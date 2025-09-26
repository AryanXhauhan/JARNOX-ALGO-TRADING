// server.js (optimized)
// Node 16+
// npm i express ws axios body-parser better-sqlite3 proxy-agent

'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const path = require('path');
const bodyParser = require('body-parser');
const Database = require('better-sqlite3');
const { ProxyAgent } = require('proxy-agent');

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ---------------- Config / constants ----------------
// ✅ Env-overridable endpoints to avoid region blocks (451)
const BINANCE_REST = process.env.BINANCE_REST || 'https://api.binance.com';
const BINANCE_WS_BASE = process.env.BINANCE_WS || 'wss://stream.binance.com:9443/ws';

const MAX_CANDLES_CACHE = 2000;
const MAX_SEED_CANDLES = 1000;
const MAX_HISTORY_FETCH = 1000;
const FEEDER_BASE_RETRY_MS = 2000;
const FEEDER_MAX_RETRY_MS = 120000;
const HEARTBEAT_INTERVAL = 30_000;

// ---------------- Shared axios instance ----------------
const axiosInst = axios.create({
  timeout: 20_000,
  validateStatus: s => s >= 200 && s < 500,
  headers: { 'User-Agent': 'arualgo-server/1.0' }
});

// ---------------- In-memory stores ----------------
// session handling
const users = new Map(); // sessionId -> { userId, premiumUntil }

// ws connections meta
// Map<WebSocket, { sessionId, subscriptions: Set<string>, isAlive: boolean }>
const connections = new Map();

// indicators & caches keyed by `${SYMBOL}::${INTERVAL}`
const indicatorInstances = new Map();
const currentCandles = new Map(); // key -> Array<bars>
const feeders = new Map();        // key -> { ws, symbol, interval, reconnectMs, retryTimer, connecting }

// ---------------- SQLite storage (better-sqlite3) ----------------
const db = new Database(path.join(__dirname, 'trades.db'));
db.pragma('journal_mode = WAL');
db.prepare(`CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  entry_price REAL NOT NULL,
  exit_price REAL,
  qty REAL,
  pnl REAL,
  note TEXT
)`).run();

const insertTradeStmt = db.prepare('INSERT INTO trades (ts,symbol,side,entry_price,exit_price,qty,pnl,note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const selectRecentTrades = db.prepare('SELECT * FROM trades ORDER BY ts DESC LIMIT ?');

// ---------------- Utilities ----------------
const now = () => Date.now();
function keyFor(symbol, interval) { return `${String(symbol).toUpperCase()}::${String(interval)}`; }
function createSubKey(key, indicator) { return `${key}::${indicator || ''}`; }
function isPremium(sessionId) { const u = users.get(sessionId); return !!(u && u.premiumUntil && u.premiumUntil > Date.now()); }

function safeParseJSON(s) {
  try { return JSON.parse(s); } catch (_) { return null; }
}

function parseCandle(input) {
  if (!input) return null;
  const { time, open, high, low, close, volume } = input;
  if (time == null || open == null || high == null || low == null || close == null) return null;
  return { time: Number(time), open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume ?? 0) };
}

function clamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }

function scheduleReconnect(feederKey, symbol, interval, feederMeta) {
  // exponential backoff with jitter
  try {
    if (!feederMeta) feederMeta = feeders.get(feederKey) || { symbol, interval, reconnectMs: FEEDER_BASE_RETRY_MS, retryTimer: null };
    let ms = feederMeta.reconnectMs || FEEDER_BASE_RETRY_MS;
    ms = Math.min(Math.round(ms * 1.8), FEEDER_MAX_RETRY_MS);
    // small jitter
    ms = Math.round(ms * (1 + (Math.random() * 0.3)));
    feederMeta.reconnectMs = ms;
    if (feederMeta.retryTimer) {
      try { clearTimeout(feederMeta.retryTimer); } catch (_) {}
      feederMeta.retryTimer = null;
    }
    feederMeta.retryTimer = setTimeout(() => {
      feederMeta.retryTimer = null;
      // guard - don't start if there's already a good feeder present
      try { startFeeder(symbol, interval); } catch (e) { console.warn('scheduled startFeeder failed', e && e.message); }
    }, ms);
    if (feederMeta.retryTimer && feederMeta.retryTimer.unref) feederMeta.retryTimer.unref();
    feeders.set(feederKey, feederMeta);
  } catch (e) {
    console.warn('scheduleReconnect err', e && e.message);
  }
}

