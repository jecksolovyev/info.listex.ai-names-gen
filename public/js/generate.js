// Generator — real API client (Phase 2).
//
// Calls the same-origin proxy, which holds the service account and forwards to
// Vertex AI. Because the proxy also serves this page behind HTTP Basic Auth, the
// browser already has the credentials cached and attaches them to this fetch —
// no auth handling is needed here.
//
//   input:  { prompt, rows: [{ row_id, cells: { "D | Назва": "...", "E | TM": "..." } }], signal }
//   output: { items: [{ row_id, F, G }] }
//
// Add `?mock` to the URL to run fully offline against the mock instead.

export const USE_MOCK = new URLSearchParams(location.search).has('mock');

async function callApi({ prompt, rows, model, temperature, thinkingBudget, signal }) {
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, rows, model, temperature, thinkingBudget }),
    signal,
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch { detail = await res.text().catch(() => ''); }
    const err = new Error(`API ${res.status}${detail ? ': ' + detail : ''}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return { items: Array.isArray(data.items) ? data.items : [] };
}

export async function generateChunk(args) {
  if (USE_MOCK) {
    const mock = await import('./generate-mock.js');
    return mock.generateChunk(args);
  }
  return callApi(args);
}
