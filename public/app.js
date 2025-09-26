/* app.js — unified version with paper/server restore + draggable SL/TP shapes
   Paste this whole file into your client-side JS bundle (or include as a script).
*/

/* Config */
const HANDLE_HOVER_DELAY = 200;
const SNAP_TIME_THRESHOLD_SEC = 60 * 60 * 24;

/* Elements */
const chartDiv = document.getElementById('chart');
const overlay = document.getElementById('overlay');
const ctx = overlay ? overlay.getContext('2d') : null;
const handlesLayer = document.getElementById('handlesLayer');
const statusEl = document.getElementById('status');
const symbolSelect = document.getElementById('symbolSelect');
const tfSelect = document.getElementById('tfSelect');
const highlightCheckbox = document.getElementById('highlightCheckbox');
const highlightThreshold = document.getElementById('highlightThreshold');
const signalListEl = document.getElementById('signalList');
const equityCanvas = document.getElementById('equityChart');

/* Bottom backtest elements (from modal and panel) */
const btRun = document.getElementById('btRun');
const btStrategy = document.getElementById('btStrategy');
const btSymbol = document.getElementById('btSymbol');
const btInterval = document.getElementById('btInterval');
const btSmaShort = document.getElementById('btSmaShort');
const btSmaLong = document.getElementById('btSmaLong');
const btCapital = document.getElementById('btCapital');
const btStatus = document.getElementById('btStatus');
const btResultInline = document.getElementById('btResultInline') || (function(){
  const el = document.createElement('div');
  el.id = 'btResultInline';
  el.style.color = '#9fb4d6';
  el.style.fontSize = '13px';
  el.style.marginLeft = '12px';
  el.classList.add('hidden');
  if (statusEl && statusEl.parentNode) {
    statusEl.parentNode.appendChild(el);
  } else {
    document.body.appendChild(el);
  }
  return el;
})();

/* Modal elements */
const openBacktestPanel = document.getElementById('openBacktestPanel');
const backtestModal = document.getElementById('backtestModal');
const closeBacktestModal = document.getElementById('closeBacktestModal');
const liveBadge = document.getElementById('liveBadge');
const paperPanel = document.getElementById('paperPanel');
const tradingPanelTab = document.querySelector('#bottomBar .bt-tab:nth-child(2)'); // Trading Panel tab
const historyTab = document.querySelector('#bottomBar .bt-tab:nth-child(3)'); // History tab
const historyPanel = document.getElementById('historyPanel');
const historyTradesList = document.getElementById('historyTradesList');

/* ============================
   NEW: Timeframes (added)
   ============================ */
const AVAILABLE_TIMEFRAMES = [
  '1m','3m','5m','15m','30m',
  '1h','2h','4h','6h','8h','12h',
  '1d','3d','1w','1M'
];

function populateTimeframeSelects() {
  const makeOptions = (arr) => arr.map(i => `<option value="${i}">${i}</option>`).join('');
  try {
    if (tfSelect) {
      if (!tfSelect.children.length || tfSelect.children.length < AVAILABLE_TIMEFRAMES.length) {
        tfSelect.innerHTML = makeOptions(AVAILABLE_TIMEFRAMES);
      }
    }
    if (btInterval) {
      if (!btInterval.children.length || btInterval.children.length < AVAILABLE_TIMEFRAMES.length) {
        btInterval.innerHTML = makeOptions(AVAILABLE_TIMEFRAMES);
      }
    }
  } catch (e) {
    console.warn('populateTimeframeSelects err', e);
  }
}
function isValidInterval(i) {
  if (!i) return false;
  return AVAILABLE_TIMEFRAMES.includes(String(i).trim());
}
/* ============================
   END New timeframes
   ============================ */

/* Chart (LightweightCharts) */
const chart = LightweightCharts.createChart(chartDiv, {
  layout:{ backgroundColor:'#000000', textColor:'#d8e6f6' },
  grid:{ vertLines:{ color:'#111111' }, horzLines:{ color:'#111111' } },
  rightPriceScale:{ borderVisible:false }, timeScale:{ borderVisible:false },
  handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true },
  handleScale: { axisPressedMouseMove: true, pinch: true, mouseWheel: true },
  crosshair: {
    mode: LightweightCharts.CrosshairMode.Normal,
    vertLine: { visible: true, style: 0, width: 1, color: 'rgba(255, 255, 255, 0.3)' },
    horzLine: { visible: true, style: 0, width: 1, color: 'rgba(255, 255, 255, 0.3)' }
  }
});
const series = chart.addCandlestickSeries({ upColor: '#26a69a', downColor: '#ef5350', borderVisible:false });

/* --- indicator line series (AruAlgo visualizations) --- */
const atrStopSeries = chart.addLineSeries({ color: 'rgba(255,205,86,0.95)', lineWidth: 1.5, priceLineVisible: false });
const trendEmaSeries = chart.addLineSeries({ color: 'rgba(153,102,255,0.95)', lineWidth: 1.0, priceLineVisible: false });

/* state */
let candles = [];
let ws = null;
let wsReady = false;
let pendingSubscribe = null;
let currentSubscription = null;

// separate marker lists so paper markers don't get overwritten by indicator updates
let indicatorMarkers = [];
let paperMarkers = [];
let shapes = []; // drawing shapes (kept global)
let equityData = [];
let equityChart = null;

/* Utilities */
function toSeconds(ms){ return Math.floor(ms/1000); }
function normalizeSymbol(s){ if(!s) return s; return String(s).trim().toUpperCase(); }
function normalizeInterval(i){
  if(!i) return i;
  const str = String(i).trim();
  return str;
}

/* init equity chart */
function initEquityChart(){
  if (!equityCanvas) return;
  const ctxEq = equityCanvas.getContext('2d');
  equityChart = new Chart(ctxEq, {
    type: 'line',
    data: { labels: equityData.map(d=>new Date(d.time*1000).toLocaleTimeString()), datasets: [{ label: 'Equity proxy', data: equityData.map(d=>d.value), borderColor: '#2f8cff', backgroundColor: 'rgba(47,140,255,0.06)', tension: 0.2, pointRadius: 0 }] },
    options: { animation:false, responsive:true, scales: { x: { display:false }, y: { ticks: { color:'#9fb4d6' } } }, plugins: { legend:{ display:false } } }
  });
}
initEquityChart();

/* ---------- ARUALGO indicator implementation (keep intact) ---------- */
/* (unchanged) */
function sma(arr) { if (!arr || arr.length === 0) return null; return arr.reduce((a,b)=>a+b,0)/arr.length; }
function emaArray(src, period){
  const out = new Array(src.length).fill(NaN);
  const k = 2/(period+1);
  let prev = NaN;
  for (let i=0;i<src.length;i++){
    const v = src[i];
    if (i===0) { prev = v; out[i]=v; continue; }
    if (isNaN(prev)) { prev = v; out[i]=v; continue; }
    prev = v * k + prev * (1-k);
    out[i] = prev;
  }
  return out;
}
function rsiArray(src, period){
  const out = new Array(src.length).fill(NaN);
  if (src.length < 2) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= Math.min(period, src.length-1); i++){
    const diff = src[i] - src[i-1];
    if (diff>0) gains += diff; else losses += -diff;
  }
  let avgGain = (period<=src.length-1) ? gains/period : gains/Math.max(1, src.length-1);
  let avgLoss = (period<=src.length-1) ? losses/period : losses/Math.max(1, src.length-1);
  for (let i=0;i<src.length;i++){
    if (i===0) { out[i] = NaN; continue; }
    const change = src[i] - src[i-1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (i <= period) {
      if (i === period) {
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        out[i] = 100 - (100 /(1 + rs));
      } else {
        out[i] = NaN;
      }
      continue;
    }
    avgGain = (avgGain*(period-1) + gain)/period;
    avgLoss = (avgLoss*(period-1) + loss)/period;
    const rs = avgLoss === 0 ? 100 : avgGain/avgLoss;
    out[i] = 100 - (100/(1+rs));
  }
  return out;
}
function atrArray(candles, period){
  const out = new Array(candles.length).fill(NaN);
  if (candles.length===0) return out;
  const tr = new Array(candles.length).fill(0);
  for (let i=0;i<candles.length;i++){
    if (i===0){ tr[i] = candles[i].high - candles[i].low; continue; }
    tr[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i-1].close),
      Math.abs(candles[i].low - candles[i-1].close)
    );
  }
  let rma = NaN;
  for (let i=0;i<candles.length;i++){
    if (i === 0){ rma = tr[i]; out[i] = rma; continue; }
    if (i < period) {
      const sum = tr.slice(1, i+1).reduce((a,b)=>a+b,0);
      out[i] = sum / Math.max(1, i);
      continue;
    }
    if (i === period) {
      const sum = tr.slice(i-period+1, i+1).reduce((a,b)=>a+b,0);
      rma = sum / period;
    } else {
      rma = (rma*(period-1) + tr[i]) / period;
    }
    out[i] = rma;
  }
  return out;
}
function computeADX(candles, adxPeriod) {
  const len = candles.length;
  const plusDM = new Array(len).fill(0);
  const minusDM = new Array(len).fill(0);
  const tr = new Array(len).fill(0);
  for (let i=1;i<len;i++){
    const up = candles[i].high - candles[i-1].high;
    const down = candles[i-1].low - candles[i].low;
    plusDM[i] = (up > down && up > 0) ? up : 0;
    minusDM[i] = (down > up && down > 0) ? down : 0;
    tr[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i-1].close),
      Math.abs(candles[i].low - candles[i-1].close)
    );
  }
  const rPlus = new Array(len).fill(NaN);
  const rMinus = new Array(len).fill(NaN);
  const rTR = new Array(len).fill(NaN);
  let sp = 0, sm = 0, str = 0;
  for (let i=1;i<len;i++){
    if (i === 1) {
      sp = plusDM[i];
      sm = minusDM[i];
      str = tr[i];
    } else {
      sp = (sp*(adxPeriod-1) + plusDM[i]) / adxPeriod;
      sm = (sm*(adxPeriod-1) + minusDM[i]) / adxPeriod;
      str = (str*(adxPeriod-1) + tr[i]) / adxPeriod;
    }
    rPlus[i] = sp;
    rMinus[i] = sm;
    rTR[i] = str;
  }
  const plusDI = new Array(len).fill(NaN);
  const minusDI = new Array(len).fill(NaN);
  for (let i=0;i<len;i++){
    if (!rTR[i] || rTR[i] === 0) { plusDI[i] = NaN; minusDI[i] = NaN; continue; }
    plusDI[i] = 100 * rPlus[i] / rTR[i];
    minusDI[i] = 100 * rMinus[i] / rTR[i];
  }
  const dx = new Array(len).fill(NaN);
  for (let i=0;i<len;i++){
    if (isNaN(plusDI[i]) || isNaN(minusDI[i]) || (plusDI[i]+minusDI[i])===0) { dx[i] = NaN; continue; }
    dx[i] = 100 * Math.abs(plusDI[i] - minusDI[i]) / (plusDI[i] + minusDI[i]);
  }
  const adx = new Array(len).fill(NaN);
  let adxR = NaN;
  for (let i=0;i<len;i++){
    if (isNaN(dx[i])) { adx[i] = NaN; continue; }
    if (i === 0) { adxR = dx[i]; adx[i] = adxR; continue; }
    adxR = ( (isNaN(adxR) ? dx[i] : adxR)*(adxPeriod-1) + dx[i] )/adxPeriod;
    adx[i] = adxR;
  }
  return adx;
}

