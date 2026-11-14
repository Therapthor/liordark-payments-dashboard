/* ═══════════════════════════════════════════════════════════════
   Configuración › Avisos — el admin arma la ventana con imagen que
   aparece al entrar a la tienda (liordark.com) y al panel de mayoristas
   (mayorista.liordark.com). «Vista previa» abre la misma ventana que
   ven los clientes (diseño de public-store/css/avisos.css).
   ═══════════════════════════════════════════════════════════════ */
(() => {
  "use strict";

  const TARGETS = {
    store: {
      icon: "🛍️", name: "Tienda", host: "liordark.com",
      who: "Lo ven todos los que entran a la tienda: visitantes nuevos y clientes con cuenta.",
      placeholder: "ej. ¡Llegó stock nuevo de Netflix!",
    },
    wholesale: {
      icon: "🤝", name: "Mayoristas", host: "mayorista.liordark.com",
      who: "Lo ven tus mayoristas al entrar a su panel.",
      placeholder: "ej. Nuevos precios mayoristas desde hoy",
    },
  };
  const TYPES = ["image/jpeg", "image/png", "image/webp"];

  let state = null;          // respuesta de GET /api/avisos
  const pending = {};        // imagen elegida y todavía no guardada, por sitio: { file, url }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  async function api(path, options = {}) {
    const res = await fetch("/api/avisos" + path, { credentials: "include", ...options });
    if (res.status === 401) { location.reload(); throw new Error("No autenticado"); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || "No se pudo conectar. Intenta de nuevo.");
    return data;
  }

  function fmtDate(iso) {
    if (!iso) return "";
    const [y, m, d] = iso.split("-");
    return `${d}/${m}/${y}`;
  }

  // ─── Estado (la etiqueta de arriba de cada aviso) ───

  function statusOf(a) {
    if (!a.imageUrl) return { cls: "off", text: "Sin imagen" };
    if (!a.active) return { cls: "off", text: "Apagado" };
    if (a.ended) return { cls: "ended", text: "Terminó el " + fmtDate(a.endsOn) };
    return { cls: "on", text: a.endsOn ? "Activo hasta el " + fmtDate(a.endsOn) : "Activo" };
  }

  // ─── Formulario de cada aviso ───

  function formHtml(t) {
    const cfg = TARGETS[t];
    const a = state.avisos[t];
    const st = statusOf(a);
    const productOpts = state.products.map(p =>
      `<option value="${p.id}"${a.productId === p.id ? " selected" : ""}>${esc(p.title)}${p.title !== p.platform ? " · " + esc(p.platform) : ""}</option>`).join("");
    const missingProduct = a.buttonType === "product" && !state.products.some(p => p.id === a.productId);
    const opt = (v, label) => `<option value="${v}"${a.buttonType === v ? " selected" : ""}>${label}</option>`;
    return `
      <form class="aviso-form" data-target="${t}" novalidate>
        <div class="aviso-form-head">
          <div>
            <h3>${cfg.icon} ${cfg.name} <small>${cfg.host}</small></h3>
            <p class="aviso-help">${cfg.who}</p>
          </div>
          <span class="aviso-status aviso-status--${st.cls}" data-role="status">${esc(st.text)}</span>
        </div>

        <div class="aviso-img-box" data-role="img-box">
          <div class="aviso-img-frame">${a.imageUrl
            ? `<img src="${esc(a.imageUrl)}" alt="Imagen del aviso" data-role="img">`
            : `<div class="aviso-img-empty" data-role="img">Todavía no hay imagen.<br>Súbela ya diseñada (el combo, el producto, el descuento…).</div>`}</div>
          <div class="aviso-img-side">
            <label class="btn-secondary aviso-img-btn">
              <input type="file" accept="image/jpeg,image/png,image/webp" data-role="file">
              <span data-role="file-label">${a.imageUrl ? "Cambiar imagen" : "Subir imagen"}</span>
            </label>
            <p class="aviso-help">JPG, PNG o WEBP · hasta ${INPUT_MAX_MB} MB. Se muestra completa, sin recortar; si es muy pesada la achicamos sola para que cargue rápido. Vertical o cuadrada se ve mejor en el celular.</p>
          </div>
        </div>

        <label class="aviso-switch">
          <input type="checkbox" name="active"${a.active ? " checked" : ""}>
          <span class="aviso-switch-ui" aria-hidden="true"></span>
          <span><b>Activo</b><small>Apagado no le aparece a nadie.</small></span>
        </label>

        <label class="aviso-field"><span>Texto debajo de la imagen <span class="aviso-opt">(opcional)</span></span>
          <input type="text" name="title" maxlength="140" value="${esc(a.title)}" placeholder="${esc(cfg.placeholder)}">
        </label>

        <label class="aviso-field">Botón
          <select name="buttonType">
            ${opt("none", "Sin botón (solo aviso)")}
            ${opt("product", "Ir a un producto")}
            ${t === "store" ? opt("combo", "Abrir «Arma tu combo»") : ""}
            ${opt("link", "Ir a un link")}
          </select>
        </label>
        <label class="aviso-field" data-show="product">Producto
          <select name="productId">
            ${missingProduct || !a.productId ? `<option value="">— Elige un producto —</option>` : ""}
            ${productOpts}
          </select>
        </label>
        <label class="aviso-field" data-show="link">Link
          <input type="url" name="linkUrl" maxlength="500" value="${esc(a.linkUrl)}" placeholder="https://…" inputmode="url" autocapitalize="off" spellcheck="false">
        </label>
        <label class="aviso-field" data-show="button">Texto del botón
          <input type="text" name="buttonText" maxlength="30" value="${esc(a.buttonText)}" placeholder="${esc(state.defaultButtonText)}">
        </label>

        <fieldset class="aviso-freq">
          <legend>¿Cada cuánto lo ve cada persona?</legend>
          <label><input type="radio" name="frequency" value="once"${a.frequency !== "daily" ? " checked" : ""}><span>Una sola vez por persona</span></label>
          <label><input type="radio" name="frequency" value="daily"${a.frequency === "daily" ? " checked" : ""}><span>Una vez al día</span></label>
        </fieldset>

        <div class="aviso-field">
          <label for="aviso-${t}-ends"><span>Mostrar hasta <span class="aviso-opt">(opcional)</span></span></label>
          <div class="aviso-date-row">
            <input type="date" id="aviso-${t}-ends" name="endsOn" value="${esc(a.endsOn)}" min="${esc(state.today)}">
            <button type="button" class="btn-secondary btn-sm" data-act="clear-date">Sin fecha</button>
          </div>
          <small class="aviso-help">Ese día es el último: desde el día siguiente deja de mostrarse solo.</small>
        </div>

        <div class="aviso-actions-row">
          <button type="button" class="btn-secondary" data-act="preview">👁️ Vista previa</button>
          <button type="submit" class="btn-primary" data-role="save">Guardar</button>
        </div>
        <p class="aviso-msg" data-role="msg" role="status" hidden></p>
      </form>`;
  }

  function syncVisibility(form) {
    const type = form.elements.buttonType.value;
    form.querySelector('[data-show="product"]').hidden = type !== "product";
    form.querySelector('[data-show="link"]').hidden = type !== "link";
    form.querySelector('[data-show="button"]').hidden = type === "none";
  }

  function showMsg(form, text, kind) {
    const el = form.querySelector('[data-role="msg"]');
    el.textContent = text;
    el.className = "aviso-msg" + (kind ? " aviso-msg--" + kind : "");
    el.hidden = !text;
  }

  function setPreviewImage(form, url) {
    const frame = form.querySelector(".aviso-img-frame");
    frame.innerHTML = `<img src="${esc(url)}" alt="Imagen del aviso" data-role="img">`;
    form.querySelector('[data-role="file-label"]').textContent = "Cambiar imagen";
  }

  // nginx corta los envíos de más de ~1 MB (por eso el Curso sube por
  // partes). Una imagen grande se achica acá antes de mandarla: lado
  // mayor 1600 px como mucho, misma proporción, sin recortar.
  const INPUT_MAX_MB = 15;
  const SEND_MAX = 900 * 1024;
  const MAX_SIDE = 1600;

  function decode(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("No se pudo abrir la imagen.")); };
      img.src = url;
    });
  }
  function toBlob(canvas, type, q) {
    return new Promise(resolve => canvas.toBlob(resolve, type, q));
  }
  async function optimize(file) {
    const img = await decode(file);
    const w = img.naturalWidth, h = img.naturalHeight;
    if (file.size <= SEND_MAX && Math.max(w, h) <= MAX_SIDE) return file;
    const base = file.name.replace(/\.[a-z0-9]+$/i, "") || "aviso";
    for (const side of [MAX_SIDE, 1280, 1080]) {
      const k = Math.min(1, side / Math.max(w, h));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(w * k);
      canvas.height = Math.round(h * k);
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      for (const q of [0.9, 0.82, 0.74]) {
        let blob = await toBlob(canvas, "image/webp", q);
        if (!blob || blob.type !== "image/webp") {
          // Safari no guarda WEBP: JPG con fondo blanco.
          const c2 = document.createElement("canvas");
          c2.width = canvas.width; c2.height = canvas.height;
          const x = c2.getContext("2d");
          x.fillStyle = "#fff"; x.fillRect(0, 0, c2.width, c2.height); x.drawImage(canvas, 0, 0);
          blob = await toBlob(c2, "image/jpeg", q);
        }
        if (blob && blob.size <= SEND_MAX) {
          return new File([blob], base + (blob.type === "image/webp" ? ".webp" : ".jpg"), { type: blob.type });
        }
      }
    }
    throw new Error("No pudimos achicar la imagen. Prueba guardándola en JPG.");
  }

  async function onFile(form, input) {
    const t = form.dataset.target;
    const file = input.files && input.files[0];
    input.value = "";
    if (!file) return;
    if (!TYPES.includes(file.type)) { showMsg(form, "Esa imagen no sirve: usa JPG, PNG o WEBP.", "error"); return; }
    if (file.size > INPUT_MAX_MB * 1024 * 1024) {
      showMsg(form, `La imagen pesa más de ${INPUT_MAX_MB} MB. Guárdala más liviana (por ejemplo en JPG) y vuelve a subirla.`, "error");
      return;
    }
    showMsg(form, "Preparando la imagen…", "info");
    let ready;
    try { ready = await optimize(file); } catch (err) { showMsg(form, err.message, "error"); return; }
    if (pending[t]) URL.revokeObjectURL(pending[t].url);
    pending[t] = { file: ready, url: URL.createObjectURL(ready) };
    setPreviewImage(form, pending[t].url);
    showMsg(form, "Imagen lista. Toca «Guardar» para publicarla.", "info");
  }

  function readForm(form) {
    const f = form.elements;
    return {
      active: f.active.checked,
      title: f.title.value.trim(),
      buttonType: f.buttonType.value,
      productId: f.productId.value,
      linkUrl: f.linkUrl.value.trim(),
      buttonText: f.buttonText.value.trim(),
      frequency: f.frequency.value === "daily" ? "daily" : "once",
      endsOn: f.endsOn.value,
    };
  }

  function checkForm(v) {
    if (v.buttonType === "product" && !v.productId) return "Elige el producto al que lleva el botón.";
    if (v.buttonType === "link") {
      try {
        const u = new URL(v.linkUrl);
        if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
      } catch { return "El link debe empezar con https:// (o http://)."; }
    }
    return "";
  }

  async function save(form) {
    const t = form.dataset.target;
    const v = readForm(form);
    const problem = checkForm(v);
    if (problem) { showMsg(form, problem, "error"); return; }
    const fd = new FormData();
    Object.entries(v).forEach(([k, val]) => fd.append(k, typeof val === "boolean" ? (val ? "1" : "0") : val));
    if (pending[t]) fd.append("image", pending[t].file);
    const btn = form.querySelector('[data-role="save"]');
    btn.disabled = true;
    btn.textContent = "Guardando…";
    try {
      const r = await api("/" + t, { method: "PUT", body: fd });
      if (pending[t]) { URL.revokeObjectURL(pending[t].url); delete pending[t]; }
      state.avisos[t] = r.aviso;
      rerender(t);
      const f2 = document.querySelector(`.aviso-form[data-target="${t}"]`);
      const a = r.aviso;
      const tail = !a.active ? " Está apagado: no le aparece a nadie."
        : r.isNew ? " Es un aviso nuevo: lo verán todos, también quienes vieron el anterior." : "";
      showMsg(f2, "✅ Guardado." + tail, "ok");
    } catch (err) {
      showMsg(form, err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Guardar";
    }
  }

  // ─── Vista previa: la misma ventana que ven los clientes ───

  function previewData(form) {
    const t = form.dataset.target;
    const v = readForm(form);
    const img = form.querySelector('img[data-role="img"]');
    const text = v.buttonText || state.defaultButtonText;
    let button = null;
    if (v.buttonType === "product" && v.productId) {
      const p = state.products.find(x => String(x.id) === String(v.productId));
      if (p) button = { type: "product", text, label: "abre el producto «" + p.title + "»" };
    } else if (v.buttonType === "combo" && t === "store") {
      button = { type: "combo", text, label: "abre «Arma tu combo»" };
    } else if (v.buttonType === "link" && v.linkUrl) {
      button = { type: "link", text, label: "abre " + v.linkUrl };
    }
    return {
      imageUrl: img ? img.getAttribute("src") : "",
      imageW: img ? img.naturalWidth : 0, imageH: img ? img.naturalHeight : 0,
      title: v.title, button,
    };
  }

  function openPopup(a, onAction) {
    const prevFocus = document.activeElement;
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const wrap = document.createElement("div");
    wrap.className = "aviso-backdrop";
    wrap.setAttribute("data-aviso", "");
    const size = a.imageW && a.imageH ? ` width="${a.imageW}" height="${a.imageH}"` : "";
    wrap.innerHTML = `
      <div class="aviso-card" role="dialog" aria-modal="true" aria-label="${esc(a.title || "Aviso")}" tabindex="-1">
        <button class="aviso-x" type="button" aria-label="Cerrar">✕</button>
        <div class="aviso-media"><img src="${esc(a.imageUrl)}" alt="${esc(a.title || "Promoción")}"${size}></div>
        ${a.title ? `<p class="aviso-title">${esc(a.title)}</p>` : ""}
        <div class="aviso-actions">
          ${a.button ? `<button class="aviso-cta" type="button">${esc(a.button.text)}</button>` : ""}
          <button class="aviso-close-text" type="button">Cerrar</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    document.documentElement.classList.add("aviso-lock");
    try { wrap.querySelector(".aviso-card").focus({ preventScroll: true }); } catch { /* nada */ }
    let closed = false;
    function close(after) {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKey);
      wrap.classList.add("is-closing");
      setTimeout(() => {
        wrap.remove();
        if (!document.querySelector("[data-aviso]")) document.documentElement.classList.remove("aviso-lock");
        if (prevFocus && prevFocus.focus) { try { prevFocus.focus({ preventScroll: true }); } catch { /* nada */ } }
        if (after) after();
      }, reduce ? 130 : 270);
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap || e.target.closest(".aviso-x, .aviso-close-text")) close();
      else if (e.target.closest(".aviso-cta")) close(() => onAction && onAction(a.button));
    });
  }

  function preview(form) {
    const a = previewData(form);
    if (!a.imageUrl) { showMsg(form, "Primero sube la imagen para ver la vista previa.", "error"); return; }
    if (form.elements.buttonType.value === "link" && checkForm(readForm(form))) {
      showMsg(form, checkForm(readForm(form)), "error");
      return;
    }
    openPopup(a, (btn) => showMsg(form, "Vista previa: para tus clientes, este botón " + btn.label + ".", "info"));
  }

  // ─── Pintar ───

  function rerender(t) {
    const old = document.querySelector(`.aviso-form[data-target="${t}"]`);
    if (!old) return;
    old.outerHTML = formHtml(t);
    const form = document.querySelector(`.aviso-form[data-target="${t}"]`);
    syncVisibility(form);
    if (pending[t]) setPreviewImage(form, pending[t].url);
  }

  function render() {
    const grid = document.getElementById("avisos-grid");
    grid.innerHTML = formHtml("store") + formHtml("wholesale");
    grid.querySelectorAll(".aviso-form").forEach(syncVisibility);
  }

  function initEvents() {
    const grid = document.getElementById("avisos-grid");
    if (!grid || grid.dataset.wired) return;
    grid.dataset.wired = "1";
    grid.addEventListener("change", (e) => {
      const form = e.target.closest(".aviso-form");
      if (!form) return;
      if (e.target.matches('[data-role="file"]')) onFile(form, e.target);
      if (e.target.name === "buttonType") { syncVisibility(form); showMsg(form, ""); }
    });
    grid.addEventListener("click", (e) => {
      const form = e.target.closest(".aviso-form");
      const act = e.target.closest("[data-act]");
      if (!form || !act) return;
      if (act.dataset.act === "preview") preview(form);
      if (act.dataset.act === "clear-date") form.elements.endsOn.value = "";
    });
    grid.addEventListener("submit", (e) => {
      const form = e.target.closest(".aviso-form");
      if (!form) return;
      e.preventDefault();
      save(form);
    });
  }

  async function load() {
    initEvents();
    // En el celular la barra de secciones se desliza: que se vea «Avisos».
    const tab = document.querySelector('.config-subnav-item[data-config-section="avisos"]');
    const bar = tab && tab.parentElement;
    if (bar && bar.scrollWidth > bar.clientWidth) bar.scrollLeft += tab.getBoundingClientRect().left - bar.getBoundingClientRect().left - (bar.clientWidth - tab.offsetWidth) / 2;
    const grid = document.getElementById("avisos-grid");
    // Si hay una imagen elegida sin guardar, no se pisa lo que está editando.
    if (state && Object.keys(pending).length) return;
    try {
      state = await api("");
      render();
    } catch (err) {
      grid.innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
    }
  }

  window.LiordarkAvisos = { load };
})();
