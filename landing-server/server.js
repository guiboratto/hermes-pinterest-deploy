// Hermes landings — affiliate pages for Amazon ASINs
// Routes: GET /                    → landing index
//         GET /landings/<ASIN>/    → specific ASIN landing
//         GET /api/asins           → JSON list of ASINs

const express = require('express');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const LANDINGS_DIR = path.join(__dirname, 'landings');

const app = express();

// Load all ASINs dynamically
function listAsins() {
  if (!fs.existsSync(LANDINGS_DIR)) return [];
  return fs.readdirSync(LANDINGS_DIR, { withFileTypes: true })
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

// Serve landings directory
app.use('/landings', express.static(LANDINGS_DIR));
app.use('/gifs', express.static(path.join(__dirname, 'gifs')));

// API
app.get('/api/asins', (req, res) => {
  const asins = listAsins().map(loadAsinMeta);
  res.json({ count: asins.length, asins });
});

// Root: index of all ASINs
app.get('/', (req, res) => {
  const asins = listAsins();
  const links = asins.map(a => {
    const meta = loadAsinMeta(a);
    return `<li><a href="/landings/${a}/">${meta.title}</a> — $${meta.price} (${meta.rating}★)</li>`;
  }).join('');
  res.send(`<!DOCTYPE html>
<html><head><title>Hermes Landings</title>
<style>body{font-family:system-ui;max-width:800px;margin:40px auto;padding:20px;color:#333}
h1{color:#0a7d0a}li{margin:8px 0}a{color:#0066cc}</style></head>
<body>
<h1>🎯 Hermes Landings (${asins.length})</h1>
<ul>${links}</ul>
</body></html>`);
});

app.listen(PORT, () => console.log('hermes-landings listening on ' + PORT));