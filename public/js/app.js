import * as db from './db.js';
import * as io from './xlsx-io.js';
import { generateChunk, USE_MOCK } from './generate.js';

const DEFAULT_BATCH = 20;
const CONCURRENCY = 6;          // chunks in flight
const MIN_CONCURRENCY = 1;      // adaptive floor under sustained 429s
const MAX_TRIES = 3;            // attempts per chunk (incl. targeted partial retries)
const ETA_WINDOW_MS = 30000;    // rolling-throughput window for ETA
const SAVE_THROTTLE_MS = 1500;  // min gap between IndexedDB writes during a run
const ROW_H = 26;               // fixed grid row height (px) — must match CSS
const ROW_BUFFER = 8;           // extra rows rendered above/below the viewport

const GEMINI_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3.1-flash-lite', 'gemini-3.5-flash'];
const DEFAULT_MODEL = 'gemini-2.5-flash-lite'; // cheapest — default for new sessions
const DEFAULT_TEMPERATURE = 0.1; // low — rewriting should be near-deterministic
const DEFAULT_THINKING_BUDGET = 0; // 0 = thinking off (fast); ignored for pro models

const appEl = document.getElementById('app');

// In-memory working state:
//   current = { record (IndexedDB record), parsed }
//   run     = active run state, or null
//   grid    = table view state (scroll el, selection), or null
let current = null;
let run = null;
let grid = null;

// ---------- helpers ----------

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function fmtDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString();
}

function fmtDuration(sec) {
  if (!isFinite(sec) || sec < 0) return '—';
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function outName(fileName) {
  return fileName.replace(/\.xlsx$/i, '') + '-named.xlsx';
}

// ---------- routing ----------

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

async function route() {
  const m = location.hash.match(/^#\/session\/(.+)$/);
  if (m) await showEditor(m[1]);
  else await showSessions();
}

window.addEventListener('hashchange', route);
window.addEventListener('resize', () => { if (grid) scheduleBody(); });
window.addEventListener('mouseup', () => { if (grid) grid.selecting = false; });
window.addEventListener('keydown', onGlobalKeydown);
window.addEventListener('click', () => {
  const d = document.getElementById('si-dropdown');
  if (d) d.classList.add('hidden'); // close the gear menu on any outside click
});

// ---------- sessions screen ----------

async function showSessions() {
  current = null;
  run = null;
  grid = null;
  appEl.className = '';
  const sessions = await db.listSessions();

  appEl.innerHTML = `
    <div class="panel">
      <h2>New session</h2>
      <div id="dropzone" class="dropzone">
        Drop an <b>.xlsx</b> file here, or click to choose.
        <input id="file" type="file" accept=".xlsx" class="hidden" />
      </div>
    </div>
    <div class="panel">
      <h2>Sessions</h2>
      <div id="session-list">
        ${sessions.length ? '' : '<p class="muted">No saved sessions yet.</p>'}
        ${sessions.map(renderSessionCard).join('')}
      </div>
      <p class="small muted" id="storage" style="margin:12px 0 0"></p>
    </div>`;

  const dz = document.getElementById('dropzone');
  const file = document.getElementById('file');
  dz.addEventListener('click', () => file.click());
  file.addEventListener('change', () => file.files[0] && onFile(file.files[0]));
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('drag');
    const f = e.dataTransfer.files[0];
    if (f) onFile(f);
  });

  appEl.querySelectorAll('[data-open]').forEach((b) =>
    b.addEventListener('click', () => go(`#/session/${b.dataset.open}`)));
  appEl.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm('Delete this session? This cannot be undone.')) {
        await db.deleteSession(b.dataset.del);
        showSessions();
      }
    }));

  showStorageEstimate();
}

function renderSessionCard(s) {
  const p = s.progress || { done: 0, total: 0 };
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  return `
    <div class="session-card" data-open="${esc(s.id)}" style="cursor:pointer">
      <div style="flex:1">
        <div class="title">${esc(s.fileName)}</div>
        <div class="meta">Created ${esc(fmtDate(s.createdAt))} · sheet “${esc(s.sheetName || '')}” · ${p.done}/${p.total} rows (${pct}%)</div>
      </div>
      <button class="danger" data-del="${esc(s.id)}">Delete</button>
    </div>`;
}

