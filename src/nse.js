/**
 * NSE data access, dependency-free.
 *
 * 1) ETF bulk feed (cookie-less NextApi)   -> LTP / iNAV / NAV / turnover for every ETF
 * 2) Per-symbol order-book stream          -> best bid/ask + 5 levels + quantities
 *
 * The order-book stream is the interesting part. NSE's HTTP quote API is gated
 * by an Akamai JS challenge (403 for any non-browser client, cookies or not).
 * But the quote page itself streams books from a separate host:
 *
 *   wss://streamer.nseindia.com/streams/equity/high/equityStockBySymbol?symbol=X
 *
 * and that host only checks the Origin header. This module speaks plain
 * WebSocket (RFC 6455) over a raw TLS socket with Origin set - no browser,
 * no cookies, no npm packages. One socket per symbol; updates are pushed on
 * every order-book / trade change.
 */
const https = require("https");
const crypto = require("crypto");

const FEED_URL =
  "https://www.nseindia.com/api/NextApi/apiClient/marketWatchApi?functionName=getETFData&parent=all&child=null";
const FEED_PAGE = "https://www.nseindia.com/market-data/exchange-traded-funds-etf";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------- feed */

async function fetchEtfFeed(attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(FEED_URL, {
        signal: ctrl.signal,
        headers: {
          "user-agent": UA,
          accept: "application/json, text/plain, */*",
          "accept-language": "en-IN,en;q=0.9",
          referer: FEED_PAGE,
        },
      }).finally(() => clearTimeout(t));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const d = json?.data;
      if (!d || !Array.isArray(d.data)) throw new Error("unexpected payload shape");
      return d; // { data: [...], timestamp, navDate, ... }
    } catch (err) {
      lastErr = err;
      if (i < attempts) await sleep(1500 * i);
    }
  }
  throw new Error(`NSE ETF feed failed after ${attempts} attempts: ${lastErr.message}`);
}

/** Feed rows -> normalised objects with numerics. devPct is positive when the ETF is cheap. */
function normaliseRows(snapshot) {
  return snapshot.data.map((r) => {
    const ltp = Number(r.lastPrice);
    const inav = Number(r.inav);
    const nav = Number(r.nav);
    const turnover = Number(r.totalTradedValue) || 0;
    const volume = Number(r.totalTradedVolume) || 0;
    return {
      symbol: r.symbol,
      name: r.companyName || r.assets || r.symbol,
      category: String(r.mainCatagory || "").toUpperCase(),
      sub: String(r.subCatagory || "").trim(),
      ltp: Number.isFinite(ltp) ? ltp : NaN,
      inav: Number.isFinite(inav) ? inav : NaN,
      nav: Number.isFinite(nav) ? nav : NaN,
      prevClose: Number(r.previousClose) || NaN,
      turnover,
      volume,
      ltpDevPct: inav > 0 && ltp > 0 ? ((inav - ltp) / inav) * 100 : null,
      inavVsNavPct: nav > 0 && inav > 0 ? ((inav - nav) / nav) * 100 : null,
    };
  });
}

/* --------------------------------------------------------------- streamer */

/** Send one client frame (FIN set, masked as RFC 6455 requires). */
function sendFrame(socket, opcode, payload = Buffer.alloc(0)) {
  const mask = crypto.randomBytes(4);
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  try {
    socket.write(Buffer.concat([header, mask, masked]));
  } catch {
    /* socket dying; the close handler will deal with it */
  }
}

/** Order-book payload -> compact quote object. */
function parseQuote(raw) {
  const j = JSON.parse(raw);
  const ob = j.orderBook || {};
  const bids = [];
  const asks = [];
  for (let i = 1; i <= 5; i++) {
    const bp = Number(ob[`buyOrderPrice${i}`]);
    const bq = Number(ob[`buyOrderQty${i}`]);
    if (Number.isFinite(bp) && bp > 0) bids.push({ p: bp, q: Number.isFinite(bq) ? bq : 0 });
    const sp = Number(ob[`sellOrderPrice${i}`]);
    const sq = Number(ob[`sellOrderQty${i}`]);
    if (Number.isFinite(sp) && sp > 0) asks.push({ p: sp, q: Number.isFinite(sq) ? sq : 0 });
  }
  return {
    symbol: j.symbol,
    series: j.series,
    ltp: Number(j.ltp),
    timestamp: j.timestamp || j.dessiminationTime || null,
    mktStatus: j.mktStatus || null,
    volume: Number(j.volume) || 0,
    bid: bids.length ? bids[0].p : NaN,
    ask: asks.length ? asks[0].p : NaN,
    bids,
    asks,
    totalBuyQty: Number(ob.totalBuyQty) || 0,
    totalSellQty: Number(ob.totalSellQty) || 0,
  };
}

