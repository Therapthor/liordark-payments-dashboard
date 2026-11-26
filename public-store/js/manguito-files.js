// Manguito Pro — archivos, todo en el navegador del cliente:
//  1) LEER lo que adjunta: de Word, Excel y PowerPoint se saca solo el texto;
//     de un video, unos cuadros (el video nunca se sube al servidor).
//  2) CREAR los archivos que escribe la IA (bloque ```archivo:nombre.ext):
//     Word (.docx), Excel (.xlsx), PDF y texto, para descargarlos.
// Nada de esto se ejecuta: solo se arman archivos con texto escapado.
(function () {
  "use strict";

  const MAX_TEXT_CHARS = 200000;
  const userErr = m => Object.assign(new Error(m), { user: true }); // mensaje listo para el cliente
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
    if (eocd < 0) throw userErr("El archivo está dañado o no es de Office.");
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
      if (e.usize > 60 * 1024 * 1024) throw userErr("El documento es demasiado grande.");
      const start = e.off + 30 + dv.getUint16(e.off + 26, true) + dv.getUint16(e.off + 28, true);
      const data = u8.subarray(start, start + e.csize);
      if (e.method === 0) return dec.decode(data);
      if (e.method !== 8 || typeof DecompressionStream === "undefined") throw userErr("Tu navegador no puede abrir este documento. Actualízalo o guárdalo como PDF.");
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

  // ═══ Office viejo (.doc, .xls, .ppt): archivo «compuesto» (CFB) ═══
  const END = 0xfffffffa;
  function cfb(buf) {
    const u8 = new Uint8Array(buf), dv = new DataView(buf);
    if (![0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((b, i) => u8[i] === b)) return null;
    const ss = 1 << dv.getUint16(0x1e, true), mss = 1 << dv.getUint16(0x20, true);
    const nFat = dv.getUint32(0x2c, true), dirStart = dv.getUint32(0x30, true), cutoff = dv.getUint32(0x38, true);
    const miniFatStart = dv.getUint32(0x3c, true);
    const off = n => (n + 1) * ss;
    const fatSecs = [];
    for (let i = 0; i < 109 && fatSecs.length < nFat; i++) { const x = dv.getUint32(0x4c + i * 4, true); if (x < END) fatSecs.push(x); }
    for (let d = dv.getUint32(0x44, true), g = 0; d < END && fatSecs.length < nFat && g < 50000 && off(d) + ss <= u8.length; g++) {
      for (let i = 0; i < ss / 4 - 1 && fatSecs.length < nFat; i++) { const x = dv.getUint32(off(d) + i * 4, true); if (x < END) fatSecs.push(x); }
      d = dv.getUint32(off(d) + ss - 4, true);
    }
    const fat = [];
    for (const f of fatSecs) { if (off(f) + ss > u8.length) continue; for (let i = 0; i < ss / 4; i++) fat.push(dv.getUint32(off(f) + i * 4, true)); }
    function readChain(start, size) {
      const secs = [];
      for (let x = start, g = 0; x < END && x < fat.length && g < 2e6; g++) { secs.push(x); x = fat[x]; }
      const out = new Uint8Array(secs.length * ss);
      secs.forEach((x, i) => { if (off(x) < u8.length) out.set(u8.subarray(off(x), Math.min(off(x) + ss, u8.length)), i * ss); });
      return size != null ? out.subarray(0, Math.min(size, out.length)) : out;
    }
    const dir = readChain(dirStart);
    const ddv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
    const d16 = new TextDecoder("utf-16le");
    const entries = [];
    for (let o = 0; o + 128 <= dir.length; o += 128) {
      const type = dir[o + 0x42];
      if (!type) continue;
      const nlen = Math.min(64, ddv.getUint16(o + 0x40, true));
      entries.push({ name: d16.decode(dir.subarray(o, o + Math.max(0, nlen - 2))), type, start: ddv.getUint32(o + 0x74, true), size: ddv.getUint32(o + 0x78, true) });
    }
    const root = entries.find(e => e.type === 5);
    const mini = root ? readChain(root.start, root.size) : new Uint8Array(0);
    const miniFat = [];
    if (miniFatStart < END) {
      const mf = readChain(miniFatStart), mdv = new DataView(mf.buffer, mf.byteOffset, mf.byteLength);
      for (let i = 0; i + 4 <= mf.length; i += 4) miniFat.push(mdv.getUint32(i, true));
    }
    function stream(name) {
      const e = entries.find(x => x.type === 2 && x.name.toLowerCase() === name.toLowerCase());
      if (!e) return null;
      if (e.size >= cutoff) return readChain(e.start, e.size);
      const out = new Uint8Array(e.size);
      for (let x = e.start, pos = 0, g = 0; x < END && pos < e.size && g < 2e6; g++) {
        out.set(mini.subarray(x * mss, x * mss + Math.min(mss, e.size - pos)), pos);
        pos += mss; x = miniFat[x];
      }
      return out;
    }
    return { stream, has: n => entries.some(x => x.name.toLowerCase() === n.toLowerCase()) };
  }
  const view = a => new DataView(a.buffer, a.byteOffset, a.byteLength);
  const d1252 = new TextDecoder("windows-1252"), d16le = new TextDecoder("utf-16le");

  // ── Word 97-2003 (.doc) ──
  function readDoc(c) {
    const wd = c.stream("WordDocument");
    const dv = view(wd);
    const flags = dv.getUint16(0x0a, true);
    if (flags & 0x0100) throw new Error("PROTEGIDO");
    let text = "";
    const ident = dv.getUint16(0, true);
    if (ident === 0xa5ec) {
      const table = c.stream(flags & 0x0200 ? "1Table" : "0Table");
      let pos = 32;
      pos += 2 + dv.getUint16(pos, true) * 2;          // fibRgW
      const cslw = dv.getUint16(pos, true), lw = pos + 2;
      const ccpText = dv.getUint32(lw + 12, true);
      const fc = lw + cslw * 4 + 2;
      const fcClx = dv.getUint32(fc + 33 * 8, true), lcbClx = dv.getUint32(fc + 33 * 8 + 4, true);
      if (table && lcbClx && fcClx + lcbClx <= table.length) {
        const tv = view(table);
        let p = fcClx;
        while (p < fcClx + lcbClx && table[p] === 0x01) p += 3 + tv.getInt16(p + 1, true);
        if (table[p] === 0x02) {
          const lcb = tv.getUint32(p + 1, true), plc = p + 5, n = Math.floor((lcb - 4) / 12);
          for (let i = 0; i < n; i++) {
            const cp0 = tv.getUint32(plc + i * 4, true), cp1 = tv.getUint32(plc + (i + 1) * 4, true);
            let f = tv.getUint32(plc + (n + 1) * 4 + i * 8 + 2, true);
            const compressed = (f & 0x40000000) !== 0;
            f &= 0x3fffffff;
            const len = Math.max(0, cp1 - cp0);
            text += compressed ? d1252.decode(wd.subarray(f / 2, f / 2 + len)) : d16le.decode(wd.subarray(f, f + len * 2));
          }
        }
      }
      if (ccpText && text.length > ccpText) text = text.slice(0, ccpText); // solo el cuerpo
    }
    if (!text) text = d1252.decode(wd.subarray(dv.getUint32(0x18, true), dv.getUint32(0x1c, true))); // Word 6/95
    for (let k = 0; k < 6; k++) text = text.replace(/\x13[^\x13\x14\x15]*\x14([^\x13\x15]*)\x15/g, "$1").replace(/\x13[^\x13\x14\x15]*\x15/g, "");
    return text.replace(/[\x13\x14\x15]/g, "").replace(/\x07\x07/g, "\n").replace(/\x07/g, " | ")
      .replace(/[\r\x0b\x0c]/g, "\n").replace(/[\x00-\x08\x0e-\x1f]/g, "").replace(/\n{3,}/g, "\n\n").trim();
  }

  // ── Excel 97-2003 (.xls) ──
  function readXls(c) {
    let wb = c.stream("Workbook"), biff5 = false;
    if (!wb) { wb = c.stream("Book"); biff5 = true; }
    const dv = view(wb);
    const recs = [];
    for (let p = 0; p + 4 <= wb.length;) { const len = dv.getUint16(p + 2, true); recs.push({ type: dv.getUint16(p, true), off: p + 4, len, pos: p }); p += 4 + len; }
    if (recs.some(r => r.type === 0x002f)) throw new Error("PROTEGIDO");
    const dLat = new TextDecoder("windows-1252");
    const str = (o, short) => {      // XLUnicodeString (o corto: cch de 1 byte)
      const cch = short ? wb[o] : dv.getUint16(o, true), q = o + (short ? 1 : 2);
      if (biff5) return dLat.decode(wb.subarray(q, q + cch));
      const high = wb[q] & 1;
      return high ? d16le.decode(wb.subarray(q + 1, q + 1 + cch * 2)) : dLat.decode(wb.subarray(q + 1, q + 1 + cch));
    };
    const sheetAt = new Map(), sst = [];
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      if (r.type === 0x0085) sheetAt.set(dv.getUint32(r.off, true), str(r.off + 6, true));
      if (r.type === 0x00fc) {
        const segs = [wb.subarray(r.off, r.off + r.len)];
        for (let j = i + 1; j < recs.length && recs[j].type === 0x003c; j++) segs.push(wb.subarray(recs[j].off, recs[j].off + recs[j].len));
        let si = 0, p = 8;
        const byte = () => { while (si < segs.length && p >= segs[si].length) { si++; p = 0; } return si < segs.length ? segs[si][p++] : 0; };
        const u16 = () => byte() | (byte() << 8);
        const unique = view(segs[0]).getUint32(4, true);
        for (let k = 0; k < unique && si < segs.length; k++) {
          const cch = u16(), fl = byte();
          let high = fl & 1;
          const runs = fl & 8 ? u16() : 0, ext = fl & 4 ? (u16() | (u16() << 16)) >>> 0 : 0;
          let out = "", left = cch;
          while (left > 0 && si < segs.length) {
            if (p >= segs[si].length) { si++; p = 0; if (si >= segs.length) break; high = segs[si][p++] & 1; continue; }
            const per = high ? 2 : 1, n = Math.min(left, Math.floor((segs[si].length - p) / per));
            if (!n) { p = segs[si].length; continue; }
            out += high ? d16le.decode(segs[si].subarray(p, p + n * 2)) : dLat.decode(segs[si].subarray(p, p + n));
            p += n * per; left -= n;
          }
          for (let skip = runs * 4 + ext; skip > 0; skip--) byte();
          sst.push(out);
        }
      }
    }
    const rk = v => {
      let n;
      if (v & 2) n = v >> 2;
      else { const b = new DataView(new ArrayBuffer(8)); b.setUint32(4, (v & 0xfffffffc) >>> 0, true); n = b.getFloat64(0, true); }
      return v & 1 ? n / 100 : n;
    };
    const num = x => Number.isInteger(x) ? String(x) : String(Math.round(x * 1e10) / 1e10);
    const sheets = [];
    let cur = null, pending = null, rowsLeft = 20000;
    const set = (row, col, v) => { if (!cur || col > 255) return; if (!cur.rows.has(row)) { if (rowsLeft-- <= 0) return; cur.rows.set(row, []); } cur.rows.get(row)[col] = csvCell(String(v)); };
    for (const r of recs) {
      if (r.type === 0x0809 && sheetAt.has(r.pos)) { cur = { name: sheetAt.get(r.pos), rows: new Map() }; sheets.push(cur); continue; }
      if (r.type === 0x0207) { if (pending && cur) { set(pending[0], pending[1], str(r.off)); pending = null; } continue; } // resultado de fórmula (texto)
      if (!cur || r.len < 6) continue;
      const row = dv.getUint16(r.off, true), col = dv.getUint16(r.off + 2, true);
      switch (r.type) {
        case 0x00fd: set(row, col, sst[dv.getUint32(r.off + 6, true)] ?? ""); break;      // texto
        case 0x0203: set(row, col, num(dv.getFloat64(r.off + 6, true))); break;           // número
        case 0x027e: set(row, col, num(rk(dv.getUint32(r.off + 6, true)))); break;        // número corto
        case 0x00bd: { const last = dv.getUint16(r.off + r.len - 2, true);                // varios números
          for (let cc = col, q = r.off + 4; cc <= last && q + 6 <= r.off + r.len - 2; cc++, q += 6) set(row, cc, num(rk(dv.getUint32(q + 2, true))));
          break; }
        case 0x0204: case 0x00d6: set(row, col, str(r.off + 6)); break;                   // texto (viejo)
        case 0x0205: set(row, col, wb[r.off + 7] ? "#ERROR" : wb[r.off + 6] ? "VERDADERO" : "FALSO"); break;
        case 0x0006:                                                                       // fórmula: su resultado
          if (dv.getUint16(r.off + 12, true) === 0xffff) {
            const t = wb[r.off + 6];
            if (t === 0) pending = [row, col]; else if (t === 1) set(row, col, wb[r.off + 8] ? "VERDADERO" : "FALSO");
          } else set(row, col, num(dv.getFloat64(r.off + 6, true)));
          break;
      }
    }
    return sheets.map(sh => {
      const rows = [...sh.rows.entries()].sort((a, b) => a[0] - b[0]).map(([, cells]) => Array.from(cells, x => x ?? "").join(","));
      return rows.length ? `## Hoja: ${sh.name}\n` + rows.join("\n") : "";
    }).filter(Boolean).join("\n\n").trim();
  }

  // ── PowerPoint 97-2003 (.ppt) ──
  function readPpt(c) {
    const s = c.stream("PowerPoint Document");
    const dv = view(s), out = [];
    const walk = (a, b, depth) => {
      for (let p = a; p + 8 <= b;) {
        const vi = dv.getUint16(p, true), type = dv.getUint16(p + 2, true), len = dv.getUint32(p + 4, true);
        const body = p + 8, next = body + len;
        if (next > b) break;
        if ((vi & 0xf) === 0xf && depth < 24) walk(body, next, depth + 1);
        else if (type === 0x0fa0) out.push(d16le.decode(s.subarray(body, next)));
        else if (type === 0x0fa8) out.push(d1252.decode(s.subarray(body, next)));
        p = next;
      }
    };
    walk(0, s.length, 0);
    const MASTER = /^(haga clic|haz clic|click to (edit|add)|segundo nivel|second level|\*$)/i;
    const seen = new Set();
    return out.map(t => t.replace(/[\r\x0b]/g, "\n").trim())
      .filter(t => t && !MASTER.test(t) && !seen.has(t) && seen.add(t)).join("\n\n");
  }

  // ── RTF ──
  const RTF_SKIP = /^(fonttbl|colortbl|stylesheet|info|pict|object|header[lrf]?|footer[lrf]?|themedata|colorschememapping|latentstyles|datastore|xmlnstbl|listtable|listoverridetable|rsidtbl|generator|mmathPr|fldinst|filetbl|revtbl|pgdsctbl|nonshppict|shpinst)$/;
  const RTF_CH = { emdash: "—", endash: "–", bullet: "•", lquote: "‘", rquote: "’", ldblquote: "“", rdblquote: "”" };
  function rtfToText(src) {
    const stack = [];
    let skip = false, uc = 1, pend = 0, out = "";
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (ch === "{") { stack.push([skip, uc]); continue; }
      if (ch === "}") { const st = stack.pop(); if (st) [skip, uc] = st; continue; }
      if (ch === "\r" || ch === "\n") continue;
      if (ch !== "\\") { if (pend > 0) pend--; else if (!skip) out += ch; continue; }
      const nx = src[i + 1];
      if (nx === "\\" || nx === "{" || nx === "}") { if (!skip) out += nx; i++; continue; }
      if (nx === "'") { const code = parseInt(src.substr(i + 2, 2), 16); i += 3; if (pend > 0) pend--; else if (!skip && code) out += d1252.decode(Uint8Array.of(code)); continue; }
      if (nx === "*") { skip = true; i++; continue; }
      if (nx === "~") { if (!skip) out += " "; i++; continue; }
      if (nx === "\r" || nx === "\n") { if (!skip) out += "\n"; i++; continue; }
      const m = /^([a-zA-Z]+)(-?\d+)? ?/.exec(src.slice(i + 1, i + 40));
      if (!m) { i++; continue; }
      i += m[0].length;
      const w = m[1], arg = m[2] !== undefined ? Number(m[2]) : null;
      if (RTF_SKIP.test(w)) { skip = true; continue; }
      if (skip) continue;
      if (/^(par|line|row|sect|page)$/.test(w)) out += "\n";
      else if (w === "tab") out += "\t";
      else if (w === "cell") out += " | ";
      else if (w === "u" && arg !== null) { out += String.fromCharCode(arg < 0 ? arg + 65536 : arg); pend = uc; }
      else if (w === "uc" && arg !== null) uc = arg;
      else if (RTF_CH[w]) out += RTF_CH[w];
    }
    return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  // ── OpenOffice / LibreOffice (.odt, .ods, .odp) ──
  async function readOdf(z) {
    const s = await z.read("content.xml");
    if (!s) throw new Error("No se encontró el contenido del documento.");
    const doc = xml(s);
    const body = byName(doc, "body")[0] || doc.documentElement;
    const out = [];
    if (byName(body, "spreadsheet").length) {
      let rowsLeft = 20000;
      for (const t of byName(body, "table")) {
        const lines = [];
        for (const r of byName(t, "table-row")) {
          if (rowsLeft-- <= 0) break;
          const cells = [];
          for (const c of [...r.children].filter(x => /table-cell$/.test(x.localName))) {
            const rep = Math.min(Number(c.getAttribute("table:number-columns-repeated")) || 1, 50);
            const v = byName(c, "p").map(p => p.textContent).join(" ");
            for (let k = 0; k < rep; k++) cells.push(csvCell(v));
          }
          while (cells.length && cells[cells.length - 1] === "") cells.pop();
          if (cells.length) lines.push(cells.join(","));
        }
        if (lines.length) out.push(`## Hoja: ${t.getAttribute("table:name") || "Hoja"}\n` + lines.join("\n"));
      }
    } else if (byName(body, "presentation").length) {
      byName(body, "page").forEach((pg, i) => {
        const t = byName(pg, "p").map(p => p.textContent).filter(x => x.trim());
        if (t.length) out.push(`## Diapositiva ${i + 1}\n` + t.join("\n"));
      });
    } else {
      const walk = (n, inList) => {
        for (const c of n.children) {
          if (c.localName === "h") out.push("#".repeat(Math.min(4, Number(c.getAttribute("text:outline-level")) || 1)) + " " + c.textContent);
          else if (c.localName === "p") out.push((inList ? "- " : "") + c.textContent);
          else if (c.localName === "table-row") out.push("| " + [...c.children].map(x => byName(x, "p").map(p => p.textContent).join(" ")).join(" | ") + " |");
          else walk(c, inList || c.localName === "list-item");
        }
      };
      walk(body, false);
    }
    return out.join("\n").trim();
  }

  // ── Libros (.epub) ──
  async function readEpub(z) {
    const htmlText = s => new DOMParser().parseFromString(s.replace(/<\/(p|div|h\d|li|tr)>/gi, "$&\n"), "text/html").body.textContent;
    let files = z.names.filter(n => /\.x?html?$/i.test(n)).sort();
    const cont = await z.read("META-INF/container.xml");
    const opfPath = cont && (xml(cont).querySelector("rootfile")?.getAttribute("full-path") || "");
    if (opfPath) {
      const opf = await z.read(opfPath);
      if (opf) {
        const d = xml(opf), base = opfPath.replace(/[^/]*$/, "");
        const items = {};
        for (const it of byName(d, "item")) items[it.getAttribute("id")] = base + it.getAttribute("href");
        const spine = byName(d, "itemref").map(r => items[r.getAttribute("idref")]).filter(Boolean);
        if (spine.length) files = spine;
      }
    }
    const out = [];
    let total = 0;
    for (const f of files) {
      if (total > MAX_TEXT_CHARS) break;
      const s = await z.read(decodeURIComponent(f));
      if (!s) continue;
      const t = htmlText(s).replace(/[ \t]{2,}/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
      if (t) { out.push(t); total += t.length; }
    }
    return out.join("\n\n");
  }

  // HTML que llega con otro nombre (ej. «.doc» que exporta una web).
  const htmlToText = s => new DOMParser().parseFromString(
    s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<\/(td|th)>/gi, " | $&").replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d)[^>]*>/gi, "$&\n"),
    "text/html").body.textContent.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  /** Prepara un documento para mandarlo: PDF tal cual; lo demás, como texto.
   *  Se reconoce por su contenido (no solo por la extensión). */
  async function readDocument(file) {
    const name = file.name || "documento";
    const ext = (name.match(/\.([a-z0-9]+)$/i) || [, ""])[1].toLowerCase();
    const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
    const headStr = String.fromCharCode(...head.subarray(0, 1024));
    const isPdf = headStr.includes("%PDF-");
    const isZip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 3 && head[3] === 4;
    const isCfb = head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0;
    const isRtf = /^\s*\{\\rtf/.test(headStr);
    const locked = () => userErr(`«${name}» tiene contraseña. Ábrelo, quítale la contraseña y vuelve a enviarlo.`);
    if (isPdf || ext === "pdf") {
      if (!isPdf) throw userErr(`«${name}» no es un PDF válido.`);
      if (file.size > 10 * 1024 * 1024) throw userErr("El PDF pesa más de 10 MB.");
      return { kind: "pdf", blob: file, name, note: "" };
    }
    let text;
    try {
      if (isZip || isCfb) {
        if (file.size > 25 * 1024 * 1024) throw userErr("El documento pesa más de 25 MB.");
        const buf = await file.arrayBuffer();
        if (isZip) {
          const z = await zipEntries(buf), has = n => z.names.includes(n);
          if (has("word/document.xml")) text = await readDocx(z);
          else if (has("xl/workbook.xml")) text = await readXlsx(z);
          else if (has("ppt/presentation.xml") || z.names.some(n => /^ppt\/slides\//.test(n))) text = await readPptx(z);
          else if (has("content.xml")) text = await readOdf(z);
          else if (has("META-INF/container.xml")) text = await readEpub(z);
          else if (z.names.some(n => /^Index\/.*\.iwa$/.test(n) || n === "Index.zip")) throw userErr(`«${name}» es de Pages, Numbers o Keynote: ábrelo y usa Archivo › Exportar a › PDF o Word, y envía ese.`);
          else throw userErr(`No reconozco el contenido de «${name}». Envíalo como PDF o Word.`);
        } else {
          const c = cfb(buf);
          if (!c) throw userErr(`«${name}» está dañado.`);
          if (c.has("EncryptedPackage") || c.has("EncryptionInfo")) throw locked();
          if (c.has("WordDocument")) text = readDoc(c);
          else if (c.has("Workbook") || c.has("Book")) text = readXls(c);
          else if (c.has("PowerPoint Document")) text = readPpt(c);
          else throw userErr(`No reconozco el contenido de «${name}». Envíalo como PDF o Word.`);
        }
      } else if (isRtf) {
        if (file.size > 25 * 1024 * 1024) throw userErr("El documento pesa más de 25 MB.");
        text = rtfToText(await readText(file));
      } else {
        // ¿Es texto? (pocos caracteres de control)
        const ctrl = [...head].filter(b => b < 9 || (b > 13 && b < 32)).length;
        if (!(TEXT_EXT.test(name) || /^text\//.test(file.type) || file.type === "application/json") && ctrl > head.length * 0.02) {
          throw userErr(`No puedo leer «${name}». Envíalo como PDF, Word, Excel, PowerPoint o texto.`);
        }
        if (file.size > 3 * 1024 * 1024) throw userErr("El archivo de texto pesa más de 3 MB.");
        text = await readText(file);
        // .doc/.xls que en verdad son páginas web
        if (!/^html?$/.test(ext) && /^\s*(<!doctype html|<html|<\?xml[^>]*>\s*<html|<table|<body)/i.test(text.slice(0, 600))) text = htmlToText(text);
      }
    } catch (err) {
      if (err && err.message === "PROTEGIDO") throw locked();
      if (err && err.user) throw err;
      throw userErr(`No pude leer «${name}» (puede estar dañado). Prueba guardándolo como PDF.`);
    }
    text = String(text || "").replace(/\u0000/g, "");
    if (!text.trim()) throw userErr(`«${name}» no tiene texto que leer (si es escaneado, envíalo como PDF o foto).`);
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

  window.MangoFiles = { readDocument, videoFrames, build, info, safeName, VIDEO_MAX_BYTES, _test: { docx, xlsx, pdf, parseCsv, zipEntries, rtfToText } };
})();
