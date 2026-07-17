const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'dashboard-data.json');
const IMAGES_DIR = path.join(__dirname, 'data', 'images');

// Ensure data directories exist
if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'));
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR);

// Initialize data file with empty state if it doesn't exist
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({
    trades: [],
    goals: [],
    nextGoalId: 1,
    masterMistakes: [],
    newsList: [],
    watchlists: { daily: [], weekly: [] },
    pbStore: {},
    categories: null,
    psychologyHistory: [],
    studyEntries: []
  }, null, 2));
}

// Multer for image uploads (stored as actual files, not base64)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, IMAGES_DIR),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e6);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB max

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));
app.use('/data/images', express.static(IMAGES_DIR));

// ── SUPABASE CLOUD SYNC (optional) ────────────────────────────
// Reads credentials from supabase-config.json if present. If absent or blank,
// the app runs in local-only mode exactly as before.
let SUPA = null;
const SUPA_BUCKET = 'dashboard';
const SUPA_OBJECT = 'dashboard-data.json';
const SUPA_CONFIG = path.join(__dirname, 'supabase-config.json');
try {
  if (fs.existsSync(SUPA_CONFIG)) {
    const c = JSON.parse(fs.readFileSync(SUPA_CONFIG, 'utf8').replace(/^﻿/, ''));
    // Set "enabled": false in supabase-config.json to run LOCAL-ONLY (single computer).
    // Set it back to true (or remove it) to re-enable cloud sync for multiple computers.
    if (c.url && c.key && c.enabled !== false) {
      SUPA = { url: c.url.replace(/\/$/, ''), key: c.key };
      console.log('☁️  Supabase cloud sync ENABLED');
    } else {
      console.log('💾 Local-only mode (cloud sync OFF) — data saves to data/dashboard-data.json');
    }
  }
} catch (e) { console.warn('Supabase config error:', e.message); SUPA = null; }

// Make sure the private storage bucket exists (service_role key can create it)
async function supaEnsureBucket() {
  try {
    const r = await fetch(`${SUPA.url}/storage/v1/bucket`, {
      method: 'POST',
      headers: { apikey: SUPA.key, Authorization: 'Bearer ' + SUPA.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: SUPA_BUCKET, name: SUPA_BUCKET, public: false })
    });
    if (r.ok) console.log('☁️  Created cloud storage bucket "' + SUPA_BUCKET + '"');
    // 400/409 = already exists — that's fine
  } catch (e) { console.warn('Bucket ensure failed:', e.message); }
}

