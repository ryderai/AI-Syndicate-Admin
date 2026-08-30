/* Reading a spreadsheet in the browser, with no library.
 *
 * WHY NOT JUST USE A LIBRARY
 * CJ's lead lists live in Excel. Telling him to "save as CSV" first works
 * until the day he forgets, and then the import silently reads one column of
 * gibberish. Adding a spreadsheet library would have been the easy fix and it
 * is roughly 800 KB on a page that currently ships under 400 KB — for one
 * button. So this reads .xlsx directly.
 *
 * HOW IT WORKS
 * An .xlsx file is a zip of XML files. Chrome and Safari can already unzip:
 * DecompressionStream("deflate-raw") is built into the browser. So the job is
 * to walk the zip's index, pull out two files, and read their XML.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * Formulas are read as their last saved VALUE, which is what the person saw on
 * screen. Dates come back as Excel's number unless the cell was already
 * formatted as text — and a lead list has no dates in it, so that is a
 * knowingly accepted gap rather than a missed one. Only the first sheet is
 * read; a multi-tab workbook says so and asks which tab to save out.
 *
 * If the browser has no DecompressionStream, this throws a message that tells
 * the person exactly what to do instead. It never half-reads a file.
 */

/* ------------------------------------------------------------------ */
/* Delimited text — CSV and what Excel puts on the clipboard           */
/* ------------------------------------------------------------------ */

/** Quote-aware split into rows and cells. Handles "" inside quotes, commas
 * inside quotes, and newlines inside quotes — all three appear in real
 * exported lists, usually in the notes column. */
export function parseDelimited(text, delimiter = ",") {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const s = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i += 1; }
        else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delimiter) { row.push(cell); cell = ""; continue; }
    if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; continue; }
    cell += ch;
  }
  row.push(cell);
  rows.push(row);

  // Drop trailing blank lines — every spreadsheet export has at least one.
  while (rows.length && rows[rows.length - 1].every((c) => !String(c).trim())) rows.pop();
  return rows;
}

/** Which separator a pasted block uses. Excel and Google Sheets both put tabs
 * on the clipboard; a saved file is usually commas; European exports use
 * semicolons. Decided by counting on the first line rather than by asking. */
