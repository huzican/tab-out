# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Tab Out is a Chrome extension (Manifest V3) that replaces the new tab page with a dashboard showing all open tabs grouped by domain. It's a pure extension — no server, no build tools, no npm. All persistence uses `chrome.storage.local` and `localStorage`.

## Structure

```
extension/
├── manifest.json      # Manifest V3, permissions: tabs, activeTab, storage
├── index.html         # New tab page (the dashboard)
├── app.js             # All dashboard logic (~1700 lines)
├── style.css          # All styles including dark mode
├── background.js      # Service worker (badge count updates)
├── config.local.js    # Optional gitignored custom grouping rules
└── icons/             # 16/48/128 PNG + SVG icons
```

## No Build Commands

No npm, no bundler, no linter, no tests. Pure vanilla JS/HTML/CSS loaded directly by Chrome.

To develop: load `extension/` as an unpacked extension in `chrome://extensions` (Developer mode).

## Architecture

### Data Flow
```
chrome.tabs.query() → app.js groups by domain → renders masonry cards
User actions → chrome.tabs.remove/update → re-render
```

### Storage
- **`chrome.storage.local`** key `"deferred"` — saved-for-later tabs (array of `{id, url, title, savedAt, completed, dismissed}`)
- **`chrome.storage.local`** key `"tabout-config"` — user settings (userName, pomodoro, clock, search engine, quick links, quote)
- **`localStorage`** keys — dark mode preference (`tabout-dark-mode`), pomodoro state (`tabout-pomodoro`), weather cache (`tabout-weather`), recently closed tabs (`tabout-recently-closed`)
  - Dark mode uses localStorage (sync) instead of chrome.storage (async) to prevent flash on page load

### Tab Grouping
- Tabs grouped by `new URL(tab.url).hostname`
- Landing pages (Gmail inbox, X home, LinkedIn, GitHub, YouTube home) pulled into a special "Homepages" group — closed by exact URL, not hostname
- Custom groups via optional `config.local.js` (merge subdomains, split by path)

### Key Features
- Smart title cleanup (strips notification counts, trailing site names, extracts GitHub issues/PRs, tweet authors)
- Duplicate detection with `(Nx)` badges and one-click dedup
- Save for later → chrome.storage.local, sidebar checklist with archive
- Dark mode, pomodoro timer, live clock, weather, search bar, quick links, daily quotes
- Settings modal for all configuration
- Recently closed tabs tracking (localStorage, max 20)
- Confetti + swoosh sound on tab close (Web Audio API synthesized)
- Extension badge shows real-time tab count with color coding (green/amber/red)

### Event Handling
All click events use a single delegated listener on `document` matching `[data-action]` attributes. Actions include: `close-domain-tabs`, `focus-tab`, `close-single-tab`, `defer-single-tab`, `dedup-keep-one`, `expand-chips`, etc.
