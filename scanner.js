#!/usr/bin/env node
/**
 * ETF intraday arbitrage/opportunity scanner - NSE India.
 *
 * The loop, every scan.intervalSec (default 20 s, market hours only):
 *
 *   1. poll the NSE ETF bulk feed (LTP / iNAV / NAV / turnover for all ETFs)
 *   2. track iNAV freshness per symbol (age, update cadence)
 *   3. rank by traded value -> liquidity universe (top 100)
 *   4. LTP-vs-iNAV prefilter -> candidates
 *   5. keep an order-book socket per candidate (NSE streamer)
 *   6. for every candidate, run the engine: executable (ask/VWAP) discount,
 *      spread, depth bands, three exit scenarios, full cost model, z-score vs
 *      the symbol's own history, 0-100 score -> ENTER / WATCH / NO_BOOK
 *   7. alert ENTERs on Telegram, book paper trades, monitor open paper trades
 *   8. append samples + decisions to data/*.jsonl (backtest fodder)
 *
 * Usage:
 *   node scanner.js                 run continuously (Ctrl+C to stop)
 *   node scanner.js --once          one scan then exit (cron / Actions friendly)
 *   node scanner.js --minutes 60    run for 60 minutes then exit
 *   node scanner.js --dry           print messages instead of sending
 *   node scanner.js --force         ignore market-hours / stale-feed guards
 *   node scanner.js --no-stream     skip books (diagnostics; no ENTERs possible)
 *   node scanner.js --symbols A,B   force these symbols as candidates (debug)
 *
 * Exit code 0 = the scan(s) ran; alert delivery failures are logged, not fatal.
 */
const { loadConfig } = require("./src/config");
const { fetchEtfFeed, normaliseRows, StreamPool } = require("./src/nse");
const { History } = require("./src/stats");
const { evaluate } = require("./src/engine");
const { Logger } = require("./src/logger");
const { PaperTrader } = require("./src/paper");
const { sendTelegram, formatOpportunity, formatExit, formatScanError } = require("./src/telegram");
const { sleep, istParts, parseIstStamp, median, money, pct, f2 } = require("./src/util");

/* ------------------------------------------------------------- arguments */
const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
const optVal = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : null;
};
const OPTS = {
  once: hasFlag("--once"),
  dry: hasFlag("--dry"),
  force: hasFlag("--force"),
  noStream: hasFlag("--no-stream"),
  minutes: Number(optVal("--minutes") || 0),
  symbols: (optVal("--symbols") || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
};

const cfg = loadConfig();
if (OPTS.dry) cfg.telegram.dryRun = true;
if (OPTS.force) cfg.scan.ignoreMarketHours = true;
if (OPTS.noStream) cfg.streamer.enabled = false;

/* ----------------------------------------------------------------- state */
const log = new Logger(cfg);
const hist = new History(cfg);
const loaded = hist.load();
const pool = new StreamPool(cfg);
const paper = new PaperTrader(cfg, log, hist);

const iNAVState = new Map(); // symbol -> { value, lastChangeAt, changes, gaps[] }
const lastAlertAt = new Map(); // symbol -> epoch ms
let feedFailStreak = 0;
let feedAlerted = false;
let scanNo = 0;
let stopping = false;

const toMin = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
};
const withinMarketHours = (ist) => ist.minutes >= toMin(cfg.scan.marketOpenTime) && ist.minutes <= toMin(cfg.scan.marketCloseTime);
const dateKeyOf = (stamp) => {
  const ms = parseIstStamp(stamp);
  return ms === null ? null : istParts(new Date(ms)).dateKey;
};