export function sniffDelimiter(text) {
  const first = String(text || "").split(/\r?\n/)[0] || "";
  const counts = { "\t": 0, ",": 0, ";": 0 };
  let quoted = false;
  for (const ch of first) {
    if (ch === '"') { quoted = !quoted; continue; }
    if (!quoted && ch in counts) counts[ch] += 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ",";
}

/* ------------------------------------------------------------------ */
/* Zip                                                                 */
/* ------------------------------------------------------------------ */

export function hasUnzipSupport() {
  return typeof DecompressionStream === "function";
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Walk the zip's central directory and return { name -> bytes } for the
 * entries `wanted` says yes to. Reading only the entries we need matters: a
 * workbook with images in it is mostly images. */
async function readZip(buffer, wanted) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // The end-of-central-directory record is at the end, but a zip comment can
  // follow it, so it is searched for backwards. 22 is its minimum length.
  let eocd = -1;
  const from = Math.max(0, bytes.length - 22 - 65535);
  for (let i = bytes.length - 22; i >= from; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("That file is not a spreadsheet the browser can open.");

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = {};

  for (let n = 0; n < count; n += 1) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (!wanted(name)) continue;

    // The central directory's name and extra lengths are not the local
    // header's — reading the local header's own is the only correct way to
    // find where the data starts.
    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(start, start + compressedSize);

    if (method === 0) out[name] = raw;                    // stored, not compressed
    else if (method === 8) out[name] = await inflateRaw(raw);
    else throw new Error(`That spreadsheet uses a compression this reader does not handle (method ${method}). Save it as CSV instead.`);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The sheet XML                                                       */
/* ------------------------------------------------------------------ */

function codePoint(n, original) {
  if (!Number.isInteger(n) || n < 0 || n > 0x10ffff) return original;
  try { return String.fromCodePoint(n); } catch { return original; }
}

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    // A malformed or out-of-range entity throws RangeError out of
    // fromCodePoint, and one bad character in one cell would take down the
    // whole import with an unreadable error. Leave it as written instead.
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => codePoint(parseInt(h, 16), m))
    .replace(/&#(\d+);/g, (m, d) => codePoint(parseInt(d, 10), m))
    .replace(/&amp;/g, "&"); // last, or &amp;lt; would become <
}

/** The shared string table. Excel stores every repeated text value once and
 * refers to it by number, so without this every text cell reads as a number. */
function parseSharedStrings(xml) {
  const out = [];
  const items = xml.match(/<si\b[\s\S]*?<\/si>/g) || [];
  for (const si of items) {
    // A cell with mixed formatting is split into several <t> runs; joining
    // them is what stops "Chen Dental" arriving as "Chen".
    const parts = si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
    out.push(parts.map((t) => decodeXmlEntities(t.replace(/<[^>]+>/g, ""))).join(""));
  }
  return out;
}

/** "BC7" → column 54. Base-26 with letters, no zero. */
export function colToIndex(ref) {
  const letters = String(ref).replace(/\d+$/, "");
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.toUpperCase().charCodeAt(0) - 64);
  return n - 1;
}

/* MATCHING A TAG THAT CAN CONTAIN OTHER TAGS.
 *
 * These two are written the long way — "either a self-closing tag, or an
 * opening tag through to its closing tag" — and they have to be.
 *
 * The obvious version, `<row\b[\s\S]*?(?:\/>|<\/row>)`, reads as "a row up to
 * the first `/>` or `</row>`". But an EMPTY CELL is written `<c r="A2" s="7"/>`,
 * and that `/>` is the first one inside the row. So the match ended there, and
 * every row was silently cut off at its first empty cell.
 *
 * It was silent because a short row is a valid row: the columns that survived
 * still lined up, the count on screen still looked plausible, and the rows that
 * happened to have no gaps came through perfectly. On CJ's real workbook it
 * read 36 of 3,673 people and reported no error at all — the Jewelry tab came
 * back as 3 rows instead of 71, because every row there starts with six empty
 * cells and so was cut to nothing before the first name.
 *
 * `[^>]*` stops at the tag's OWN closing angle bracket, so nothing inside it
 * can end the match early. Found 30 Aug 2026, by counting the rows that went
 * in against the rows in the file. Shipped 20 Aug 2026. */
/* `ATTRS` is "any number of attributes", where an attribute's VALUE is matched
 * as a quoted string and everything else is matched a character at a time.
 *
 * `[^>]*` was the first attempt and it is not enough: `>` is perfectly legal
 * unescaped inside an XML attribute value, and so is `/>`. A cell written
 * `<c r="A2" t="str" cm="a/>b"><v>Sabrina</v></c>` matched the self-closing
 * alternative, ended inside its own attribute, had no <v> left in it, and read
 * as empty — the same silent truncation, one level down. The same trick on a
 * <row> attribute swallowed the whole row.
 *
 * The optional `[\w.-]+:` is a namespace prefix. Several writers that are not
 * Excel emit `<x:row><x:c>`, and without it the sheet matched zero rows and
 * came back as an empty tab rather than an error. Both found 30 Aug 2026 by an
 * adversarial reviewer. */
const ATTRS = String.raw`(?:"[^"]*"|'[^']*'|[^>"'])*`;
const ROW_TAG = new RegExp(`<(?:[\\w.-]+:)?row\\b${ATTRS}/>|<(?:[\\w.-]+:)?row\\b${ATTRS}>[\\s\\S]*?</(?:[\\w.-]+:)?row>`, "g");
const CELL_TAG = new RegExp(`<(?:[\\w.-]+:)?c\\b${ATTRS}/>|<(?:[\\w.-]+:)?c\\b${ATTRS}>[\\s\\S]*?</(?:[\\w.-]+:)?c>`, "g");

function parseSheet(xml, shared) {
  const rows = [];
  const rowXml = xml.match(ROW_TAG) || [];
  for (const r of rowXml) {
    const cells = [];
    const cellXml = r.match(CELL_TAG) || [];
    for (const c of cellXml) {
      const ref = /\br="([A-Z]+\d+)"/.exec(c);
      const type = /\bt="([^"]+)"/.exec(c);
      const at = ref ? colToIndex(ref[1]) : cells.length;

      let value = "";
      if (type?.[1] === "inlineStr") {
        const parts = c.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
        value = parts.map((t) => decodeXmlEntities(t.replace(/<[^>]+>/g, ""))).join("");
      } else {
        const v = /<v[^>]*>([\s\S]*?)<\/v>/.exec(c);
        const raw = v ? decodeXmlEntities(v[1]) : "";
        if (type?.[1] === "s") value = shared[parseInt(raw, 10)] ?? "";
        else value = raw;
      }
      // Fill the gaps: Excel leaves empty cells out of the file entirely, so
      // without this a blank middle column silently shifts every column after
      // it one place left, and the whole mapping is wrong.
      while (cells.length < at) cells.push("");
      cells[at] = value;
    }
    rows.push(cells);
  }
  while (rows.length && rows[rows.length - 1].every((c) => !String(c).trim())) rows.pop();
  return rows;
}

