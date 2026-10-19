#!/usr/bin/env node
/**
 * Session report from the scanner's own files (spec 13, 16, 25):
 *   node report.js [--date YYYY-MM-DD] [--telegram]
 *
 * Reads data/samples-<date>.jsonl, candidates-<date>.jsonl, alerts-<date>.jsonl
 * and data/paper-trades.jsonl, then prints:
 *   - what the market did per time bucket
 *   - which symbols actually dislocated
 *   - what the scanner decided and why it said no (rejection histogram)
 *   - how the paper trades ended (P&L, MAE/MFE, exit mix)
 */
const fs = require("fs");
const path = require("path");
const { loadConfig } = require("./src/config");
const { istParts, mean, median, percentile, pct, f2, money, qtyFmt, esc, pad, sign } = require("./src/util");
const { sendTelegram } = require("./src/telegram");

const args = process.argv.slice(2);
const optVal = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : null;
};
const wantTelegram = args.includes("--telegram");
const cfg = loadConfig();
const dateKey = optVal("--date") || istParts().dateKey;

const readJsonl = (file) => {
  const out = [];
  try {
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip */ }
    }
  } catch { /* missing file */ }
  return out;
};

const samples = readJsonl(path.join(cfg.dataDir, `samples-${dateKey}.jsonl`));
const candidates = readJsonl(path.join(cfg.dataDir, `candidates-${dateKey}.jsonl`));
const alerts = readJsonl(path.join(cfg.dataDir, `alerts-${dateKey}.jsonl`));
const allTrades = readJsonl(path.join(cfg.dataDir, "paper-trades.jsonl"));
const stateFile = path.join(cfg.dataDir, "paper-state.json");
let openTrades = [];
try { openTrades = JSON.parse(fs.readFileSync(stateFile, "utf8")).open || []; } catch { /* none */ }

const dayTrades = allTrades.filter((t) => t.closedAt && istParts(new Date(t.closedAt)).dateKey === dateKey);

/* ------------------------------------------------------------ aggregates */
const perSymbol = new Map();
for (const s of samples) {
  if (!perSymbol.has(s.s)) perSymbol.set(s.s, []);
  perSymbol.get(s.s).push(s);
}

const buckets = [
  ["09:15-09:30", 555, 570], ["09:30-10:30", 570, 630], ["10:30-12:00", 630, 720],
  ["12:00-14:00", 720, 840], ["14:00-15:00", 840, 900], ["15:00-15:30", 900, 930],
];
const bucketRows = buckets.map(([label, a, b]) => {
  const rows = samples.filter((s) => {
    const m = istParts(new Date(s.t)).minutes;
    return m >= a && m < b;
  });
  const devs = rows.map((r) => r.d).filter(Number.isFinite);
  const flag = rows.filter((r) => Number.isFinite(r.d) && r.d >= cfg.candidates.minExecDiscountPct);
  return {
    label, n: rows.length, symbols: new Set(rows.map((r) => r.s)).size,
    meanDev: devs.length ? mean(devs) : NaN,
    maxDev: devs.length ? Math.max(...devs) : NaN,
    flags: flag.length,
    flagSymbols: new Set(flag.map((r) => r.s)).size,
  };
});

const threshold = cfg.candidates.minExecDiscountPct;
const symbolTable = [...perSymbol.entries()]
  .map(([sym, rows]) => {
    const devs = rows.map((r) => r.d).filter(Number.isFinite);
    const flagShare = devs.length ? devs.filter((d) => d >= threshold).length / devs.length : 0;
    return {
      symbol: sym, n: devs.length,
      mean: devs.length ? mean(devs) : NaN,
      med: devs.length ? median(devs) : NaN,
      p95: devs.length ? percentile(devs, 95) : NaN,
      max: devs.length ? Math.max(...devs) : NaN,
      flagShare,
    };
  })
  .filter((r) => r.n >= 10)
  .sort((a, b) => b.mean - a.mean);

const decisions = new Map();
const rejection = new Map();
for (const c of candidates) {
  decisions.set(c.decision, (decisions.get(c.decision) || 0) + 1);
  for (const reason of c.reasons || []) {
    const key = String(reason).split(":")[0].trim();
    rejection.set(key, (rejection.get(key) || 0) + 1);
  }
}
const enterRecs = candidates.filter((c) => c.decision === "ENTER");

