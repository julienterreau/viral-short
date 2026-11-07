'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const pipeline = require('./pipeline');
const llm = require('./llm');

const DEFAULT_APP_PASSWORD = 'dev-password';

function loadConfig(e) {
  const c = {
    port: parseInt(e.PORT || '3000', 10), host: e.HOST || '0.0.0.0', dataDir: path.resolve(e.DATA_DIR || './data'),
    password: (e.APP_PASSWORD || DEFAULT_APP_PASSWORD), secret: e.APP_SECRET || '',
    ffmpeg: e.FFMPEG || 'ffmpeg', ffprobe: e.FFPROBE || 'ffprobe', preset: e.X264_PRESET || 'veryfast',
    transcribeCmd: (e.TRANSCRIBE_CMD || 'python3 worker/transcribe.py').split(/\s+/),
    ollamaUrl: (e.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, ''), chatModel: e.CHAT_MODEL || 'qwen2.5:7b', numCtx: parseInt(e.NUM_CTX || '8192', 10), llmTimeoutMs: parseInt(e.LLM_TIMEOUT_MS || '120000', 10),
    windowChars: parseInt(e.WINDOW_CHARS || '6000', 10), minClipSec: parseInt(e.MIN_CLIP_SEC || '20', 10), maxClipSec: parseInt(e.MAX_CLIP_SEC || '90', 10),
    maxUploadBytes: parseInt(e.MAX_UPLOAD_MB || '2048', 10) * 1048576, maxVideoMin: parseInt(e.MAX_VIDEO_MINUTES || '120', 10),
    concurrency: parseInt(e.CONCURRENCY || '1', 10), renderParallel: parseInt(e.RENDER_PARALLEL || '2', 10), subFont: e.SUB_FONT || 'DejaVu Sans',
  };
  if (!c.password || c.password.length < 8) {
    console.warn('APP_PASSWORD manquant ou trop court; utilisation du mot de passe de développement par défaut: "' + DEFAULT_APP_PASSWORD + '"');
    c.password = DEFAULT_APP_PASSWORD;
  }
  if (!c.secret) c.secret = crypto.createHash('sha256').update('viralshort:' + c.password).digest('hex');
  return c;
}

const LANG_RE = /^[a-z]{2}$/;