async function supaLoad() {
  const r = await fetch(`${SUPA.url}/storage/v1/object/${SUPA_BUCKET}/${SUPA_OBJECT}`, {
    headers: { apikey: SUPA.key, Authorization: 'Bearer ' + SUPA.key }
  });
  if (r.status === 404 || r.status === 400) return null; // nothing uploaded yet
  if (!r.ok) throw new Error('Supabase load HTTP ' + r.status);
  return await r.json();
}
async function supaSave(data) {
  const r = await fetch(`${SUPA.url}/storage/v1/object/${SUPA_BUCKET}/${SUPA_OBJECT}`, {
    method: 'POST',
    headers: {
      apikey: SUPA.key,
      Authorization: 'Bearer ' + SUPA.key,
      'Content-Type': 'application/json',
      'x-upsert': 'true'
    },
    body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error('Supabase save HTTP ' + r.status + ' ' + (await r.text()));
}

// Coalesce rapid saves into one cloud push (saves bandwidth on the free tier)
let _cloudTimer = null, _cloudPending = null;
function scheduleCloudSave(data) {
  _cloudPending = data;
  clearTimeout(_cloudTimer);
  _cloudTimer = setTimeout(() => {
    const d = _cloudPending; _cloudPending = null;
    supaSave(d).catch(e => console.warn('Cloud save failed (saved locally):', e.message));
  }, 5000);
}

// ── DATA API ──────────────────────────────────────────────────

function readData() {
  // Strip BOM if present (PowerShell sometimes writes UTF-8 BOM)
  const raw = fs.readFileSync(DATA_FILE, 'utf8').replace(/^﻿/, '');
  return JSON.parse(raw);
}
function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Load all data — from Supabase if enabled (falls back to local file), else local file
app.get('/api/data', async (req, res) => {
  if (SUPA) {
    try {
      const cloud = await supaLoad();
      if (cloud) { writeData(cloud); return res.json(cloud); } // cache cloud copy locally
    } catch (e) { console.warn('Cloud load failed, using local copy:', e.message); }
  }
  res.json(readData());
});

// Save all data (bulk save) — local file immediately, cloud push coalesced
const _count = d => (d ? ((d.trades||[]).length + (d.todTrades||[]).length) : 0);

// ── AUTOMATIC ROLLING BACKUPS ─────────────────────────────────
// Timestamped local backups had stopped in June, leaving no recovery history.
// These are written automatically (throttled) and pruned to the most recent N,
// so there is always a trail to restore from. Auto-backups use a distinct prefix
// so pruning never touches manually-named backups (SAFE_, RESTORED_, etc.).
const ROLLING_PREFIX = 'dashboard-data_auto_';
const ROLLING_KEEP = 40;                        // keep the most recent N auto-backups
const ROLLING_THROTTLE_MS = 30 * 60 * 1000;     // at most one every 30 minutes
const SHRINK_THRESHOLD = 3;                      // a bigger single-save drop gets its own snapshot
let _lastRollingBackup = 0;
const _pad2 = n => String(n).padStart(2, '0');
function _stamp() {
  const d = new Date();
  return d.getFullYear() + _pad2(d.getMonth()+1) + _pad2(d.getDate()) + '_' +
         _pad2(d.getHours()) + _pad2(d.getMinutes()) + _pad2(d.getSeconds());
}
function writeRollingBackup(data, bdir) {
  try {
    const now = Date.now();
    if (now - _lastRollingBackup < ROLLING_THROTTLE_MS) return;
    _lastRollingBackup = now;
    fs.writeFileSync(path.join(bdir, ROLLING_PREFIX + _stamp() + '.json'), JSON.stringify(data));
    const files = fs.readdirSync(bdir).filter(f => f.startsWith(ROLLING_PREFIX)).sort();
    if (files.length > ROLLING_KEEP) {
      files.slice(0, files.length - ROLLING_KEEP).forEach(f => { try { fs.unlinkSync(path.join(bdir, f)); } catch(_){} });
    }
  } catch (e) { /* backups are best-effort; never block a save on them */ }
}

app.post('/api/data', async (req, res) => {
  const current = readData();
  const updated = { ...current, ...req.body };

  // ── SAFETY GUARD ──────────────────────────────────────────────
  // Refuse a save that would wipe existing trades down to nothing.
  // This is the exact failure that lost data before: a blank page
  // posting an empty state over a populated file (and the cloud).
  if (_count(current) > 0 && _count(updated) === 0) {
    console.warn('⛔ Blocked empty-overwrite save (current had ' + _count(current) + ' trades, incoming had 0). Data preserved.');
    return res.json({ ok: false, blocked: 'empty-overwrite' });
  }

  const bdir = path.join(__dirname, 'backups');
  try { if (!fs.existsSync(bdir)) fs.mkdirSync(bdir); } catch (e) { /* ignore */ }

  // Keep a one-step "last good" backup of the previous non-empty state before overwriting.
  try {
    if (_count(current) > 0) {
      fs.writeFileSync(path.join(bdir, 'dashboard-data.lastgood.json'), JSON.stringify(current));
    }
  } catch (e) { /* backup is best-effort; never block a save on it */ }

  // A big single-save drop in trade count is unusual (a stale copy overwriting a fuller one).
  // Deletes are still allowed, but snapshot the prior state first so it is always recoverable.
  if (_count(current) - _count(updated) > SHRINK_THRESHOLD) {
    try { fs.writeFileSync(path.join(bdir, 'dashboard-data_preshrink_' + _stamp() + '.json'), JSON.stringify(current)); } catch (e) { /* ignore */ }
    console.warn('⚠️  Large trade-count drop on save (' + _count(current) + ' → ' + _count(updated) + ' trades). Prior state snapshotted (preshrink backup).');
  }

  // Automatic rolling history (throttled + pruned).
  if (_count(updated) > 0) writeRollingBackup(updated, bdir);

  writeData(updated);
  if (SUPA) scheduleCloudSave(updated);
  res.json({ ok: true });
});

// ── STOCK SCREENER QUOTE (Yahoo Finance proxy) ────────────────
// Returns { symbol, price, avgVol, curVol, prevClose, volSeries } for the screener.
// The data source is isolated here so it can be swapped for a paid API later
// (Finnhub/Polygon) without touching the frontend.
const TF_MAP = {
  '1m':  { interval: '1m',  range: '5d' },
  '5m':  { interval: '5m',  range: '1mo' },
  '15m': { interval: '15m', range: '1mo' },
  '30m': { interval: '30m', range: '1mo' },
  '60m': { interval: '60m', range: '3mo' },
  '2h':  { interval: '60m', range: '6mo', group: 2 },   // Yahoo has no native 2h — resample 60m
  '4h':  { interval: '60m', range: '1y',  group: 4 },   // ...and 4h from 60m
  '1d':  { interval: '1d',  range: '3mo' }
};
// Resample close/volume arrays into buckets of `g` consecutive bars (close=last, volume=sum)
function _resampleCV(closes, vols, g) {
  const oc = [], ov = [];
  for (let i = 0; i < closes.length; i += g) {
    let vol = 0, last = null, any = false;
    for (let j = i; j < Math.min(i + g, closes.length); j++) { if (vols[j] != null) vol += vols[j]; if (closes[j] != null) { last = closes[j]; any = true; } }
    if (any) { oc.push(last); ov.push(vol); }
  }
  return { closes: oc, vols: ov };
}
// ── Market Cap via Yahoo's authenticated quote (cookie + crumb) ──
// Unofficial/free; degrades to null (shows "—") if Yahoo blocks it. Swap for a
// keyed provider (Finnhub /stock/profile2 marketCapitalization) for guaranteed data.
const YUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
let _yCookie = '', _yCrumb = '', _yAuthTs = 0;
// Obtain a fresh Yahoo cookie + crumb. `force` skips the 30-min cache (used to
// self-heal when a cached crumb has gone stale and v7 starts returning 401).
async function _yahooAuth(force) {
  if (!force && _yCrumb && Date.now() - _yAuthTs < 30 * 60 * 1000) return true;
  // A cookie can come from any of these hosts — fc.yahoo.com is flaky, so fall back.
  let cookie = '';
  for (const src of ['https://fc.yahoo.com/', 'https://finance.yahoo.com/', 'https://login.yahoo.com/']) {
    try {
      const r1 = await fetch(src, { headers: { 'User-Agent': YUA } });
      const sc = (typeof r1.headers.getSetCookie === 'function') ? r1.headers.getSetCookie() : [];
      if (sc.length) { cookie = sc.map(c => c.split(';')[0]).join('; '); break; }
    } catch (e) { /* try next source */ }
  }
  if (!cookie) return false;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const r2 = await fetch(`https://${host}/v1/test/getcrumb`, { headers: { 'User-Agent': YUA, 'Cookie': cookie } });
      const crumb = (await r2.text()).trim();
      if (crumb && crumb.length < 30 && !crumb.includes('<')) { _yCookie = cookie; _yCrumb = crumb; _yAuthTs = Date.now(); return true; }
    } catch (e) { /* try next host */ }
  }
  return false;
}
// Per-symbol v7-quote cache. One v7 call gives us BOTH market cap and the
// extended-hours change fields, so we fetch it once and share. Successes cached
// 30s (keeps the extended-hours % fresh for the ~45s auto-refresh); a null
// (blocked) cached 60s so we retry soon without hammering Yahoo.
const _v7Cache = {}; // SYMBOL -> { q: object|null, ts }
async function fetchV7Quote(symbol) {
  const c = _v7Cache[symbol];
  if (c) {
    const ttl = (c.q != null) ? 30 * 1000 : 60 * 1000;
    if (Date.now() - c.ts < ttl) return c.q;
  }
  let q = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!(await _yahooAuth(attempt === 1))) break;       // force a fresh auth on the retry
    try {
      const url = 'https://query1.finance.yahoo.com/v7/finance/quote?symbols=' + encodeURIComponent(symbol) + '&crumb=' + encodeURIComponent(_yCrumb);
      const r = await fetch(url, { headers: { 'User-Agent': YUA, 'Cookie': _yCookie } });
      if (r.ok) {
        const j = await r.json();
        q = (j.quoteResponse && j.quoteResponse.result && j.quoteResponse.result[0]) || null;
        break;                                            // got a valid response
      }
      _yCrumb = ''; _yCookie = '';                        // stale crumb (e.g. 401) -> force re-auth & retry
    } catch (e) { _yCrumb = ''; _yCookie = ''; }
  }
  _v7Cache[symbol] = { q, ts: Date.now() };
  return q;
}
function _mcapOf(q) { return q && typeof q.marketCap === 'number' ? q.marketCap : null; }
async function fetchMarketCap(symbol) { return _mcapOf(await fetchV7Quote(symbol)); }
// Extended-hours-aware % change vs the regular close, derived from a v7 quote.
function extChange(q) {
  if (!q) return null;
  const st = q.marketState || '';
  const reg  = (typeof q.regularMarketChangePercent === 'number') ? q.regularMarketChangePercent : null;
  const pre  = (typeof q.preMarketChangePercent === 'number') ? q.preMarketChangePercent : null;
  const post = (typeof q.postMarketChangePercent === 'number') ? q.postMarketChangePercent : null;
  if ((st === 'PRE' || st === 'PREPRE') && pre != null) return { changePct: pre, phase: 'pre' };
  if ((st === 'POST' || st === 'POSTPOST' || st === 'CLOSED') && post != null) return { changePct: post, phase: 'post' };
  if (reg != null) return { changePct: reg, phase: 'regular' };
  return null;
}
// Extended-hours-aware CURRENT price (pre-market / after-hours / regular) from a v7 quote.
function extPrice(q) {
  if (!q) return null;
  const st = q.marketState || '';
  const reg = (typeof q.regularMarketPrice === 'number') ? q.regularMarketPrice : null;
  const pre = (typeof q.preMarketPrice === 'number') ? q.preMarketPrice : null;
  const post = (typeof q.postMarketPrice === 'number') ? q.postMarketPrice : null;
  if ((st === 'PRE' || st === 'PREPRE') && pre != null) return { price: pre, phase: 'pre' };
  if ((st === 'POST' || st === 'POSTPOST' || st === 'CLOSED') && post != null) return { price: post, phase: 'post' };
  if (reg != null) return { price: reg, phase: 'regular' };
  return null;
}

