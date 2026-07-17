# Product Name Generator — Context

A single content manager's tool that bulk-rewrites existing product names into
rules-conformant **Full** and **Short** variants using Gemini, appending the
results as new columns to their spreadsheet.

## Language

**Content Manager**:
The sole user of the tool — the person responsible for producing rules-conformant
product names. There is exactly one active user (1–2 machines).
_Avoid_: user, operator, admin

**Source Name**:
An existing product name, read from the source file, that is to be rewritten.
_Avoid_: title, label, original

**Rules**:
The content-manager-authored natural-language instructions that define how names
are rewritten — including what "full" and "short" mean. The tool is agnostic to
their content; they are delivered to the model as the prompt.
_Avoid_: instructions, spec

**Full Name**:
The complete rewritten product name produced for a row, per the Rules. Written to
a new column. Its exact meaning is defined by the Rules, not by the tool.
_Avoid_: long name

**Short Name**:
The abbreviated rewritten product name produced for a row, per the Rules. Written
to a new column. Its exact meaning is defined by the Rules, not by the tool.
_Avoid_: abbreviation

**TM**:
The product's trademark/brand, held in a dedicated source column (header `TM`). The
value is a brand identifier — a code (e.g. `103`), a brand name (e.g. `EcoMil`), or
the literal `No Brand` when there is none. The Rules use it to *locate* the
trademark inside the Source Name; the exact wording/format is taken from the Source
Name, not from this column.
_Avoid_: trademark, brand (as standalone terms)

**Source File**:
The spreadsheet the content manager loads, containing source names and TM. The
tool appends Full/Short columns to a copy the content manager downloads.
_Avoid_: input, sheet
