/**
 * Trading-cost model (round trip, equity delivery, NSE ETF).
 * Every rate lives in config.json -> costs; nothing is hardcoded here.
 *
 * Rates are in percent of notional (₹100 notional -> 0.001 means 0.1 paisa).
 * GST applies to (brokerage + exchange charges + SEBI fee), not to taxes.
 * DP charge is flat per sell scrip (per day) - it dominates the cost of very
 * small tickets, which is one reason micro positions never work.
 */
function roundTripCost(cfg, { price, qty }) {
  const c = cfg.costs;
  const notional = price * qty;
  const pctOf = (pct) => (notional * pct) / 100;

  const buy = {
    brokerage: Math.max(pctOf(c.brokeragePct), c.brokerageFlatPerOrder),
    exchange: pctOf(c.exchangeTxnPct),
    sebi: pctOf(c.sebiPct),
    stamp: pctOf(c.stampDutyBuyPct),
  };
  buy.gst = ((buy.brokerage + buy.exchange + buy.sebi) * c.gstPct) / 100;

  const sell = {
    brokerage: Math.max(pctOf(c.brokeragePct), c.brokerageFlatPerOrder),
    exchange: pctOf(c.exchangeTxnPct),
    sebi: pctOf(c.sebiPct),
    stt: pctOf(c.sttSellPct),
    dp: c.dpChargeFlatPerSell,
  };
  sell.gst = ((sell.brokerage + sell.exchange + sell.sebi) * c.gstPct) / 100;

  const slippage = pctOf(c.slippagePct);

  const totalRs =
    Object.values(buy).reduce((s, v) => s + v, 0) +
    Object.values(sell).reduce((s, v) => s + v, 0) +
    slippage;

  return {
    notional,
    buy,
    sell,
    slippageRs: slippage,
    totalRs,
    totalPct: notional > 0 ? (totalRs / notional) * 100 : NaN,
  };
}

module.exports = { roundTripCost };