// ── Average daily $ volume over the last 20 trading days (volume × close) ──
function _avg20dFrom(vols, closes) {
  const pairs = [];
  for (let i = 0; i < vols.length; i++) {
    if (vols[i] != null && closes[i] != null && vols[i] > 0) pairs.push(vols[i] * closes[i]);
  }
  const last20 = pairs.slice(-20);
  if (!last20.length) return null;
  return Math.round(last20.reduce((a, b) => a + b, 0) / last20.length);
}
async function fetch20dAvgDollar(symbol) {
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?interval=1d&range=2mo';
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const j = await r.json();
    const res = j.chart && j.chart.result && j.chart.result[0];
    if (!res) return null;
    const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
    return _avg20dFrom(q.volume || [], q.close || []);
  } catch (e) { return null; }
}

async function fetchQuote(symbol, tf) {
  const cfg = TF_MAP[tf] || TF_MAP['1d'];
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?interval=' + cfg.interval + '&range=' + cfg.range;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) return { symbol, error: 'HTTP ' + r.status };
  const j = await r.json();
  const res = j.chart && j.chart.result && j.chart.result[0];
  if (!res) return { symbol, error: (j.chart && j.chart.error && j.chart.error.description) || 'no data' };
  const meta = res.meta || {};
  const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
  if (cfg.group && cfg.group > 1) { const rs = _resampleCV(q.close || [], q.volume || [], cfg.group); q.close = rs.closes; q.volume = rs.vols; }
  const vols = (q.volume || []).filter(v => v != null && v > 0);
  const closes = (q.close || []).filter(c => c != null);
  const price = meta.regularMarketPrice || (closes.length ? closes[closes.length - 1] : 0);
  let curVol;
  if (tf && tf !== '1d') {
    curVol = vols.length ? vols[vols.length - 1] : 0;      // intraday: latest bar's volume
  } else {
    curVol = meta.regularMarketVolume || (vols.length ? vols[vols.length - 1] : 0); // daily: today's full volume
  }
  const hist = vols.slice(0, -1);                          // average of prior bars (exclude the current bar)
  const avgVol = hist.length ? Math.round(hist.reduce((a, b) => a + b, 0) / hist.length) : 0;
  // Previous-day close. For the daily chart it's the close before the latest bar (reliable);
  // for intraday charts use the prior regular-session close from meta.
  let prevClose;
  if (tf && tf !== '1d') {
    prevClose = (meta.previousClose != null ? meta.previousClose : meta.chartPreviousClose) || 0;
  } else {
    prevClose = closes.length >= 2 ? closes[closes.length - 2] : (meta.previousClose || meta.chartPreviousClose || 0);
  }
  const volSeries = vols.slice(-40);                        // recent bars for a small volume sparkline
  // Full-day total shares traded today (consistent across timeframes) — for "Vol Traded ($)".
  const dayVol = meta.regularMarketVolume || curVol || 0;
  // One authenticated v7 quote gives market cap + extended-hours change; fetch it
  // alongside the 20-day avg daily $ volume. On the daily timeframe we already have
  // daily bars, so reuse them (no extra request).
  const [v7, avgDollar20d] = await Promise.all([
    fetchV7Quote(symbol),
    (tf === '1d') ? Promise.resolve(_avg20dFrom(q.volume || [], q.close || [])) : fetch20dAvgDollar(symbol)
  ]);
  const marketCap = _mcapOf(v7);
  // Extended-hours-aware % change; fall back to a chart-derived regular change.
  const ext = extChange(v7) || { changePct: (prevClose ? ((price - prevClose) / prevClose) * 100 : null), phase: 'regular' };
  // Previous trading day's $ volume (daily bars only) — lets "Vol Traded ($)" colour green/red
  // vs the prior day immediately, instead of waiting for a tick-to-tick comparison.
  let prevDayDollar = null;
  if (!tf || tf === '1d') {
    const rv = q.volume || [], rc = q.close || [];
    let seen = 0;
    for (let i = rv.length - 1; i >= 0; i--) {
      if (rv[i] != null && rc[i] != null && rv[i] > 0) { seen++; if (seen === 2) { prevDayDollar = rv[i] * rc[i]; break; } }
    }
  }
  return { symbol, price, avgVol, curVol, prevClose, volSeries, dayVol, marketCap, avgDollar20d, prevDayDollar, changePct: ext.changePct, phase: ext.phase, tf: tf || '1d' };
}
// ── HISTORICAL DAILY SNAPSHOT (as-of a prior date) ────────────
// Returns the same shape as fetchQuote but computed from the daily bar for the
// selected date (snaps to the prior trading day on weekends/holidays). Market cap
// is approximate: current shares (current marketCap / latest close) × that day's close.
async function fetchHistoricalQuote(symbol, dateStr) {
  const target = Math.floor(new Date(dateStr + 'T23:59:59Z').getTime() / 1000); // end of the selected day, UTC
  const ageDays = (Date.now() / 1000 - target) / 86400;
  let range = '6mo';
  if (ageDays > 1700) range = '10y'; else if (ageDays > 700) range = '5y';
  else if (ageDays > 330) range = '2y'; else if (ageDays > 150) range = '1y';
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?interval=1d&range=' + range;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) return { symbol, error: 'HTTP ' + r.status };
  const j = await r.json();
  const res = j.chart && j.chart.result && j.chart.result[0];
  if (!res) return { symbol, error: (j.chart && j.chart.error && j.chart.error.description) || 'no data' };
  const ts = res.timestamp || [];
  const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
  const rc = q.close || [], rv = q.volume || [];
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (rc[i] != null && rv[i] != null && rv[i] > 0) bars.push({ ts: ts[i], close: rc[i], vol: rv[i] });
  }
  if (!bars.length) return { symbol, error: 'no daily data' };
  // last bar at/before the end of the selected day → snaps to prior trading day
  let idx = -1;
  for (let i = 0; i < bars.length; i++) { if (bars[i].ts <= target) idx = i; }
  if (idx < 0) return { symbol, error: 'no data on/before ' + dateStr };
  const b = bars[idx];
  const price = b.close, curVol = b.vol, dayVol = b.vol;
  const prevClose = idx > 0 ? bars[idx - 1].close : 0;
  const win = bars.slice(Math.max(0, idx - 19), idx + 1);            // up to 20 bars ending on the date
  const avgDollar20d = win.length ? Math.round(win.reduce((a, x) => a + x.vol * x.close, 0) / win.length) : null;
  const prior = bars.slice(Math.max(0, idx - 20), idx);             // ~20 bars before the date (for RVOL)
  const avgVol = prior.length ? Math.round(prior.reduce((a, x) => a + x.vol, 0) / prior.length) : 0;
  const volSeries = bars.slice(Math.max(0, idx - 39), idx + 1).map(x => x.vol);
  const asOf = new Date(b.ts * 1000).toISOString().slice(0, 10);
  // Approximate market cap as of the date: current shares × that day's close.
  let marketCap = null;
  try {
    const curMcap = await fetchMarketCap(symbol);
    const latestClose = bars[bars.length - 1].close;
    if (curMcap && latestClose) marketCap = Math.round((curMcap / latestClose) * b.close);
  } catch (e) { /* leave null */ }
  const changePct = prevClose ? ((b.close - prevClose) / prevClose) * 100 : null;
  return { symbol, price, avgVol, curVol, prevClose, volSeries, dayVol, marketCap, mktCapApprox: marketCap != null, avgDollar20d, changePct, phase: 'regular', asOf, tf: '1d' };
}

