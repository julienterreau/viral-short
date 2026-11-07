'use strict';
// Sous-titres ASS animés : groupes de 1 à 4 mots, mot courant surligné (karaoke).
const cs = (t) => Math.max(0, Math.round(t * 100));
function ts(t) { const c = cs(t); const h = Math.floor(c / 360000), m = Math.floor((c % 360000) / 6000), s = Math.floor((c % 6000) / 100), x = c % 100; return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(x).padStart(2, '0'); }
const esc = (w) => String(w).replace(/[{}\\]/g, '').replace(/\n/g, ' ');

function chunk(words, max) {
  const out = []; let cur = [];
  for (const w of words) { cur.push(w); if (cur.length >= max || /[.!?…,;:]$/.test(w.w)) { out.push(cur); cur = []; } }
  if (cur.length) out.push(cur);
  return out;
}
// words : [{w,s,e}] en secondes ABSOLUES ; offset = début du clip.
function makeAss(words, offset, o) {
  const opt = Object.assign({ font: 'DejaVu Sans', size: 78, w: 1080, h: 1920, rtl: false }, o);
  const head = '[Script Info]\nScriptType: v4.00+\nPlayResX: ' + opt.w + '\nPlayResY: ' + opt.h + '\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n' +
    // Primary = mot déjà dit (or), Secondary = mot à venir (blanc). Couleurs ASS en &HBBGGRR.
    'Style: Default,' + opt.font + ',' + opt.size + ',&H0000D7FF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,6,2,2,60,60,420,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
  const lines = chunk(words, 4).map((g) => {
    const s = g[0].s - offset, e = g[g.length - 1].e - offset;
    const text = g.map((w, i) => { const next = g[i + 1]; const d = (next ? next.s : w.e) - w.s; return '{\\kf' + Math.max(1, cs(d)) + '}' + esc(w.w); }).join(' ');
    return 'Dialogue: 0,' + ts(Math.max(0, s)) + ',' + ts(Math.max(s + 0.1, e)) + ',Default,,0,0,0,,' + text;
  });
  return head + lines.join('\n') + '\n';
}
// Texte traduit réparti uniformément sur l'intervalle de la phrase d'origine.
function spread(text, start, end) {
  const toks = String(text).split(/\s+/).filter(Boolean); if (!toks.length) return [];
  const step = (end - start) / toks.length;
  return toks.map((w, i) => ({ w, s: start + i * step, e: start + (i + 1) * step }));
}
module.exports = { makeAss, spread, ts, chunk };
