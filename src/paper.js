/**
 * Paper trading (spec 25): every ENTER signal is booked as a virtual trade at
 * the executable VWAP, monitored with live books, and closed on
 * convergence / target / time-stop / invalidation. The ledger
 * (data/paper-trades.jsonl) is what tells us later whether the signals were
 * worth anything - it drives "convergenceHistory" scoring too.
 */
const fs = require("fs");
const path = require("path");
const { loadJson, saveJson } = require("./logger");
const { roundTripCost } = require("./costs");
const { fillVwap } = require("./engine");
const { istParts } = require("./util");

class PaperTrader {
  constructor(cfg, logger, hist) {
    this.cfg = cfg;
    this.log = logger;
    this.hist = hist;
    this.stateFile = path.join(cfg.dataDir, "paper-state.json");
    this.ledgerFile = path.join(cfg.dataDir, "paper-trades.jsonl");

    const prev = loadJson(this.stateFile, null);
    const today = istParts().dateKey;
    if (prev && prev.dayKey !== today && Array.isArray(prev.open) && prev.open.length) {
      // day roll while positions were open (scanner was not running at EOD):
      // mark them closed at their last known bid so the ledger stays truthful.
      const lines = prev.open.map((t) => {
        const exitPx = t.lastBid || t.entryPx;
        const netPct = ((exitPx - t.entryPx) / t.entryPx) * 100 - (t.costPct || 0);
        return JSON.stringify({
          ...t, status: "closed", closedAt: Date.now(), exitPx,
          netPct, netRs: (exitPx - t.entryPx) * t.qty - (t.costRs || 0),
          holdMin: 0, reason: "stale-open (scanner stopped)",
        });
      });
      try {
        fs.appendFileSync(this.ledgerFile, lines.join("\n") + "\n");
      } catch { /* ignore */ }
    }
    this.state = prev && prev.dayKey === today ? prev : { dayKey: today, open: [], closedToday: 0, realizedTodayRs: 0, wins: 0, losses: 0, nextId: (prev?.nextId || 0) + 1 };
    this.state.open = this.state.open || [];
    this.save();
    this.rebuildConvergence();
  }

