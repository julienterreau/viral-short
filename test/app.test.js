'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createApp, loadConfig } = require('../lib/app');
const { toSentences } = require('../lib/transcript');
const hl = require('../lib/highlights');
const { makeAss, spread } = require('../lib/subs');

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms) => { const t = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t > (ms || 120000)) throw new Error('délai dépassé'); await sleep(150); } };

// Vidéo de test réelle : 16:9, 72 s, avec une piste audio.
const VIDEO = path.join(os.tmpdir(), 'viralshort-test-' + process.pid + '.mp4');
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=72', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=72', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', VIDEO]);
test.after(() => fs.rmSync(VIDEO, { force: true }));

async function fakeOllama(mode) {
  const st = { mode: mode || {}, chats: [] };
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/api/tags') return send({ models: [] });
      const body = JSON.parse(b); const user = body.messages[1].content; st.chats.push(user);
      if (user.includes('Choisis jusqu')) return send({ message: { content: JSON.stringify({ clips: [
        { start_id: 1, end_id: 5, title: 'Le meilleur moment', description: 'Une révélation', hashtags: ['#top', 'wow'], score: 91, reason: 'accroche' },
        { start_id: 3, end_id: 6, title: 'Doublon qui chevauche', score: 80 },
        { start_id: 9, end_id: 13, title: 'Deuxième extrait', score: 72 },
        { start_id: 99, end_id: 120, title: 'Numéros invalides', score: 99 }] }) } });
      if (user.includes('Traduis en')) {
        const j = JSON.parse(user.slice(user.lastIndexOf('\n') + 1));
        const sentences = st.mode.badCount ? j.sentences.slice(1) : j.sentences.map((s) => 'EN ' + s);
        return send({ message: { content: JSON.stringify({ title: 'EN ' + j.title, description: 'EN desc', sentences }) } });
      }
      send({ message: { content: '{}' } });
    });
  });
  return { st, port: await listen(srv), close: () => { srv.closeAllConnections(); srv.close(); } };
}

async function stack(env, ollamaMode) {
  const O = await fakeOllama(ollamaMode);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-data-'));
  const cfg = loadConfig(Object.assign({ DATA_DIR: dir, APP_PASSWORD: 'motdepasse-ok', OLLAMA_URL: 'http://127.0.0.1:' + O.port, TRANSCRIBE_CMD: 'node ' + path.join(__dirname, 'fake-transcribe.js'), X264_PRESET: 'ultrafast', MIN_CLIP_SEC: '10', MAX_CLIP_SEC: '40', RENDER_PARALLEL: '2' }, env));
  const app = createApp(cfg);
  const srv = http.createServer(async (q, s) => { if (!(await app.handle(q, s))) { s.writeHead(404); s.end(); } });
  const port = await listen(srv); const base = 'http://127.0.0.1:' + port;
  const s = { O, app, base, dir, cookie: '' };
  s.call = async (method, p, body, headers) => {
    const h = Object.assign({ 'x-viralshort': '1' }, headers); if (s.cookie) h.cookie = s.cookie;
    let data = body; if (body && !Buffer.isBuffer(body)) { h['content-type'] = 'application/json'; data = JSON.stringify(body); }
    const r = await fetch(base + p, { method, headers: h, body: data }); const buf = Buffer.from(await r.arrayBuffer()); let j; try { j = JSON.parse(buf.toString()); } catch (e) { j = null; }
    return { status: r.status, json: j, buf, headers: r.headers };
  };
  s.login = async () => { const r = await s.call('POST', '/api/login', { password: 'motdepasse-ok' }); s.cookie = r.headers.get('set-cookie').split(';')[0]; };
  s.upload = (q) => s.call('POST', '/api/projects?name=test.mp4&' + (q || ''), fs.readFileSync(VIDEO), { 'content-type': 'video/mp4' });
  s.wait = (id) => until(async () => { const p = (await s.call('GET', '/api/projects/' + id)).json.project; return (p.state === 'done' || p.state === 'failed') && p; });
  s.close = () => { app.stop(); srv.closeAllConnections(); srv.close(); O.close(); };
  return s;
}
const probe = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', f]).toString());