/* computeAruAlgo: returns stops, ema, rsi, adx, atr, markers, signals */
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
  if (n === 0) return {};
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const trendEma = emaArray(closes, p.trendEmaPeriod);
  const atr = atrArray(candles, p.atrPeriod);
  const smoothedAtrStop = new Array(n).fill(NaN);
  let prevAtrStop = NaN;
  for (let i=0;i<n;i++){
    const src = closes[i];
    const prevSrc = (i>0) ? closes[i-1] : src;
    const prevAtrStopVal = (i>0) ? prevAtrStop : NaN;
    const xATR = atr[i] || atr[Math.max(0,i-1)] || 0;
    const nLoss = p.sensitivity * xATR;
    let atrStop;
    if (!isNaN(prevAtrStopVal) && src > prevAtrStopVal && prevSrc > prevAtrStopVal) {
      atrStop = Math.max(prevAtrStopVal, src - nLoss);
    } else if (!isNaN(prevAtrStopVal) && src < prevAtrStopVal && prevSrc < prevAtrStopVal) {
      atrStop = Math.min(prevAtrStopVal, src + nLoss);
    } else if (src > prevAtrStopVal || isNaN(prevAtrStopVal)) {
      atrStop = src - nLoss;
    } else {
      atrStop = src + nLoss;
    }
    prevAtrStop = atrStop;
    smoothedAtrStop[i] = atrStop;
  }
  const rawStops = smoothedAtrStop.slice();
  const smoothStops = emaArray(rawStops.map(v => isNaN(v)?0:v), 5);
  const rsi = rsiArray(closes, p.rsiPeriod);
  const adx = computeADX(candles, p.adxPeriod);
  const signals = [];
  const markers = new Array(n).fill(null);
  let lastSL = NaN, lastTP = NaN;
  for (let i=0;i<n;i++){
    const src = closes[i];
    const sStop = smoothStops[i];
    const prevSStop = (i>0) ? smoothStops[i-1] : sStop;
    const emaLine = closes[i];
    const prevEma = (i>0) ? closes[i-1] : emaLine;
    const rsiBuyConfirm = rsi[i] < p.rsiOversold;
    const rsiSellConfirm = rsi[i] > p.rsiOverbought;
    const adxFilter = (adx[i] || 0) > p.adxThreshold;
    const trendDirection = (closes[i] > trendEma[i]) ? 1 : (closes[i] < trendEma[i] ? -1 : 0);
    const crossoverUp = (prevEma <= prevSStop) && (emaLine > sStop);
    const crossoverDown = (prevSStop <= prevEma) && (sStop > emaLine);
    const buyCond = (src > sStop) && crossoverUp && (trendDirection === 1 || trendDirection === 0) && rsiBuyConfirm && adxFilter;
    const sellCond = (src < sStop) && ((prevSStop <= prevEma) && (sStop < emaLine) || ((prevEma >= prevSStop) && (sStop < emaLine))) && (trendDirection === -1 || trendDirection === 0) && rsiSellConfirm && adxFilter;
    const simpleBuyCond = (i>0) && (closes[i-1] <= prevSStop) && (closes[i] > sStop);
    const simpleSellCond = (i>0) && (closes[i-1] >= prevSStop) && (closes[i] < sStop);
    const xATR = atr[i] || (i>0?atr[i-1]:0);
    const slDistance = xATR * p.slMultiplier;
    const tpDistance = xATR * p.tpMultiplier;
    if (buyCond) {
      const sl = src - slDistance;
      const tp = src + tpDistance;
      lastSL = sl; lastTP = tp;
      signals.push({ idx:i, type:'buy', sl, tp });
      markers[i] = { time: candles[i].time, position: 'belowBar', color:'#00b894', shape:'arrowUp', text: `BUY\nSL:${sl.toFixed(2)} TP:${tp.toFixed(2)}` };
    } else if (sellCond) {
      const sl = src + slDistance;
      const tp = src - tpDistance;
      lastSL = sl; lastTP = tp;
      signals.push({ idx:i, type:'sell', sl, tp });
      markers[i] = { time: candles[i].time, position: 'aboveBar', color:'#ff7675', shape:'arrowDown', text: `SELL\nSL:${sl.toFixed(2)} TP:${tp.toFixed(2)}` };
    } else if (simpleBuyCond) {
      const sl = src - slDistance;
      const tp = src + tpDistance;
      lastSL = sl; lastTP = tp;
      signals.push({ idx:i, type:'simpleBuy', sl, tp });
      markers[i] = { time: candles[i].time, position: 'belowBar', color:'#66ff99', shape:'arrowUp', text: `sBUY\nSL:${sl.toFixed(2)} TP:${tp.toFixed(2)}` };
    } else if (simpleSellCond) {
      const sl = src + slDistance;
      const tp = src - tpDistance;
      lastSL = sl; lastTP = tp;
      signals.push({ idx:i, type:'simpleSell', sl, tp });
      markers[i] = { time: candles[i].time, position: 'aboveBar', color:'#ff9aa2', shape:'arrowDown', text: `sSELL\nSL:${sl.toFixed(2)} TP:${tp.toFixed(2)}` };
    }
  }
  return {
    smoothedAtrStop: smoothStops,
    trendEma,
    rsi,
    adx,
    atr,
    markers,
    signals,
    lastSL: lastSL,
    lastTP: lastTP
  };
}

/* ---------- apply indicators and plot helper ---------- */
let indicatorScheduled = false;
function safeApplyIndicators(paramsOverride) {
  if (indicatorScheduled) return;
  indicatorScheduled = true;
  window.requestAnimationFrame(() => {
    indicatorScheduled = false;
    try {
      applyAruAlgoAndPlot(paramsOverride);
    } catch (err) {
      console.warn('applyAruAlgoAndPlot err', err);
    }
  });
}

function mapToChartTime(t) {
  if (typeof t === 'number' && String(t).length > 10) return Math.floor(t/1000);
  return t;
}

function applyAruAlgoAndPlot(paramsOverride = {}) {
  if (!candles || candles.length === 0) {
    try { atrStopSeries.setData([]); } catch(e){}
    try { trendEmaSeries.setData([]); } catch(e){}
    indicatorMarkers = [];
    updateMarkers();
    return;
  }
  const out = computeAruAlgo(candles, paramsOverride);

  const atrLine = [];
  const emaLine = [];
  for (let i = 0; i < candles.length; i++) {
    const t = mapToChartTime(candles[i].time);
    const s = out.smoothedAtrStop && out.smoothedAtrStop[i];
    if (Number.isFinite(s)) atrLine.push({ time: t, value: s });
    const e = out.trendEma && out.trendEma[i];
    if (Number.isFinite(e)) emaLine.push({ time: t, value: e });
  }

  try { atrStopSeries.setData(atrLine); } catch (e) { console.warn('atrStopSeries.setData', e); }
  try { trendEmaSeries.setData(emaLine); } catch (e) { console.warn('trendEmaSeries.setData', e); }

  // build indicatorMarkers (don't directly call series.setMarkers here)
  const markerArr = [];
  if (out.markers && Array.isArray(out.markers)) {
    for (let i = 0; i < out.markers.length; i++) {
      const m = out.markers[i];
      if (!m) continue;
      markerArr.push({
        time: mapToChartTime(m.time),
        position: m.position || 'belowBar',
        color: m.color || (m.shape && m.shape === 'arrowUp' ? '#00b894' : '#ff7675'),
        shape: m.shape || 'arrowUp',
        text: m.text || ''
      });
    }
  }
  // keep up to 200 indicator markers
  indicatorMarkers = markerArr.slice(-200);
  updateMarkers();
}

/* ---------- History fetchers (unchanged) ---------- */
async function fetchServerHistory(symbol, interval, limit=1000){
  try{
    const url = `/history?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${Math.min(1000, limit)}`;
    const res = await fetch(url, { cache: 'no-store' });
    if(!res.ok) { console.warn('server /history returned', res.status); return null; }
    const json = await res.json();
    if(!json || !Array.isArray(json.data)) return null;
    const arr = json.data.map(k => ({ time: Number(k.time), open: Number(k.open), high: Number(k.high), low: Number(k.low), close: Number(k.close) })).sort((a,b)=>a.time - b.time);
    return arr;
  } catch (err) { console.warn('fetchServerHistory err', err); return null; }
}
async function loadKlinesREST(symbol, interval, limit=1000){
  try{
    if (statusEl) statusEl.innerText = `Status: loading ${symbol} ${interval} (binance REST) ...`;
    const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    if(!res.ok) throw new Error('REST fetch failed ' + res.status);
    const data = await res.json();
    return data.map(k => ({ time: toSeconds(k[0]), open: +k[1], high: +k[2], low: +k[3], close: +k[4] }));
  }catch(e){ console.warn('binance REST err', e); return null; }
}

/* Attempt server history -> ws snapshot -> binance REST */
async function loadLocalSnapshot(sym, tf){
  if (statusEl) statusEl.innerText = `Loading ${sym} ${tf} (history)...`;
  const srv = await fetchServerHistory(sym, tf, 1000);
  if (srv && srv.length > 0) {
    candles = srv;
    try { series.setData(candles); } catch(e){ console.warn('series.setData history', e); }
    safeApplyIndicators();
    buildEquityFromCandles();
    try{ chart.timeScale().fitContent(); }catch(e){}
    // --- NEW: evaluate paper positions on last bar of loaded history
    if (candles && candles.length) evaluatePaperPositionsOnCandle(candles[candles.length-1]);
    if (statusEl) statusEl.innerText = `Loaded ${sym} ${tf} (server history: ${candles.length} bars)`;
    return true;
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type:'get_snapshot', symbol: sym, interval: tf, limit: 1000 }));
      if (statusEl) statusEl.innerText = 'Requested snapshot from server (ws)...';
      const start = Date.now();
      while (Date.now() - start < 1500) {
        if (candles && candles.length > 20) {
          try { series.setData(candles); } catch(e){ console.warn('series.setData snapshot', e); }
          safeApplyIndicators();
          buildEquityFromCandles();
          try{ chart.timeScale().fitContent(); }catch(e){}
          if (candles && candles.length) evaluatePaperPositionsOnCandle(candles[candles.length-1]);
          if (statusEl) statusEl.innerText = `Snapshot loaded ${sym} ${tf} (${candles.length} bars)`;
          return true;
        }
        await new Promise(r => setTimeout(r, 100));
      }
    } catch (err) { console.warn('snapshot request failed', err); }
  }

  const bin = await loadKlinesREST(sym, tf, 1000);
  if (bin && bin.length > 0) {
    candles = bin.sort((a,b)=>a.time - b.time);
    try { series.setData(candles); } catch(e){ console.warn('series.setData bin', e); }
    safeApplyIndicators();
    buildEquityFromCandles();
    try{ chart.timeScale().fitContent(); }catch(e){}
    if (candles && candles.length) evaluatePaperPositionsOnCandle(candles[candles.length-1]);
    if (statusEl) statusEl.innerText = `Loaded ${sym} ${tf} (binance REST: ${candles.length} bars)`;
    return true;
  }

  if (statusEl) statusEl.innerText = `No historical bars available for ${sym} ${tf}`;
  return false;
}

/* --- subscription helpers --- */
function doSubscribe(symbol, interval){
  if(!ws || ws.readyState !== WebSocket.OPEN) { pendingSubscribe = { symbol, interval }; return; }
  try { ws.send(JSON.stringify({ type:'get_snapshot', symbol, interval, limit: 1000 })); } catch(e){ console.warn('get_snapshot send failed', e); }
  try { ws.send(JSON.stringify({ type:'subscribe', symbol, interval })); currentSubscription = { symbol, interval }; if (statusEl) statusEl.innerText = `Subscribed to ${symbol} ${interval} (ws)`; } catch (e) { console.warn('subscribe send fail', e); }
}
function doUnsubscribe(symbol, interval){
  if(!ws || ws.readyState !== WebSocket.OPEN) { if (pendingSubscribe && pendingSubscribe.symbol===symbol && pendingSubscribe.interval===interval) pendingSubscribe = null; currentSubscription = null; return; }
  try { ws.send(JSON.stringify({ type:'unsubscribe', symbol, interval })); currentSubscription = null;
    // when unsubscribing we want to clear indicator markers but keep paper markers
    indicatorMarkers = [];
    updateMarkers();
    if (statusEl) statusEl.innerText = `Unsubscribed ${symbol} ${interval}`;
  } catch(e){ console.warn('unsubscribe failed', e); }
}
async function loadAndConnect(symRaw, tfRaw){
  const sym = normalizeSymbol(symRaw);
  const tf = normalizeInterval(tfRaw);
  if (currentSubscription && (currentSubscription.symbol !== sym || currentSubscription.interval !== tf)) { doUnsubscribe(currentSubscription.symbol, currentSubscription.interval); }
  try { series.setData([]); } catch(_) {}
  candles = []; // keep paperMarkers/paper shapes — don't nuke server-sourced paper markers on symbol change; they are tied to symbol/interval in pos objects
  await loadLocalSnapshot(sym, tf);
  pendingSubscribe = { symbol: sym, interval: tf };
  if (ws && ws.readyState === WebSocket.OPEN) doSubscribe(sym, tf);
  else if (statusEl) statusEl.innerText = `History loaded for ${sym} ${tf} — waiting for WS to subscribe`;
}