// ---------------- Indicator fallback (optimized) ----------------
class AruAlgo {
  constructor() {
    // Keep arrays incremental to avoid recreating large arrays every candle
    this.candles = []; // array of {time,open,high,low,close,volume}
    this.closes = [];  // array of close prices for fast numeric ops
    this.lastSignal = null;
  }

  _pushCandle(candle) {
    this.candles.push(candle);
    this.closes.push(candle.close);
    if (this.candles.length > 5000) {
      this.candles.shift();
      this.closes.shift();
    }
  }

  _smaFromCloses(len) {
    const L = this.closes.length;
    if (L < len) return null;
    let s = 0;
    for (let i = L - len; i < L; i++) s += this.closes[i];
    return s / len;
  }

  _emaFromCloses(len) {
    const arr = this.closes;
    const L = arr.length;
    if (L < len) return null;
    const k = 2 / (len + 1);
    // seed average of first len
    let ema = 0;
    for (let i = 0; i < len; i++) ema += arr[i];
    ema = ema / len;
    for (let i = len; i < L; i++) {
      ema = arr[i] * k + ema * (1 - k);
    }
    return ema;
  }

  _rsiFromCloses(period = 14) {
    const arr = this.closes;
    const L = arr.length;
    if (L <= period) return null;
    let gains = 0, losses = 0;
    // compute last 'period' differences
    for (let i = L - period + 1; i < L; i++) {
      const d = arr[i] - arr[i - 1];
      if (d > 0) gains += d; else losses += Math.abs(d);
    }
    const rs = gains / (losses || 1e-9);
    return 100 - (100 / (1 + rs));
  }

  _bollingerFromCloses(len = 20, numStd = 2) {
    const arr = this.closes;
    const L = arr.length;
    if (L < len) return null;
    let s = 0;
    for (let i = L - len; i < L; i++) s += this.closes[i];
    const sma = s / len;
    let variance = 0;
    for (let i = L - len; i < L; i++) {
      const d = arr[i] - sma;
      variance += d * d;
    }
    variance = variance / len;
    const std = Math.sqrt(variance);
    return { upper: sma + numStd * std, lower: sma - numStd * std, sma, std };
  }