/**
 * Read an .xlsx file.
 * @returns { rows, sheetCount, sheetName }
 */
export async function parseXlsx(arrayBuffer) {
  if (!hasUnzipSupport()) {
    throw new Error("This browser cannot open Excel files. In Excel choose File → Save As → CSV, then import that.");
  }
  const files = await readZip(arrayBuffer, (name) =>
    name === "xl/sharedStrings.xml" || name === "xl/workbook.xml"
    || name === "xl/_rels/workbook.xml.rels" || /^xl\/worksheets\/sheet\d+\.xml$/.test(name));

  const dec = new TextDecoder();
  const sheetNames = Object.keys(files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
  if (!sheetNames.length) throw new Error("That file has no sheets in it.");

  const shared = files["xl/sharedStrings.xml"]
    ? parseSharedStrings(dec.decode(files["xl/sharedStrings.xml"]))
    : [];

  /* WHICH tab is the first one, and what is it called?
   *
   * These are two different questions and the answers are stored in two
   * different places. workbook.xml lists the tabs in the order a person sees
   * them, each with a relationship id; xl/_rels/workbook.xml.rels maps that id
   * to the actual file. The file NAMES (sheet1.xml, sheet2.xml) are creation
   * order, not tab order.
   *
   * Taking the first <sheet name=...> from workbook.xml and pairing it with
   * sheet1.xml assumed the two orders match. Drag a tab to the front in Excel
   * and they do not — so the import would read one tab and tell the person, in
   * writing, that it had read a different one. Found by an adversarial review,
   * Aug 20 2026.
   *
   * Follow the relationship. If anything is missing, fall back to sheet1.xml
   * and say plainly that the tab could not be named, rather than naming the
   * wrong one. */
  const wbXml = files["xl/workbook.xml"] ? dec.decode(files["xl/workbook.xml"]) : "";
  const relsXml = files["xl/_rels/workbook.xml.rels"] ? dec.decode(files["xl/_rels/workbook.xml.rels"]) : "";

  const relTarget = {};
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    relTarget[m[1]] = m[2].replace(/^\/?xl\//, "").replace(/^\.\//, "");
  }
  // Attribute order is not guaranteed, so Id and Target are read separately.
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*Target="([^"]+)"[^>]*Id="([^"]+)"/g)) {
    relTarget[m[2]] = m[1].replace(/^\/?xl\//, "").replace(/^\.\//, "");
  }

  const tabs = [];
  for (const m of wbXml.matchAll(/<sheet\b[^>]*>/g)) {
    const tag = m[0];
    const name = /name="([^"]+)"/.exec(tag)?.[1];
    const rid = /r:id="([^"]+)"/.exec(tag)?.[1];
    if (name) tabs.push({ name: decodeXmlEntities(name), path: rid ? `xl/${relTarget[rid] || ""}` : null });
  }

  const first = tabs.find((t) => t.path && files[t.path]);
  const readPath = first ? first.path : sheetNames[0];
  const label = first ? first.name : null;

  const rows = parseSheet(dec.decode(files[readPath]), shared);
  return {
    rows,
    sheetCount: tabs.length || sheetNames.length,
    sheetName: label,
    /* Everything needed to read the OTHER tabs, so parseXlsxAllTabs below does
     * not have to unzip and re-parse the same file a second time. */
    _all: { files, tabs, sheetNames, shared, dec },
  };
}

