#!/usr/bin/env node
/**
 * test_backtest.js — improved / optimized
 *
 * Usage:
 *   node test_backtest.js --symbol=BTCUSDT --interval=1m --strategy=sma --limit=1000 --out=bt_res.json --timeout=30000 --retries=2
 *
 * Requirements: Node.js 18+ (global fetch + AbortController)
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  url: process.env.BACKTEST_URL || 'http://localhost:8080/backtest',
  symbol: 'BTCUSDT',
  interval: '1m',
  strategy: 'sma',
  sma_short: 10,
  sma_long: 30,
  limit: 1000,
  initial_capital: 10000,
  size_pct: 0.1,
  slippage_bps: 5,
  commission_pct: 0.0005,
  persistTrades: false,
  timeout: 30_000, // ms
  retries: 2,
  out: null
};

// -- improved arg parsing (supports --flag, --flag=val, --flag val, short -o val) --
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    let a = argv[i];
    if (!a) continue;
    if (a === '--') { // rest are positional
      out._ = out._.concat(argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const kv = a.slice(2).split('=');
      const k = kv[0];
      if (kv.length > 1) {
        out[k] = kv.slice(1).join('=');
      } else {
        // peek next token: if it exists and doesn't start with -, consume as value
        const next = argv[i + 1];
        if (typeof next !== 'undefined' && !String(next).startsWith('-')) {
          out[k] = next;
          i++;
        } else {
          out[k] = true;
        }
      }
    } else if (a.startsWith('-') && a.length > 1) {
      // short flags: -o value or -f (flag)
      const k = a[1];
      if (a.length > 2) {
        // bundled or -oVALUE: take rest as value
        out[k] = a.slice(2);
      } else {
        const next = argv[i + 1];
        if (typeof next !== 'undefined' && !String(next).startsWith('-')) {
          out[k] = next;
          i++;
        } else {
          out[k] = true;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function usageAndExit(code = 0) {
  console.log(`Usage:
  node test_backtest.js [--url=http://host/backtest] [--symbol=BTCUSDT] [--interval=1m] [--strategy=sma]
                       [--limit=1000] [--out=path.json] [--timeout=30000] [--retries=2] [--persistTrades]

Short flags: -o (out), -s (symbol)

Environment:
  BACKTEST_URL  Override default backtest endpoint (default http://localhost:8080/backtest)
`);
  process.exit(code);
}

function coerceNumber(v, fallback) {
  if (v === true) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function atomicWriteFile(filePath, content) {
  const tmp = filePath + '.tmp-' + Math.random().toString(36).slice(2, 8);
  await fs.promises.writeFile(tmp, content, 'utf8');
  await fs.promises.rename(tmp, filePath);
}

async function run() {
  const args = parseArgs(process.argv);
  if (args.help || args.h) return usageAndExit(0);

  // map some common short flags
  const outFlag = args.out || args.o || args['-o'];
  const symbolArg = args.symbol || args.s || args['-s'];

  const payload = {
    symbol: (symbolArg || DEFAULTS.symbol).toString().toUpperCase(),
    interval: (args.interval || DEFAULTS.interval),
    strategy: (args.strategy || DEFAULTS.strategy),
    sma_short: coerceNumber(args.sma_short ?? args.ss, DEFAULTS.sma_short),
    sma_long: coerceNumber(args.sma_long ?? args.sl, DEFAULTS.sma_long),
    limit: Math.min(5000, coerceNumber(args.limit ?? DEFAULTS.limit, DEFAULTS.limit)),
    initial_capital: coerceNumber(args.initial_capital ?? args.capital ?? DEFAULTS.initial_capital, DEFAULTS.initial_capital),
    size_pct: coerceNumber(args.size_pct ?? DEFAULTS.size_pct, DEFAULTS.size_pct),
    slippage_bps: coerceNumber(args.slippage_bps ?? DEFAULTS.slippage_bps, DEFAULTS.slippage_bps),
    commission_pct: coerceNumber(args.commission_pct ?? DEFAULTS.commission_pct, DEFAULTS.commission_pct),
    persistTrades: (typeof args.persistTrades !== 'undefined' ? !!args.persistTrades : DEFAULTS.persistTrades)
  };

  const timeoutMs = coerceNumber(args.timeout ?? DEFAULTS.timeout, DEFAULTS.timeout);
  const retries = Math.max(0, Math.floor(coerceNumber(args.retries ?? DEFAULTS.retries, DEFAULTS.retries)));
  const maxAttempts = retries + 1; // attempt count = initial try + retries
  const outFile = outFlag || DEFAULTS.out || `backtest_${payload.symbol}_${Date.now()}.json`;
  const url = args.url || DEFAULTS.url;

  // basic validation
  if (!/^[A-Z0-9]{3,12}$/.test(payload.symbol)) {
    console.error('Invalid symbol:', payload.symbol);
    return process.exit(2);
  }
  if (!payload.interval) {
    console.error('Interval required');
    return process.exit(2);
  }

  console.log('Backtest request →', { url, payload, timeoutMs, retries, outFile });

  let attempt = 0;
  let lastErr = null;

  while (attempt < maxAttempts) {
    attempt++;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    let res = null;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timeoutHandle);

      if (!res.ok) {
        // try to read body for helpful debug info (but cap length)
        let bodyPreview = '';
        try {
          const txt = await res.text();
          bodyPreview = txt.slice(0, 200);
        } catch (e) {
          bodyPreview = `<non-text response: ${e && e.message}>`;
        }
        throw new Error(`HTTP ${res.status} — ${bodyPreview}`);
      }

      const ct = (res.headers.get && (res.headers.get('content-type') || '')).toLowerCase ? (res.headers.get('content-type') || '').toLowerCase() : '';
      let data;
      if (ct.includes('application/json') || ct.includes('+json')) {
        data = await res.json();
      } else {
        // not JSON
        const txt = await res.text();
        throw new Error(`Expected JSON response but got content-type="${ct}". First bytes: ${txt.slice(0, 300)}`);
      }

      if (!data || typeof data !== 'object') throw new Error('Empty/invalid JSON payload received');

      console.log(`\n✅ Backtest completed (HTTP ${res.status})`);
      console.log('Metrics:', data.metrics ?? 'none');
      console.log('Trades:', Array.isArray(data.trades) ? `${data.trades.length} trades (showing first 8)` : 'none');
      if (Array.isArray(data.trades)) console.log(JSON.stringify(data.trades.slice(0, 8), null, 2));
      if (Array.isArray(data.equity)) console.log('Equity points (first 8):', data.equity.slice(0, 8));

      // write result atomically
      const text = JSON.stringify(data, null, 2);
      const resolved = path.resolve(outFile);
      await atomicWriteFile(resolved, text);
      console.log(`Saved full result to: ${resolved}`);
      return; // success
    } catch (err) {
      clearTimeout(timeoutHandle);
      lastErr = err;
      if (err && err.name === 'AbortError') {
        console.error(`Attempt ${attempt}/${maxAttempts} timed out after ${timeoutMs}ms (URL: ${url})`);
      } else {
        console.error(`Attempt ${attempt}/${maxAttempts} failed (URL: ${url}):`, err && err.message ? err.message : err);
      }
      if (attempt >= maxAttempts) break;
      const delay = Math.round(500 * Math.pow(2, attempt - 1) + Math.random() * 200);
      console.log(`Retrying in ${delay}ms (attempt ${attempt + 1}/${maxAttempts})...`);
      await sleep(delay);
    }
  }

  console.error('Backtest failed after retries. Last error:\n', lastErr && (lastErr.stack || lastErr.message || lastErr));
  process.exitCode = 3;
}

run().catch(err => {
  console.error('Fatal error:', err && (err.stack || err.message || err));
  process.exit(1);
});
