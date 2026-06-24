# Stock Screener — portable install kit

This folder is a self-contained copy of the Stock Screener feature from the other
trading dashboard. It contains **everything except the theme** — it references CSS
variables and class names instead of hard-coding any colors or fonts, so it adopts
*your* dashboard's look automatically.

The two dashboards stay 100% independent: this is a copy, not a shared module.
Nothing here imports from, or talks to, the other project.

## Files

| File | What it is | Where it goes |
|------|-----------|---------------|
| `server-quote-endpoint.js` | Backend `GET /api/quote` (Yahoo Finance proxy, no API key) | Paste into your Express server file, above `app.listen(...)` |
| `screener.page.html` | (A) nav link + (B) the page markup | Paste each part into your dashboard HTML |
| `screener.js` | The whole front-end engine (state, render, fetch, auto-refresh) | Paste into your dashboard's `<script>` |

## Install steps

1. **Backend.** Open `server-quote-endpoint.js`, copy all of it, paste into your
   server file above `app.listen(...)`. Requires Node 18+ (global `fetch`); on
   older Node run `npm i node-fetch` and add `const fetch = require('node-fetch');`.
   No API keys, no new services.

2. **Markup.** From `screener.page.html`: paste part **(A)** into your sidebar/nav,
   and part **(B)** next to your other `.page` sections. Make sure clicking the nav
   item routes to the screener page and that your router adds class **`active`** to
   `#page-screener` when it's shown (the auto-refresh + first load depend on it).

3. **Script.** Paste all of `screener.js` into your `<script>`. Then hook it into
   your page router so it loads when the tab opens — find where your router handles
   page switches and add:
   ```js
   if (key === 'screener') { renderScreenerControls(); setTimeout(() => loadScreener(), 30); }
   ```
   (Use whatever your router's page key / function is.)

4. **Persistence (optional but recommended).** `screener.js` calls `scheduleSave()`
   whenever state changes. Point that at your existing "save dashboard state"
   function. To **save**, include these keys in the object you persist:
   ```js
   screenerSymbols, screenerTF, screenerHidden, screenerSort,
   screenerDate, screenerHighlights, screenerColorFilter
   ```
   To **restore** on load (after the script has defined the globals):
   ```js
   if (Array.isArray(d.screenerSymbols) && d.screenerSymbols.length) screenerSymbols.push(...d.screenerSymbols);
   if (d.screenerTF) screenerTF = d.screenerTF;
   if (d.screenerHidden && typeof d.screenerHidden === 'object') Object.assign(screenerHidden, d.screenerHidden);
   if (d.screenerSort && typeof d.screenerSort === 'object') Object.assign(screenerSort, d.screenerSort);
   if (typeof d.screenerDate === 'string') screenerDate = d.screenerDate;
   if (d.screenerHighlights && typeof d.screenerHighlights === 'object') Object.assign(screenerHighlights, d.screenerHighlights);
   if (typeof d.screenerColorFilter === 'string') screenerColorFilter = d.screenerColorFilter;
   ```
   Store this in **your** dashboard's own data store — never the other one's.
   If you don't have a save system, replace `scheduleSave()` with a no-op and the
   screener still works for the session.

## Theme contract — what it borrows from your CSS

The screener **does not ship a theme**. It uses these tokens/classes, which your
dashboard almost certainly already defines. If any are missing or named
differently, add an alias or rename inside the pasted code:

**CSS variables:** `--fd` (mono/number font), `--text`, `--muted`, `--surface`,
`--border2`, `--green`, `--red`, `--accent2`. (`--accent`, `--border` may also
appear in the nav/page wrappers.)

**CSS classes (your existing components):** `nav-item`, `page`, `tl-page`,
`add-trade-btn`, `topbar-tag` (chips; needs an `.active` state), `log-table`,
`empty-log`, `td-ticker`. Rename these in the pasted snippets to match your
dashboard's equivalents if they differ.

**Icons:** the markup uses Tabler Icons (`<i class="ti ti-...">`). If you don't
load Tabler, swap them for your icon set or plain text.

> Note: a few faint neutral shades (e.g. `rgba(255,255,255,0.3)` for em-dashes) and
> the highlight chip colors (green/orange/yellow at low alpha) are inlined. These
> are intentionally theme-neutral, but if your dashboard is light-themed, change the
> `rgba(255,255,255,...)` placeholders to a dark rgba so faint text stays visible.

## Feature checklist (so you can confirm parity)

- Add/remove symbols (comma-separated multi-add), Refresh button
- Columns, all individually show/hide: Symbol, Market Cap, Vol Traded ($),
  Avg D Vol 20D ($), Current Price, % Chg (regular), % Chg (ext, with PRE/AH tag),
  RVOL, Volume Chart (sparkline)
- Timeframe: Daily / 1h / 30m / 5m (disabled while viewing a past date)
- Date stepper (◀ ▶, weekday-aware) + date picker + Live button → historical
  close-of-day snapshots
- Click a header to sort, click again to flip; no-data rows sink to bottom
- Click a ticker to cycle highlight (none→green→orange→yellow); Highlight filter
  shows only one color
- Vol Traded ($) and RVOL cells flash green/red vs the previous refresh
- Live auto-refresh every 45s while the tab is open
- Status line: live "updated {time}" vs historical "as of {date} (close of day)"
