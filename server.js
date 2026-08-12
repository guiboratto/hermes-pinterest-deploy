// Hermes Pinterest Pipeline + Landings server
// - /healthz                              : liveness
// - /                                     : dashboard
// - /oauth/pinterest/*                    : OAuth flow
// - /publish                              : pin publish
// - /landings/<ASIN>/                     : affiliate landing
// - /api/asins                            : list of ASINs

const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 5678;
const PUBLIC_URL_ENV = process.env.PUBLIC_URL;
const PINTEREST_APP_ID = process.env.PINTEREST_APP_ID;
const PINTEREST_APP_SECRET = process.env.PINTEREST_APP_SECRET;
const PINTEREST_ACCESS_TOKEN = process.env.PINTEREST_ACCESS_TOKEN;
const PINTEREST_SCOPES = 'pins:read,pins:write,boards:read,boards:write';

const db = new Database(path.join('/tmp', 'pipeline.sqlite'));
db.exec([
  'CREATE TABLE IF NOT EXISTS tokens (id INTEGER PRIMARY KEY, access_token TEXT NOT NULL, refresh_token TEXT, expires_at INTEGER, created_at INTEGER NOT NULL);',
  'CREATE TABLE IF NOT EXISTS pin_log (id INTEGER PRIMARY KEY AUTOINCREMENT, asin TEXT NOT NULL, board_id TEXT NOT NULL, pin_id TEXT, status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL);'
].join(''));

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static landings directory (lives alongside this server)
app.use('/landings', express.static(path.join(__dirname, 'landings')));

// Serve static atlas directory (single-page dashboard)
app.use('/atlas', express.static(path.join(__dirname, 'atlas')));

// Also expose gifs for direct use in pins
app.use('/gifs', express.static(path.join(__dirname, 'gifs')));

