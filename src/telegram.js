/** Telegram delivery + message formatting (spec 24 style). */
const { esc, pct, f2, money, qtyFmt } = require("./util");

const API = (token) => `https://api.telegram.org/bot${token}/sendMessage`;

async function sendTelegram(cfg, text, { silent = false } = {}) {
  const { botToken, chatId, dryRun } = cfg.telegram;
  if (dryRun) {
    console.log(`--- TELEGRAM (dry run, ${text.length} chars) ---`);
    console.log(text.replace(/<\/?[a-z][^>]*>/gi, ""));
    console.log("--- end ---");
    return { dry: true };
  }
  if (!botToken || !chatId) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing");
  let lastErr;
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(API(botToken), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
          disable_notification: silent,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) throw new Error(`HTTP ${res.status} ${j.description || ""}`);
      return j.result;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  throw new Error(`telegram send failed: ${lastErr.message}`);
}

const istStamp = (ms) =>
  new Date(ms).toLocaleString("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }) + " IST";

function depthLine(label, levels, inav) {
  if (!levels || !levels.length) return `${label}: -`;
  return `${label}: ` + levels.map((l) => `${f2(l.p)}×${qtyFmt(l.q)}`).join("  ");
}

/** Rich single-ETF opportunity card (spec 24, adapted to what we can measure). */
function formatOpportunity(rec, { cfg, paperTrade, cooldownNote } = {}) {
  const m = rec.metrics;
  const s = m.scenarios;
  const primary = m.primary;
  const line = [];
  line.push(`\ud83d\udea8 <b>ETF ARB \u2014 BUY candidate</b>`);
  line.push(`<b>${esc(rec.symbol)}</b> \u00b7 ${esc(rec.category)}${rec.sub ? "/" + esc(rec.sub) : ""}`);
  line.push(`<i>${esc(rec.name)}</i>`);
  line.push(`<i>${istStamp(rec.at)}</i>`);
  line.push("");
  line.push(`iNAV <b>${f2(rec.inav)}</b> (age ${rec.inavAgeSec === null ? "?" : rec.inavAgeSec + "s"})`);
  line.push(`LTP ${f2(rec.ltp)} \u00b7 bid <b>${f2(rec.book.bid)}</b> \u00b7 ask <b>${f2(rec.book.ask)}</b> \u00b7 spread ${f2(m.spreadPct, 3)}%`);
  line.push("");
  line.push(`\u25b8 Executable discount <b>${pct(m.askDevPct, 3)}</b> (at ask) \u2192 ${pct(m.execDevPct, 3)} at VWAP for ${money(cfg.position.capitalPerTradeRs)} (${m.qtyTarget} u)`);
  line.push(`\u25b8 Depth \u2264 iNAV\u22120.10%: ${qtyFmt(m.buyWithin[0.1])} u buy \u00b7 ${qtyFmt(m.sellWithin[0.1])} u sell`);
  line.push(`\u25b8 Gross: full ${pct(s.A.grossPct, 3)} \u00b7 partial ${pct(s.B.grossPct, 3)} \u00b7 immediate ${pct(s.C.grossPct, 3)}`);
  if (rec.costs) {
    line.push(
      `\u25b8 Costs: ${pct(rec.costs.totalPct, 3)} round trip (STT ${cfg.costs.sttSellPct}% + stamp ${cfg.costs.stampDutyBuyPct}% + exch/SEBI/GST + DP \u20b9${cfg.costs.dpChargeFlatPerSell} + slip ${cfg.costs.slippagePct}%)`
    );
  }
  line.push(`\u25b8 Net: full ${pct(s.A.netPct, 3)} \u00b7 <b>partial ${pct(s.B.netPct, 3)}</b> \u00b7 immediate ${pct(s.C.netPct, 3)}`);
  line.push("");
  if (m.hist) {
    const spread = Number.isFinite(m.hist.std) ? ` \u00b1 ${f2(m.hist.std, 3)}` : "";
    line.push(`\u25b8 Baseline (${m.histSeries === "e" ? "exec" : "ltp"}, n=${m.hist.n}): mean ${pct(m.hist.mean, 3)}${spread} \u00b7 z ${m.z === null ? "n/a" : f2(m.z)}`);
  } else {
    line.push(`\u25b8 Baseline: no history yet (cold start rules apply)`);
  }
  const flags = rec.score.items.filter((i) => i.ok).map((i) => i.name);
  line.push(`\u25b8 Score <b>${rec.score.total}/100</b> (${flags.join(", ")})`);
  line.push("");
  line.push(`Plan: buy \u2264 ${f2(m.buyVwap)} \u00b7 exit when discount \u2264 ${cfg.exits.exitDiscountPct}% \u00b7 or bid \u2265 iNAV \u00b7 or +${cfg.exits.profitTargetNetPct}% net \u00b7 time stop ${cfg.exits.maxHoldMin} min`);
  if (paperTrade) line.push(`Paper trade <b>#${paperTrade.id}</b> opened (${money(paperTrade.notional)} \u00b7 ${paperTrade.qty} u)`);
  if (cooldownNote) line.push(`<i>${esc(cooldownNote)}</i>`);
  return line.join("\n");
}

function formatExit(trade) {
  const win = trade.netPct > 0;
  const head = win ? "\u2705 <b>PAPER EXIT</b>" : "\u274c <b>PAPER EXIT</b>";
  return [
    `${head} \u2014 ${esc(trade.symbol)} (${esc(trade.reason)})`,
    `entry ${f2(trade.entryPx)} \u2192 exit ${f2(trade.exitPx)} \u00b7 held ${trade.holdMin.toFixed(1)} min`,
    `net <b>${pct(trade.netPct, 3)}</b> (${money(trade.netRs)}) \u00b7 MAE ${pct(trade.maePct, 3)} \u00b7 MFE ${pct(trade.mfePct, 3)}`,
    `score at entry ${trade.score}`,
  ].join("\n");
}

function formatScanError(msg) {
  return `\u26a0\ufe0f <b>ETF arb scanner error</b>\n${esc(msg).slice(0, 3500)}`;
}

module.exports = { sendTelegram, formatOpportunity, formatExit, formatScanError, depthLine };
