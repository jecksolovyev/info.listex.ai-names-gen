# Design — AI Product Name Generator

A tool for a single content manager to bulk-rewrite existing product names into
rules-conformant **Full** and **Short** variants using Gemini, appending the
results as new columns to their spreadsheet.

See [CONTEXT.md](./CONTEXT.md) for vocabulary and [docs/adr/](./docs/adr/) for the
decisions behind the points below.

## Architecture (ADR-0001, ADR-0002)
- **Browser front-end (vanilla JS + SheetJS, no build step)** — parses the `.xlsx`,
  collects the Rules, orchestrates generation, appends columns, triggers download.
  All heavy lifting is client-side.
- **Tiny stateless proxy on Render (free), Node (Express/Fastify)** — serves the GUI +
  a single generate endpoint, holds the service-account credential, forwards to Vertex
  AI. HTTP Basic Auth on every route.

## Generation (ADR-0003, ADR-0004, ADR-0005)
- Online Vertex AI calls (not the Batch API).
- Chunked multi-row (~20/chunk, configurable), each item tagged with a row-id.
- Structured JSON output `{ row_id, full, short }` per item; validate all ids
  round-trip, retry failed/misaligned chunks.
- Temperature ~0.1 + strict schema as the anti-hallucination controls.

## Configuration (env vars on Render)
- `GCP_PROJECT_ID = listex-ua-production`
- `GCP_LOCATION     = us-central1` (single-region; serves the Gemini 2.5 models)
- `GCP_LOCATION_V3  = us` (multi-region; serves the Gemini 3.x models)
- `GEMINI_MODEL     = gemini-2.5-flash-lite` (cheapest default; region routed per model)
- Service-account JSON (base64)
- Basic Auth username / password
- Chunk size (default ~20)

## File formats
- v1: **`.xlsx` only** (local files). CSV dropped — removes encoding/delimiter
  ambiguity. Google Sheets deferred (online, separate OAuth, conflicts with download).

## Front-end (ADR-0006)
- **Vanilla JS + SheetJS, no build step**, served static from the Render proxy.
- **Preview table** — render the first ~10 rows in a plain `<table>`: leading 0-based
  row-number column, double header (column letters over header names), sticky header,
  horizontal scroll, ellipsis + `title` tooltip. Sheet picker if the workbook has >1
  sheet.
- **Results table** — do *not* render up to 60k rows; show a rolling window of the
  last ~100 results + counters + progress/ETA. Full data goes to the download.

## Source file structure
- Sheet with header in row 1. Columns: `A GoodId`, `B Art`, `C barcode`, **`D`
  Source Name** (`2479 Назва (укр.)`), **`E` TM** (brand code / name / `No Brand`),
  **`F` FULL NAME** (output), **`G` SHORT NAME** (output).
- Production files: up to ~60k rows. `example.xlsx` is now a **curated ~49-row
  reference set** — hand-made `D→F/G` examples across many categories (medical,
  coffee, toys, wine, dish soap, snacks…) illustrating the target output.
- The **Rules reference columns by letter** (`D`, `E` → build `F`; shorten `F` → `G`).
- "Short" means whatever the Rules say — including any length limit. The tool holds
  **no length rule of its own**: the prompt owns it (the CM can edit the number), and
  Short is whatever the model returns. There is no deterministic char check or
  too-long flag.

## Resolved since first draft
- **TM** — dedicated `E` column (see CONTEXT.md).
- **Volume** — up to ~60k rows per run.
- **Prompt input** — the CM **pastes the prompt** into a text box; few-shot examples
  (if any) go *inside* that pasted text. No separate examples feature.
- **Row binding / addressing** — send each row's cells labeled by **both** column
  letter and header name, so prompts may address columns either way.
- **Output** — download a **copy of the original** file with **two columns appended**;
  headers default `FULL NAME` / `SHORT NAME`.
- **Run range** — no auto-resume. The CM picks a **start row** and **row count**
  (preview shows row numbers), so any window `[start, start+count)` can be run. Row
  indexing is **0-based data rows** (row 0 = first row under the header).
- **Sessions & persistence (ADR-0007)** — **multiple self-contained sessions** live in
  IndexedDB. Each stores the original `.xlsx` bytes, chosen sheet, prompt, column
  config, results (row-index → `{full, short}`), and progress, written as work
  proceeds. The landing screen lists sessions (name, date, progress); clicking one
  **resumes** it with no re-upload. A **"download results so far"** button is available
  anytime, plus the final download.
- **Error handling** — hard failures (no usable result after retries) leave
  `full`/`short` **blank**, get recorded in a **failures list** (reason + counter) and
  can be **retried**. Per-row status: `ok` / `failed`, surfaced as counters + in the
  results table. (No length rule → no `too-long` status; see Source file structure.)
- **Model** — the CM picks from a fixed set (`GEMINI_MODELS` in `app.js`):
  `gemini-2.5-flash-lite` (default, cheapest), `gemini-2.5-flash`,
  `gemini-3.1-flash-lite`, `gemini-3.5-flash`. Region is routed per model
  (2.5 → single-region, 3.x → multi-region). **2.5-pro is not offered** — it
  rejects `thinkingBudget: 0` with a 400.
- **Concurrency & rate limits** — configurable, default **6 chunks in flight**;
  exponential backoff w/ jitter on 429/5xx (client + server); adaptively lower
  concurrency (global cooldown + pool shrink) if 429s persist. Verify/raise the
  project's Vertex quota before big runs. Measured: ~9s per 20-row chunk with the
  full Rules prompt → ~13 rows/s at concurrency 6 (~75 min for 60k). Faster needs
  higher concurrency/quota, bigger chunks, or **context caching** of the Rules prompt.
- **ETA** — rolling average of completed rows/sec over the last ~30s, extrapolated.
- **Re-upload dedupe** — a file whose content hash matches an existing session
  **opens that session** (no duplicate).
- **Storage hygiene** — sessions kept until manually deleted; warn near IndexedDB
  quota / on eviction.

## UX flow (v1)
0. **Sessions screen (landing)** — list saved sessions (file name, created date,
   progress); click one to **resume**, or **New session** → upload an `.xlsx`. Delete
   removes a session.
1. **Open `.xlsx`** (new session) → render a **preview of the first 5–10 rows** (row
   numbers + column letters + header names) so the CM confirms the right
   sheet/columns. Multi-sheet workbooks: the CM picks the sheet.
2. **Paste the prompt** into a text box. Few-shot examples (if any) go inside it.
3. **TEST** → run the prompt on the **first 5 rows**, render results. Edit prompt →
   re-TEST, iterate freely until satisfied.
4. **Run** → the full file, or the **first N rows** (CM sets N).
5. **Results table** on screen + **progress bar with ETA** during the run.
6. **Download** a copy of the file with the two columns appended.

## Open questions
_None outstanding — design at shared understanding._

## Deferred (post-v1)
- **CSV / Google Sheets** input (xlsx-only for v1; see ADR-0006).
- **Vertex Batch Prediction** if online throughput/cost ever becomes a problem at
  scale (see ADR-0003).
- **Context caching** of the (large) Rules prompt to cut token cost.
- **Automated eval harness** scoring model output vs a held-out reference set.