async function showStorageEstimate() {
  const el = document.getElementById('storage');
  if (!el || !navigator.storage || !navigator.storage.estimate) return;
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    if (!quota) return;
    const mb = (n) => (n / 1048576).toFixed(0);
    const pct = Math.round((usage / quota) * 100);
    el.textContent = `Browser storage: ${mb(usage)} MB of ~${mb(quota)} MB used (${pct}%).`;
    if (pct >= 80) {
      el.classList.remove('muted');
      el.style.color = '#d97706';
      el.textContent += ' Running low — download results and delete finished sessions.';
    }
  } catch { /* estimate unsupported */ }
}

async function onFile(file) {
  const bytes = await file.arrayBuffer();
  const hash = await io.hashBytes(bytes);

  const existing = await db.findByHash(hash);
  if (existing) {
    alert('This file matches an existing session — opening it instead of creating a duplicate.');
    go(`#/session/${existing.id}`);
    return;
  }

  let wb;
  try {
    wb = io.parseWorkbook(bytes);
  } catch (err) {
    alert('Could not read this file as .xlsx:\n' + err.message);
    return;
  }
  const names = io.sheetNames(wb);
  if (!names.length) { alert('This workbook has no sheets.'); return; }

  const { dataRows } = io.readSheet(wb, names[0], true);
  const record = {
    id: crypto.randomUUID(),
    fileName: file.name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    fileHash: hash,
    xlsxBytes: bytes,
    sheetName: names[0],
    hasHeader: true,
    prompt: '',
    model: DEFAULT_MODEL,
    batchSize: DEFAULT_BATCH,
    columns: null,
    results: {},
    progress: { done: 0, total: dataRows.length },
  };
  await db.putSession(record);
  go(`#/session/${record.id}`);
}

// ---------- editor screen ----------

function parseCurrent() {
  const wb = io.parseWorkbook(current.record.xlsxBytes);
  const hasHeader = current.record.hasHeader !== false; // default true
  const { columns, dataRows } = io.readSheet(wb, current.record.sheetName, hasHeader);
  const outCols = io.resolveOutputColumns(columns);
  const inputColumns = io.resolveInputColumns(columns, outCols, hasHeader);
  const sourceCol = inputColumns.find((c) => c.letter === 'D') || inputColumns[0] || null;

  // Columns shown in the table: the sheet's own columns PLUS the output columns
  // even when they're appended (so generated F/G are visible, not just downloaded).
  const displayColumns = columns.slice();
  for (const oc of [outCols.outFull, outCols.outShort]) {
    if (!displayColumns.some((c) => c.index === oc.index)) {
      displayColumns.push({ index: oc.index, letter: oc.letter, name: oc.name });
    }
  }
  displayColumns.sort((a, b) => a.index - b.index);

  current.parsed = {
    wb, columns, displayColumns, dataRows, outCols, inputColumns,
    sourceIndex: sourceCol ? sourceCol.index : 0,
    sheetNames: io.sheetNames(wb),
  };
  current.record.columns = {
    inputs: inputColumns.map((c) => c.letter),
    outFull: outCols.outFull,
    outShort: outCols.outShort,
  };
  current.record.hasHeader = hasHeader;
  if (!current.record.model) current.record.model = DEFAULT_MODEL;
  if (!current.record.batchSize) current.record.batchSize = DEFAULT_BATCH;
  if (current.record.temperature == null) current.record.temperature = DEFAULT_TEMPERATURE;
  if (current.record.thinkingBudget == null) current.record.thinkingBudget = DEFAULT_THINKING_BUDGET;
  current.record.progress = {
    done: Object.keys(current.record.results).length,
    total: dataRows.length,
  };
}

async function showEditor(id) {
  const record = await db.getSession(id);
  if (!record) { go('#/'); return; }
  current = { record, parsed: null };
  run = null;
  grid = null;
  parseCurrent();
  renderEditor();
}

