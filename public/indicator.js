// indicators.js (optimized)
// computeAruAlgo: converts the Pine logic to JS working on an array of candles.
// candles: [{time: <unix sec>, open, high, low, close}, ...] oldest -> newest
// params: { sensitivity, atrPeriod, trendEmaPeriod, rsiPeriod, rsiOverbought, rsiOversold, adxPeriod, adxThreshold, slMultiplier, tpMultiplier }

'use strict';

/* Small numeric helpers */
const safeNum = (v, fallback = NaN) => (v == null || Number.isNaN(Number(v))) ? fallback : Number(v);
const isFiniteNum = v => (typeof v === 'number' && Number.isFinite(v));

/* Efficient EMA: returns array of same length (NaN for initial until it's seeded).
   Implementation computes in one pass and seeds the EMA with the first value.
*/
function emaArray(src, period) {
  const n = src.length;
  const out = new Array(n);
  if (n === 0) return out.fill(NaN);
  const k = 2 / (period + 1);
  let ema = safeNum(src[0], NaN);
  out[0] = ema;
  for (let i = 1; i < n; i++) {
    const v = safeNum(src[i], NaN);
    if (!isFiniteNum(ema)) {
      ema = v;
    } else if (!isFiniteNum(v)) {
      // preserve ema if current value invalid
      ema = ema;
    } else {
      ema = v * k + ema * (1 - k);
    }
    out[i] = ema;
  }
  return out;
}

/* ATR (True Range + Wilder's RMA). Returns array of ATR values.
   Implemented in a single pass; TR computed per bar and RMA (Wilder) applied.
*/
function atrArray(candles, period) {
  const n = candles.length;
  const out = new Array(n).fill(NaN);
  if (n === 0) return out;

  let prevClose = safeNum(candles[0].close, NaN);
  // TR for i=0 is high-low
  let tr0 = safeNum(candles[0].high, NaN) - safeNum(candles[0].low, NaN);
  if (!isFiniteNum(tr0)) tr0 = 0;
  let rma = tr0;
  out[0] = rma;

  // compute progressively
  for (let i = 1; i < n; i++) {
    const high = safeNum(candles[i].high, NaN);
    const low = safeNum(candles[i].low, NaN);
    const close = safeNum(candles[i].close, NaN);
    const t1 = (isFiniteNum(high) && isFiniteNum(low)) ? (high - low) : 0;
    const t2 = (isFiniteNum(high) && isFiniteNum(prevClose)) ? Math.abs(high - prevClose) : 0;
    const t3 = (isFiniteNum(low) && isFiniteNum(prevClose)) ? Math.abs(low - prevClose) : 0;
    const tr = Math.max(t1, t2, t3);
    if (i === period) {
      // compute initial RMA as simple average of last `period` TRs (approx)
      // but we already have rma from index 0; we will recompute sum from i-period+1..i
      let sum = 0;
      // fallback loop (few iterations); avoids extra allocations
      for (let j = Math.max(1, i - period + 1); j <= i; j++) {
        const hh = safeNum(candles[j].high, NaN);
        const ll = safeNum(candles[j].low, NaN);
        const pc = safeNum(candles[j - 1]?.close, NaN);
        const tt1 = (isFiniteNum(hh) && isFiniteNum(ll)) ? (hh - ll) : 0;
        const tt2 = (isFiniteNum(hh) && isFiniteNum(pc)) ? Math.abs(hh - pc) : 0;
        const tt3 = (isFiniteNum(ll) && isFiniteNum(pc)) ? Math.abs(ll - pc) : 0;
        sum += Math.max(tt1, tt2, tt3);
      }
      rma = sum / period;
    } else if (i > period) {
      rma = (rma * (period - 1) + tr) / period;
    } else {
      // for i < period, produce a simple average up to i
      // compute running average cheaply: rma holds previous average * (i) so far
      rma = ((rma * (i - 1 || 1)) + tr) / i;
    }
    out[i] = rma;
    prevClose = close;
  }
  return out;
}

