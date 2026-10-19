/** Configuration: defaults <- config.json <- env overrides. */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

const DEFAULTS = {
  universe: {
    topLiquidN: 100, // liquidity universe: the N most-traded ETFs by value today
    categories: ["EQUITY", "COMMODITY"], // only categories whose iNAV tracks live
    minTurnoverRs: 0,
    sanityMaxInavNavPct: 25, // drop rows where |iNAV - declared NAV| exceeds this
  },
  scan: {
    intervalSec: 20, // feed poll cadence while scanning
    marketOpenTime: "09:15",
    marketCloseTime: "15:35",
    ignoreMarketHours: false, // --force / FORCE=1 to scan anyway (testing)
  },
  streamer: {
    enabled: true, // order-book stream (wss://streamer.nseindia.com)
    maxStreams: 12, // concurrent sockets (one per symbol)
    minHoldSec: 90, // keep a socket at least this long once opened
    heartbeatSec: 45, // ping if silent this long
    quietBookSec: 300, // a book older than this is flagged quiet (still valid: updates are push)
    maxBookAgeSec: 600, // ... and unusable beyond this
    reconnectMinMs: 2000,
    reconnectMaxMs: 45000,
  },
  candidates: {
    prefilterDiscountPct: 0.15, // LTP-vs-iNAV needed to bother with the book
    minExecDiscountPct: 0.25, // ask(+VWAP)-vs-iNAV needed to enter
    maxSpreadPct: 0.10, // bid/ask spread ceiling
  },
  thresholds: {
    minNetProfitPct: 0.20, // net of costs, primary scenario
    costSafetyMult: 2.0, // gross edge must be >= costs * this
    zMin: 2.0, // unusual vs own history
    zStdFloor: 0.02, // ignore z when the symbol's std is below this (avoids explosive z)
    requireUnusual: true,
    minHistorySamples: 30,
    structuralMinSamples: 3, // judge "structural discount" from this many samples already
    coldStartMinDiscountPct: 0.40, // when there is no usable history yet, demand this instead
    structuralMeanPct: 0.25, // |historical mean dev| above this => deviation is structural
    structuralMarginPct: 0.10, // ... and today must beat the mean by this much to matter
    maxInavAgeSec: 60, // stale-iNAV ceiling
    freshInavSec: 30, // bonus-score freshness
    entryScore: 75, // 0..100 signal score gate
  },
  scenarios: {
    primary: "B", // which scenario headlines net edge: full | partial | immediate
    partialFraction: 0.5, // scenario B: fraction of the way from entry to iNAV
  },
  costs: {
    brokeragePct: 0, // internal / delivery: 0
    brokerageFlatPerOrder: 0,
    sttSellPct: 0.001, // STT on sale, equity delivery, ETF
    exchangeTxnPct: 0.00297, // NSE transaction charge per side
    sebiPct: 0.0001, // SEBI turnover fee per side
    gstPct: 18, // GST on (brokerage + exchange + SEBI)
    stampDutyBuyPct: 0.005, // stamp duty on purchase
    dpChargeFlatPerSell: 15.34, // DP charge per sell scrip (incl. GST) - flat
    slippagePct: 0.02, // extra round-trip slippage buffer (touch fills already use book VWAP)
  },
  position: {
    totalCapitalRs: 500000,
    capitalPerTradeRs: 50000, // notional per opportunity
    maxOpenTrades: 3,
    maxTradesPerDay: 10,
    dailyLossLimitRs: 2500,
    minRequiredQtyFactor: 1.0, // book depth must cover this multiple of target qty
  },
  exits: {
    exitDiscountPct: 0.10, // convergence exit: current exec discount <= this
    profitTargetNetPct: 0.30, // take-profit on net (unrealized) return
    maxHoldMin: 30, // time stop
    inavMoveInvalidationPct: 0.5, // exit if iNAV moved this much against the thesis
  },
  alerts: {
    enabled: true,
    cooldownMin: 30, // per-symbol alert cooldown
    maxPerScan: 3,
    sendExits: true,
    scoreWeights: {
      unusualDeviation: 20,
      zscore: 15,
      liquidity: 15,
      freshInav: 10,
      convergenceHistory: 10,
      tightSpread: 10,
      marketActive: 10,
      depthVsTarget: 10,
    },
  },
  history: {
    windowDays: 10, // sessions of samples to load for baselines
    maxSamplesPerSymbol: 2000,
    sampleEveryScans: 3, // record a full universe sample every N scans (~60s at 20s cadence)
    warmupScans: 12, // ... but every scan for the first N scans of a session
  },
  paper: { enabled: true },
  logging: { logAllCandidates: true, console: true },
};

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(base, extra) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

/** Minimal .env loader (KEY=VALUE lines, # comments). Existing env wins. */
function loadDotEnv(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || line.trim().startsWith("#")) continue;
      const key = m[1];
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    /* no .env file - fine */
  }
}

function loadConfig() {
  loadDotEnv(path.join(ROOT, ".env"));
  let fileCfg = {};
  const cfgPath = path.join(ROOT, "config.json");
  try {
    fileCfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw new Error(`config.json is invalid JSON: ${err.message}`);
  }
  const cfg = deepMerge(DEFAULTS, fileCfg);

  // env overrides (secrets and quick switches only)
  cfg.telegram = {
    botToken: process.env.TELEGRAM_BOT_TOKEN || "",
    chatId: process.env.TELEGRAM_CHAT_ID || "",
    dryRun: process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true",
  };
  if (process.env.FORCE === "1" || process.env.FORCE === "true") cfg.scan.ignoreMarketHours = true;
  if (process.env.SCAN_INTERVAL_SEC) cfg.scan.intervalSec = Number(process.env.SCAN_INTERVAL_SEC);
  if (process.env.MAX_STREAMS) cfg.streamer.maxStreams = Number(process.env.MAX_STREAMS);

  cfg.root = ROOT;
  cfg.dataDir = path.join(ROOT, "data");
  return cfg;
}

module.exports = { loadConfig, DEFAULTS, ROOT };