function renderEditor() {
  const { record, parsed } = current;
  const { displayColumns, dataRows } = parsed;
  const total = dataRows.length;

  const multiSheet = parsed.sheetNames.length > 1;
  const sheetPicker = multiSheet
    ? `<label class="si-field">Sheet
        <select id="sheet">${parsed.sheetNames
          .map((n) => `<option value="${esc(n)}" ${n === record.sheetName ? 'selected' : ''}>${esc(n)}</option>`)
          .join('')}</select></label>`
    : '';

  const modelOpts = GEMINI_MODELS
    .map((m) => `<option value="${m}" ${m === record.model ? 'selected' : ''}>${m}</option>`)
    .join('');

  appEl.className = 'editor-mode';
  appEl.innerHTML = `
    <div class="editor">
      <div class="session-info" id="session-info">
        <div class="si-head">
          <button class="link" id="back">← Sessions</button>
          <button class="si-collapse" id="si-collapse" title="Collapse">▾</button>
          <div class="si-title">${esc(record.fileName)}</div>
          <div class="si-counts">
            <span class="status-ok">ok <b id="c-ok">0</b></span>
            <span class="status-failed">failed <b id="c-failed">0</b></span>
            <span class="muted">total <b id="c-total">${total}</b></span>
          </div>
          <div class="spacer"></div>
          <div class="si-menu">
            <button class="gear" id="gear" title="Session actions">⚙</button>
            <div class="si-dropdown hidden" id="si-dropdown">
              <button id="reset-session">Reset session</button>
              <button id="delete-session" class="danger">Delete session</button>
            </div>
          </div>
          <button id="download" class="primary">Download Excel</button>
        </div>
        <div class="si-body" id="si-body">
          <label class="si-field">Model
            <select id="model">${modelOpts}</select></label>
          <label class="si-field">Batch size
            <input id="batch" type="number" min="1" max="200" value="${record.batchSize}" /></label>
          <label class="si-field">Temperature
            <input id="temp" type="number" min="0" max="2" step="0.1" value="${record.temperature ?? DEFAULT_TEMPERATURE}" /></label>
          <label class="si-field">Thinking budget
            <input id="thinking" type="number" min="0" step="128" value="${record.thinkingBudget ?? DEFAULT_THINKING_BUDGET}" title="Thinking tokens (0 = off). Ignored for pro models." /></label>
          <label class="si-field">Max FULL length
            <input id="max-full" type="number" min="0" placeholder="∞" value="${record.maxFull || ''}" /></label>
          <label class="si-field">Max SHORT length
            <input id="max-short" type="number" min="0" placeholder="∞" value="${record.maxShort || ''}" /></label>
          <label class="si-check"><input id="has-header" type="checkbox" ${record.hasHeader !== false ? 'checked' : ''} /> First row is header</label>
          ${sheetPicker}
        </div>
      </div>

      <div class="editor-main">
        <div class="table-scroll" id="table-scroll">
          <table id="grid">
            <thead>${renderGridHead(displayColumns)}</thead>
            <tbody id="grid-body"></tbody>
          </table>
        </div>

        <div class="pp-resizer" id="pp-resizer" title="Drag to resize"></div>

        <div class="prompt-panel" id="prompt-panel" style="width:${Math.max(380, record.promptWidth || 380)}px">
          <label class="ppl">Prompt (Rules)</label>
          <div class="pp-hint small muted">
            Reference columns by <b>header name</b> (recommended) — or by letter; both work.
            Every column <b>except</b> the generated <b>FULL NAME</b> / <b>SHORT NAME</b> is sent to the model.
            Columns with an empty header are not sent.
          </div>
          <textarea id="prompt">${esc(record.prompt || '')}</textarea>

          <div class="run-row">
            <button id="run" class="primary">RUN</button>
            <label class="rng">from <input id="from" type="number" min="0" max="${Math.max(0, total - 1)}" value="0" /></label>
            <label class="rng">to <input id="to" type="number" min="0" max="${Math.max(0, total - 1)}" value="${Math.max(0, total - 1)}" /></label>
          </div>
          <div class="run-row">
            <button id="continue">CONTINUE</button>
            <button id="retry" disabled>Retry failed</button>
            <button id="stop" class="danger hidden">STOP</button>
          </div>

          <div id="progress-wrap" class="hidden">
            <div class="progress"><span id="bar"></span></div>
            <div class="run-row small muted">
              <span id="rate"></span><div class="spacer"></div><span>ETA <b id="eta">—</b></span>
            </div>
          </div>
          <div class="small muted">Tip: drag to select rows in the table — it fills <b>from/to</b>, then press RUN.</div>
        </div>
      </div>
    </div>`;

  document.getElementById('back').addEventListener('click', () => go('#/'));
  document.getElementById('si-collapse').addEventListener('click', () => {
    document.getElementById('session-info').classList.toggle('collapsed');
    if (grid) scheduleBody();
  });

  const prompt = document.getElementById('prompt');
  prompt.addEventListener('change', async () => {
    current.record.prompt = prompt.value;
    await db.putSession(current.record);
  });
  document.getElementById('model').addEventListener('change', async (e) => {
    current.record.model = e.target.value;
    await db.putSession(current.record);
  });
  document.getElementById('batch').addEventListener('change', async (e) => {
    current.record.batchSize = Math.max(1, parseInt(e.target.value, 10) || DEFAULT_BATCH);
    e.target.value = current.record.batchSize;
    await db.putSession(current.record);
  });
  document.getElementById('temp').addEventListener('change', async (e) => {
    let v = parseFloat(e.target.value);
    if (!Number.isFinite(v)) v = DEFAULT_TEMPERATURE;
    v = Math.min(2, Math.max(0, v));
    current.record.temperature = v;
    e.target.value = v;
    await db.putSession(current.record);
  });
  document.getElementById('thinking').addEventListener('change', async (e) => {
    let v = parseInt(e.target.value, 10);
    if (!Number.isFinite(v) || v < 0) v = DEFAULT_THINKING_BUDGET;
    current.record.thinkingBudget = v;
    e.target.value = v;
    await db.putSession(current.record);
  });
  const onMaxChange = (field) => async (e) => {
    const v = parseInt(e.target.value, 10);
    current.record[field] = Number.isFinite(v) && v > 0 ? v : 0; // 0 = no limit
    e.target.value = current.record[field] || '';
    await db.putSession(current.record);
  };
  document.getElementById('max-full').addEventListener('change', onMaxChange('maxFull'));
  document.getElementById('max-short').addEventListener('change', onMaxChange('maxShort'));
  document.getElementById('has-header').addEventListener('change', async (e) => {
    // Toggling shifts every row by one, so existing results no longer line up.
    if (Object.keys(current.record.results).length &&
        !confirm('Changing the header setting shifts all rows and clears this session’s results. Continue?')) {
      e.target.checked = current.record.hasHeader !== false;
      return;
    }
    current.record.hasHeader = e.target.checked;
    current.record.results = {};
    parseCurrent();
    await db.putSession(current.record);
    renderEditor();
  });

  if (multiSheet) {
    document.getElementById('sheet').addEventListener('change', async (e) => {
      if (Object.keys(current.record.results).length &&
          !confirm('Switching sheets clears results for this session. Continue?')) {
        e.target.value = current.record.sheetName;
        return;
      }
      current.record.sheetName = e.target.value;
      current.record.results = {};
      parseCurrent();
      await db.putSession(current.record);
      renderEditor();
    });
  }

  document.getElementById('run').addEventListener('click', onRun);
  document.getElementById('continue').addEventListener('click', onContinue);
  document.getElementById('retry').addEventListener('click', onRetryFailed);
  document.getElementById('stop').addEventListener('click', () => run && run.abort.abort());
  document.getElementById('download').addEventListener('click', onDownload);

  document.getElementById('gear').addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('si-dropdown').classList.toggle('hidden');
  });
  document.getElementById('reset-session').addEventListener('click', onResetSession);
  document.getElementById('delete-session').addEventListener('click', onDeleteSession);

  setupPromptResizer();
  buildGrid();
  updateCounters();
}