  processCandle(candle) {
    // minimal defensive copy
    const c = { time: Number(candle.time), open: +candle.open, high: +candle.high, low: +candle.low, close: +candle.close, volume: Number(candle.volume ?? 0) };
    this._pushCandle(c);
    const closes = this.closes; // local ref

    const out = { ready: false, time: c.time, close: c.close };

    const smaShort = this._smaFromCloses(10);
    const smaLong = this._smaFromCloses(30);
    const emaShort = this._emaFromCloses(10);
    const emaLong = this._emaFromCloses(30);
    const rsi = this._rsiFromCloses(14);
    const boll = this._bollingerFromCloses(20, 2);

    if (smaShort != null && smaLong != null) { out.smaShort = smaShort; out.smaLong = smaLong; }
    if (emaShort != null && emaLong != null) { out.emaShort = emaShort; out.emaLong = emaLong; }
    if (rsi != null) out.rsi = rsi;
    if (boll != null) out.bollinger = boll;

    // SMA Crossover
    const L = closes.length;
    if (L >= 31 && smaShort != null && smaLong != null) {
      // compute prior SMAs cheaply by summing windows rather than slicing
      let prevSmaShort = null, prevSmaLong = null;
      if (L >= 11) {
        let s = 0;
        for (let i = L - 11; i < L - 1; i++) s += closes[i];
        prevSmaShort = s / 10;
      }
      if (L >= 31) {
        let s = 0;
        for (let i = L - 31; i < L - 1; i++) s += closes[i];
        prevSmaLong = s / 30;
      }
      if (prevSmaShort != null && prevSmaLong != null) {
        if (prevSmaShort <= prevSmaLong && smaShort > smaLong) {
          out.signal = { side: 'buy', reason: 'sma_cross', time: c.time, price: c.close }; this.lastSignal = 'buy';
        } else if (prevSmaShort >= prevSmaLong && smaShort < smaLong) {
          out.signal = { side: 'sell', reason: 'sma_cross', time: c.time, price: c.close }; this.lastSignal = 'sell';
        }
      }
    }

    // EMA crossover (similar approach)
    if (L >= 31 && emaShort != null && emaLong != null) {
      const closesPrev = closes.slice(0, -1);
      const emaShortPrev = closesPrev.length >= 10 ? (function(arr,len){
        const k=2/(len+1);
        let ema = 0;
        for(let i=0;i<len;i++) ema += arr[i];
        ema /= len;
        for(let i=len;i<arr.length;i++) ema = arr[i]*k + ema*(1-k);
        return ema;
      })(closesPrev,10) : null;
      const emaLongPrev = closesPrev.length >= 30 ? (function(arr,len){
        const k=2/(len+1);
        let ema = 0;
        for(let i=0;i<len;i++) ema += arr[i];
        ema /= len;
        for(let i=len;i<arr.length;i++) ema = arr[i]*k + ema*(1-k);
        return ema;
      })(closesPrev,30) : null;

      if (emaShortPrev != null && emaLongPrev != null) {
        if (emaShortPrev <= emaLongPrev && emaShort > emaLong) {
          out.signal = { side: 'buy', reason: 'ema_cross', time: c.time, price: c.close };
        } else if (emaShortPrev >= emaLongPrev && emaShort < emaLong) {
          out.signal = { side: 'sell', reason: 'ema_cross', time: c.time, price: c.close };
        }
      }
    }

    // RSI crossing
    if (rsi != null && closes.length > 1) {
      const prevCloses = closes.slice(0, -1);
      if (prevCloses.length > 14) {
        let gains = 0, losses = 0;
        for (let i = prevCloses.length - 13; i < prevCloses.length; i++) {
          const d = prevCloses[i] - prevCloses[i - 1];
          if (d > 0) gains += d; else losses += Math.abs(d);
        }
        const prevRsi = 100 - (100 / (1 + (gains / (losses || 1e-9))));
        if (prevRsi < 30 && rsi >= 30) out.signal = { side: 'buy', reason: 'rsi_oversold', time: c.time, price: c.close };
        else if (prevRsi > 70 && rsi <= 70) out.signal = { side: 'sell', reason: 'rsi_overbought', time: c.time, price: c.close };
      }
    }

    // Bollinger mean-reversion
    if (boll != null) {
      if (c.close <= boll.lower) out.signal = { side: 'buy', reason: 'boll_lower', time: c.time, price: c.close };
      else if (c.close >= boll.upper) out.signal = { side: 'sell', reason: 'boll_upper', time: c.time, price: c.close };
    }

    out.ready = true;
    return out;
  }
}

// ---------------- Broadcast helpers (optimized) ----------------
function broadcastAll(obj) {
  const payload = JSON.stringify(obj);
  for (const [ws] of connections.entries()) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(payload); } catch (err) { /* ignore per-connection errors */ }
    }
  }
}

function broadcastIndicator(symbol, interval, indicatorName, payloadObj) {
  const baseKey = keyFor(symbol, interval);
  const subKey = createSubKey(baseKey, indicatorName);
  const payloadStr = JSON.stringify({ type: 'indicator_update', symbol, interval, indicator: indicatorName, data: payloadObj });
  for (const [ws, meta] of connections.entries()) {
    if (!ws || !meta || !meta.subscriptions) continue;
    // If client subscribed specifically for this indicator, send. If they subscribed to base key with empty indicator, also send.
    if (!meta.subscriptions.has(subKey) && !meta.subscriptions.has(createSubKey(baseKey, null))) continue;
    if (!isPremium(meta.sessionId)) {
      try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', reason: 'premium_expired' })); } catch (_) {}
      meta.subscriptions.delete(subKey);
      continue;
    }
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(payloadStr); } catch (err) { /* ignore */ }
    }
  }
}

function broadcastSignalAll(signal, symbol, interval) {
  if (!signal) return;
  const payload = JSON.stringify({ type: 'signal', symbol, interval, signal });
  for (const [ws] of connections.entries()) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(payload); } catch (err) { /* ignore */ }
    }
  }
}