app.get('/api/quote', async (req, res) => {
  const symbol = (req.query.symbol || '').trim().toUpperCase();
  const tf = (req.query.tf || '1d');
  const date = (req.query.date || '').trim();
  if (!symbol) return res.status(400).json({ error: 'no symbol' });
  try {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) res.json(await fetchHistoricalQuote(symbol, date));
    else res.json(await fetchQuote(symbol, tf));
  }
  catch (e) { res.json({ symbol, error: e.message }); }
});

// ── IN-PLAY UPTREND SCAN: trend / relative-strength / composite score ─────────
// Pulls 1y of daily bars per symbol and computes the moving-average stack, ADX,
// 52-week-high proximity, relative strength vs SPY, and a 0–100 "In-Play" score.
function _smaLast(a, n) { if (a.length < n) return null; let s = 0; for (let i = a.length - n; i < a.length; i++) s += a[i]; return s / n; }
function _emaLast(a, n) { if (a.length < n) return null; const k = 2 / (n + 1); let e = 0; for (let i = 0; i < n; i++) e += a[i]; e /= n; for (let i = n; i < a.length; i++) e = a[i] * k + e * (1 - k); return e; }
function _clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
// Wilder ADX(14) → { adx, plusDI, minusDI }
function _adx(H, L, C, n) {
  if (H.length < 2 * n + 2) return { adx: null, plusDI: 0, minusDI: 0 };
  let trS = 0, pdmS = 0, mdmS = 0;
  for (let i = 1; i <= n; i++) {
    const tr = Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1]));
    const up = H[i] - H[i - 1], dn = L[i - 1] - L[i];
    trS += tr; pdmS += (up > dn && up > 0) ? up : 0; mdmS += (dn > up && dn > 0) ? dn : 0;
  }
  const dxs = []; let pDI = 0, mDI = 0;
  for (let i = n + 1; i < H.length; i++) {
    const tr = Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1]));
    const up = H[i] - H[i - 1], dn = L[i - 1] - L[i];
    trS = trS - trS / n + tr;
    pdmS = pdmS - pdmS / n + ((up > dn && up > 0) ? up : 0);
    mdmS = mdmS - mdmS / n + ((dn > up && dn > 0) ? dn : 0);
    pDI = trS ? 100 * pdmS / trS : 0; mDI = trS ? 100 * mdmS / trS : 0;
    dxs.push((pDI + mDI) ? 100 * Math.abs(pDI - mDI) / (pDI + mDI) : 0);
  }
  if (dxs.length < n) return { adx: null, plusDI: pDI, minusDI: mDI };
  let adx = 0; for (let i = 0; i < n; i++) adx += dxs[i]; adx /= n;
  for (let i = n; i < dxs.length; i++) adx = (adx * (n - 1) + dxs[i]) / n;
  return { adx, plusDI: pDI, minusDI: mDI };
}
// Per-timeframe scan config. range gives enough bars for SMA100; momFull scales the
// momentum threshold to the bar size; rsN = relative-strength lookback (in bars).
const SCAN_TF = {
  '1m':  { interval: '1m',  range: '5d',  group: 1, momFull: 1,   rsN: 20 },
  '5m':  { interval: '5m',  range: '5d',  group: 1, momFull: 1.5, rsN: 20 },
  '15m': { interval: '15m', range: '1mo', group: 1, momFull: 2,   rsN: 20 },
  '30m': { interval: '30m', range: '1mo', group: 1, momFull: 2.5, rsN: 20 },
  '60m': { interval: '60m', range: '3mo', group: 1, momFull: 3,   rsN: 30 },
  '2h':  { interval: '60m', range: '6mo', group: 2, momFull: 3.5, rsN: 30 },
  '4h':  { interval: '60m', range: '1y',  group: 4, momFull: 4,   rsN: 30 },
  '1d':  { interval: '1d',  range: '1y',  group: 1, momFull: 5,   rsN: 63 }
};
function _resampleBars(H, L, C, V, g) {
  if (g <= 1) return { H, L, C, V };
  const oH = [], oL = [], oC = [], oV = [];
  for (let i = 0; i < C.length; i += g) {
    let hi = -Infinity, lo = Infinity, vol = 0, lc = null, any = false;
    for (let j = i; j < Math.min(i + g, C.length); j++) { if (H[j] > hi) hi = H[j]; if (L[j] < lo) lo = L[j]; vol += V[j]; lc = C[j]; any = true; }
    if (any) { oH.push(hi); oL.push(lo); oC.push(lc); oV.push(vol); }
  }
  return { H: oH, L: oL, C: oC, V: oV };
}
async function _fetchBars(symbol, cfg) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?interval=' + cfg.interval + '&range=' + cfg.range;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const res = j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error('no data');
  const meta = res.meta || {}, q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
  const ts = res.timestamp || [], rc = q.close || [], rh = q.high || [], rl = q.low || [], rv = q.volume || [];
  let H = [], L = [], C = [], V = [];
  for (let i = 0; i < ts.length; i++) { if (rc[i] != null && rh[i] != null && rl[i] != null) { H.push(rh[i]); L.push(rl[i]); C.push(rc[i]); V.push(rv[i] || 0); } }
  if (cfg.group > 1) { const g = _resampleBars(H, L, C, V, cfg.group); H = g.H; L = g.L; C = g.C; V = g.V; }
  return { meta, H, L, C, V };
}
const _benchCache = {};
async function _benchRet(sym, cfg) {
  const key = sym + '|' + cfg.interval + cfg.range + cfg.group;
  const c = _benchCache[key]; if (c && Date.now() - c.ts < 300000) return c.r;
  let r = 0;
  try { const d = await _fetchBars(sym, cfg); const C = d.C; r = C.length > cfg.rsN ? (C[C.length - 1] / C[C.length - 1 - cfg.rsN] - 1) * 100 : 0; } catch (e) { }
  _benchCache[key] = { r, ts: Date.now() };
  return r;
}
const _scanCache = {};
async function fetchScan(symbol, benchRet, cfg, tfKey, bench) {
  const ck = symbol + '|' + tfKey + '|' + bench;
  const c = _scanCache[ck]; if (c && Date.now() - c.ts < 60000) return c.data;
  const { meta, H, L, C, V } = await _fetchBars(symbol, cfg);
  if (C.length < 55) throw new Error('not enough history');
  const isDaily = (tfKey === '1d');
  const v7 = await fetchV7Quote(symbol).catch(() => null);
  const ep = v7 ? extPrice(v7) : null, ec = v7 ? extChange(v7) : null;
  const price = (ep && ep.price) ? ep.price : (meta.regularMarketPrice || C[C.length - 1]);
  const prevClose = C.length >= 2 ? C[C.length - 2] : price;
  // % change: daily = extended-hours daily move; intraday = move over the most recent bar (≈ the chosen period)
  const changePct = isDaily ? (ec ? ec.changePct : (prevClose ? (price / prevClose - 1) * 100 : 0)) : (prevClose ? (price / prevClose - 1) * 100 : 0);
  const phase = ec ? ec.phase : 'regular';
  const curVol = isDaily ? (meta.regularMarketVolume || V[V.length - 1] || 0) : (V[V.length - 1] || 0);
  const ema8 = _emaLast(C, 8), ema21 = _emaLast(C, 21), sma50 = _smaLast(C, 50), sma100 = _smaLast(C, 100);
  const { adx, plusDI, minusDI } = _adx(H, L, C, 14);
  const winHigh = Math.max.apply(null, H.slice(-Math.min(H.length, 252)));
  const pctFrom52 = winHigh ? (price / winHigh - 1) * 100 : 0;
  const w = V.slice(-(cfg.rsN + 1), -1), avgV = w.length ? w.reduce((a, b) => a + b, 0) / w.length : 0;
  const rvol = avgV ? curVol / avgV : 0;
  const sret = n => C.length > n ? (price / C[C.length - 1 - n] - 1) * 100 : 0;
  const rs = sret(cfg.rsN) - (benchRet || 0);
  let ms = 0;
  if (ema8 != null && price > ema8) ms++;
  if (ema8 != null && ema21 != null && ema8 > ema21) ms++;
  if (ema21 != null && sma50 != null && ema21 > sma50) ms++;
  if (sma50 != null && sma100 != null && sma50 > sma100) ms++;
  const score = Math.round(
    30 * _clamp(rvol / 3, 0, 1)
    + 20 * _clamp(changePct / cfg.momFull, 0, 1)
    + 25 * (ms / 4)
    + 15 * ((adx != null && adx >= 25 && plusDI > minusDI) ? 1 : 0)
    + 10 * _clamp((price / winHigh - 0.75) / 0.25, 0, 1)
  );
  // liquidity / size context (daily-based so they're stable across scan timeframes)
  const dollarVol = (meta.regularMarketVolume || 0) * price;                 // today's $ traded
  const avgDollar20d = isDaily ? _avg20dFrom(V, C) : await fetch20dAvgDollar(symbol).catch(() => null);
  const marketCap = _mcapOf(v7);
  const out = { symbol, price, changePct, phase, rvol, score, maStack: ms, adx, plusDI, minusDI, pctFrom52, rs, dollarVol, avgDollar20d, marketCap };
  _scanCache[ck] = { ts: Date.now(), data: out };
  return out;
}
const SCAN_BENCH = { QQQ: 1, SPY: 1, SMH: 1 };   // allowed RS benchmarks
app.get('/api/scan', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const tfKey = SCAN_TF[req.query.tf] ? req.query.tf : '1d';
  const cfg = SCAN_TF[tfKey];
  const bench = SCAN_BENCH[(req.query.bench || '').toUpperCase()] ? req.query.bench.toUpperCase() : 'QQQ';
  const syms = (req.query.symbols || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 60);
  if (!syms.length) return res.json({ rows: [], tf: tfKey, bench });
  try {
    const benchRet = await _benchRet(bench, cfg);
    const rows = await Promise.all(syms.map(async s => { try { return await fetchScan(s, benchRet, cfg, tfKey, bench); } catch (e) { return { symbol: s, error: e.message }; } }));
    res.json({ rows, tf: tfKey, bench, asOf: Date.now() });
  } catch (e) { res.json({ rows: [], tf: tfKey, bench, error: e.message }); }
});