const PROMPT_MIN_W = 380;

function setupPromptResizer() {
  const resizer = document.getElementById('pp-resizer');
  const panel = document.getElementById('prompt-panel');
  if (!resizer || !panel) return;
  let dragging = false;

  const onMove = (e) => {
    if (!dragging) return;
    // Panel is pinned to the right edge; its width = distance from cursor to that edge.
    const w = Math.max(PROMPT_MIN_W, Math.min(window.innerWidth - 300, window.innerWidth - e.clientX));
    panel.style.width = w + 'px';
    if (grid) scheduleBody();
  };
  const onUp = async () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    const w = parseInt(panel.style.width, 10);
    if (w) { current.record.promptWidth = w; await db.putSession(current.record); }
  };

  resizer.addEventListener('mousedown', (e) => {
    dragging = true;
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
}

// ---------- table (virtualized) ----------

function renderGridHead(columns) {
  const { outFull, outShort } = current.parsed.outCols;
  const isGen = (i) => i === outFull.index || i === outShort.index;
  const cols = columns
    .map((c) => `<th class="${isGen(c.index) ? 'gencol' : 'srccol'}" title="${esc(c.name)}">${esc(c.letter)}${c.name ? ' · ' + esc(c.name) : ''}</th>`)
    .join('');
  return `<tr><th class="status"></th><th class="rownum">#</th>${cols}</tr>`;
}

function buildGrid() {
  const scrollEl = document.getElementById('table-scroll');
  const bodyEl = document.getElementById('grid-body');
  grid = { scrollEl, bodyEl, selAnchor: -1, selFocus: -1, selecting: false, scheduled: false };

  scrollEl.addEventListener('scroll', scheduleBody);
  bodyEl.addEventListener('mousedown', (e) => {
    const tr = e.target.closest('tr[data-row]');
    if (!tr) return;
    grid.selAnchor = grid.selFocus = Number(tr.dataset.row);
    grid.selecting = true;
    applySelection();
    e.preventDefault(); // avoid text selection while dragging
  });
  bodyEl.addEventListener('mouseover', (e) => {
    if (!grid.selecting) return;
    const tr = e.target.closest('tr[data-row]');
    if (!tr) return;
    grid.selFocus = Number(tr.dataset.row);
    applySelection();
  });

  renderTableBody();
}

function selRange() {
  if (grid.selAnchor < 0) return null;
  return [Math.min(grid.selAnchor, grid.selFocus), Math.max(grid.selAnchor, grid.selFocus)];
}

function applySelection() {
  const r = selRange();
  if (r) {
    document.getElementById('from').value = r[0];
    document.getElementById('to').value = r[1];
  }
  renderTableBody();
}

// Ctrl/Cmd+A selects every row (unless the user is typing in a field).
function onGlobalKeydown(e) {
  if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) {
    const t = e.target;
    if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;
    if (!grid || !current || !current.parsed) return;
    const total = current.parsed.dataRows.length;
    if (!total) return;
    grid.selAnchor = 0;
    grid.selFocus = total - 1;
    applySelection();
    e.preventDefault();
  }
}

