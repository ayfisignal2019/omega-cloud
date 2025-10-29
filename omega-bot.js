/**
 * omega-bot.js
 * Node.js version of Omega V∞ CLOUD — preserves original HTML logic & behaviors.
 *
 * Usage:
 * 1) create config.js next to this file (see sample above)
 * 2) npm install node-fetch@2 nodemailer
 * 3) node omega-bot.js
 *
 * Recommend running with pm2 or deploying to Render/Railway for 24/7 uptime.
 */

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch'); // v2 (require style)
const AbortController = require('abort-controller');
const nodemailer = require('nodemailer');

const { TG_TOKEN, TG_CHAT, GMAIL_USER, GMAIL_PASS } = require('./config');

// ---------------- logger ----------------
function timeNow() {
  return new Date().toISOString();
}
function log(msg, type = 'info') {
  const prefix = `[${timeNow()}]`;
  if (type === 'buy') console.log(`${prefix} [BUY] ${msg}`);
  else if (type === 'sell') console.log(`${prefix} [SELL] ${msg}`);
  else if (type === 'warn') console.warn(`${prefix} [WARN] ${msg}`);
  else console.log(`${prefix} ${msg}`);
}

// ---------------- config & state ----------------
const EXCHANGES = ['kucoin','gateio','mexc','coinex','bitget','okx','bybit','kraken','htx'];

const EXCHANGE_URLS = {
  kucoin: sym => `https://api.kucoin.com/api/v1/market/candles?type=1hour&symbol=${sym.replace('/', '-')}`,
  gateio: sym => `https://api.gate.io/api2/1/marketinfo/candlesticks?pair=${sym.replace('/', '_')}&interval=3600`,
  mexc: sym => `https://api.mexc.com/api/v3/klines?symbol=${sym.replace('/', '')}&interval=1h&limit=50`,
  coinex: sym => `https://api.coinex.com/v1/market/kline?market=${sym.replace('/', '').toLowerCase()}&type=1h&limit=50`,
  bitget: sym => `https://api.bitget.com/api/v2/spot/market/candles?symbol=${sym.replace('/', '')}&period=1h&limit=50`,
  okx: sym => `https://www.okx.com/api/v5/market/candles?instId=${sym.replace('/', '-')}&bar=1H&limit=50`,
  bybit: sym => `https://api.bybit.com/v5/market/kline?category=spot&symbol=${sym.replace('/', '')}&interval=60&limit=50`,
  kraken: sym => `https://api.kraken.com/0/public/OHLC?pair=${sym.replace('USDT','USD').replace('BTC','XBT')}&interval=60`,
  htx: sym => `https://api.htx.com/market/history/kline?symbol=${sym.replace('/', '').toLowerCase()}&period=60min&size=50`
};

const TICKER_URLS = {
  kucoin: "https://api.kucoin.com/api/v1/market/allTickers",
  gateio: "https://api.gate.io/api2/1/tickers",
  mexc: "https://api.mexc.com/api/v3/ticker/24hr",
  coinex: "https://api.coinex.com/v1/market/ticker/all",
  bitget: "https://api.bitget.com/api/v2/spot/market/tickers?type=spot",
  okx: "https://www.okx.com/api/v5/market/tickers?instType=SPOT",
  bybit: "https://api.bybit.com/v5/market/tickers?category=spot",
  kraken: "https://api.kraken.com/0/public/Ticker",
  htx: "https://api.htx.com/market/tickers"
};

const miniCache = {};
const simState = {};
const MAX_SIM_CONSECUTIVE = 1;
const MAX_SIM_PER_HOUR = 2;
const sentSignals = {};

// ---------------- helpers ----------------
function ensureSimState(sym) {
  if (!simState[sym]) simState[sym] = { consecutive: 0, hourly: { count: 0, windowStart: Date.now() }, lastReal: null, cachedUses: 0 };
  const now = Date.now();
  if (now - simState[sym].hourly.windowStart > 3600000) {
    simState[sym].hourly.count = 0;
    simState[sym].hourly.windowStart = now;
  }
}

function timeoutFetch(url, t = 10000) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const id = setTimeout(() => {
      controller.abort();
    }, t);
    fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'OmegaBot/1.0' } })
      .then(r => { clearTimeout(id); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(resolve)
      .catch(err => { clearTimeout(id); reject(err); });
  });
}

const delay = ms => new Promise(r => setTimeout(r, ms));