// Upload an image — returns the URL path to use in the dashboard
app.post('/api/upload-image', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: '/data/images/' + req.file.filename });
});

// Delete an image file
app.delete('/api/image/:filename', (req, res) => {
  const filePath = path.join(IMAGES_DIR, req.params.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  res.json({ ok: true });
});

// ── RSS NEWS FEED ─────────────────────────────────────────────
const RSS_FEEDS = {
  // Investing.com
  general:      'https://www.investing.com/rss/news.rss',
  stocks:       'https://www.investing.com/rss/news_25.rss',
  economy:      'https://www.investing.com/rss/news_1.rss',
  earnings:     'https://www.investing.com/rss/news_14.rss',
  // Benzinga
  benzinga:     'https://www.benzinga.com/feed/',
  bz_earnings:  'https://www.benzinga.com/topic/earnings/feed',
  bz_movers:    'https://www.benzinga.com/topic/movers/feed',
  // MarketWatch (Dow Jones)
  marketwatch:  'https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines',
  mw_market:    'https://feeds.content.dowjones.io/public/rss/mw_marketpulse',
  // Wall Street Journal (Dow Jones)
  wsj_markets:  'https://feeds.a.dj.com/rss/RSSMarketsMain.xml',
  wsj_business: 'https://feeds.a.dj.com/rss/WSJcomUSBusiness.xml',
  // Yahoo Finance
  yahoo:        'https://finance.yahoo.com/news/rssindex',
  // CNBC
  cnbc:         'https://www.cnbc.com/id/100003114/device/rss/rss.html',
  cnbc_markets: 'https://www.cnbc.com/id/15839135/device/rss/rss.html',
};

// Cache: { category: { ts, items[] } }
const rssCache = {};
const RSS_TTL = 5 * 60 * 1000; // 5 minutes

function fetchRSS(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml'
      }
    }, res => {
      // Follow redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchRSS(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const get = tag => {
      const m = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([^<]*)<\\/${tag}>`));
      return m ? (m[1] || m[2] || '').trim() : '';
    };
    const title = get('title');
    const link  = get('link') || block.match(/<link>([^<]+)/)?.[1]?.trim() || '';
    const pubDate = get('pubDate');
    const desc = get('description').replace(/<[^>]+>/g, '').trim();
    if (title) items.push({ title, link, pubDate, desc });
    if (items.length >= 30) break;
  }
  return items;
}

app.get('/api/news-feed', async (req, res) => {
  const cat = req.query.category || 'general';
  const url = RSS_FEEDS[cat] || RSS_FEEDS.general;
  const cached = rssCache[cat];
  if (cached && Date.now() - cached.ts < RSS_TTL) {
    return res.json({ items: cached.items, cached: true });
  }
  try {
    const xml = await fetchRSS(url);
    const items = parseRSS(xml);
    rssCache[cat] = { ts: Date.now(), items };
    res.json({ items, cached: false });
  } catch(e) {
    if (cached) return res.json({ items: cached.items, cached: true, stale: true });
    res.status(500).json({ error: e.message, items: [] });
  }
});

// ── BREAKING NEWS (multi-source aggregated feed) ──────────────
const BREAKING_SOURCES = [
  { key: 'benzinga',   url: 'https://www.benzinga.com/feed/',                                        label: 'Benzinga' },
  { key: 'mw',         url: 'https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines',     label: 'MarketWatch' },
  { key: 'wsj',        url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml',                         label: 'WSJ' },
  { key: 'cnbc',       url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html',                 label: 'CNBC' },
  { key: 'yahoo',      url: 'https://finance.yahoo.com/news/rssindex',                               label: 'Yahoo Finance' },
  { key: 'investing',  url: 'https://www.investing.com/rss/news.rss',                                label: 'Investing.com' },
];

const breakingCache = { ts: 0, items: [] };
const BREAKING_TTL = 2 * 60 * 1000; // 2 minutes

app.get('/api/breaking-news', async (req, res) => {
  const forceRefresh = !!req.query.bust;
  if (!forceRefresh && Date.now() - breakingCache.ts < BREAKING_TTL) {
    return res.json({ items: breakingCache.items, cached: true });
  }
  const fetches = BREAKING_SOURCES.map(src =>
    fetchRSS(src.url)
      .then(xml => parseRSS(xml).slice(0, 20).map(item => ({ ...item, source: src.label })))
      .catch(() => [])
  );
  const results = await Promise.all(fetches);
  const allItems = results.flat();

  // Deduplicate on leading 60 chars of title
  const seen = new Set();
  const deduped = allItems.filter(item => {
    const key = item.title.toLowerCase().replace(/\s+/g, ' ').slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort newest first
  deduped.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));

  breakingCache.ts = Date.now();
  breakingCache.items = deduped.slice(0, 60);
  res.json({ items: breakingCache.items, cached: false });
});

// ── TICKER-SPECIFIC NEWS ──────────────────────────────────────
const tickerCache = {}; // { TICKER: { ts, items[] } }

app.get('/api/ticker-news', async (req, res) => {
  const ticker = (req.query.ticker || '').toUpperCase().trim();
  if (!ticker) return res.status(400).json({ error: 'No ticker provided', items: [] });

  const cached = tickerCache[ticker];
  if (cached && Date.now() - cached.ts < RSS_TTL) {
    return res.json({ items: cached.items, ticker, cached: true });
  }

  // Try multiple sources in order, return first that works
  const sources = [
    // Yahoo Finance RSS
    `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${ticker}&region=US&lang=en-US`,
    // Benzinga ticker search
    `https://www.benzinga.com/stock/${ticker.toLowerCase()}/feed`,
  ];

  for (const url of sources) {
    try {
      const xml = await fetchRSS(url);
      const items = parseRSS(xml);
      if (items.length > 0) {
        tickerCache[ticker] = { ts: Date.now(), items };
        return res.json({ items, ticker, cached: false });
      }
    } catch(e) { /* try next source */ }
  }

  // All sources failed — return stale if available
  if (cached) return res.json({ items: cached.items, ticker, cached: true, stale: true });
  res.json({ items: [], ticker, error: 'No news found for this ticker' });
});

