// Manguito Pro — archivos, todo en el navegador del cliente:
//  1) LEER lo que adjunta: de Word, Excel y PowerPoint se saca solo el texto;
//     de un video, unos cuadros (el video nunca se sube al servidor).
//  2) CREAR los archivos que escribe la IA (bloque ```archivo:nombre.ext):
//     Word (.docx), Excel (.xlsx), PDF y texto, para descargarlos.
// Nada de esto se ejecuta: solo se arman archivos con texto escapado.
(function () {
  "use strict";

  const MAX_TEXT_CHARS = 200000;
  const VIDEO_MAX_BYTES = 15 * 1024 * 1024;
  const MAX_FRAMES = 8;
  const enc = new TextEncoder();

  // ═══ ZIP (Word, Excel y PowerPoint son archivos ZIP por dentro) ═══
  async function zipEntries(buf) {
    const u8 = new Uint8Array(buf), dv = new DataView(buf);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("El archivo está dañado o no es de Office.");
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    const map = new Map();
    for (let n = 0; n < count && p + 46 <= u8.length; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const off = dv.getUint32(p + 42, true);
      map.set(dec.decode(u8.subarray(p + 46, p + 46 + nlen)), { method, csize, usize, off });
      p += 46 + nlen + xlen + clen;
    }
    async function read(name) {
      const e = map.get(name);
      if (!e) return null;
      if (e.usize > 60 * 1024 * 1024) throw new Error("El documento es demasiado grande.");
      const start = e.off + 30 + dv.getUint16(e.off + 26, true) + dv.getUint16(e.off + 28, true);
      const data = u8.subarray(start, start + e.csize);
      if (e.method === 0) return dec.decode(data);
      if (e.method !== 8 || typeof DecompressionStream === "undefined") throw new Error("Tu navegador no puede abrir este documento. Guárdalo como PDF.");
      const out = await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
      return dec.decode(out);
    }
    return { names: [...map.keys()], read };
  }

  const xml = s => new DOMParser().parseFromString(s, "application/xml");
  const byName = (node, name) => [...node.getElementsByTagNameNS("*", name)];
  const kids = (node, name) => [...node.children].filter(c => c.localName === name);

  // ── Word ──
  function docxParagraph(p) {
    let text = "";
    const walk = n => {
      for (const c of n.children) {
        if (c.localName === "t") text += c.textContent;
        else if (c.localName === "tab") text += "\t";
        else if (c.localName === "br" || c.localName === "cr") text += "\n";
        else if (c.localName !== "pPr" && c.localName !== "rPr") walk(c);
      }
    };
    walk(p);
    const style = byName(p, "pStyle")[0];
    const val = style ? (style.getAttribute("w:val") || style.getAttributeNS(style.namespaceURI, "val") || "") : "";
    const h = val.match(/^(?:heading|ttulo|titulo|título)\s*(\d)/i);
    if (h && text.trim()) return "#".repeat(Math.min(4, Number(h[1]) || 1)) + " " + text;
    if (/^(title|titulo|título)$/i.test(val) && text.trim()) return "# " + text;
    if (byName(p, "numPr").length && text.trim()) return "- " + text;
    return text;
  }
  async function readDocx(z) {
    const s = await z.read("word/document.xml");
    if (!s) throw new Error("No se encontró el texto del Word.");
    const body = byName(xml(s), "body")[0];
    const out = [];
    for (const el of body ? body.children : []) {
      if (el.localName === "p") out.push(docxParagraph(el));
      else if (el.localName === "tbl") {
        for (const tr of kids(el, "tr")) {
          out.push("| " + kids(tr, "tc").map(tc => kids(tc, "p").map(docxParagraph).join(" ").replace(/\|/g, "/").trim()).join(" | ") + " |");
        }
        out.push("");
      }
    }
    return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  // ── Excel ──
  const csvCell = v => /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  const colIndex = ref => { let n = 0; for (const ch of String(ref).replace(/\d+$/, "")) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
  async function readXlsx(z) {
    const shared = [];
    const ss = await z.read("xl/sharedStrings.xml");
    if (ss) for (const si of byName(xml(ss), "si")) shared.push(byName(si, "t").map(t => t.textContent).join(""));
    const wb = await z.read("xl/workbook.xml");
    const rels = await z.read("xl/_rels/workbook.xml.rels");
    const targets = {};
    if (rels) for (const r of byName(xml(rels), "Relationship")) targets[r.getAttribute("Id")] = r.getAttribute("Target");
    let sheets = [];
    if (wb) {
      sheets = byName(xml(wb), "sheet").map(sh => {
        const rid = [...sh.attributes].find(a => a.localName === "id" && a.prefix)?.value;
        let target = targets[rid] || "";
        target = target.replace(/^\/?xl\//, "").replace(/^\//, "");
        return { name: sh.getAttribute("name") || "Hoja", path: target ? "xl/" + target : "" };
      });
    }
    if (!sheets.some(s => s.path)) {
      sheets = z.names.filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
        .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]))
        .map((path, i) => ({ name: "Hoja " + (i + 1), path }));
    }
    const out = [];
    let rowsLeft = 20000;
    for (const sh of sheets) {
      const s = sh.path ? await z.read(sh.path) : null;
      if (!s) continue;
      const lines = [];
      for (const row of byName(xml(s), "row")) {
        if (rowsLeft-- <= 0) break;
        const cells = [];
        for (const c of kids(row, "c")) {
          const t = c.getAttribute("t"), v = kids(c, "v")[0]?.textContent ?? "";
          let val = v;
          if (t === "s") val = shared[Number(v)] ?? "";
          else if (t === "inlineStr") val = byName(c, "t").map(x => x.textContent).join("");
          else if (t === "b") val = v === "1" ? "VERDADERO" : "FALSO";
          if (!val && kids(c, "f")[0]) val = "=" + kids(c, "f")[0].textContent; // fórmula sin resultado guardado
          const idx = c.getAttribute("r") ? colIndex(c.getAttribute("r")) : cells.length;
          cells[idx] = csvCell(String(val));
        }
        if (cells.length) lines.push(Array.from(cells, x => x ?? "").join(","));
      }
      if (lines.length) out.push(`## Hoja: ${sh.name}\n` + lines.join("\n"));
    }
    return out.join("\n\n").trim();
  }

  // ── PowerPoint ──
  async function readPptx(z) {
    const slides = z.names.filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
    const out = [];
    for (let i = 0; i < slides.length; i++) {
      const s = await z.read(slides[i]);
      if (!s) continue;
      const paras = byName(xml(s), "p").map(p => byName(p, "t").map(t => t.textContent).join("")).filter(t => t.trim());
      out.push(`## Diapositiva ${i + 1}\n` + paras.join("\n"));
    }
    return out.join("\n\n").trim();
  }

  // ── Texto ──
  const TEXT_EXT = /\.(txt|text|md|markdown|csv|tsv|json|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|java|c|h|cpp|hpp|cs|php|rb|go|rs|kt|swift|dart|sql|ya?ml|toml|ini|cfg|conf|log|sh|bat|ps1|r|m|tex|srt|vtt|rtf|vue|svelte)$/i;
  async function readText(file) {
    const buf = await file.arrayBuffer();
    try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
    catch { return new TextDecoder("windows-1252").decode(buf); } // CSV de Excel en español
  }

  /** Prepara un documento para mandarlo: PDF tal cual; lo demás, como texto. */
  async function readDocument(file) {
    const name = file.name || "documento";
    const ext = (name.match(/\.([a-z0-9]+)$/i) || [, ""])[1].toLowerCase();
    if (ext === "pdf" || file.type === "application/pdf") {
      if (file.size > 10 * 1024 * 1024) throw new Error("El PDF pesa más de 10 MB.");
      return { kind: "pdf", blob: file, name, note: "" };
    }
    if (["doc", "xls", "ppt"].includes(ext)) throw new Error(`«${name}» es un formato antiguo. Guárdalo como .${ext}x o PDF y vuelve a intentar.`);
    let text;
    if (["docx", "docm", "xlsx", "xlsm", "pptx"].includes(ext)) {
      if (file.size > 25 * 1024 * 1024) throw new Error("El documento pesa más de 25 MB.");
      const z = await zipEntries(await file.arrayBuffer());
      text = ext.startsWith("doc") ? await readDocx(z) : ext.startsWith("xls") ? await readXlsx(z) : await readPptx(z);
    } else if (TEXT_EXT.test(name) || /^text\//.test(file.type) || file.type === "application/json") {
      if (file.size > 3 * 1024 * 1024) throw new Error("El archivo de texto pesa más de 3 MB.");
      text = await readText(file);
    } else {
      throw new Error(`No puedo leer «${name}». Usa PDF, Word, Excel, PowerPoint, texto, imágenes o un video.`);
    }
    text = String(text || "").replace(/\u0000/g, "");
    if (!text.trim()) throw new Error(`«${name}» no tiene texto que leer.`);
    let note = "";
    if (text.length > MAX_TEXT_CHARS) { text = text.slice(0, MAX_TEXT_CHARS); note = "Es muy largo: Manguito leerá solo el inicio."; }
    return { kind: "text", blob: new Blob([text], { type: "text/plain" }), name, note };
  }

  // ═══ Video: unos cuadros (sin audio); el video no se sube ═══
  function once(el, ev, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { cleanup(); reject(new Error("timeout")); }, ms);
      const ok = () => { cleanup(); resolve(); };
      const bad = () => { cleanup(); reject(new Error("error")); };
      const cleanup = () => { clearTimeout(t); el.removeEventListener(ev, ok); el.removeEventListener("error", bad); };
      el.addEventListener(ev, ok); el.addEventListener("error", bad);
    });
  }
  async function videoFrames(file) {
    if (file.size > VIDEO_MAX_BYTES) throw new Error("El video pesa más de 15 MB. Recórtalo o envía uno más corto.");
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = url;
    try {
      try { await once(v, "loadedmetadata", 15000); } catch { throw new Error("No pude abrir ese video. Prueba con MP4 o MOV."); }
      // iPhone: sin «play» no carga ningún cuadro.
      try { await v.play(); v.pause(); } catch { /* en PC no hace falta */ }
      const duration = isFinite(v.duration) ? v.duration : 0;
      const count = Math.max(1, Math.min(MAX_FRAMES, Math.ceil((duration || 1) / 5)));
      const scale = Math.min(1, 768 / Math.max(v.videoWidth || 768, v.videoHeight || 768));
      const w = Math.max(2, Math.round((v.videoWidth || 640) * scale)), h = Math.max(2, Math.round((v.videoHeight || 360) * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      const frames = [];
      for (let i = 0; i < count; i++) {
        const t = duration ? Math.min(duration - 0.05, (i + 0.5) * duration / count) : 0;
        if (Math.abs(v.currentTime - t) > 0.01) { v.currentTime = Math.max(0, t); try { await once(v, "seeked", 8000); } catch { continue; } }
        ctx.drawImage(v, 0, 0, w, h);
        const blob = await new Promise(r => canvas.toBlob(r, "image/jpeg", 0.72));
        if (blob) frames.push(blob);
      }
      if (!frames.length) throw new Error("No pude sacar imágenes de ese video.");
      return { frames, duration, name: file.name || "video", bytes: file.size };
    } finally {
      v.removeAttribute("src"); v.load();
      URL.revokeObjectURL(url);
    }
  }

  // ═══ Crear archivos ═══
  const xmlEsc = s => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // ZIP sin comprimir (suficiente para Word/Excel).
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = d => { let c = 0xffffffff; for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  function zip(files) {
    const parts = [], central = [];
    let offset = 0;
    for (const [name, content] of files) {
      const data = typeof content === "string" ? enc.encode(content) : content;
      const nm = enc.encode(name), crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, nm.length, true);
      parts.push(new Uint8Array(lh.buffer), nm, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, nm.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), nm);
      offset += 30 + nm.length + data.length;
    }
    const size = central.reduce((s, a) => s + a.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, size, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: "application/octet-stream" });
  }

  // Markdown sencillo → bloques (lo usan Word y PDF).
  function mdBlocks(text) {
    const lines = String(text).replace(/\r\n/g, "\n").split("\n");
    const blocks = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^\s*```/.test(l)) continue;
      if (/^\s*\|.*\|\s*$/.test(l)) {
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          if (!/^\s*\|?\s*:?-{2,}/.test(lines[i])) rows.push(lines[i].trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim()));
          i++;
        }
        i--;
        blocks.push({ t: "table", rows });
        continue;
      }
      const h = l.match(/^(#{1,4})\s+(.*)$/);
      if (h) { blocks.push({ t: "h", level: h[1].length, text: h[2] }); continue; }
      const ul = l.match(/^\s*[-*+•]\s+(.*)$/);
      if (ul) { blocks.push({ t: "li", text: ul[1], mark: "•" }); continue; }
      const ol = l.match(/^\s*(\d+)[.)]\s+(.*)$/);
      if (ol) { blocks.push({ t: "li", text: ol[2], mark: ol[1] + "." }); continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { blocks.push({ t: "hr" }); continue; }
      blocks.push({ t: l.trim() ? "p" : "gap", text: l.replace(/^>\s?/, "") });
    }
    return blocks;
  }
  // **negritas** → tramos [{text, bold}]
  const runs = s => String(s).split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map(x => /^\*\*[^*]+\*\*$/.test(x) ? { text: x.slice(2, -2), bold: true } : { text: x.replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$|[.,;:!?])/g, "$1$2").replace(/`/g, ""), bold: false });

  // ── Word (.docx) ──
  function docx(text) {
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const r = rs => rs.map(x => `<w:r>${x.bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${xmlEsc(x.text)}</w:t></w:r>`).join("");
    const body = mdBlocks(text).map(b => {
      if (b.t === "h") return `<w:p><w:pPr><w:pStyle w:val="Heading${b.level}"/></w:pPr>${r(runs(b.text.replace(/\*\*/g, "")))}</w:p>`;
      if (b.t === "li") return `<w:p><w:pPr><w:ind w:left="567" w:hanging="283"/></w:pPr>${r([{ text: b.mark + "\t", bold: false }, ...runs(b.text)])}</w:p>`;
      if (b.t === "hr") return `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BBBBBB"/></w:pBdr></w:pPr></w:p>`;
      if (b.t === "gap") return "";
      if (b.t === "table") {
        const cols = Math.max(...b.rows.map(x => x.length), 1);
        const border = '<w:tblBorders>' + ["top", "left", "bottom", "right", "insideH", "insideV"].map(s => `<w:${s} w:val="single" w:sz="4" w:color="BFBFBF"/>`).join("") + "</w:tblBorders>";
        return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>${border}</w:tblPr>` +
          b.rows.map((row, ri) => "<w:tr>" + Array.from({ length: cols }, (_, ci) => `<w:tc><w:p>${r(runs(row[ci] ?? "").map(x => ri === 0 ? { ...x, bold: true } : x))}</w:p></w:tc>`).join("") + "</w:tr>").join("") +
          "</w:tbl><w:p/>";
      }
      return `<w:p>${r(runs(b.text))}</w:p>`;
    }).join("");
    const heading = (n, size) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`;
    return zip([
      ["[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'],
      ["_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
      ["word/_rels/document.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
      ["word/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:lang w:val="es-PE"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${heading(1, 36)}${heading(2, 28)}${heading(3, 24)}${heading(4, 22)}</w:styles>`],
      ["word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`],
    ]);
  }

  // ── Excel (.xlsx) desde CSV ──
  function parseCsv(text) {
    const src = String(text).replace(/\r\n/g, "\n").replace(/^﻿/, "").trim();
    const first = src.split("\n")[0] || "";
    const sep = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ";" : (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? "\t" : ",";
    const rows = [];
    let row = [], cell = "", q = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (q) {
        if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') q = false;
        else cell += ch;
      } else if (ch === '"' && !cell) q = true;
      else if (ch === sep) { row.push(cell); cell = ""; }
      else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
      else cell += ch;
    }
    row.push(cell); rows.push(row);
    return rows.filter(r => r.some(c => c.trim() !== "")).slice(0, 20000);
  }
  const colName = n => { let s = ""; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
  function xlsx(text) {
    const rows = parseCsv(text);
    const cols = Math.max(1, ...rows.map(r => r.length));
    const widths = Array.from({ length: cols }, (_, c) => Math.min(60, Math.max(8, ...rows.map(r => String(r[c] ?? "").length + 2))));
    const sheet = rows.map((r, ri) => `<row r="${ri + 1}">` + r.map((v, ci) => {
      const ref = colName(ci) + (ri + 1), style = ri === 0 ? ' s="1"' : "";
      const val = String(v).trim();
      if (val === "") return "";
      if (/^-?\d+(\.\d+)?$/.test(val) && !/^0\d/.test(val) && val.length < 16) return `<c r="${ref}"${style}><v>${val}</v></c>`;
      if (/^=[A-Za-z]/.test(val) && val.length < 500) return `<c r="${ref}"${style}><f>${xmlEsc(val.slice(1))}</f></c>`;
      return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(val)}</t></is></c>`;
    }).join("") + "</row>").join("");
    const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    return zip([
      ["[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
      ["_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
      ["xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
      ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ${NS}><sheets><sheet name="Hoja1" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`],
      ["xl/styles.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFE8A3"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs></styleSheet>'],
      ["xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${NS}><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols><sheetData>${sheet}</sheetData></worksheet>`],
    ]);
  }

  // ── PDF (texto con títulos, listas, negritas y tablas simples) ──
  const HW = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
  const WIN = { "€": 0x80, "‚": 0x82, "„": 0x84, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "™": 0x99 };
  const toWin = s => [...String(s)].map(ch => {
    const c = ch.codePointAt(0);
    if (c >= 32 && c < 127) return ch;
    if (c >= 160 && c <= 255) return String.fromCharCode(c);
    if (WIN[ch]) return String.fromCharCode(WIN[ch]);
    if (ch === "\t") return "    ";
    return c > 0xffff || (c >= 0x2600 && c <= 0x27bf) ? "" : "?"; // emojis fuera
  }).join("");
  const charW = (ch, bold) => {
    const c = ch.charCodeAt(0);
    let w = c >= 32 && c < 127 ? HW[c - 32] : 556;
    if (c >= 0xc0) w = /[ÀÁÂÃÄÅÈÉÊËÌÍÎÏÒÓÔÕÖÙÚÛÜÑÇÝ]/.test(ch) ? 690 : /[ìíîï]/.test(ch) ? 278 : 556;
    return bold ? w * 1.07 : w;
  };
  const textW = (s, size, bold) => [...s].reduce((a, ch) => a + charW(ch, bold), 0) * size / 1000;
  const pdfStr = s => "(" + s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)") + ")";
  function pdf(text) {
    const PW = 595, PH = 842, M = 56, MAXW = PW - 2 * M;
    const pages = [];
    let ops = [], y = PH - M;
    const newPage = () => { if (ops.length) pages.push(ops.join("\n")); ops = []; y = PH - M; };
    const need = h => { if (y - h < M) newPage(); };
    // Escribe tramos con ajuste de línea.
    function para(rs, size, indent, mark) {
      const words = [];
      for (const r of rs) for (const w of toWin(r.text).split(/(\s+)/)) if (w) words.push({ w, bold: r.bold });
      const lh = size * 1.4;
      let line = [], lw = 0, first = true;
      const flush = () => {
        need(lh);
        y -= lh;
        const x = M + indent;
        const parts = [];
        if (first && mark) parts.push(`BT ${(x - 16).toFixed(1)} ${y.toFixed(1)} Td /F1 ${size} Tf ${pdfStr(toWin(mark))} Tj ET`);
        parts.push(`BT ${x.toFixed(1)} ${y.toFixed(1)} Td`);
        let cur = null;
        for (const it of line) {
          const f = it.bold ? "/F2" : "/F1";
          if (f !== cur) { parts.push(`${f} ${size} Tf`); cur = f; }
          parts.push(`${pdfStr(it.w)} Tj`);
        }
        parts.push("ET");
        ops.push(parts.join(" "));
        line = []; lw = 0; first = false;
      };
      for (const it of words) {
        const ww = textW(it.w, size, it.bold);
        if (/^\s+$/.test(it.w) && !line.length) continue;
        if (lw + ww > MAXW - indent && line.length) { flush(); if (/^\s+$/.test(it.w)) continue; }
        line.push(it); lw += ww;
      }
      if (line.length || first) flush();
    }
    for (const b of mdBlocks(text)) {
      if (b.t === "h") { const size = [0, 18, 14.5, 12.5, 11.5][b.level]; y -= b.level === 1 ? 6 : 4; para([{ text: b.text.replace(/\*\*/g, ""), bold: true }], size, 0); y -= 3; }
      else if (b.t === "li") para(runs(b.text), 11, 18, b.mark);
      else if (b.t === "p") { para(runs(b.text), 11, 0); y -= 3; }
      else if (b.t === "gap") y -= 5;
      else if (b.t === "hr") { need(12); y -= 6; ops.push(`0.75 G 0.6 w ${M} ${y.toFixed(1)} m ${PW - M} ${y.toFixed(1)} l S 0 G`); y -= 6; }
      else if (b.t === "table") {
        const cols = Math.max(...b.rows.map(r => r.length), 1), cw = MAXW / cols;
        b.rows.forEach((row, ri) => {
          need(16);
          y -= 15;
          const cells = Array.from({ length: cols }, (_, ci) => {
            let s = toWin(String(row[ci] ?? "").replace(/\*\*/g, ""));
            while (s.length > 1 && textW(s, 9.5, ri === 0) > cw - 8) s = s.slice(0, -2) + "\x85"; // «…»
            return `BT ${(M + ci * cw + 4).toFixed(1)} ${(y + 4).toFixed(1)} Td ${ri === 0 ? "/F2" : "/F1"} 9.5 Tf ${pdfStr(s)} Tj ET`;
          });
          if (ri === 0) ops.push(`0.96 0.92 0.84 rg ${M} ${y.toFixed(1)} ${MAXW} 15 re f 0 g`);
          ops.push(...cells);
          ops.push(`0.8 G 0.4 w ${M} ${y.toFixed(1)} m ${PW - M} ${y.toFixed(1)} l S 0 G`);
        });
        y -= 8;
      }
    }
    newPage();
    if (!pages.length) pages.push("");
    // Objetos: 1 catálogo, 2 páginas, 3-4 fuentes, luego página + contenido.
    const objs = [];
    const kidsRef = pages.map((_, i) => `${5 + i * 2} 0 R`).join(" ");
    objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    objs[2] = `<< /Type /Pages /Kids [${kidsRef}] /Count ${pages.length} >>`;
    objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
    objs[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
    pages.forEach((content, i) => {
      objs[5 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`;
      objs[6 + i * 2] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
    });
    let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
    const offs = [];
    for (let n = 1; n < objs.length; n++) { offs[n] = out.length; out += `${n} 0 obj\n${objs[n]}\nendobj\n`; }
    const xref = out.length;
    out += `xref\n0 ${objs.length}\n0000000000 65535 f \n` + offs.slice(1).map(o => String(o).padStart(10, "0") + " 00000 n \n").join("");
    out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
    return new Blob([bytes], { type: "application/octet-stream" });
  }

  // ── Nombre seguro y tipo ──
  const KINDS = {
    docx: ["Word", "doc"], doc: ["Word", "doc"], xlsx: ["Excel", "xls"], xls: ["Excel", "xls"], pdf: ["PDF", "pdf"],
    csv: ["CSV (Excel)", "xls"], txt: ["Texto", "txt"], md: ["Markdown", "txt"], json: ["JSON", "code"], html: ["HTML", "code"],
  };
  function safeName(n) {
    let s = String(n || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").replace(/\s+/g, "-").replace(/^[.-]+/, "").slice(0, 80);
    if (!s) s = "archivo";
    if (!/\.[a-z0-9]{1,5}$/i.test(s)) s += ".txt";
    // Word/Excel viejos: se entregan en el formato nuevo.
    return s.replace(/\.doc$/i, ".docx").replace(/\.xls$/i, ".xlsx");
  }
  function info(name) {
    const n = safeName(name), ext = n.split(".").pop().toLowerCase();
    const k = KINDS[ext] || [ext.toUpperCase(), "code"];
    return { name: n, ext, label: k[0], tone: k[1] };
  }
  function build(name, text) {
    const { ext } = info(name);
    if (ext === "docx") return docx(text);
    if (ext === "xlsx") return xlsx(text);
    if (ext === "pdf") return pdf(text);
    // Texto: con BOM para que Excel lea bien las tildes del CSV.
    return new Blob([(ext === "csv" ? "﻿" : "") + text], { type: "application/octet-stream" });
  }
  function save(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // Botón «Descargar» de los bloques ```archivo:…``` (chat y chats compartidos).
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-mg-dl]");
    if (!b || b.disabled) return;
    const card = b.closest(".mg-file");
    const code = card && card.querySelector("pre code");
    if (!code) return;
    const name = info(card.dataset.name).name;
    try {
      save(build(name, code.textContent), name);
      const old = b.textContent;
      b.textContent = "✓ Descargado";
      setTimeout(() => { b.textContent = old; }, 1800);
    } catch {
      b.textContent = "No se pudo";
    }
  });

  window.MangoFiles = { readDocument, videoFrames, build, info, safeName, VIDEO_MAX_BYTES, _test: { docx, xlsx, pdf, parseCsv, zipEntries, readDocx, readXlsx, readPptx } };
})();