/* ------------------------------------------------------------------ scan */
async function scanOnce() {
  scanNo++;
  const now = Date.now();
  const ist = istParts();
  cfg._dateKey = ist.dateKey;
  log.setDate(ist.dateKey);

  let snap;
  try {
    snap = await fetchEtfFeed();
    feedFailStreak = 0;
    if (feedAlerted) {
      feedAlerted = false;
      try { await sendTelegram(cfg, "\u2705 ETF arb scanner: feed recovered."); } catch { /* best effort */ }
    }
  } catch (err) {
    feedFailStreak++;
    log.error(`feed failed (${feedFailStreak}x): ${err.message}`);
    if (feedFailStreak >= 5 && !feedAlerted) {
      feedAlerted = true;
      try { await sendTelegram(cfg, formatScanError(`NSE ETF feed failing since ${ist.timeStr}: ${err.message}`)); } catch { /* best effort */ }
    }
    return { ok: false, idle: true };
  }

  const snapKey = dateKeyOf(snap.timestamp);
  const isToday = snapKey === ist.dateKey;
  if ((!isToday || !withinMarketHours(ist)) && !cfg.scan.ignoreMarketHours) {
    if (scanNo % 30 === 1) log.line(`market closed (feed stamp ${snap.timestamp || "?"}) - idle`);
    return { ok: true, idle: true };
  }

  /* ---- normalise + liquidity universe ---- */
  const rows = normaliseRows(snap);
  const tradeable = rows.filter((r) => r.volume > 0 && r.turnover > 0 && r.turnover >= cfg.universe.minTurnoverRs && r.ltp > 0 && r.inav > 0);
  const ranked = tradeable.slice().sort((a, b) => b.turnover - a.turnover);
  const universeRanked = cfg.universe.topLiquidN > 0 ? ranked.slice(0, cfg.universe.topLiquidN) : ranked;
  const rankBySymbol = new Map(universeRanked.map((r, i) => [r.symbol, i]));
  const cutoff = universeRanked.length ? universeRanked[universeRanked.length - 1].turnover : 0;
  const universe = universeRanked.filter((r) => r.inavVsNavPct === null || Math.abs(r.inavVsNavPct) <= cfg.universe.sanityMaxInavNavPct);

  /* ---- iNAV freshness tracking ---- */
  for (const r of rows) {
    if (!Number.isFinite(r.inav) || r.inav <= 0) continue;
    const st = iNAVState.get(r.symbol);
    if (!st) {
      iNAVState.set(r.symbol, { value: r.inav, lastChangeAt: now, changes: 0, gaps: [] });
      continue;
    }
    if (Math.abs(r.inav - st.value) > 1e-9) {
      st.gaps.push(now - st.lastChangeAt);
      if (st.gaps.length > 30) st.gaps.shift();
      st.value = r.inav;
      st.lastChangeAt = now;
      st.changes++;
    }
  }
  const inavFor = (sym) => {
    const st = iNAVState.get(sym);
    if (!st) return null;
    const gaps = st.gaps.filter((g) => g > 0 && g < 600000);
    return {
      ageSec: Math.round((now - st.lastChangeAt) / 1000),
      medianGapSec: gaps.length ? Math.round(median(gaps) / 1000) : null,
      changes: st.changes,
    };
  };

  /* ---- candidates ---- */
  let cands = universe.filter(
    (r) => cfg.universe.categories.includes(r.category) && r.ltpDevPct !== null && r.ltpDevPct >= cfg.candidates.prefilterDiscountPct
  );
  if (OPTS.symbols.length) cands = universe.filter((r) => OPTS.symbols.includes(r.symbol));

  // Stream sockets are scarce (maxStreams); prioritise candidates whose discount
  // is NOT this symbol's normal state (structural offsets, e.g. silver ETFs,
  // would otherwise hog every socket all day while never being tradeable).
  const structuralPrecheck = (r) => {
    const st = hist.stat(r.symbol);
    if (!st || st.n < (cfg.thresholds.structuralMinSamples ?? 5)) return false;
    return Math.abs(st.mean) >= cfg.thresholds.structuralMeanPct && !(r.ltpDevPct >= Math.abs(st.mean) + cfg.thresholds.structuralMarginPct);
  };
  cands = cands
    .map((r) => ({ r, structural: structuralPrecheck(r) }))
    .sort((a, b) => Number(a.structural) - Number(b.structural) || b.r.ltpDevPct - a.r.ltpDevPct)
    .map((x) => x.r);

  const premiums = universe.filter(
    (r) => cfg.universe.categories.includes(r.category) && r.ltpDevPct !== null && r.ltpDevPct <= -cfg.candidates.prefilterDiscountPct
  );

  /* ---- order-book sockets for candidates + open paper trades ---- */
  let poolInfo = { active: pool.streams.size, opened: 0, closed: 0 };
  if (cfg.streamer.enabled) {
    const streamSyms = [...paper.openSymbols(), ...cands.slice(0, cfg.streamer.maxStreams).map((r) => r.symbol)];
    poolInfo = pool.sync(streamSyms);
    // fresh sockets need a moment for the first push; reused sockets are instant
    await pool.waitForQuotes(streamSyms, poolInfo.opened > 0 ? 6000 : 1200);
  }

  /* ---- evaluate ---- */
  const execMap = new Map();
  const evals = [];
  for (const c of cands) {
    const stream = pool.get(c.symbol);
    const rec = evaluate({
      row: c,
      stream,
      hist,
      inavState: inavFor(c.symbol),
      cfg,
      now: Date.now(),
      turnoverRank: rankBySymbol.get(c.symbol) ?? 9999,
    });
    rec.scanNo = scanNo;
    if (rec.metrics && Number.isFinite(rec.metrics.execDevPct)) execMap.set(c.symbol, rec.metrics.execDevPct);
    evals.push(rec);
    if (cfg.logging.logAllCandidates) log.candidate(rec);
  }

  // Sample history densely during the warmup scans so each symbol's baseline
  // (mean/std/structural offset) forms within the first ~2 minutes, then slow down.
  const warmup = scanNo <= (cfg.history.warmupScans ?? 12);
  if (warmup || scanNo % Math.max(1, cfg.history.sampleEveryScans) === 0) {
    hist.recordBatch(universe, execMap, now);
  }

  /* ---- alerts: ENTER candidates, ranked by primary net edge ---- */
  const enters = evals.filter((r) => r.decision === "ENTER").sort((a, b) => (b.metrics.primary.netPct || 0) - (a.metrics.primary.netPct || 0));
  const sent = [];
  for (const rec of enters) {
    if (sent.length >= cfg.alerts.maxPerScan) break;
    const last = lastAlertAt.get(rec.symbol) || 0;
    if (now - last < cfg.alerts.cooldownMin * 60000) {
      log.line(`ENTER ${rec.symbol} suppressed (cooldown ${cfg.alerts.cooldownMin} min)`);
      continue;
    }
    const perm = paper.canOpen(rec);
    const trade = perm.ok ? paper.open(rec) : null;
    if (cfg.alerts.enabled) {
      const text = formatOpportunity(rec, { cfg, paperTrade: trade, cooldownNote: perm.ok ? null : `paper not opened: ${perm.reason}` });
      try {
        await sendTelegram(cfg, text);
        lastAlertAt.set(rec.symbol, now);
        sent.push(rec);
        log.alert({
          at: now,
          scanNo,
          symbol: rec.symbol,
          score: rec.score.total,
          execDevPct: rec.metrics.execDevPct,
          netPct: rec.metrics.primary.netPct,
          z: rec.metrics.z,
          tradeId: trade ? trade.id : null,
        });
        log.line(
          `ALERT ${rec.symbol} exec ${f2(rec.metrics.execDevPct, 3)}% net ${pct(rec.metrics.primary.netPct, 3)} score ${rec.score.total}${trade ? ` paper#${trade.id}` : ""}`
        );
      } catch (err) {
        log.error(`telegram failed for ${rec.symbol}: ${err.message}`);
      }
    }
  }

  /* ---- monitor paper trades ---- */
  const rowBySymbol = new Map(rows.map((r) => [r.symbol, r]));
  const closed = paper.monitor({ pool, rowBySymbol, cfg, now: Date.now() });
  for (const t of closed) {
    log.line(`paper exit #${t.id} ${t.symbol} - ${t.reason} - net ${pct(t.netPct, 3)} (${money(t.netRs)}) held ${t.holdMin.toFixed(1)}m`);
    if (cfg.alerts.sendExits && cfg.alerts.enabled) {
      try { await sendTelegram(cfg, formatExit(t)); } catch (err) { log.error(`exit message failed: ${err.message}`); }
    }
  }

  const ps = paper.stats();
  log.line(
    `scan#${scanNo} ${ist.timeStr} rows ${rows.length} universe ${universe.length} cut ${money(cutoff)} cand ${cands.length}${OPTS.symbols.length ? " (forced)" : ""} prem ${premiums.length} streams ${pool.streams.size} enter ${enters.length} sent ${sent.length} open ${ps.open} realized ${money(ps.realizedTodayRs)}`
  );
  return { ok: true, rows: rows.length, candidates: cands.length, enters: enters.length, sent: sent.length, closed: closed.length, premiumWatch: premiums.length };
}