/* symbol/timeframe change handlers */
if (symbolSelect) symbolSelect.addEventListener('change', ()=> { const sym = normalizeSymbol(symbolSelect.value); const tf = normalizeInterval(tfSelect ? tfSelect.value : '1m'); loadAndConnect(sym, tf); });
if (tfSelect) tfSelect.addEventListener('change', ()=> { const sym = normalizeSymbol(symbolSelect ? symbolSelect.value : 'BTCUSDT'); const tf = normalizeInterval(tfSelect.value); loadAndConnect(sym, tf); });

/* Modal and panel event handlers */
if (openBacktestPanel) openBacktestPanel.addEventListener('click', () => { if (backtestModal) backtestModal.style.display = 'flex'; });
if (closeBacktestModal) closeBacktestModal.addEventListener('click', () => { if (backtestModal) backtestModal.style.display = 'none'; });
if (tradingPanelTab) tradingPanelTab.addEventListener('click', () => { if (paperPanel) paperPanel.style.display = paperPanel.style.display === 'none' ? 'block' : 'none'; });

if (historyTab) historyTab.addEventListener('click', () => { if (historyPanel) historyPanel.style.display = historyPanel.style.display === 'none' ? 'block' : 'none'; loadPaperHistory(); });

/* Collapse/Expand buttons for bottom panel */
const collapseBtn = document.getElementById('collapseBtn');
const expandBtn = document.getElementById('expandBtn');
if (collapseBtn) collapseBtn.addEventListener('click', () => {
  if (historyPanel) historyPanel.style.display = 'none';
  collapseBtn.style.display = 'none';
  expandBtn.style.display = 'inline-block';
});
if (expandBtn) expandBtn.addEventListener('click', () => {
  if (historyPanel) historyPanel.style.display = 'block';
  expandBtn.style.display = 'none';
  collapseBtn.style.display = 'inline-block';
});

/* Backtest elements */
const btMetrics = document.getElementById('btMetrics');
const btTrades = document.getElementById('btTrades');
const backtestResults = document.getElementById('backtestResults');
const btEquityChartCanvas = document.getElementById('btEquityChart');

/* Backtest logic */
let btEquityChartInstance = null;

function initBtEquityChart(labels, data) {
  if (btEquityChartCanvas) {
    const ctx = btEquityChartCanvas.getContext('2d');
    if (btEquityChartInstance) {
      btEquityChartInstance.destroy();
    }
    btEquityChartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: 'Equity',
          data: data,
          borderColor: '#2f8cff',
          backgroundColor: 'rgba(47, 140, 255, 0.1)',
          tension: 0.1,
          fill: true
        }]
      },
      options: {
        responsive: true,
        animation: false,
        scales: {
          x: { display: false },
          y: {
            ticks: { color: '#9fb4d6' },
            grid: { color: '#111111' }
          }
        },
        plugins: { legend: { display: false } }
      }
    });
  }
}

async function runBacktest() {
  if (!btStrategy || !btSymbol || !btInterval || !btSmaShort || !btSmaLong || !btCapital || !btStatus) return;

  const strategy = btStrategy.value;
  const symbol = normalizeSymbol(btSymbol.value);
  const interval = normalizeInterval(btInterval.value);
  const shortPeriod = parseInt(btSmaShort.value) || 10;
  const longPeriod = parseInt(btSmaLong.value) || 30;
  const initialCapital = parseFloat(btCapital.value) || 10000;

  btStatus.textContent = `Running ${strategy.toUpperCase()} backtest for ${symbol} ${interval}...`;
  backtestResults.style.display = 'none';

  try {
    // Fetch historical data (up to 2000 bars for backtest)
    let history = await fetchServerHistory(symbol, interval, 2000);
    if (!history || history.length < Math.max(shortPeriod, longPeriod) + 10) {
      history = await loadKlinesREST(symbol, interval, 2000);
    }
    if (!history || history.length < Math.max(shortPeriod, longPeriod)) {
      btStatus.textContent = 'Insufficient historical data';
      return;
    }

    // Prepare closes for indicators
    const closes = history.map(c => c.close);
    const times = history.map(c => new Date(c.time * 1000).toLocaleString());

    let trades = [];
    let equityCurve = [initialCapital];
    let position = null; // {side: 'long'/'short', entryIndex: i, size: amount}
    let currentCapital = initialCapital;

    for (let i = Math.max(shortPeriod, longPeriod); i < history.length; i++) {
      const close = closes[i];
      let signal = null;

      if (strategy === 'sma') {
        const shortSMA = sma(closes.slice(i - shortPeriod + 1, i + 1));
        const longSMA = sma(closes.slice(i - longPeriod + 1, i + 1));
        if (shortSMA > longSMA && !position) {
          signal = 'buy';
        } else if (shortSMA < longSMA && position && position.side === 'long') {
          signal = 'sell';
        }
      } else if (strategy === 'rsi') {
        const rsiPeriod = shortPeriod; // Use short as RSI period
        const rsiValues = rsiArray(closes.slice(0, i + 1), rsiPeriod);
        const rsi = rsiValues[i];
        if (rsi < 30 && !position) {
          signal = 'buy';
        } else if (rsi > 70 && position && position.side === 'long') {
          signal = 'sell';
        }
      }

      // Execute signal
      if (signal === 'buy' && !position) {
        const size = currentCapital; // All-in for simplicity
        position = { side: 'long', entryIndex: i, entryPrice: close, size };
        trades.push({ time: times[i], type: 'entry', side: 'buy', price: close });
      } else if (signal === 'sell' && position) {
        const pnl = position.size * (close - position.entryPrice) / position.entryPrice;
        currentCapital += pnl;
        trades.push({
          time: times[i],
          type: 'exit',
          side: 'sell',
          price: close,
          pnl: pnl,
          return: (pnl / position.size) * 100
        });
        position = null;
      }

      // Update equity (unrealized if position open)
      let eq = currentCapital;
      if (position) {
        const unreal = position.size * (close - position.entryPrice) / position.entryPrice;
        eq += unreal;
      }
      equityCurve.push(eq);
    }

    // Close final position if open
    if (position) {
      const lastClose = closes[closes.length - 1];
      const pnl = position.size * (lastClose - position.entryPrice) / position.entryPrice;
      currentCapital += pnl;
      trades.push({
        time: times[times.length - 1],
        type: 'exit',
        side: 'sell',
        price: lastClose,
        pnl: pnl,
        return: (pnl / position.size) * 100
      });
    }

    // Compute metrics
    const finalEquity = equityCurve[equityCurve.length - 1];
    const totalReturn = ((finalEquity - initialCapital) / initialCapital) * 100;
    const numTrades = trades.filter(t => t.type === 'exit').length;
    const winningTrades = trades.filter(t => t.type === 'exit' && t.pnl > 0).length;
    const winRate = numTrades > 0 ? (winningTrades / numTrades) * 100 : 0;
    const totalPnL = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);

    // Update UI
    if (btMetrics) {
      btMetrics.innerHTML = `
        <strong>Total Return: ${totalReturn.toFixed(2)}%</strong><br>
        Total P&L: $${totalPnL.toFixed(2)}<br>
        Number of Trades: ${numTrades}<br>
        Win Rate: ${winRate.toFixed(1)}%<br>
        Final Equity: $${finalEquity.toFixed(2)}
      `;
    }

    if (btTrades) {
      btTrades.innerHTML = trades.map(t => {
        const color = t.pnl > 0 ? 'green' : 'red';
        return `<div style="color: ${color}; margin-bottom: 4px;">
          ${t.time} - ${t.type.toUpperCase()} ${t.side} @ ${t.price.toFixed(4)}
          ${t.pnl !== undefined ? ` (PnL: $${t.pnl.toFixed(2)})` : ''}
        </div>`;
      }).join('');
    }

    initBtEquityChart(times.slice(Math.max(shortPeriod, longPeriod)), equityCurve.slice(Math.max(shortPeriod, longPeriod)));

    backtestResults.style.display = 'block';
    btStatus.textContent = 'Backtest complete';

    // Update inline result
    if (btResultInline) {
      btResultInline.textContent = `${strategy.toUpperCase()}: ${totalReturn.toFixed(2)}% return (${numTrades} trades)`;
      btResultInline.classList.remove('hidden');
    }

  } catch (err) {
    console.error('Backtest error:', err);
    btStatus.textContent = 'Backtest failed';
  }
}

if (btRun) btRun.addEventListener('click', runBacktest);

/* --- WebSocket connection & handlers --- */
function startWS(){
  try {
    const port = 8080;
    const url = `ws://${location.hostname}:${port}`;
    ws = new WebSocket(url);
  } catch (e) {
    console.warn('ws init err', e);
    if (statusEl) statusEl.innerText = 'WS init failed';
    ws = null;
    return;
  }

  ws.addEventListener('open', () => {
    wsReady = true;
    console.log('ws open');
    if (statusEl) statusEl.innerText = 'WS connected';
    if (liveBadge) liveBadge.innerText = 'CONNECTED';
    try { ws.send(JSON.stringify({ type:'auth', sessionId: 'guest-'+Math.random().toString(36).slice(2,8), demoPremium: true })); } catch(e){}
    if (pendingSubscribe) { doSubscribe(pendingSubscribe.symbol, pendingSubscribe.interval); pendingSubscribe = null; }
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch(e){ return; }
    if (!msg || !msg.type) return;
    if (msg.type === 'welcome' || msg.type === 'auth_ok') return;

    if (msg.type === 'snapshot' && Array.isArray(msg.data)) {
      const arr = msg.data.map(k => ({ time: Number(k.time), open: Number(k.open), high: Number(k.high), low: Number(k.low), close: Number(k.close) })).sort((a,b)=>a.time - b.time);
      if (!candles || candles.length < 5) {
        candles = arr;
        try { series.setData(candles); } catch(e){ console.warn('series.setData snapshot', e); }
        safeApplyIndicators();
        buildEquityFromCandles();
        try{ chart.timeScale().fitContent(); }catch(e){}
        // --- NEW: evaluate paper positions on last bar of snapshot
        if (candles && candles.length) evaluatePaperPositionsOnCandle(candles[candles.length-1]);
        if (statusEl) statusEl.innerText = `Snapshot loaded ${msg.symbol} ${msg.interval} (${candles.length} bars)`;
      } else {
        console.log('snapshot received but local history exists; skipping overwrite');
      }
      return;
    }

    if (msg.type === 'candles_update' && msg.candle) {
      const c = msg.candle;
      const o = { time: Number(c.time), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) };
      if (!candles || candles.length === 0) {
        candles = [o];
        try { series.setData(candles); } catch(e){ console.warn('series.setData on empty', e); }
        safeApplyIndicators();
        updateEquityWithCandle(o, true);
        // evaluate on newly loaded candle
        evaluatePaperPositionsOnCandle(o);
        return;
      }
      const last = candles[candles.length - 1];
      if (last && last.time === o.time) {
        candles[candles.length - 1] = o;
        try { series.update(o); } catch(e){ console.warn('series.update failed', e); try{ series.setData(candles.slice(-1000)); }catch(_){} }
        safeApplyIndicators();
        updateEquityWithCandle(o, true);
        // evaluate on updated candle
        evaluatePaperPositionsOnCandle(o);
      } else if (o.time > last.time) {
        candles.push(o);
        if (candles.length > 2000) candles.shift();
        try { series.update(o); } catch(e){ console.warn('series.update push failed', e); try{ series.setData(candles.slice(-1000)); }catch(_){} }
        safeApplyIndicators();
        updateEquityWithCandle(o, false);
        // evaluate on new final candle
        evaluatePaperPositionsOnCandle(o);
      } else {
        let inserted = false;
        for (let i = candles.length - 1; i >= 0; i--) {
          if (candles[i].time < o.time) { candles.splice(i+1, 0, o); inserted = true; break; }
        }
        if (!inserted) candles.unshift(o);
        try { series.setData(candles.slice(-1000)); } catch(e){ console.warn('rebuild after insert failed', e); }
        safeApplyIndicators();
        updateEquityWithCandle(o, false);
        // evaluate on the candle that was inserted (best-effort)
        evaluatePaperPositionsOnCandle(o);
      }
      return;
    }

    if (msg.type === 'indicator_update' || msg.type === 'signal' || (msg.type === 'indicator' && msg.data)) {
      const payload = msg.data || msg;
      if (payload.signal) { addSignalToUI(payload.signal); addIndicatorMarker(payload.signal); }
      return;
    }
  });

  ws.addEventListener('close', ()=> {
    wsReady = false;
    console.log('ws closed; reconnecting in 2s');
    if (statusEl) statusEl.innerText = 'WS disconnected — reconnecting...';
    if (liveBadge) liveBadge.innerText = 'DISCONNECTED';
    setTimeout(startWS, 2000);
  });

  ws.addEventListener('error',(e)=> {
    wsReady = false;
    console.warn('ws err', e);
    if (statusEl) statusEl.innerText = 'WS error';
    if (liveBadge) liveBadge.innerText = 'ERROR';
    try { ws.close(); } catch(_) {}
  });
}
startWS();