/**
 * Every tab in the workbook, in the order a person sees them.
 *
 * WHY THIS EXISTS
 * parseXlsx reads the first tab and tells the person to "save the other tab
 * out on its own first". CJ's outreach sheet has eight lead tabs plus a rules
 * tab, so that instruction means eight exports, eight imports, and eight
 * chances to import the same tab twice. This reads them all in one pass and
 * lets the import screen tick the ones to bring in.
 *
 * Returns [{ name, rows, empty }]. A tab whose relationship cannot be
 * resolved is returned with its file-order name rather than dropped — a
 * missing tab is worse than an oddly named one, because nobody notices it.
 */
export async function parseXlsxAllTabs(arrayBuffer) {
  const head = await parseXlsx(arrayBuffer);
  const { files, tabs, sheetNames, shared, dec } = head._all;

  const out = [];
  const used = new Set();
  for (const t of tabs) {
    if (!t.path || !files[t.path]) continue;
    used.add(t.path);
    const rows = parseSheet(dec.decode(files[t.path]), shared);
    out.push({ name: t.name, rows, empty: rows.length === 0 });
  }
  // Anything the workbook.xml relationships did not cover, by file order.
  for (const n of sheetNames) {
    if (used.has(n)) continue;
    const rows = parseSheet(dec.decode(files[n]), shared);
    out.push({ name: n.replace(/^xl\/worksheets\//, "").replace(/\.xml$/, ""), rows, empty: rows.length === 0 });
  }
  return out;
}

/**
 * One door for every way a list arrives: a file the person chose, or a block
 * they pasted. Returns { rows, kind, note } — `note` is the one line the page
 * shows about what was actually read.
 */
export async function readSheetFile(file) {
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xlsm")) {
    const { rows, sheetCount, sheetName } = await parseXlsx(await file.arrayBuffer());
    const which = sheetName ? `"${sheetName}"` : "the first tab";
    return {
      rows,
      kind: "xlsx",
      note: sheetCount > 1
        ? `Read ${which} — the first of ${sheetCount} tabs. The Sales page imports every tab at once; this older importer reads one.`
        : `Read ${which}.`,
    };
  }
  if (name.endsWith(".xls")) {
    throw new Error("That is the old Excel format (.xls). Open it in Excel and choose File → Save As → Excel Workbook (.xlsx), then import that.");
  }
  const text = await file.text();
  const delim = name.endsWith(".tsv") ? "\t" : sniffDelimiter(text);
  return {
    rows: parseDelimited(text, delim),
    kind: "text",
    note: `Read as ${delim === "\t" ? "tab" : delim === ";" ? "semicolon" : "comma"}-separated text.`,
  };
}

export function readPasted(text) {
  const delim = sniffDelimiter(text);
  return {
    rows: parseDelimited(text, delim),
    kind: "paste",
    note: `Read ${delim === "\t" ? "as pasted from a spreadsheet" : `as ${delim === ";" ? "semicolon" : "comma"}-separated text`}.`,
  };
}