function scheduleBody() {
  if (!grid || grid.scheduled) return;
  grid.scheduled = true;
  requestAnimationFrame(() => {
    grid.scheduled = false;
    renderTableBody();
  });
}

function statusIcon(res) {
  if (!res) return '';
  if (res.status === 'ok') return '<span class="st st-ok" title="ok">✓</span>';
  return `<span class="st st-fail" title="${esc(res.error || 'failed')}">✕</span>`;
}

function renderTableBody() {
  if (!grid) return;
  const { dataRows, displayColumns, outCols } = current.parsed;
  const results = current.record.results;
  const total = dataRows.length;

  const scrollTop = grid.scrollEl.scrollTop;
  const viewH = grid.scrollEl.clientHeight || 600;
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - ROW_BUFFER);
  const visible = Math.ceil(viewH / ROW_H) + 2 * ROW_BUFFER;
  const last = Math.min(total, first + visible);

  const ncols = displayColumns.length + 2;
  const sel = selRange() || [-1, -2];
  const fullIdx = outCols.outFull.index;
  const shortIdx = outCols.outShort.index;

  let html = '';
  if (first > 0) html += `<tr class="spacer"><td colspan="${ncols}" style="height:${first * ROW_H}px"></td></tr>`;
  for (let i = first; i < last; i++) {
    const row = dataRows[i];
    const res = results[i];
    const selCls = i >= sel[0] && i <= sel[1] ? ' sel' : '';
    let tds = '';
    for (const c of displayColumns) {
      const gen = c.index === fullIdx || c.index === shortIdx;
      let v = row[c.index];
      if (res && gen) v = c.index === fullIdx ? res.full : res.short;
      tds += `<td class="${gen ? 'gencol' : 'srccol'}" title="${esc(v)}">${esc(v)}</td>`;
    }
    html += `<tr data-row="${i}" class="grow${selCls}"><td class="status">${statusIcon(res)}</td><td class="rownum">${i}</td>${tds}</tr>`;
  }
  if (last < total) html += `<tr class="spacer"><td colspan="${ncols}" style="height:${(total - last) * ROW_H}px"></td></tr>`;

  grid.bodyEl.innerHTML = html;
}