  /** Rebuild per-symbol convergence stats from the full ledger. */
  rebuildConvergence() {
    let text = "";
    try {
      text = fs.readFileSync(this.ledgerFile, "utf8");
    } catch {
      return;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const t = JSON.parse(line);
        const c = this.hist.convergence.get(t.symbol) || { closed: 0, converged: 0 };
        c.closed++;
        if (t.netPct > 0) c.converged++;
        this.hist.convergence.set(t.symbol, c);
      } catch { /* skip */ }
    }
  }

  save() {
    saveJson(this.stateFile, this.state);
  }

  canOpen(rec) {
    const cfg = this.cfg;
    if (!cfg.paper.enabled) return { ok: false, reason: "paper trading disabled" };
    if (!rec.metrics || !rec.metrics.buyComplete) return { ok: false, reason: "no full-size fill" };
    const open = this.state.open;
    if (open.some((t) => t.symbol === rec.symbol)) return { ok: false, reason: "already open for this symbol" };
    if (open.length >= cfg.position.maxOpenTrades) return { ok: false, reason: `max open trades (${cfg.position.maxOpenTrades})` };
    const todayCount = this.state.closedToday + open.length;
    if (todayCount >= cfg.position.maxTradesPerDay) return { ok: false, reason: `daily trade cap (${cfg.position.maxTradesPerDay})` };
    if (this.state.realizedTodayRs <= -Math.abs(cfg.position.dailyLossLimitRs)) return { ok: false, reason: "daily loss limit hit" };
    const deployed = open.reduce((s, t) => s + t.notional, 0);
    if (deployed + cfg.position.capitalPerTradeRs > cfg.position.totalCapitalRs) return { ok: false, reason: "capital cap" };
    return { ok: true };
  }

  open(rec) {
    const cfg = this.cfg;
    const m = rec.metrics;
    const entryPx = m.buyVwap;
    const qty = m.qtyTarget;
    const cost = roundTripCost(cfg, { price: entryPx, qty });
    const trade = {
      id: this.state.nextId++,
      symbol: rec.symbol,
      name: rec.name,
      category: rec.category,
      openedAt: rec.at,
      entryPx,
      qty,
      notional: entryPx * qty,
      costPct: cost.totalPct,
      costRs: cost.totalRs,
      iNAV: rec.inav,
      ltpDevPct: rec.ltpDevPct,
      askDevPct: m.askDevPct,
      execDevPct: m.execDevPct,
      spreadPct: m.spreadPct,
      score: rec.score.total,
      z: m.z,
      baseline: m.hist ? { key: m.histSeries, mean: m.hist.mean, std: m.hist.std, n: m.hist.n } : null,
      lastBid: rec.book.bid,
      marks: 0,
      mfePct: null,
      maePct: null,
      status: "open",
    };
    this.state.open.push(trade);
    this.save();
    return trade;
  }

  /**
   * Mark all open trades with current books and close those that hit an exit.
   * rowBySymbol: Map(symbol -> feed row) for live iNAV. Returns closed trades.
   */
  monitor({ pool, rowBySymbol, cfg, now = Date.now() }) {
    const closed = [];
    const keep = [];
    for (const t of this.state.open) {
      const stream = pool.get(t.symbol);
      const quote = stream && stream.connected ? stream.quote : null;
      if (!quote || !quote.bids.length) {
        keep.push(t); // no book right now; leave it open until data returns
        continue;
      }
      const row = rowBySymbol.get(t.symbol);
      const inavNow = row && Number.isFinite(row.inav) && row.inav > 0 ? row.inav : t.iNAV;
      const fill = fillVwap(quote.bids, t.qty);
      const exitPx = fill.complete ? fill.vwap : quote.bid;
      const unrealNetPct = ((exitPx - t.entryPx) / t.entryPx) * 100 - t.costPct;
      const heldMin = (now - t.openedAt) / 60000;
      const askDev = inavNow > 0 ? ((inavNow - quote.ask) / inavNow) * 100 : null;

      t.marks++;
      t.lastBid = quote.bid;
      t.mfePct = t.mfePct === null ? unrealNetPct : Math.max(t.mfePct, unrealNetPct);
      t.maePct = t.maePct === null ? unrealNetPct : Math.min(t.maePct, unrealNetPct);

      const mktOpen = String(quote.mktStatus || "").toLowerCase() === "open";
      let reason = null;
      if (!mktOpen) reason = "market closed";
      else if (inavNow < t.entryPx * (1 - cfg.exits.inavMoveInvalidationPct / 100)) reason = "fair value fell below entry";
      else if (unrealNetPct >= cfg.exits.profitTargetNetPct) reason = "profit target";
      else if (quote.bid >= inavNow) reason = "bid reached iNAV";
      else if (askDev !== null && askDev <= cfg.exits.exitDiscountPct) reason = "discount converged";
      else if (heldMin >= cfg.exits.maxHoldMin) reason = "time stop";

      if (!reason) {
        keep.push(t);
        continue;
      }

      const done = {
        ...t,
        status: "closed",
        closedAt: now,
        exitPx,
        exitComplete: fill.complete,
        askDevAtExit: askDev,
        netPct: unrealNetPct,
        netRs: (exitPx - t.entryPx) * t.qty - t.costRs,
        holdMin,
        reason,
      };
      delete done.marks;
      closed.push(done);
      this.state.closedToday++;
      this.state.realizedTodayRs += done.netRs;
      if (done.netPct > 0) this.state.wins++;
      else this.state.losses++;
      const c = this.hist.convergence.get(t.symbol) || { closed: 0, converged: 0 };
      c.closed++;
      if (done.netPct > 0) c.converged++;
      this.hist.convergence.set(t.symbol, c);
      try {
        fs.appendFileSync(this.ledgerFile, JSON.stringify(done) + "\n");
      } catch { /* ignore */ }
    }
    this.state.open = keep;
    this.save();
    return closed;
  }

  openSymbols() {
    return this.state.open.map((t) => t.symbol);
  }

  stats() {
    const deployed = this.state.open.reduce((s, t) => s + t.notional, 0);
    return {
      open: this.state.open.length,
      deployedRs: deployed,
      closedToday: this.state.closedToday,
      wins: this.state.wins,
      losses: this.state.losses,
      realizedTodayRs: this.state.realizedTodayRs,
    };
  }
}

module.exports = { PaperTrader };