/* --- Equity helpers (unchanged) --- */
function buildEquityFromCandles(){
  if (!candles || candles.length===0) { equityData = []; updateEquityChart(); return; }
  const startPrice = candles[0].close || 1;
  equityData = candles.map(c => ({ time: c.time, value: (c.close / startPrice) * 10000 }));
  updateEquityChart();
}
function updateEquityWithCandle(candle, replaceLast=false){
  if (!equityData) equityData = [];
  const startPrice = equityData.length ? (equityData[0].value / 10000 * (candles[0]?.close || 1)) : (candles[0]?.close || candle.close || 1);
  const newVal = (candle.close / (candles[0]?.close || startPrice)) * 10000;
  if (replaceLast && equityData.length) equityData[equityData.length-1] = { time: candle.time, value: newVal };
  else { equityData.push({ time: candle.time, value: newVal }); if (equityData.length > 2000) equityData.shift(); }
  updateEquityChart();
}
function updateEquityChart(){
  if (!equityChart) return;
  equityChart.data.labels = equityData.map(d => new Date(d.time*1000).toLocaleTimeString());
  equityChart.data.datasets[0].data = equityData.map(d => d.value);
  equityChart.update('none');
}

/* --- Signals UI & markers (safer) --- */
function addSignalToUI(signal){
  if(!signal) return;
  const side = signal.side || signal.type || (signal.action ? signal.action : null);
  if(!side) return;
  if (!signalListEl) return;
  const el = document.createElement('div');
  el.className = 'signalItem ' + (side==='buy' ? 'buy' : 'sell');
  const timeVal = signal.time || signal.ts || signal.t || null;
  const timeStr = timeVal ? new Date(Number(timeVal)*1000).toLocaleTimeString() : '';
  el.innerHTML = `<div style="flex:1"><strong>${String(side).toUpperCase()}</strong> <div class="smallMuted">${signal.reason || ''}</div></div>
                  <div style="text-align:right"><div>${(signal.price!=null)?Number(signal.price).toFixed(2):''}</div><div class="smallMuted">${timeStr}</div></div>`;
  if(signalListEl.children.length===0 || (signalListEl.children[0] && signalListEl.children[0].innerText==='No signals yet')) signalListEl.innerHTML = '';
  signalListEl.insertBefore(el, signalListEl.firstChild);
  while(signalListEl.children.length > 80) signalListEl.removeChild(signalListEl.lastChild);
}

// indicator-related marker add (keeps in indicatorMarkers)
function addIndicatorMarker(s){
  if(!s) return;
  const side = s.side || s.type || s.action || null;
  const time = s.time || s.ts || s.t || null;
  if(time == null) return;
  const mk = { time: mapToChartTime(time), position: side === 'buy' ? 'belowBar' : 'aboveBar', color: side === 'buy' ? '#00b894' : '#ff7675', shape: side === 'buy' ? 'arrowUp' : 'arrowDown', text: s.reason || side };
  indicatorMarkers.push(mk);
  if(indicatorMarkers.length>200) indicatorMarkers.shift();
  updateMarkers();
}

// paper-related marker add
function addPaperMarker(pos, closed=false) {
  try {
    const m = {
      posId: pos.id,
      time: mapToChartTime(pos.entry_time || (candles[candles.length-1] && candles[candles.length-1].time) || Math.floor(Date.now()/1000)),
      position: pos.side === 'buy' ? 'belowBar' : 'aboveBar',
      color: pos.side === 'buy' ? '#00b894' : '#ff7675',
      shape: closed ? 'circle' : (pos.side === 'buy' ? 'arrowUp' : 'arrowDown'),
      text: `${pos.side.toUpperCase()} ${pos.qty?.toFixed?.(6) || ''}\nSL:${pos.sl || '-'} TP:${pos.tp || '-'}`
    };
    paperMarkers.push(m);
    if (paperMarkers.length > 300) paperMarkers.shift();
    updateMarkers();
  } catch (e) { console.warn('addPaperMarker err', e); }
}

// merge & update markers on chart
function updateMarkers(){
  try {
    // concat indicator then paper markers (chart will render them)
    const merged = [];
    merged.push(...indicatorMarkers.slice(-200));
    merged.push(...paperMarkers.filter(m => openPositions.some(p => p.id === m.posId)).slice(-200));
    series.setMarkers(merged.slice(-300));
  } catch (e) {
    console.warn('updateMarkers failed', e);
  }
}

/* ---------- drawing & shapes: (expose createLineShape globally so other init code can call it) ---------- */

