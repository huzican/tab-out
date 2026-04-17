/* ================================================================
   Tab Out — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   APP CONFIG — chrome.storage.local
   ---------------------------------------------------------------- */

const CONFIG_DEFAULTS = {
  userName: '',
  pomodoroWorkMinutes: 25,
  pomodoroBreakMinutes: 5,
  clockShowSeconds: false,
  clockFormat: '12',
  searchEngine: 'google',
  quickLinks: [
    { title: 'Gmail',    url: 'https://mail.google.com' },
    { title: 'GitHub',   url: 'https://github.com' },
    { title: 'YouTube',  url: 'https://youtube.com' },
    { title: 'Twitter',  url: 'https://x.com' },
    { title: 'LinkedIn', url: 'https://linkedin.com' },
  ],
};

let appConfig = { ...CONFIG_DEFAULTS };

async function loadConfig() {
  try {
    const { 'tabout-config': saved } = await chrome.storage.local.get('tabout-config');
    if (saved) appConfig = { ...CONFIG_DEFAULTS, ...saved };
  } catch { /* first run — use defaults */ }
}

async function saveConfig(updates) {
  appConfig = { ...appConfig, ...updates };
  await chrome.storage.local.set({ 'tabout-config': appConfig });
}



/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * Sets the extensionId flag so we can identify Tab Out's own pages.
 */
async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    // The new URL for this page is now index.html (not newtab.html)
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    const tabs = await chrome.tabs.query({});
    openTabs = tabs.map(t => ({
      id:       t.id,
      url:      t.url,
      title:    t.title,
      windowId: t.windowId,
      active:   t.active,
      // Flag Tab Out's own pages so we can detect duplicate new tabs
      favIconUrl: t.favIconUrl || '',
      isTabOut: t.url === newtabUrl || t.url === 'chrome://newtab/',
    }));
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
  }
}

/**
 * closeTabsByUrls(urls)
 *
 * Closes all open tabs whose hostname matches any of the given URLs.
 * After closing, re-fetches the tab list to keep our state accurate.
 *
 * Special case: file:// URLs are matched exactly (they have no hostname).
 */
async function closeTabsByUrls(urls) {
  if (!urls || urls.length === 0) return;

  // Separate file:// URLs (exact match) from regular URLs (hostname match)
  const targetHostnames = [];
  const exactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith('file://')) {
      exactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); }
      catch { /* skip unparseable */ }
    }
  }

  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs
    .filter(tab => {
      const tabUrl = tab.url || '';
      if (tabUrl.startsWith('file://') && exactUrls.has(tabUrl)) return true;
      try {
        const tabHostname = new URL(tabUrl).hostname;
        return tabHostname && targetHostnames.includes(tabHostname);
      } catch { return false; }
    })
    .map(tab => tab.id);

  if (toClose.length > 0) {
    // Track recently closed
    for (const id of toClose) {
      const tab = allTabs.find(t => t.id === id);
      if (tab) addRecentlyClosed({ url: tab.url, title: tab.title });
    }
    await chrome.tabs.remove(toClose);
  }
  await fetchOpenTabs();
}

/**
 * closeTabsExact(urls)
 *
 * Closes tabs by exact URL match (not hostname). Used for landing pages
 * so closing "Gmail inbox" doesn't also close individual email threads.
 */
async function closeTabsExact(urls) {
  if (!urls || urls.length === 0) return;
  const urlSet = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs.filter(t => urlSet.has(t.url)).map(t => t.id);
  if (toClose.length > 0) {
    for (const id of toClose) {
      const tab = allTabs.find(t => t.id === id);
      if (tab) addRecentlyClosed({ url: tab.url, title: tab.title });
    }
    await chrome.tabs.remove(toClose);
  }
  await fetchOpenTabs();
}

/**
 * focusTab(url)
 *
 * Switches Chrome to the tab with the given URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
async function focusTab(url) {
  if (!url) return;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  // Try exact URL match first
  let matches = allTabs.filter(t => t.url === url);

  // Fall back to hostname match
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  // Prefer a match in a different window so it actually switches windows
  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true → keep one copy of each, close the rest.
 * keepOne=false → close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const toClose = [];

  for (const url of urls) {
    const matching = allTabs.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabOutDupes()
 *
 * Closes all duplicate Tab Out new-tab pages except the current one.
 */
async function closeTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  if (tabOutTabs.length <= 1) return;

  // Keep the active Tab Out tab in the CURRENT window — that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — chrome.storage.local

   Replaces the old server-side SQLite + REST API with Chrome's
   built-in key-value storage. Data persists across browser sessions
   and doesn't require a running server.

   Data shape stored under the "deferred" key:
   [
     {
       id: "1712345678901",          // timestamp-based unique ID
       url: "https://example.com",
       title: "Example Page",
       savedAt: "2026-04-04T10:00:00.000Z",  // ISO date string
       completed: false,             // true = checked off (archived)
       dismissed: false              // true = dismissed without reading
     },
     ...
   ]
   ---------------------------------------------------------------- */

/**
 * saveTabForLater(tab)
 *
 * Saves a single tab to the "Saved for Later" list in chrome.storage.local.
 * @param {{ url: string, title: string }} tab
 */
async function saveTabForLater(tab) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  deferred.push({
    id:        Date.now().toString(),
    url:       tab.url,
    title:     tab.title,
    savedAt:   new Date().toISOString(),
    completed: false,
    dismissed: false,
  });
  await chrome.storage.local.set({ deferred });
}

/**
 * getSavedTabs()
 *
 * Returns all saved tabs from chrome.storage.local.
 * Filters out dismissed items (those are gone for good).
 * Splits into active (not completed) and archived (completed).
 */
