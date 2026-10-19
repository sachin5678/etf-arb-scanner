/**
 * Historical deviation store.
 *
 * Every scan appends compact samples to data/samples-YYYY-MM-DD.jsonl:
 *   {"t":epochMs,"s":"SYMBOL","d":<ltp-vs-iNAV %>,"e":<exec(ask VWAP)-vs-iNAV %>}
 * "d" is recorded for the whole universe; "e" only when a live book was
 * available (candidates). At startup the last `windowDays` files are loaded so
 * each symbol carries its own baseline: mean / median / std / percentiles, and
 * a z-score for "is today unusual for THIS etf".
 */
const fs = require("fs");
const path = require("path");
const { mean, stddev, median, percentile } = require("./util");

class History {
  constructor(cfg) {
    this.cfg = cfg;
    this.series = new Map(); // symbol -> { d: [], e: [] }
    this.convergence = new Map(); // symbol -> { closed, converged } (fed by the paper trader)
  }

  _got(symbol) {
    if (!this.series.has(symbol)) this.series.set(symbol, { d: [], e: [] });
    return this.series.get(symbol);
  }

  load() {
    let files = [];
    try {
      files = fs
        .readdirSync(this.cfg.dataDir)
        .filter((f) => /^samples-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .sort()
        .slice(-this.cfg.history.windowDays);
    } catch {
      return { files: 0, samples: 0 };
    }
    let samples = 0;
    for (const f of files) {
      let text = "";
      try {
        text = fs.readFileSync(path.join(this.cfg.dataDir, f), "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          const r = JSON.parse(line);
          const g = this._got(r.s);
          if (Number.isFinite(r.d)) g.d.push(r.d);
          if (Number.isFinite(r.e)) g.e.push(r.e);
          samples++;
        } catch {
          /* skip malformed */
        }
      }
    }
    const cap = this.cfg.history.maxSamplesPerSymbol;
    for (const g of this.series.values()) {
      if (g.d.length > cap) g.d.splice(0, g.d.length - cap);
      if (g.e.length > cap) g.e.splice(0, g.e.length - cap);
    }
    return { files: files.length, samples };
  }

  /**
   * Append one scan's samples. rows: universe rows (need symbol + ltpDevPct).
   * execMap: Map(symbol -> execDevPct) for symbols that had a live book.
   */
  recordBatch(rows, execMap, nowMs = Date.now()) {
    const lines = [];
    for (const r of rows) {
      if (!Number.isFinite(r.ltpDevPct)) continue;
      const g = this._got(r.symbol);
      const d = Math.round(r.ltpDevPct * 1e4) / 1e4;
      g.d.push(d);
      const rec = { t: nowMs, s: r.symbol, d };
      const e = execMap && execMap.get(r.symbol);
      if (Number.isFinite(e)) {
        const ev = Math.round(e * 1e4) / 1e4;
        g.e.push(ev);
        rec.e = ev;
      }
      lines.push(JSON.stringify(rec));
    }
    const cap = this.cfg.history.maxSamplesPerSymbol;
    for (const g of this.series.values()) {
      if (g.d.length > cap) g.d.splice(0, g.d.length - cap);
      if (g.e.length > cap) g.e.splice(0, g.e.length - cap);
    }
    if (lines.length) {
      try {
        fs.appendFileSync(path.join(this.cfg.dataDir, `samples-${this.cfg._dateKey}.jsonl`), lines.join("\n") + "\n");
      } catch {
        /* disk hiccup: memory series still live */
      }
    }
    return lines.length;
  }

  /** Best series for a symbol: executable samples once they are plentiful, else LTP samples. */
  pickSeries(symbol) {
    const g = this.series.get(symbol);
    if (!g) return { key: "d", values: [], nE: 0, nD: 0 };
    const min = this.cfg.thresholds.minHistorySamples;
    const nE = g.e.length;
    const nD = g.d.length;
    if (nE >= min) return { key: "e", values: g.e, nE, nD };
    return { key: "d", values: g.d, nE, nD };
  }

  stat(symbol) {
    const { key, values, nE, nD } = this.pickSeries(symbol);
    if (!values.length) return null;
    const s = [...values].sort((a, b) => a - b);
    return {
      key, n: values.length, nE, nD,
      mean: mean(values),
      std: stddev(values),
      min: s[0],
      max: s[s.length - 1],
      p1: percentile(s, 1),
      p5: percentile(s, 5),
      p25: percentile(s, 25),
      med: median(values),
      p75: percentile(s, 75),
      p95: percentile(s, 95),
      last: values[values.length - 1],
    };
  }

  /** z = (value - mean) / std, null when there is not enough history or std is tiny. */
  z(symbol, value) {
    const st = this.stat(symbol);
    if (!st || st.n < this.cfg.thresholds.minHistorySamples) return null;
    const floor = this.cfg.thresholds.zStdFloor ?? 0.02;
    if (!Number.isFinite(st.std) || st.std < floor) return null;
    return (value - st.mean) / st.std;
  }

  convergenceStats(symbol) {
    return this.convergence.get(symbol) || { closed: 0, converged: 0 };
  }

  size() {
    return this.series.size;
  }
}

module.exports = { History };