/* RSI (Wilder smoothing). Returns array of RSI values.
   Uses initial avg gain/loss based on first `period` intervals then Wilder smoothing.
*/
function rsiArray(src, period) {
  const n = src.length;
  const out = new Array(n).fill(NaN);
  if (n < 2) return out;

  // initial sums over first 'period' diffs
  let gains = 0, losses = 0;
  const maxInit = Math.min(period, n - 1);
  for (let i = 1; i <= maxInit; i++) {
    const diff = safeNum(src[i], NaN) - safeNum(src[i - 1], NaN);
    if (diff > 0) gains += diff; else losses += -diff;
  }
  let avgGain = gains / Math.max(1, maxInit);
  let avgLoss = losses / Math.max(1, maxInit);

  // fill out array
  for (let i = 1; i < n; i++) {
    const change = safeNum(src[i], NaN) - safeNum(src[i - 1], NaN);
    const gain = (change > 0) ? change : 0;
    const loss = (change < 0) ? -change : 0;

    if (i <= period) {
      // during warm-up, we've already computed avgGain/avgLoss from the initial window
      if (i === period) {
        // compute RSI at index == period
        const rs = (avgLoss === 0) ? Infinity : (avgGain / avgLoss);
        out[i] = 100 - (100 / (1 + rs));
      } else {
        out[i] = NaN;
      }
      // update rolling avg for next steps if needed (but do not apply Wilder yet)
      // We'll transition to Wilder update after i > period
      avgGain = ((avgGain * (i - 1 || 1)) + gain) / Math.max(1, i);
      avgLoss = ((avgLoss * (i - 1 || 1)) + loss) / Math.max(1, i);
      continue;
    }

    // Wilder smoothing
    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;
    const rs = (avgLoss === 0) ? Infinity : (avgGain / avgLoss);
    out[i] = 100 - (100 / (1 + rs));
  }
  return out;
}

/* ADX computation optimized: single-pass smoothing for +DM, -DM and TR using Wilder's method */
function computeADX(candles, adxPeriod) {
  const n = candles.length;
  const adx = new Array(n).fill(NaN);
  if (n < 2) return adx;

  let prevHigh = safeNum(candles[0].high, NaN);
  let prevLow = safeNum(candles[0].low, NaN);
  let prevClose = safeNum(candles[0].close, NaN);

  // initial accumulators
  let sp = 0, sm = 0, str = 0;
  // temp arrays only for the portion we need (we avoid large arrays)
  const plusDI = new Array(n).fill(NaN);
  const minusDI = new Array(n).fill(NaN);
  const dx = new Array(n).fill(NaN);

  // compute TR, +DM, -DM and their Wilder smoothed values
  for (let i = 1; i < n; i++) {
    const high = safeNum(candles[i].high, NaN);
    const low = safeNum(candles[i].low, NaN);
    const close = safeNum(candles[i].close, NaN);

    const up = high - prevHigh;
    const down = prevLow - low;

    const plus = (up > down && up > 0) ? up : 0;
    const minus = (down > up && down > 0) ? down : 0;

    const t1 = isFiniteNum(high) && isFiniteNum(low) ? (high - low) : 0;
    const t2 = isFiniteNum(high) && isFiniteNum(prevClose) ? Math.abs(high - prevClose) : 0;
    const t3 = isFiniteNum(low) && isFiniteNum(prevClose) ? Math.abs(low - prevClose) : 0;
    const tr = Math.max(t1, t2, t3);

    if (i === 1) {
      sp = plus;
      sm = minus;
      str = tr;
    } else {
      sp = (sp * (adxPeriod - 1) + plus) / adxPeriod;
      sm = (sm * (adxPeriod - 1) + minus) / adxPeriod;
      str = (str * (adxPeriod - 1) + tr) / adxPeriod;
    }

    // compute DI values
    if (str === 0) {
      plusDI[i] = NaN;
      minusDI[i] = NaN;
    } else {
      plusDI[i] = 100 * (sp / str);
      minusDI[i] = 100 * (sm / str);
    }

    // compute dx
    const p = plusDI[i], m = minusDI[i];
    if (!isFiniteNum(p) || !isFiniteNum(m) || (p + m) === 0) {
      dx[i] = NaN;
    } else {
      dx[i] = 100 * Math.abs(p - m) / (p + m);
    }

    prevHigh = high;
    prevLow = low;
    prevClose = close;
  }

  // ADX as Wilder's RMA of dx
  let adxR = NaN;
  for (let i = 0; i < n; i++) {
    const d = dx[i];
    if (!isFiniteNum(d)) {
      adx[i] = NaN;
      continue;
    }
    if (!isFiniteNum(adxR)) {
      adxR = d;
    } else {
      adxR = ((adxR * (adxPeriod - 1)) + d) / adxPeriod;
    }
    adx[i] = adxR;
  }
  return adx;
}

