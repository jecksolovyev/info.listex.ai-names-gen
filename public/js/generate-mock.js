// Generator — MOCK (offline / no-server dev).
//
// Same interface as the real API client in generate.js. Enabled by adding
// `?mock` to the URL, so the whole UI still runs with no proxy and no Gemini.
//
//   input:  { prompt, rows: [{ row_id, cells: { "D | Назва": "...", "E | TM": "..." } }], signal }
//   output: { items: [{ row_id, F, G }] }
//
// The tool is agnostic to what "short" means — no length limit lives here; the
// prompt owns that rule. The mock just returns a plausible F and G.

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }
  });
}

// Pull a cell by column letter regardless of the header-name suffix.
function pickByLetter(cells, letter) {
  const key = Object.keys(cells).find((k) => k === letter || k.startsWith(letter + ' '));
  return key ? cells[key] : '';
}

export async function generateChunk({ prompt, rows, signal }) {
  // Simulate network + model latency so chunking/progress/ETA/persistence all
  // exercise realistically against the mock.
  await delay(250 + rows.length * 25, signal);

  const items = rows.map((row) => {
    const name = pickByLetter(row.cells, 'D') || Object.values(row.cells)[0] || '';
    const tm = pickByLetter(row.cells, 'E');
    const brand = tm && tm.toLowerCase() !== 'no brand' ? tm : '';
    const full = `[MOCK] ${[name, brand].filter(Boolean).join(' ')}`.trim();
    const short = `[MOCK] ${name}`.trim(); // "short" = name without the brand suffix; no length rule
    return { row_id: row.row_id, F: full, G: short };
  });

  return { items };
}