// ── SERVE DASHBOARD ───────────────────────────────────────────
app.get('/', (req, res) => {
  // Never cache the dashboard HTML so updates always show on reload
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(__dirname, 'petes_trade_dash_2026.html'));
});

// STARTUP SELF-HEAL: if the live data file is empty/corrupt but a "last good"
// backup with real data exists, restore it before serving — so a reopen never
// comes up blank.
function selfHealOnStartup() {
  try {
    let live = null;
    try { live = readData(); } catch (e) { live = null; }
    const liveCount = live ? ((live.trades||[]).length + (live.todTrades||[]).length) : 0;
    if (liveCount > 0) return; // live data is fine
    const lastGood = path.join(__dirname, 'backups', 'dashboard-data.lastgood.json');
    if (fs.existsSync(lastGood)) {
      const bak = JSON.parse(fs.readFileSync(lastGood, 'utf8').replace(/^﻿/, ''));
      const bakCount = (bak.trades||[]).length + (bak.todTrades||[]).length;
      if (bakCount > 0) {
        writeData(bak);
        console.log(`🛟 Self-heal: live data was empty — restored ${bakCount} trades from last-good backup.`);
      }
    }
  } catch (e) { console.warn('Self-heal check skipped:', e.message); }
}
selfHealOnStartup();

app.listen(PORT, () => {
  console.log('\n✅ Pete\'s Trade Dash is running!');
  console.log(`   Open your browser and go to: http://localhost:${PORT}\n`);
  if (PORT == 3000) {
    if (SUPA) supaEnsureBucket(); // auto-create the cloud storage bucket if needed
    // Auto-open the browser
    const { exec } = require('child_process');
    exec(`start http://localhost:${PORT}`);
  }
});
