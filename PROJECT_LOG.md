# Pete's Trade Dash 2026 — Project Log & Build Summary

A reference record of how this dashboard works and everything built. Paste this into a
new Claude Code session to give it full context.

## What it is
Single-file HTML trading dashboard (`petes_trade_dash_2026.html`, inline CSS + JS) served by a
Node.js + Express server (`server.js`). Data auto-saves to `data/dashboard-data.json` and syncs
to a Supabase cloud storage bucket.

## Run it
1. Install Node.js (`winget install OpenJS.NodeJS.LTS`)
2. `npm install` (Express + Multer)
3. `npm start` → http://localhost:3000 (auto-opens browser)

## Data persistence (layers)
- Auto-save ~0.4s after any change (local file)
- Force-save on tab close
- Supabase cloud sync (coalesced ~5s) via secret key in `supabase-config.json` (gitignored)
- Timestamped local backups in `backups/`; full copy in Desktop "…(Back Up)" folder
- NEVER edit `data/dashboard-data.json` with PowerShell text commands (BOM/encoding corruption) — use Node or the UI.
- Cloud config is storage-bucket based; server auto-creates the private "dashboard" bucket.
- DATA syncs between computers automatically; CODE/features do not (copy the file or use Git).

## Pages / features

### News & Watchlist
News & Catalyst log; Hype Sector log; Daily/Weekly Watchlists; 𝕏 Feed panels;
Breaking News (aggregates WSJ, Benzinga, MarketWatch, CNBC, Yahoo, Investing.com, auto-refresh 2 min);
Live News with grouped source pills (Investing.com, Benzinga, MarketWatch, WSJ, Yahoo, CNBC);
ticker news search.

### Daily Report Card & Trade Journal (default tab)
- **Daily Report Card**: auto Routine & Management scores; auto overall /5 score with reason+advice;
  Missed Trades reason checklist (shared list incl. custom reasons).
- **Daily Rules**: Daily Target $ / Daily Loss $ params; auto-detect target-hit & max-loss-hit from
  the day's PnL; 45-min reset timer; global red STOP-TRADING banner when triggered.
  Trading day rolls over at 03:00 BKK.
- **Trade Journal**: full trade log. **Trades of the Day**: separate log for missed/spotted trades.
- Trade modal fields: date, ticker, Entry/Exit/Potential-Exit time (BKK 24h + auto NY time +
  Total & Potential trade duration), setup (grouped by category), criteria (add/remove, synced
  with Playbook, live feedback comment), Planned RR, Actual Reward (R), Reward Potential (R), PnL,
  W/L, screenshots (drag-drop, multi-zoom lightbox), Trade Management checklist (✓/✗),
  Trading Mistakes (tap-to-flag, custom library), Goal tracker. Trades of the Day adds a
  Missed-Trade reason checklist (custom reasons supported). Click a row to edit; trash to delete.

### Playbook (Personal) + Playbook (Secondary Ideas)
Setups with desc/criteria/rules/notes/grade/tags/screenshots. Screenshots: drag-to-swap between
main and thumbnails, multi-zoom lightbox. Per-setup stats: Win rate (journal), Avg R:R (avg Reward
Potential across journal+TOD), Trades (journal), Avg Duration (journal), Grade. Grade filter A/B/C.
Criteria are add/remove and synced with the trade modal. **Majority Criteria banner** appears when
(3+ green flags & 0 red) OR (>4 green & <3 red): "MAJORITY CRITERIA HIT — Take the trade no matter what!"

### Performance & Stats (Trade Journal unless noted)
Total PnL, Total Win Rate, Avg Reward (winning trades only, shows — if none), Avg Reward Potential;
Equity Curve (cumulative $ from a Starting Balance setting; date labels);
PnL per trade (date labels, slim bars); Avg Reward (R) by Day bar chart (green = avg Reward Potential
journal+TOD, orange = avg Actual Reward journal); Mistakes Made (chart auto-sizes to all labels + ranked
breakdown); **Setup Performance** (best win rate + best R:R highlights + ranked table); Goals Achieved;
Missed Trades (reason summary + table); Wins by Session (BKK windows) — Journal & Trades of the Day shown separately.

### Psychology / Trade Management
Setup selector (left side); pre-trade commitment; RR capture; reminders; "ask yourself before exiting"
questions incl. dynamic avg-trade-duration and avg-POTENTIAL-duration questions; trailing options;
setup-specific notes; honest verdict (hold vs exit). Notes & Reminders subtab.

### Topbar (global)
- In-trade **Stopwatch** (icon button): click to start counting up; Reset returns to 00:00;
  "In a trade?" setup dropdown shows that setup's average potential trade duration and flips to
  "✓ reached" once elapsed time passes it.
- Theme toggle (orange/teal).

### Claude Analysis & Recommendation (sidebar tab)
Auto-generated insights from logged data + dashboard improvement ideas.

## Conventions
- Times entered in BKK 24h. US sessions in BKK: Opening 20:30–21:29, Mid Morning 21:30–22:59,
  Lunchtime Lull 23:00–01:59, Power Hour 02:00–03:00.
- Trading day boundary = 03:00 BKK (computed from UTC epoch).
- Performance reflects the Trade Journal (real trades). Trades of the Day = missed/not-taken.

## To-do / next
- GitHub setup so code syncs between work + home computers (avoids manual zip uploads).
