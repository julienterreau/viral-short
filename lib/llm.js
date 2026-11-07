'use strict';
// Fournisseur IA interchangeable : ici Ollama (modèles libres, aucun coût par token).
async function chatJson(cfg, system, user, signal) {
  const r = await fetch(cfg.ollamaUrl + '/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: signal || AbortSignal.timeout(cfg.llmTimeoutMs),
    body: JSON.stringify({ model: cfg.chatModel, stream: false, format: 'json', keep_alive: '30m', options: { temperature: 0.3, num_ctx: cfg.numCtx, num_predict: 2048 }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  });
  if (!r.ok) throw new Error('Ollama : HTTP ' + r.status);
  const j = await r.json();
  return (j.message && j.message.content) || '';
}
async function available(cfg) {
  try { const r = await fetch(cfg.ollamaUrl + '/api/tags', { signal: AbortSignal.timeout(3000) }); return r.ok; } catch (e) { return false; }
}
module.exports = { chatJson, available };