// ---------------- Websocket server for frontends ----------------
wss.on('connection', (ws, req) => {
  const remote = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
  console.log('WS conn from', remote);
  const meta = { sessionId: null, subscriptions: new Set(), isAlive: true };
  connections.set(ws, meta);

  ws.on('pong', () => { meta.isAlive = true; });

  // greet
  try { ws.send(JSON.stringify({ type: 'welcome', msg: 'connected to arualgo feed' })); } catch (_) {}

  ws.on('message', (raw) => {
    let msg = null;
    try {
      if (typeof raw === 'string') msg = safeParseJSON(raw);
      else if (raw && raw.toString) msg = safeParseJSON(raw.toString());
    } catch (e) {
      msg = null;
    }
    if (!msg || typeof msg.type !== 'string') {
      try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', reason: 'invalid_message' })); } catch (_) {}
      return;
    }

    switch (msg.type) {
      case 'auth': {
        const sid = msg.sessionId || `guest-${Math.random().toString(36).slice(2,8)}`;
        meta.sessionId = sid;
        if (!users.has(sid)) {
          users.set(sid, { userId: sid, premiumUntil: msg.demoPremium ? Date.now() + 5*60*1000 : 0 });
        }
        try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'auth_ok', sessionId: sid, premium: isPremium(sid) })); } catch (_) {}
        break;
      }

      case 'subscribe': {
        const symbol = String((msg.symbol || 'BTCUSDT')).toUpperCase();
        const interval = String(msg.interval || '1m');
        const indicator = msg.indicator || null;

        if (indicator && !isPremium(meta.sessionId)) {
          try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', reason: 'indicator_requires_premium' })); } catch (_) {}
          break;
        }

        // ensure feeder exists (idempotent)
        try { startFeeder(symbol, interval); } catch (e) { console.warn('startFeeder error', e && e.message); }

        const subKey = createSubKey(keyFor(symbol, interval), indicator);
        meta.subscriptions.add(subKey);
        try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'subscribed', symbol, interval, indicator })); } catch (_) {}
        break;
      }

      case 'unsubscribe': {
        const symbol = String((msg.symbol || 'BTCUSDT')).toUpperCase();
        const interval = String(msg.interval || '1m');
        const indicator = msg.indicator || null;
        const subKey = createSubKey(keyFor(symbol, interval), indicator);
        meta.subscriptions.delete(subKey);
        try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'unsubscribed', symbol, interval, indicator })); } catch (_) {}
        break;
      }

      case 'get_snapshot': {
        const symbol = String((msg.symbol || 'BTCUSDT')).toUpperCase();
        const interval = String(msg.interval || '1m');
        const limit = Math.min(1000, Number(msg.limit) || 500);
        const arr = currentCandles.get(keyFor(symbol, interval)) || [];
        try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'snapshot', symbol, interval, data: arr.slice(-limit) })); } catch (_) {}
        break;
      }

      case 'ping': {
        try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pong' })); } catch (_) {}
        break;
      }

      default: {
        try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', reason: 'unknown_type' })); } catch (_) {}
        break;
      }
    }
  });

  ws.on('close', (code, reason) => {
    connections.delete(ws);
    try { if (ws && ws.terminate) ws.terminate(); } catch (_) {}
    const reasonStr = reason && reason.toString && reason.toString();
    console.info('WS closed', remote, code, reasonStr);
  });

  ws.on('error', (err) => {
    connections.delete(ws);
    console.warn('WS error from', remote, err && err.message);
    try { if (ws && ws.terminate) ws.terminate(); } catch (_) {}
  });
});

// heartbeat: ping clients & cleanup dead
const heartbeatTimer = setInterval(() => {
  for (const [ws, meta] of connections.entries()) {
    if (!meta) continue;
    try {
      if (meta.isAlive === false) {
        connections.delete(ws);
        try { if (ws && ws.terminate) ws.terminate(); } catch (_) {}
        continue;
      }
      meta.isAlive = false;
      if (ws && typeof ws.ping === 'function') {
        try { ws.ping(() => {}); } catch (_) {}
      }
    } catch (e) {
      console.warn('heartbeat iteration err', e && e.message);
    }
  }
}, HEARTBEAT_INTERVAL);
if (heartbeatTimer.unref) heartbeatTimer.unref();

