/** Small utilities: IST clock, feed timestamp parsing, stats, formatting. */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

/**
 * Wall-clock parts in IST, regardless of the host timezone (Actions runners are UTC).
 * dateKey: "YYYY-MM-DD", timeStr: "HH:MM:SS", weekday: "Mon", minutes: minutes since midnight.
 */
function istParts(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return {
    dateKey: `${p.year}-${p.month}-${p.day}`,
    timeStr: `${p.hour}:${p.minute}:${p.second}`,
    weekday: p.weekday,
    minutes: Number(p.hour) * 60 + Number(p.minute),
    seconds: Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second),
  };
}

/** "19-Oct-2026 10:14:40" | "2026-10-19 10:14:40" -> epoch ms (interpreted as IST, i.e. UTC+5:30) */
function parseIstStamp(s) {
  const str = String(s || "").trim();
  let m = /^(\d{2})-([A-Za-z]{3})-(\d{4})[ T](\d{2}):(\d{2}):(\d{2})/.exec(str);
  if (m) {
    const mm = MONTHS[m[2]];
    if (!mm) return null;
    return Date.UTC(+m[3], mm - 1, +m[1], +m[4], +m[5], +m[6]) - 5.5 * 3600 * 1000;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(str);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - 5.5 * 3600 * 1000;
  return null;
}

/* ------------------------------------------------------------------ stats */

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const stddev = (a) => {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1));
};
const median = (a) => percentile(a, 50);

/** Linear-interpolation percentile, p in 0..100. Does not mutate input. */
function percentile(a, p) {
  if (!a.length) return NaN;
  const s = Array.isArray(a) ? [...a].sort((x, y) => x - y) : a;
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

/* ---------------------------------------------------------------- format */

const sign = (n) => (n > 0 ? "+" : n < 0 ? "\u2212" : "");
const pct = (n, dp = 2) => (Number.isFinite(n) ? `${sign(n)}${Math.abs(n).toFixed(dp)}%` : "-");
const f2 = (n, dp = 2) => (Number.isFinite(n) ? n.toFixed(dp) : "-");

const money = (n) => {
  if (!Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 1e7) return `\u20b9${(n / 1e7).toFixed(2)} Cr`;
  if (Math.abs(n) >= 1e5) return `\u20b9${(n / 1e5).toFixed(2)} L`;
  if (Math.abs(n) >= 1e3) return `\u20b9${(n / 1e3).toFixed(1)} k`;
  return `\u20b9${Math.round(n)}`;
};

const qtyFmt = (n) => {
  if (!Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 1e7) return `${(n / 1e7).toFixed(2)} Cr`;
  if (Math.abs(n) >= 1e5) return `${(n / 1e5).toFixed(2)} L`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)} k`;
  return String(Math.round(n));
};

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pad = (s, w) => String(s).padEnd(w, " ");

const round2 = (n) => Math.round(n * 100) / 100;

/** Read a numeric env var with a default. */
const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== "" ? n : d;
};

module.exports = {
  sleep, istParts, parseIstStamp,
  mean, stddev, median, percentile,
  sign, pct, f2, money, qtyFmt, esc, pad, round2, num,
};
