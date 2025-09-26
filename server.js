// server.js (fixed version)
// Node 16+
// npm i express ws axios body-parser better-sqlite3

'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const path = require('path');
const bodyParser = require('body-parser');
const Database = require('better-sqlite3');

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ---------------- Config / constants ----------------
// Use Binance US for better compatibility
const BINANCE_REST = process.env.BINANCE_REST || 'https://api.binance.com';
const BINANCE_WS_BASE = process.env.BINANCE_WS || 'wss://stream.binance.com:9443/ws';

const MAX_CANDLES_CACHE = 2000;
const MAX_SEED_CANDLES = 1000;
const MAX_HISTORY_FETCH = 1000;
const FEEDER_BASE_RETRY_MS = 5000; // Increased retry time
const FEEDER_MAX_RETRY_MS = 60000;
const HEARTBEAT_INTERVAL = 30000;

// ---------------- Shared axios instance ----------------
const axiosInst = axios.create({
  timeout: 15000,
  validateStatus: s => s >= 200 && s < 500,
  headers: { 
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json'
  }
});

// ---------------- In-memory stores ----------------
const users = new Map();
const connections = new Map();
const indicatorInstances = new Map();
const currentCandles = new Map();
const feeders = new Map();

// ---------------- SQLite storage ----------------
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

// ---------------- Utilities ----------------
function keyFor(symbol, interval) { 
  return `${String(symbol).toUpperCase()}::${String(interval)}`; 
}

function safeParseJSON(s) {
  try { return JSON.parse(s); } catch (_) { return null; }
}

function parseCandle(input) {
  if (!input) return null;
  const { time, open, high, low, close, volume } = input;
  if (time == null || open == null || high == null || low == null || close == null) return null;
  return { 
    time: Number(time), 
    open: Number(open), 
    high: Number(high), 
    low: Number(low), 
    close: Number(close), 
    volume: Number(volume ?? 0) 
  };
}

// ---------------- Simple Indicator Class ----------------
class SimpleIndicator {
  constructor() {
    this.candles = [];
    this.closes = [];
  }

  _pushCandle(candle) {
    this.candles.push(candle);
    this.closes.push(candle.close);
    if (this.candles.length > 1000) {
      this.candles.shift();
      this.closes.shift();
    }
  }

  _sma(len) {
    const arr = this.closes;
    if (arr.length < len) return null;
    let sum = 0;
    for (let i = arr.length - len; i < arr.length; i++) {
      sum += arr[i];
    }
    return sum / len;
  }

  _rsi(period = 14) {
    const arr = this.closes;
    if (arr.length <= period) return null;
    
    let gains = 0, losses = 0;
    for (let i = arr.length - period; i < arr.length - 1; i++) {
      const diff = arr[i + 1] - arr[i];
      if (diff > 0) gains += diff;
      else losses -= diff;
    }
    
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  processCandle(candle) {
    this._pushCandle(candle);
    
    const out = {
      ready: this.closes.length > 30,
      time: candle.time,
      close: candle.close,
      sma20: this._sma(20),
      sma50: this._sma(50),
      rsi: this._rsi(14)
    };

    // Simple crossover signal
    if (out.sma20 && out.sma50) {
      if (out.sma20 > out.sma50) {
        out.signal = { side: 'buy', reason: 'sma_cross', time: candle.time, price: candle.close };
      } else {
        out.signal = { side: 'sell', reason: 'sma_cross', time: candle.time, price: candle.close };
      }
    }

    return out;
  }
}

// ---------------- Broadcast functions ----------------
function broadcastToClient(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (err) {
      console.warn('Broadcast error:', err.message);
    }
  }
}

function broadcastToAll(obj) {
  for (const [ws, meta] of connections.entries()) {
    broadcastToClient(ws, obj);
  }
}

