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

  // Keep a one-step "last good" backup of the previous non-empty state before overwriting.
  try {
    if (_count(current) > 0) {
      const bdir = path.join(__dirname, 'backups');
      if (!fs.existsSync(bdir)) fs.mkdirSync(bdir);
      fs.writeFileSync(path.join(bdir, 'dashboard-data.lastgood.json'), JSON.stringify(current));
    }
  } catch (e) { /* backup is best-effort; never block a save on it */ }

  writeData(updated);
  if (SUPA) scheduleCloudSave(updated);
  res.json({ ok: true });
});

// ── STOCK SCREENER QUOTE (Yahoo Finance proxy) ────────────────
// Returns { symbol, price, avgVol, curVol } for the screener.
const TF_MAP = {
  '5m':  { interval: '5m',  range: '1mo' },
  '30m': { interval: '30m', range: '1mo' },
  '60m': { interval: '60m', range: '3mo' },
  '1d':  { interval: '1d',  range: '3mo' }
};
async function yfChart(symbol, interval, range, pre) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol)
            + '?interval=' + interval + '&range=' + range + (pre ? '&includePrePost=true' : '');
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) return null;
  const j = await r.json();
  return (j.chart && j.chart.result && j.chart.result[0]) || null;
}
// The previous *regular-session* close from a daily series — robust across market states.
// If the last daily bar is today's (forming) bar, use the one before it; otherwise the last bar is the prior day.
function prevDailyClose(dailyRes) {
  if (!dailyRes) return 0;
  const q = (dailyRes.indicators && dailyRes.indicators.quote && dailyRes.indicators.quote[0]) || {};
  const ts = dailyRes.timestamp || [];
  const cl = q.close || [];
  const arr = ts.map((t, i) => ({ t, c: cl[i] })).filter(x => x.c != null);
  if (!arr.length) return 0;
  const nowD = new Date().toISOString().slice(0, 10);
  const lastD = new Date(arr[arr.length - 1].t * 1000).toISOString().slice(0, 10);
  return (lastD === nowD && arr.length >= 2) ? arr[arr.length - 2].c : arr[arr.length - 1].c;
}
async function fetchQuote(symbol, tf) {
  const cfg = TF_MAP[tf] || TF_MAP['1d'];
  const isIntraday = !!(tf && tf !== '1d');
  // Two fetches in parallel:
  //  • dailyRes — daily series, for a reliable previous-day close (and daily volume when tf=Daily)
  //  • liveRes  — intraday bars WITH pre/post-market, for the live price (and intraday volume)
  const [dailyRes, liveRes] = await Promise.all([
    yfChart(symbol, '1d', isIntraday ? '1mo' : cfg.range, false),
    yfChart(symbol, isIntraday ? cfg.interval : '5m', isIntraday ? cfg.range : '1d', true)
  ]);
  const volRes = isIntraday ? liveRes : dailyRes;
  if (!volRes) return { symbol, error: 'no data' };
  const meta = volRes.meta || {};
  const q = (volRes.indicators && volRes.indicators.quote && volRes.indicators.quote[0]) || {};
  const vols = (q.volume || []).filter(v => v != null && v > 0);
  const curVol = isIntraday ? (vols.length ? vols[vols.length - 1] : 0)
                            : (meta.regularMarketVolume || (vols.length ? vols[vols.length - 1] : 0));
  const hist = vols.slice(0, -1);
  const avgVol = hist.length ? Math.round(hist.reduce((a, b) => a + b, 0) / hist.length) : 0;
  const volSeries = vols.slice(-40);
  // Live price = latest close from the pre/post-inclusive intraday bars (reflects pre-market & after-hours).
  const liveCloses = liveRes ? ((liveRes.indicators.quote[0].close || []).filter(c => c != null)) : [];
  const price = liveCloses.length ? liveCloses[liveCloses.length - 1] : (meta.regularMarketPrice || 0);
  const prevClose = prevDailyClose(dailyRes) || meta.previousClose || meta.chartPreviousClose || 0;
  return { symbol, price, avgVol, curVol, prevClose, volSeries, tf: tf || '1d' };
}
app.get('/api/quote', async (req, res) => {
  const symbol = (req.query.symbol || '').trim().toUpperCase();
  const tf = (req.query.tf || '1d');
  if (!symbol) return res.status(400).json({ error: 'no symbol' });
  try { res.json(await fetchQuote(symbol, tf)); }
  catch (e) { res.json({ symbol, error: e.message }); }
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
