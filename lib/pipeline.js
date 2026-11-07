'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ff = require('./ffmpeg');
const llm = require('./llm');
const { toSentences, windows } = require('./transcript');
const hl = require('./highlights');
const { makeAss, spread } = require('./subs');

// Poids de chaque étape dans la progression globale. La progression affichée est la somme du réel : étapes finies + fraction mesurée.
const STAGES = [
  ['import', 'Importation', 5], ['transcription', 'Transcription', 30], ['analyse', 'Analyse', 15], ['selection', 'Sélection des passages', 3],
  ['traduction', 'Traduction', 7], ['montage', 'Montage et sous-titrage', 35], ['export', 'Exportation', 5],
];
const TOTAL = STAGES.reduce((n, s) => n + s[2], 0);
const LANG_NAMES = { fr: 'français', en: 'anglais', es: 'espagnol', de: 'allemand', ar: 'arabe', it: 'italien', pt: 'portugais', nl: 'néerlandais', tr: 'turc', ru: 'russe', ja: 'japonais', zh: 'chinois', hi: 'hindi' };

function setProgress(ctx, key, frac, detail) {
  let done = 0; for (const s of STAGES) { if (s[0] === key) break; done += s[2]; }
  const st = STAGES.find((s) => s[0] === key);
  const p = ctx.project;
  p.stage = key; p.stageLabel = st[1]; p.detail = detail || '';
  p.progress = Math.round(((done + st[2] * Math.min(1, Math.max(0, frac))) / TOTAL) * 1000) / 10;
  ctx.save(p);
}
const dir = (cfg, p) => path.join(cfg.dataDir, 'projects', p.id);

async function transcribe(ctx, audio, out) {
  const { cfg, project } = ctx;
  const [bin, ...pre] = cfg.transcribeCmd;
  await ff.run(bin, [...pre, audio, out, project.options.source || 'auto'], {
    signal: ctx.signal,
    onStdout: (s) => { const m = /PROGRESS\s+([0-9.]+)/g; let x, last; while ((x = m.exec(s))) last = parseFloat(x[1]); if (last !== undefined) setProgress(ctx, 'transcription', last, Math.round(last * 100) + ' % de l’audio transcrit'); },
  });
}

async function selectClips(ctx, sentences, lang) {
  const { cfg, project } = ctx;
  const count = project.options.count || Math.min(10, Math.max(1, Math.round(project.duration / 240)));
  const opt = { count, minSec: cfg.minClipSec, maxSec: cfg.maxClipSec };
  const wins = windows(sentences, cfg.windowChars);
  let raw = []; let ok = 0; let ai = await llm.available(cfg);
  if (ai) {
    for (let i = 0; i < wins.length; i++) {
      setProgress(ctx, 'analyse', i / wins.length, 'Passage ' + (i + 1) + ' sur ' + wins.length);
      const want = Math.min(count + 2, Math.max(2, Math.ceil(count / wins.length) + 1));
      try {
        const text = await llm.chatJson(cfg, 'Tu réponds uniquement en JSON valide.', hl.buildPrompt(wins[i], want, lang), ctx.signal);
        const got = hl.parseLlm(text); if (got.length) ok++; raw = raw.concat(got);
      } catch (e) { if (ctx.signal.aborted) throw e; }
    }
  }
  setProgress(ctx, 'analyse', 1, '');
  setProgress(ctx, 'selection', 0, '');
  let clips = ok ? hl.validate(raw, sentences, opt) : [];
  project.analysis = ok && clips.length ? 'ia' : 'heuristique';
  if (!clips.length) clips = hl.heuristic(sentences, opt);
  clips.sort((a, b) => a.start - b.start);
  return clips;
}

function wordsInRange(transcript, start, end) { return transcript.words.filter((w) => w.s >= start - 0.02 && w.e <= end + 0.05); }

