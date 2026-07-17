# Front-end: vanilla JS + SheetJS, no build, .xlsx only

The browser UI is plain **vanilla JS** with **SheetJS** for spreadsheet I/O, served
static from the Render proxy — no framework, no build step. Input/output is
**`.xlsx` only**; CSV support was dropped.

## Why
- The app is a few screens (open/preview, prompt box, TEST, run + progress, results).
  Plain DOM + a `<table>` is enough; a framework/build toolchain cuts against "tiny."
- `.xlsx` is internally UTF-8 and delimiter-free, so it sidesteps the Cyrillic
  encoding and separator ambiguity that made CSV risky — removing CSV removes a whole
  class of parse bugs and the encoding/delimiter UI they would have required.

## Considered options
- **Alpine.js** for reactive ergonomics (still no build) — kept in reserve if manual
  DOM wiring gets painful.
- **React/Vue** — rejected: adds a build step for little gain at this size.