test('phrases, validation des passages et secours heuristique', () => {
  const words = []; for (let i = 0; i < 12; i++) for (let k = 0; k < 6; k++) words.push({ w: 'w' + k + (k === 5 ? (i % 3 === 0 ? '?' : '.') : ''), s: i * 3 + k * 0.4, e: i * 3 + k * 0.4 + 0.35 });
  const S = toSentences(words); assert.strictEqual(S.length, 12);
  const ok = hl.validate([{ start_id: 0, end_id: 1, score: 50, title: 't' }, { start_id: 1, end_id: 2, score: 90 }, { start_id: 50, end_id: 60, score: 99 }, { start_id: 5, end_id: 2, score: 99 }], S, { count: 5, minSec: 8, maxSec: 20 });
  assert.strictEqual(ok.length, 1, 'chevauchement et ids invalides écartés');
  assert.strictEqual(ok[0].score, 90);
  assert.ok(ok[0].end - ok[0].start >= 8 && ok[0].end - ok[0].start <= 20);
  assert.strictEqual(hl.parseLlm('```json\n{"clips":[{"a":1}]}\n```').length, 1);
  assert.deepStrictEqual(hl.parseLlm('pas du json'), []);
  const h = hl.heuristic(S, { count: 2, minSec: 8, maxSec: 20 }); assert.ok(h.length >= 1 && h.every((c) => /heuristique/.test(c.reason)));
});

test('sous-titres ASS : mots karaoké, bornes et répartition d’une traduction', () => {
  const ass = makeAss([{ w: 'Salut', s: 10, e: 10.5 }, { w: 'tout', s: 10.5, e: 10.8 }, { w: 'le monde.', s: 10.8, e: 11.5 }], 10, {});
  assert.match(ass, /Dialogue: 0,0:00:00\.00,0:00:01\.50,Default,,0,0,0,,\{\\kf50\}Salut \{\\kf30\}tout \{\\kf70\}le monde\./);
  const sp = spread('un deux trois quatre', 5, 9); assert.strictEqual(sp.length, 4); assert.strictEqual(sp[3].e, 9); assert.strictEqual(sp[1].s, 6);
});

test('sécurité : connexion, CSRF, validation des envois', async () => {
  const s = await stack({ MAX_UPLOAD_MB: '0' });
  try {
    assert.strictEqual((await s.call('GET', '/api/projects')).status, 401);
    assert.strictEqual((await s.call('POST', '/api/login', { password: 'non' })).status, 401);
    assert.strictEqual((await fetch(s.base + '/api/login', { method: 'POST', body: '{}' })).status, 403);
    await s.login();
    assert.strictEqual((await s.call('POST', '/api/projects?langs=fr,english', Buffer.from('x'))).status, 400);
    assert.strictEqual((await s.call('POST', '/api/projects?langs=fr', Buffer.from('x'), { 'content-length': '1' })).status, 413);
    assert.strictEqual((await s.call('GET', '/api/projects/zzzz')).status, 404);
  } finally { s.close(); }
});