/* computeAruAlgo: optimized version using incremental arrays and fewer allocations */
function computeAruAlgo(candles, params = {}) {
  const p = Object.assign({
    sensitivity: 8,
    atrPeriod: 20,
    trendEmaPeriod: 50,
    rsiPeriod: 14,
    rsiOverbought: 60,
    rsiOversold: 40,
    adxPeriod: 14,
    adxThreshold: 15,
    slMultiplier: 1.5,
    tpMultiplier: 2.0
  }, params || {});

  const n = candles.length;
  if (n === 0) return {
    smoothedAtrStop: [],
    trendEma: [],
    rsi: [],
    adx: [],
    atr: [],
    markers: [],
    signals: [],
    lastSL: NaN,
    lastTP: NaN
  };

  // extract arrays once (avoids repeated map overhead)
  const closes = new Array(n);
  const highs = new Array(n);
  const lows = new Array(n);
  for (let i = 0; i < n; i++) {
    closes[i] = safeNum(candles[i].close, NaN);
    highs[i] = safeNum(candles[i].high, NaN);
    lows[i] = safeNum(candles[i].low, NaN);
  }

  // trend EMA of closes
  const trendEma = emaArray(closes, p.trendEmaPeriod);

  // ATR (Wilder)
  const atr = atrArray(candles, p.atrPeriod);

  // Build raw ATR-stop values using incremental prev logic (similar to Pine)
  const rawAtrStop = new Array(n).fill(NaN);
  let prevAtrStop = NaN;
  for (let i = 0; i < n; i++) {
    const src = closes[i];
    const prevSrc = (i > 0) ? closes[i - 1] : src;
    const prevAtrStopVal = (i > 0) ? prevAtrStop : NaN;
    const xATR = isFiniteNum(atr[i]) ? atr[i] : (i > 0 && isFiniteNum(atr[i - 1]) ? atr[i - 1] : 0);
    const nLoss = p.sensitivity * xATR;

    let atrStop;
    if (isFiniteNum(prevAtrStopVal) && src > prevAtrStopVal && prevSrc > prevAtrStopVal) {
      atrStop = Math.max(prevAtrStopVal, src - nLoss);
    } else if (isFiniteNum(prevAtrStopVal) && src < prevAtrStopVal && prevSrc < prevAtrStopVal) {
      atrStop = Math.min(prevAtrStopVal, src + nLoss);
    } else if (!isFiniteNum(prevAtrStopVal) || src > prevAtrStopVal) {
      atrStop = src - nLoss;
    } else {
      atrStop = src + nLoss;
    }
    prevAtrStop = atrStop;
    rawAtrStop[i] = atrStop;
  }

  // Smooth rawAtrStop with EMA(5)
  const smoothedAtrStop = emaArray(rawAtrStop.map(v => isFiniteNum(v) ? v : 0), 5);

  // RSI and ADX
  const rsi = rsiArray(closes, p.rsiPeriod);
  const adx = computeADX(candles, p.adxPeriod);

  // Signals & markers
  const signals = [];
  const markers = new Array(n).fill(null);
  let lastSL = NaN, lastTP = NaN;

  for (let i = 0; i < n; i++) {
    const src = closes[i];
    const sStop = smoothedAtrStop[i];
    const prevSStop = (i > 0) ? smoothedAtrStop[i - 1] : sStop;
    // In original pine, emaLine was close (ema of length 1)
    const emaLine = closes[i];
    const prevEma = (i > 0) ? closes[i - 1] : emaLine;

    const rsiBuyConfirm = isFiniteNum(rsi[i]) && (rsi[i] < p.rsiOversold);
    const rsiSellConfirm = isFiniteNum(rsi[i]) && (rsi[i] > p.rsiOverbought);
    const adxFilter = isFiniteNum(adx[i]) ? (adx[i] > p.adxThreshold) : false;

    const trendDirection = (isFiniteNum(trendEma[i]) && isFiniteNum(closes[i])) ? ((closes[i] > trendEma[i]) ? 1 : (closes[i] < trendEma[i] ? -1 : 0)) : 0;

    const crossoverUp = (isFiniteNum(prevEma) && isFiniteNum(prevSStop) && isFiniteNum(emaLine) && isFiniteNum(sStop)) ? ((prevEma <= prevSStop) && (emaLine > sStop)) : false;
    const crossoverDown = (isFiniteNum(prevEma) && isFiniteNum(prevSStop) && isFiniteNum(emaLine) && isFiniteNum(sStop)) ? ((prevSStop <= prevEma) && (sStop > emaLine)) : false;

    const buyCond = isFiniteNum(src) && isFiniteNum(sStop) && crossoverUp && (trendDirection === 1 || trendDirection === 0) && rsiBuyConfirm && adxFilter;
    const sellCond = isFiniteNum(src) && isFiniteNum(sStop) && ( ( (prevSStop <= prevEma) && (sStop < emaLine) ) || ( (prevEma >= prevSStop) && (sStop < emaLine) ) ) && (trendDirection === -1 || trendDirection === 0) && rsiSellConfirm && adxFilter;

    const simpleBuyCond = (i > 0 && isFiniteNum(closes[i - 1]) && isFiniteNum(prevSStop) && isFiniteNum(closes[i]) && isFiniteNum(sStop)) ? ((closes[i - 1] <= prevSStop) && (closes[i] > sStop)) : false;
    const simpleSellCond = (i > 0 && isFiniteNum(closes[i - 1]) && isFiniteNum(prevSStop) && isFiniteNum(closes[i]) && isFiniteNum(sStop)) ? ((closes[i - 1] >= prevSStop) && (closes[i] < sStop)) : false;

    const xATR = isFiniteNum(atr[i]) ? atr[i] : (i > 0 && isFiniteNum(atr[i - 1]) ? atr[i - 1] : 0);
    const slDistance = xATR * p.slMultiplier;
    const tpDistance = xATR * p.tpMultiplier;

    if (buyCond) {
      const sl = src - slDistance;
      const tp = src + tpDistance;
      lastSL = sl; lastTP = tp;
      signals.push({ idx: i, type: 'buy', sl, tp });
      markers[i] = { time: candles[i].time, position: 'belowBar', color: '#00b894', shape: 'arrowUp', text: `BUY\nSL:${sl.toFixed(2)} TP:${tp.toFixed(2)}` };
    } else if (sellCond) {
      const sl = src + slDistance;
      const tp = src - tpDistance;
      lastSL = sl; lastTP = tp;
      signals.push({ idx: i, type: 'sell', sl, tp });
      markers[i] = { time: candles[i].time, position: 'aboveBar', color: '#ff7675', shape: 'arrowDown', text: `SELL\nSL:${sl.toFixed(2)} TP:${tp.toFixed(2)}` };
    } else if (simpleBuyCond) {
      const sl = src - slDistance;
      const tp = src + tpDistance;
      lastSL = sl; lastTP = tp;
      signals.push({ idx: i, type: 'simpleBuy', sl, tp });
      markers[i] = { time: candles[i].time, position: 'belowBar', color: '#66ff99', shape: 'arrowUp', text: `sBUY\nSL:${sl.toFixed(2)} TP:${tp.toFixed(2)}` };
    } else if (simpleSellCond) {
      const sl = src + slDistance;
      const tp = src - tpDistance;
      lastSL = sl; lastTP = tp;
      signals.push({ idx: i, type: 'simpleSell', sl, tp });
      markers[i] = { time: candles[i].time, position: 'aboveBar', color: '#ff9aa2', shape: 'arrowDown', text: `sSELL\nSL:${sl.toFixed(2)} TP:${tp.toFixed(2)}` };
    }
  }

  return {
    smoothedAtrStop,
    trendEma,
    rsi,
    adx,
    atr,
    markers,
    signals,
    lastSL,
    lastTP
  };
}

/* Export for Node / bundlers */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computeAruAlgo, atrArray, rsiArray, computeADX, emaArray };
}
