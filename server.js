'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createApp, loadConfig } = require('./lib/app');

const cfg = loadConfig(process.env);
const app = createApp(cfg);
const page = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const srv = http.createServer(async (req, res) => {
  if (await app.handle(req, res)) return;
  if (req.url === '/' || req.url.startsWith('/?')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }); return res.end(page); }
  res.writeHead(404); res.end('Introuvable');
});
srv.requestTimeout = 0; // les envois de longues vidéos ne doivent pas être coupés
srv.listen(cfg.port, cfg.host, () => console.log('ViralShort AI : http://' + cfg.host + ':' + cfg.port));
