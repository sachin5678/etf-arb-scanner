/**
 * The decision engine.
 *
 * Given one ETF row (feed), its live book (streamer), what the symbol normally
 * does (history) and iNAV freshness, produce:
 *
 *   - every metric the spec asks for (executable discount, spread, VWAP fills,
 *     depth bands, three exit scenarios, full cost breakdown, net edges, z,
 *     reliability, score)
 *   - a decision: ENTER / WATCH / NO_BOOK, with the human reasons either way
 *
 * Nothing here talks to the network: it is pure functions, easy to test and to
 * reason about. The one rule that matters (spec 27): never act on LTP alone -
 * the executable buy price is the ask (walked for size), nothing else.
 */
const { roundTripCost } = require("./costs");
const { percentile, round2 } = require("./util");

/** Walk order-book levels for a target size. levels best-first. */
function fillVwap(levels, qtyTarget) {
  let remain = qtyTarget;
  let cost = 0;
  let filled = 0;
  let worst = NaN;
  for (const l of levels || []) {
    if (remain <= 0) break;
    const take = Math.min(remain, l.q);
    cost += take * l.p;
    filled += take;
    remain -= take;
    worst = l.p;
  }
  return {
    vwap: filled > 0 ? cost / filled : NaN,
    filled,
    remaining: Math.max(0, remain),
    complete: filled >= qtyTarget,
    worstPrice: worst,
  };
}

function sumQtyWithin(levels, predicate) {
  let q = 0;
  for (const l of levels || []) if (predicate(l.p)) q += l.q;
  return q;
}

/**
 * ctx = { row, stream, hist, inavState, cfg, now, turnoverRank }
 *   row        - normalised feed row (src/nse.js normaliseRows)
 *   stream     - pool.get(symbol) snapshot or null
 *   hist       - History instance
 *   inavState  - { ageSec, medianGapSec, changes } or null
 *   turnoverRank - 0-based rank by traded value within the liquidity universe
 */
