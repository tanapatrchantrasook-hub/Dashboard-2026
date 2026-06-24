/* ============================================================================
   STOCK SCREENER — backend quote endpoint (portable, no API key)
   ----------------------------------------------------------------------------
   This is the server half of the screener. It proxies Yahoo Finance from the
   server (so the browser never hits CORS) and powers GET /api/quote.

   HOW TO INSTALL (Express):
     1. Make sure your server uses Node 18+ (global fetch) OR `npm i node-fetch`
        and add `const fetch = require('node-fetch');` at the top of your server.
     2. Paste everything below into your existing server file (e.g. server.js),
        ABOVE `app.listen(...)`. It registers one route: app.get('/api/quote').
     3. That's it — no keys, no extra deps. Yahoo's endpoints are public.

   Not on Express? The two functions you need are fetchQuote(symbol, tf) and
   fetchQuoteHistorical(symbol, dateStr) — call them from whatever HTTP layer you
   use and return their JSON. The /api/quote handler at the bottom shows the
   routing: if `date` looks like YYYY-MM-DD → historical, else live.

   KEEP IT INDEPENDENT: this is a standalone copy. Do not import from or share a
   process with the other dashboard.
   ========================================================================== */

// Selected-timeframe → Yahoo {interval, range}
const TF_MAP = {
  '5m':  { interval: '5m',  range: '1mo' },
  '30m': { interval: '30m', range: '1mo' },
  '60m': { interval: '60m', range: '3mo' },
  '1d':  { interval: '1d',  range: '3mo' }
};

async function yfChart(symbol, interval, range) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol)
            + '?interval=' + interval + '&range=' + range;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) return null;
  const j = await r.json();
  return (j.chart && j.chart.result && j.chart.result[0]) || null;
}

// ── Yahoo authenticated quote (for market cap + pre/post change) — cookie + crumb, cached ~30 min ──
// Best-effort: if any step fails, callers fall back to marketCap = null.
let _yfAuth = { cookie: null, crumb: null, ts: 0 };
const YF_AUTH_TTL = 30 * 60 * 1000;
async function yfAuth() {
  if (_yfAuth.crumb && (Date.now() - _yfAuth.ts) < YF_AUTH_TTL) return _yfAuth;
  // 1) hit fc.yahoo.com to obtain session cookies
  const r1 = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': 'Mozilla/5.0' } });
  let cookies = [];
  if (typeof r1.headers.getSetCookie === 'function') cookies = r1.headers.getSetCookie();
  else if (r1.headers.get('set-cookie')) cookies = [r1.headers.get('set-cookie')];
  const cookie = cookies.map(c => c.split(';')[0]).join('; ');
  // 2) exchange the cookies for a crumb
  const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': cookie }
  });
  const crumb = (await r2.text()).trim();
  _yfAuth = { cookie, crumb, ts: Date.now() };
  return _yfAuth;
}
// Authenticated v7 quote → { marketCap, marketState, regularChg, preChg, postChg } (best-effort, null on failure).
async function yfQuoteInfo(symbol) {
  try {
    const { cookie, crumb } = await yfAuth();
    if (!crumb) return null;
    const url = 'https://query1.finance.yahoo.com/v7/finance/quote?symbols=' + encodeURIComponent(symbol)
              + '&crumb=' + encodeURIComponent(crumb);
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': cookie } });
    if (!r.ok) return null;
    const j = await r.json();
    const q = j && j.quoteResponse && j.quoteResponse.result && j.quoteResponse.result[0];
    if (!q) return null;
    const num = x => (typeof x === 'number' && isFinite(x)) ? x : null;
    return {
      marketCap: num(q.marketCap),
      marketState: q.marketState || '',
      regularChg: num(q.regularMarketChangePercent),
      preChg: num(q.preMarketChangePercent),
      postChg: num(q.postMarketChangePercent)
    };
  } catch (e) { return null; }
}
// Extended-hours-aware % change vs the regular close: pre-market in PRE, post-market in POST/CLOSED, else regular.
function pickChangePct(info) {
  if (!info) return { changePct: null, phase: 'regular' };
  const st = (info.marketState || '').toUpperCase();
  if ((st === 'PRE' || st === 'PREPRE') && info.preChg != null) return { changePct: info.preChg, phase: 'pre' };
  if ((st === 'POST' || st === 'POSTPOST' || st === 'CLOSED') && info.postChg != null) return { changePct: info.postChg, phase: 'post' };
  return { changePct: info.regularChg, phase: 'regular' };
}