// ---------- run engine ----------

function* chunk(arr, size) {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const onAbort = () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); };
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort); // don't leak listeners across a run
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

const jitter = (base) => base * (0.5 + Math.random());
// Prefer the structured status; only fall back to a NARROW message match (never
// bare "rate" — that substring hides inside "generate").
const isRateLimited = (err) => !!err && (err.status === 429 || err.status === 503 ||
  /\b429\b|RESOURCE_EXHAUSTED|rate.?limit|too many requests/i.test(err.message || ''));

async function waitForCooldown(signal) {
  const wait = run.cooldownUntil - Date.now();
  if (wait > 0) await sleep(wait, signal);
}

function noteRateLimit() {
  run.concurrency = Math.max(MIN_CONCURRENCY, run.concurrency - 1);
  run.cooldownUntil = Math.max(run.cooldownUntil, Date.now() + jitter(1500));
}

// A clean chunk (no rate limit, past any cooldown) earns one concurrency slot back,
// so a brief 429 spike doesn't throttle the whole rest of the run.
function noteSuccess() {
  if (Date.now() >= run.cooldownUntil && run.concurrency < CONCURRENCY) {
    run.concurrency += 1;
  }
}

function rollingRate() {
  const now = Date.now();
  while (run.completions.length && run.completions[0] < now - ETA_WINDOW_MS) run.completions.shift();
  const span = Math.min(now - run.startTime, ETA_WINDOW_MS) / 1000;
  return span > 0 ? run.completions.length / span : 0;
}

// One chunk: row-id round-trip validation, exponential backoff + jitter, and
// TARGETED partial retry (re-request only the still-missing row-ids). Returns
// { byId, error } — error is the last failure message when incomplete.
async function generateChunkWithRetry(prompt, rowsAll, gen, signal) {
  const wanted = new Set(rowsAll.map((r) => r.row_id));
  const best = new Map();
  let pending = rowsAll;
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    await waitForCooldown(signal);
    try {
      const { items } = await generateChunk({ prompt, rows: pending, ...gen, signal });
      for (const it of items || []) {
        if (wanted.has(it.row_id) && !best.has(it.row_id)) best.set(it.row_id, it);
      }
      if (best.size === wanted.size) return { byId: best, error: null };
      lastError = 'model omitted some rows';
      pending = rowsAll.filter((r) => !best.has(r.row_id));
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      lastError = err.message;
      if (isRateLimited(err)) noteRateLimit();
    }
    if (attempt < MAX_TRIES) await sleep(jitter(500 * 2 ** (attempt - 1)), signal);
  }
  return { byId: best, error: lastError };
}

// Turn a model item into a stored result. Failure cases:
//   - no usable Full name (or the row was omitted)     -> blank + failed
//   - Full/Short exceed the session's max length (if set) -> KEEP the text + failed,
//     so the CM can see what was generated and why it was flagged.
function classifyRow(item, chunkError, maxFull, maxShort) {
  if (!(item && item.F)) {
    return { full: '', short: '', status: 'failed', error: chunkError || (item ? 'empty result from model' : 'row omitted by model') };
  }
  const full = item.F;
  const short = item.G || '';
  if (maxFull && full.length > maxFull) {
    return { full, short, status: 'failed', error: `FULL too long: ${full.length} > ${maxFull}` };
  }
  if (maxShort && short.length > maxShort) {
    return { full, short, status: 'failed', error: `SHORT too long: ${short.length} > ${maxShort}` };
  }
  return { full, short, status: 'ok' };
}

function onRun() {
  const { dataRows } = current.parsed;
  const total = dataRows.length;
  const from = Math.max(0, Math.min(total - 1, parseInt(document.getElementById('from').value, 10) || 0));
  const to = Math.max(from, Math.min(total - 1, parseInt(document.getElementById('to').value, 10) || 0));
  const indices = [];
  for (let i = from; i <= to; i++) indices.push(i);
  return runIndices(indices);
}