async function getSavedTabs() {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const visible = deferred.filter(t => !t.dismissed);
  return {
    active:   visible.filter(t => !t.completed),
    archived: visible.filter(t => t.completed),
  };
}

/**
 * checkOffSavedTab(id)
 *
 * Marks a saved tab as completed (checked off). It moves to the archive.
 */
async function checkOffSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.completed = true;
    tab.completedAt = new Date().toISOString();
    await chrome.storage.local.set({ deferred });
  }
}

/**
 * dismissSavedTab(id)
 *
 * Marks a saved tab as dismissed (removed from all lists).
 */
async function dismissSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.dismissed = true;
    await chrome.storage.local.set({ deferred });
  }
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low — creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  const colors = [
    '#c8713a', // amber
    '#e8a070', // amber light
    '#5a7a62', // sage
    '#8aaa92', // sage light
    '#5a6b7a', // slate
    '#8a9baa', // slate light
    '#d4b896', // warm paper
    '#b35a5a', // rose
  ];

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');

    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6; // 5–11px
    const color = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    // Physics: random angle and speed for the outward burst
    const angle   = Math.random() * Math.PI * 2;
    const speed   = 60 + Math.random() * 120;
    const vx      = Math.cos(angle) * speed;
    const vy      = Math.sin(angle) * speed - 80; // bias upward
    const gravity = 200;

    const startTime = performance.now();
    const duration  = 700 + Math.random() * 200; // 700–900ms

    function frame(now) {
      const elapsed  = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) { el.remove(); return; }

      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
      const rotate  = elapsed * 200 * (isCircle ? 0 : 1);

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card: fade + scale down, then confetti.
 * After the animation, checks if the grid is now empty.
 */
function animateCardOut(card) {
  if (!card) return;

  const rect = card.getBoundingClientRect();
  shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 300);
}

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * checkAndShowEmptyState()
 *
 * Shows a cheerful "Inbox zero" message when all domain cards are gone.
 */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">Inbox zero, but for tabs.</div>
      <div class="empty-subtitle">You're free.</div>
    </div>
  `;

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 domains';
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}

/**
 * getGreeting() — "Good morning / afternoon / evening"
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * getDateDisplay() — "Friday, April 4, 2026"
 */
function getDateDisplay() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });
}


/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + "'s Substack";
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `Post by @${username}` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} post`;
    }
  }

  return title || url;
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  focus:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
};


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc.
 */
function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

/**
 * checkTabOutDupes()
 *
 * Counts how many Tab Out pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
function checkTabOutDupes() {
  const tabOutTabs = openTabs.filter(t => t.isTabOut);
  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = tabOutTabs.length;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   OVERFLOW CHIPS ("+N more" expand button in domain cards)
   ---------------------------------------------------------------- */

function buildOverflowChips(hiddenTabs, urlCounts = {}) {
  const hiddenChips = hiddenTabs.map(tab => {
    const label    = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), '');
    const count    = urlCounts[tab.url] || 1;
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = tab.favIconUrl || (domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '');
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.src='https://www.google.com/s2/favicons?domain=${domain}&sz=16';this.onerror=null">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">+${hiddenTabs.length} more</span>
    </div>`;
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML for one domain group card.
 * group = { domain: string, tabs: [{ url, title, id, windowId, active }] }
 */
function renderDomainCard(group) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');

  // Count duplicates (exact URL match)
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls   = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes   = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    ${tabCount} tab${tabCount !== 1 ? 's' : ''} open
  </span>`;

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">
        ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </span>`
    : '';

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  const pageChips = visibleTabs.map(tab => {
    let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), group.domain);
    // For localhost tabs, prepend port number so you can tell projects apart
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname === 'localhost' && parsed.port) label = `${parsed.port} ${label}`;
    } catch {}
    const count    = urlCounts[tab.url];
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = tab.favIconUrl || (domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '');
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.src='https://www.google.com/s2/favicons?domain=${domain}&sz=16';this.onerror=null">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('') + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), urlCounts) : '');

  let actionsHtml = `
    <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}">
      ${ICONS.close}
      Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}
    </button>`;

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </button>`;
  }

  return `
    <div class="mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}" data-domain-id="${stableId}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${isLanding ? 'Homepages' : (group.label || friendlyDomain(group.domain))}</span>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — Render Checklist Column
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Reads saved tabs from chrome.storage.local and renders the right-side
 * "Saved for Later" checklist column. Shows active items as a checklist
 * and completed items in a collapsible archive.
 */
async function renderDeferredColumn() {
  const column         = document.getElementById('deferredColumn');
  const list           = document.getElementById('deferredList');
  const empty          = document.getElementById('deferredEmpty');
  const countEl        = document.getElementById('deferredCount');
  const archiveEl      = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');

  if (!column) return;

  try {
    const { active, archived } = await getSavedTabs();

    // Hide the entire column if there's nothing to show
    if (active.length === 0 && archived.length === 0) {
      column.style.display = 'none';
      return;
    }

    column.style.display = 'block';

    // Render active checklist items
    if (active.length > 0) {
      countEl.textContent = `${active.length} item${active.length !== 1 ? 's' : ''}`;
      list.innerHTML = active.map(item => renderDeferredItem(item)).join('');
      list.style.display = 'block';
      empty.style.display = 'none';
    } else {
      list.style.display = 'none';
      countEl.textContent = '';
      empty.style.display = 'block';
    }

    // Render archive section
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      archiveEl.style.display = 'block';
    } else {
      archiveEl.style.display = 'none';
    }

  } catch (err) {
    console.warn('[tab-out] Could not load saved tabs:', err);
    column.style.display = 'none';
  }
}

/**
 * renderDeferredItem(item)
 *
 * Builds HTML for one active checklist item: checkbox, title link,
 * domain, time ago, dismiss button.
 */
function renderDeferredItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
  const ago = timeAgo(item.savedAt);

  return `
    <div class="deferred-item" data-deferred-id="${item.id}">
      <input type="checkbox" class="deferred-checkbox" data-action="check-deferred" data-deferred-id="${item.id}">
      <div class="deferred-info">
        <a href="${item.url}" target="_blank" rel="noopener" class="deferred-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
          <img src="${faviconUrl}" alt="" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px" onerror="this.style.display='none'">${item.title || item.url}
        </a>
        <div class="deferred-meta">
          <span>${domain}</span>
          <span>${ago}</span>
        </div>
      </div>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${item.id}" title="Dismiss">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * renderArchiveItem(item)
 *
 * Builds HTML for one completed/archived item (simpler: just title + date).
 */