// Daily {t, c, v} bars (non-null) from a daily chart result.
function dailyBars(dailyRes) {
  if (!dailyRes) return [];
  const q = (dailyRes.indicators && dailyRes.indicators.quote && dailyRes.indicators.quote[0]) || {};
  const ts = dailyRes.timestamp || [];
  const cl = q.close || [], vl = q.volume || [];
  return ts.map((t, i) => ({ t, c: cl[i], v: vl[i] })).filter(x => x.c != null && x.v != null);
}
// Average daily $ volume over the 20 daily bars ending at endIdx (inclusive; default = last bar).
function avgDollar20(bars, endIdx) {
  const end = (endIdx == null) ? bars.length - 1 : endIdx;
  const start = Math.max(0, end - 19);
  const slice = bars.slice(start, end + 1);
  if (!slice.length) return null;
  return Math.round(slice.reduce((a, b) => a + (b.v * b.c), 0) / slice.length);
}

async function fetchQuote(symbol, tf) {
  const cfg = TF_MAP[tf] || TF_MAP['1d'];
  const isIntraday = !!(tf && tf !== '1d');
  // selected-timeframe chart (price/volumes/sparkline), a daily chart for the 20-day $ avg
  // (reuse the timeframe chart when tf is already daily), and the market cap (best-effort).
  const [tfRes, dailyExtra, info] = await Promise.all([
    yfChart(symbol, cfg.interval, cfg.range),
    (tf === '1d') ? Promise.resolve(null) : yfChart(symbol, '1d', '2mo'),
    yfQuoteInfo(symbol)
  ]);
  const mcap = info ? info.marketCap : null;
  if (!tfRes) return { symbol, error: 'no data' };
  const meta = tfRes.meta || {};
  const q = (tfRes.indicators && tfRes.indicators.quote && tfRes.indicators.quote[0]) || {};
  const volumes = (q.volume || []).filter(v => v != null && v > 0);
  const closes = (q.close || []).filter(c => c != null);
  const price = (meta.regularMarketPrice != null) ? meta.regularMarketPrice
              : (closes.length ? closes[closes.length - 1] : 0);
  const curVol = isIntraday ? (volumes.length ? volumes[volumes.length - 1] : 0)
                            : (meta.regularMarketVolume != null ? meta.regularMarketVolume
                               : (volumes.length ? volumes[volumes.length - 1] : 0));
  const hist = volumes.slice(0, -1); // exclude the current/forming bar
  const avgVol = hist.length ? Math.round(hist.reduce((a, b) => a + b, 0) / hist.length) : 0;
  const volSeries = volumes.slice(-40);
  const dayVol = (meta.regularMarketVolume != null) ? meta.regularMarketVolume : curVol;
  // prevClose: daily → second-to-last daily close; intraday → meta.previousClose / chartPreviousClose
  let prevClose = 0;
  if (tf === '1d') {
    prevClose = closes.length >= 2 ? closes[closes.length - 2] : (closes[0] || 0);
  } else {
    prevClose = (meta.previousClose != null) ? meta.previousClose
              : (meta.chartPreviousClose != null ? meta.chartPreviousClose : 0);
  }
  const bars = dailyBars(tf === '1d' ? tfRes : dailyExtra);
  const avgDollar20d = bars.length ? avgDollar20(bars) : null;
  // Extended-hours-aware % change (falls back to a chart-derived regular change if v7 is unavailable).
  let { changePct, phase } = pickChangePct(info);
  if (changePct == null && prevClose) { changePct = ((price - prevClose) / prevClose) * 100; phase = 'regular'; }
  // Regular-session % change vs prior close (price = regularMarketPrice, so this stays "regular" even after hours).
  const regularChangePct = (info && info.regularChg != null) ? info.regularChg
                         : (prevClose ? ((price - prevClose) / prevClose) * 100 : null);
  return { symbol, price, avgVol, curVol, prevClose, volSeries, dayVol, avgDollar20d, marketCap: mcap, changePct, phase, regularChangePct, tf: tf || '1d' };
}