function onContinue() {
  const { dataRows } = current.parsed;
  const results = current.record.results;
  const indices = [];
  for (let i = 0; i < dataRows.length; i++) if (!results[i]) indices.push(i);
  if (!indices.length) { alert('All rows are already processed.'); return; }
  return runIndices(indices);
}

function onRetryFailed() {
  const results = current.record.results;
  const indices = Object.keys(results)
    .filter((k) => results[k].status === 'failed')
    .map(Number)
    .sort((a, b) => a - b);
  if (!indices.length) return;
  return runIndices(indices);
}

// Core run loop over an arbitrary set of row indices, with a concurrency pool.
async function runIndices(indices) {
  if (run) return;
  const promptText = document.getElementById('prompt').value.trim();
  if (!promptText) { alert('Paste a prompt first.'); return; }
  current.record.prompt = promptText;

  const { dataRows, inputColumns } = current.parsed;
  indices = indices.filter((i) => i >= 0 && i < dataRows.length);
  if (!indices.length) { alert('No rows to process.'); return; }

  const batch = Math.max(1, current.record.batchSize || DEFAULT_BATCH);
  const gen = {
    model: current.record.model || DEFAULT_MODEL,
    temperature: current.record.temperature ?? DEFAULT_TEMPERATURE,
    thinkingBudget: current.record.thinkingBudget ?? DEFAULT_THINKING_BUDGET,
  };
  const maxFull = current.record.maxFull || 0;   // 0 = no limit
  const maxShort = current.record.maxShort || 0;

  run = {
    abort: new AbortController(),
    total: indices.length,
    done: 0,
    concurrency: CONCURRENCY,
    cooldownUntil: 0,
    completions: [],
    lastSave: 0,
    startTime: Date.now(),
  };
  setRunning(true);
  // Heartbeat: refresh the UI every second even when no chunk completes, so a slow
  // first response (pro can take ~30s/batch) shows a live elapsed counter, not a freeze.
  run.ticker = setInterval(updateRunUI, 1000);
  updateRunUI();

  const groups = [...chunk(indices, batch)];

  async function processGroup(group) {
    const rows = group.map((i) => ({ row_id: i, cells: io.rowCells(dataRows[i], inputColumns) }));
    let byId = new Map();
    let error = null;
    try {
      ({ byId, error } = await generateChunkWithRetry(promptText, rows, gen, run.abort.signal));
    } catch (err) {
      if (err.name === 'AbortError') return;
      error = err.message;
    }
    if (!error) noteSuccess(); // fully-resolved chunk earns a concurrency slot back
    const now = Date.now();
    for (const i of group) {
      const item = byId.get(i);
      current.record.results[i] = classifyRow(item, error, maxFull, maxShort);
      run.done += 1;
      run.completions.push(now);
    }
    current.record.progress.done = Object.keys(current.record.results).length;
    await maybeSave();
    updateRunUI();
  }

  // Worker pool: workers pull from a shared queue. When the (adaptive) concurrency
  // drops below the live worker count a worker PARKS (releasing its active slot)
  // instead of exiting, so it can resume once noteSuccess raises concurrency back.
  let nextGroup = 0;
  let active = 0;
  async function worker() {
    active += 1;
    try {
      while (!run.abort.signal.aborted && nextGroup < groups.length) {
        if (active > run.concurrency && active > 1) { // over the limit: park, don't quit
          active -= 1;
          let aborted = false;
          try { await sleep(jitter(500), run.abort.signal); } catch { aborted = true; }
          active += 1; // re-balance before any exit so `finally` stays symmetric
          if (aborted) return;
          continue;
        }
        await processGroup(groups[nextGroup++]);
      }
    } finally {
      active -= 1;
    }
  }

  try {
    const starters = [];
    for (let i = 0; i < Math.min(run.concurrency, groups.length); i++) starters.push(worker());
    await Promise.all(starters);
  } finally {
    clearInterval(run.ticker); // stop the heartbeat
    try { await db.putSession(current.record); } catch (err) { handleStorageError(err); }
    run = null;
    setRunning(false); // hides the progress bar
    renderRunUI();      // final repaint: table statuses + counters
  }
}

