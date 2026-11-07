'use strict';
const { spawn } = require('child_process');

function run(bin, args, opts) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; if (opts && opts.onStdout) opts.onStdout(d.toString()); });
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    if (opts && opts.signal) opts.signal.addEventListener('abort', () => p.kill('SIGKILL'), { once: true });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(bin + ' a échoué (' + code + ') : ' + err.trim().split('\n').slice(-3).join(' | ')))));
  });
}

async function probe(cfg, file) {
  const j = JSON.parse(await run(cfg.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]));
  const v = (j.streams || []).find((s) => s.codec_type === 'video');
  const a = (j.streams || []).find((s) => s.codec_type === 'audio');
  return { duration: parseFloat(j.format.duration) || 0, width: v ? v.width : 0, height: v ? v.height : 0, hasVideo: !!v, hasAudio: !!a };
}
const extractAudio = (cfg, src, dst, signal) => run(cfg.ffmpeg, ['-y', '-v', 'error', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', dst], { signal });

// Découpe [start,end], recadre en 9:16 (cadrage horizontal cropX de 0 à 1, 0,5 = centre), incruste les sous-titres ASS.
function filterGraph(info, assPath, cropX) {
  const fx = Math.min(1, Math.max(0, cropX === undefined ? 0.5 : cropX));
  const esc = assPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
  const crop = info.width / info.height > 9 / 16
    ? 'crop=trunc(ih*9/16/2)*2:ih:(iw-trunc(ih*9/16/2)*2)*' + fx + ':0,scale=1080:1920'
    : 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920';
  return crop + ',ass=\'' + esc + '\',format=yuv420p';
}
function renderClip(cfg, o) {
  const args = ['-y', '-v', 'error', '-ss', String(o.start), '-t', String((o.end - o.start).toFixed(3)), '-i', o.src,
    '-vf', filterGraph(o.info, o.ass, o.cropX), '-c:v', 'libx264', '-preset', cfg.preset, '-crf', '21', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', o.out];
  return run(cfg.ffmpeg, args, { signal: o.signal });
}
const thumbnail = (cfg, src, t, dst, signal) => run(cfg.ffmpeg, ['-y', '-v', 'error', '-ss', String(t), '-i', src, '-frames:v', '1', '-vf', 'scale=360:-2', dst], { signal });
module.exports = { run, probe, extractAudio, renderClip, thumbnail, filterGraph };
