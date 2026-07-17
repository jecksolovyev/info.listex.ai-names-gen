# Client-side multi-session persistence in IndexedDB

The app keeps **multiple self-contained sessions** in IndexedDB. Each session stores
the original `.xlsx` bytes, the chosen sheet, the prompt, column config, results
(row-index → `{ full, short }`), and progress — updated as work proceeds. The
**landing screen lists sessions** (file name, created date, progress); the CM clicks
one to **resume** (no re-upload) or starts a new one by uploading a file.

## Why
- Runs are long (up to ~60k rows) and browser-driven, so work must survive a tab
  crash/refresh. Self-contained sessions let the CM resume by clicking, without
  re-locating the source file.
- Storing the original bytes lets the "original + 2 columns" download reproduce the
  full file (all columns/sheets/formatting), not just the parsed values.

## Consequences
- Several 60k-row workbooks in IndexedDB can total tens of MB; provide a session
  **delete** action and stay resilient to browser storage eviction.
