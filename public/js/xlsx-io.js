// Spreadsheet I/O built on SheetJS (global `XLSX`, loaded from CDN in index.html).
// Responsibilities: parse an .xlsx, read a sheet into columns + data rows,
// decide which columns to feed the model, decide where output goes, and
// rebuild the original workbook with the two result columns written in.

/** Parse raw bytes (ArrayBuffer / Uint8Array) into a SheetJS workbook. */
export function parseWorkbook(bytes) {
  const data = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  return XLSX.read(data, { type: 'array' });
}

export function sheetNames(wb) {
  return wb.SheetNames.slice();
}

/**
 * Read a sheet into a normalized shape:
 *   columns: [{ index, letter, name }]  (name = header cell in row 1, trimmed)
 *   dataRows: string[][]                (0-based data rows, row 0 = first under header)
 */
export function readSheet(wb, sheetName, hasHeader = true) {
  const ws = wb.Sheets[sheetName];
  const ref = ws && ws['!ref'] ? ws['!ref'] : 'A1';
  const range = XLSX.utils.decode_range(ref);
  const ncols = range.e.c + 1;

  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  // With a header, row 1 names the columns and data starts at row 2. Without one,
  // columns have no names and every row (incl. the first) is data.
  const headerRow = hasHeader ? (aoa[0] || []) : [];

  const columns = [];
  for (let c = 0; c < ncols; c++) {
    columns.push({
      index: c,
      letter: XLSX.utils.encode_col(c),
      name: hasHeader ? String(headerRow[c] == null ? '' : headerRow[c]).trim() : '',
    });
  }

  const body = hasHeader ? aoa.slice(1) : aoa;
  const dataRows = body.map((r) => {
    const out = new Array(ncols);
    for (let c = 0; c < ncols; c++) out[c] = r[c] == null ? '' : String(r[c]);
    return out;
  });

  return { columns, dataRows };
}

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Decide output columns. If the sheet already has FULL NAME / SHORT NAME headers,
 * write into them; otherwise append two new columns after the last one.
 */
export function resolveOutputColumns(columns) {
  const last = columns.length - 1;
  let outFull = columns.find((c) => norm(c.name) === 'full name');
  let outShort = columns.find((c) => norm(c.name) === 'short name');

  let nextIndex = last;
  if (!outFull) {
    nextIndex += 1;
    outFull = { index: nextIndex, letter: XLSX.utils.encode_col(nextIndex), name: 'FULL NAME' };
  }
  if (!outShort) {
    nextIndex = Math.max(nextIndex, outFull.index) + 1;
    outShort = { index: nextIndex, letter: XLSX.utils.encode_col(nextIndex), name: 'SHORT NAME' };
  }
  return { outFull, outShort };
}

/**
 * Columns sent to the model: everything except the two output targets. With a
 * header, columns lacking a header name are skipped (phantom columns); without a
 * header, all columns are real data and are kept (labeled by letter only).
 */
export function resolveInputColumns(columns, outCols, hasHeader = true) {
  const skip = new Set([outCols.outFull.index, outCols.outShort.index]);
  return columns.filter((c) => !skip.has(c.index) && (!hasHeader || c.name !== ''));
}

/** Build the per-row cell payload, labeling each cell by BOTH letter and header name. */
export function rowCells(dataRow, inputColumns) {
  const cells = {};
  for (const col of inputColumns) {
    const key = col.name ? `${col.letter} | ${col.name}` : col.letter;
    cells[key] = dataRow[col.index] == null ? '' : dataRow[col.index];
  }
  return cells;
}

function setCell(ws, r, c, value) {
  const addr = XLSX.utils.encode_cell({ r, c });
  ws[addr] = { t: 's', v: String(value == null ? '' : value) };
}

/**
 * Rebuild the original workbook with results written into the output columns and
 * return a Blob ready for download. Preserves all other columns/sheets/formatting.
 *
 * `hasHeader` must match how the sheet was read: with a header, data row 0 lives
 * at spreadsheet row 1 (row 0 holds the header names); without one, data row 0 IS
 * spreadsheet row 0 and there is no header row to write.
 */
export function buildDownload(bytes, sheetName, outCols, results, hasHeader = true) {
  const wb = parseWorkbook(bytes);
  const ws = wb.Sheets[sheetName];
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');

  const rowOffset = hasHeader ? 1 : 0; // data row -> spreadsheet row
  if (hasHeader) {
    setCell(ws, 0, outCols.outFull.index, outCols.outFull.name);
    setCell(ws, 0, outCols.outShort.index, outCols.outShort.name);
  }

  for (const [rowIndexStr, res] of Object.entries(results || {})) {
    const dataRow = Number(rowIndexStr);
    const r = dataRow + rowOffset;
    setCell(ws, r, outCols.outFull.index, res.full || '');
    setCell(ws, r, outCols.outShort.index, res.short || '');
  }

  // Extend the range to whichever output column reaches furthest right — the FULL
  // column can be appended past SHORT when the sheet already had a SHORT header.
  range.e.c = Math.max(range.e.c, outCols.outFull.index, outCols.outShort.index);
  ws['!ref'] = XLSX.utils.encode_range(range);

  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return new Blob([out], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/** SHA-256 of the file bytes, hex — used to dedupe re-uploads of the same file. */
export async function hashBytes(bytes) {
  // For a typed-array view, hash only its slice — not the whole backing buffer.
  const buf = bytes instanceof ArrayBuffer
    ? bytes
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