/* ------------------------------------------------------------------ main */
async function main() {
  const issues = [];
  if (!cfg.telegram.dryRun && (!cfg.telegram.botToken || !cfg.telegram.chatId)) issues.push("TELEGRAM_BOT_TOKEN/CHAT_ID missing (use --dry)");
  log.line(
    `etf-arb-scanner up - ${loaded.files} history files / ${loaded.samples} samples - streamer ${cfg.streamer.enabled ? "on" : "off"} - paper ${cfg.paper.enabled ? "on" : "off"} - dry ${cfg.telegram.dryRun}`
  );
  if (issues.length) log.error(issues.join("; "));

  if (OPTS.once) {
    const r = await scanOnce();
    pool.stop();
    return r;
  }

  const startedAt = Date.now();
  const stopAt = OPTS.minutes > 0 ? startedAt + OPTS.minutes * 60000 : null;
  while (!stopping) {
    const t0 = Date.now();
    let res = null;
    try {
      res = await scanOnce();
    } catch (err) {
      log.error(`scan error: ${err.stack || err.message}`);
      res = { idle: false };
    }
    if (stopping) break;
    if (stopAt && Date.now() >= stopAt) break;
    const base = res && res.idle && !cfg.scan.ignoreMarketHours ? 300000 : cfg.scan.intervalSec * 1000;
    let wait = Math.max(2000, base - (Date.now() - t0));
    if (stopAt) wait = Math.min(wait, Math.max(0, stopAt - Date.now()));
    await sleep(wait);
  }
  pool.stop();
  const ps = paper.stats();
  log.line(`stopped after ${scanNo} scans - paper open ${ps.open} realized today ${money(ps.realizedTodayRs)}`);
}

process.on("SIGINT", () => {
  stopping = true;
  log.line("SIGINT - shutting down");
  try { pool.stop(); } catch { /* ignore */ }
  process.exit(0);
});

main()
  .then((r) => {
    if (OPTS.once && r) console.log(JSON.stringify(r));
  })
  .catch((err) => {
    log.error(`fatal: ${err.stack || err.message}`);
    try { pool.stop(); } catch { /* ignore */ }
    process.exit(1);
  });
