/* ═══════════════════════════════════════════════════════════════
   Configuración › Reseñas — el dueño revisa las reseñas que dejan
   los clientes (pendientes → publicar u ocultar) y copia reseñas reales
   que le mandaron por otro lado. Solo las «publicada» salen en la tienda.
   ═══════════════════════════════════════════════════════════════ */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  async function api(path, options = {}) {
    const res = await fetch("/api/reviews" + path, {
      credentials: "include",
      headers: options.body ? { "Content-Type": "application/json" } : {},
      ...options,
    });
    if (res.status === 401) { location.reload(); throw new Error("No autenticado"); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || "No se pudo conectar. Intenta de nuevo.");
    return data;
  }

  const STATUS = {
    pendiente: { cls: "pend", text: "Pendiente" },
    publicada: { cls: "on", text: "Publicada" },
    oculta: { cls: "off", text: "Oculta" },
  };

  function fmtDate(sqlite) {
    const d = new Date(String(sqlite || "").replace(" ", "T") + "Z");
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("es-PE", { day: "numeric", month: "short", timeZone: "America/Lima" });
  }

  function stars(n) { return "★".repeat(n) + "<span>" + "★".repeat(5 - n) + "</span>"; }

  function rowHtml(r) {
    const st = STATUS[r.status] || STATUS.pendiente;
    const acts = [];
    if (r.status !== "publicada") acts.push(`<button class="btn-primary btn-sm" data-act="publicada">Publicar</button>`);
    if (r.status !== "oculta") acts.push(`<button class="btn-secondary btn-sm" data-act="oculta">Ocultar</button>`);
    acts.push(`<button class="rvw-del" data-act="delete" title="Borrar" aria-label="Borrar">🗑</button>`);
    return `<div class="rvw-item rvw-${st.cls}" data-id="${r.id}">
      <div class="rvw-item-top">
        <span class="rvw-stars">${stars(r.stars)}</span>
        <span class="rvw-chip rvw-chip-${st.cls}">${st.text}</span>
      </div>
      <p class="rvw-body">${esc(r.body)}</p>
      <div class="rvw-meta"><b>${esc(r.author)}</b> · ${r.source === "cliente" ? "Cliente de la tienda (compra verificada)" : "Copiada por ti"} · ${fmtDate(r.createdAt)}</div>
      <div class="rvw-acts">${acts.join("")}</div>
    </div>`;
  }

  function setBadge(n) {
    const b = $("reviews-pending-badge");
    if (!b) return;
    b.textContent = String(n);
    b.hidden = !n;
  }

  // Interruptores: qué muestra la tienda (apagados por defecto).
  function paintSwitches(sec) {
    [["rvw-sw-reviews", sec && sec.reviewsEnabled], ["rvw-sw-faq", sec && sec.faqEnabled]].forEach(([id, on]) => {
      const el = $(id);
      if (!el) return;
      el.setAttribute("aria-checked", String(!!on));
      el.disabled = false;
    });
  }
  [["rvw-sw-reviews", "reviewsEnabled"], ["rvw-sw-faq", "faqEnabled"]].forEach(([id, key]) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("click", async () => {
      const next = el.getAttribute("aria-checked") !== "true";
      el.setAttribute("aria-checked", String(next));
      el.disabled = true;
      try {
        const r = await api("/sections", { method: "PUT", body: JSON.stringify({ [key]: next }) });
        if (data) data.sections = r.sections;
        paintSwitches(r.sections);
      } catch (err) {
        el.setAttribute("aria-checked", String(!next));
        el.disabled = false;
        alert(err.message);
      }
    });
  });

  let data = null;
  function render() {
    setBadge(data.pending);
    paintSwitches(data.sections);
    const list = $("rvw-list");
    if (!data.reviews.length) {
      list.innerHTML = `<p class="panel-hint">Todavía no hay reseñas. Cuando un cliente deje la suya desde «Mis cuentas», aparece aquí para que la publiques.</p>`;
      return;
    }
    list.innerHTML = data.reviews.map(rowHtml).join("");
  }

  async function load() {
    try { data = await api(""); render(); }
    catch (err) { $("rvw-list").innerHTML = `<p class="form-error">${esc(err.message)}</p>`; }
  }

  // Solo el contador (por el stream en vivo, sin repintar si no está a la vista).
  async function refresh() {
    const section = $("config-section-reviews");
    if (section && !section.hidden) { load(); return; }
    try { const d = await api(""); setBadge(d.pending); } catch { /* no crítico */ }
  }

  $("rvw-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const item = btn.closest(".rvw-item");
    const id = item.dataset.id;
    const act = btn.dataset.act;
    if (act === "delete" && !confirm("¿Borrar esta reseña? No se puede deshacer.")) return;
    btn.disabled = true;
    try {
      if (act === "delete") await api("/" + id, { method: "DELETE" });
      else await api("/" + id, { method: "PATCH", body: JSON.stringify({ status: act }) });
      await load();
    } catch (err) { btn.disabled = false; alert(err.message); }
  });

  $("rvw-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("rvw-error");
    err.hidden = true;
    const btn = $("rvw-add");
    btn.disabled = true;
    try {
      await api("", { method: "POST", body: JSON.stringify({ author: $("rvw-author").value, stars: Number($("rvw-stars").value), body: $("rvw-body").value }) });
      $("rvw-author").value = ""; $("rvw-body").value = ""; $("rvw-stars").value = "5";
      await load();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    btn.disabled = false;
  });

  window.LiordarkReviews = { load, refresh };
  // Contador de pendientes desde el inicio (para verlo sin entrar a la sección).
  setTimeout(refresh, 2500);
})();