// ---------------- simulate klines ----------------
function simulateKlines(sym, len = 50) {
  const state = simState[sym];
  if (!state.lastReal || state.lastReal.length < 5) {
    const base = 0.001 + Math.random() * 100;
    return Array.from({ length: len }, (_, i) => [
      Date.now() - (len - i) * 3600000,
      base + i * 0.0001, base + i * 0.0002, base + i * 0.00005, base + i * 0.00015,
      100000 + Math.random() * 100000
    ]);
  }
  const last = parseFloat(state.lastReal.slice(-1)[0][4]);
  const last5 = state.lastReal.slice(-5);
  const trend = last5.reduce((a, b) => a + (parseFloat(b[4]) - parseFloat(b[1])), 0) / last5.length;
  const vol = last5.reduce((a, b) => a + parseFloat(b[5]||0), 0) / last5.length;
  return Array.from({ length: len }, (_, i) => {
    const p = last + (i - len + 1) * trend * 0.02 + (Math.random() - 0.5) * last * 0.001;
    return [
      Date.now() - (len - i) * 3600000,
      p * (1 + (Math.random() - 0.5) * 0.002),
      p * (1 + (Math.random() - 0.5) * 0.003),
      p * (1 + (Math.random() - 0.5) * 0.002),
      p,
      vol * (0.8 + Math.random() * 0.4)
    ];
  });
}

// ---------------- parse klines ----------------
function parseKlines(data, ex) {
  if (!data) return null;
  let raw = data;
  if (ex === 'kraken' && data.result) {
    const pair = Object.keys(data.result).find(p => p.includes('USDT') || p.includes('USD'));
    raw = pair ? data.result[pair] : [];
  } else if (ex === 'htx' && data.data) raw = data.data;
  else if (data.data) raw = data.data;
  else if (data.result) raw = data.result;
  else if (data.ticker) raw = data.ticker;

  const map = {
    kucoin: d => [d[0]*1000, d[1], d[3], d[4], d[2], d[5]],
    gateio: d => [d[0]*1000, d[5], d[2], d[3], d[1], d[6]],
    mexc: d => [d[0], d[1], d[2], d[3], d[4], d[5]],
    coinex: d => [d[0]*1000, d[1], d[2], d[3], d[4], d[5]],
    bitget: d => [d[0], d[1], d[2], d[3], d[4], d[5]],
    okx: d => [d[0], d[1], d[2], d[3], d[4], d[5]],
    bybit: d => [d[0], d[1], d[2], d[3], d[4], d[5]],
    kraken: d => [d[0]*1000, d[1], d[4], d[3], d[2], d[6]],
    htx: d => [d[0]*1000, d[1], d[2], d[3], d[4], d[5]]
  };

  try {
    const sliced = raw.slice(-50);
    return sliced.map(d => map[ex](d)).filter(k => parseFloat(k[4]) > 0);
  } catch (e) {
    return null;
  }
}

// ---------------- fetchSymbolData ----------------
async function fetchSymbolData(sym) {
  const results = await Promise.allSettled(
    EXCHANGES.map(async ex => {
      await delay(Math.random() * 800);
      try {
        const data = await timeoutFetch(EXCHANGE_URLS[ex](sym), 10000);
        const klines = parseKlines(data, ex);
        if (klines && klines.length >= 20) return klines;
      } catch (e) { /* ignore per original logic */ }
      return null;
    })
  );

  const valid = results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
  if (valid.length > 0) {
    miniCache[sym] = valid[0];
    if (simState[sym]) simState[sym].consecutive = 0;
    ensureSimState(sym);
    simState[sym].lastReal = valid[0];
    return valid[0];
  }

  ensureSimState(sym);
  const state = simState[sym];
  if (miniCache[sym] && state.cachedUses < 3) {
    state.cachedUses = (state.cachedUses || 0) + 1;
    return miniCache[sym];
  }

  if (state.consecutive < MAX_SIM_CONSECUTIVE && state.hourly.count < MAX_SIM_PER_HOUR) {
    state.consecutive++;
    state.hourly.count++;
    log(`شبیه‌سازی هوشمند برای ${sym}`, 'warn');
    return simulateKlines(sym, 50);
  }
  return null;
}

// ---------------- RSI ----------------
function calcRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    gains += Math.max(diff, 0);
    losses += Math.max(-diff, 0);
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  return avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
}

