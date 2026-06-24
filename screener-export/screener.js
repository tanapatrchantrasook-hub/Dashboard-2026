/* ============================================================================
   STOCK SCREENER — front-end engine (portable)
   ----------------------------------------------------------------------------
   Paste this whole block inside your dashboard's <script> (top level, alongside
   your other globals/functions). It is self-contained except for two hooks you
   wire into YOUR app:
     1. scheduleSave()  — your existing "save my dashboard state" function.
                          If you don't have one, replace every scheduleSave()
                          call with your own persistence (or a no-op).
     2. Persistence      — see screener-INSTALL.md for the save/load keys.
   It also expects a backend endpoint GET /api/quote (see server-quote-endpoint.js)
   and a few CSS variables / classes (see screener-INSTALL.md "Theme contract").
   Nothing here defines colors or fonts — it only references var(--…) tokens, so
   it inherits YOUR theme automatically.
   ========================================================================== */

const screenerSymbols = []; // array of ticker strings
let screenerTF = '1d';      // '1d' | '60m' | '30m' | '5m'
const screenerHidden = {};  // { colKey: true } when a column is hidden
let screenerSort = { key:null, dir:'desc' }; // active sort column + direction
let screenerDate = '';      // '' = live; otherwise 'YYYY-MM-DD' historical close-of-day
const screenerHighlights = {}; // { SYMBOL: 'green'|'orange'|'yellow' } per-symbol chip backdrop
let screenerColorFilter = ''; // '' = all; otherwise show only this highlight color
let _lastQuotes = {};       // cache so toggling columns doesn't refetch
const _volDollarDir = {};   // { SYMBOL: 1|-1|0 } vs previous load — colors Vol Traded ($)
const _rvolDir = {};        // { SYMBOL: 1|-1|0 } vs previous load — colors RVOL
const SCREENER_COLS = [
  { key:'symbol',    label:'Symbol' },
  { key:'mktcap',    label:'Market Cap' },
  { key:'voldollar', label:'Vol Traded ($)' },
  { key:'avgdollar', label:'Avg D Vol 20D ($)' },
  { key:'price',     label:'Current Price' },
  { key:'chg',       label:'% Chg' },
  { key:'chgext',    label:'% Chg (ext)' },
  { key:'rvol',      label:'RVOL' },
  { key:'volchart',  label:'Volume Chart' },
];
const SCREENER_SORTABLE = new Set(['symbol','mktcap','voldollar','avgdollar','price','chg','chgext','rvol']);
function _fmtDollarFull(n){ return (n==null||isNaN(n)) ? '—' : '$'+Math.round(n).toLocaleString('en-US'); }
function _fmtPrice(p){ return (p==null||isNaN(p)) ? '—' : '$'+(p<1 ? Number(p).toFixed(4) : Number(p).toFixed(2)); }
const TF_LABEL = { '1d':'Daily', '60m':'1h', '30m':'30m', '5m':'5m' };
function _fmtBig(n){
  n = Number(n)||0;
  if(n>=1e12) return (n/1e12).toFixed(2)+'T';
  if(n>=1e9)  return (n/1e9).toFixed(2)+'B';
  if(n>=1e6)  return (n/1e6).toFixed(2)+'M';
  if(n>=1e3)  return (n/1e3).toFixed(1)+'K';
  return String(Math.round(n));
}
function addScreenerSymbol(){
  const raw = prompt('Add symbol(s) — separate multiple with commas (e.g. NVDA, AMD, SPY):');
  if(!raw) return;
  raw.split(',').map(s=>s.trim().toUpperCase()).filter(Boolean).forEach(sym=>{ if(!screenerSymbols.includes(sym)) screenerSymbols.push(sym); });
  renderScreener();          // show rows immediately (loading)
  loadScreener(true);        // then fetch data
  scheduleSave();
}
function removeScreenerSymbol(sym){
  const i = screenerSymbols.indexOf(sym); if(i>-1) screenerSymbols.splice(i,1);
  delete _lastQuotes[sym];
  renderScreener(_lastQuotes);
  scheduleSave();
}
function setScreenerTF(tf){ if(screenerDate) return; screenerTF = tf; renderScreenerControls(); loadScreener(true); scheduleSave(); }
// Symbol highlight chip: cycle none → green → orange → yellow → none (persisted per symbol).
function cycleScreenerHL(sym){
  const order=[null,'green','orange','yellow'];
  const next=order[(order.indexOf(screenerHighlights[sym]||null)+1)%order.length];
  if(next) screenerHighlights[sym]=next; else delete screenerHighlights[sym];
  renderScreener(_lastQuotes); scheduleSave();
}
function _scrHLbg(sym){
  const h=screenerHighlights[sym];
  return h==='green'?'rgba(63,185,80,0.32)':h==='orange'?'rgba(224,92,42,0.32)':h==='yellow'?'rgba(240,200,60,0.40)':'transparent';
}
// ── Date navigation (historical close-of-day snapshots) ──
function _scrToday(){ return new Date().toISOString().slice(0,10); }
function _scrIsWeekend(d){ const day=d.getUTCDay(); return day===0||day===6; }
function _scrPrevTradingDay(dateStr){
  const d=new Date((dateStr||_scrToday())+'T00:00:00Z');
  do { d.setUTCDate(d.getUTCDate()-1); } while(_scrIsWeekend(d));
  return d.toISOString().slice(0,10);
}
function _scrNextTradingDay(dateStr){
  const d=new Date(dateStr+'T00:00:00Z');
  do { d.setUTCDate(d.getUTCDate()+1); } while(_scrIsWeekend(d));
  return d.toISOString().slice(0,10);
}
function stepScreenerDate(dir){
  if(dir<0){
    screenerDate=_scrPrevTradingDay(screenerDate||_scrToday());
  } else {
    if(!screenerDate) return;                 // already live
    const nxt=_scrNextTradingDay(screenerDate);
    if(nxt>=_scrToday()){ screenerGoLive(); return; }  // stepping into today → Live
    screenerDate=nxt;
  }
  renderScreenerControls(); loadScreener(true); scheduleSave();
}
function onScreenerDateChange(){
  const el=document.getElementById('screener-date');
  const v=el?el.value:'';
  if(v && v>=_scrToday()){ screenerGoLive(); return; } // today/future → Live
  screenerDate=v||'';
  renderScreenerControls(); loadScreener(true); scheduleSave();
}
function screenerGoLive(){
  screenerDate='';
  renderScreenerControls(); loadScreener(true); scheduleSave();
}
function toggleScreenerCol(key){ screenerHidden[key] = !screenerHidden[key]; renderScreenerControls(); renderScreener(_lastQuotes); scheduleSave(); }
// Sortable columns: click a header to sort, click again to flip direction.
function setScreenerSort(key){
  if(key==='volchart') return; // sparkline column isn't sortable
  if(screenerSort.key===key){ screenerSort.dir = (screenerSort.dir==='desc'?'asc':'desc'); }
  else { screenerSort.key = key; screenerSort.dir = (key==='symbol' ? 'asc' : 'desc'); }
  renderScreener(_lastQuotes);
  scheduleSave();
}
// Highlight filter: show only stocks chipped with the chosen color (click active → back to All).
function setScreenerColorFilter(color){
  screenerColorFilter = (screenerColorFilter===color) ? '' : color;
  renderScreenerControls(); renderScreener(_lastQuotes); scheduleSave();
}
function _screenerSortVal(key, v){
  if(!v) return null;
  switch(key){
    case 'symbol':    return v.sym;
    case 'mktcap':    return v.marketCap;        // null for ETFs → sinks to bottom
    case 'voldollar': return v.curVol * v.price;
    case 'avgdollar': return v.avgDollar20d;     // may be null
    case 'price':     return v.price;
    case 'chg':       return v.regularChangePct; // may be null
    case 'chgext':    return v.changePct;        // may be null
    case 'rvol':      return v.rvol;
    default:          return null;               // volchart not sortable
  }
}
function renderScreenerControls(){
  const hist = !!screenerDate;
  const tfEl=document.getElementById('screener-tf');
  if(tfEl) tfEl.innerHTML = Object.keys(TF_LABEL).map(k=>`<button onclick="setScreenerTF('${k}')" class="topbar-tag${screenerTF===k?' active':''}" style="cursor:${hist?'not-allowed':'pointer'};opacity:${hist?'0.4':'1'}"${hist?' title="Daily snapshot — timeframe disabled for past dates"':''}>${TF_LABEL[k]}</button>`).join('');
  const colEl=document.getElementById('screener-cols');
  if(colEl) colEl.innerHTML = SCREENER_COLS.map(c=>`<button onclick="toggleScreenerCol('${c.key}')" class="topbar-tag${screenerHidden[c.key]?'':' active'}" style="cursor:pointer" title="Click to ${screenerHidden[c.key]?'show':'hide'}">${screenerHidden[c.key]?'':'✓ '}${c.label}</button>`).join('');
  const hlEl=document.getElementById('screener-hlfilter');
  if(hlEl){
    const opts=[{k:'',label:'All',bg:''},{k:'green',label:'Green',bg:'rgba(63,185,80,0.32)'},{k:'orange',label:'Orange',bg:'rgba(224,92,42,0.32)'},{k:'yellow',label:'Yellow',bg:'rgba(240,200,60,0.40)'}];
    hlEl.innerHTML = opts.map(o=>{
      const active = screenerColorFilter===o.k;
      const sw = o.bg ? `<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${o.bg};margin-right:5px;vertical-align:middle"></span>` : '';
      return `<button onclick="setScreenerColorFilter('${o.k}')" class="topbar-tag${active?' active':''}" style="cursor:pointer" title="${o.k?'Show only '+o.label.toLowerCase()+'-highlighted stocks':'Show all stocks'}">${sw}${o.label}</button>`;
    }).join('');
  }
  const dateEl=document.getElementById('screener-date');
  if(dateEl){ dateEl.max=_scrToday(); if(dateEl.value!==screenerDate) dateEl.value=screenerDate; }
  const liveBtn=document.getElementById('scr-live');
  if(liveBtn) liveBtn.classList.toggle('active', !screenerDate);
}
function _sparkline(vals, up){
  if(!vals || vals.length<2) return '<span style="color:rgba(255,255,255,0.2);font-size:11px">—</span>';
  const w=96,h=26,max=Math.max(...vals),min=Math.min(...vals),range=(max-min)||1;
  const pts=vals.map((x,i)=>{ const px=(i/(vals.length-1))*w; const py=h-1-((x-min)/range)*(h-2); return px.toFixed(1)+','+py.toFixed(1); }).join(' ');
  const col=up?'var(--green)':'var(--accent2)';
  const lastX=w, lastY=(h-1-((vals[vals.length-1]-min)/range)*(h-2)).toFixed(1);
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block"><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.5" stroke-linejoin="round"/><circle cx="${lastX}" cy="${lastY}" r="1.8" fill="${col}"/></svg>`;
}
function _dirColor(d){ return d>0?'var(--green)':d<0?'var(--red)':'var(--text)'; }
function _screenerCell(key,v){
  switch(key){
    case 'symbol':
      return `<td><span class="td-ticker" onclick="cycleScreenerHL('${v.sym}')" title="Click to cycle highlight" style="cursor:pointer;padding:1px 7px;border-radius:4px;background:${_scrHLbg(v.sym)};transition:background .15s">${v.sym}</span></td>`;
    case 'mktcap':
      return (v.marketCap==null)
        ? `<td style="font-family:var(--fd);color:rgba(255,255,255,0.3)">—</td>`
        : `<td style="font-family:var(--fd)">${v.mktCapApprox?'≈':''}${_fmtDollarFull(v.marketCap)}</td>`;
    case 'voldollar':
      return `<td style="font-family:var(--fd);font-weight:600;color:${_dirColor(_volDollarDir[v.sym]||0)}">${_fmtDollarFull(v.curVol*v.price)}</td>`;
    case 'avgdollar':
      return `<td style="font-family:var(--fd)">${_fmtDollarFull(v.avgDollar20d)}</td>`;
    case 'price':
      return `<td style="font-family:var(--fd)">${_fmtPrice(v.price)}</td>`;
    case 'chg': {
      if(v.regularChangePct==null) return `<td style="font-family:var(--fd);color:rgba(255,255,255,0.3)">—</td>`;
      const c=v.regularChangePct>=0?'var(--green)':'var(--red)';
      return `<td style="font-family:var(--fd);font-weight:700;color:${c}" title="Regular-session change vs prior close">${v.regularChangePct>=0?'+':''}${v.regularChangePct.toFixed(2)}%</td>`;
    }
    case 'chgext': {
      if(v.changePct==null) return `<td style="font-family:var(--fd);color:rgba(255,255,255,0.3)">—</td>`;
      const c=v.changePct>=0?'var(--green)':'var(--red)';
      const tag=v.phase==='pre'?' <span style="font-size:9px;color:var(--muted);letter-spacing:.03em">PRE</span>'
               :v.phase==='post'?' <span style="font-size:9px;color:var(--muted);letter-spacing:.03em">AH</span>':'';
      return `<td style="font-family:var(--fd);font-weight:700;color:${c}" title="${v.phase==='pre'?'Pre-market':v.phase==='post'?'After-hours':'Regular session'} change vs prior close">${v.changePct>=0?'+':''}${v.changePct.toFixed(2)}%${tag}</td>`;
    }
    case 'rvol':
      return `<td style="font-family:var(--fd);font-weight:700;color:${_dirColor(_rvolDir[v.sym]||0)}">${v.rvol?v.rvol.toFixed(2)+'×':'—'}</td>`;
    case 'volchart':
      return `<td title="Volume — recent ${TF_LABEL[screenerTF]||screenerTF} bars">${_sparkline(v.volSeries, v.up)}</td>`;
  }
  return '';
}
function renderScreener(quotes){
  const tbl=document.getElementById('screener-table'), msg=document.getElementById('screener-empty'), thead=document.getElementById('screener-thead'), tb=document.getElementById('screener-tbody');
  if(!tbl) return;
  renderScreenerControls();
  if(!screenerSymbols.length){ tbl.style.display='none'; msg.style.display='block'; tb.innerHTML=''; thead.innerHTML=''; return; }
  tbl.style.display='table'; msg.style.display='none';
  const cols = SCREENER_COLS.filter(c=>!screenerHidden[c.key]);
  thead.innerHTML = '<tr>'+cols.map(c=>{
    const sortable = c.key!=='volchart';
    const active = screenerSort.key===c.key;
    const arrow = active ? (screenerSort.dir==='asc'?' ▲':' ▼') : (sortable?' <span style="opacity:.25">⇅</span>':'');
    const style = sortable ? 'cursor:pointer;user-select:none'+(active?';color:var(--accent2)':'') : '';
    const handler = sortable ? ` onclick="setScreenerSort('${c.key}')" title="Sort by ${c.label}"` : '';
    return `<th${handler} style="${style}">${c.label}${arrow}</th>`;
  }).join('')+'<th></th></tr>';
  const rm = sym=>`<td><button onclick="removeScreenerSymbol('${sym}')" title="Remove" style="background:transparent;border:none;color:rgba(255,255,255,0.3);font-size:13px;cursor:pointer">✕</button></td>`;
  // Highlight filter: when a color is selected, show only stocks chipped that color.
  const visibleSymbols = screenerColorFilter
    ? screenerSymbols.filter(s => screenerHighlights[s] === screenerColorFilter)
    : screenerSymbols;
  if(screenerColorFilter && !visibleSymbols.length){
    tb.innerHTML = `<tr><td colspan="${cols.length+1}" style="font-size:12px;color:var(--muted);text-align:center;padding:20px">No ${screenerColorFilter}-highlighted stocks. Click a ticker to highlight it, or pick a different color.</td></tr>`;
    return;
  }
  // Build a row record per symbol, then sort if a column is active.
  let rows = visibleSymbols.map(sym=>{
    const q = quotes && quotes[sym];
    let v = null;
    if(q && !q.error){
      const avgVol=q.avgVol||0, curVol=q.curVol||0, price=q.price||0;
      v={ sym, avgVol, curVol, price, prevClose:q.prevClose||0,
          marketCap:(q.marketCap!=null?q.marketCap:null), mktCapApprox:!!q.mktCapApprox,
          avgDollar20d:(q.avgDollar20d!=null?q.avgDollar20d:null),
          changePct:(q.changePct!=null?q.changePct:null), phase:(q.phase||'regular'),
          regularChangePct:(q.regularChangePct!=null?q.regularChangePct:null),
          volSeries:q.volSeries||[], rvol: avgVol?curVol/avgVol:0, up: curVol>avgVol };
    }
    return { sym, q, v };
  });
  if(screenerSort.key && !SCREENER_SORTABLE.has(screenerSort.key)) screenerSort.key=null; // drop stale/removed keys
  if(screenerSort.key){
    const k=screenerSort.key, dir=(screenerSort.dir==='asc'?1:-1);
    rows.sort((a,b)=>{
      const av=_screenerSortVal(k,a.v), bv=_screenerSortVal(k,b.v);
      const aNull=(av==null), bNull=(bv==null);
      if(aNull && bNull) return 0;
      if(aNull) return 1;   // rows without data always sink to the bottom
      if(bNull) return -1;
      if(typeof av==='string') return dir * av.localeCompare(bv);
      return dir * (av - bv);
    });
  }
  tb.innerHTML = rows.map(({sym,q,v})=>{
    if(!q) return `<tr><td colspan="${cols.length}" style="font-size:12px;color:var(--muted)"><span class="td-ticker">${sym}</span> · loading…</td>${rm(sym)}</tr>`;
    if(q.error) return `<tr><td colspan="${cols.length}" style="font-size:12px"><span class="td-ticker">${sym}</span> · <span style="color:var(--red)">${q.error}</span></td>${rm(sym)}</tr>`;
    return '<tr>'+cols.map(c=>_screenerCell(c.key,v)).join('')+rm(sym)+'</tr>';
  }).join('');
}
let _screenerLoading=false;
async function loadScreener(force){
  const status=document.getElementById('screener-status');
  renderScreenerControls();
  if(!screenerSymbols.length){ renderScreener(); if(status)status.textContent=''; return; }
  if(_screenerLoading && !force) return;
  _screenerLoading=true;
  renderScreener(_lastQuotes); // keep showing last data while refreshing
  if(status) status.textContent = screenerDate
    ? ('Loading daily snapshot for '+screenerDate+'…')
    : ('Fetching live data ('+(TF_LABEL[screenerTF]||screenerTF)+')…');
  // Snapshot the previous load's metrics so we can color Vol Traded ($) / RVOL green↑ / red↓.
  const prevVD={}, prevRV={};
  Object.keys(_lastQuotes).forEach(s=>{ const q=_lastQuotes[s]; if(q&&!q.error){ prevVD[s]=(q.curVol||0)*(q.price||0); prevRV[s]=(q.avgVol?(q.curVol||0)/q.avgVol:0); } });
  const dateParam = screenerDate ? ('&date='+encodeURIComponent(screenerDate)) : '';
  const quotes={};
  await Promise.all(screenerSymbols.map(async sym=>{
    try{ const r=await fetch('/api/quote?symbol='+encodeURIComponent(sym)+'&tf='+encodeURIComponent(screenerTF)+dateParam); quotes[sym]=await r.json(); }
    catch(e){ quotes[sym]={symbol:sym,error:'offline'}; }
  }));
  // Direction vs previous load (neutral on first sight / no change).
  screenerSymbols.forEach(sym=>{
    const q=quotes[sym]; if(!q||q.error) return;
    const vd=(q.curVol||0)*(q.price||0), rv=(q.avgVol?(q.curVol||0)/q.avgVol:0);
    _volDollarDir[sym]=(prevVD[sym]==null)?0:(vd>prevVD[sym]?1:vd<prevVD[sym]?-1:0);
    _rvolDir[sym]=(prevRV[sym]==null)?0:(rv>prevRV[sym]?1:rv<prevRV[sym]?-1:0);
  });
  _lastQuotes=quotes;
  renderScreener(quotes);
  if(status){
    if(screenerDate){
      let asOf=screenerDate;
      for(const s of screenerSymbols){ const q=quotes[s]; if(q&&q.asOf){ asOf=q.asOf; break; } }
      status.textContent='Daily snapshot · as of '+asOf+' (close of day)';
    } else {
      status.textContent=(TF_LABEL[screenerTF]||screenerTF)+' · updated '+new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    }
  }
  _screenerLoading=false;
}

// Auto-refresh live volume/price every 45s while the Screener tab is open.
// (Assumes your screener page element id is "page-screener" and gets class
//  "active" when shown. Adjust the id/condition to match your router.)
setInterval(function(){
  try {
    const p = document.getElementById('page-screener');
    if (p && p.classList.contains('active') && typeof screenerSymbols !== 'undefined' && screenerSymbols.length && !screenerDate) loadScreener(true);
  } catch(e){}
}, 45000);
