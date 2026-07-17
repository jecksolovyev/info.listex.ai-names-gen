# Chunked multi-row requests, not one call per row

Rows are sent in **configurable chunks (default ~20)** per model call, each item
carrying a **row-id**; the tool validates that every id round-trips and re-runs
only the chunks that don't ("validate-and-retry").

## Considered options
- **One call per row** — rejected: at up to 60k rows it means ~60k calls (hours of
  wall-clock, high token cost from re-sending the Rules every time).
- **Chunked multi-row (chosen)** — ~3k calls for 60k rows; Rules amortized over the
  chunk.

## Why (the hallucination question)
Per-row does **not** reduce per-name hallucination — it only avoids cross-row
contamination and output misalignment, both handled here by row-ids +
validate-and-retry. The real quality controls are **temperature ~0.1** and a
**strict JSON output schema**, independent of chunk size.
