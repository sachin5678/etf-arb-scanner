# ETF arbitrage scanner (NSE India)

Intraday scanner that finds ETFs whose **executable market price is unusually
cheap relative to a fresh, reliable estimate of fair value** — and only flags
them when the expected convergence profit beats every realistic cost.

It deliberately does *not* implement:

```text
if market_price < iNAV: BUY        # naive; exactly what this repo avoids
```

Because that naive rule is wrong four times out of five: LTP is not executable,
iNAV can be stale, "discounts" can be structural, and a 0.3% discount is inside
the spread of anything illiquid. The scanner instead requires (spec 27):

```
iNAV fresh  AND  underlying market active  AND  executable ask (VWAP for size)
below fair value  AND  spread acceptable  AND  size actually available  AND
the deviation is unusual FOR THIS ETF (z-score / baseline)  AND
gross edge >= 2x all costs  AND  net edge >= minimum  AND  score >= threshold
THEN it is a BUY candidate.
```

Verified live on this repo's first day: the rule above keeps a *persistent*
0.5–0.8% "discount" on six silver ETFs (HDFCSILVER, TATSILV, SILVERAXIS,
SILVERCASE, SILVERAG, GROWWSLVR) out of the alerts — because those funds
normally trade at that offset (it is structural, not an opportunity), while a
same-sized move in an equity ETF is unusual and does alert. See
"Structural vs unusual" below.

## Data sources

| What | Where | Notes |
|---|---|---|
| LTP / iNAV / NAV / turnover, all 355 ETFs | NSE ETF bulk feed (`NextApi/apiClient/marketWatchApi?functionName=getETFData`) | cookie-less, one request per scan |
| Best bid/ask + 5 levels + quantities, real-time | `wss://streamer.nseindia.com/streams/equity/high/equityStockBySymbol?symbol=X` | the streamer behind NSE's own quote page; needs only an `Origin: https://www.nseindia.com` header |

The order-book stream is the keystone. NSE's HTTP quote API is protected by an
Akamai JS challenge (403 for any non-browser client, with or without cookies,
even from a real browser page context when automated). The quote page's data —
though — comes from a separate host (`streamer.nseindia.com`) that accepts plain
WebSocket handshakes with the right `Origin`. `src/nse.js` implements a
zero-dependency WebSocket client (raw TLS + RFC 6455 frames + ping/pong +
auto-reconnect) for it. One socket per symbol; updates are pushed on every
book/trade change.

## How one scan flows

```
bulk feed ──► universe = top-100 by traded value today (EQUITY + COMMODITY only)
              │   (debt iNAV updates 4×/day; global ETFs freeze when their market
              │    is shut — their "discounts" are stale-feed artefacts, not signals)
              ▼
          prefilter: LTP-vs-iNAV >= 0.15%
              ▼
          order-book sockets for the best candidates (max 12, LRU by interest)
              ▼
          engine per candidate:
            executable discount  = (iNAV - ask VWAP for size) / iNAV
            spread, depth bands  = how many units trade within iNAV-0.05/0.10/0.20/0.30%
            three exits          = full convergence, partial (50%), immediate at bid
            costs                = STT + stamp + exchange + SEBI + GST + DP + slippage
            net edges            = gross - costs per scenario
            history              = mean/std/percentiles/z of THIS symbol's deviations
            reliability + score  = 0..100, weights in config.json
              ▼
          ENTER  -> Telegram alert + paper trade + ledger
          WATCH  -> logged with the exact failing gates ("why not")
```

Everything is logged to `data/*.jsonl`: every candidate evaluation (all metrics,
gates, score, decision + reasons), universe samples, alerts, and the paper
ledger. `report.js` turns the day into per-bucket stats, per-symbol deviation
profiles, rejection histograms and paper P&L.

## Expectations, not hopes: the numbers that gate a signal

Defaults (all in `config.json`):

| Gate | Default | Why |
|---|---|---|
| executable discount | ≥ 0.25% | measured at the **ask** (VWAP for the configured ticket), never at LTP |
| spread | ≤ 0.10% | the spread is the real cost; taxes are ~0.01% of notional |
| net edge (primary scenario) | ≥ 0.20% | after *all* costs |
| gross vs costs | gross ≥ 2 × costs | safety margin — edges shrink between signal and fill |
| unusual vs own history | z ≥ 2 (30+ samples) | "0.4% is huge for this ETF" beats "0.4% is big in general" |
| structural filter | baseline ≥ 0.25% + 0.10% | a discount the fund *always* trades at is not an opportunity |
| depth | full ticket fillable from book | no partial-fill fantasy |
| iNAV age | ≤ 60 s | stale fair value = fiction |
| score | ≥ 75/100 | the remaining quality sum (weights below) |

Score (0–100): unusual deviation 20 · z ≥ 2 15 · liquidity 15 · fresh iNAV 10 ·
past convergence 10 · tight spread 10 · market active 10 · depth ≥ ticket 10.