function renderArchiveItem(item) {
  const ago = item.completedAt ? timeAgo(item.completedAt) : timeAgo(item.savedAt);
  return `
    <div class="archive-item">
      <a href="${item.url}" target="_blank" rel="noopener" class="archive-item-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
        ${item.title || item.url}
      </a>
      <span class="archive-item-date">${ago}</span>
    </div>`;
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main render function:
 * 1. Paints greeting + date
 * 2. Fetches open tabs via chrome.tabs.query()
 * 3. Groups tabs by domain (with landing pages pulled out to their own group)
 * 4. Renders domain cards
 * 5. Updates footer stats
 * 6. Renders the "Saved for Later" checklist
 */
async function renderStaticDashboard() {
  // --- Header ---
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting() + (appConfig.userName ? `, ${appConfig.userName}` : '');
  if (dateEl)     dateEl.textContent     = getDateDisplay();

  // --- Fetch tabs ---
  await fetchOpenTabs();
  const realTabs = getRealTabs();

  // --- Group tabs by domain ---
  // Landing pages (Gmail inbox, Twitter home, etc.) get their own special group
  // so they can be closed together without affecting content tabs on the same domain.
  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: (p, h) =>
        !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com',               pathExact: ['/home'] },
    { hostname: 'www.linkedin.com',    pathExact: ['/'] },
    { hostname: 'github.com',          pathExact: ['/'] },
    { hostname: 'www.youtube.com',     pathExact: ['/'] },
    // Merge personal patterns from config.local.js (if it exists)
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined' ? LOCAL_LANDING_PAGE_PATTERNS : []),
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(p => {
        // Support both exact hostname and suffix matching (for wildcard subdomains)
        const hostnameMatch = p.hostname
          ? parsed.hostname === p.hostname
          : p.hostnameEndsWith
            ? parsed.hostname.endsWith(p.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  domainGroups = [];
  const groupMap    = {};
  const landingTabs = [];

  // Custom group rules from config.local.js (if any)
  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

  // Load drag-and-drop overrides from storage
  const dragState = await chrome.storage.local.get(['tabout-group-order', 'tabout-tab-moves', 'tabout-tab-order']);
  const savedGroupOrder = dragState['tabout-group-order'] || null;     // [domain1, domain2, ...]
  const savedTabMoves   = dragState['tabout-tab-moves']   || {};       // { tabUrl: targetDomainKey }
  const savedTabOrder   = dragState['tabout-tab-order']   || {};       // { domainKey: [url1, url2, ...] }

  // Check if a URL matches a custom group rule; returns the rule or null
  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(r => {
        const hostMatch = r.hostname
          ? parsed.hostname === r.hostname
          : r.hostnameEndsWith
            ? parsed.hostname.endsWith(r.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
        return true; // hostname matched, no path filter
      }) || null;
    } catch { return null; }
  }

  for (const tab of realTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      // Check custom group rules first (e.g. merge subdomains, split by path)
      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue;

      if (!groupMap[hostname]) groupMap[hostname] = { domain: hostname, tabs: [] };
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  // --- Apply saved cross-group tab moves ---
  // Tabs the user previously dragged to a different group
  for (const [tabUrl, targetDomain] of Object.entries(savedTabMoves)) {
    // Find which group currently has this tab
    let sourceGroup = null, tabIdx = -1;
    for (const g of Object.values(groupMap)) {
      const idx = g.tabs.findIndex(t => t.url === tabUrl);
      if (idx !== -1) { sourceGroup = g; tabIdx = idx; break; }
    }
    if (!sourceGroup || tabIdx === -1) continue;
    // Target group must exist (tab might have been closed)
    if (!groupMap[targetDomain]) continue;
    if (sourceGroup.domain === targetDomain) continue;
    const [tab] = sourceGroup.tabs.splice(tabIdx, 1);
    groupMap[targetDomain].tabs.push(tab);
  }

  // Remove empty groups after moves
  for (const key of Object.keys(groupMap)) {
    if (groupMap[key].tabs.length === 0) delete groupMap[key];
  }

  // Clean up stale move entries (tabs that no longer exist)
  const openUrls = new Set(realTabs.map(t => t.url));
  let movesChanged = false;
  for (const url of Object.keys(savedTabMoves)) {
    if (!openUrls.has(url)) { delete savedTabMoves[url]; movesChanged = true; }
  }
  if (movesChanged) chrome.storage.local.set({ 'tabout-tab-moves': savedTabMoves });

  // --- Apply saved tab order within groups ---
  for (const [domainKey, urlOrder] of Object.entries(savedTabOrder)) {
    const group = groupMap[domainKey];
    if (!group) continue;
    const orderMap = {};
    urlOrder.forEach((url, i) => { orderMap[url] = i; });
    group.tabs.sort((a, b) => {
      const ai = orderMap[a.url] ?? 9999;
      const bi = orderMap[b.url] ?? 9999;
      return ai - bi;
    });
  }

  // Sort: landing pages first, then domains from landing page sites, then by tab count
  // Collect exact hostnames and suffix patterns for priority sorting
  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname).filter(Boolean));
  const landingSuffixes = LANDING_PAGE_PATTERNS.map(p => p.hostnameEndsWith).filter(Boolean);
  function isLandingDomain(domain) {
    if (landingHostnames.has(domain)) return true;
    return landingSuffixes.some(s => domain.endsWith(s));
  }
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aIsPriority = isLandingDomain(a.domain);
    const bIsPriority = isLandingDomain(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;

    return b.tabs.length - a.tabs.length;
  });

  // --- Apply saved group order (from drag-and-drop) ---
  if (savedGroupOrder && savedGroupOrder.length > 0) {
    const orderMap = {};
    savedGroupOrder.forEach((d, i) => { orderMap[d] = i; });
    domainGroups.sort((a, b) => {
      const ai = orderMap[a.domain] ?? 9999;
      const bi = orderMap[b.domain] ?? 9999;
      return ai - bi;
    });
  }

  // --- Render domain cards ---
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');

  if (domainGroups.length > 0 && openTabsSection) {
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Open tabs';
    openTabsSectionCount.innerHTML = `${domainGroups.length} domain${domainGroups.length !== 1 ? 's' : ''} &nbsp;&middot;&nbsp; <button class="action-btn close-tabs" data-action="close-all-open-tabs" style="font-size:11px;padding:3px 10px;">${ICONS.close} Close all ${realTabs.length} tabs</button>`;
    openTabsMissionsEl.innerHTML = domainGroups.map(g => renderDomainCard(g)).join('');
    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    openTabsSection.style.display = 'none';
  }

  // --- Footer stats ---
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = openTabs.length;

  // --- Check for duplicate Tab Out tabs ---
  checkTabOutDupes();

  // --- Render "Saved for Later" section ---
  await renderDeferredColumn();

  // --- Enable drag-and-drop ---
  makeDraggable();
}

async function renderDashboard() {
  await renderStaticDashboard();
  initDragAndDrop();
}


/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM to find the nearest element with data-action
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  // ---- Close duplicate Tab Out tabs ----
  if (action === 'close-tabout-dupes') {
    await closeTabOutDupes();
    playCloseSound();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast('Closed extra Tab Out tabs');
    return;
  }

  const card = actionEl.closest('.mission-card');

  // ---- Expand overflow chips ("+N more") ----
  if (action === 'expand-chips') {
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) await focusTab(tabUrl);
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    // Close the tab in Chrome directly
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) {
      addRecentlyClosed({ url: match.url, title: match.title });
      await chrome.tabs.remove(match.id);
    }
    await fetchOpenTabs();

    playCloseSound();

    // Animate the chip row out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        // If the card now has no tabs, remove it too
        const parentCard = document.querySelector('.mission-card:has(.mission-pages:empty)');
        if (parentCard) animateCardOut(parentCard);
        document.querySelectorAll('.mission-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    }

    // Update footer
    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;

    showToast('Tab closed');
    renderRecentlyClosed();
    return;
  }

  // ---- Save a single tab for later (then close it) ----
  if (action === 'defer-single-tab') {
    e.stopPropagation();
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    // Save to chrome.storage.local
    try {
      await saveTabForLater({ url: tabUrl, title: tabTitle });
    } catch (err) {
      console.error('[tab-out] Failed to save tab:', err);
      showToast('Failed to save tab');
      return;
    }

    // Close the tab in Chrome
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    // Animate chip out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => chip.remove(), 200);
    }

    showToast('Saved for later');
    await renderDeferredColumn();
    return;
  }

  // ---- Check off a saved tab (moves it to archive) ----
  if (action === 'check-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await checkOffSavedTab(id);

    // Animate: strikethrough first, then slide out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('checked');
      setTimeout(() => {
        item.classList.add('removing');
        setTimeout(() => {
          item.remove();
          renderDeferredColumn(); // refresh counts and archive
        }, 300);
      }, 800);
    }
    return;
  }

  // ---- Dismiss a saved tab (removes it entirely) ----
  if (action === 'dismiss-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await dismissSavedTab(id);

    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn();
      }, 300);
    }
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const group    = domainGroups.find(g => {
      return 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId;
    });
    if (!group) return;

    const urls      = group.tabs.map(t => t.url);
    // Landing pages and custom groups (whose domain key isn't a real hostname)
    // must use exact URL matching to avoid closing unrelated tabs
    const useExact  = group.domain === '__landing-pages__' || !!group.label;

    if (useExact) {
      await closeTabsExact(urls);
    } else {
      await closeTabsByUrls(urls);
    }

    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    // Remove from in-memory groups
    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    const groupLabel = group.domain === '__landing-pages__' ? 'Homepages' : (group.label || friendlyDomain(group.domain));
    showToast(`Closed ${urls.length} tab${urls.length !== 1 ? 's' : ''} from ${groupLabel}`);
    renderRecentlyClosed();

    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await closeDuplicateTabs(urls, true);
    playCloseSound();

    // Hide the dedup button
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity    = '0';
    setTimeout(() => actionEl.remove(), 200);

    // Remove dupe badges from the card
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity    = '0';
        setTimeout(() => b.remove(), 200);
      });
      card.querySelectorAll('.open-tabs-badge').forEach(badge => {
        if (badge.textContent.includes('duplicate')) {
          badge.style.transition = 'opacity 0.2s';
          badge.style.opacity    = '0';
          setTimeout(() => badge.remove(), 200);
        }
      });
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
    }

    showToast('Closed duplicates, kept one copy each');
    return;
  }

  // ---- Close ALL open tabs ----
  if (action === 'close-all-open-tabs') {
    const allUrls = openTabs
      .filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
      .map(t => t.url);
    await closeTabsByUrls(allUrls);
    playCloseSound();

    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      shootConfetti(
        c.getBoundingClientRect().left + c.offsetWidth / 2,
        c.getBoundingClientRect().top  + c.offsetHeight / 2
      );
      animateCardOut(c);
    });

    showToast('All tabs closed. Fresh start.');
    return;
  }
});

// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});


/* ----------------------------------------------------------------
   DRAG AND DROP — Tabs within/across groups + Group reordering
   ---------------------------------------------------------------- */

let dragData = null; // { type: 'tab'|'card', tabUrl, sourceDomain, groupDomain }

function initDragAndDrop() {
  const container = document.getElementById('openTabsMissions');
  if (!container) return;

  // --- DRAG START ---
  container.addEventListener('dragstart', (e) => {
    const chip = e.target.closest('.page-chip[data-action="focus-tab"]');
    const card = e.target.closest('.mission-card');

    if (chip && !e.target.closest('.chip-action')) {
      // Dragging a tab chip
      const tabUrl = chip.dataset.tabUrl;
      const cardEl = chip.closest('.mission-card');
      const sourceDomain = cardEl ? cardEl.dataset.domainId : '';
      dragData = { type: 'tab', tabUrl, sourceDomain };
      chip.classList.add('dragging-chip');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', tabUrl);
    } else if (card && !chip) {
      // Dragging a group card
      const domainId = card.dataset.domainId;
      dragData = { type: 'card', groupDomain: domainId };
      card.classList.add('dragging-card');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', domainId);
    }
  });

  // --- DRAG OVER ---
  container.addEventListener('dragover', (e) => {
    if (!dragData) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    // Clear previous indicators
    container.querySelectorAll('.drag-over-tab, .drag-over-card').forEach(el => {
      el.classList.remove('drag-over-tab', 'drag-over-card');
    });

    if (dragData.type === 'tab') {
      // Highlight the chip or card being hovered
      const overChip = e.target.closest('.page-chip[data-action="focus-tab"]');
      const overCard = e.target.closest('.mission-card');
      if (overChip) {
        overChip.classList.add('drag-over-tab');
      } else if (overCard) {
        overCard.classList.add('drag-over-card');
      }
    } else if (dragData.type === 'card') {
      const overCard = e.target.closest('.mission-card');
      if (overCard && overCard.dataset.domainId !== dragData.groupDomain) {
        overCard.classList.add('drag-over-card');
      }
    }
  });

  // --- DRAG LEAVE ---
  container.addEventListener('dragleave', (e) => {
    const el = e.target.closest('.drag-over-tab, .drag-over-card');
    if (el) el.classList.remove('drag-over-tab', 'drag-over-card');
  });

  // --- DROP ---
  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    container.querySelectorAll('.drag-over-tab, .drag-over-card, .dragging-chip, .dragging-card').forEach(el => {
      el.classList.remove('drag-over-tab', 'drag-over-card', 'dragging-chip', 'dragging-card');
    });

    if (!dragData) return;

    if (dragData.type === 'tab') {
      await handleTabDrop(e, dragData);
    } else if (dragData.type === 'card') {
      handleCardDrop(e, dragData);
    }

    dragData = null;
  });

  // --- DRAG END ---
  container.addEventListener('dragend', () => {
    container.querySelectorAll('.dragging-chip, .dragging-card, .drag-over-tab, .drag-over-card').forEach(el => {
      el.classList.remove('dragging-chip', 'dragging-card', 'drag-over-tab', 'drag-over-card');
    });
    dragData = null;
  });
}

