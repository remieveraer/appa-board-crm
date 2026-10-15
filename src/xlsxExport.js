"use strict";
/**
 * Générateur Excel (.xlsx) minimal, sans aucune dépendance npm (Node natif :
 * zlib + Buffer). Utilisé par la route d'export de sauvegarde
 * (/api/export/xlsx) : une feuille par collection du board, une ligne par
 * document, une colonne par champ de premier niveau.
 *
 * Principes (sauvegarde = zéro perte) :
 *  - aucune donnée n'est omise : les objets/tableaux imbriqués sont sérialisés
 *    en JSON dans leur cellule ;
 *  - si une cellule dépasse la limite Excel (32 767 caractères), elle est
 *    tronquée avec un marqueur explicite ET signalée dans la feuille
 *    "_Résumé" — la sauvegarde complète exacte reste disponible via
 *    /api/export/json (sans aucune limite).
 */
const zlib = require("zlib");

const EXCEL_CELL_MAX = 32767;
const TRUNC_MARK = " …[TRONQUÉ — voir export JSON]";

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- ZIP minimal (méthode deflate) ----------
function buildZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, "utf8");
    const comp = zlib.deflateRawSync(raw);
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flag : noms en UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + comp.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralBuf, eocd]);
}

// ---------- XML / cellules ----------
function xmlEscape(s) {
  return String(s)
    // caractères interdits en XML 1.0
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function colName(i) {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Convertit une valeur JS en {type, text} de cellule. `onTrunc` est appelé si la valeur est tronquée. */
function toCell(value, onTrunc) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return { t: "n", v: String(value) };
  if (typeof value === "boolean") return { t: "b", v: value ? "1" : "0" };
  let text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length > EXCEL_CELL_MAX) {
    if (onTrunc) onTrunc();
    text = text.slice(0, EXCEL_CELL_MAX - TRUNC_MARK.length) + TRUNC_MARK;
  }
  return { t: "s", v: text };
}

function cellXml(ref, cell, style) {
  const s = style ? ` s="${style}"` : "";
  if (!cell) return "";
  if (cell.t === "n") return `<c r="${ref}"${s}><v>${cell.v}</v></c>`;
  if (cell.t === "b") return `<c r="${ref}"${s} t="b"><v>${cell.v}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(cell.v)}</t></is></c>`;
}

function sheetXml(header, rows, onTrunc) {
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  out.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
  out.push('<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>');
  out.push("<sheetData>");
  out.push('<row r="1">' + header.map((h, i) => cellXml(colName(i) + "1", { t: "s", v: h }, 1)).join("") + "</row>");
  rows.forEach((row, ri) => {
    const r = ri + 2;
    const cells = row.map((v, ci) => cellXml(colName(ci) + r, toCell(v, onTrunc), 0)).join("");
    out.push(`<row r="${r}">${cells}</row>`);
  });
  out.push("</sheetData></worksheet>");
  return out.join("");
}

function safeSheetName(name, used) {
  let n = String(name).replace(/[\\/?*[\]:]/g, "_").slice(0, 31) || "feuille";
  let base = n;
  let k = 2;
  while (used.has(n.toLowerCase())) {
    const suffix = "~" + k++;
    n = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(n.toLowerCase());
  return n;
}

/**
 * @param {{name:string, docs:{id:string,data:any,updatedAt:number}[]}[]} collections
 * @param {{exportedAtIso:string}} meta
 * @returns {{buffer:Buffer, summary:{collection:string,sheet:string,documents:number,truncatedCells:number}[]}}
 */
function buildWorkbook(collections, meta) {
  const used = new Set(["_résumé"]);
  const sheets = []; // {name, xml}
  const summary = [];

  for (const col of collections) {
    const keys = [];
    const seen = new Set();
    for (const d of col.docs) {
      const data = d.data;
      if (data && typeof data === "object" && !Array.isArray(data)) {
        for (const k of Object.keys(data)) {
          if (!seen.has(k)) {
            seen.add(k);
            keys.push(k);
          }
        }
      }
    }
    const hasScalarDocs = col.docs.some((d) => !(d.data && typeof d.data === "object" && !Array.isArray(d.data)));
    const header = ["_id", "_modifié_le", ...keys];
    if (hasScalarDocs) header.push("_valeur");

    let truncated = 0;
    const rows = col.docs.map((d) => {
      const isObj = d.data && typeof d.data === "object" && !Array.isArray(d.data);
      const iso = d.updatedAt ? new Date(d.updatedAt).toISOString() : "";
      const row = [d.id, iso];
      for (const k of keys) row.push(isObj ? d.data[k] : undefined);
      if (hasScalarDocs) row.push(isObj ? undefined : d.data);
      return row;
    });

    const name = safeSheetName(col.name, used);
    sheets.push({ name, xml: sheetXml(header, rows, () => truncated++) });
    summary.push({ collection: col.name, sheet: name, documents: col.docs.length, truncatedCells: truncated });
  }

  // Feuille de résumé (en premier) : preuve d'exhaustivité de la sauvegarde.
  const sumRows = summary.map((s) => [s.collection, s.sheet, s.documents, s.truncatedCells]);
  const total = summary.reduce((a, s) => a + s.documents, 0);
  sumRows.push(["TOTAL", "", total, summary.reduce((a, s) => a + s.truncatedCells, 0)]);
  sumRows.push([]);
  sumRows.push(["Export généré le", meta.exportedAtIso]);
  const resume = { name: "_Résumé", xml: sheetXml(["Collection", "Feuille", "Nb documents", "Cellules tronquées"], sumRows, null) };
  const all = [resume, ...sheets];

  const files = [];
  files.push({
    name: "[Content_Types].xml",
    data:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      all.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
      "</Types>",
  });
  files.push({
    name: "_rels/.rels",
    data:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      "</Relationships>",
  });
  files.push({
    name: "xl/workbook.xml",
    data:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      all.map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
      "</sheets></workbook>",
  });
  files.push({
    name: "xl/_rels/workbook.xml.rels",
    data:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      all.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
      `<Relationship Id="rId${all.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      "</Relationships>",
  });
  files.push({
    name: "xl/styles.xml",
    data:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      "</styleSheet>",
  });
  all.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: s.xml }));

  return { buffer: buildZip(files), summary };
}

module.exports = { buildWorkbook, buildZip, crc32, EXCEL_CELL_MAX };