// Pick the Yahoo daily range wide enough to include the requested historical date.
function rangeForDate(dateStr) {
  const days = (Date.now() - new Date(dateStr + 'T00:00:00Z').getTime()) / 86400000;
  if (days <= 180) return '6mo';
  if (days <= 365) return '1y';
  if (days <= 730) return '2y';
  if (days <= 1825) return '5y';
  return '10y';
}
async function fetchQuoteHistorical(symbol, dateStr) {
  const [dailyRes, infoNow] = await Promise.all([
    yfChart(symbol, '1d', rangeForDate(dateStr)),
    yfQuoteInfo(symbol)
  ]);
  const mcapNow = infoNow ? infoNow.marketCap : null;
  if (!dailyRes) return { symbol, error: 'no data' };
  const bars = dailyBars(dailyRes);
  if (!bars.length) return { symbol, error: 'no data' };
  // last bar with timestamp <= end of the selected day (snaps weekends/holidays to prior trading day)
  const endOfDay = Math.floor(new Date(dateStr + 'T23:59:59Z').getTime() / 1000);
  let idx = -1;
  for (let i = 0; i < bars.length; i++) { if (bars[i].t <= endOfDay) idx = i; else break; }
  if (idx < 0) return { symbol, error: 'no data for date' };
  const bar = bars[idx];
  const prev = idx > 0 ? bars[idx - 1] : null;
  const price = bar.c;
  const curVol = bar.v, dayVol = bar.v;
  const prevClose = prev ? prev.c : 0;
  const avgDollar20d = avgDollar20(bars, idx);
  // avgVol = mean volume of the ~20 bars BEFORE that date (for RVOL)
  const before = bars.slice(Math.max(0, idx - 20), idx);
  const avgVol = before.length ? Math.round(before.reduce((a, b) => a + b.v, 0) / before.length) : 0;
  const volSeries = bars.slice(Math.max(0, idx - 39), idx + 1).map(b => b.v);
  const asOf = new Date(bar.t * 1000).toISOString().slice(0, 10);
  // marketCap: scale current cap by (that day's close / latest close)
  let marketCap = null, mktCapApprox = false;
  const latestClose = bars[bars.length - 1].c;
  if (mcapNow != null && latestClose) { marketCap = Math.round(mcapNow / latestClose * bar.c); mktCapApprox = true; }
  const changePct = prevClose ? ((bar.c - prevClose) / prevClose) * 100 : null;
  return { symbol, price, avgVol, curVol, prevClose, volSeries, dayVol, avgDollar20d, marketCap, mktCapApprox, asOf, changePct, phase: 'regular', regularChangePct: changePct, tf: 'historical' };
}

// ── ROUTE ──
app.get('/api/quote', async (req, res) => {
  const symbol = (req.query.symbol || '').trim().toUpperCase();
  const tf = (req.query.tf || '1d');
  const date = (req.query.date || '').trim();
  if (!symbol) return res.status(400).json({ error: 'no symbol' });
  try {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) res.json(await fetchQuoteHistorical(symbol, date));
    else res.json(await fetchQuote(symbol, tf));
  } catch (e) { res.json({ symbol, error: e.message }); }
});
