// Manguito Pro — Markdown seguro para las respuestas (lo usan el chat y la
// página de chats compartidos). TODO se escapa antes de dar formato: lo que
// escriba el cliente o la IA nunca se vuelve HTML ni código ejecutable.
(function () {
  "use strict";
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ── Markdown seguro (todo se escapa antes de dar formato) ──
  function inline(s) {
    return s.split(/(`[^`\n]+`)/g).map(part => {
      if (/^`[^`\n]+`$/.test(part)) return "<code>" + part.slice(1, -1) + "</code>";
      return part
        .replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[\s(¿¡])\*([^*\n]+?)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>")
        .replace(/(^|[\s(])_([^_\n]+?)_(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>")
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    }).join("");
  }
  const isFence = l => /^\s*```/.test(l);
  const isUl = l => /^\s*[-*+]\s+/.test(l);
  const isOl = l => /^\s*\d+[.)]\s+/.test(l);
  const isTableRow = l => /^\s*\|.*\|\s*$/.test(l);
  const isTableSep = l => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const isBlockStart = l => isFence(l) || isUl(l) || isOl(l) || /^#{1,4}\s/.test(l) || /^>\s?/.test(l) || isTableRow(l);
  const cells = l => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => inline(esc(c.trim())));

  // Archivo para descargar (```archivo:nombre.ext): la tarjeta lleva el
  // contenido escapado; manguito-files.js arma el archivo al tocar «Descargar».
  function fileCard(rawName, content, closed) {
    const F = window.MangoFiles;
    const inf = F ? F.info(rawName) : { name: String(rawName).trim() || "archivo.txt", ext: "txt", label: "Archivo", tone: "txt" };
    const lines = content ? content.split("\n").length : 0;
    return '<div class="mg-file" data-name="' + esc(inf.name) + '">' +
      '<div class="mg-file-row"><span class="mg-file-ic t-' + esc(inf.tone) + '">' + esc(inf.ext.toUpperCase().slice(0, 4)) + "</span>" +
      '<span class="mg-file-info"><b>' + esc(inf.name) + "</b><small>" + esc(inf.label) + (closed ? " · " + lines + " línea" + (lines === 1 ? "" : "s") : " · escribiendo…") + "</small></span>" +
      '<button type="button" class="mg-file-dl" data-mg-dl' + (closed ? "" : " disabled") + ">" + (closed ? "Descargar" : "Creando…") + "</button></div>" +
      '<details class="mg-file-src"><summary>Ver contenido</summary><pre><code>' + esc(content) + "</code></pre></details></div>";
  }

  function md(src) {
    const lines = String(src || "").replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (isFence(line)) {
        const lang = line.replace(/^\s*```/, "").trim();
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        const closed = i < lines.length; // mientras escribe, el bloque aún no cierra
        i++;
        const file = lang.match(/^(?:archivo|file)\s*:\s*(.+)$/i);
        if (file) { out.push(fileCard(file[1], buf.join("\n"), closed)); continue; }
        out.push('<div class="mg-code"><div class="mg-code-head"><span>' + esc(lang || "código") +
          '</span><button type="button" data-copy-code>Copiar</button></div><pre><code>' + esc(buf.join("\n")) + "</code></pre></div>");
        continue;
      }
      if (!line.trim()) { i++; continue; }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { const n = h[1].length + 1; out.push(`<h${n}>${inline(esc(h[2]))}</h${n}>`); i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
      if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && isTableRow(lines[i])) { rows.push(cells(lines[i])); i++; }
        out.push('<div class="mg-table"><table><thead><tr>' + head.map(c => "<th>" + c + "</th>").join("") + "</tr></thead><tbody>" +
          rows.map(r => "<tr>" + r.map(c => "<td>" + c + "</td>").join("") + "</tr>").join("") + "</tbody></table></div>");
        continue;
      }
      if (isUl(line) || isOl(line)) {
        const ordered = isOl(line);
        const items = [];
        while (i < lines.length && (ordered ? isOl(lines[i]) : isUl(lines[i]))) {
          items.push(inline(esc(lines[i].replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/, ""))));
          i++;
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !isUl(lines[i]) && !isOl(lines[i])) {
            items[items.length - 1] += "<br>" + inline(esc(lines[i].trim())); i++;
          }
        }
        const tag = ordered ? "ol" : "ul";
        out.push(`<${tag}>` + items.map(t => "<li>" + t + "</li>").join("") + `</${tag}>`);
        continue;
      }
      if (/^>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(inline(esc(lines[i].replace(/^>\s?/, "")))); i++; }
        out.push("<blockquote>" + buf.join("<br>") + "</blockquote>");
        continue;
      }
      const buf = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) { buf.push(lines[i]); i++; }
      out.push("<p>" + buf.map(l => inline(esc(l))).join("<br>") + "</p>");
    }
    return out.join("");
  }

  window.MangoMD = { md, esc };
})();