(function setupToolsAndDrawing() {
  if (!overlay) {
    console.warn('overlay element missing — drawing tools will be disabled.');
    return;
  }

  /* DOM references for tools UI (from index.html) */
  const leftbar = document.getElementById('leftbar');
  const linesMaster = document.getElementById('linesMaster');
  const palette = document.getElementById('linesPalette');
  const closePalette = document.getElementById('closePalette');
  const searchInput = document.getElementById('searchInput');
  const trendBtn = document.getElementById('trendBtn');
  const pitchBtn = document.getElementById('pitchBtn');
  const posLongBtn = document.getElementById('positionLong');
  const posShortBtn = document.getElementById('positionShort');
  const trashBtn = document.getElementById('trashBtn');
  const undoBtn = document.getElementById('undoBtn');
  const redoBtn = document.getElementById('redoBtn');
  const historyUndo = document.getElementById('historyUndo');
  const historyRedo = document.getElementById('historyRedo');
  const historyInfo = document.getElementById('historyInfo');
  const ctxMenu = document.getElementById('ctxMenu');
  const ctxDelete = document.getElementById('ctxDelete');
  const ctxDuplicate = document.getElementById('ctxDuplicate');
  const ctxCopy = document.getElementById('ctxCopy');
  const shapePanel = document.getElementById('shapePanel');
  const colorPicker = document.getElementById('colorPicker');
  const thickness = document.getElementById('thickness');
  const labelToggle = document.getElementById('labelToggle');
  const applyShape = document.getElementById('applyShape');
  const deleteShape = document.getElementById('deleteShape');
  const sizeSlider = document.getElementById('sizeSlider') || (function(){
    const el = document.createElement('input');
    el.id = 'sizeSlider';
    el.type = 'range';
    el.min = '10';
    el.max = '100';
    el.value = '50';
    if (shapePanel) {
      const label = document.createElement('label');
      label.textContent = 'Size ';
      label.appendChild(el);
      shapePanel.insertBefore(label, applyShape);
    }
    return el;
  })();

  /* device pixel scaling for overlay */
  let DPR = window.devicePixelRatio || 1;

  /* make shapePanel movable */
  let isDraggingPanel = false;
  let dragOffsetX = 0, dragOffsetY = 0;
  if (shapePanel) {
    shapePanel.addEventListener('mousedown', (e) => {
      isDraggingPanel = true;
      const rect = shapePanel.getBoundingClientRect();
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (isDraggingPanel) {
        shapePanel.style.left = (e.clientX - dragOffsetX) + 'px';
        shapePanel.style.top = (e.clientY - dragOffsetY) + 'px';
        shapePanel.style.position = 'fixed';
      }
    });
    document.addEventListener('mouseup', () => {
      isDraggingPanel = false;
    });
  }

  /* tool constants */
  const TOOL_NONE = null;
  const TOOL_TREND = 'trendline';
  const TOOL_RAY = 'ray';
  const TOOL_INFO_LINE = 'infoLine';
  const TOOL_EXTENDED = 'extended';
  const TOOL_HORIZONTAL = 'horizontal';
  const TOOL_VERTICAL = 'vertical';
  const TOOL_FIB_EXTENSION = 'fib-extension';
  const TOOL_FIB_TIMEZONE = 'fib-timezone';
  const TOOL_FIB_SPEED_RESISTANCE = 'fib-speed-resistance';
  const TOOL_GANN_FAN = 'gann-fan';
  const TOOL_GANN_BOX = 'gann-box';
  const TOOL_GANN_SQUARE = 'gann-square';
  const TOOL_ELLOTT_WAVE = 'elliott-wave';
  const TOOL_ELLIPSE = 'ellipse';
  const TOOL_TRIANGLE = 'triangle';
  const TOOL_BRUSH = 'brush';
  const TOOL_TEXT = 'text';
  const TOOL_ICON = 'icon';
  const TOOL_MEASURE = 'measure';
  const TOOL_PITCH = 'pitchfork';
  const TOOL_POSITION_LONG = 'positionLong';
  const TOOL_POSITION_SHORT = 'positionShort';

  /* interactive state */
  let activeTool = TOOL_NONE;
  let selectedShapeId = null;
  let drawing = null; // { tool, startPt, tempPt }
  let dragging = null; // { shapeId, pointIndex, offsetX, offsetY }
  let undoStack = [];
  let redoStack = [];

  /* overlay sizing & transform (pixel ratio aware) */
  function resizeOverlayToChart() {
    if (!overlay || !chartDiv) return;
    const rect = chartDiv.getBoundingClientRect();
    const cssW = Math.max(1, Math.floor(rect.width));
    const cssH = Math.max(1, Math.floor(rect.height));
    overlay.style.left = rect.left + 'px';
    overlay.style.top = rect.top + 'px';
    overlay.style.width = cssW + 'px';
    overlay.style.height = cssH + 'px';
    DPR = window.devicePixelRatio || 1;
    overlay.width = Math.max(1, Math.floor(cssW * DPR));
    overlay.height = Math.max(1, Math.floor(cssH * DPR));
    if (ctx) {
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.imageSmoothingEnabled = true;
    }
    renderAll();
  }
  window.addEventListener('resize', () => { resizeOverlayToChart(); });
  resizeOverlayToChart();

  /* ---------- coordinate conversions using chart API (preferred) ---------- */
  function timeToX(time) {
    try {
      if (!time || !chart || !chart.timeScale) return null;
      return chart.timeScale().timeToCoordinate(time);
    } catch (e) { return null; }
  }
  function xToTime(x) {
    try {
      if (!chart || !chart.timeScale) return null;
      return chart.timeScale().coordinateToTime(x);
    } catch (e) { return null; }
  }
  function priceToY(price) {
    try {
      if (!series || !series.priceToCoordinate) return null;
      return series.priceToCoordinate(price);
    } catch (e) { return null; }
  }
  function yToPrice(y) {
    try {
      if (!series || !series.coordinateToPrice) return null;
      return series.coordinateToPrice(y);
    } catch (e) { return null; }
  }

  /* helper: event -> local overlay coords (CSS px) */
  function eventToLocal(ev) {
    const rect = overlay.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top, clientX: ev.clientX, clientY: ev.clientY };
  }

  /* unique id */
  function uid(prefix='s') { return prefix + '_' + Math.random().toString(36).slice(2,9); }

  /* ---------- history (undo/redo) ---------- */
  function pushHistory() {
    try {
      undoStack.push(JSON.parse(JSON.stringify(shapes)));
      if (undoStack.length > 80) undoStack.shift();
      redoStack = [];
      updateHistoryInfo();
    } catch (e) { console.warn('pushHistory err', e); }
  }
  function undo() {
    if (undoStack.length === 0) return;
    redoStack.push(JSON.parse(JSON.stringify(shapes)));
    shapes = undoStack.pop();
    selectedShapeId = null;
    renderAll();
    updateHistoryInfo();
  }
  function redo() {
    if (redoStack.length === 0) return;
    undoStack.push(JSON.parse(JSON.stringify(shapes)));
    shapes = redoStack.pop();
    selectedShapeId = null;
    renderAll();
    updateHistoryInfo();
  }
  function updateHistoryInfo() {
    if (historyInfo) historyInfo.innerText = `${undoStack.length} / ${redoStack.length}`;
  }

  /* expose global undo/redo used elsewhere */
  window.undo = undo;
  window.redo = redo;

  /* ---------- shape helpers ---------- */
  function createLineShape(type, p1, p2, opts = {}) {
    const s = {
      id: uid('shape'),
      type,
      points: [
        { time: p1.time ?? null, price: p1.price ?? null, xPx: p1.xPx ?? null, yPx: p1.yPx ?? null },
        { time: p2.time ?? null, price: p2.price ?? null, xPx: p2.xPx ?? null, yPx: p2.yPx ?? null }
      ],
      color: opts.color || (document.getElementById('colorPicker') ? document.getElementById('colorPicker').value : '#ffd166'),
      width: opts.width || (document.getElementById('thickness') ? Number(document.getElementById('thickness').value) : 2),
      meta: { ...opts.meta, size: opts.size || 50 }
    };
    shapes.push(s);
    pushHistory();
    renderAll();
    return s;
  }
  function removeShapeById(id) {
    const idx = shapes.findIndex(s => s.id === id);
    if (idx >= 0) {
      shapes.splice(idx, 1);
      pushHistory();
      selectedShapeId = null;
      renderAll();
    }
  }
  function duplicateShape(id) {
    const s = shapes.find(x=>x.id===id);
    if (!s) return;
    const copy = JSON.parse(JSON.stringify(s));
    copy.id = uid('shape_dup');
    copy.points.forEach(pt => {
      if (typeof pt.time === 'number') pt.time += 60;
      if (typeof pt.xPx === 'number') pt.xPx += 12;
      if (typeof pt.yPx === 'number') pt.yPx += 12;
    });
    shapes.push(copy);
    pushHistory();
    renderAll();
  }

  /* expose create/remove globally so other init code (restore) can use it */
  window.createLineShape = createLineShape;
  window.removeShapeById = removeShapeById;
  window.duplicateShape = duplicateShape;
  window._shapes = shapes; // debugging handle

  /* ---------- pixel <-> market conversions for saved points ---------- */
  function shapePointToPixel(pt) {
    if (!pt) return null;
    let x = null, y = null;
    if (pt.time != null) {
      const xx = timeToX(pt.time);
      if (typeof xx === 'number') x = xx;
    }
    if (pt.price != null) {
      const yy = priceToY(pt.price);
      if (typeof yy === 'number') y = yy;
    }
    if ((x === null || isNaN(x)) && typeof pt.xPx === 'number') x = pt.xPx;
    if ((y === null || isNaN(y)) && typeof pt.yPx === 'number') y = pt.yPx;
    if (x === null || y === null || isNaN(x) || isNaN(y)) return null;
    return { x, y };
  }
  function pixelToShapePoint(px, py) {
    const t = xToTime(px);
    const p = yToPrice(py);
    const out = { time: (typeof t !== 'undefined' ? t : null), price: (typeof p !== 'undefined' ? p : null), xPx: px, yPx: py };
    return out;
  }

  /* ---------- rendering ---------- */
  function clearOverlay() {
    if (!ctx) return;
    ctx.clearRect(0, 0, overlay.width / DPR, overlay.height / DPR);
  }

  function brightenColor(hex, amt=0.15) {
    try {
      if (hex[0] === '#') {
        const r = parseInt(hex.slice(1,3),16);
        const g = parseInt(hex.slice(3,5),16);
        const b = parseInt(hex.slice(5,7),16);
        const nr = Math.min(255, Math.round(r + (255 - r)*amt));
        const ng = Math.min(255, Math.round(g + (255 - g)*amt));
        const nb = Math.min(255, Math.round(b + (255 - b)*amt));
        return `rgb(${nr},${ng},${nb})`;
      }
    } catch(e){}
    return hex;
  }

  function extendRay(a,b) {
    const W = overlay.width / DPR, H = overlay.height / DPR;
    const dx = b.x - a.x, dy = b.y - a.y;
    const candidates = [];
    if (dx !== 0) {
      candidates.push({ t: (0 - a.x)/dx, x: 0, y: a.y + (0 - a.x)/dx * dy });
      candidates.push({ t: (W - a.x)/dx, x: W, y: a.y + (W - a.x)/dx * dy });
    }
    if (dy !== 0) {
      candidates.push({ t: (0 - a.y)/dy, y: 0, x: a.x + (0 - a.y)/dy * dx });
      candidates.push({ t: (H - a.y)/dy, y: H, x: a.x + (H - a.y)/dy * dx });
    }
    let best = null, bestT = -Infinity;
    for (const c of candidates) {
      if (c.t > bestT && c.t > 0 && c.x >= -10 && c.x <= W+10 && c.y >= -10 && c.y <= H+10) {
        bestT = c.t; best = { x: c.x, y: c.y };
      }
    }
    return best || b;
  }
  function extendLineBoth(a,b) {
    const W = overlay.width / DPR, H = overlay.height / DPR;
    const dx = b.x - a.x, dy = b.y - a.y;
    if (dx === 0 && dy === 0) return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    const tCandidates = [];
    if (dx !== 0) {
      tCandidates.push((0 - a.x)/dx);
      tCandidates.push((W - a.x)/dx);
    }
    if (dy !== 0) {
      tCandidates.push((0 - a.y)/dy);
      tCandidates.push((H - a.y)/dy);
    }
    const tMin = Math.min(...tCandidates);
    const tMax = Math.max(...tCandidates);
    return { x1: a.x + dx*tMin, y1: a.y + dy*tMin, x2: a.x + dx*tMax, y2: a.y + dy*tMax };
  }

  function drawShape(s, highlighted=false) {
    if (!ctx) return;
    const pA = shapePointToPixel(s.points[0]);
    const pB = shapePointToPixel(s.points[1]);
    if (!pA || !pB) return;
    ctx.save();
    ctx.lineWidth = (s.width || 2) + (highlighted ? 1 : 0);
    ctx.strokeStyle = highlighted ? brightenColor(s.color, 0.25) : s.color;
    ctx.beginPath();
    if (s.type === 'ray') {
      const ex = extendRay(pA,pB);
      ctx.moveTo(pA.x, pA.y);
      ctx.lineTo(ex.x, ex.y);
      ctx.stroke();
    } else if (s.type === 'extended' || s.type === 'trendline') {
      const e = extendLineBoth(pA,pB);
      ctx.moveTo(e.x1, e.y1);
      ctx.lineTo(e.x2, e.y2);
      ctx.stroke();
    } else if (s.type === 'horizontal') {
      ctx.moveTo(0, pA.y);
      ctx.lineTo(overlay.width / DPR, pA.y);
      ctx.stroke();
  } else if (s.type === 'vertical') {
    ctx.moveTo(pA.x, 0);
    ctx.lineTo(pA.x, overlay.height / DPR);
    ctx.stroke();
  } else if (s.type === 'ellipse') {
    const centerX = (pA.x + pB.x) / 2;
    const centerY = (pA.y + pB.y) / 2;
    const rx = Math.abs(pB.x - pA.x) / 2 * (s.meta.size / 50);
    const ry = Math.abs(pB.y - pA.y) / 2 * (s.meta.size / 50);
    ctx.beginPath();
    ctx.ellipse(centerX, centerY, rx, ry, 0, 0, 2 * Math.PI);
    ctx.stroke();
  } else if (s.type === 'triangle') {
    const scale = s.meta.size / 50;
    const topX = (pA.x + pB.x) / 2;
    const topY = Math.min(pA.y, pB.y) - Math.abs(pB.y - pA.y) * scale / 2;
    const baseLeftX = pA.x;
    const baseLeftY = Math.max(pA.y, pB.y);
    const baseRightX = pB.x;
    const baseRightY = Math.max(pA.y, pB.y);
    ctx.beginPath();
    ctx.moveTo(topX, topY);
    ctx.lineTo(baseLeftX, baseLeftY);
    ctx.lineTo(baseRightX, baseRightY);
    ctx.closePath();
    ctx.stroke();
  } else {
    ctx.moveTo(pA.x, pA.y);
    ctx.lineTo(pB.x, pB.y);
    ctx.stroke();
  }

    // endpoints
    ctx.fillStyle = '#0b1220';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(pA.x, pA.y, 4, 0, Math.PI*2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(pB.x, pB.y, 4, 0, Math.PI*2);
    ctx.fill();
    ctx.stroke();

    // if this is a SL/TP attached to a position, draw confirmation label
    if (s.meta && s.meta.posId) {
      ctx.fillStyle = '#222b33';
      const priceTxt = (s.points[0].price != null) ? Number(s.points[0].price).toFixed(2) : '-';
      const kind = s.meta.type === 'sl' ? 'SL' : (s.meta.type === 'tp' ? 'TP' : (s.meta.type||''));
      const txt = `${kind}: ${priceTxt}`;
      ctx.font = '12px Inter, monospace';
      const tx = Math.max(8, Math.min(overlay.width / DPR - 120, pA.x + 8));
      const ty = Math.max(12, pA.y - 10);
      const w = ctx.measureText(txt).width + 12;
      ctx.fillRect(tx - 6, ty - 12, w, 18);
      ctx.fillStyle = '#e6f1ff';
      ctx.fillText(txt, tx, ty);
    }

    ctx.restore();
  }

  function renderAll() {
    clearOverlay();
    for (const s of shapes) {
      drawShape(s, s.id === selectedShapeId);
    }
    if (drawing && drawing.startPt && drawing.tempPt) {
      ctx.save();
      ctx.setLineDash([6,6]);
      ctx.strokeStyle = '#9fb4d6';
      ctx.lineWidth = 1.2;
      const a = shapePointToPixel(drawing.startPt);
      const b = shapePointToPixel(drawing.tempPt);
      if (a && b) {
        if (drawing.tool === TOOL_RAY) {
          const ex = extendRay(a,b);
          ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(ex.x,ex.y); ctx.stroke();
        } else {
          ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
        }
      }
      ctx.restore();
    }
  }

  /* ---------- hit testing / selection ---------- */
  function distanceToSegment(px,py, x1,y1,x2,y2) {
    const A = px - x1;
    const B = py - y1;
    const C = x2 - x1;
    const D = y2 - y1;
    const dot = A * C + B * D;
    const len_sq = C * C + D * D;
    let param = -1;
    if (len_sq !== 0) param = dot / len_sq;
    let xx, yy;
    if (param < 0) { xx = x1; yy = y1; }
    else if (param > 1) { xx = x2; yy = y2; }
    else { xx = x1 + param * C; yy = y1 + param * D; }
    const dx = px - xx;
    const dy = py - yy;
    return Math.sqrt(dx*dx + dy*dy);
  }

  function findShapeAt(x,y) {
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i];
      const pA = shapePointToPixel(s.points[0]);
      const pB = shapePointToPixel(s.points[1]);
      if (!pA || !pB) continue;
      if (s.type === 'horizontal') {
        if (Math.abs(y - pA.y) < 8) return s;
      } else if (s.type === 'vertical') {
        if (Math.abs(x - pA.x) < 8) return s;
      } else {
        const d = distanceToSegment(x, y, pA.x, pA.y, pB.x, pB.y);
        if (d < 8) return s;
      }
    }
    return null;
  }

  /* ---------- pointer handlers (drawing, dragging, selecting) ---------- */
  let pointerDown = false;

  overlay.addEventListener('mousedown', (ev) => {
    const pos = eventToLocal(ev);
    pointerDown = true;
    if (ev.button === 2) return;
    if (activeTool) {
      const p = pixelToShapePoint(pos.x, pos.y);
      if (activeTool === TOOL_HORIZONTAL) {
        const p2 = { time: null, price: p.price, xPx: pos.x, yPx: pos.y };
        createLineShape('horizontal', p, p2);
        return;
      }
      if (activeTool === TOOL_VERTICAL) {
        const p2 = { time: p.time, price: null, xPx: pos.x, yPx: pos.y };
        createLineShape('vertical', p, p2);
        return;
      }
      if (activeTool === TOOL_POSITION_LONG || activeTool === TOOL_POSITION_SHORT) {
        const color = activeTool === TOOL_POSITION_LONG ? '#00b894' : '#ff7675';
        const s = { id: uid('pos'), type: activeTool, points:[{ time: p.time, price: p.price, xPx: pos.x, yPx: pos.y }, { time: (p.time||0)+1, price: (p.price||0), xPx: pos.x+8, yPx: pos.y }] , color, width:2, meta:{ position: activeTool }};
        shapes.push(s);
        pushHistory();
        renderAll();
        return;
      }
      drawing = { tool: activeTool, startPt: p, tempPt: p };
      renderAll();
      return;
    }

    const hit = findShapeAt(pos.x, pos.y);
    if (hit) {
      selectedShapeId = hit.id;
      const a = shapePointToPixel(hit.points[0]);
      const b = shapePointToPixel(hit.points[1]);
      const dA = Math.hypot(pos.x - a.x, pos.y - a.y);
      const dB = Math.hypot(pos.x - b.x, pos.y - b.y);
      const which = dA < dB ? 0 : 1;
      const offsetX = pos.x - (which === 0 ? a.x : b.x);
      const offsetY = pos.y - (which === 0 ? a.y : b.y);
      dragging = { shapeId: hit.id, pointIndex: which, offsetX, offsetY };
      renderAll();
      if (shapePanel) {
        const s = shapes.find(x=>x.id === selectedShapeId);
        if (s) {
          shapePanel.style.display = 'block';
          if (colorPicker) colorPicker.value = s.color || '#ffd166';
          if (thickness) thickness.value = s.width || 2;
          if (labelToggle) labelToggle.checked = s.meta.showLabel || false;
          if (sizeSlider) sizeSlider.value = s.meta.size || 50;
        }
      }
      return;
    }

    selectedShapeId = null;
    renderAll();
    if (shapePanel) shapePanel.style.display = 'none';
  });

  overlay.addEventListener('mousemove', (ev) => {
    const pos = eventToLocal(ev);
    if (drawing) {
      drawing.tempPt = pixelToShapePoint(pos.x, pos.y);
      renderAll();
      return;
    }
    if (dragging) {
      const s = shapes.find(x=>x.id===dragging.shapeId);
      if (!s) return;
      const newPxX = pos.x - dragging.offsetX;
      const newPxY = pos.y - dragging.offsetY;
      const newPt = pixelToShapePoint(newPxX, newPxY);
      s.points[dragging.pointIndex].xPx = newPt.xPx;
      s.points[dragging.pointIndex].yPx = newPt.yPx;
      s.points[dragging.pointIndex].time = newPt.time;
      s.points[dragging.pointIndex].price = newPt.price;
      renderAll();
      return;
    }
    const hit = findShapeAt(pos.x,pos.y);
    overlay.style.cursor = hit ? 'move' : (activeTool ? 'crosshair' : 'default');
  });

  overlay.addEventListener('mouseup', (ev) => {
    const pos = eventToLocal(ev);
    pointerDown = false;
    if (drawing) {
      const s = drawing;
      const p1 = s.startPt;
      const p2 = s.tempPt || pixelToShapePoint(pos.x, pos.y);
      if (!p1 || !p2) { drawing = null; renderAll(); return; }
      if (s.tool === TOOL_TREND) createLineShape('trendline', p1, p2);
      else if (s.tool === TOOL_RAY) createLineShape('ray', p1, p2);
      else if (s.tool === TOOL_PITCH) createLineShape('pitchfork', p1, p2);
      else createLineShape(s.tool, p1, p2);
      drawing = null;
      return;
    }
    if (dragging) {
      pushHistory();
      // --- after finishing dragging a horizontal SL/TP shape, update the associated paper position
      try {
        const s = shapes.find(x => x.id === dragging.shapeId);
        if (s && s.type === 'horizontal' && s.meta && s.meta.posId && (s.meta.type === 'sl' || s.meta.type === 'tp')) {
          const posId = s.meta.posId;
          const posObj = openPositions.find(p => p.id === posId);
          if (posObj) {
            // prefer market price from the point's price (should be set during dragging)
            const newPrice = (typeof s.points[0].price === 'number') ? s.points[0].price : (typeof s.points[1].price === 'number' ? s.points[1].price : null);
            if (newPrice != null) {
              if (s.meta.type === 'sl') posObj.sl = Number(newPrice);
              else posObj.tp = Number(newPrice);
              // persist change to server
              persistTrade({ ts: Math.floor(Date.now()/1000), symbol: posObj.symbol, side: posObj.side, entry_price: posObj.entry_price, exit_price: null, qty: posObj.qty, pnl: null, note: `paper_set_${s.meta.type}`, pos_id: posObj.id }).catch(()=>{});
              updatePaperUI();
              // regenerate paperMarkers for that position
              rebuildPaperMarkers();
            }
          }
        }
      } catch (e) { console.warn('post-drag shape update err', e); }
      dragging = null;
    }
  });

  overlay.addEventListener('mouseleave', (ev) => {
    if (drawing) { drawing = null; renderAll(); }
    if (dragging) { pushHistory(); dragging = null; }
  });

  /* context menu for shapes (right click) */
  overlay.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    const pos = eventToLocal(ev);
    const hit = findShapeAt(pos.x,pos.y);
    if (!hit) {
      ctxMenu && (ctxMenu.style.display = 'none');
      return;
    }
    selectedShapeId = hit.id;
    renderAll();
    if (ctxMenu) {
      ctxMenu.style.left = ev.clientX + 'px';
      ctxMenu.style.top = ev.clientY + 'px';
      ctxMenu.style.display = 'block';
    }
  });
  window.addEventListener('click', (ev) => { if (ctxMenu) ctxMenu.style.display = 'none'; });

  if (ctxDelete) ctxDelete.addEventListener('click', ()=> { if (selectedShapeId) removeShapeById(selectedShapeId); if (ctxMenu) ctxMenu.style.display='none'; });
  if (ctxDuplicate) ctxDuplicate.addEventListener('click', ()=> { if (selectedShapeId) duplicateShape(selectedShapeId); if (ctxMenu) ctxMenu.style.display='none'; });
  if (ctxCopy) ctxCopy.addEventListener('click', ()=> { if (selectedShapeId) { const s = shapes.find(x=>x.id===selectedShapeId); navigator.clipboard?.writeText(JSON.stringify(s)).catch(()=>{}); } if (ctxMenu) ctxMenu.style.display='none'; });

  if (applyShape) applyShape.addEventListener('click', () => {
    const s = shapes.find(x=>x.id === selectedShapeId);
    if (s) {
      s.color = colorPicker.value;
      s.width = Number(thickness.value);
      s.meta.showLabel = labelToggle.checked;
      s.meta.size = Number(sizeSlider.value);
      renderAll();
    }
  });

  if (deleteShape) deleteShape.addEventListener('click', () => {
    if (selectedShapeId) removeShapeById(selectedShapeId);
  });

  /* ---------- UI wiring for toolbar & palette ---------- */
  function setActiveTool(tool) {
    activeTool = tool;
    if (leftbar) [...leftbar.querySelectorAll('.tool')].forEach(el => {
      const dt = el.getAttribute('data-tool');
      el.classList.toggle('active', dt && dt === tool);
    });
    if (tool === TOOL_TREND || tool === TOOL_RAY) {
      if (palette) palette.setAttribute('aria-hidden','false');
    }
  }
  if (trendBtn) trendBtn.addEventListener('click', ()=> setActiveTool(TOOL_TREND));
  if (pitchBtn) pitchBtn.addEventListener('click', ()=> setActiveTool(TOOL_PITCH));
  if (posLongBtn) posLongBtn.addEventListener('click', ()=> setActiveTool(TOOL_POSITION_LONG));
  if (posShortBtn) posShortBtn.addEventListener('click', ()=> setActiveTool(TOOL_POSITION_SHORT));
  if (trashBtn) trashBtn.addEventListener('click', ()=> { shapes = []; pushHistory(); renderAll(); });

  if (linesMaster) linesMaster.addEventListener('click', ()=> {
    if (!palette) return;
    const hidden = palette.getAttribute('aria-hidden') === 'true';
    palette.setAttribute('aria-hidden', hidden ? 'false' : 'true');
  });
  if (closePalette) closePalette.addEventListener('click', ()=> { if (palette) palette.setAttribute('aria-hidden','true'); });

  const paletteItems = document.querySelectorAll('#content .item');
  paletteItems.forEach(it => {
    it.addEventListener('click', ()=> {
      const t = it.dataset.tool;
      if (t === 'trendline') setActiveTool(TOOL_TREND);
      else if (t === 'ray') setActiveTool(TOOL_RAY);
      else if (t === 'horizontal') setActiveTool(TOOL_HORIZONTAL);
      else if (t === 'vertical') setActiveTool(TOOL_VERTICAL);
      else setActiveTool(t);
      if (palette) palette.setAttribute('aria-hidden','true');
    });
  });

  document.querySelectorAll('.tool[data-tool]').forEach(btn => {
    if (!btn.id) { // for new tools without id
      btn.addEventListener('click', () => {
        const t = btn.dataset.tool;
        setActiveTool(t);
      });
    }
  });

  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      const v = e.target.value.toLowerCase();
      [...document.querySelectorAll('#content .item')].forEach(it => {
        it.style.display = (!v || it.dataset.tool.includes(v)) ? 'block' : 'none';
      });
    });
  }

  if (undoBtn) undoBtn.addEventListener('click', undo);
  if (redoBtn) redoBtn.addEventListener('click', redo);
  if (historyUndo) historyUndo.addEventListener('click', undo);
  if (historyRedo) historyRedo.addEventListener('click', redo);

  /* keyboard shortcuts */
  window.addEventListener('keydown', (ev) => {
    if ((ev.key === 'z' || ev.key === 'Z') && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); undo(); }
    if ((ev.key === 'y' || ev.key === 'Y') && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); redo(); }
    if (ev.key === 't' || ev.key === 'T') { setActiveTool(TOOL_TREND); }
    if (ev.key === 'r' || ev.key === 'R') { setActiveTool(TOOL_RAY); }
    if (ev.shiftKey && (ev.key === 'L')) setActiveTool(TOOL_POSITION_LONG);
    if (ev.shiftKey && (ev.key === 'S')) setActiveTool(TOOL_POSITION_SHORT);
    if (ev.key === 'Escape') { drawing = null; activeTool = TOOL_NONE; if (palette) palette.setAttribute('aria-hidden','true'); renderAll(); }
  });

  /* ---------- rerender on chart transformations (pan/zoom/crosshair) ---------- */
  let renderHandle = null;
  function scheduleRerender() {
    if (renderHandle) cancelAnimationFrame(renderHandle);
    renderHandle = requestAnimationFrame(()=> renderAll());
  }
  if (chart && chart.timeScale && chart.timeScale().subscribeVisibleTimeRangeChange) {
    chart.timeScale().subscribeVisibleTimeRangeChange(() => scheduleRerender());
  }
  if (chart && chart.subscribeCrosshairMove) {
    chart.subscribeCrosshairMove(() => scheduleRerender());
  }
  window.addEventListener('resize', () => { resizeOverlayToChart(); scheduleRerender(); });

  /* initial snapshot for history */
  pushHistory();
  renderAll();

  console.log('Tooling initialized (integrated with chart).');

})(); // end setupToolsAndDrawing

