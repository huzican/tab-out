<div align="center">

# Tab Out

**Keep tabs on your tabs.**

![Chrome](https://img.shields.io/badge/Chrome-Extension-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-34A853?style=for-the-badge)
![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)

</div>

---

Tab Out replaces your Chrome new tab page with a dashboard that shows everything you have open — grouped by domain, with landing pages pulled into their own group. Close tabs with a satisfying swoosh + confetti.

No server. No account. No build tools. Just a Chrome extension.

---

## Features

### Tab Management
- **Domain grouping** — open tabs automatically grouped by domain into clean cards
- **Homepages group** — Gmail inbox, X home, YouTube, LinkedIn, GitHub homepages get their own card
- **Click to jump** — click any tab title to switch to it, even across windows
- **Close with style** — swoosh sound + confetti burst when you close a group
- **Close single tab** — X button on each tab to close just that one
- **Duplicate detection** — flags duplicates with `(2x)` badge, one-click "Close duplicates"
- **Expandable groups** — shows first 8 tabs, click "+N more" to reveal the rest
- **Real-time sync** — dashboard auto-updates when you open/close tabs in other windows

### Drag & Drop
- **Reorder tabs** — drag tabs within a group to rearrange
- **Move tabs** — drag a tab from one domain group to another
- **Reorder groups** — drag entire domain cards to rearrange
- **Persistent** — drag-and-drop changes survive page refresh

### Save for Later
- **Bookmark before closing** — save any tab to a checklist, then close it
- **Checklist** — check off saved tabs when you're done with them
- **Archive** — completed items move to a searchable archive
- **Below tabs** — saved items and archive appear below the tab grid

### Productivity
- **Dark mode** — sun/moon toggle, persists across sessions
- **Live clock** — configurable 12/24h format with optional seconds
- **Pomodoro timer** — 25/5 work-break timer, survives tab closes
- **Weather** — current conditions in the header (via wttr.in, no API key)
- **Search bar** — configurable engine (Google, Bing, DuckDuckGo, Brave, Ecosia)
- **Quick links** — row of favicon shortcuts, drag to reorder
- **Personalized greeting** — "Good morning, [name]" with your configured name
- **Recently closed** — collapsible list of last 20 closed tabs, click to reopen

### Keyboard Shortcut
- **`Alt+T`** — instantly jump to Tab Out from any window (customizable in `chrome://extensions/shortcuts`)

### Privacy
- **100% local** — no data sent anywhere, no external API calls (except weather)
- **No server** — pure Chrome extension, no Node.js, no npm
- **No account** — no sign-up, no cloud sync

---

## Install

**1. Clone**

```bash
git clone https://github.com/huzican/tab-out.git
```

**2. Load in Chrome**

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder

**3. Open a new tab** — you'll see Tab Out.

**4. (Optional) Set keyboard shortcut**

Go to `chrome://extensions/shortcuts` to customize the `Alt+T` shortcut.

---

## Settings

Click the gear icon in the top-right to configure:

| Setting | Options |
|---------|---------|
| Your name | Personalizes the greeting |
| Clock format | 12-hour / 24-hour, show seconds |
| Pomodoro | Work duration (1–120 min), break duration (1–60 min) |
| Search engine | Google, Bing, DuckDuckGo, Brave, Ecosia |
| Quick links | Add, remove, drag to reorder |

All settings stored locally in `chrome.storage.local`.

---

## Custom Grouping

Create `extension/config.local.js` (gitignored) to customize tab grouping:

```javascript
// Merge all *.github.io sites into one group
const LOCAL_CUSTOM_GROUPS = [
  {
    hostnameEndsWith: '.github.io',
    groupKey: 'github-pages',
    groupLabel: 'GitHub Pages'
  }
];

// Add extra landing page patterns
const LOCAL_LANDING_PAGE_PATTERNS = [
  { hostname: 'calendar.google.com', pathExact: ['/'] }
];
```

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Extension | Chrome Manifest V3 |
| Storage | `chrome.storage.local` + `localStorage` |
| Sound | Web Audio API (synthesized, no files) |
| Animations | CSS transitions + JS confetti particles |
| Layout | CSS columns (masonry) |
| Fonts | Newsreader + DM Sans (Google Fonts) |
| Build tools | None — pure HTML/CSS/JS |

---

## License

MIT

---

Originally built by [Zara](https://x.com/zarazhangrui). This fork adds dark mode, search, weather, pomodoro timer, drag-and-drop, recently closed tabs, keyboard shortcut, and real-time tab sync.
