// keepalive-supabase.js
// Pings the dashboard's Supabase project so the FREE tier never hits its ~7-day
// inactivity auto-pause. Any HTTP response from the project counts as "activity",
// so this keeps it awake. Run by a Windows scheduled task (via keepalive-supabase.vbs).
// It reads the same supabase-config.json the server uses — no secrets are hard-coded.
const path = require('path');
const fs = require('fs');

const CFG = path.join(__dirname, 'supabase-config.json');
const LOG = path.join(__dirname, 'keepalive.log');

function log(msg) {
  const line = new Date().toISOString() + '  ' + msg;
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
  console.log(line);
}

(async () => {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CFG, 'utf8')); }
  catch (e) { log('keep-alive ABORT: cannot read supabase-config.json (' + e.message + ')'); process.exit(1); }

  const url = (cfg.url || '').replace(/\/+$/, '');
  const key = cfg.key || '';
  if (!url || !key || cfg.enabled === false) { log('keep-alive SKIP: cloud not configured/enabled'); process.exit(0); }
  const h = { apikey: key, Authorization: 'Bearer ' + key };

  // Hit two surfaces so at least one registers as project activity.
  const targets = [
    ['rest',    url + '/rest/v1/'],                                      // PostgREST root (touches the database)
    ['storage', url + '/storage/v1/object/dashboard/dashboard-data.json'] // storage (what the app itself uses)
  ];

  let reached = false;
  for (const [name, u] of targets) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const r = await fetch(u, { headers: h, signal: ctrl.signal });
      clearTimeout(timer);
      reached = true;                 // any HTTP response = the request reached the live project
      log('ping ' + name + ' -> HTTP ' + r.status);
    } catch (e) {
      // ENOTFOUND / fetch failed = the project is paused or unreachable (a ping can't un-pause it)
      log('ping ' + name + ' -> ERROR ' + (e.message || e));
    }
  }
  log(reached ? 'keep-alive OK (project is awake)' : 'keep-alive FAILED: project unreachable — may be paused; restore it in the Supabase dashboard');

  // Keep the log small.
  try {
    const lines = fs.readFileSync(LOG, 'utf8').trim().split('\n');
    if (lines.length > 300) fs.writeFileSync(LOG, lines.slice(-300).join('\n') + '\n');
  } catch (e) {}

  process.exit(reached ? 0 : 1);
})();