/* small helper to initiate first load */
setTimeout(()=> {
  populateTimeframeSelects();

  const s = normalizeSymbol((symbolSelect && symbolSelect.value) || 'BTCUSDT');

  let initialTF = '1m';
  if (tfSelect && tfSelect.value && isValidInterval(tfSelect.value)) initialTF = tfSelect.value;
  else if (tfSelect && tfSelect.options && tfSelect.options.length) initialTF = tfSelect.options[0].value || initialTF;

  const t = normalizeInterval(initialTF);

  if (symbolSelect) symbolSelect.value = s;
  if (tfSelect) tfSelect.value = t;
  // restore paper positions from server first (preferred), then load history and WS
  (async () => {
    await tryRestorePaperFromServer(); // prefer server SOT
    loadAndConnect(s, t);
  })().catch(err => {
    console.warn('init restore err', err);
    loadAndConnect(s, t);
  });
  try { /* resizeOverlay(); updateOverlayPointer(); */ } catch(e){}
}, 300);

/* debug */
window._shapes = window._shapes || [];
window.snapshotAndPush = window.snapshotAndPush || (()=>{});
window.undo = window.undo || (()=>{});
window.redo = window.redo || (()=>{});

/* Extra helper: subscribeCrosshairMove for raw free coords (optional) */
if (chart && chart.subscribeCrosshairMove) {
  chart.subscribeCrosshairMove(param => {
    // optional
  });
}