/**
 * handleTabDrop — move/reorder a tab within or across groups
 */
async function handleTabDrop(e, data) {
  const targetCard = e.target.closest('.mission-card');
  if (!targetCard) return;
  const targetDomainId = targetCard.dataset.domainId;

  // Find source and target groups
  const sourceGroup = domainGroups.find(g => 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === data.sourceDomain);
  const targetGroup = domainGroups.find(g => 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === targetDomainId);
  if (!sourceGroup || !targetGroup) return;

  const tabIdx = sourceGroup.tabs.findIndex(t => t.url === data.tabUrl);
  if (tabIdx === -1) return;
  const [tab] = sourceGroup.tabs.splice(tabIdx, 1);

  // Find target position
  const targetChip = e.target.closest('.page-chip[data-action="focus-tab"]');
  if (targetChip && targetDomainId === data.sourceDomain) {
    // Same group — reorder
    const targetUrl = targetChip.dataset.tabUrl;
    const targetIdx = targetGroup.tabs.findIndex(t => t.url === targetUrl);
    targetGroup.tabs.splice(targetIdx >= 0 ? targetIdx : targetGroup.tabs.length, 0, tab);
  } else {
    // Different group or no specific chip — append
    targetGroup.tabs.push(tab);
  }

  // Remove empty source group
  if (sourceGroup.tabs.length === 0) {
    const idx = domainGroups.indexOf(sourceGroup);
    if (idx !== -1) domainGroups.splice(idx, 1);
  }

  // --- Persist drag state ---
  // Save cross-group moves
  if (sourceGroup.domain !== targetGroup.domain) {
    const { 'tabout-tab-moves': moves = {} } = await chrome.storage.local.get('tabout-tab-moves');
    moves[data.tabUrl] = targetGroup.domain;
    await chrome.storage.local.set({ 'tabout-tab-moves': moves });
  }

  // Save tab order within the target group (and source if still exists)
  const orderUpdate = {};
  orderUpdate[targetGroup.domain] = targetGroup.tabs.map(t => t.url);
  if (sourceGroup.tabs.length > 0) {
    orderUpdate[sourceGroup.domain] = sourceGroup.tabs.map(t => t.url);
  }
  const { 'tabout-tab-order': savedOrder = {} } = await chrome.storage.local.get('tabout-tab-order');
  Object.assign(savedOrder, orderUpdate);
  await chrome.storage.local.set({ 'tabout-tab-order': savedOrder });

  // Re-render affected cards
  reRenderCards();
  showToast('Tab moved');
}

