// Hermes Pinterest Pipeline
// - GET /healthz                          : liveness
// - GET /                                 : dashboard (HTML)
// - GET /oauth/pinterest/callback         : OAuth2 redirect (Pinterest -> here -> token stored)
// - POST /publish                         : manual pin publish (debug/demo)
// - cron every 4h                         : auto-publish next ASIN

const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const Database = require('better-sqlite3');
const path = require('path');

const PORT = process.env.PORT || 5678;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const PINTEREST_APP_ID = process.env.PINTEREST_APP_ID;
const PINTEREST_APP_SECRET = process.env.PINTEREST_APP_SECRET;
const PINTEREST_SCOPES = 'pins:read,pins:write,boards:read,boards:write';

const db = new Database(path.join('/tmp', 'pipeline.sqlite'));
db.exec(`
  CREATE TABLE IF NOT EXISTS tokens (
    id INTEGER PRIMARY KEY,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expires_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pin_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asin TEXT NOT NULL,
    board_id TEXT NOT NULL,
    pin_id TEXT,
    status TEXT NOT NULL,
    error TEXT,
    created_at INTEGER NOT NULL
  );
`);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- Health ----------
app.get('/healthz', (req, res) => res.json({ status: 'ok', service: 'hermes-pinterest', ts: Date.now() }));

// ---------- Dashboard ----------
app.get('/', (req, res) => {
  const token = db.prepare('SELECT access_token, expires_at FROM tokens ORDER BY id DESC LIMIT 1').get();
  const recentPins = db.prepare('SELECT * FROM pin_log ORDER BY id DESC LIMIT 10').all();
  res.send(`
<!DOCTYPE html><html><head><title>Hermes Pinterest Pipeline</title>
<style>body{font-family:system-ui;max-width:900px;margin:40px auto;padding:24px;color:#333}
.card{border:1px solid #ddd;border-radius:8px;padding:16px;margin:12px 0}
.ok{color:#0a7d0a}.err{color:#b00}</style></head>
<body>
<h1>🎯 Hermes Pinterest Pipeline</h1>
<div class="card">
  <strong>OAuth status:</strong>
  ${token
    ? `<span class="ok">✅ connected</span> — token expires ${new Date(token.expires_at * 1000).toLocaleString()}`
    : `<span class="err">❌ not connected</span> — <a href="/oauth/pinterest/start">Connect Pinterest</a>`}
</div>
<div class="card">
  <strong>Public URL:</strong> ${PUBLIC_URL}<br>
  <strong>OAuth callback:</strong> ${PUBLIC_URL}/oauth/pinterest/callback<br>
  <strong>Webhook:</strong> POST ${PUBLIC_URL}/publish
</div>
<div class="card">
  <strong>Recent pins:</strong>
  ${recentPins.length === 0 ? '<em>no pins yet</em>' : '<table border="1" cellpadding="6" style="border-collapse:collapse;width:100%"><tr><th>Time</th><th>ASIN</th><th>Board</th><th>Pin ID</th><th>Status</th></tr>' +
    recentPins.map(p => `<tr><td>${new Date(p.created_at * 1000).toLocaleString()}</td><td>${p.asin}</td><td>${p.board_id}</td><td>${p.pin_id || '-'}</td><td>${p.status}</td></tr>`).join('') + '</table>'}
</div>
<div class="card">
  <strong>Manual actions:</strong>
  <form method="POST" action="/publish" style="display:inline">
    <button type="submit">📌 Publish next ASIN now</button>
  </form>
</div>
</body></html>
  `);
});

// ---------- OAuth2 Authorization Code flow ----------
// Determine public base URL: explicit env var, or reconstruct from Render proxy headers
function publicBaseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
  const proto = req.get('x-forwarded-proto') || 'https';
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}`;
}

app.get('/oauth/pinterest/start', (req, res) => {
  if (!PINTEREST_APP_ID) return res.status(500).send('PINTEREST_APP_ID env var not set');
  const state = Math.random().toString(36).slice(2);
  const url = `https://www.pinterest.com/oauth/?` + new URLSearchParams({
    client_id: PINTEREST_APP_ID,
    redirect_uri: `${publicBaseUrl(req)}/oauth/pinterest/callback`,
    response_type: 'code',
    scope: PINTEREST_SCOPES,
    state
  });
  res.redirect(url);
});