class NseStream {
  /**
   * One symbol's order-book socket. Auto-reconnects with backoff; pushes the
   * latest quote into `this.quote`. `receivedAt` = local receive time.
   */
  constructor(symbol, cfg) {
    this.symbol = symbol;
    this.cfg = cfg;
    this.connected = false;
    this.quote = null;
    this.receivedAt = 0;
    this.lastDataAt = 0;
    this.openedAt = Date.now();
    this.connects = 0;
    this.reconnects = 0;
    this.messages = 0;
    this.lastError = null;
    this._closed = false;
    this._socket = null;
    this._req = null;
    this._buf = Buffer.alloc(0);
    this._frag = [];
    this._fragOp = 1;
    this._pingTimer = setInterval(() => this._heartbeat(), cfg.streamer.heartbeatSec * 1000).unref?.() ?? null;
    this._connect();
  }

  _url() {
    return `/streams/equity/high/equityStockBySymbol?symbol=${encodeURIComponent(this.symbol)}`;
  }

  _connect() {
    if (this._closed) return;
    this.connects++;
    const key = crypto.randomBytes(16).toString("base64");
    const req = https.request({
      host: "streamer.nseindia.com",
      path: this._url(),
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
        Origin: "https://www.nseindia.com",
        "User-Agent": UA,
      },
    });
    this._req = req;

    req.setTimeout(20000, () => {
      this.lastError = "connect timeout";
      try { req.destroy(); } catch {}
    });

    req.on("upgrade", (res, socket) => {
      this._socket = socket;
      this.connected = true;
      this.lastError = null;
      this._buf = Buffer.alloc(0);
      socket.setNoDelay(true);
      socket.on("data", (chunk) => this._onData(chunk));
      socket.on("close", () => this._onDrop("socket closed"));
      socket.on("error", (e) => this._onDrop(`socket error: ${e.message}`));
    });
    req.on("response", (res) => {
      this.lastError = `upgrade refused: HTTP ${res.statusCode}`;
      res.resume();
      this._scheduleReconnect();
    });
    req.on("error", (e) => {
      if (!this.connected) {
        this.lastError = e.message;
        this._scheduleReconnect();
      }
    });
    req.end();
  }

  _scheduleReconnect() {
    if (this._closed || this._retryTimer) return;
    const { reconnectMinMs, reconnectMaxMs } = this.cfg.streamer;
    const backoff = Math.min(reconnectMaxMs, reconnectMinMs * Math.pow(2, Math.min(this.reconnects, 6)));
    const delay = backoff * (0.7 + Math.random() * 0.6);
    this.reconnects++;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._connect();
    }, delay);
  }

  _onDrop(reason) {
    if (this._closed) return;
    this.connected = false;
    this._socket = null;
    this.lastError = reason;
    this._scheduleReconnect();
  }

  _heartbeat() {
    if (this._closed) return;
    const now = Date.now();
    if (this.connected && this._socket && now - this.lastDataAt > this.cfg.streamer.heartbeatSec * 1000 * 2.5) {
      // silently dead socket - force a fresh connection
      try { this._socket.destroy(); } catch {}
      return;
    }
    if (this.connected && this._socket && now - this.lastDataAt > this.cfg.streamer.heartbeatSec * 1000) {
      sendFrame(this._socket, 0x9, Buffer.from("hb"));
    }
  }

  _onData(chunk) {
    this.lastDataAt = Date.now();
    this._buf = Buffer.concat([this._buf, chunk]);
    while (this._buf.length >= 2) {
      const b0 = this._buf[0];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (this._buf[1] & 0x80) !== 0;
      let off = 2;
      let len = this._buf[1] & 0x7f;
      if (len === 126) {
        if (this._buf.length < 4) return;
        len = this._buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this._buf.length < 10) return;
        len = Number(this._buf.readBigUInt64BE(2));
        off = 10;
      }
      let maskKey = null;
      if (masked) {
        if (this._buf.length < off + 4) return;
        maskKey = this._buf.slice(off, off + 4);
        off += 4;
      }
      if (this._buf.length < off + len) return;
      let payload = this._buf.slice(off, off + len);
      this._buf = this._buf.slice(off + len);
      if (maskKey) {
        const out = Buffer.alloc(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
        payload = out;
      }
      if (opcode === 0x9) {
        // ping -> pong (echo)
        if (this._socket) sendFrame(this._socket, 0xa, payload);
      } else if (opcode === 0x8) {
        try { this._socket && this._socket.end(); } catch {}
      } else if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        if (opcode !== 0x0) {
          this._frag = [payload];
          this._fragOp = opcode;
        } else {
          this._frag.push(payload);
        }
        if (fin) {
          const full = Buffer.concat(this._frag).toString("utf8");
          this._frag = [];
          if (this._fragOp === 0x1) this._onMessage(full);
        }
      }
      // 0xa pong -> ignore
    }
  }

  _onMessage(raw) {
    this.messages++;
    try {
      const q = parseQuote(raw);
      if (q.symbol === this.symbol || !q.symbol) {
        this.quote = q;
        this.receivedAt = Date.now();
      }
    } catch {
      /* malformed frame: keep the previous quote */
    }
  }

  /** Snapshot for consumers. */
  snapshot() {
    return {
      symbol: this.symbol,
      connected: this.connected,
      quote: this.quote,
      receivedAt: this.receivedAt,
      ageMs: this.receivedAt ? Date.now() - this.receivedAt : Infinity,
      messages: this.messages,
      reconnects: this.reconnects,
      lastError: this.lastError,
      heldMs: Date.now() - this.openedAt,
    };
  }

  close() {
    this._closed = true;
    if (this._pingTimer) clearInterval(this._pingTimer);
    if (this._retryTimer) clearTimeout(this._retryTimer);
    try { this._socket && this._socket.destroy(); } catch {}
    try { this._req && this._req.destroy(); } catch {}
    this.connected = false;
  }
}

