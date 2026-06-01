const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const https = require('https');

const app = express();
const PORT = 3000;
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

// ── DATA API ──────────────────────────────────────────────────

function readData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Load all data
app.get('/api/data', (req, res) => {
  res.json(readData());
});

// Save all data (bulk save)
app.post('/api/data', (req, res) => {
  const current = readData();
  const updated = { ...current, ...req.body };
  writeData(updated);
  res.json({ ok: true });
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
  general:  'https://www.investing.com/rss/news.rss',
  stocks:   'https://www.investing.com/rss/news_25.rss',
  economy:  'https://www.investing.com/rss/news_1.rss',
  earnings: 'https://www.investing.com/rss/news_14.rss',
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
    // Return stale cache if available
    if (cached) return res.json({ items: cached.items, cached: true, stale: true });
    res.status(500).json({ error: e.message, items: [] });
  }
});

// ── SERVE DASHBOARD ───────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'petes_trade_dash_2026.html'));
});

app.listen(PORT, () => {
  console.log('\n✅ Pete\'s Trade Dash is running!');
  console.log(`   Open your browser and go to: http://localhost:${PORT}\n`);
  // Auto-open the browser
  const { exec } = require('child_process');
  exec(`start http://localhost:${PORT}`);
});