async function maybeSave() {
  const now = Date.now();
  if (now - run.lastSave < SAVE_THROTTLE_MS) return;
  run.lastSave = now;
  try {
    await db.putSession(current.record);
  } catch (err) {
    handleStorageError(err);
  }
}

// Coalesce repaints: many workers finish near-simultaneously; render once/frame.
let uiScheduled = false;
function updateRunUI() {
  if (uiScheduled) return;
  uiScheduled = true;
  requestAnimationFrame(() => {
    uiScheduled = false;
    renderRunUI();
  });
}

function renderRunUI() {
  updateCounters();
  renderTableBody();

  const bar = document.getElementById('bar');
  if (run) {
    const pct = run.total ? (run.done / run.total) * 100 : 0;
    if (bar) bar.style.width = pct.toFixed(1) + '%';
    const rate = rollingRate();
    const etaEl = document.getElementById('eta');
    const rateEl = document.getElementById('rate');
    if (rate > 0) {
      const remaining = (run.total - run.done) / rate;
      if (etaEl) etaEl.textContent = run.done >= run.total ? 'done' : fmtDuration(remaining);
      if (rateEl) rateEl.textContent = `${rate.toFixed(1)} rows/s`;
    } else {
      // No chunk has finished yet — slow first response (e.g. pro can take ~30s per
      // batch). Show a live elapsed counter so the run doesn't look frozen.
      const elapsed = Math.round((Date.now() - run.startTime) / 1000);
      if (etaEl) etaEl.textContent = '…';
      if (rateEl) rateEl.textContent = `working… ${elapsed}s`;
    }
    if (rateEl && run.concurrency < CONCURRENCY) rateEl.textContent += ` · ${run.concurrency}× (throttled)`;
  }
  // When idle the progress bar is hidden (see setRunning), so nothing to update.
}

function updateCounters() {
  const results = current.record.results;
  let ok = 0, failed = 0;
  for (const k in results) {
    if (results[k].status === 'ok') ok++;
    else failed++;
  }
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('c-ok', ok);
  set('c-failed', failed);
  set('c-total', current.parsed.dataRows.length);

  const retryBtn = document.getElementById('retry');
  if (retryBtn && !run) {
    retryBtn.disabled = failed === 0;
    retryBtn.textContent = failed ? `Retry failed (${failed})` : 'Retry failed';
  }
}

function setRunning(running) {
  ['run', 'continue', 'retry'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = running;
  });
  const stop = document.getElementById('stop');
  if (stop) stop.classList.toggle('hidden', !running);
  // Progress bar + ETA only make sense during a run — hide when idle/finished.
  const pw = document.getElementById('progress-wrap');
  if (pw) pw.classList.toggle('hidden', !running);
}

function handleStorageError(err) {
  if (err && (err.name === 'QuotaExceededError' || /quota/i.test(err.message || ''))) {
    alert('Browser storage is full — the session could not be saved.\n\n' +
      'Download your results now, then delete finished sessions to free space.');
  } else {
    console.error('save failed:', err);
  }
}

async function onDownload() {
  const { record, parsed } = current;
  if (!Object.keys(record.results).length && !confirm('No results yet — download the original file unchanged?')) return;
  const blob = io.buildDownload(
    record.xlsxBytes, record.sheetName, parsed.outCols, record.results, record.hasHeader !== false,
  );
  download(blob, outName(record.fileName));
}

// Clear all results/statuses/counters but keep the file, prompt, model and batch.
async function onResetSession() {
  if (run) { alert('Stop the current run first.'); return; }
  if (!confirm('Reset this session? All statuses and results will be cleared. The file, prompt, model and batch size are kept.')) return;
  current.record.results = {};
  current.record.progress = { done: 0, total: current.parsed.dataRows.length };
  await db.putSession(current.record);
  renderEditor();
}

async function onDeleteSession() {
  if (run) { alert('Stop the current run first.'); return; }
  if (!confirm('Delete this session permanently? This cannot be undone.')) return;
  await db.deleteSession(current.record.id);
  go('#/');
}

// ---------- boot ----------

const badge = document.getElementById('mode-badge');
if (badge) {
  badge.textContent = USE_MOCK ? 'mock generator (?mock)' : 'Vertex AI · Gemini';
}

route();