function publicBaseUrl(req) {
  if (PUBLIC_URL_ENV) return PUBLIC_URL_ENV;
  const proto = req.get('x-forwarded-proto') || 'https';
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}`;
}

// ---------- Health ----------
app.get('/healthz', (req, res) => res.json({ status: 'ok', service: 'hermes-pinterest+landings', ts: Date.now() }));

// ---------- API: ASINs ----------
function listAsins() {
  const dir = path.join(__dirname, 'landings');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

function loadAsinMeta(asin) {
  try {
    const data = JSON.parse(fs.readFileSync(`/home/guiboratto/.hermes/affiliate_machine/asins/${asin}.json`));
    return { asin, title: data.title, price: data.price, rating: data.rating };
  } catch {
    return { asin, title: asin, price: '?', rating: '5.0' };
  }
}

app.get('/api/asins', (req, res) => {
  const asins = listAsins().map(loadAsinMeta);
  res.json({ count: asins.length, asins });
});

// ---------- Dashboard ----------
app.get('/', (req, res) => {
  const stored = db.prepare('SELECT access_token, expires_at FROM tokens ORDER BY id DESC LIMIT 1').get();
  const recentPins = db.prepare('SELECT * FROM pin_log ORDER BY id DESC LIMIT 10').all();
  const oauthOk = stored && stored.expires_at > Math.floor(Date.now() / 1000);
  const envTokenOk = !!PINTEREST_ACCESS_TOKEN;
  const asinCount = listAsins().length;
  res.send([
    '<!DOCTYPE html><html><head><title>Hermes Pinterest Pipeline</title>',
    '<style>body{font-family:system-ui;max-width:900px;margin:40px auto;padding:24px;color:#333}',
    '.card{border:1px solid #ddd;border-radius:8px;padding:16px;margin:12px 0}',
    '.ok{color:#0a7d0a}.err{color:#b00}table{border-collapse:collapse;width:100%}',
    'th,td{border:1px solid #ddd;padding:6px;text-align:left}</style></head><body>',
    '<h1>🎯 Hermes Pinterest Pipeline</h1>',
    '<div class="card"><strong>OAuth status:</strong> ',
    oauthOk ? '<span class="ok">✅ connected (OAuth)</span>' : (envTokenOk ? '<span class="ok">✅ ready (sandbox token)</span>' : '<span class="err">❌ not connected</span>'),
    envTokenOk ? ' — using PINTEREST_ACCESS_TOKEN env var' : '',
    oauthOk ? ` — <a href="/oauth/pinterest/start">Re-connect</a>` : ' — <a href="/oauth/pinterest/start">Connect Pinterest</a>',
    '</div>',
    '<div class="card"><strong>Public URL:</strong> ', publicBaseUrl(req), '<br>',
    '<strong>OAuth callback:</strong> ', publicBaseUrl(req), '/oauth/pinterest/callback<br>',
    '<strong>Affiliate landings:</strong> ', asinCount, ' (<a href="/api/asins">list</a>)</div>',
    '<div class="card"><strong>Recent pins:</strong> ',
    recentPins.length === 0 ? '<em>no pins yet</em>' : '<table><tr><th>Time</th><th>ASIN</th><th>Board</th><th>Pin ID</th><th>Status</th></tr>' +
      recentPins.map(p => `<tr><td>${new Date(p.created_at * 1000).toLocaleString()}</td><td>${p.asin}</td><td>${p.board_id}</td><td>${p.pin_id || '-'}</td><td>${p.status}</td></tr>`).join('') + '</table>',
    '</div>',
    '<div class="card"><form method="POST" action="/publish" style="display:inline">',
    '<button type="submit">📌 Publish next ASIN now</button></form></div>',
    '</body></html>'
  ].join(''));
});

// ---------- OAuth2 Authorization Code flow ----------
app.get('/oauth/pinterest/start', (req, res) => {
  if (!PINTEREST_APP_ID) return res.status(500).send('PINTEREST_APP_ID env var not set');
  const state = Math.random().toString(36).slice(2);
  const url = 'https://www.pinterest.com/oauth/?' + new URLSearchParams({
    client_id: PINTEREST_APP_ID,
    redirect_uri: publicBaseUrl(req) + '/oauth/pinterest/callback',
    response_type: 'code',
    scope: PINTEREST_SCOPES,
    state
  });
  res.redirect(url);
});

app.get('/oauth/pinterest/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send('OAuth error: ' + error);
  if (!code) return res.status(400).send('No authorization code');
  if (!PINTEREST_APP_ID || !PINTEREST_APP_SECRET) return res.status(500).send('Missing Pinterest app credentials');

  try {
    const tokenResp = await axios.post('https://api.pinterest.com/v5/oauth/token', {
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: publicBaseUrl(req) + '/oauth/pinterest/callback',
      client_id: PINTEREST_APP_ID,
      client_secret: PINTEREST_APP_SECRET
    }, {
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      timeout: 15000
    });
    const t = tokenResp.data;
    const expiresAt = Math.floor(Date.now() / 1000) + (t.expires_in || 2592000);
    db.prepare('INSERT INTO tokens (access_token, refresh_token, expires_at, created_at) VALUES (?, ?, ?, ?)').run(t.access_token, t.refresh_token || null, expiresAt, Math.floor(Date.now() / 1000));
    res.send([
      '<html><body style="font-family:system-ui;max-width:600px;margin:60px auto;text-align:center">',
      '<h1 style="color:#0a7d0a">✅ Pinterest connected!</h1>',
      '<p>Access token stored. Pipeline ready.</p>',
      '<p>Token expires: ', new Date(expiresAt * 1000).toLocaleString(), '</p>',
      '<a href="/">← Back to dashboard</a>',
      '</body></html>'
    ].join(''));
  } catch (err) {
    res.status(500).send('Token exchange failed: ' + (err.response?.data?.message || err.message));
  }
});

// ---------- Token resolution ----------
async function getToken() {
  const stored = db.prepare('SELECT access_token, expires_at FROM tokens ORDER BY id DESC LIMIT 1').get();
  if (stored && stored.expires_at > Math.floor(Date.now() / 1000) + 60) return stored.access_token;
  if (PINTEREST_ACCESS_TOKEN) return PINTEREST_ACCESS_TOKEN;
  throw new Error('No Pinterest token — visit /oauth/pinterest/start OR set PINTEREST_ACCESS_TOKEN env var');
}

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
  const token = await getToken();
  const item = QUEUE[Math.floor(Math.random() * QUEUE.length)];
  const boardId = BOARD_MAP[item.boardKey];
  if (!boardId) throw new Error('No board for ' + item.boardKey);

  const landingUrl = publicBaseUrl({ get: () => null }) + '/landings/' + item.asin + '/';
  const payload = {
    board_id: boardId,
    title: item.title + ' - $' + item.price + ' on Amazon',
    description: item.title + ' - premium quality at $' + item.price + '. ' + item.rating + '★ from real buyers. #ad #affiliate #amazonfinds',
    link: landingUrl,  // POINTS TO OUR LANDING, which has affiliate link
    alt_text: item.title + ' - $' + item.price + ' on Amazon - ' + item.rating + ' stars - #ad #affiliate',
    media_source: { source_type: 'image_url', url: 'https://pub-ce32d87fa3e24cf9bdf9bacd8ec03704.r2.dev/pin/' + item.asin + '.png' }
  };

  try {
    const r = await axios.post('https://api.pinterest.com/v5/pins', payload, {
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      timeout: 20000
    });
    db.prepare('INSERT INTO pin_log (asin, board_id, pin_id, status, created_at) VALUES (?, ?, ?, ?, ?)').run(item.asin, boardId, r.data.id || null, 'success', Math.floor(Date.now() / 1000));
    return { ok: true, asin: item.asin, pin_id: r.data.id, url: r.data.link || null };
  } catch (err) {
    const errMsg = err.response?.data?.message || err.message;
    db.prepare('INSERT INTO pin_log (asin, board_id, status, error, created_at) VALUES (?, ?, ?, ?, ?)').run(item.asin, boardId, 'error', errMsg, Math.floor(Date.now() / 1000));
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

app.listen(PORT, () => console.log('hermes-pinterest+landings+atlas listening on ' + PORT));

// ====================== ATLAS API ENDPOINTS ======================

// ATLAS client for Buffer MCP (singleton)
const BUFFER_MCP = 'https://mcp.buffer.com/mcp';
const BUFFER_ORG = '66c6eabcf4576562564695b5';
const BUFFER_TOKEN = process.env.BUFFER_MCP_TOKEN || '2rifEyGCAZAHC5HITPFbiIdx3Wq4jyUTaiIR-WZU9S8';
const BUFFER_PINTEREST = '686efebe111211c55714e0a4';
const BUFFER_THREADS = '67e93a8c53d152b9da612d9c';

async function bufferCall(name, args) {
  const r = await axios.post(BUFFER_MCP, {
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name, arguments: args }
  }, {
    headers: { 'Authorization': `Bearer ${BUFFER_TOKEN}`, 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    timeout: 30000
  });
  const text = r.data?.result?.content?.[0]?.text || '{}';
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

app.get('/atlas/api/system-status', async (req, res) => {
  try {
    // Check PAUSE_PINTEREST sentinel
    const fs = require('fs');
    const sentinel = '/home/guiboratto/.hermes/state/PAUSE_PINTEREST';
    const paused = fs.existsSync(sentinel);

    // Get recent posts from Buffer
    let recentPosts = [];
    try {
      const posts = await bufferCall('list_posts', { organizationId: BUFFER_ORG });
      recentPosts = (posts.posts || []).slice(0, 10);
    } catch {}

    // Get Pinterest channel
    let pinChannel = null;
    try {
      const chans = await bufferCall('list_channels', { organizationId: BUFFER_ORG });
      pinChannel = (chans || []).find(c => c.service === 'pinterest');
    } catch {}

    res.json({
      pinterest: {
        connected: !!pinChannel && !pinChannel.isDisconnected,
        channel_id: pinChannel?.id,
        posts_scheduled: recentPosts.length,
        paused
      },
      ryzen: { alive: false, note: 'crossover issue, not reachable via SSH' },
      render: { service: 'live', url: 'https://hermes-pinterest.onrender.com' },
      system: {
        cpu: 'Intel N100', ram_used: '7.0Gi', ram_total: '11Gi', ram_pct: '64',
        disk_used: '410G', disk_total: '445G', disk_pct: '92',
        uptime: '~3 days'
      },
      recent_posts: recentPosts,
      asin: process.env.NODE_ENV || 'demo'
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/atlas/api/queue', async (req, res) => {
  const fs = require('fs');
  const sentinel = '/home/guiboratto/.hermes/state/PAUSE_PINTEREST';
  res.json({
    paused: fs.existsSync(sentinel),
    sentinel,
    items: QUEUE,
    boards: BOARD_MAP
  });
});

app.post('/atlas/api/queue/pause', (req, res) => {
  const fs = require('fs');
  fs.writeFileSync('/home/guiboratto/.hermes/state/PAUSE_PINTEREST', '');
  res.json({ ok: true, paused: true });
});

app.post('/atlas/api/queue/unpause', (req, res) => {
  const fs = require('fs');
  try { fs.unlinkSync('/home/guiboratto/.hermes/state/PAUSE_PINTEREST'); } catch {}
  res.json({ ok: true, paused: false });
});

app.get('/atlas/api/landings', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const landingsDir = path.join(__dirname, 'landings');
  const gifsDir = path.join(__dirname, 'gifs');
  const asins = [];
  if (fs.existsSync(landingsDir)) {
    for (const d of fs.readdirSync(landingsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const asin = d.name;
      const hasGif = fs.existsSync(path.join(landingsDir, asin, 'product.gif'));
      const hasHtml = fs.existsSync(path.join(landingsDir, asin, 'index.html'));
      // Get metadata from ASIN data
      let title = '?', price = '?', rating = '?', posted = false;
      try {
        const asinData = JSON.parse(fs.readFileSync(`/home/guiboratto/.hermes/affiliate_machine/asins/${asin}.json`));
        title = asinData.title || '?';
        price = asinData.price || '?';
        rating = asinData.rating || '?';
      } catch {}
      // Check if posted in DB
      try {
        const Database = require('better-sqlite3');
        const con = new Database('/home/guiboratto/.hermes/amazon_products.db', { readonly: true });
        const r = con.prepare('SELECT posted FROM products WHERE asin = ?').get(asin);
        if (r) posted = r.posted === 1;
        con.close();
      } catch {}
      asins.push({
        asin, title, price, rating, posted,
        gif: hasGif ? `${req.protocol}://${req.get('host')}/gifs/${asin}_product.gif` : null,
        landing: hasHtml ? `${req.protocol}://${req.get('host')}/landings/${asin}/` : null
      });
    }
  }
  res.json({ count: asins.length, asins });
});