// ---------------- REST endpoints ----------------
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.get('/history', async (req, res) => {
  try {
    const symbolRaw = String(req.query.symbol || 'BTCUSDT');
    const symbol = symbolRaw.toUpperCase();
    const interval = String(req.query.interval || '1m');
    const limit = Math.min(MAX_HISTORY_FETCH, Number(req.query.limit || 500));

    if (!/^[A-Z0-9]{3,12}$/.test(symbol)) return res.status(400).json({ error: 'invalid_symbol' });

    const url = `${BINANCE_REST}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    console.info('Fetching history', symbol, interval, limit);
    const r = await axiosInst.get(url);

    if (!r || !Array.isArray(r.data)) {
      const status = r && r.status;
      console.warn('Bad /history response for', symbol, status);
      return res.status(502).json({ error: 'bad_history_response', status, hint: status === 451 ? 'region_blocked' : undefined });
    }

    const data = r.data.map(k => ({
      time: Math.floor(k[0] / 1000),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5])
    }));

    const key = keyFor(symbol, interval);
    currentCandles.set(key, data.slice(-MAX_SEED_CANDLES));
    console.info(`Cached ${currentCandles.get(key).length} bars for ${key}`);

    try { startFeeder(symbol, interval); } catch (e) { console.warn('startFeeder after history err', e && e.message); }

    return res.json({ ok: true, symbol, interval, data });
  } catch (err) {
    console.error('history err', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'failed_fetch_history', message: err && err.message });
  }
});

// ingest endpoint: accepts a single candle and updates caches & indicators
app.post('/ingest', (req, res) => {
  try {
    const { symbol, interval, candle } = req.body || {};
    if (!symbol || !candle) return res.status(400).json({ error: 'symbol and candle required' });
    const sym = String(symbol).toUpperCase();
    const intv = String(interval || '1m');
    const ck = parseCandle(candle);
    if (!ck) return res.status(400).json({ error: 'invalid_candle' });

    const key = keyFor(sym, intv);
    let arr = currentCandles.get(key);
    if (!Array.isArray(arr)) arr = [];
    // update last bar if same timestamp
    if (arr.length > 0 && arr[arr.length - 1].time === ck.time) arr[arr.length - 1] = ck;
    else arr.push(ck);
    if (arr.length > MAX_CANDLES_CACHE) arr.shift();
    currentCandles.set(key, arr);

    // ensure indicator instance exists & seeded
    let inst = indicatorInstances.get(key);
    if (!inst) {
      inst = new AruAlgo();
      if (arr.length) {
        for (const c of arr) {
          try { inst.processCandle(c); } catch (_) {}
        }
      }
      indicatorInstances.set(key, inst);
    }

    // process the incoming candle
    let out = null;
    try { out = inst.processCandle(ck); } catch (e) { console.warn('indicator process error', e && e.message); }

    if (out && out.ready) {
      broadcastIndicator(sym, intv, 'arualgo_v6_7', out);
      if (out.signal) broadcastSignalAll(out.signal, sym, intv);
    }

    broadcastAll({ type: 'candles_update', symbol: sym, interval: intv, candle: ck, isFinal: true });
    return res.json({ ok: true });
  } catch (err) {
    console.error('ingest error', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'internal_error' });
  }
});

// demo premium endpoints
app.post('/demo/grant', (req, res) => {
  const { sessionId, minutes } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  const mins = clamp(Number(minutes) || 10, 1, 60 * 24 * 30);
  users.set(sessionId, { userId: sessionId, premiumUntil: Date.now() + mins * 60 * 1000 });
  return res.json({ ok: true, sessionId, premiumUntil: users.get(sessionId).premiumUntil });
});
app.post('/demo/revoke', (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  users.set(sessionId, { userId: sessionId, premiumUntil: 0 });
  return res.json({ ok: true, sessionId });
});

app.get('/paper/trades/recent', (req, res) => {
  try {
    const limit = Math.min(500, Number(req.query.limit) || 50);
    const openStmt = db.prepare('SELECT * FROM trades WHERE exit_price IS NULL ORDER BY ts DESC');
    const closedStmt = db.prepare('SELECT * FROM trades WHERE exit_price IS NOT NULL ORDER BY ts DESC LIMIT ?');
    const openRows = openStmt.all();
    const closedRows = closedStmt.all(limit);
    return res.json({ ok: true, open: openRows, closed: closedRows });
  } catch (err) {
    console.error('paper/trades err', err && err.message);
    return res.status(500).json({ error: 'db_error' });
  }
});

app.get('/paper/positions', (req, res) => {
  try {
    const closedLimit = Math.min(500, Number(req.query.closedLimit) || 200);
    const openRows = db.prepare('SELECT * FROM trades WHERE exit_price IS NULL ORDER BY ts DESC').all();
    const closedRows = db.prepare('SELECT * FROM trades WHERE exit_price IS NOT NULL ORDER BY ts DESC LIMIT ?').all(closedLimit);
    return res.json({ ok: true, open: openRows, closed: closedRows });
  } catch (err) {
    console.error('paper/positions err', err && err.message);
    return res.status(500).json({ error: 'db_error' });
  }
});

app.post('/paper/trade', (req, res) => {
  try {
    const { ts, symbol, side, entry_price, exit_price, qty, pnl, note, pos_id } = req.body || {};
    if (!ts || !symbol || !side || entry_price == null || qty == null) {
      return res.status(400).json({ error: 'missing_required_fields' });
    }

    const result = insertTradeStmt.run(
      Number(ts),
      String(symbol).toUpperCase(),
      String(side),
      Number(entry_price),
      exit_price != null ? Number(exit_price) : null,
      Number(qty),
      pnl != null ? Number(pnl) : null,
      note ? String(note) : null
    );

    if (result.changes === 0) {
      return res.status(500).json({ error: 'insert_failed' });
    }

    return res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error('paper/trade POST err', err && err.message);
    return res.status(500).json({ error: 'db_error' });
  }
});

app.delete('/paper/trade/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' });
    const result = db.prepare('DELETE FROM trades WHERE id = ?').run(id);
    if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
    return res.json({ success: true, deleted: id });
  } catch (err) {
    console.error('delete trade err', err && err.message);
    return res.status(500).json({ error: 'db_error' });
  }
});

app.post('/backtest', async (req, res) => {
  try {
    const body = req.body || {};
    const symbol = String((body.symbol || 'BTCUSDT')).toUpperCase();
    const interval = String(body.interval || '1m');
    const strategy = String((body.strategy || 'sma')).toLowerCase();
    const limit = Math.min(5000, Number(body.limit || 2000));
    const initialCapital = Number(body.initial_capital || 10000);
    const sizePct = Math.max(0.0001, Number(body.size_pct || 0.1));
    const slippageBps = Number(body.slippage_bps || 5);
    const commissionPct = Number(body.commission_pct || 0.0005);

    let arr = currentCandles.get(keyFor(symbol, interval)) || [];
    if (arr.length < 50) {
      const url = `${BINANCE_REST}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${Math.min(1000, limit)}`;
      const r = await axiosInst.get(url);
      if (!r || !Array.isArray(r.data)) return res.status(400).json({ error: 'not_enough_data' });
      arr = r.data.map(k => ({ time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
    }
    if (!arr || arr.length < 30) return res.status(400).json({ error: 'not_enough_data' });

    arr = arr.slice(-limit).sort((a, b) => a.time - b.time);

    const SMA = (data, idx, len) => {
      const start = idx - len + 1;
      if (start < 0) return null;
      let s = 0; for (let i = start; i <= idx; i++) s += data[i].close;
      return s / len;
    };
    const RSI = (data, idx, period = 14) => {
      if (idx - period < 0) return null;
      let gains = 0, losses = 0;
      for (let i = idx - period + 1; i <= idx; i++) {
        const d = data[i].close - data[i - 1].close;
        if (d > 0) gains += d; else losses += Math.abs(d);
      }
      const rs = gains / (losses || 1e-9);
      return 100 - (100 / (1 + rs));
    };

    let cash = initialCapital;
    let position = 0;
    let entryPrice = 0;
    const trades = [];
    const equity = [];
    const metrics = { initialCapital }; // ← declare once

    const smaShort = Number(body.sma_short || 10);
    const smaLong = Number(body.sma_long || 30);
    const rsiPeriod = Number(body.rsi_period || 14);
    const rsiOverbought = Number(body.rsi_overbought || 70);
    const rsiOversold = Number(body.rsi_oversold || 30);

    for (let i = 1; i < arr.length - 1; i++) {
      const sShort = SMA(arr, i, smaShort);
      const sLong = SMA(arr, i, smaLong);
      const rsi = RSI(arr, i, rsiPeriod);

      let signal = null;
      if (strategy === 'sma' && sShort != null && sLong != null) {
        const sShortPrev = SMA(arr, i - 1, smaShort);
        const sLongPrev = SMA(arr, i - 1, smaLong);
        if (sShortPrev != null && sLongPrev != null) {
          if (sShortPrev <= sLongPrev && sShort > sLong) signal = 'buy';
          else if (sShortPrev >= sLongPrev && sShort < sLong) signal = 'sell';
        }
      } else if (strategy === 'rsi' && rsi != null) {
        const prevRsi = RSI(arr, i - 1, rsiPeriod);
        if (prevRsi != null) {
          if (prevRsi < rsiOversold && rsi >= rsiOversold) signal = 'buy';
          else if (prevRsi > rsiOverbought && rsi <= rsiOverbought) signal = 'sell';
        }
      }

      if (signal === 'buy' && position === 0) {
        const nextBar = arr[i + 1];
        if (nextBar) {
          const execPrice = nextBar.open * (1 + slippageBps / 10000) * (1 + commissionPct);
          const qty = (cash * sizePct) / execPrice;
          position = qty;
          entryPrice = execPrice;
          cash -= qty * execPrice;
          trades.push({ ts: nextBar.time, symbol, side: 'buy', entry_price: execPrice, exit_price: null, qty, pnl: null, note: `${strategy}_buy` });
        }
      } else if (signal === 'sell' && position > 0) {
        const nextBar = arr[i + 1];
        if (nextBar) {
          const execPrice = nextBar.open * (1 - slippageBps / 10000) * (1 - commissionPct);
          const qty = position;
          const pnl = qty * (execPrice - entryPrice);
          cash += qty * execPrice;
          position = 0;
          trades.push({ ts: nextBar.time, symbol, side: 'sell', entry_price: null, exit_price: execPrice, qty, pnl, note: `${strategy}_sell` });
        }
      }

      const marketValue = position > 0 ? position * arr[i].close : 0;
      equity.push({ time: arr[i].time, equity: cash + marketValue });
    }

    if (position > 0) {
      const lastBar = arr[arr.length - 1];
      const exitPrice = lastBar.close * (1 - slippageBps / 10000) * (1 - commissionPct);
      const qty = position;
      const pnl = qty * (exitPrice - entryPrice);
      cash += qty * exitPrice;
      trades.push({ ts: lastBar.time, symbol, side: 'sell', entry_price: null, exit_price: exitPrice, qty, pnl, note: 'exit_on_finish' });
      position = 0;
      equity.push({ time: lastBar.time, equity: cash });
    }

    const finalEquity = equity.length ? equity[equity.length - 1].equity : cash;
    const totalReturn = ((finalEquity - initialCapital) / initialCapital) * 100;

    // ← just assign fields; don't redeclare
    metrics.finalEquity = finalEquity;
    metrics.totalReturnPct = totalReturn;
    metrics.trades = trades.length;
    metrics.startTime = arr[0].time;
    metrics.endTime = arr[arr.length - 1].time;

    if (body.persistTrades) {
      const insertMany = db.transaction((rows) => {
        for (const t of rows) {
          insertTradeStmt.run(
            t.ts || Math.floor(Date.now() / 1000),
            symbol, (t.side || 'sell'),
            t.entry_price || null,
            t.exit_price != null ? +t.exit_price : null,
            t.qty || 0,
            t.pnl == null ? null : +t.pnl,
            t.note || null
          );
        }
      });
      try { insertMany(trades); } catch (e) { console.warn('persistTrades failed', e?.message); }
    }

    return res.json({ ok: true, symbol, interval, strategy, metrics, trades, equity });
  } catch (err) {
    console.error('backtest err', err?.stack || err?.message || err);
    return res.status(500).json({ error: 'backtest_failed', message: err?.message });
  }
});

// ---------------- Binance feeder (per symbol+interval) ----------------
function startFeeder(symbol = 'BTCUSDT', interval = '1m') {
  const key = keyFor(symbol, interval);
  const existing = feeders.get(key);
  if (existing) {
    // if ws exists and open or connecting, nothing to do
    if (existing.ws && existing.ws.readyState === WebSocket.OPEN) return;
    if (existing.connecting) return;
  }

  console.info('Starting feeder for', key);
  const seedCandles = currentCandles.get(key) || [];

  // ensure indicator instance exists & seeded
  let inst = indicatorInstances.get(key);
  if (!inst) {
    inst = new AruAlgo();
    if (seedCandles.length > 0) {
      for (let i = 0; i < seedCandles.length; i++) {
        try { inst.processCandle(seedCandles[i]); } catch (e) {}
      }
      console.info(`Seeded ${seedCandles.length} candles for ${key}`);
    }
    indicatorInstances.set(key, inst);
  }

  const stream = `${symbol.toLowerCase()}@kline_${interval}`;
  const url = `${BINANCE_WS_BASE}/${stream}`;
  let bws;
  try {
    bws = new WebSocket(url, { agent: process.env.HTTP_PROXY ? new ProxyAgent(process.env.HTTP_PROXY) : undefined });
  } catch (err) {
    console.warn('Failed to create Binance WS for', key, err && err.message);
    const feederMeta = feeders.get(key) || { symbol, interval, reconnectMs: FEEDER_BASE_RETRY_MS, retryTimer: null, connecting: false };
    feeders.set(key, feederMeta);
    scheduleReconnect(key, symbol, interval, feederMeta);
    return;
  }

  const feederMeta = { ws: bws, symbol, interval, reconnectMs: FEEDER_BASE_RETRY_MS, retryTimer: null, connecting: true };
  feeders.set(key, feederMeta);

  bws.on('open', () => {
    feederMeta.connecting = false;
    feederMeta.reconnectMs = FEEDER_BASE_RETRY_MS;
    feederMeta.connectedAt = Date.now();
    console.info('Binance feeder connected for', key);
  });

  bws.on('message', (raw) => {
    try {
      const payload = (typeof raw === 'string') ? safeParseJSON(raw) : safeParseJSON(raw && raw.toString && raw.toString());
      if (!payload || !payload.k) return;
      const k = payload.k;
      if (!k.t) return;

      const candle = {
        time: Math.floor(k.t / 1000),
        open: Number(k.o),
        high: Number(k.h),
        low: Number(k.l),
        close: Number(k.c),
        volume: Number(k.v)
      };
      const isFinal = !!k.x;

      // update candles cache (in-place when possible)
      let arr = currentCandles.get(key);
      if (!Array.isArray(arr)) arr = [];

      if (arr.length > 0 && arr[arr.length - 1].time === candle.time) {
        arr[arr.length - 1] = candle;
      } else {
        arr.push(candle);
        if (arr.length > MAX_CANDLES_CACHE) arr.shift();
      }
      currentCandles.set(key, arr);

      // broadcast candle update once (cheap)
      broadcastAll({ type: 'candles_update', symbol, interval, candle, isFinal });

      // if final candle, run indicator and broadcast indicator/signal
      if (isFinal) {
        try {
          const instance = indicatorInstances.get(key);
          if (instance) {
            const out = instance.processCandle(candle);
            if (out && out.ready) {
              broadcastIndicator(symbol, interval, 'arualgo_v6_7', out);
              if (out.signal) broadcastSignalAll(out.signal, symbol, interval);
            }
          }
        } catch (e) {
          console.warn('Indicator processing error for', key, e && e.message);
        }
      }
    } catch (err) {
      console.error('feeder parse err', err && err.message);
    }
  });

  bws.on('close', (code, reason) => {
    const reasonStr = reason && reason.toString && reason.toString();
    console.info('Binance feeder closed for', key, 'code:', code, 'reason:', reasonStr);
    if (String(code) === '451' || (reasonStr && reasonStr.includes && reasonStr.includes('451'))) {
      console.warn('Hint: 451 means region/IP blocked by Binance. Set BINANCE_WS/BINANCE_REST to binance.us or deploy in SG/IN/EU, or set HTTP_PROXY.');
    }
    console.log('Scheduling reconnect for', key);
    try { if (bws && bws.terminate) bws.terminate(); } catch (_) {}
    feeders.delete(key);
    scheduleReconnect(key, symbol, interval, feederMeta);
  });

  bws.on('error', (err) => {
    console.warn('Binance feeder error for', key, err && err.message);
    console.error('Full error:', err);
    try { if (bws && bws.terminate) bws.terminate(); } catch (_) {}
    feeders.delete(key);
    scheduleReconnect(key, symbol, interval, feederMeta);
  });

  // save updated feeder meta
  feeders.set(key, feederMeta);
}

// start a default feeder (non-fatal if fails)
try { startFeeder('BTCUSDT', '1m'); } catch (e) { console.warn('initial startFeeder failed', e && e.message); }

// ---------------- Start server ----------------
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// ---------------- Graceful shutdown ----------------
async function shutdown() {
  console.log('Shutting down...');
  try { clearInterval(heartbeatTimer); } catch (_) {}
  try {
    for (const [key, f] of feeders.entries()) {
      try { if (f.retryTimer) clearTimeout(f.retryTimer); } catch (_) {}
      try { if (f.ws && typeof f.ws.terminate === 'function') f.ws.terminate(); } catch (_) {}
      feeders.delete(key);
    }
  } catch (_) {}

  try { wss.close(); } catch (_) {}
  try { await new Promise((resolve) => server.close(resolve)); } catch (_) {}
  try { db.close(); } catch (_) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