/**
 * handleCardDrop — reorder group cards
 */
function handleCardDrop(e, data) {
  const targetCard = e.target.closest('.mission-card');
  if (!targetCard) return;
  const targetDomainId = targetCard.dataset.domainId;
  if (targetDomainId === data.groupDomain) return;

  const srcIdx = domainGroups.findIndex(g => 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === data.groupDomain);
  const tgtIdx = domainGroups.findIndex(g => 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === targetDomainId);
  if (srcIdx === -1 || tgtIdx === -1) return;

  const [moved] = domainGroups.splice(srcIdx, 1);
  domainGroups.splice(tgtIdx, 0, moved);

  reRenderCards();

  // Save order to storage
  const order = domainGroups.map(g => g.domain);
  chrome.storage.local.set({ 'tabout-group-order': order });
}

/**
 * reRenderCards — re-renders all domain cards from current domainGroups state
 */
function reRenderCards() {
  const missionsEl = document.getElementById('openTabsMissions');
  const countEl = document.getElementById('openTabsSectionCount');
  const sectionEl = document.getElementById('openTabsSection');
  if (!missionsEl) return;

  const realTabs = getRealTabs();

  if (domainGroups.length > 0) {
    countEl.innerHTML = `${domainGroups.length} domain${domainGroups.length !== 1 ? 's' : ''} &nbsp;&middot;&nbsp; <button class="action-btn close-tabs" data-action="close-all-open-tabs" style="font-size:11px;padding:3px 10px;">${ICONS.close} Close all ${realTabs.length} tabs</button>`;
    missionsEl.innerHTML = domainGroups.map(g => renderDomainCard(g)).join('');
    sectionEl.style.display = 'block';
    // Re-enable drag on new elements
    makeDraggable();
  } else if (sectionEl) {
    checkAndShowEmptyState();
  }
}

/**
 * makeDraggable — adds draggable attribute to cards and chips
 */
function makeDraggable() {
  document.querySelectorAll('#openTabsMissions .mission-card').forEach(card => {
    card.draggable = true;
  });
  document.querySelectorAll('#openTabsMissions .page-chip[data-action="focus-tab"]').forEach(chip => {
    chip.draggable = true;
  });
}


// ---- Archive search — filter archived items as user types ----
document.addEventListener('input', async (e) => {
  if (e.target.id !== 'archiveSearch') return;

  const q = e.target.value.trim().toLowerCase();
  const archiveList = document.getElementById('archiveList');
  if (!archiveList) return;

  try {
    const { archived } = await getSavedTabs();

    if (q.length < 2) {
      // Show all archived items
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      return;
    }

    // Filter by title or URL containing the query string
    const results = archived.filter(item =>
      (item.title || '').toLowerCase().includes(q) ||
      (item.url  || '').toLowerCase().includes(q)
    );

    archiveList.innerHTML = results.map(item => renderArchiveItem(item)).join('')
      || '<div style="font-size:12px;color:var(--muted);padding:8px 0">No results</div>';
  } catch (err) {
    console.warn('[tab-out] Archive search failed:', err);
  }
});


/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */

// ---- Search engine config ----
const SEARCH_ENGINES = {
  google:     { action: 'https://www.google.com/search', param: 'q', label: 'Google' },
  bing:       { action: 'https://www.bing.com/search', param: 'q', label: 'Bing' },
  duckduckgo: { action: 'https://duckduckgo.com/', param: 'q', label: 'DuckDuckGo' },
  brave:      { action: 'https://search.brave.com/search', param: 'q', label: 'Brave' },
  ecosia:     { action: 'https://www.ecosia.org/search', param: 'q', label: 'Ecosia' },
};

function updateSearchBar() {
  const form = document.getElementById('searchForm');
  const input = document.getElementById('searchInput');
  if (!form || !input) return;
  const engine = SEARCH_ENGINES[appConfig.searchEngine] || SEARCH_ENGINES.google;
  form.action = engine.action;
  input.name = engine.param;
  input.placeholder = `Search ${engine.label}...`;
}

// ---- Dark mode ----
function initDarkMode() {
  const isDark = localStorage.getItem('tabout-dark-mode') === 'true';
  document.body.classList.toggle('dark-mode', isDark);
  updateDarkModeIcon(isDark);

  document.getElementById('darkModeToggle')?.addEventListener('click', () => {
    const nowDark = document.body.classList.toggle('dark-mode');
    localStorage.setItem('tabout-dark-mode', nowDark);
    updateDarkModeIcon(nowDark);
  });
}

function updateDarkModeIcon(isDark) {
  const icon = document.getElementById('darkModeIcon');
  if (!icon) return;
  if (isDark) {
    // Sun icon for dark mode (click to go light)
    icon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z" />';
  } else {
    // Moon icon for light mode (click to go dark)
    icon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z" />';
  }
}

// ---- Live clock ----
function updateClock() {
  const el = document.getElementById('clock');
  if (!el) return;
  const now = new Date();
  const opts = { hour: 'numeric', minute: '2-digit', hour12: appConfig.clockFormat === '12' };
  if (appConfig.clockShowSeconds) opts.second = '2-digit';
  el.textContent = now.toLocaleTimeString('en-US', opts);
}

