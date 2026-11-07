'use strict';
// Faux Whisper : mêmes arguments et même format de sortie que worker/transcribe.py. Phrases de 8 mots toutes les 4 s.
const fs = require('fs');
const [, , audio, out, lang] = process.argv;
if (!fs.existsSync(audio)) { console.error('audio absent'); process.exit(2); }
const words = [];
for (let i = 0; i < 18; i++) {
  for (let k = 0; k < 8; k++) { const s = i * 4 + k * 0.42; words.push({ w: (k === 0 ? 'Phrase' : 'mot' + k) + (k === 7 ? '.' : ''), s: +s.toFixed(2), e: +(s + 0.38).toFixed(2) }); }
  console.log('PROGRESS ' + ((i + 1) / 18).toFixed(2));
}
fs.writeFileSync(out, JSON.stringify({ language: lang === 'auto' ? 'fr' : lang, words }));