// ---------------- sendAlert (Telegram + Gmail) ----------------
async function sendTelegram(msg) {
  if (!TG_TOKEN || !TG_CHAT) return;
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage?chat_id=${TG_CHAT}&text=${encodeURIComponent(msg)}&parse_mode=HTML`;
  try {
    await timeoutFetch(url, 8000);
    log('ارسال به تلگرام انجام شد', 'buy');
  } catch (e) {
    log('خطا در ارسال تلگرام: ' + (e.message || e), 'warn');
  }
}

let mailTransporter = null;
function ensureMailer() {
  if (mailTransporter) return mailTransporter;
  mailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: GMAIL_USER,
      pass: GMAIL_PASS
    }
  });
  return mailTransporter;
}

async function sendEmail(subject, htmlBody) {
  if (!GMAIL_USER || !GMAIL_PASS) return;
  try {
    const transporter = ensureMailer();
    await transporter.sendMail({
      from: GMAIL_USER,
      to: GMAIL_USER,
      subject,
      html: htmlBody
    });
    log('ایمیل ارسال شد', 'buy');
  } catch (e) {
    log('خطا در ارسال ایمیل: ' + (e.message || e), 'warn');
  }
}

async function sendAlert(msg) {
  await Promise.all([
    sendTelegram(msg),
    sendEmail('Omega Alert', msg.replace(/\n/g, '<br>'))
  ]);
}

// ---------------- analyze ----------------
async function analyze(sym) {
  const klines = await fetchSymbolData(sym);
  if (!klines || klines.length < 20) return false;

  const closes = klines.map(k => parseFloat(k[4]));
  const price = closes[closes.length - 1];
  const sma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const rsi = calcRSI(closes);
  const volatility = Math.abs(closes[closes.length - 1] - closes[closes.length - 5]) / closes[closes.length - 5];
  const pred = 0.5 + (rsi / 100) * 0.35 + (price / sma20) * 0.3 + volatility * 0.2;

  const usedFallback = !miniCache[sym] || simState[sym]?.consecutive > 0;

  if (pred > 0.72) {
    const dir = pred > 0.78 ? 'BUY' : 'SELL';
    const atr = price * 0.0055;
    const capital = 1000;
    const leverage = pred > 0.85 ? 10 : 5;
    const key = sym + new Date().toISOString().slice(0, 10);
    if (sentSignals[key]) return false;
    sentSignals[key] = true;

    let msg = `<b>سیگنال ${dir}</b>\n<code>${sym}</code>\nورود: <b>${price.toFixed(6)}</b>\nSL: <b>${(dir === 'BUY' ? price - atr : price + atr).toFixed(6)}</b>\nTP1: <b>${(dir === 'BUY' ? price + atr * 1.6 : price - atr * 1.6).toFixed(6)}</b>\nTP2: <b>${(dir === 'BUY' ? price + atr * 3.2 : price - atr * 3.2).toFixed(6)}</b>\nسرمایه: <b>$${capital}</b>\nلوریج: <b>${leverage}x</b>\nاعتماد: <b>${(pred * 100).toFixed(1)}%</b>`;
    if (pred > 0.85) msg += "\n\nسیگنال بسیار معتبر — اقدام فوری!";
    if (usedFallback) msg += "\n\nداده از شبیه‌سازی (با دقت)";
    log(msg.replace(/\n/g, ' | '), dir.toLowerCase());
    await sendAlert(msg);
    return true;
  }
  return false;
}

// ---------------- getTopSymbols ----------------
async function getTopSymbols(n = 25) {
  const scores = {};
  await Promise.all(EXCHANGES.map(async ex => {
    await delay(Math.random() * 1000);
    try {
      const data = await timeoutFetch(TICKER_URLS[ex], 8000);
      let items = [];
      if (ex === 'kraken' && data.result) {
        items = Object.entries(data.result).map(([pair, v]) => ({
          symbol: pair.replace('XBT','BTC').replace('USD','USDT'),
          lastPrice: v.c[0],
          quoteVolume: v.v[1],
          priceChangePercent: ((v.c[0] - v.o[0]) / v.o[0] * 100).toString()
        }));
      } else if (ex === 'htx' && data.data) {
        items = data.data;
      } else if (data.data) items = data.data;
      else if (data.ticker) items = data.ticker;
      else if (data.result) items = data.result;

      for (const i of items) {
        let sym = (i.symbol || i.instId || i.s || '').replace(/[-_]/g, '/');
        if (!sym.includes('/USDT')) continue;
        const vol = parseFloat(i.quoteVolume || i.vol || i.q || i.v || i.turnover24h || 0) || 0;
        const price = parseFloat(i.lastPrice || i.last || i.c || i.close || 0) || 0;
        const change = Math.abs(parseFloat(i.priceChangePercent || i.P || i.price24hPcnt || 0)) || 0;
        if (vol * price > 200000) {
          scores[sym] = vol * price * (1 + change / 100);
        }
      }
    } catch (e) { /* ignore */ }
  }));
  return Object.keys(scores).sort((a, b) => scores[b] - scores[a]).slice(0, n);
}

// ---------------- main cycle ----------------
async function runCycle() {
  try {
    log('شروع اسکن ۹ صرافی...', 'buy');
    const syms = await getTopSymbols(25);
    let count = 0;
    for (const sym of syms) {
      try {
        if (await analyze(sym)) count++;
      } catch (e) {
        log('خطا در آنالیز ' + sym + ' : ' + (e.message || e), 'warn');
      }
      await delay(300);
    }
    log(count ? `${count} سیگنال ارسال شد` : 'بدون سیگنال قوی', count ? 'buy' : 'sell');
  } catch (e) {
    log('خطا در چرخه: ' + (e.message || e), 'warn');
  }
}

// ---------------- scheduler ----------------
// run immediately, then every 150s
runCycle();
setInterval(runCycle, 150000);

// optionally maintain smaller interval trigger similar to the worker in browser
setInterval(() => {
  // this ensures periodic run even if earlier runs failed
  runCycle();
}, 150000);

log('Omega V∞ CLOUD (Node) با موفقیت فعال شد!', 'buy');