// ---- Weather ----
async function loadWeather() {
  const el = document.getElementById('weather');
  if (!el) return;
  try {
    const cached = localStorage.getItem('tabout-weather');
    const cachedTime = parseInt(localStorage.getItem('tabout-weather-time') || '0');
    if (cached && Date.now() - cachedTime < 30 * 60 * 1000) {
      el.textContent = cached;
      return;
    }
    const resp = await fetch('https://wttr.in/?format=%t+%C', { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) throw new Error();
    const text = (await resp.text()).trim();
    el.textContent = text;
    localStorage.setItem('tabout-weather', text);
    localStorage.setItem('tabout-weather-time', Date.now().toString());
  } catch {
    if (!el.textContent) el.style.display = 'none';
  }
}

// ---- Quick links ----
function renderQuickLinks() {
  const container = document.getElementById('quickLinks');
  if (!container) return;
  const links = appConfig.quickLinks || [];
  if (links.length === 0) { container.style.display = 'none'; return; }
  container.style.display = 'flex';

  container.innerHTML = links.map((link, i) => {
    let domain = '';
    try { domain = new URL(link.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=32` : '';
    return `<a class="quick-link" href="${link.url}" target="_top" title="${link.title || domain}" draggable="true" data-ql-index="${i}">
      ${faviconUrl ? `<img src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : `<span>${(link.title || '?')[0]}</span>`}
    </a>`;
  }).join('');

  // Drag-to-reorder
  let dragIdx = null;
  container.addEventListener('dragstart', e => {
    const el = e.target.closest('.quick-link');
    if (el) { dragIdx = parseInt(el.dataset.qlIndex); el.classList.add('dragging'); }
  });
  container.addEventListener('dragover', e => {
    e.preventDefault();
    const el = e.target.closest('.quick-link');
    if (el) el.classList.add('drag-over');
  });
  container.addEventListener('dragleave', e => {
    const el = e.target.closest('.quick-link');
    if (el) el.classList.remove('drag-over');
  });
  container.addEventListener('drop', async e => {
    e.preventDefault();
    const el = e.target.closest('.quick-link');
    if (!el || dragIdx === null) return;
    el.classList.remove('drag-over');
    const dropIdx = parseInt(el.dataset.qlIndex);
    if (dragIdx === dropIdx) return;
    const links = [...appConfig.quickLinks];
    const [moved] = links.splice(dragIdx, 1);
    links.splice(dropIdx, 0, moved);
    await saveConfig({ quickLinks: links });
    renderQuickLinks();
  });
  container.addEventListener('dragend', () => {
    dragIdx = null;
    container.querySelectorAll('.quick-link').forEach(el => el.classList.remove('dragging', 'drag-over'));
  });
}

// ---- Pomodoro timer ----
let pomodoroInterval = null;

function initPomodoro() {
  const timeEl    = document.getElementById('pomodoroTime');
  const labelEl   = document.getElementById('pomodoroLabel');
  const playBtn   = document.getElementById('pomodoroPlayPause');
  const resetBtn  = document.getElementById('pomodoroReset');
  if (!timeEl || !playBtn) return;

  // Load state from localStorage
  const state = JSON.parse(localStorage.getItem('tabout-pomodoro') || 'null') || {
    remaining: appConfig.pomodoroWorkMinutes * 60,
    mode: 'work',
    running: false,
    lastTick: null,
  };

  // Account for elapsed time while page was closed
  if (state.running && state.lastTick) {
    const elapsed = Math.floor((Date.now() - state.lastTick) / 1000);
    state.remaining = Math.max(0, state.remaining - elapsed);
  }

  function saveState() {
    state.lastTick = Date.now();
    localStorage.setItem('tabout-pomodoro', JSON.stringify(state));
  }

  function render() {
    const mins = Math.floor(state.remaining / 60);
    const secs = state.remaining % 60;
    timeEl.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    labelEl.textContent = state.mode;
    timeEl.className = 'pomodoro-time ' + (state.mode === 'work' ? 'pomodoro-work' : 'pomodoro-break');
    playBtn.textContent = state.running ? '⏸' : '▶';
  }

  function tick() {
    if (state.remaining <= 0) {
      // Switch mode
      if (state.mode === 'work') {
        state.mode = 'break';
        state.remaining = appConfig.pomodoroBreakMinutes * 60;
        showToast('Time for a break!');
      } else {
        state.mode = 'work';
        state.remaining = appConfig.pomodoroWorkMinutes * 60;
        showToast('Break over — back to work!');
      }
    } else {
      state.remaining--;
    }
    saveState();
    render();
  }

  function start() {
    if (pomodoroInterval) return;
    state.running = true;
    saveState();
    pomodoroInterval = setInterval(tick, 1000);
    render();
  }

  function pause() {
    state.running = false;
    if (pomodoroInterval) { clearInterval(pomodoroInterval); pomodoroInterval = null; }
    saveState();
    render();
  }

  playBtn.addEventListener('click', () => {
    if (state.running) pause(); else start();
  });

  resetBtn.addEventListener('click', () => {
    pause();
    state.mode = 'work';
    state.remaining = appConfig.pomodoroWorkMinutes * 60;
    saveState();
    render();
  });

  render();
  if (state.running) start();
}

// ---- Recently closed tabs ----
function getRecentlyClosed() {
  return JSON.parse(localStorage.getItem('tabout-recently-closed') || '[]');
}

function addRecentlyClosed(tab) {
  const list = getRecentlyClosed();
  list.unshift({ url: tab.url, title: tab.title, closedAt: new Date().toISOString() });
  if (list.length > 20) list.length = 20;
  localStorage.setItem('tabout-recently-closed', JSON.stringify(list));
}

function renderRecentlyClosed() {
  const section = document.getElementById('recentlyClosedSection');
  const list    = document.getElementById('recentlyClosedList');
  const countEl = document.getElementById('recentlyClosedCount');
  if (!section || !list) return;

  const items = getRecentlyClosed();
  if (items.length === 0) { section.style.display = 'none'; return; }

  section.style.display = 'block';
  if (countEl) countEl.textContent = `(${items.length})`;

  list.innerHTML = items.map(item => {
    let domain = '';
    try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="recently-closed-item">
      <a href="${item.url}" target="_blank" rel="noopener" class="deferred-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
        ${faviconUrl ? `<img src="${faviconUrl}" alt="" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px" onerror="this.style.display='none'">` : ''}
        ${item.title || item.url}
      </a>
      <span class="deferred-meta">${domain} · ${timeAgo(item.closedAt)}</span>
    </div>`;
  }).join('');
}

// ---- Settings modal ----
function initSettings() {
  const overlay = document.getElementById('settingsOverlay');
  const panel   = document.getElementById('settingsPanel');
  if (!overlay) return;

  function open() {
    // Populate fields with current config
    const s = (id) => document.getElementById(id);
    s('settingUserName').value = appConfig.userName || '';
    s('settingClockFormat').value = appConfig.clockFormat || '12';
    s('settingClockSeconds').checked = appConfig.clockShowSeconds || false;
    s('settingPomodoroWork').value = appConfig.pomodoroWorkMinutes || 25;
    s('settingPomodoroBreak').value = appConfig.pomodoroBreakMinutes || 5;
    s('settingSearchEngine').value = appConfig.searchEngine || 'google';

    // Render quick links list
    renderSettingsQuickLinks();

    overlay.style.display = 'flex';
    requestAnimationFrame(() => overlay.classList.add('visible'));
  }

  function close() {
    overlay.classList.remove('visible');
    setTimeout(() => { overlay.style.display = 'none'; }, 300);
  }

  document.getElementById('settingsBtn')?.addEventListener('click', open);
  document.getElementById('settingsClose')?.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && overlay.style.display !== 'none') close(); });

  // Save
  document.getElementById('settingsSave')?.addEventListener('click', async () => {
    const s = (id) => document.getElementById(id);
    await saveConfig({
      userName: s('settingUserName').value.trim(),
      clockFormat: s('settingClockFormat').value,
      clockShowSeconds: s('settingClockSeconds').checked,
      pomodoroWorkMinutes: Math.min(120, Math.max(1, parseInt(s('settingPomodoroWork').value) || 25)),
      pomodoroBreakMinutes: Math.min(60, Math.max(1, parseInt(s('settingPomodoroBreak').value) || 5)),
      searchEngine: s('settingSearchEngine').value,
    });
    close();
    showToast('Settings saved');
    // Refresh UI
    updateSearchBar();
    renderQuickLinks();
    updateClock();
    // Update greeting with new name
    const greetingEl = document.getElementById('greeting');
    if (greetingEl) greetingEl.textContent = getGreeting() + (appConfig.userName ? `, ${appConfig.userName}` : '');
  });

  // Add quick link
  document.getElementById('settingAddLink')?.addEventListener('click', async () => {
    const titleEl = document.getElementById('settingNewLinkTitle');
    const urlEl   = document.getElementById('settingNewLinkUrl');
    let url = urlEl.value.trim();
    const title = titleEl.value.trim();
    if (!url) return;
    if (!url.startsWith('http')) url = 'https://' + url;
    const links = [...(appConfig.quickLinks || []), { title: title || url, url }];
    await saveConfig({ quickLinks: links });
    titleEl.value = ''; urlEl.value = '';
    renderSettingsQuickLinks();
    renderQuickLinks();
  });
}

function renderSettingsQuickLinks() {
  const container = document.getElementById('settingsQuickLinks');
  if (!container) return;
  const links = appConfig.quickLinks || [];
  container.innerHTML = links.map((link, i) => {
    return `<div class="settings-ql-item">
      <span class="settings-ql-title">${link.title || link.url}</span>
      <button class="settings-ql-remove" data-ql-remove="${i}">×</button>
    </div>`;
  }).join('');

  // Remove handlers
  container.querySelectorAll('[data-ql-remove]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.qlRemove);
      const links = [...appConfig.quickLinks];
      links.splice(idx, 1);
      await saveConfig({ quickLinks: links });
      renderSettingsQuickLinks();
      renderQuickLinks();
    });
  });
}

// ---- Recently closed toggle ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#recentlyClosedToggle');
  if (!toggle) return;
  toggle.classList.toggle('open');
  const list = document.getElementById('recentlyClosedList');
  if (list) list.style.display = list.style.display === 'none' ? 'block' : 'none';
});

document.getElementById('clearRecentlyClosed')?.addEventListener('click', () => {
  localStorage.removeItem('tabout-recently-closed');
  renderRecentlyClosed();
  showToast('Recently closed history cleared');
});

// ---- Main init ----
async function init() {
  await loadConfig();
  initDarkMode();
  updateSearchBar();
  renderQuickLinks();
  updateClock();
  setInterval(updateClock, 1000);
  loadWeather();
  initPomodoro();
  initSettings();
  await renderDashboard();
  renderRecentlyClosed();

  // Auto-refresh when tabs change in the browser
  let refreshTimer = null;
  function scheduleRefresh() {
    // Debounce: wait 300ms after the last event before re-rendering
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      await renderStaticDashboard();
      renderRecentlyClosed();
    }, 300);
  }

  chrome.tabs.onCreated.addListener(scheduleRefresh);
  chrome.tabs.onRemoved.addListener(scheduleRefresh);
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    // Only refresh when a tab finishes loading (not on every intermediate state)
    if (changeInfo.status === 'complete' || changeInfo.title) scheduleRefresh();
  });
}

init();
