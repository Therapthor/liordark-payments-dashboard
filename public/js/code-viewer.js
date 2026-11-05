// Visor de códigos (panel): el correo tal cual llegó + link temporal para el cliente.
window.LiordarkCodeViewer = (() => {
  "use strict";

  let current = null;     // { id, platform, email }
  let lastValue = "";
  let share = null;       // { token, minutes }
  let shareTimer = null;

  const $ = id => document.getElementById(id);

  async function api(path, options = {}) {
    const res = await fetch("/api/code-viewer" + path, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    if (res.status === 401) { location.reload(); throw new Error("No autenticado"); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || "Error de red");
    return data;
  }

  function agoText(iso) {
    const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (min < 1) return "hace segundos";
    if (min < 60) return "hace " + min + " min";
    const h = Math.floor(min / 60);
    return h < 24 ? "hace " + h + " h" : "hace " + Math.floor(h / 24) + " d";
  }

  function setEmpty(html) {
    $("cv-mail").hidden = true;
    $("cv-empty").hidden = false;
    $("cv-empty").innerHTML = html;
  }

  async function refresh() {
    if (!current) return;
    const btn = $("cv-refresh");
    btn.disabled = true; btn.textContent = "Consultando…";
    try {
      const d = await api("/" + current.id + "/fetch", { method: "POST", body: "{}" });
      $("cv-share").hidden = !!d.totp;
      if (d.totp) {
        $("cv-meta").textContent = d.sourceLabel + " · cambia cada 30 s";
        lastValue = d.totp.code;
        $("cv-copy").hidden = false;
        $("cv-copy").textContent = "Copiar código " + d.totp.code;
        setEmpty(`<span class="cv-big">${d.totp.code}</span><span>Código 2FA (se renueva solo)</span>`);
        return;
      }
      const when = d.receivedAtIso
        ? ` · llegó a las <b style="color:#FFFAF3">${d.receivedAtLima}</b> (${agoText(d.receivedAtIso)})`
        : (d.receivedAt ? " · " + d.receivedAt : "");
      $("cv-meta").innerHTML = escapeHtml(d.sourceLabel) + when + (d.subject ? " · " + escapeHtml(d.subject) : "");
      lastValue = d.found && d.value ? d.value : "";
      const isLink = d.kind === "link";
      $("cv-copy").hidden = !lastValue;
      $("cv-copy").textContent = isLink ? "Copiar enlace" : "Copiar código " + lastValue;
      if (d.html) {
        $("cv-empty").hidden = true;
        const frame = $("cv-mail");
        frame.hidden = false;
        frame.srcdoc = d.html;
      } else if (lastValue) {
        setEmpty(`<span class="cv-big">${escapeHtml(isLink ? "Enlace" : lastValue)}</span><span>Este proveedor no muestra el correo completo.</span>`);
      } else {
        setEmpty("<b>Todavía no llegó ningún correo para esta cuenta.</b><span>Pide el código y toca Actualizar.</span>");
      }
    } catch (err) {
      setEmpty("<b>No se pudo consultar.</b><span>" + escapeHtml(err.message) + "</span>");
    } finally {
      btn.disabled = false; btn.textContent = "Actualizar";
    }
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function open(account) {
    current = account;
    lastValue = "";
    $("cv-email").textContent = account.email;
    $("cv-meta").textContent = account.platform;
    $("cv-copy").hidden = true;
    setEmpty("Cargando…");
    $("cv-drawer-back").hidden = false;
    refresh();
  }

  function close() {
    $("cv-drawer-back").hidden = true;
    $("cv-mail").srcdoc = "";
    current = null;
  }

  // ─── Compartir link ───

  async function makeLink(minutes) {
    $("cv-share-url").textContent = "Generando…";
    $("cv-share-status").textContent = "Abierto por el cliente: aún no";
    $("cv-share-status").classList.remove("on");
    document.querySelectorAll(".cv-pill").forEach(p => p.classList.toggle("active", Number(p.dataset.min) === minutes));
    try {
      const d = await api("/" + current.id + "/link", { method: "POST", body: JSON.stringify({ minutes }) });
      share = { token: d.token, minutes, url: d.url };
      $("cv-share-url").textContent = d.url.replace(/^https:\/\//, "");
      const slow = /disney/i.test(current.platform);
      const text = `Hola 👋 Aquí puedes ver tu código de ${current.platform} (vence en ${minutes} minutos):\n${d.url}` +
        (slow ? "\n\n⏳ El correo de Disney+ puede tardar hasta 4 minutos. Pide el código una sola vez y espera en la página: se actualiza sola." : "");
      $("cv-share-wa").href = "https://api.whatsapp.com/send?text=" + encodeURIComponent(text);
      pollShare();
    } catch (err) {
      $("cv-share-url").textContent = err.message;
    }
  }

  async function pollShare() {
    clearTimeout(shareTimer);
    if (!share || $("cv-share-back").hidden) return;
    try {
      const s = await api("/link/" + share.token);
      const el = $("cv-share-status");
      const t = iso => new Date(iso).toLocaleTimeString("es-PE", { timeZone: "America/Lima", hour: "numeric", minute: "2-digit" });
      if (s.closedAt) { el.textContent = "El cliente ya ingresó y cerró el link ✓ (" + t(s.closedAt) + ")"; el.classList.add("on"); return; }
      if (s.state === "expired") { el.textContent = "El link venció" + (s.openedAt ? " (lo abrió a las " + t(s.openedAt) + ")" : " sin abrirse"); el.classList.remove("on"); return; }
      if (s.openedAt) { el.textContent = "Abierto por el cliente a las " + t(s.openedAt); el.classList.add("on"); }
    } catch { /* se reintenta */ }
    shareTimer = setTimeout(pollShare, 4000);
  }

  function openShare() {
    if (!current) return;
    $("cv-share-sub").textContent = current.platform + " · " + current.email;
    $("cv-share-back").hidden = false;
    // Disney+ tarda hasta ~4 min en mandar el correo: 10 min por defecto.
    makeLink(/disney/i.test(current.platform) ? 10 : 5);
  }

  function closeShare() {
    $("cv-share-back").hidden = true;
    clearTimeout(shareTimer);
    share = null;
  }

  async function copy(text, btn) {
    try { await navigator.clipboard.writeText(text); } catch { return; }
    const old = btn.textContent;
    btn.textContent = "✓ Copiado";
    setTimeout(() => { btn.textContent = old; }, 1200);
  }

  function init() {
    $("cv-close").addEventListener("click", close);
    $("cv-drawer-back").addEventListener("click", e => { if (e.target.id === "cv-drawer-back") close(); });
    $("cv-refresh").addEventListener("click", refresh);
    $("cv-copy").addEventListener("click", e => { if (lastValue) copy(lastValue, e.currentTarget); });
    $("cv-share").addEventListener("click", openShare);
    $("cv-share-close").addEventListener("click", closeShare);
    $("cv-share-back").addEventListener("click", e => { if (e.target.id === "cv-share-back") closeShare(); });
    $("cv-share-copy").addEventListener("click", e => { if (share) copy(share.url, e.currentTarget); });
    document.querySelectorAll(".cv-pill").forEach(p => p.addEventListener("click", () => makeLink(Number(p.dataset.min))));
    document.addEventListener("keydown", e => {
      if (e.key !== "Escape") return;
      if (!$("cv-share-back").hidden) closeShare();
      else if (!$("cv-drawer-back").hidden) close();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
  return { open };
})();