/* ---------- PAPER TRADING (frontend simulation) ---------- */
/* state */
let paperAccount = {
  balance: 100000.0,   // demo $100k initial
  realized: 0,
  unrealized: 0,
  equity: 100000.0
};
let openPositions = []; // array of { id, side, entry_price, qty, sl, tp, entry_time, symbol, interval }
let closedTrades = [];  // for UI or later persistence

/* UI refs (from index.html snippet) */
const paperBalanceEl = document.getElementById('paperBalance');
const paperEquityEl = document.getElementById('paperEquity');
const paperUnrealEl = document.getElementById('paperUnreal');
const lastPriceEl = document.getElementById('lastPrice');
const positionsCountEl = document.getElementById('positionsCount');
const buyBtn = document.getElementById('buyBtn');
const sellBtn = document.getElementById('sellBtn');
const placeOrderBtn = document.getElementById('placeOrder');
const orderMode = document.getElementById('orderMode');
const orderAmount = document.getElementById('orderAmount');
const orderQty = document.getElementById('orderQty');
const orderSL = document.getElementById('orderSL');
const orderTP = document.getElementById('orderTP');
const amountLabel = document.getElementById('amountLabel');
const qtyLabel = document.getElementById('qtyLabel');

function formatMoney(v) {
  return (typeof v === 'number') ? ('$' + v.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})) : '—';
}

function updatePaperUI() {
  if (paperBalanceEl) paperBalanceEl.innerText = formatMoney(paperAccount.balance);
  if (paperEquityEl) paperEquityEl.innerText = formatMoney(paperAccount.equity);
  if (paperUnrealEl) {
    const txt = paperAccount.unrealized >= 0 ? `+${paperAccount.unrealized.toFixed(2)}` : paperAccount.unrealized.toFixed(2);
    paperUnrealEl.innerText = txt;
    paperUnrealEl.style.color = paperAccount.unrealized >= 0 ? '#9beeac' : '#ff9b9b';
  }
  if (positionsCountEl) positionsCountEl.innerText = `Open: ${openPositions.length}`;

  const tradesListEl = document.getElementById('openTradesList');
  if (tradesListEl) {
    if (openPositions.length === 0) {
      tradesListEl.innerHTML = '<div style="text-align:center;color:var(--muted-2);padding:10px;font-size:12px">No open trades</div>';
    } else {
      tradesListEl.innerHTML = openPositions.map(pos => {
        const current = getCurrentPrice();
        const unreal = (pos.side === 'buy') ? (current - pos.entry_price) * pos.qty : (pos.entry_price - current) * pos.qty;
        const pnlColor = unreal >= 0 ? '#9beeac' : '#ff9b9b';
        const sideClass = pos.side;
        return `
          <div class="trade-item ${sideClass}">
            <div class="details">
              <div><strong>${pos.side.toUpperCase()}</strong> @ ${pos.entry_price.toFixed(4)} (${pos.qty.toFixed(6)})</div>
              <div style="color:var(--muted-2);font-size:11px">Unreal: <span style="color:${pnlColor}">${unreal >= 0 ? '+' : ''}$${unreal.toFixed(2)}</span></div>
            </div>
            <div class="pnl" style="color:${pnlColor}">${unreal >= 0 ? '+' : ''}$${unreal.toFixed(2)}</div>
            <button class="close-btn" onclick="closePosition('${pos.id}')">Close</button>
          </div>
        `;
      }).join('');
    }
  }
}

function updateChartTradeOverlay() {
  if (!chartTradeOverlay) return;

  // Update balance info
  if (overlayBalance) overlayBalance.innerText = formatMoney(paperAccount.balance);
  if (overlayEquity) overlayEquity.innerText = formatMoney(paperAccount.equity);
  if (overlayUnreal) {
    const txt = paperAccount.unrealized >= 0 ? `+${paperAccount.unrealized.toFixed(2)}` : paperAccount.unrealized.toFixed(2);
    overlayUnreal.innerText = txt;
    overlayUnreal.style.color = paperAccount.unrealized >= 0 ? '#9beeac' : '#ff9b9b';
  }

  // Update quantity display (use last order amount or default)
  if (overlayQty) {
    const currentPrice = getCurrentPrice() || 50000;
    const lastAmount = orderAmount ? (Number(orderAmount.value) || 1000) : 1000;
    const qty = lastAmount / currentPrice;
    overlayQty.innerText = qty.toFixed(6);
  }
}

/* toggle orderMode UI */
if (orderMode) orderMode.addEventListener('change', (e) => {
  if (e.target.value === 'qty') {
    if (amountLabel) amountLabel.style.display = 'none';
    if (qtyLabel) qtyLabel.style.display = 'flex';
  } else {
    if (amountLabel) amountLabel.style.display = 'flex';
    if (qtyLabel) qtyLabel.style.display = 'none';
  }
});

/* helper to get current mid/last price from candles (use last candle close) */
function getCurrentPrice() {
  if (!candles || candles.length === 0) return null;
  return candles[candles.length - 1].close;
}

