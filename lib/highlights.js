'use strict';
const { fmt } = require('./transcript');

function buildPrompt(sentences, want, lang) {
  const list = sentences.map((s) => '[' + s.id + '] (' + fmt(s.start) + ') ' + s.text).join('\n');
  return 'Tu es monteur de vidéos courtes virales. Voici la transcription numérotée d’une vidéo' + (lang ? ' (langue : ' + lang + ')' : '') + '.\n' +
    'Choisis jusqu’à ' + want + ' extraits indépendants, compréhensibles sans le reste de la vidéo. Critères : accroche dans les premières secondes, moment surprenant, révélation, histoire, humour, émotion, prise de position, phrase mémorable, bon rythme. ' +
    'Un extrait commence au début d’une phrase et se termine sur une conclusion, dure entre 20 et 90 secondes, ne chevauche pas un autre extrait.\n' +
    'Réponds uniquement en JSON : {"clips":[{"start_id":0,"end_id":0,"title":"titre accrocheur","description":"1 phrase","hashtags":["#a","#b"],"score":0-100,"reason":"pourquoi"}]}\n' +
    'start_id et end_id sont des numéros de phrases listés ci-dessous.\n\n' + list;
}

function parseLlm(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a < 0 || b < a) return [];
  try { const j = JSON.parse(t.slice(a, b + 1)); return Array.isArray(j.clips) ? j.clips : []; } catch (e) { return []; }
}

// Aligne sur les phrases, borne la durée, évite doublons/chevauchements, garde les meilleurs scores.
function validate(rawClips, sentences, o) {
  const min = o.minSec || 20, max = o.maxSec || 90, N = sentences.length;
  const cands = [];
  for (const c of rawClips) {
    let a = Number(c.start_id), b = Number(c.end_id);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b >= N || b < a) continue;
    const dur = () => sentences[b].end - sentences[a].start;
    while (dur() < min && b < N - 1 && sentences[b + 1].end - sentences[a].start <= max) b++;
    while (dur() > max && b > a) b--;
    // finir sur une phrase conclusive si possible
    while (!/[.!?…]$/.test(sentences[b].text) && b < N - 1 && sentences[b + 1].end - sentences[a].start <= max) b++;
    if (dur() < min * 0.6 || dur() > max) continue;
    cands.push({ a, b, title: String(c.title || '').slice(0, 100), description: String(c.description || '').slice(0, 300), hashtags: (Array.isArray(c.hashtags) ? c.hashtags : []).map((h) => '#' + String(h).replace(/^#/, '').replace(/\s+/g, '')).filter((h) => h.length > 1).slice(0, 6), score: Math.max(0, Math.min(100, Math.round(Number(c.score) || 0))), reason: String(c.reason || '').slice(0, 300) });
  }
  cands.sort((x, y) => y.score - x.score);
  const kept = [];
  for (const c of cands) {
    const s0 = sentences[c.a].start, e0 = sentences[c.b].end;
    const clash = kept.some((k) => { const s1 = sentences[k.a].start, e1 = sentences[k.b].end; const ov = Math.min(e0, e1) - Math.max(s0, s1); return ov > 0.1 * Math.min(e0 - s0, e1 - s1); });
    if (!clash) kept.push(c);
    if (kept.length >= o.count) break;
  }
  return kept.map((c) => ({ startSentence: c.a, endSentence: c.b, start: sentences[c.a].start, end: sentences[c.b].end, title: c.title, description: c.description, hashtags: c.hashtags, score: c.score, reason: c.reason }));
}

// Secours sans IA : fenêtres denses en parole contenant questions/exclamations. Marqué « heuristique ».
function heuristic(sentences, o) {
  const raw = []; const min = o.minSec || 20, max = o.maxSec || 90;
  for (let a = 0; a < sentences.length; a++) {
    let b = a; while (b < sentences.length - 1 && sentences[b].end - sentences[a].start < min) b++;
    if (sentences[b].end - sentences[a].start > max) continue;
    const span = sentences.slice(a, b + 1); const words = span.reduce((n, s) => n + s.words.length, 0);
    const dur = sentences[b].end - sentences[a].start; const punch = span.filter((s) => /[?!]/.test(s.text)).length;
    raw.push({ start_id: a, end_id: b, title: sentences[a].text.slice(0, 70), description: '', hashtags: [], score: Math.min(60, Math.round((words / dur) * 12 + punch * 6)), reason: 'sélection heuristique (IA indisponible)' });
  }
  return validate(raw, sentences, o);
}
module.exports = { buildPrompt, parseLlm, validate, heuristic };
