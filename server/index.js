// server/index.js
// ─────────────────────────────────────────────────────────────────────────────
// Main entry point for the Tab Out server.
// Serves the dashboard and API routes on localhost.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const path    = require('path');
const config  = require('./config');
const { startUpdateChecker } = require('./updater');

const app = express();

// CORS: only allow requests from the Chrome extension iframe (localhost)
// and the extension's own origin. Block all other origins.
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  const allowed = !origin
    || origin.startsWith('http://localhost')
    || origin.startsWith('chrome-extension://');
  if (allowed) {
    res.header('Access-Control-Allow-Origin', origin || '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Parse JSON request bodies (for POST endpoints)
app.use(express.json());

// Serve the dashboard's static files (HTML, CSS, JS)
app.use(express.static(path.join(__dirname, '..', 'dashboard')));

// Mount API routes under /api
const apiRouter = require('./routes');
app.use('/api', apiRouter);

// Start the server
app.listen(config.port, () => {
  console.log(`Tab Out running at http://localhost:${config.port}`);
  startUpdateChecker();
});
