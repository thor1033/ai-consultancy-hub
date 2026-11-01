// Text from a file, for an agent or the knowledge base to read. Shared by the
// Teams server (files read from a team's SharePoint) and the hub's Documents
// page (a file someone uploads), so both read Word, PowerPoint, Excel, PDF,
// transcripts and plain text the same way — and a fix to one is a fix to both.
//
// Plain ESM with no TypeScript, because the stdio servers run as `node
// server.mjs` with no build step. Types for the web app: fileText.d.mts.
import { unzipSync, strFromU8 } from "fflate";

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, e) => {
    if (e[0] !== "#") return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e.toLowerCase()];
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

// "00:01:02.345" or "0:01:02.345" → "00:01:02". Negative offsets (transcription
// started mid-conversation) keep their sign.
function clock(stamp) {
  const m = stamp.trim().match(/^(-?)(\d+):(\d{2}):(\d{2})/);
  return m ? `${m[1]}${m[2].padStart(2, "0")}:${m[3]}:${m[4]}` : stamp.trim();
}

/**
 * WebVTT → one line per turn: "[00:00:16] Name: what they said". Consecutive
 * cues from the same speaker are merged — Teams cuts a cue every few seconds,
 * and a model reading forty "Ditlev:" prefixes for one answer reads noise.
 */
export function vttToTurns(vtt) {
  const turns = [];
  for (const block of vtt.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue; // the WEBVTT header, NOTE blocks
    let body = lines.slice(at + 1).join(" ").trim();
    let speaker = null;
    const voiced = body.match(/^<v\s+([^>]+)>([\s\S]*?)(?:<\/v>)?$/);
    if (voiced) {
      speaker = voiced[1].trim();
      body = voiced[2];
    }
    body = decodeEntities(body.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    if (!body) continue;
    const last = turns.at(-1);
    if (last && last.speaker === speaker) last.text += ` ${body}`;
    else turns.push({ at: clock(lines[at].split("-->")[0]), speaker, text: body });
  }
  return turns;
}

export const turnsToText = (turns) =>
  turns.map((t) => `[${t.at}] ${t.speaker ? `${t.speaker}: ` : ""}${t.text}`).join("\n");

// What an Office file may inflate to. A 30 MB .xlsx is fine; a zip bomb is not.
const MAX_INFLATED = 120 * 1024 ** 2;
export const PLAIN = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "log", "xml", "yaml", "yml", "ini"]);