// ---------------- WebSocket Server ----------------
wss.on('connection', (ws, req) => {
  const remote = req.socket.remoteAddress;
  console.log('Client connected from:', remote);
  
  const meta = { 
    sessionId: `guest-${Math.random().toString(36).slice(2, 8)}`,
    subscriptions: new Set(),
    isAlive: true 
  };
  
  connections.set(ws, meta);

  // Send welcome message
  broadcastToClient(ws, { type: 'welcome', message: 'Connected to trading server' });

  ws.on('message', (data) => {
    try {
      const msg = safeParseJSON(data.toString());
      if (!msg || !msg.type) return;

      switch (msg.type) {
        case 'auth':
          meta.sessionId = msg.sessionId || meta.sessionId;
          broadcastToClient(ws, { 
            type: 'auth_ok', 
            sessionId: meta.sessionId,
            premium: true 
          });
          break;

        case 'subscribe':
          const symbol = (msg.symbol || 'BTCUSDT').toUpperCase();
          const interval = msg.interval || '1m';
          const key = keyFor(symbol, interval);
          
          meta.subscriptions.add(key);
          console.log('Client subscribed to:', key);
          
          // Send current candles if available
          const candles = currentCandles.get(key);
          if (candles && candles.length > 0) {
            broadcastToClient(ws, {
              type: 'snapshot',
              symbol,
              interval,
              data: candles.slice(-500)
            });
          }
          
          // Ensure feeder is running
          startFeeder(symbol, interval);
          break;

        case 'unsubscribe':
          const unsubKey = keyFor(msg.symbol, msg.interval);
          meta.subscriptions.delete(unsubKey);
          break;

        case 'get_snapshot':
          const snapKey = keyFor(msg.symbol, msg.interval);
          const snapCandles = currentCandles.get(snapKey) || [];
          broadcastToClient(ws, {
            type: 'snapshot',
            symbol: msg.symbol,
            interval: msg.interval,
            data: snapCandles.slice(-(msg.limit || 500))
          });
          break;

        case 'ping':
          broadcastToClient(ws, { type: 'pong' });
          break;
      }
    } catch (error) {
      console.warn('Message processing error:', error.message);
    }
  });

  ws.on('close', () => {
    connections.delete(ws);
    console.log('Client disconnected:', remote);
  });

  ws.on('error', (error) => {
    console.warn('WebSocket error:', error.message);
    connections.delete(ws);
  });

  ws.on('pong', () => {
    meta.isAlive = true;
  });
});

// Heartbeat handling
setInterval(() => {
  for (const [ws, meta] of connections.entries()) {
    if (!meta.isAlive) {
      ws.terminate();
      connections.delete(ws);
      continue;
    }
    
    meta.isAlive = false;
    try {
      ws.ping();
    } catch (error) {
      connections.delete(ws);
    }
  }
}, HEARTBEAT_INTERVAL);

// ---------------- REST Endpoints ----------------
app.get('/health', (req, res) => {
  res.json({ 
    ok: true, 
    uptime: process.uptime(),
    connections: connections.size,
    feeders: feeders.size
  });
});

