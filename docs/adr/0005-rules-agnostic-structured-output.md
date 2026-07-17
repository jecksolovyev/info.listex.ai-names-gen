# Rules-agnostic tool with structured {full, short} output

The tool encodes **no** naming rules. The content manager supplies the Rules
(prompt), and the tool asks the model for **structured JSON output** — the fields
`full` and `short` (plus a row-id in chunked mode) — which map directly to the two
new columns. What "full" and "short" mean is defined entirely by the Rules.

## Why
Keeps the tool generic and reusable across rule sets, and makes model output
reliably parseable into columns instead of guessing how to split freeform text.
