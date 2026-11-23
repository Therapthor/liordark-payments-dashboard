(() => {
  "use strict";

  // ─────────────────────────────────────────────────────────────
  // CONFIGURACIÓN › 💾 COPIAS — llave pública, Google Drive (Apps Script)
  // y estado de las copias. Ver services/backup.service.ts.
  // ─────────────────────────────────────────────────────────────

  const $ = id => document.getElementById(id);
  let data = null;
  let poll = null;

  async function api(path, options) {
    const res = await fetch("/api/backup" + path, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) { location.reload(); throw new Error("No autenticado"); }
    if (!res.ok) throw new Error(body?.message || "Error de red");
    return body;
  }

  function esc(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function when(sql) {
    if (!sql) return "—";
    const d = new Date(String(sql).replace(" ", "T") + "Z");
    return d.toLocaleString("es-PE", { timeZone: "America/Lima", dateStyle: "medium", timeStyle: "short" });
  }
  function mb(n) { return n == null ? "—" : n < 1048576 ? Math.max(1, Math.round(n / 1024)) + " KB" : (n / 1048576).toFixed(1) + " MB"; }

  function showMsg(id, text, ok) {
    const el = $(id);
    el.hidden = !text;
    el.textContent = text || "";
    el.style.color = ok ? "var(--mp-ok, #1f8a4c)" : "";
  }

  function render() {
    const d = data;
    const lastOk = d.runs.find(r => r.kind === "datos" && r.ok);
    const ready = !!d.recipient;
    let head;
    if (!ready) head = `<p class="bk-state warn">⚠️ Todavía no hay copias: falta tu llave pública (paso 1).</p>`;
    else if (!lastOk) head = `<p class="bk-state warn">Aún no se hizo ninguna copia. Toca «Hacer copia ahora» para la primera.</p>`;
    else {
      const ageH = (Date.now() - new Date(String(lastOk.finishedAt).replace(" ", "T") + "Z").getTime()) / 3600e3;
      head = `<p class="bk-state ${ageH > 30 ? "warn" : "ok"}">${ageH > 30 ? "⚠️" : "✅"} Última copia: <b>${esc(when(lastOk.finishedAt))}</b> · ${mb(lastOk.sizeBytes)} · ${
        lastOk.drive === "ok" ? "en Google Drive y en el servidor" : lastOk.drive === "error" ? "⚠️ solo en el servidor (Drive falló)" : "solo en el servidor (falta conectar Drive)"}</p>`;
    }
    if (d.running) head += `<p class="bk-state">⏳ Haciendo una copia…</p>`;
    // Sin finishedAt = todavía se está haciendo (no es un fallo).
    const rows = d.runs.map(r => {
      const busy = !r.finishedAt;
      return `
      <li class="bk-run ${r.ok || busy ? "" : "bad"}">
        <span class="bk-run-when">${esc(when(r.startedAt))}</span>
        <span>${r.kind === "media" ? "🎬 Videos" : "🗄 Datos"}${r.contents && r.contents.includes("código") ? " + 💻 código" : ""}${r.trigger === "manual" ? " · a mano" : ""}</span>
        <span>${busy ? "⏳ en curso…" : r.ok ? mb(r.sizeBytes) : "❌ " + esc(r.error || "falló")}</span>
        <span>${busy || !r.ok ? "" : r.drive === "ok" ? "☁️ Drive" : r.drive === "error" ? "⚠️ " + esc(r.error || "Drive falló") : "💻 solo servidor"}</span>
      </li>`;
    }).join("");
    $("bk-status").innerHTML = head + (rows ? `<ul class="bk-runs">${rows}</ul>` : "") +
      (d.local.length ? `<p class="panel-hint">En el servidor (${esc(d.localDir)}): ${d.local.length} copia(s).</p>` : "");
    $("bk-run").disabled = !ready || d.running;
    if (document.activeElement !== $("bk-recipient")) $("bk-recipient").value = d.recipient || "";
    if (document.activeElement !== $("bk-drive-url")) $("bk-drive-url").value = d.driveUrl || "";
    $("bk-code").value = d.appsScript;
  }

  async function load() {
    try {
      data = await api("/");
      render();
      clearTimeout(poll);
      if (data.running) poll = setTimeout(load, 3000);
    } catch (err) {
      $("bk-status").innerHTML = `<p class="bk-state warn">No se pudo cargar: ${esc(err.message)}</p>`;
    }
  }

  async function copy(text, btn) {
    try { await navigator.clipboard.writeText(text); } catch { window.prompt("Copia:", text); return; }
    const prev = btn.textContent;
    btn.textContent = "Copiado ✓";
    setTimeout(() => { btn.textContent = prev; }, 1500);
  }

  function init() {
    $("bk-recipient-save").addEventListener("click", async () => {
      try {
        await api("/config", { method: "PUT", body: JSON.stringify({ recipient: $("bk-recipient").value }) });
        showMsg("bk-recipient-msg", "✅ Llave pública guardada.", true);
        load();
      } catch (err) { showMsg("bk-recipient-msg", err.message); }
    });
    $("bk-drive-save").addEventListener("click", async () => {
      const btn = $("bk-drive-save");
      btn.disabled = true;
      try {
        await api("/config", { method: "PUT", body: JSON.stringify({ driveUrl: $("bk-drive-url").value }) });
        if (!$("bk-drive-url").value.trim()) { showMsg("bk-drive-msg", "Drive desconectado.", true); return load(); }
        showMsg("bk-drive-msg", "Probando…", true);
        const r = await api("/test-drive", { method: "POST" });
        showMsg("bk-drive-msg", `✅ Conectado: las copias irán a la carpeta «${r.folder}» de tu Drive.`, true);
        load();
      } catch (err) { showMsg("bk-drive-msg", err.message); }
      finally { btn.disabled = false; }
    });
    $("bk-copy-code").addEventListener("click", e => copy(data ? data.appsScript : "", e.currentTarget));
    $("bk-rotate").addEventListener("click", async () => {
      if (!confirm("Se crea una clave nueva: tendrás que volver a copiar el código en tu Apps Script e implementarlo de nuevo. ¿Seguir?")) return;
      try { await api("/token/rotate", { method: "POST" }); await load(); showMsg("bk-drive-msg", "Clave cambiada: copia el código otra vez y vuelve a implementarlo.", true); }
      catch (err) { showMsg("bk-drive-msg", err.message); }
    });
    $("bk-run").addEventListener("click", async () => {
      try { await api("/run", { method: "POST" }); await load(); }
      catch (err) { alert(err.message); }
    });
  }

  document.addEventListener("DOMContentLoaded", () => { if ($("config-section-backup")) init(); });
  window.LiordarkBackup = { load };
})();