/* persist trade to server (entry or exit). Body uses server /paper/trade */
async function persistTrade(tr) {
  try {
    const res = await fetch('/paper/trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tr)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.success) throw new Error('Persist failed');
    return data.id;
  } catch (e) {
    console.warn('persistTrade err', e);
    return null;
  }
}

/* restore paper state from server as authoritative source-of-truth */
async function tryRestorePaperFromServer() {
  try {
    const resp = await fetch('/paper/positions?closedLimit=200');
    if (!resp.ok) return false;
    const data = await resp.json();
    if (!data || !data.ok) return false;

    // For fresh start on refresh: Do not restore open positions or closed trades
    // server returns open (array) and closed (array) rows
    if (Array.isArray(data.open) && data.open.length > 0) {
      // Skip restoring open positions to ensure fresh start on page refresh
      console.log('Skipping open positions restore for fresh session');
    }

    // Skip restoring closed trades for fresh start on page refresh
    closedTrades = [];
    updateHistoryUI();
    return true;
  } catch (e) {
    console.warn('tryRestorePaperFromServer err', e);
    return false;
  }
}

/* helper: keep paperMarkers in sync based on openPositions */
function rebuildPaperMarkers() {
  paperMarkers = [];
  for (const p of openPositions) {
    addPaperMarker(p, false);
  }
  updateMarkers();
}

function showTradeAlert(type, pnl) {
  let alertEl = document.getElementById('tradeAlert');
  if (!alertEl) {
    alertEl = document.createElement('div');
    alertEl.id = 'tradeAlert';
    document.body.appendChild(alertEl);
  }
  const sign = pnl >= 0 ? '+' : '';
  alertEl.innerHTML = `${type.toUpperCase()} Hit!<br><strong>${sign}$${Math.abs(pnl).toFixed(2)}</strong>`;
  alertEl.className = type; // tp, sl, manual
  alertEl.classList.add('show');
  setTimeout(() => alertEl.classList.remove('show'), 3000);
}

async function closePosition(posId) {
  const posIdx = openPositions.findIndex(p => p.id === posId);
  if (posIdx === -1) return;
  const pos = openPositions[posIdx];
  const currentPrice = getCurrentPrice();
  if (!currentPrice) { alert('No current price'); return; }
  const pnl = (pos.side === 'buy') ? (currentPrice - pos.entry_price) * pos.qty : (pos.entry_price - currentPrice) * pos.qty;
  paperAccount.realized += pnl;
  // return margin + pnl
  paperAccount.balance += pos.initial_notional + pnl;
  const closedObj = Object.assign({}, pos, { exit_price: currentPrice, pnl, exit_time: Math.floor(Date.now()/1000), reason: 'manual' });
  const tradeId = await persistTrade({ ts: closedObj.exit_time, symbol: closedObj.symbol, side: closedObj.side, entry_price: pos.entry_price, exit_price: currentPrice, qty: pos.qty, pnl, note: 'paper_exit_manual', pos_id: pos.id });
  if (tradeId) closedObj.id = tradeId;
  closedTrades.push(closedObj);
  openPositions.splice(posIdx, 1);
  // Remove SL/TP shapes and entry marker
  for (let sIdx = shapes.length - 1; sIdx >= 0; sIdx--) {
    const s = shapes[sIdx];
    if (s.meta && s.meta.posId === pos.id) {
      shapes.splice(sIdx, 1);
    }
  }
  paperMarkers = paperMarkers.filter(m => m.posId !== pos.id);
  updateMarkers();
  showTradeAlert('manual', pnl);
  updatePaperUI();
  updateHistoryUI();
}

/* Place order handler — now creates horizontal SL/TP shapes for drag control */
if (placeOrderBtn) placeOrderBtn.addEventListener('click', async () => {
  const side = buyBtn && buyBtn.classList.contains('active') ? 'buy' : (sellBtn && sellBtn.classList.contains('active') ? 'sell' : null);
  const selectedSide = window.__paper_last_side || side || 'buy';

  const priceNow = getCurrentPrice();
  if (!priceNow) { alert('No market price available'); return; }

  let qty = 0;
  let isAmountMode = !(orderMode && orderMode.value === 'qty');
  let effectiveSide = selectedSide;
  let amount = 0;
  if (isAmountMode) {
    amount = Number(orderAmount.value) || 0;
    if (amount <= 0) { alert('Enter an amount to invest'); return; }
    qty = amount / priceNow;
  } else {
    qty = Number(orderQty.value) || 0;
    if (qty <= 0) { alert('Enter quantity'); return; }
    amount = qty * priceNow;
  }

  let slInput = orderSL ? orderSL.value.trim() : '';
  let tpInput = orderTP ? orderTP.value.trim() : '';
  let sl = slInput ? Number(slInput) : null;
  let tp = tpInput ? Number(tpInput) : null;
  if (slInput && (!Number.isFinite(sl) || sl <= 0)) sl = null;
  if (tpInput && (!Number.isFinite(tp) || tp <= 0)) tp = null;

  // Validate SL/TP direction
  if (effectiveSide === 'buy') {
    if ((sl !== null && sl >= priceNow) || (tp !== null && tp <= priceNow)) {
      alert('Invalid SL/TP for buy order: SL must be below entry price, TP must be above entry price.');
      return;
    }
  } else if (effectiveSide === 'sell') {
    if ((sl !== null && sl <= priceNow) || (tp !== null && tp >= priceNow)) {
      alert('Invalid SL/TP for sell order: SL must be above entry price, TP must be below entry price.');
      return;
    }
  }

  if (amount > paperAccount.balance) {
    if (!confirm(`Required $${amount.toFixed(2)} exceeds available balance $${paperAccount.balance.toFixed(2)}. Place anyway?`)) return;
  }

  const pos = {
    id: 'p_' + Math.random().toString(36).slice(2,9),
    symbol: (symbolSelect && symbolSelect.value) || 'BTCUSDT',
    interval: (tfSelect && tfSelect.value) || '1m',
    side: effectiveSide,
    entry_price: priceNow,
    qty,
    initial_notional: amount,
    sl,
    tp,
    entry_time: (candles && candles.length ? candles[candles.length-1].time : Math.floor(Date.now()/1000)),
    status: 'open'
  };

  // deduct notional as margin for position
  paperAccount.balance -= amount;
  openPositions.push(pos);
  addPaperMarker(pos, false);
  persistTrade({ ts: pos.entry_time, symbol: pos.symbol, side: pos.side, entry_price: pos.entry_price, qty: pos.qty, pnl: null, note: 'paper_entry', pos_id: pos.id }).catch(()=>{});
  updatePaperUI();

  // Check for immediate SL/TP hit on current/entry candle
  const currentCandle = candles.length ? candles[candles.length - 1] : { high: priceNow, low: priceNow, close: priceNow, time: pos.entry_time };
  evaluatePaperPositionsOnCandle(currentCandle);

  // create draggable horizontal shapes for SL and TP (if provided),
  try {
    const createHP = (price, type) => {
      if (price == null) return null;
      const p = { time: null, price: price, xPx: null, yPx: null };
      const p2 = { time: null, price: price, xPx: null, yPx: null };
      const color = type === 'sl' ? '#ff7675' : '#66ff99';
      const meta = { posId: pos.id, type: type };
      const s = window.createLineShape ? window.createLineShape('horizontal', p, p2, { color, width: 2, meta }) : null;
      return s;
    };

    if (pos.sl) createHP(pos.sl, 'sl');
    if (pos.tp) createHP(pos.tp, 'tp');

    // if neither were provided, create reasonable defaults (small offsets)
    if (!pos.sl && !pos.tp) {
      const offset = (priceNow * 0.01); // 1% default
      if (selectedSide === 'buy') {
        pos.sl = Number((priceNow - offset).toFixed(2));
        pos.tp = Number((priceNow + offset).toFixed(2));
      } else {
        pos.sl = Number((priceNow + offset).toFixed(2));
        pos.tp = Number((priceNow - offset).toFixed(2));
      }
      createHP(pos.sl, 'sl');
      createHP(pos.tp, 'tp');
      persistTrade({ ts: Math.floor(Date.now()/1000), symbol: pos.symbol, side: pos.side, entry_price: pos.entry_price, qty: pos.qty, pnl: null, note: 'paper_set_default_sl_tp', pos_id: pos.id }).catch(()=>{});
      updatePaperUI();
    }
  } catch (e) { console.warn('create SL/TP shapes err', e); }

  // Clear inputs after place
  if (orderAmount) orderAmount.value = '';
  if (orderQty) orderQty.value = '';
  if (orderSL) orderSL.value = '';
  if (orderTP) orderTP.value = '';
});

/* Quick buy/sell from leftbar */
const buyQuickBtn = document.getElementById('buyQuickBtn');
const sellQuickBtn = document.getElementById('sellQuickBtn');
if (buyQuickBtn) {
  buyQuickBtn.addEventListener('click', () => {
    window.__paper_last_side = 'buy';
    buyQuickBtn.classList.add('active');
    sellQuickBtn?.classList.remove('active');
    if (paperPanel && paperPanel.style.display === 'none') {
      paperPanel.style.display = 'block';
    }
    // Optional: Auto-place small order
    // setTimeout(() => { if (orderAmount) orderAmount.value = '1000'; placeOrderBtn.click(); }, 100);
  });
}
if (sellQuickBtn) {
  sellQuickBtn.addEventListener('click', () => {
    window.__paper_last_side = 'sell';
    sellQuickBtn.classList.add('active');
    buyQuickBtn?.classList.remove('active');
    if (paperPanel && paperPanel.style.display === 'none') {
      paperPanel.style.display = 'block';
    }
    // Optional: Auto-place small order
    // setTimeout(() => { if (orderAmount) orderAmount.value = '1000'; placeOrderBtn.click(); }, 100);
  });
}

/* buy / sell button visuals */
if (buyBtn) buyBtn.addEventListener('click', ()=> { window.__paper_last_side = 'buy'; buyBtn.classList.add('active'); if (sellBtn) sellBtn.classList.remove('active'); });
if (sellBtn) sellBtn.addEventListener('click', ()=> { window.__paper_last_side = 'sell'; sellBtn.classList.add('active'); if (buyBtn) buyBtn.classList.remove('active'); });

/* Chart trade overlay buttons */
// overlayBuyBtn and overlaySellBtn not defined in current UI; comment out to avoid error
/*
if (overlayBuyBtn) overlayBuyBtn.addEventListener('click', () => {
  window.__paper_last_side = 'buy';
  // Set default order amount if not set
  if (orderAmount && !orderAmount.value) orderAmount.value = '1000';
  // Trigger the place order button
  if (placeOrderBtn) placeOrderBtn.click();
});

if (overlaySellBtn) overlaySellBtn.addEventListener('click', () => {
  window.__paper_last_side = 'sell';
  // Set default order amount if not set
  if (orderAmount && !orderAmount.value) orderAmount.value = '1000';
  // Trigger the place order button
  if (placeOrderBtn) placeOrderBtn.click();
});
*/

/* Called on each incoming candle update to evaluate SL/TP hits & update unrealized PnL */
async function evaluatePaperPositionsOnCandle(candle) {
  if (!candle) return;
  const current = candle.close;
  if (lastPriceEl) lastPriceEl.innerText = `Price: ${current.toFixed(2)}`;

  const high = candle.high, low = candle.low;
  const toClose = [];
  for (let i = 0; i < openPositions.length; i++) {
    const pos = openPositions[i];
    if (candle.time < pos.entry_time) continue; // Allow evaluation on entry candle for intra-bar hits
    let closed = false;
    let exitPrice = null;
    let reason = null;

    if (pos.side === 'buy') {
      if (pos.tp != null && Number.isFinite(pos.tp) && high >= pos.tp) { exitPrice = pos.tp; reason = 'tp'; closed = true; }
      else if (pos.sl != null && Number.isFinite(pos.sl) && low <= pos.sl) { exitPrice = pos.sl; reason = 'sl'; closed = true; }
    } else if (pos.side === 'sell') {
      if (pos.tp != null && Number.isFinite(pos.tp) && low <= pos.tp) { exitPrice = pos.tp; reason = 'tp'; closed = true; }
      else if (pos.sl != null && Number.isFinite(pos.sl) && high >= pos.sl) { exitPrice = pos.sl; reason = 'sl'; closed = true; }
    }

    if (closed) {
      const pnl = (pos.side === 'buy') ? (exitPrice - pos.entry_price) * pos.qty : (pos.entry_price - exitPrice) * pos.qty;
      paperAccount.realized += pnl;
      // return margin + pnl
      paperAccount.balance += pos.initial_notional + pnl;
      const closedObj = Object.assign({}, pos, { exit_price: exitPrice, pnl, exit_time: candle.time, reason });
      const tradeId = await persistTrade({ ts: closedObj.exit_time, symbol: closedObj.symbol, side: closedObj.side, entry_price: pos.entry_price, exit_price: exitPrice, qty: pos.qty, pnl, note: 'paper_exit', pos_id: pos.id });
      if (tradeId) closedObj.id = tradeId;
      closedTrades.push(closedObj);

      // Remove any SL/TP shapes and entry marker tied to this pos
      for (let sIdx = shapes.length - 1; sIdx >= 0; sIdx--) {
        const s = shapes[sIdx];
        if (s.meta && s.meta.posId === pos.id) {
          shapes.splice(sIdx, 1);
        }
      }
      paperMarkers = paperMarkers.filter(m => m.posId !== pos.id);
      updateMarkers();

      showTradeAlert(reason, pnl);

      toClose.push(i);
    } else {
      // nothing to do here now
    }
  }

  for (let j = toClose.length - 1; j >= 0; j--) {
    const idx = toClose[j];
    openPositions.splice(idx, 1);
  }

  // recompute unrealized & equity
  let unrealTotal = 0;
  let totalMargin = 0;
  for (const p of openPositions) {
    totalMargin += p.initial_notional;
    const curUnreal = (p.side === 'buy') ? (current - p.entry_price) * p.qty : (p.entry_price - current) * p.qty;
    unrealTotal += curUnreal;
  }
  paperAccount.unrealized = unrealTotal;
  paperAccount.equity = paperAccount.balance + totalMargin + paperAccount.unrealized;
  updatePaperUI();
  updateHistoryUI();
}

function updateHistoryUI() {
  if (historyTradesList) {
    if (closedTrades.length === 0) {
      historyTradesList.innerHTML = '<div style="text-align:center;color:var(--muted-2);padding:10px;font-size:12px">No closed trades</div>';
    } else {
      const sorted = closedTrades.sort((a, b) => (b.exit_time || b.ts) - (a.exit_time || a.ts));
      historyTradesList.innerHTML = sorted.map(trade => {
        const pnlColor = (trade.pnl || 0) >= 0 ? '#9beeac' : '#ff9b9b';
        const exitTime = new Date((trade.exit_time || trade.ts) * 1000).toLocaleString();
        return `
          <div class="trade-item closed" style="display: flex; justify-content: space-between; align-items: center; padding: 8px; border-bottom: 1px solid #333;">
            <div class="details" style="flex: 1;">
              <div><strong>${trade.side.toUpperCase()} ${trade.reason?.toUpperCase() || 'CLOSED'}</strong> @ ${trade.exit_price?.toFixed(4) || '—'} (PnL: <span style="color:${pnlColor}">${(trade.pnl || 0) >= 0 ? '+' : ''}$${Math.abs(trade.pnl || 0).toFixed(2)}</span>)</div>
              <div style="color:var(--muted-2);font-size:11px">Entry: ${trade.entry_price.toFixed(4)} | Exit: ${exitTime}</div>
            </div>
            ${trade.id ? `<button class="delete-trade-btn" onclick="deleteTrade('${trade.id}')" style="background: #ff4444; color: white; border: none; border-radius: 4px; width: 24px; height: 24px; cursor: pointer; font-size: 12px; margin-left: 8px;">×</button>` : ''}
          </div>
        `;
      }).join('');
    }
  }
}

async function loadPaperHistory() {
  try {
    const resp = await fetch('/paper/positions?closedLimit=200');
    if (!resp.ok) return false;
    const data = await resp.json();
    if (!data || !data.ok) return false;

    if (Array.isArray(data.closed) && data.closed.length > 0) {
      closedTrades = data.closed.map(r => ({
        id: r.id,
        ts: r.ts || r.exit_time,
        symbol: r.symbol,
        side: r.side,
        entry_price: r.entry_price,
        exit_price: r.exit_price,
        qty: r.qty,
        pnl: r.pnl,
        note: r.note,
        exit_time: r.exit_time || r.ts
      }));
      updateHistoryUI();
      return true;
    }
    return false;
  } catch (e) {
    console.warn('loadPaperHistory err', e);
    return false;
  }
}

async function deleteTrade(id) {
  if (!id || !confirm('Are you sure you want to delete this trade from history?')) return;

  // First, attempt server delete
  try {
    const res = await fetch(`/paper/trade/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.success) throw new Error('Server delete failed');
    console.log('Server delete successful:', data);
  } catch (e) {
    console.error('Server delete failed:', e.message);
    alert('Failed to delete trade from server. Please try again.');
    return;
  }

  // If server success, remove from local
  closedTrades = closedTrades.filter(t => t.id !== id);

  // Refetch to sync UI with server
  await loadPaperHistory();

  updateHistoryUI();
}

window.deleteTrade = deleteTrade;

/* End of script */