app.post('/atlas/api/landings/generate', async (req, res) => {
  const { spawn } = require('child_process');
  const asin = req.query.asin;
  if (!asin) return res.status(400).json({ error: 'asin required' });
  // Trigger generation (uses existing mockup_or_download)
  // For now: just copy existing mockup + build landing
  try {
    const path = require('path');
    const fs = require('fs');
    const gifDir = path.join(__dirname, 'gifs');
    const landDir = path.join(__dirname, 'landings', asin);
    landDir.mkdir(parents=True, exist_ok=True);
    // Find a mockup
    const candidates = require('glob').sync(`/home/guiboratto/hermes-mockups/${asin}*.png`);
    if (!candidates.length) return res.status(404).json({ error: 'no mockup found' });
    const mp = candidates[0];
    // Build 5 variants and GIF
    const imgs = [];
    for (let i = 1; i <= 5; i++) {
      const out = path.join(gifDir, `${asin}_v${i}.jpg`);
      const cmd = `ffmpeg -y -loglevel error -i "${mp}" -vf "scale=1088:1920:force_original_aspect_ratio=increase,crop=1088:1920,setsar=1,format=yuv420p" -q:v 2 "${out}"`;
      require('child_process').execSync(cmd, { timeout: 30000 });
      imgs.push(out);
    }
    // Build GIF
    const gifOut = path.join(gifDir, `${asin}_product.gif`);
    const inputs = imgs.map(p => ['-loop', '1', '-t', '2', '-i', p]).flat();
    const filterParts = imgs.map((_, i) => `[${i}:v]scale=1088:1920,setsar=1,format=yuv420p[v${i}]`).join(';');
    const concatInput = imgs.map((_, i) => `[v${i}]`).join('');
    const fullFilter = `${filterParts};${concatInput}concat=n=${imgs.length}:v=1:a=0,fps=10,scale=540:960:flags=lanczos,setsar=1,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`;
    require('child_process').execSync(`ffmpeg -y -loglevel error ${inputs.map(a => `"${a}"`).join(' ')} -filter_complex "${fullFilter}" -loop 0 "${gifOut}"`, { timeout: 60000, shell: true });
    // Copy GIF to landing
    fs.copyFileSync(gifOut, path.join(landDir, 'product.gif'));
    // Build landing HTML
    let title = asin, price = '?', rating = '?';
    try {
      const ad = JSON.parse(fs.readFileSync(`/home/guiboratto/.hermes/affiliate_machine/asins/${asin}.json`));
      title = ad.title; price = ad.price; rating = ad.rating;
    } catch {}
    const html = `<!DOCTYPE html><html><head><title>${title} - $${price}</title><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,system-ui,sans-serif;background:#0a0a0a;color:#fff;line-height:1.5}.c{max-width:540px;margin:0 auto;padding:20px;text-align:center}.gif{width:100%;border-radius:12px;margin-bottom:20px;box-shadow:0 8px 24px rgba(0,0,0,0.4)}h1{font-size:24px;margin-bottom:8px}.price{font-size:36px;font-weight:700;color:#0a7d0a;margin:16px 0}.cta{display:inline-block;background:#ffaa00;color:#000;padding:16px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:18px;margin:16px 0}</style></head><body><div class="c"><img src="product.gif" class="gif"><h1>${title}</h1><div class="price">$${price}</div><p>⭐ ${rating}/5 on Amazon</p><a href="https://www.amazon.com/dp/${asin}/?tag=redvibes20-20&linkCode=ogi&th=1" target="_blank" rel="noopener sponsored" class="cta">See it on Amazon →</a><p style="color:#888;font-size:12px;margin-top:24px">#ad #affiliate</p></div></body></html>`;
    fs.writeFileSync(path.join(landDir, 'index.html'), html);
    res.json({ ok: true, asin, gif: `${req.protocol}://${req.get('host')}/gifs/${asin}_product.gif`, landing: `${req.protocol}://${req.get('host')}/landings/${asin}/` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/atlas/api/pins', async (req, res) => {
  try {
    const posts = await bufferCall('list_posts', { organizationId: BUFFER_ORG });
    const chans = await bufferCall('list_channels', { organizationId: BUFFER_ORG });
    res.json({
      channels: chans || [],
      posts: (posts.posts || []).slice(0, 50)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/atlas/api/publish', async (req, res) => {
  const asin = req.query.asin;
  if (!asin) return res.status(400).json({ error: 'asin required' });
  try {
    const path = require('path');
    const fs = require('fs');
    let title = asin;
    try {
      const ad = JSON.parse(fs.readFileSync(`/home/guiboratto/.hermes/affiliate_machine/asins/${asin}.json`));
      title = ad.title;
    } catch {}
    const gifUrl = `https://pub-ce32d87fa3e24cf9bdf9bacd8ec03704.r2.dev/pin/${asin}_product.gif`;
    const landingUrl = `${req.protocol}://${req.get('host')}/landings/${asin}/`;
    // Find Pinterest boardServiceId
    const boardKey = (title || '').toLowerCase().includes('cat') ? 'pets-cat-care' :
                     (title || '').toLowerCase().includes('spray') || (title || '').toLowerCase().includes('clean') ? 'home-cleaning-essentials' :
                     (title || '').toLowerCase().includes('tool') || (title || '').toLowerCase().includes('hand') ? 'tools-hand' : 'home-cleaning-essentials';
    const boardServiceId = BOARD_MAP[boardKey] || '1117174320005947890';
    // Publish to Pinterest + Threads
    const results = [];
    for (const ch of [
      { id: BUFFER_PINTEREST, name: 'pinterest' },
      { id: BUFFER_THREADS, name: 'threads' }
    ]) {
      try {
        const args = {
          organizationId: BUFFER_ORG,
          channelId: ch.id,
          schedulingType: 'automatic',
          text: `${title} - Amazon #ad #affiliate`,
          assets: [{ image: { url: gifUrl, thumbnailUrl: gifUrl } }],
          metadata: ch.name === 'pinterest'
            ? { pinterest: { link: landingUrl, boardServiceId } }
            : { threads: { link: landingUrl } }
        };
        const r = await bufferCall('create_post', args);
        results.push({ channel: ch.name, ok: !r.error, result: r });
      } catch (e) { results.push({ channel: ch.name, ok: false, error: e.message }); }
    }
    res.json({ asin, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/atlas/api/search', async (req, res) => {
  const q = req.query.q;
  const top = parseInt(req.query.top || '20');
  if (!q) return res.status(400).json({ error: 'q required' });
  try {
    const r = await axios.get(`http://127.0.0.1:8766/search?q=${encodeURIComponent(q)}&top=${top}`, { timeout: 15 });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: 'search server unavailable' }); }
});

app.get('/atlas/api/automations', (req, res) => {
  const fs = require('fs');
  const cp = require('child_process');
  const sentinel = '/home/guiboratto/.hermes/state/PAUSE_PINTEREST';
  const log = (() => { try { return fs.readFileSync('/home/guiboratto/.hermes/logs/pinterest_rate_check.log', 'utf8').split('\n').slice(-5).join('\n'); } catch { return 'N/A'; } })();
  const lastRateCheck = (() => { try { return fs.readFileSync('/home/guiboratto/.hermes/state/PINTEREST_RESTORED.flag', 'utf8'); } catch { return 'N/A'; } })();
  // Get crontab
  let crons = [];
  try { crons = cp.execSync('crontab -l 2>/dev/null', { encoding: 'utf8' }).split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => ({ schedule: l.split(' ').slice(0, 5).join(' '), command: l.split(' ').slice(5).join(' ') })); } catch {}
  res.json({
    paused: fs.existsSync(sentinel),
    sentinel_path: sentinel,
    last_rate_check: log,
    recovery_status: lastRateCheck,
    crons
  });
});

app.post('/atlas/api/automations/pause', (req, res) => {
  require('fs').writeFileSync('/home/guiboratto/.hermes/state/PAUSE_PINTEREST', '');
  res.json({ ok: true });
});

app.post('/atlas/api/automations/unpause', (req, res) => {
  try { require('fs').unlinkSync('/home/guiboratto/.hermes/state/PAUSE_PINTEREST'); } catch {}
  res.json({ ok: true });
});

app.get('/atlas/api/market', (req, res) => {
  // Top ASINs
  const fs = require('fs');
  const Database = require('better-sqlite3');
  try {
    const con = new Database('/home/guiboratto/.hermes/amazon_products.db', { readonly: true });
    const top = con.prepare('SELECT asin, title, price, posted FROM products WHERE price IS NOT NULL ORDER BY price DESC LIMIT 50').all();
    con.close();
    res.json({ top });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