async function translateClip(ctx, clip, srcWords, lang) {
  const { cfg, project } = ctx;
  const sents = toSentences(srcWords);
  const prompt = 'Traduis en ' + (LANG_NAMES[lang] || lang) + ' en gardant le sens, le ton et les expressions du locuteur. Réponds en JSON : {"title":"","description":"","sentences":["..."]}. Le tableau "sentences" doit avoir exactement ' + sents.length + ' éléments, dans le même ordre.\n' +
    JSON.stringify({ title: clip.title, description: clip.description, sentences: sents.map((s) => s.text) });
  for (let attempt = 0; attempt < 2; attempt++) {
    let j; try { j = JSON.parse(await llm.chatJson(cfg, 'Tu es un traducteur. Réponds uniquement en JSON valide.', prompt, ctx.signal)); } catch (e) { if (ctx.signal.aborted) throw e; continue; }
    if (j && Array.isArray(j.sentences) && j.sentences.length === sents.length && j.sentences.every((x) => typeof x === 'string' && x.trim())) {
      const words = []; sents.forEach((s, i) => words.push(...spread(j.sentences[i], s.start, s.end)));
      return { title: String(j.title || clip.title).slice(0, 100), description: String(j.description || '').slice(0, 300), words };
    }
  }
  throw new Error('Traduction en ' + lang + ' impossible (réponse du modèle invalide)');
}

async function renderVersion(ctx, clip, lang) {
  const { cfg, project } = ctx;
  const d = dir(cfg, project); const base = path.join(d, 'clips', clip.id + '_' + lang);
  const v = clip.versions[lang] = clip.versions[lang] || {};
  v.state = 'running'; v.error = undefined;
  try {
    const transcript = JSON.parse(fs.readFileSync(path.join(d, 'transcript.json'), 'utf8'));
    let words = wordsInRange(transcript, clip.start, clip.end); let title = clip.title; let description = clip.description;
    if (lang !== project.sourceLang) { const t = await translateClip(ctx, clip, words, lang); words = t.words; title = t.title; description = t.description; }
    clip.wordCount = wordsInRange(transcript, clip.start, clip.end).length;
    fs.writeFileSync(base + '.ass', makeAss(words, clip.start, { font: cfg.subFont }));
    await ff.renderClip(cfg, { src: project.sourceFile, info: project.info, start: clip.start, end: clip.end, ass: base + '.ass', cropX: clip.cropX, out: base + '.mp4', signal: ctx.signal });
    await ff.thumbnail(cfg, base + '.mp4', 1, base + '.jpg', ctx.signal).catch(() => {});
    Object.assign(v, { state: 'done', title, description, video: path.basename(base) + '.mp4', thumb: fs.existsSync(base + '.jpg') ? path.basename(base) + '.jpg' : null, duration: Math.round((clip.end - clip.start) * 10) / 10 });
  } catch (e) { if (ctx.signal.aborted) throw e; v.state = 'failed'; v.error = e.message; }
  ctx.save(project);
}

async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const it = items[i++]; await fn(it); } })); }