## Costs (round trip, delivery ETF, configurable)

STT 0.001% (sell only) · stamp 0.005% (buy only) · NSE txn 0.00297%/side ·
SEBI 0.0001%/side · GST 18% on (brokerage+txn+SEBI) · DP ₹15.34 flat (sell) ·
slippage buffer 0.02%. On a ₹50,000 ticket that is ≈ ₹32 ≈ **0.064%** — which is
why the minimum net edge sits at 0.20%, not 0.05%.

## Structural vs unusual (the lesson that shaped the engine)

Measured 19 Oct 2026 (first hour, 90-second sampling of the top-100):

* Equity ETF discounts are **transient** — only 44% survive 90 seconds.
* Six silver ETFs sat at a persistent +0.3…+0.8% "discount" all session
  (HDFCSILVER flagged in 100% of samples), while SILVERBEES traded at par.

The engine's `structural` guard generalises that: if a symbol's own baseline
deviation is ≥ 0.25% and today's move doesn't exceed it by ≥ 0.10%, the signal
is rejected however large the discount looks. Cold start (first ~5 samples of a
symbol) falls back to an absolute 0.40% threshold so a fresh restart never goes
blind — then the baseline takes over.

## Paper trading first (by design)

Every ENTER is also booked as a paper trade at the executable VWAP (size from
`position.capitalPerTradeRs`) and managed with explicit exits:

1. **convergence** — discount falls to ≤ 0.10%
2. **bid reaches iNAV**
3. **profit target** — net ≥ +0.30%
4. **time stop** — 30 minutes
5. **invalidation** — fair value falls below entry, or market closes

The ledger records entry/exit prices, net P&L after costs, holding time and the
full MAE/MFE path (`data/paper-trades.jsonl`). `report.js` aggregates it.
Real money should only follow after the ledger shows the edges are real.

## Usage

```powershell
cd etf-arb-scanner
Copy-Item .env.example .env      # bot token + chat id (same bot as etf-nav-alert works)
npm start                        # continuous, market hours, real Telegram alerts
npm run dry                      # one scan, prints everything, sends nothing
node scanner.js --minutes 60     # bounded run
node scanner.js --once           # single scan (cron / GitHub Actions friendly)
node scanner.js --symbols SILVERBEES,NIFTYBEES --dry   # force-debug specific symbols
node report.js                   # today's session report
node report.js --telegram        # ... also sent to the chat
```

No npm dependencies; Node ≥ 18 (uses global `fetch`; the WebSocket client is
hand-rolled).

**Where to run it.** Continuous socket streaming wants a machine that stays on
during market hours: run it locally (Task Scheduler at 09:14 IST). GitHub
Actions can host bounded runs (`--once` or `--minutes N` via `workflow_dispatch`),
but hosted runners are a poor fit for held sockets and lose the day's state
between jobs.

## Configuration

`config.json` is the single source of truth (thresholds, costs, position sizing,
exit rules, score weights, streamer limits, history windows). `.env` holds only
secrets and quick switches. Highlights:

| Key | Default | Meaning |
|---|---|---|
| `universe.topLiquidN` | 100 | liquidity universe size |
| `universe.categories` | EQUITY, COMMODITY | iNAV-fresh categories only |
| `scan.intervalSec` | 20 | feed poll cadence |
| `streamer.maxStreams` | 12 | concurrent book sockets |
| `candidates.prefilterDiscountPct` | 0.15 | LTP-vs-iNAV wake-up threshold |
| `thresholds.*` | see above | all gates |
| `position.capitalPerTradeRs` | 50000 | ticket size for VWAP / sizing / paper |
| `exits.*` | 0.10 / 0.30 / 30min | exit rules |
| `alerts.cooldownMin` | 30 | per-symbol alert cooldown |

## Honest limits

* **No creation/redemption leg.** Retail cannot arbitrage the basket; the trade
  is "buy the discount, wait for convergence". If it doesn't converge, the time
  stop takes you out — the system never assumes mean reversion (spec 20).
* **iNAV is taken on trust.** There is no independent fair-value computation
  (that would need constituent feeds); instead freshness, category rules, the
  iNAV-vs-NAV sanity bound and the history baseline carry the reliability job.
* **Intraday round trip** needs an intraday-capable product (MIS) or existing
  holdings of the same ETF in the demat account.
* **Streamer etiquette.** One socket per symbol, capped at 12, reconnect with
  backoff. It is a public host of NSE's website; keep it gentle.
* **Not investment advice.** Paper first.

## References

* SEBI, *Circular on development of passive funds* (May 23, 2022) — iNAV
  dissemination frequency per category.
* SEBI, *Norms for base price, price bands... for ETFs* (June 15, 2026,
  effective Sep 7, 2026) — VWAP-based base price; 10%→20% / 5% / 6% bands.
* NSE ETF market-watch feed and the quote-page streamer (see Data sources).