/* ----------------------------------------------------------------- output */
const L = [];
const push = (s = "") => L.push(s);
const first = samples.length ? istParts(new Date(samples[0].t)).timeStr : "-";
const last = samples.length ? istParts(new Date(samples[samples.length - 1].t)).timeStr : "-";

push(`ETF arb session report - ${dateKey}`);
push(`samples ${samples.length} (${first}-${last}) - symbols ${perSymbol.size} - candidate evals ${candidates.length} - alerts ${alerts.length}`);
push("");

push(`Time buckets (all sampled symbols):`);
push(`  ${pad("window", 12)} ${pad("n", 6)} ${pad("sym", 5)} ${pad("meanDev", 9)} ${pad("maxDev", 8)} ${pad(">=0.25%", 8)} syms`);
for (const b of bucketRows) {
  push(`  ${pad(b.label, 12)} ${pad(b.n, 6)} ${pad(b.symbols, 5)} ${pad(pct(b.meanDev, 3), 9)} ${pad(pct(b.maxDev, 3), 8)} ${pad(b.flags, 8)} ${b.flagSymbols}`);
}
push("");

push(`Symbols with the highest typical deviation (n>=10):`);
push(`  ${pad("symbol", 12)} ${pad("n", 5)} ${pad("mean", 8)} ${pad("med", 8)} ${pad("p95", 8)} ${pad("max", 8)} %samples>=${threshold}`);
for (const r of symbolTable.slice(0, 20)) {
  push(`  ${pad(r.symbol, 12)} ${pad(r.n, 5)} ${pad(pct(r.mean, 3), 8)} ${pad(pct(r.med, 3), 8)} ${pad(pct(r.p95, 3), 8)} ${pad(pct(r.max, 3), 8)} ${(r.flagShare * 100).toFixed(0)}%`);
}
push("");

push(`Decisions: ${[...decisions.entries()].map(([k, v]) => `${k} ${v}`).join(" - ") || "none"}`);
push(`Top rejection reasons:`);
[...rejection.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([k, v]) => push(`  ${pad(k, 18)} ${v}`));
push("");
if (enterRecs.length) {
  push(`ENTER candidates:`);
  for (const e of enterRecs.slice(0, 20)) {
    push(`  ${pad(e.symbol, 12)} ${istParts(new Date(e.at)).timeStr}  exec ${pct(e.metrics.execDevPct, 3)}  netB ${pct(e.metrics.primary.netPct, 3)}  score ${e.score.total}`);
  }
  push("");
}

push(`Paper trading:`);
const wins = dayTrades.filter((t) => t.netPct > 0).length;
const realized = dayTrades.reduce((s, t) => s + (t.netRs || 0), 0);
push(`  closed ${dayTrades.length} (win ${wins} / loss ${dayTrades.length - wins})  realized ${money(realized)}  still open ${openTrades.length}`);
if (dayTrades.length) {
  push(`  avg net ${pct(mean(dayTrades.map((t) => t.netPct)), 3)}  avg hold ${f2(mean(dayTrades.map((t) => t.holdMin)), 1)} min  avg MFE ${pct(mean(dayTrades.map((t) => t.mfePct ?? 0)), 3)}  avg MAE ${pct(mean(dayTrades.map((t) => t.maePct ?? 0)), 3)}`);
  const byReason = new Map();
  for (const t of dayTrades) byReason.set(t.reason, (byReason.get(t.reason) || 0) + 1);
  push(`  exits: ${[...byReason.entries()].map(([k, v]) => `${k} x${v}`).join(" - ")}`);
  for (const t of dayTrades.slice(0, 25)) {
    push(`  #${t.id} ${pad(t.symbol, 12)} ${istParts(new Date(t.closedAt)).timeStr} ${pad(t.reason, 22)} net ${pct(t.netPct, 3)} (${money(t.netRs)}) held ${f2(t.holdMin, 0)}m`);
  }
}
for (const t of openTrades) {
  push(`  #${t.id} ${t.symbol} OPEN ${f2(t.qty)}u @ ${f2(t.entryPx)} since ${istParts(new Date(t.openedAt)).timeStr}`);
}
const text = L.join("\n");
console.log(text);
if (wantTelegram) {
  const msg = `\ud83d\udcca <b>ETF arb report ${esc(dateKey)}</b>\n<pre>${esc(text.slice(0, 3500))}</pre>`;
  sendTelegram(cfg, msg)
    .then(() => console.log("report sent to telegram"))
    .catch((e) => console.error(`telegram report failed: ${e.message}`));
}