function evaluate(ctx) {
  const { row, stream, hist, inavState, cfg, turnoverRank } = ctx;
  const quote = stream && stream.connected ? stream.quote : null;
  const now = ctx.now || Date.now();

  const rec = {
    at: now,
    symbol: row.symbol,
    name: row.name,
    category: row.category,
    sub: row.sub,
    ltp: row.ltp,
    inav: row.inav,
    nav: row.nav,
    turnover: row.turnover,
    turnoverRank,
    ltpDevPct: row.ltpDevPct,
    inavVsNavPct: row.inavVsNavPct,
    inavAgeSec: inavState ? inavState.ageSec : null,
    inavMedianGapSec: inavState ? inavState.medianGapSec : null,
    inavChanges: inavState ? inavState.changes : 0,
    book: null,
    metrics: null,
    costs: null,
    score: null,
    decision: "NO_BOOK",
    reasons: [],
  };

  const gates = [];
  const fail = (name, detail) => gates.push({ name, ok: false, detail });
  const pass = (name, detail) => gates.push({ name, ok: true, detail });

  /* ---- spread of the discount options from the raw feed ---- */
  const ltpDev = row.ltpDevPct;

  /* ---- sanity: iNAV vs last declared NAV ---- */
  const sane = rec.inavVsNavPct === null || Math.abs(rec.inavVsNavPct) <= cfg.universe.sanityMaxInavNavPct;
  sane ? pass("sanity", `|iNAV-NAV| ${rec.inavVsNavPct === null ? "n/a" : Math.abs(rec.inavVsNavPct).toFixed(2) + "%"}`) : fail("sanity", `|iNAV-NAV| ${Math.abs(rec.inavVsNavPct).toFixed(2)}% > ${cfg.universe.sanityMaxInavNavPct}%`);

  /* ---- book required: no LTP-only trading (spec 27) ---- */
  if (!quote || !quote.bids.length || !quote.asks.length) {
    fail("book", stream ? (stream.connected ? "no quote yet" : `socket: ${stream.lastError || "down"}`) : "no stream");
    rec.gates = gates;
    rec.reasons.push(gates[gates.length - 1].detail);
    return rec;
  }

  const bookAgeMs = stream.ageMs;
  rec.book = {
    bid: quote.bid,
    ask: quote.ask,
    bids: quote.bids,
    asks: quote.asks,
    totalBuyQty: quote.totalBuyQty,
    totalSellQty: quote.totalSellQty,
    streamTimestamp: quote.timestamp,
    mktStatus: quote.mktStatus,
    ageMs: bookAgeMs,
  };

  const inav = row.inav;
  const bid = quote.bid;
  const ask = quote.ask;
  const mid = (bid + ask) / 2;
  const spread = ask - bid;
  const spreadPct = mid > 0 ? (spread / mid) * 100 : NaN;

  /* ---- executable metrics (spec 3, 4) ---- */
  const askDevPct = ((inav - ask) / inav) * 100; // discount at best ask
  const bidPremPct = ((bid - inav) / inav) * 100; // premium achievable at best bid

  /* ---- size-aware execution (spec 9, 11) ---- */
  const qtyTarget = Math.max(1, Math.round(cfg.position.capitalPerTradeRs / ask));
  const buyFill = fillVwap(quote.asks, qtyTarget);
  const sellFill = fillVwap(quote.bids, qtyTarget);
  const entryPx = buyFill.complete ? buyFill.vwap : NaN;
  const execDevPct = buyFill.complete ? ((inav - buyFill.vwap) / inav) * 100 : NaN;

  /* ---- depth bands (spec 10) ---- */
  const bands = [0.05, 0.1, 0.2, 0.3];
  const buyWithin = {};
  const sellWithin = {};
  for (const x of bands) {
    buyWithin[x] = sumQtyWithin(quote.asks, (p) => p <= inav * (1 - x / 100));
    sellWithin[x] = sumQtyWithin(quote.bids, (p) => p >= inav * (1 - x / 100));
  }

  /* ---- exit scenarios (spec 5) + costs (6) + net edges (7) ---- */
  const partialFraction = cfg.scenarios.partialFraction;
  const scenarios = {
    A: { exitPx: inav, grossPct: ((inav - entryPx) / entryPx) * 100, label: "full convergence" },
    B: {
      exitPx: entryPx + partialFraction * (inav - entryPx),
      grossPct: ((partialFraction * (inav - entryPx)) / entryPx) * 100,
      label: `partial ${Math.round(partialFraction * 100)}%`,
    },
    C: { exitPx: sellFill.complete ? sellFill.vwap : bid, grossPct: ((bid - entryPx) / entryPx) * 100, label: "immediate at bid" },
  };

  const costs = buyFill.complete ? roundTripCost(cfg, { price: buyFill.vwap, qty: qtyTarget }) : null;
  const costPct = costs ? costs.totalPct : NaN;
  for (const s of Object.values(scenarios)) s.netPct = s.grossPct - costPct;

  const primaryKey = String(cfg.scenarios.primary || "B").toUpperCase();
  const primary = scenarios[primaryKey] || scenarios.B;

  /* ---- history / unusualness (spec 13, 14) ---- */
  const histStat = hist.stat(row.symbol);
  const seriesFor = histStat ? histStat.key : "d";
  const z = hist.z(row.symbol, seriesFor === "e" ? execDevPct : ltpDev);
  const histMean = histStat ? histStat.mean : null;
  const histSufficient = !!(histStat && histStat.n >= cfg.thresholds.minHistorySamples);
  // Structural guard: works off partial history too (structuralMinSamples), because
  // a fund whose iNAV/price relationship is structurally offset (classic case:
  // silver ETFs) shows its baseline within minutes, not within 30 samples.
  const structuralJudge = histStat && histStat.n >= (cfg.thresholds.structuralMinSamples ?? 5);
  const structuralNormal =
    !!structuralJudge &&
    Math.abs(histStat.mean) >= cfg.thresholds.structuralMeanPct &&
    !(execDevPct >= Math.abs(histStat.mean) + cfg.thresholds.structuralMarginPct);
  const conv = hist.convergenceStats(row.symbol);

  rec.metrics = {
    askDevPct,
    bidPremPct,
    spread, spreadPct,
    qtyTarget,
    buyVwap: buyFill.vwap, buyFilled: buyFill.filled, buyComplete: buyFill.complete,
    sellVwap: sellFill.vwap, sellFilled: sellFill.filled, sellComplete: sellFill.complete,
    execDevPct,
    buyWithin, sellWithin,
    scenarios,
    primary: { key: primaryKey, ...primary },
    hist: histStat,
    histSeries: seriesFor,
    histSufficient,
    z,
    structuralNormal,
    convergence: conv,
  };
  rec.costs = costs;

  /* ---- reliability (spec 2, 12) ---- */
  const inavAge = rec.inavAgeSec;
  const reliability =
    inavAge === null ? "UNKNOWN" : inavAge <= 10 ? "HIGH" : inavAge <= 30 ? "MEDIUM" : inavAge <= cfg.thresholds.maxInavAgeSec ? "LOW" : "STALE";
  rec.reliability = reliability;

  /* ---- mandatory gates (spec 18, 27) ---- */
  // market + book
  const mktOpen = String(quote.mktStatus || "").toLowerCase() === "open";
  mktOpen ? pass("market", "NSE Open") : fail("market", `mktStatus ${quote.mktStatus || "?"}`);
  const bookFresh = bookAgeMs <= cfg.streamer.maxBookAgeSec * 1000;
  bookFresh ? pass("bookAge", `${Math.round(bookAgeMs / 1000)}s`) : fail("bookAge", `${Math.round(bookAgeMs / 1000)}s > limit`);

  // iNAV freshness
  const inavFresh = inavAge !== null && inavAge <= cfg.thresholds.maxInavAgeSec;
  inavFresh ? pass("inavAge", `${inavAge}s`) : fail("inavAge", inavAge === null ? "unknown" : `${inavAge}s > ${cfg.thresholds.maxInavAgeSec}s`);
  const categoryOk = cfg.universe.categories.includes(row.category);
  categoryOk ? pass("category", row.category) : fail("category", row.category);

  // executable discount
  const execOk = Number.isFinite(execDevPct) && execDevPct >= cfg.candidates.minExecDiscountPct;
  execOk
    ? pass("execDiscount", `${execDevPct.toFixed(3)}% >= ${cfg.candidates.minExecDiscountPct}%`)
    : fail("execDiscount", Number.isFinite(execDevPct) ? `${execDevPct.toFixed(3)}% < ${cfg.candidates.minExecDiscountPct}%` : "no full fill at target size");

  // spread
  const spreadOk = Number.isFinite(spreadPct) && spreadPct <= cfg.candidates.maxSpreadPct;
  spreadOk ? pass("spread", `${spreadPct.toFixed(3)}%`) : fail("spread", `${spreadPct?.toFixed(3)}% > ${cfg.candidates.maxSpreadPct}%`);

  // depth for target size
  if (buyFill.complete) pass("depth", `${buyFill.filled} @ vwap ${buyFill.vwap.toFixed(2)}`);
  else fail("depth", `only ${buyFill.filled}/${qtyTarget} available`);

  // profitability
  const netOk = Number.isFinite(primary.netPct) && primary.netPct >= cfg.thresholds.minNetProfitPct;
  netOk
    ? pass("netProfit", `${primary.netPct.toFixed(3)}% (${primaryKey})`)
    : fail("netProfit", `${Number.isFinite(primary.netPct) ? primary.netPct.toFixed(3) : "n/a"}% < ${cfg.thresholds.minNetProfitPct}%`);
  const safetyOk = Number.isFinite(primary.grossPct) && Number.isFinite(costPct) && primary.grossPct >= costPct * cfg.thresholds.costSafetyMult;
  safetyOk
    ? pass("costSafety", `gross ${primary.grossPct.toFixed(3)}% >= ${(costPct * cfg.thresholds.costSafetyMult).toFixed(3)}%`)
    : fail("costSafety", `gross ${Number.isFinite(primary.grossPct) ? primary.grossPct.toFixed(3) : "n/a"}% < ${(costPct * cfg.thresholds.costSafetyMult).toFixed(3)}%`);

  // unusual vs own history
  if (!cfg.thresholds.requireUnusual) {
    pass("unusual", "gate disabled");
  } else if (structuralNormal) {
    fail("unusual", `structural: baseline ${histStat.mean.toFixed(3)}% (n=${histStat.n}), today ${Number.isFinite(execDevPct) ? execDevPct.toFixed(3) : "n/a"}%`);
  } else if (!histSufficient) {
    const okCold = Number.isFinite(execDevPct) && execDevPct >= cfg.thresholds.coldStartMinDiscountPct;
    okCold
      ? pass("unusual", `no history yet; ${execDevPct.toFixed(3)}% >= cold-start ${cfg.thresholds.coldStartMinDiscountPct}%`)
      : fail("unusual", `no history yet; need >= ${cfg.thresholds.coldStartMinDiscountPct}%`);
  } else if (z !== null && z >= cfg.thresholds.zMin) {
    pass("unusual", `z=${z.toFixed(2)} >= ${cfg.thresholds.zMin}`);
  } else {
    fail("unusual", `z=${z === null ? "n/a" : z.toFixed(2)} < ${cfg.thresholds.zMin}`);
  }

  /* ---- opportunity score 0..100 (spec 18) ---- */
  const w = cfg.alerts.scoreWeights;
  const items = [];
  const addItem = (name, points, ok, detail) => items.push({ name, points: ok ? points : 0, max: points, ok, detail });

  const unusualScore = histSufficient
    ? Number.isFinite(execDevPct) && execDevPct >= histStat.p95
    : Number.isFinite(execDevPct) && execDevPct >= cfg.thresholds.coldStartMinDiscountPct;
  addItem("unusualDeviation", w.unusualDeviation, unusualScore, histSufficient ? `>= p95(${histStat.p95.toFixed(3)}%)` : "cold start threshold");

  addItem("zscore", w.zscore, z !== null && z >= cfg.thresholds.zMin, z === null ? "no z" : `z=${z.toFixed(2)}`);
  addItem("liquidity", w.liquidity, turnoverRank !== undefined && turnoverRank < Math.max(10, Math.round(cfg.universe.topLiquidN / 4)), `rank #${turnoverRank + 1}`);
  addItem("freshInav", w.freshInav, inavAge !== null && inavAge <= cfg.thresholds.freshInavSec, `${inavAge}s`);
  addItem("convergenceHistory", w.convergenceHistory, conv.closed >= 3 && conv.converged / conv.closed >= 0.5, conv.closed ? `${conv.converged}/${conv.closed} converged` : "no trades yet");
  addItem("tightSpread", w.tightSpread, Number.isFinite(spreadPct) && spreadPct <= cfg.candidates.maxSpreadPct / 2, `${spreadPct?.toFixed(3)}%`);
  addItem("marketActive", w.marketActive, mktOpen && bookFresh, mktOpen ? "open" : "closed");
  addItem("depthVsTarget", w.depthVsTarget, (buyWithin[0.1] || 0) >= qtyTarget * cfg.position.minRequiredQtyFactor, `${buyWithin[0.1]} units <= iNAV-0.1%`);

  const score = items.reduce((s, i) => s + i.points, 0);
  rec.score = { total: score, items };

  /* ---- decision ---- */
  rec.gates = gates;
  const failed = gates.filter((g) => !g.ok);
  rec.reasons = failed.map((g) => `${g.name}: ${g.detail}`);
  const gatesOk = failed.length === 0;
  const scoreOk = score >= cfg.thresholds.entryScore;
  if (!scoreOk) rec.reasons.push(`score ${score} < ${cfg.thresholds.entryScore}`);
  rec.decision = gatesOk && scoreOk ? "ENTER" : "WATCH";
  rec.decisionSummary = rec.decision === "ENTER" ? "ENTER candidate" : "watch only";
  rec.revenue = null; // filled by scanner (cooldown etc.)
  rec.prefilterDevPct = ltpDev;
  return rec;
}

module.exports = { evaluate, fillVwap, sumQtyWithin };