async function run(ctx) {
  const { cfg, project } = ctx; const d = dir(cfg, project);
  fs.mkdirSync(path.join(d, 'clips'), { recursive: true });
  project.state = 'running'; project.error = undefined;
  setProgress(ctx, 'import', 0, 'Analyse du fichier');
  project.info = await ff.probe(cfg, project.sourceFile);
  if (!project.info.hasVideo || !project.info.hasAudio) throw new Error('Le fichier doit contenir une piste vidéo et une piste audio.');
  project.duration = project.info.duration;
  if (project.duration > cfg.maxVideoMin * 60) throw new Error('Vidéo trop longue (' + Math.round(project.duration / 60) + ' min, maximum ' + cfg.maxVideoMin + ').');
  const audio = path.join(d, 'audio.wav'); const tfile = path.join(d, 'transcript.json');
  if (!fs.existsSync(audio)) await ff.extractAudio(cfg, project.sourceFile, audio, ctx.signal);
  setProgress(ctx, 'import', 1);

  if (!fs.existsSync(tfile)) { setProgress(ctx, 'transcription', 0, ''); await transcribe(ctx, audio, tfile); }
  const transcript = JSON.parse(fs.readFileSync(tfile, 'utf8'));
  if (!transcript.words || !transcript.words.length) throw new Error('Aucune parole détectée dans la vidéo.');
  project.sourceLang = project.options.source && project.options.source !== 'auto' ? project.options.source : (transcript.language || 'fr');
  project.words = transcript.words.length;
  setProgress(ctx, 'transcription', 1);

  const sentences = toSentences(transcript.words);
  const picked = await selectClips(ctx, sentences, project.sourceLang);
  if (!picked.length) throw new Error('Aucun passage exploitable trouvé.');
  project.clips = picked.map((c, i) => ({ id: 'c' + (i + 1), start: c.start, end: c.end, title: c.title, description: c.description, hashtags: c.hashtags, score: c.score, scoreNote: 'estimation de l’IA, pas une mesure', reason: c.reason, cropX: 0.5, versions: {} }));
  setProgress(ctx, 'selection', 1, project.clips.length + ' passage(s)');

  const langs = project.options.langs.length ? project.options.langs : [project.sourceLang];
  const jobs = []; project.clips.forEach((c) => langs.forEach((l) => jobs.push([c, l])));
  const todo = jobs.length; let done = 0;
  // La traduction est faite dans renderVersion ; on sépare la progression : traduction (LLM) puis montage (ffmpeg).
  const foreign = jobs.filter(([, l]) => l !== project.sourceLang);
  setProgress(ctx, 'traduction', foreign.length ? 0 : 1, foreign.length ? '0 / ' + foreign.length : 'Aucune traduction demandée');
  let tdone = 0;
  const trs = new Map();
  await pool(foreign, 1, async ([c, l]) => {
    try { trs.set(c.id + l, await translateClip(ctx, c, wordsInRange(transcript, c.start, c.end), l)); } catch (e) { trs.set(c.id + l, { error: e.message }); }
    tdone++; setProgress(ctx, 'traduction', tdone / foreign.length, tdone + ' / ' + foreign.length);
  });
  await pool(jobs, cfg.renderParallel, async ([c, l]) => {
    const t = trs.get(c.id + l);
    if (t && t.error) { c.versions[l] = { state: 'failed', error: t.error }; } else { await renderVersionWith(ctx, c, l, t); }
    done++; setProgress(ctx, 'montage', done / todo, done + ' / ' + todo + ' vidéo(s)');
  });
  setProgress(ctx, 'export', 1, '');
  project.state = 'done'; project.progress = 100; project.stage = 'done'; project.stageLabel = 'Terminé'; project.detail = '';
  project.finishedAt = new Date().toISOString();
  ctx.save(project);
}

// Variante de renderVersion qui réutilise une traduction déjà faite.
async function renderVersionWith(ctx, clip, lang, tr) {
  if (!tr) return renderVersion(ctx, clip, lang);
  const { cfg, project } = ctx; const d = dir(cfg, project); const base = path.join(d, 'clips', clip.id + '_' + lang);
  const v = clip.versions[lang] = { state: 'running' };
  try {
    fs.writeFileSync(base + '.ass', makeAss(tr.words, clip.start, { font: cfg.subFont }));
    clip.wordCount = wordsInRange(JSON.parse(fs.readFileSync(path.join(d, 'transcript.json'), 'utf8')), clip.start, clip.end).length;
    await ff.renderClip(cfg, { src: project.sourceFile, info: project.info, start: clip.start, end: clip.end, ass: base + '.ass', cropX: clip.cropX, out: base + '.mp4', signal: ctx.signal });
    await ff.thumbnail(cfg, base + '.mp4', 1, base + '.jpg', ctx.signal).catch(() => {});
    Object.assign(v, { state: 'done', title: tr.title, description: tr.description, video: path.basename(base) + '.mp4', thumb: fs.existsSync(base + '.jpg') ? path.basename(base) + '.jpg' : null, duration: Math.round((clip.end - clip.start) * 10) / 10 });
  } catch (e) { if (ctx.signal.aborted) throw e; v.state = 'failed'; v.error = e.message; }
  ctx.save(project);
}

module.exports = { run, renderVersion, STAGES, LANG_NAMES, dir };