class StreamPool {
  /** Keeps one NseStream per wanted symbol, respecting maxStreams and minHold. */
  constructor(cfg) {
    this.cfg = cfg;
    this.streams = new Map(); // symbol -> NseStream
  }

  /**
   * Make the pool match `symbols` (priority order, most interesting first).
   * Sockets for symbols outside the list are closed once they pass minHold.
   */
  sync(symbols) {
    const wanted = [...new Set(symbols)];
    const max = this.cfg.streamer.maxStreams;
    let opened = 0;
    let closed = 0;

    // open (respecting capacity), priority order
    for (const sym of wanted) {
      if (this.streams.size >= max) break;
      if (this.streams.has(sym)) continue;
      this.streams.set(sym, new NseStream(sym, this.cfg));
      opened++;
    }
    // close those no longer wanted (min hold respected)
    const now = Date.now();
    for (const [sym, s] of this.streams) {
      if (wanted.includes(sym)) continue;
      if (now - s.openedAt < this.cfg.streamer.minHoldSec * 1000) continue;
      s.close();
      this.streams.delete(sym);
      closed++;
    }
    return { opened, closed, active: this.streams.size };
  }

  get(symbol) {
    const s = this.streams.get(symbol);
    return s ? s.snapshot() : null;
  }

  /**
   * Wait until every wanted symbol has received its first quote
   * (or `timeoutMs` runs out). Returns true when all are ready.
   */
  async waitForQuotes(symbols, timeoutMs) {
    const want = symbols.filter((s) => this.streams.has(s));
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const missing = want.filter((s) => {
        const st = this.streams.get(s);
        return !st || !st.quote;
      });
      if (!missing.length) return true;
      await sleep(200);
    }
    return false;
  }

  active() {
    return [...this.streams.values()].map((s) => s.snapshot());
  }

  stop() {
    for (const s of this.streams.values()) s.close();
    this.streams.clear();
  }
}

module.exports = { fetchEtfFeed, normaliseRows, parseQuote, StreamPool, NseStream, sendFrame, FEED_URL };