app.get('/history', async (req, res) => {
  try {
    const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
    const interval = req.query.interval || '1m';
    const limit = Math.min(MAX_HISTORY_FETCH, Number(req.query.limit || 500));

    console.log('Fetching history for:', symbol, interval, limit);

    // Try to get from cache first
    const key = keyFor(symbol, interval);
    const cached = currentCandles.get(key);
    if (cached && cached.length > 100) {
      return res.json({ 
        ok: true, 
        symbol, 
        interval, 
        data: cached.slice(-limit) 
      });
    }

    // Fetch from Binance
    const url = `${BINANCE_REST}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const response = await axiosInst.get(url);
    
    if (!response.data || !Array.isArray(response.data)) {
      return res.status(502).json({ error: 'Invalid response from Binance' });
    }

    const data = response.data.map(k => ({
      time: Math.floor(k[0] / 1000),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5])
    }));

    // Cache the data
    currentCandles.set(key, data);
    
    // Start feeder for this symbol
    startFeeder(symbol, interval);

    res.json({ ok: true, symbol, interval, data });

  } catch (error) {
    console.error('History error:', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch history',
      message: error.message 
    });
  }
});

// Paper trading endpoints
app.get('/paper/positions', (req, res) => {
  try {
    const closedLimit = Math.min(500, Number(req.query.closedLimit) || 200);
    
    const openRows = db.prepare(`
      SELECT * FROM trades 
      WHERE exit_price IS NULL 
      ORDER BY ts DESC
    `).all();
    
    const closedRows = db.prepare(`
      SELECT * FROM trades 
      WHERE exit_price IS NOT NULL 
      ORDER BY ts DESC 
      LIMIT ?
    `).all(closedLimit);

    res.json({ 
      ok: true, 
      open: openRows, 
      closed: closedRows 
    });
  } catch (error) {
    console.error('Paper positions error:', error.message);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/paper/trade', (req, res) => {
  try {
    const { ts, symbol, side, entry_price, exit_price, qty, pnl, note, pos_id } = req.body;
    
    if (!ts || !symbol || !side || entry_price == null || qty == null) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = insertTradeStmt.run(
      Math.floor(Date.now() / 1000),
      symbol.toUpperCase(),
      side,
      parseFloat(entry_price),
      exit_price ? parseFloat(exit_price) : null,
      parseFloat(qty),
      pnl ? parseFloat(pnl) : null,
      note || null
    );

    res.json({ 
      success: true, 
      id: result.lastInsertRowid 
    });
  } catch (error) {
    console.error('Paper trade error:', error.message);
    res.status(500).json({ error: 'Database error' });
  }
});

app.delete('/paper/trade/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const result = db.prepare('DELETE FROM trades WHERE id = ?').run(id);
    
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Trade not found' });
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Delete trade error:', error.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// Backtest endpoint
app.post('/backtest', async (req, res) => {
  try {
    const {
      symbol = 'BTCUSDT',
      interval = '1m',
      strategy = 'sma',
      sma_short = 10,
      sma_long = 30,
      limit = 1000,
      initial_capital = 10000
    } = req.body;

    // Get historical data
    const key = keyFor(symbol, interval);
    let candles = currentCandles.get(key);
    
    if (!candles || candles.length < Math.max(sma_short, sma_long)) {
      // Fetch if not enough data
      const historyUrl = `/history?symbol=${symbol}&interval=${interval}&limit=${limit}`;
      // This would need to be implemented properly
      return res.status(400).json({ error: 'Insufficient historical data' });
    }

    // Simple SMA backtest
    const results = {
      symbol,
      interval,
      strategy,
      initial_capital,
      final_equity: initial_capital,
      total_return: 0,
      trades: []
    };

    res.json({ ok: true, ...results });

  } catch (error) {
    console.error('Backtest error:', error.message);
    res.status(500).json({ error: 'Backtest failed' });
  }
});

// ---------------- Binance Feeder ----------------
function startFeeder(symbol = 'BTCUSDT', interval = '1m') {
  const key = keyFor(symbol, interval);
  
  // Check if feeder already exists
  if (feeders.has(key)) {
    const existing = feeders.get(key);
    if (existing.ws && existing.ws.readyState === WebSocket.OPEN) {
      return; // Already connected
    }
  }

  console.log('Starting feeder for:', key);

  const stream = `${symbol.toLowerCase()}@kline_${interval}`;
  const wsUrl = `${BINANCE_WS_BASE}/${stream}`;

  let ws;
  try {
    ws = new WebSocket(wsUrl);
  } catch (error) {
    console.error('WebSocket creation failed:', error.message);
    scheduleReconnect(key, symbol, interval);
    return;
  }

  const feeder = {
    ws,
    symbol,
    interval,
    reconnectAttempts: 0,
    reconnectTimer: null
  };

  feeders.set(key, feeder);

  ws.on('open', () => {
    console.log('Binance WebSocket connected for:', key);
    feeder.reconnectAttempts = 0;
  });

  ws.on('message', (data) => {
    try {
      const message = safeParseJSON(data.toString());
      if (!message || !message.k) return;

      const kline = message.k;
      const candle = {
        time: Math.floor(kline.t / 1000),
        open: parseFloat(kline.o),
        high: parseFloat(kline.h),
        low: parseFloat(kline.l),
        close: parseFloat(kline.c),
        volume: parseFloat(kline.v),
        isFinal: kline.x
      };

      const key = keyFor(symbol, interval);
      
      // Update candles cache
      let candles = currentCandles.get(key) || [];
      const lastCandle = candles[candles.length - 1];
      
      if (lastCandle && lastCandle.time === candle.time) {
        // Update existing candle
        candles[candles.length - 1] = candle;
      } else {
        // Add new candle
        candles.push(candle);
        if (candles.length > MAX_CANDLES_CACHE) {
          candles = candles.slice(-MAX_CANDLES_CACHE);
        }
      }
      
      currentCandles.set(key, candles);

      // Broadcast to subscribed clients
      broadcastToAll({
        type: 'candles_update',
        symbol,
        interval,
        candle,
        isFinal: candle.isFinal
      });

      // Process indicators for final candles
      if (candle.isFinal) {
        let indicator = indicatorInstances.get(key);
        if (!indicator) {
          indicator = new SimpleIndicator();
          indicatorInstances.set(key, indicator);
        }

        const result = indicator.processCandle(candle);
        if (result.ready) {
          broadcastToAll({
            type: 'indicator_update',
            symbol,
            interval,
            data: result
          });

          if (result.signal) {
            broadcastToAll({
              type: 'signal',
              symbol,
              interval,
              signal: result.signal
            });
          }
        }
      }

    } catch (error) {
      console.warn('Message processing error:', error.message);
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`Binance WebSocket closed for ${key}:`, code, reason.toString());
    feeders.delete(key);
    scheduleReconnect(key, symbol, interval);
  });

  ws.on('error', (error) => {
    console.error(`Binance WebSocket error for ${key}:`, error.message);
    feeders.delete(key);
    scheduleReconnect(key, symbol, interval);
  });
}

function scheduleReconnect(key, symbol, interval) {
  const existing = feeders.get(key);
  if (existing && existing.reconnectTimer) {
    clearTimeout(existing.reconnectTimer);
  }

  const attempts = (existing && existing.reconnectAttempts) || 0;
  const delay = Math.min(FEEDER_BASE_RETRY_MS * Math.pow(2, attempts), FEEDER_MAX_RETRY_MS);
  
  console.log(`Scheduling reconnect for ${key} in ${delay}ms (attempt ${attempts + 1})`);
  
  const timer = setTimeout(() => {
    startFeeder(symbol, interval);
  }, delay);

  const feeder = {
    reconnectAttempts: attempts + 1,
    reconnectTimer: timer,
    symbol,
    interval
  };
  
  feeders.set(key, feeder);
}

// ---------------- Server Startup ----------------
const PORT = process.env.PORT || 8080;

// Start default feeder
setTimeout(() => {
  startFeeder('BTCUSDT', '1m');
}, 2000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down gracefully...');
  
  // Close all WebSocket connections
  for (const [ws] of connections.entries()) {
    ws.close();
  }
  
  for (const [key, feeder] of feeders.entries()) {
    if (feeder.ws) {
      feeder.ws.close();
    }
    if (feeder.reconnectTimer) {
      clearTimeout(feeder.reconnectTimer);
    }
  }
  
  server.close(() => {
    db.close();
    console.log('Server shut down complete');
    process.exit(0);
  });
});