function createApp(cfg) {
  const root = path.join(cfg.dataDir, 'projects'); fs.mkdirSync(root, { recursive: true });
  const projects = new Map(); const running = new Map(); const queue = [];
  const fileOf = (id) => path.join(root, id, 'project.json');
  const save = (p) => { const tmp = fileOf(p.id) + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(p)); fs.renameSync(tmp, fileOf(p.id)); };
  for (const id of fs.readdirSync(root)) {
    try { const p = JSON.parse(fs.readFileSync(fileOf(id), 'utf8')); if (p.state === 'running' || p.state === 'queued') { p.state = 'failed'; p.error = 'Interrompu par un redémarrage : relance le projet.'; save(p); } } catch (e) {}
  }

  function pump() {
    while (running.size < cfg.concurrency && queue.length) {
      const p = queue.shift(); const ac = new AbortController(); running.set(p.id, ac);
      p.state = 'running'; save(p);
      pipeline.run({ cfg, project: p, save, signal: ac.signal }).catch((e) => { if (!ac.signal.aborted) { p.state = 'failed'; p.error = e.message; save(p); } }).finally(() => { running.delete(p.id); pump(); });
    }
  }
  const enqueue = (p) => { p.state = 'queued'; p.stageLabel = 'En attente'; p.progress = 0; p.error = undefined; save(p); queue.push(p); pump(); };

  const sign = (s) => crypto.createHmac('sha256', cfg.secret).update(s).digest('hex');
  const makeToken = () => { const exp = String(Date.now() + 7 * 864e5); return exp + '.' + sign(exp); };
  const tokenOk = (t) => { if (!t) return false; const [exp, mac] = t.split('.'); const good = sign(exp || ''); return !!mac && mac.length === good.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good)); };
  const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((p) => p.trim().split(/=(.*)/s).slice(0, 2)).filter((x) => x[0]));
  const hits = new Map();
  const limited = (ip) => { const now = Date.now(); const a = (hits.get(ip) || []).filter((t) => now - t < 600000); hits.set(ip, a); return a.length >= 8; };
  const send = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); return true; };
  const readJson = (req, max) => new Promise((resolve, reject) => { let n = 0; const ch = []; req.on('data', (c) => { n += c.length; if (n > max) { reject(Object.assign(new Error('Corps trop gros'), { status: 413 })); return; } ch.push(c); }); req.on('end', () => resolve(JSON.parse(Buffer.concat(ch).toString() || '{}'))); req.on('error', reject); });
  const sameOrigin = (req) => { const o = req.headers.origin; if (!o) return true; try { return new URL(o).host === req.headers.host; } catch (e) { return false; } };
  const pub = (p) => { const q = Object.assign({}, p); delete q.sourceFile; delete q.info; return q; };

  function streamFile(req, res, file, type) {
    if (!fs.existsSync(file)) return send(res, 404, { error: 'Introuvable' });
    const size = fs.statSync(file).size; const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      let a = range[1] === '' ? size - parseInt(range[2], 10) : parseInt(range[1], 10); let b = range[1] !== '' && range[2] !== '' ? parseInt(range[2], 10) : size - 1;
      if (!(a >= 0 && a <= b && b < size)) { res.writeHead(416, { 'content-range': 'bytes */' + size }); res.end(); return true; }
      res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': 'bytes ' + a + '-' + b + '/' + size, 'content-length': b - a + 1 });
      fs.createReadStream(file, { start: a, end: b }).pipe(res); return true;
    }
    res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size });
    fs.createReadStream(file).pipe(res); return true;
  }

  async function upload(req, res, url) {
    const name = String(url.searchParams.get('name') || 'video').slice(0, 120).replace(/[^\w .()-]/g, '_');
    const ext = (path.extname(name).toLowerCase().match(/^\.(mp4|mov|mkv|webm|avi|m4v)$/) || ['.mp4'])[0];
    const langs = (url.searchParams.get('langs') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!langs.every((l) => LANG_RE.test(l)) || langs.length > 6) return send(res, 400, { error: 'Langues invalides' });
    const source = (url.searchParams.get('source') || 'auto').toLowerCase(); if (source !== 'auto' && !LANG_RE.test(source)) return send(res, 400, { error: 'Langue source invalide' });
    const count = Math.min(20, Math.max(0, parseInt(url.searchParams.get('count') || '0', 10) || 0));
    const declared = parseInt(req.headers['content-length'] || '0', 10);
    if (declared > cfg.maxUploadBytes) return send(res, 413, { error: 'Fichier trop volumineux (max ' + Math.round(cfg.maxUploadBytes / 1048576) + ' Mo)' });
    const id = crypto.randomBytes(8).toString('hex'); const d = path.join(root, id); fs.mkdirSync(path.join(d, 'clips'), { recursive: true });
    const file = path.join(d, 'source' + ext); let n = 0;
    const out = fs.createWriteStream(file);
    const ok = await new Promise((resolve) => {
      req.on('data', (c) => { n += c.length; if (n > cfg.maxUploadBytes) { req.destroy(); out.destroy(); resolve(false); } });
      req.on('error', () => resolve(false)); req.pipe(out); out.on('finish', () => resolve(true)); out.on('error', () => resolve(false));
    });
    if (!ok || !n) { fs.rmSync(d, { recursive: true, force: true }); return send(res, 400, { error: n > cfg.maxUploadBytes ? 'Fichier trop volumineux' : 'Envoi interrompu ou vide' }); }
    const p = { id, name, sourceFile: file, state: 'queued', options: { source, langs, count }, createdAt: new Date().toISOString(), clips: [] };
    projects.set(id, p); enqueue(p);
    return send(res, 200, { project: pub(p) });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/api/')) return false;
    try {
      if (req.method !== 'GET' && (req.headers['x-viralshort'] !== '1' || !sameOrigin(req))) return send(res, 403, { error: 'Requête refusée' });
      if (url.pathname === '/api/login' && req.method === 'POST') {
        const ip = req.socket.remoteAddress || '?'; if (limited(ip)) return send(res, 429, { error: 'Trop d’essais, réessaie plus tard' });
        const { password } = await readJson(req, 4096);
        const a = crypto.createHash('sha256').update(String(password || '')).digest(); const b = crypto.createHash('sha256').update(cfg.password).digest();
        if (!crypto.timingSafeEqual(a, b)) { hits.get(ip).push(Date.now()); return send(res, 401, { error: 'Mot de passe incorrect' }); }
        res.setHeader('set-cookie', 'viralshort_session=' + makeToken() + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800'); return send(res, 200, { ok: true });
      }
      if (!tokenOk(cookies(req).viralshort_session)) return send(res, 401, { error: 'Connexion requise' });
      if (url.pathname === '/api/config') return send(res, 200, { ai: await llm.available(cfg), model: cfg.chatModel, languages: pipeline.LANG_NAMES, maxUploadMb: Math.round(cfg.maxUploadBytes / 1048576) });
      if (url.pathname === '/api/projects' && req.method === 'POST') return upload(req, res, url);
      if (url.pathname === '/api/projects' && req.method === 'GET') return send(res, 200, { projects: [...projects.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(pub) });
      const m = /^\/api\/projects\/([a-f0-9]{16})(?:\/(.*))?$/.exec(url.pathname);
      if (!m) return send(res, 404, { error: 'Route inconnue' });
      const p = projects.get(m[1]); if (!p) return send(res, 404, { error: 'Projet introuvable' });
      const rest = m[2] || '';
      if (rest === '' && req.method === 'GET') return send(res, 200, { project: pub(p) });
      if (rest === '' && req.method === 'DELETE') { const ac = running.get(p.id); if (ac) ac.abort(); const qi = queue.indexOf(p); if (qi >= 0) queue.splice(qi, 1); projects.delete(p.id); fs.rmSync(path.join(root, p.id), { recursive: true, force: true }); return send(res, 200, { ok: true }); }
      if (rest === 'retry' && req.method === 'POST') { if (p.state === 'running' || p.state === 'queued') return send(res, 409, { error: 'Déjà en cours' }); enqueue(p); return send(res, 200, { project: pub(p) }); }
      const cm = /^clips\/(c\d+)(?:\/(.*))?$/.exec(rest);
      if (cm) {
        const clip = p.clips.find((c) => c.id === cm[1]); if (!clip) return send(res, 404, { error: 'Clip introuvable' });
        const sub = cm[2] || '';
        if (sub === '' && req.method === 'PATCH') {
          const b = await readJson(req, 8192);
          if (b.title !== undefined) clip.title = String(b.title).slice(0, 100);
          if (b.description !== undefined) clip.description = String(b.description).slice(0, 300);
          if (b.cropX !== undefined) clip.cropX = Math.min(1, Math.max(0, Number(b.cropX) || 0.5));
          const s = b.start !== undefined ? Number(b.start) : clip.start, e = b.end !== undefined ? Number(b.end) : clip.end;
          if (!(s >= 0 && e <= p.duration + 0.01 && e - s >= 5 && e - s <= 180)) return send(res, 400, { error: 'Bornes invalides (5 à 180 s dans la vidéo)' });
          clip.start = s; clip.end = e; save(p); return send(res, 200, { clip });
        }
        if (sub === 'render' && req.method === 'POST') {
          const b = await readJson(req, 2048); const lang = String(b.lang || p.sourceLang).toLowerCase();
          if (!LANG_RE.test(lang)) return send(res, 400, { error: 'Langue invalide' });
          if (p.state === 'running' || p.state === 'queued') return send(res, 409, { error: 'Le projet est en cours de traitement' });
          const v = clip.versions[lang] = Object.assign(clip.versions[lang] || {}, { state: 'running', error: undefined }); save(p);
          const ac = new AbortController(); running.set(p.id + clip.id + lang, ac);
          pipeline.renderVersion({ cfg, project: p, save, signal: ac.signal }, clip, lang).finally(() => running.delete(p.id + clip.id + lang));
          return send(res, 202, { version: v });
        }
        const fm = /^([a-z]{2})\/(video|thumb)$/.exec(sub);
        if (fm && req.method === 'GET') {
          const v = clip.versions[fm[1]]; const f = v && (fm[2] === 'video' ? v.video : v.thumb); if (!f) return send(res, 404, { error: 'Pas encore prêt' });
          return streamFile(req, res, path.join(root, p.id, 'clips', path.basename(f)), fm[2] === 'video' ? 'video/mp4' : 'image/jpeg');
        }
        return send(res, 404, { error: 'Route inconnue' });
      }
      if (rest === 'export' && req.method === 'GET') {
        const files = []; const meta = [];
        p.clips.forEach((c) => Object.entries(c.versions).forEach(([l, v]) => { if (v.state === 'done') { files.push('clips/' + v.video); meta.push({ file: v.video, lang: l, title: v.title, description: v.description || '' }); } }));
        if (!files.length) return send(res, 404, { error: 'Aucune vidéo prête' });
        fs.writeFileSync(path.join(root, p.id, 'metadata.json'), JSON.stringify(meta, null, 2));
        res.writeHead(200, { 'content-type': 'application/x-tar', 'content-disposition': 'attachment; filename="shorts-' + p.id + '.tar"' });
        const t = spawn('tar', ['-cf', '-', '-C', path.join(root, p.id), 'metadata.json', ...files]); t.stdout.pipe(res); return true;
      }
      return send(res, 404, { error: 'Route inconnue' });
    } catch (e) { return send(res, e.status || 500, { error: e.message }); }
  }
  return { cfg, handle, projects, stop: () => running.forEach((a) => a.abort()), idle: () => !running.size && !queue.length };
}
module.exports = { createApp, loadConfig };
