// Visor de códigos (panel): el correo tal cual llegó + link temporal para el cliente.
window.LiordarkCodeViewer = (() => {
  "use strict";

  let current = null;     // { id, platform, email }
  // Si todavía no hay correo, se sigue buscando solo (cada 10 s, hasta 4
  // min): Pally y Disney+ tardan en recibirlo.
  const WAIT_MS = 4 * 60 * 1000;
  const POLL_MS = 10 * 1000;
  let waitStart = 0, waitTimer = null, tickTimer = null;
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

  function themeFor(platform) {
    return /netflix/i.test(platform) ? "t-netflix"
      : /disney/i.test(platform) ? "t-disney"
      : /prime|amazon/i.test(platform) ? "t-prime"
      : /crunchy/i.test(platform) ? "t-crunchy"
      : /chatgpt|gpt|openai/i.test(platform) ? "t-chatgpt" : "";
  }

  // Tarjeta con el código (colores de la plataforma) y el correo debajo,
  // plegado, para quien quiera verlo completo.
  function showCard(code, meta, isLink, hasMail) {
    const card = $("cv-card");
    card.className = "cv-card " + themeFor(current ? current.platform : "");
    card.hidden = false;
    $("cv-card-meta").textContent = meta;
    const el = $("cv-card-code");
    el.textContent = isLink ? "Enlace de acceso" : code;
    el.classList.toggle("long", isLink || String(code).length > 4);
    $("cv-card-copy").textContent = isLink ? "Copiar enlace" : "Copiar";
    $("cv-card-toggle").hidden = !hasMail;
    $("cv-card-toggle").textContent = "Ver correo completo";
    $("cv-empty").hidden = true;
    $("cv-mail").hidden = true;
  }

  function setEmpty(html) {
    $("cv-card").hidden = true;
    $("cv-mail").hidden = true;
    $("cv-empty").hidden = false;
    $("cv-empty").innerHTML = html;
  }

  function stopWaiting() {
    clearTimeout(waitTimer); clearInterval(tickTimer);
    waitTimer = null; tickTimer = null; waitStart = 0;
  }

  function renderWaiting() {
    const left = Math.max(0, WAIT_MS - (Date.now() - waitStart));
    const elapsed = Math.floor((Date.now() - waitStart) / 1000);
    const fmt = s => Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    setEmpty(`<span class="cv-spin"></span><b>Esperando el correo…</b>` +
      `<span>${fmt(elapsed)} de 4:00 · se revisa solo cada 10 segundos</span>`);
    if (left <= 0) {
      stopWaiting();
      setEmpty("<b>No llegó ningún correo en 4 minutos.</b><span>Revisa que el código se haya pedido y toca Actualizar.</span>");
    }
  }

  function startWaiting() {
    if (!waitStart) waitStart = Date.now();
    renderWaiting();
    clearInterval(tickTimer);
    tickTimer = setInterval(renderWaiting, 1000);
    clearTimeout(waitTimer);
    waitTimer = setTimeout(() => refresh(true), POLL_MS);
  }

  async function refresh(auto = false) {
    if (!current) return;
    if (!auto) stopWaiting();
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
      if (d.html) $("cv-mail").srcdoc = d.html;
      if (lastValue) {
        const meta = current.platform + (d.receivedAtLima ? " · llegó a las " + d.receivedAtLima : "");
        showCard(lastValue, meta, isLink, !!d.html);
      } else if (d.html) {
        // Llegó un correo pero sin código reconocible: se muestra tal cual.
        $("cv-card").hidden = true;
        $("cv-empty").hidden = true;
        $("cv-mail").hidden = false;
      } else if (waitStart && Date.now() - waitStart >= WAIT_MS) {
        renderWaiting();
      } else {
        startWaiting();
        return;
      }
      stopWaiting();
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
    stopWaiting();
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
    $("cv-refresh").addEventListener("click", () => refresh(false));
    $("cv-card-copy").addEventListener("click", e => { if (lastValue) copy(lastValue, e.currentTarget); });
    $("cv-card-toggle").addEventListener("click", e => {
      const frame = $("cv-mail");
      frame.hidden = !frame.hidden;
      e.currentTarget.textContent = frame.hidden ? "Ver correo completo" : "Ocultar correo";
    });
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
