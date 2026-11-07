'use strict';
// Mots horodatés -> phrases. Une phrase finit sur une ponctuation forte, un silence > 0,8 s ou 40 mots.
const END = /[.!?…。！？؟]$/;

function toSentences(words) {
  const out = []; let cur = [];
  const flush = () => { if (cur.length) { out.push({ id: out.length, start: cur[0].s, end: cur[cur.length - 1].e, text: cur.map((w) => w.w).join(' ').replace(/\s+([,.;:!?…])/g, '$1'), words: cur }); cur = []; } };
  words.forEach((w, i) => {
    cur.push(w);
    const next = words[i + 1];
    if (END.test(w.w) || cur.length >= 40 || (next && next.s - w.e > 0.8)) flush();
  });
  flush();
  return out;
}
const fmt = (t) => { const s = Math.floor(t); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };

// Fenêtres de phrases dont le texte tient dans maxChars (contexte limité des petits modèles).
function windows(sentences, maxChars) {
  const out = []; let cur = []; let n = 0;
  for (const s of sentences) {
    if (n + s.text.length > maxChars && cur.length) { out.push(cur); cur = []; n = 0; }
    cur.push(s); n += s.text.length + 8;
  }
  if (cur.length) out.push(cur);
  return out;
}
module.exports = { toSentences, windows, fmt };
