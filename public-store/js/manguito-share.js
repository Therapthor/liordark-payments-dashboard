// Manguito Pro — página de un chat compartido (liordark.com/manguito/s/<token>).
// Cualquiera puede leerlo (si tiene contraseña, primero la pide). Para
// continuar la conversación hace falta cuenta y Manguito Pro: se copia a un
// chat nuevo del visitante. Todo el texto pasa por MangoMD (escapado).
(function () {
  "use strict";
  const { md, esc } = window.MangoMD;
  const $ = id => document.getElementById(id);
  const token = (location.pathname.match(/^\/manguito\/s\/([A-Za-z0-9_-]{22})\/?$/) || [])[1] || "";
  let password = "";

  async function api(url, opts) {
    const res = await fetch(url, { credentials: "include", cache: "no-store", ...(opts || {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.message || "Algo falló. Intenta de nuevo."); e.status = res.status; throw e; }
    return data;
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $("mg-toast");
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast("✓ Copiado"); } catch { toast("No se pudo copiar"); }
  }

  const COPY_IC = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
  const dateLabel = s => new Date(String(s || "").replace(" ", "T") + "Z").toLocaleDateString("es-PE", { day: "numeric", month: "long", year: "numeric" });

  function render(data) {
    document.title = (data.title || "Chat compartido") + " · Manguito Pro";
    const msgs = (data.messages || []).map((m, i) => m.role === "user"
      ? `<div class="mg-msg user" data-i="${i}">${m.images ? `<div class="mg-msg-imgs"><span class="mg-img-gone">📎 ${m.images} adjunto(s) (no se comparten)</span></div>` : ""}<div class="mg-bubble">${esc(m.text)}</div></div>`
      : `<div class="mg-msg assistant" data-i="${i}"><div class="mg-who"><img src="/assets/manguito-pro.svg" alt=""><b>Manguito</b>${m.label ? `<span class="mg-tier">${esc(m.label)}</span>` : ""}</div>` +
        `<div class="mg-answer">${md(m.text)}</div><div class="mg-meta"><button class="mg-act" type="button" data-copy>${COPY_IC}Copiar</button></div></div>`
    ).join("");
    $("sh-main").innerHTML = `<div class="mg-shared-head"><h1>${esc(data.title || "Chat compartido")}</h1>` +
      `<p>Compartido el ${esc(dateLabel(data.createdAt))} · solo lectura</p></div><div>${msgs}</div>`;
    $("sh-main")._msgs = data.messages || [];
    setupCta();
  }

  $("sh-main").addEventListener("click", e => {
    const code = e.target.closest("[data-copy-code]");
    if (code) { copyText(code.closest(".mg-code").querySelector("pre").textContent); return; }
    const b = e.target.closest("[data-copy]");
    if (b) { const i = Number(b.closest(".mg-msg").dataset.i); copyText((($("sh-main")._msgs || [])[i] || {}).text || ""); }
  });

  function showLock(error) {
    $("sh-main").innerHTML = `<div class="mg-lock"><div class="big">🔒</div><h1 class="mg-shared-head-title">Chat protegido</h1>
      <p class="mg-muted">Quien te compartió este chat le puso contraseña. Escríbela para verlo.</p>
      <form id="sh-form" autocomplete="off"><input class="mg-input" id="sh-pass" type="password" placeholder="Contraseña" maxlength="64" required autofocus>
      <button class="mg-btn-solid" type="submit">Ver chat</button><p class="mg-err" id="sh-err">${esc(error || "")}</p></form></div>`;
    $("sh-form").addEventListener("submit", async e => {
      e.preventDefault();
      const pass = $("sh-pass").value;
      try {
        const data = await api("/api/store/ai-public/share/" + token + "/unlock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pass }) });
        password = pass;
        render(data);
      } catch (err) { $("sh-err").textContent = err.message; }
    });
  }

  // Abajo: continuar la conversación (con cuenta) o crear cuenta.
  async function setupCta() {
    let access = null;
    try { access = await api("/api/store/ai/access"); } catch { access = null; }
    const cta = $("sh-cta"), text = $("sh-cta-text"), btn = $("sh-cta-btn");
    cta.hidden = false;
    if (!access) {
      text.textContent = "Estás viendo un chat de solo lectura. ¿Quieres continuarlo o hacer tus propias preguntas? Crea tu cuenta o inicia sesión.";
      btn.textContent = "Crear cuenta / Entrar";
      btn.onclick = () => {
        try { sessionStorage.setItem("mg_return", location.pathname.replace(/\/$/, "")); } catch { /* sin storage */ }
        location.assign("/#manguito");
      };
    } else if (!access.allowed) {
      text.textContent = "Para continuar esta conversación necesitas Manguito Pro.";
      btn.textContent = "Ver planes";
      btn.onclick = () => location.assign("/manguito/#planes");
    } else {
      text.textContent = "Se copiará a un chat nuevo tuyo para que sigas preguntando.";
      btn.textContent = "Continuar esta conversación";
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          const r = await api("/api/store/ai/shares/" + token + "/continue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
          location.assign("/manguito/#c=" + r.conversationId);
        } catch (err) { toast(err.message); btn.disabled = false; }
      };
    }
  }

  async function init() {
    if (!token) { $("sh-main").innerHTML = `<div class="mg-lock"><div class="big">🥭</div><h1>Link no válido</h1></div>`; return; }
    try {
      const data = await api("/api/store/ai-public/share/" + token);
      if (data.locked) showLock(""); else render(data);
    } catch (err) {
      $("sh-main").innerHTML = `<div class="mg-lock"><div class="big">🥭</div><h1>Este chat ya no existe</h1><p class="mg-muted">${esc(err.message)}</p><a class="mg-btn-solid" href="/manguito/">Ir a Manguito Pro</a></div>`;
    }
  }
  init();
})();