export const extOf = (name) => (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();

export function tidy(s) {
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const stripXml = (xml) => decodeEntities(xml.replace(/<[^>]+>/g, ""));

function unzip(bytes, wanted) {
  let inflated = 0;
  return unzipSync(bytes, {
    filter: (f) => {
      if (!wanted(f.name)) return false;
      inflated += f.originalSize;
      if (inflated > MAX_INFLATED) throw new Error("This file expands to more than 120 MB; too large to read.");
      return true;
    },
  });
}

function docxText(bytes) {
  const files = unzip(bytes, (n) => n === "word/document.xml");
  const doc = files["word/document.xml"];
  if (!doc) throw new Error("Not a Word document: word/document.xml is missing.");
  const xml = strFromU8(doc)
    // Field codes and tracked deletions are text nobody sees on the page.
    .replace(/<w:instrText[^>]*>[\s\S]*?<\/w:instrText>/g, "")
    .replace(/<w:delText[^>]*>[\s\S]*?<\/w:delText>/g, "")
    // Headings keep their level, so the agent sees the document's outline.
    .replace(/<w:p[\s>][\s\S]*?<\/w:p>/g, (p) => {
      const h = p.match(/<w:pStyle w:val="(?:Heading|Overskrift)(\d)"/i);
      return h ? `${"#".repeat(Number(h[1]))} ${p}` : p;
    })
    // A table cell's paragraphs stay on the row's line.
    .replace(/<w:tc[\s>][\s\S]*?<\/w:tc>/g, (cell) => `${cell.replace(/<\/w:p>/g, " ")} | `)
    .replace(/<\/w:tr>/g, "\n")
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n");
  return tidy(
    stripXml(xml)
      .split("\n")
      .map((l) => l.replace(/\s*\|\s*$/, "").replace(/\s+\|\s+/g, " | "))
      .join("\n"),
  );
}

function pptxText(bytes) {
  const files = unzip(
    bytes,
    (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n) || n === "ppt/presentation.xml" || n === "ppt/_rels/presentation.xml.rels",
  );
  // Slide file numbers are creation order, not the order of the deck; the
  // presentation's slide list (through its relationships) is the real order.
  const byNumber = Object.keys(files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
  let order = byNumber;
  const pres = files["ppt/presentation.xml"] && strFromU8(files["ppt/presentation.xml"]);
  const rels = files["ppt/_rels/presentation.xml.rels"] && strFromU8(files["ppt/_rels/presentation.xml.rels"]);
  if (pres && rels) {
    const target = new Map(
      [...rels.matchAll(/<Relationship\b[^>]*>/g)].map(([tag]) => [
        tag.match(/\bId="([^"]+)"/)?.[1],
        `ppt/${(tag.match(/\bTarget="([^"]+)"/)?.[1] ?? "").replace(/^\/?(ppt\/)?/, "")}`,
      ]),
    );
    const listed = [...pres.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)].map((m) => target.get(m[1])).filter((n) => files[n]);
    if (listed.length) order = listed;
  }
  if (order.length === 0) throw new Error("Not a PowerPoint deck: no slides found.");
  return order
    .map((name, i) => {
      const xml = strFromU8(files[name]).replace(/<a:br\/>/g, "\n").replace(/<\/a:p>/g, "\n");
      return `## Slide ${i + 1}\n${tidy(stripXml(xml))}`;
    })
    .join("\n\n");
}

function columnIndex(ref) {
  const letters = ref.match(/^[A-Z]+/i)?.[0].toUpperCase() ?? "A";
  return [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
}

function xlsxText(bytes) {
  const files = unzip(
    bytes,
    (n) =>
      /^xl\/worksheets\/[^/]+\.xml$/.test(n) ||
      n === "xl/sharedStrings.xml" ||
      n === "xl/workbook.xml" ||
      n === "xl/_rels/workbook.xml.rels",
  );
  const shared = files["xl/sharedStrings.xml"]
    ? [...strFromU8(files["xl/sharedStrings.xml"]).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
        stripXml(m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, "")),
      )
    : [];
  const workbook = files["xl/workbook.xml"] ? strFromU8(files["xl/workbook.xml"]) : "";
  const rels = files["xl/_rels/workbook.xml.rels"] ? strFromU8(files["xl/_rels/workbook.xml.rels"]) : "";
  const target = new Map(
    [...rels.matchAll(/<Relationship\b[^>]*>/g)].map(([tag]) => [
      tag.match(/\bId="([^"]+)"/)?.[1],
      `xl/${(tag.match(/\bTarget="([^"]+)"/)?.[1] ?? "").replace(/^\/?(xl\/)?/, "")}`,
    ]),
  );
  const sheets = [...workbook.matchAll(/<sheet\b[^>]*>/g)]
    .map(([tag]) => ({
      name: decodeEntities(tag.match(/\bname="([^"]*)"/)?.[1] ?? "Sheet"),
      file: target.get(tag.match(/\br:id="([^"]+)"/)?.[1]),
    }))
    .filter((s) => s.file && files[s.file]);
  if (sheets.length === 0) throw new Error("Not an Excel workbook: no worksheets found.");

  return sheets
    .map(({ name, file }) => {
      const rows = [];
      for (const [, row] of strFromU8(files[file]).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
        const cells = [];
        for (const [, attrs, inner = ""] of row.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const ref = attrs.match(/\br="([^"]+)"/)?.[1];
          const type = attrs.match(/\bt="([^"]+)"/)?.[1];
          const raw = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
          let value =
            type === "s" ? shared[Number(raw)] ?? ""
            : type === "inlineStr" ? stripXml(inner.match(/<is>([\s\S]*?)<\/is>/)?.[1] ?? "")
            : type === "b" ? (raw === "1" ? "TRUE" : "FALSE")
            : decodeEntities(raw ?? "");
          value = value.replace(/\s+/g, " ").trim();
          cells[ref ? columnIndex(ref) : cells.length] = value;
        }
        const line = Array.from(cells, (c) => c ?? "").join(" | ").replace(/(\s*\|\s*)+$/, "");
        if (line.replace(/[|\s]/g, "")) rows.push(line);
      }
      return `## Sheet: ${name}\n${rows.length ? rows.join("\n") : "(empty)"}`;
    })
    .join("\n\n");
}

async function pdfText(bytes) {
  // pdf.js reports through console.log, and stdout here is the JSON-RPC
  // channel: one "Warning: …" line written there corrupts the protocol. So
  // its chatter goes to stderr for as long as it runs.
  const log = console.log;
  console.log = console.error;
  try {
    const { getDocumentProxy, extractText } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
    const { text: pages } = await extractText(pdf, { mergePages: false });
    // A scanned PDF is pictures: every page comes back blank. Return nothing
    // then, not a row of empty "## Page N" headers, so the caller can say
    // "probably scanned" instead of handing on a document with no words in it.
    if (pages.every((p) => !p.trim())) return "";
    return pages.map((p, i) => `## Page ${i + 1}\n${tidy(p)}`).join("\n\n");
  } finally {
    console.log = log;
  }
}

export async function fileText(name, bytes) {
  const ext = extOf(name);
  if (PLAIN.has(ext)) return tidy(new TextDecoder().decode(bytes));
  if (ext === "vtt") return turnsToText(vttToTurns(new TextDecoder().decode(bytes)));
  if (ext === "html" || ext === "htm") {
    return tidy(stripXml(new TextDecoder().decode(bytes).replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<\/(p|div|h\d|li|tr)>/gi, "\n")));
  }
  if (ext === "docx") return docxText(bytes);
  if (ext === "pptx") return pptxText(bytes);
  if (ext === "xlsx") return xlsxText(bytes);
  if (ext === "pdf") return pdfText(bytes);
  return null;
}

export const READABLE = "Word (.docx), PowerPoint (.pptx), Excel (.xlsx), PDF, transcripts (.vtt), HTML and plain-text files";

/** The extensions fileText reads. Anything else is refused by name, not guessed at. */
export const READABLE_EXTENSIONS = [...PLAIN, "vtt", "html", "htm", "docx", "pptx", "xlsx", "pdf"];

export function canRead(name) {
  return READABLE_EXTENSIONS.includes(extOf(name));
}