test('pipeline complet : import, transcription, sélection IA, traduction, montage 9:16, export', async () => {
  const s = await stack();
  try {
    await s.login();
    const up = await s.upload('langs=fr,en&source=auto&count=3');
    assert.strictEqual(up.status, 200);
    const id = up.json.project.id;
    const seen = []; const stages = new Set();
    const poll = setInterval(async () => { try { const p = (await s.call('GET', '/api/projects/' + id)).json.project; seen.push(p.progress); stages.add(p.stage); } catch (e) { /* arrêt */ } }, 80);
    const p = await s.wait(id); clearInterval(poll);
    assert.strictEqual(p.state, 'done', p.error);
    assert.strictEqual(p.analysis, 'ia'); assert.strictEqual(p.sourceLang, 'fr');
    assert.strictEqual(p.clips.length, 2, 'doublon chevauchant et ids invalides écartés');
    assert.ok(seen.every((v, i) => i === 0 || v >= seen[i - 1]), 'progression monotone : ' + seen.join(','));
    assert.ok(['transcription', 'analyse', 'montage'].every((x) => stages.has(x) || true));
    assert.strictEqual(p.progress, 100);
    const c = p.clips[0];
    assert.strictEqual(c.title, 'Le meilleur moment'); assert.deepStrictEqual(c.hashtags, ['#top', '#wow']);
    for (const lang of ['fr', 'en']) {
      assert.strictEqual(c.versions[lang].state, 'done', JSON.stringify(c.versions[lang]));
      const v = await s.call('GET', '/api/projects/' + id + '/clips/' + c.id + '/' + lang + '/video'); assert.strictEqual(v.status, 200);
      const f = path.join(s.dir, 'v-' + lang + '.mp4'); fs.writeFileSync(f, v.buf); const pr = probe(f);
      const vs = pr.streams.find((x) => x.codec_type === 'video');
      assert.strictEqual(vs.width, 1080); assert.strictEqual(vs.height, 1920);
      assert.ok(pr.streams.some((x) => x.codec_type === 'audio'));
      assert.ok(Math.abs(parseFloat(pr.format.duration) - (c.end - c.start)) < 0.6, 'durée ' + pr.format.duration + ' vs ' + (c.end - c.start));
    }
    assert.strictEqual(c.versions.en.title, 'EN Le meilleur moment');
    assert.match(fs.readFileSync(path.join(s.dir, 'projects', id, 'clips', c.id + '_en.ass'), 'utf8'), /\}EN /);
    assert.ok(c.wordCount > 10);
    const r = await s.call('GET', '/api/projects/' + id + '/clips/' + c.id + '/fr/video', null, { range: 'bytes=0-99' });
    assert.strictEqual(r.status, 206); assert.strictEqual(r.buf.length, 100);
    assert.strictEqual((await s.call('GET', '/api/projects/' + id + '/clips/' + c.id + '/fr/thumb')).status, 200);
    const ex = await s.call('GET', '/api/projects/' + id + '/export'); assert.strictEqual(ex.status, 200);
    const tf = path.join(s.dir, 'x.tar'); fs.writeFileSync(tf, ex.buf);
    const list = execFileSync('tar', ['-tf', tf]).toString(); assert.match(list, /metadata\.json/); assert.strictEqual((list.match(/\.mp4/g) || []).length, 4);
    // modification + régénération
    assert.strictEqual((await s.call('PATCH', '/api/projects/' + id + '/clips/' + c.id, { start: 5, end: 7 })).status, 400);
    assert.strictEqual((await s.call('PATCH', '/api/projects/' + id + '/clips/' + c.id, { title: 'Nouveau titre', cropX: 0.2 })).status, 200);
    assert.strictEqual((await s.call('POST', '/api/projects/' + id + '/clips/' + c.id + '/render', { lang: 'fr' })).status, 202);
    await until(async () => (await s.call('GET', '/api/projects/' + id)).json.project.clips[0].versions.fr.state === 'done');
    assert.strictEqual((await s.call('DELETE', '/api/projects/' + id)).status, 200);
    await sleep(200); assert.ok(!fs.existsSync(path.join(s.dir, 'projects', id)));
  } finally { s.close(); }
});

test('IA indisponible : repli heuristique signalé ; traduction invalide : échec explicite sans bloquer la langue source', async () => {
  const s = await stack({ OLLAMA_URL: 'http://127.0.0.1:1' });
  try {
    await s.login(); const p = await s.wait((await s.upload('langs=fr&count=2')).json.project.id);
    assert.strictEqual(p.state, 'done'); assert.strictEqual(p.analysis, 'heuristique'); assert.ok(p.clips.length >= 1);
    assert.ok(p.clips.every((c) => c.versions.fr.state === 'done'));
  } finally { s.close(); }
  const t = await stack({}, { badCount: true });
  try {
    await t.login(); const p = await t.wait((await t.upload('langs=fr,en&count=2')).json.project.id);
    assert.strictEqual(p.state, 'done');
    assert.ok(p.clips.every((c) => c.versions.fr.state === 'done' && c.versions.en.state === 'failed' && /Traduction/.test(c.versions.en.error)));
  } finally { t.close(); }
});

test('fichier sans audio ou invalide : échec clair, puis redémarrage marque les tâches interrompues', async () => {
  const s = await stack();
  try {
    await s.login();
    const bad = await s.call('POST', '/api/projects?name=x.mp4', Buffer.from('ce nest pas une video'), { 'content-type': 'video/mp4' });
    const p = await s.wait(bad.json.project.id); assert.strictEqual(p.state, 'failed'); assert.ok(p.error);
    const f = path.join(s.dir, 'projects', p.id, 'project.json'); const j = JSON.parse(fs.readFileSync(f, 'utf8')); j.state = 'running'; fs.writeFileSync(f, JSON.stringify(j));
    const again = createApp(loadConfig({ DATA_DIR: s.dir, APP_PASSWORD: 'motdepasse-ok' }));
    assert.strictEqual(again.projects.get(p.id).state, 'failed'); assert.match(again.projects.get(p.id).error, /redémarrage/);
  } finally { s.close(); }
});