app.get('/oauth/pinterest/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send(`OAuth error: ${error}`);
  if (!code) return res.status(400).send('No authorization code');
  if (!PINTEREST_APP_ID || !PINTEREST_APP_SECRET) return res.status(500).send('Missing Pinterest app credentials');

  try {
    const tokenResp = await axios.post('https://api.pinterest.com/v5/oauth/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${publicBaseUrl(req)}/oauth/pinterest/callback`,
        client_id: PINTEREST_APP_ID,
        client_secret: PINTEREST_APP_SECRET
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
    );
    const t = tokenResp.data;
    const expiresAt = Math.floor(Date.now() / 1000) + (t.expires_in || 2592000);
    db.prepare('INSERT INTO tokens (access_token, refresh_token, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(t.access_token, t.refresh_token || null, expiresAt, Math.floor(Date.now() / 1000));
    res.send(`
      <html><body style="font-family:system-ui;max-width:600px;margin:60px auto;text-align:center">
      <h1 style="color:#0a7d0a">✅ Pinterest connected!</h1>
      <p>Access token stored. Pipeline ready.</p>
      <p>Token expires: ${new Date(expiresAt * 1000).toLocaleString()}</p>
      <a href="/">← Back to dashboard</a>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send(`Token exchange failed: ${err.response?.data?.message || err.message}`);
  }
});

// ---------- Publish one pin ----------
const QUEUE = [
  { asin: 'B0009X29WK', boardKey: 'pets-cat-care', title: "Dr. Elsey's Cat Litter", price: '20.99', rating: '4.7' },
  { asin: 'B000E28UQU', boardKey: 'home-cleaning-essentials', title: 'O-Cedar Microfiber Mop', price: '21.99', rating: '4.6' },
  { asin: 'B000H3I2JG', boardKey: 'tools-hand', title: 'Stanley FatMax Hand Tools', price: '29.99', rating: '4.8' }
];

const BOARD_MAP = {
  'pets-cat-care': '1117174320005947890',
  'home-cleaning-essentials': '1117174320005947881',
  'tools-hand': '1117174320005947896'
};

async function publishOne() {
  const token = db.prepare('SELECT access_token FROM tokens ORDER BY id DESC LIMIT 1').get();
  if (!token) throw new Error('No Pinterest token — visit /oauth/pinterest/start');

  const item = QUEUE[Math.floor(Math.random() * QUEUE.length)];
  const boardId = BOARD_MAP[item.boardKey];
  if (!boardId) throw new Error(`No board for ${item.boardKey}`);

  const payload = {
    board_id: boardId,
    title: `${item.title} - $${item.price} on Amazon`,
    description: `${item.title} - premium quality at $${item.price}. ${item.rating}★ from real buyers. #ad #affiliate #amazonfinds`,
    link: `https://www.amazon.com/dp/${item.asin}/?tag=redvibes20-20&linkCode=ogi&th=1`,
    alt_text: `${item.title} - $${item.price} on Amazon - ${item.rating} stars - #ad #affiliate`,
    media_source: { source_type: 'image_url', url: `https://pub-ce32d87fa3e24cf9bdf9bacd8ec03704.r2.dev/pin/${item.asin}.png` }
  };

  try {
    const r = await axios.post('https://api.pinterest.com/v5/pins', payload, {
      headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' },
      timeout: 20000
    });
    db.prepare('INSERT INTO pin_log (asin, board_id, pin_id, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(item.asin, boardId, r.data.id || null, 'success', Math.floor(Date.now() / 1000));
    return { ok: true, asin: item.asin, pin_id: r.data.id };
  } catch (err) {
    const errMsg = err.response?.data?.message || err.message;
    db.prepare('INSERT INTO pin_log (asin, board_id, status, error, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(item.asin, boardId, 'error', errMsg, Math.floor(Date.now() / 1000));
    return { ok: false, asin: item.asin, error: errMsg };
  }
}

app.post('/publish', async (req, res) => {
  const r = await publishOne();
  res.json(r);
});

// ---------- Cron: every 4 hours ----------
cron.schedule('0 */4 * * *', async () => {
  console.log('[cron] publishing next pin…');
  await publishOne();
});

app.listen(PORT, () => console.log(`hermes-pinterest listening on ${PORT}, public=${PUBLIC_URL}`));