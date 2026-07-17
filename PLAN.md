# Implementation Plan

Three phases. See [DESIGN.md](./DESIGN.md) and [docs/adr/](./docs/adr/) for the
decisions behind each item.

- **Phase 1 — UI only.** The whole client works end-to-end with a **mocked**
  generator (no server, no Gemini). Fully clickable and demoable.
- **Phase 2 — Backend + MVP.** Add the tiny proxy + real Vertex, deploy to Render,
  correct-but-simple processing. Real names on real files.
- **Phase 3 — All the rest.** Speed + robustness + polish.

---

## Phase 1 — UI only (client, mocked generation) — ✅ built

**Goal:** every screen and the full flow work in the browser with fake results.

Lives under `public/` (the dir the Phase 2 Node proxy will serve static). Run it
with `npm run serve` and open the printed **http://localhost** URL — a real origin is
required (ES modules + `crypto.subtle` won't work over `file://`).

- [x] Scaffold: `public/index.html` + `js/app.js` + `styles.css`, **SheetJS from CDN**,
  no build step. Run via `npm run serve` (static server).
- [x] Screen routing: **Sessions list** ⇄ **Editor** (hash-routed).
- [x] **IndexedDB layer** (`js/db.js`) — session CRUD (put/get/list/delete/findByHash),
  record shape per the design.
- [x] **New session**: `.xlsx` upload (drop or pick) → SheetJS parse → SHA-256 content
  hash (dedupe → opens existing) → sheet picker for multi-sheet workbooks.
- [x] **Preview table** (`js/xlsx-io.js` + `app.js`): first ~10 rows, 0-based row-number
  column, double header (letters over names), sticky header, scroll, ellipsis + tooltip.
- [x] **Prompt** textarea (persisted on change).
- [x] **Run controls**: `start` / `count` inputs, **TEST (first 5)** + **Run** + **Stop**,
  progress bar, ETA, `ok`/`failed`/`too-long` counters.
- [x] **Rolling results table** (last ~100 rows).
- [x] **Mock generator** (`js/generate.js`) behind the *exact* `/api/generate` interface
  Phase 2 will use — deterministic fake `{F, G}` keyed by `row_id`, with latency.
- [x] **Download**: rebuild the original workbook (SheetJS), write `FULL NAME`/`SHORT
  NAME` into `F`/`G` (or append), trigger `.xlsx`. **Download-anytime** button + final.
- [x] **Sessions list**: name, created date, progress; resume, delete.

**Done when:** create a session from an `.xlsx`, preview it, paste a prompt, TEST 5,
run a window with progress, see results, download original + 2 columns, **resume after
a refresh**, and delete a session — all client-side, no server.

_Verified headless against `example.xlsx` (parse → columns → cell payload → mock →
download rebuild, Cyrillic intact) and static-server boot. Browser click-through of
IndexedDB/routing is the remaining manual check._

---

## Phase 2 — Backend + MVP (real Vertex, deployed) — ✅ built (deploy pending)

**Goal:** the mocked generator is replaced by real Gemini; deployed behind auth.

- [x] Proxy scaffold in **Node/Express** (`server/index.js`) — **serves the static
  front-end + `/api/generate`** (one service). Public `/healthz`.
- [x] **HTTP Basic Auth** middleware on every route except `/healthz`
  (`BASIC_AUTH_USER` / `BASIC_AUTH_PASS`; blank = open, for local dev). Timing-safe.
- [x] **Vertex client** (`server/vertex.js`): load SA from `GCP_SA_BASE64`, init
  `@google/genai` in Vertex mode with `GCP_PROJECT_ID`, `GCP_LOCATION`, `GEMINI_MODEL`.
- [x] **`/api/generate`**: accept `{ prompt, rows:[{row_id, cells-by-letter+name}] }`,
  call Gemini with a **structured-output schema** `[{row_id, F, G}]`, temperature 0.1;
  return `{ items }`.
- [x] Front-end: `generate.js` now calls **`fetch('/api/generate')`** (same interface);
  browser reuses the cached Basic Auth creds. `?mock` still runs offline.
- [x] **Correct-but-simple processing**: chunk ~20, **row-id round-trip validation**,
  sequential, 2 naive retries per chunk (best-partial kept). *(No length check —
  the prompt owns Short's length.)*
- [x] Config: `.env.example`, `render.yaml`, `README` (local run + Render deploy).
- [ ] **Deploy to Render (free)**, set env vars, **smoke-test on real data**. ← user step.

**Done when:** a deployed URL behind Basic Auth lets the CM run TEST + a real window
against Vertex, see real Full/Short, and download. Failures are surfaced (not silent).

_Verified locally: all auth/validation gates, and a **live Vertex call** with the real
SA (`gemini-2.5-flash`) returning a correct Ukrainian Full/Short for an `example.xlsx`
row. Remaining: push to GitHub + Render blueprint deploy (needs the user's accounts)._

---

## Phase 3 — All the rest (speed, robustness, polish) — ✅ built

**Goal:** a 60k run is fast, survives failures + crashes, and is pleasant.

- [x] **Concurrency pool (default 6)** over a shared chunk queue + exponential backoff
  w/ jitter on 429/5xx (client **and** server) + **adaptive concurrency**: a global
  cooldown + pool shrink (floor 1) on sustained 429 (`noteRateLimit`).
- [x] **ETA** — rolling rows/sec over the last ~30s (`rollingRate`), extrapolated;
  live `rows/s` readout + "throttled" indicator when concurrency drops.
- [x] **"Retry failed rows"** button (re-runs only `failed` indices); per-row
  `ok`/`failed` status + styling; **targeted partial retry** (re-request only the
  still-missing row-ids within a chunk).
- [x] **Storage hygiene**: `navigator.storage.estimate()` usage line + near-quota
  warning; `QuotaExceededError` handling on save (prompt to download + delete).
- [x] **Re-upload dedupe**: matching content hash opens the existing session.
- [x] **Large-file performance**: throttled IndexedDB writes (~1.5s) during a run;
  results table renders from a capped rolling buffer, not a full scan. Multi-sheet
  picker in place.
- [ ] **Ops** (user/infra): verify/raise Vertex quota (RPM/TPM); confirm SA IAM
  (**Vertex AI User**) + API enabled; optional **context caching** of the Rules prompt.
- [ ] QA pass across the example-file categories.

**Done when:** a 60k run tolerates transient errors and a tab crash (resume), leaves
failures re-runnable, and stays within quota.

_Throughput note: with the ~24 KB Rules prompt sent every call, one 20-row chunk takes
~9 s; at concurrency 6 that's ~13 rows/s (~60k in ~75 min). The `10–15 min` original
target needs either higher concurrency/quota, larger chunks, or **context caching** of
the Rules prompt (deferred) — `CONCURRENCY`/`CHUNK_SIZE` are single constants to tune._
