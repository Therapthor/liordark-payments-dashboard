(() => {
  "use strict";

  // ─────────────────────────────────────────────────────────────
  // LINKS DE VENTA (Clientes › 🔗 Links de venta) — celular + producto →
  // link liordark.com/v/<código> que deja al cliente dentro de su cuenta
  // con el pedido listo para pagar. Ver sale-links.routes.ts.
  // ─────────────────────────────────────────────────────────────

  async function api(path, options) {
    const res = await fetch("/api/sale-links" + path, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { location.reload(); throw new Error("No autenticado"); }
    if (!res.ok) throw new Error(data?.message || "Error de red");
    return data;
  }

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const digits9 = (v) => String(v || "").replace(/\D/g, "").slice(-9);

  let options = null;              // { products, combos }
  let picked = [];                 // plataformas elegidas (en orden)
  let comboId = null;              // o un combo del catálogo
  const months = {};               // plataforma → meses (planes)
  let previewTimer = null;
  let listTimer = null;

  function fmt(sqlDate) {
    try {
      const d = new Date(String(sqlDate).replace(" ", "T") + "Z");
      return d.toLocaleString("es-PE", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
    } catch { return sqlDate; }
  }

  const STATE_LABEL = { pending: "Enviado", opened: "Abierto", paid: "✅ Pagado", expired: "Vencido", cancelled: "Anulado" };

  function body() {
    return comboId
      ? { comboId }
      : { items: picked.map(p => ({ platform: p, months: months[p] || 1 })) };
  }

  function renderChips() {
    // Lista ordenada (A→Z), una fila por producto con su precio y stock,
    // igual que «Agregar cliente»: tocar la fila la marca o desmarca.
    const sorted = [...options.products].sort((a, b) => String(a.title).localeCompare(String(b.title), "es"));
    $("sl-products").innerHTML = sorted.map(p => {
      const on = picked.includes(p.platform);
      const n = Number(p.available ?? 0);
      return `
      <button type="button" class="sl-row${on ? " active" : ""}" data-platform="${esc(p.platform)}" aria-pressed="${on}">
        <span class="sl-row-check" aria-hidden="true">${on ? "✓" : ""}</span>
        <span class="sl-row-name">${esc(p.title)}</span>
        <span class="sl-row-price">S/ ${esc(p.price)}</span>
        <span class="access-platform-count ${n > 0 ? "has-stock" : "no-stock"}">${n} disp.</span>
      </button>`;
    }).join("") || `<span class="panel-hint">No hay productos activos.</span>`;
    $("sl-combos").innerHTML = options.combos.map(c => `
      <button type="button" class="sl-chip${comboId === c.id ? " active" : ""}" data-combo="${c.id}">
        ${esc(c.name)}<small>S/ ${esc(c.price)}</small>
      </button>`).join("") || `<span class="panel-hint">Sin combos activos.</span>`;

    // Planes por meses (Gemini) solo si va suelto.
    const withPlans = !comboId && picked.length === 1
      ? options.products.filter(p => p.platform === picked[0] && p.plans) : [];
    const box = $("sl-plans");
    box.hidden = !withPlans.length;
    box.innerHTML = withPlans.map(p => `
      <div class="sl-plan-row">${esc(p.title)}:
        <select data-plan="${esc(p.platform)}">
          ${p.plans.map(pl => `<option value="${pl.months}"${(months[p.platform] || 1) === pl.months ? " selected" : ""}>${esc(pl.label)} — S/ ${esc(pl.price)}</option>`).join("")}
        </select>
      </div>`).join("");
    schedulePreview();
  }

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(preview, 150);
  }

  async function preview() {
    const has = comboId || picked.length;
    $("sl-preview").hidden = !has;
    updateCreateBtn();
    if (!has) return;
    try {
      const r = await api("/preview", { method: "POST", body: JSON.stringify(body()) });
      $("sl-preview-title").textContent = r.title;
      $("sl-preview-price").textContent = "S/ " + r.price;
    } catch (err) {
      $("sl-preview-title").textContent = err.message;
      $("sl-preview-price").textContent = "";
    }
  }

  function updateCreateBtn() {
    const okPhone = /^9\d{8}$/.test(digits9($("sl-phone").value));
    $("sl-create").disabled = !(okPhone && (comboId || picked.length));
  }

  let phoneTimer = null;
  function checkPhone() {
    clearTimeout(phoneTimer);
    updateCreateBtn();
    const d = digits9($("sl-phone").value);
    const hint = $("sl-phone-hint");
    if (!/^9\d{8}$/.test(d)) { hint.textContent = d.length ? "9 dígitos, empieza con 9." : ""; return; }
    phoneTimer = setTimeout(async () => {
      try {
        const r = await api("/customer/" + d);
        hint.textContent = r.blocked ? "⛔ Número bloqueado (fraude/baneo)."
          : r.exists ? "👤 Ya tiene cuenta: el link entra a SU cuenta. Revisa que el número sea el correcto."
          : "✨ Cliente nuevo: se le crea la cuenta con un PIN al azar.";
      } catch { hint.textContent = ""; }
    }, 250);
  }

  async function create() {
    const err = $("sl-error");
    err.hidden = true;
    $("sl-create").disabled = true;
    try {
      const r = await api("/", { method: "POST", body: JSON.stringify({ phone: digits9($("sl-phone").value), ...body() }) });
      $("sl-result").hidden = false;
      $("sl-result-url").value = r.url;
      $("sl-wa").href = r.waUrl;
      $("sl-message").textContent = r.message;
      $("sl-result-new").textContent = r.newCustomer ? `· cliente nuevo (PIN ${r.pin}, también en Clientes)` : "";
      picked = []; comboId = null;
      $("sl-phone").value = ""; $("sl-phone-hint").textContent = "";
      renderChips();
      loadList();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    } finally {
      updateCreateBtn();
    }
  }

  async function loadList() {
    const list = $("sl-list");
    try {
      const { links } = await api("/");
      list.innerHTML = links.map(l => {
        const d = digits9(l.phone);
        const live = l.state === "pending" || l.state === "opened";
        return `
        <li class="sec-session">
          <div>
            <b>${esc(d.slice(0, 3) + " " + d.slice(3, 6) + " " + d.slice(6))}<span class="sl-state ${l.state}">${STATE_LABEL[l.state] || l.state}</span></b>
            <span>${esc(l.title)} · S/ ${esc(l.price)}${l.newCustomer ? " · cliente nuevo" : ""}</span>
            <span>creado ${esc(fmt(l.createdAt))}${l.openedAt ? " · abierto " + esc(fmt(l.openedAt)) : ""}</span>
          </div>
          <div class="sl-actions">
            ${live ? `<button class="btn-secondary btn-sm" data-copy="${esc(l.url)}" type="button">📋</button>
            <button class="btn-secondary btn-sm" data-cancel="${esc(l.code)}" type="button">Anular</button>` : ""}
          </div>
        </li>`;
      }).join("") || `<li class="feed-empty">Aún no has enviado links de venta.</li>`;
    } catch (e) {
      list.innerHTML = `<li class="feed-empty">${esc(e.message)}</li>`;
    }
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); alert("Link copiado."); }
    catch { prompt("Copia el link:", text); }
  }

  function init() {
    if (!$("customers-section-ventas")) return;
    $("sl-phone").addEventListener("input", checkPhone);
    $("sl-products").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-platform]");
      if (!btn) return;
      const p = btn.dataset.platform;
      comboId = null;
      picked = picked.includes(p) ? picked.filter(x => x !== p) : [...picked, p];
      renderChips();
    });
    $("sl-combos").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-combo]");
      if (!btn) return;
      const id = Number(btn.dataset.combo);
      picked = [];
      comboId = comboId === id ? null : id;
      renderChips();
    });
    $("sl-plans").addEventListener("change", (e) => {
      const sel = e.target.closest("[data-plan]");
      if (!sel) return;
      months[sel.dataset.plan] = Number(sel.value);
      schedulePreview();
    });
    $("sl-create").addEventListener("click", create);
    $("sl-copy").addEventListener("click", () => copy($("sl-result-url").value));
    $("sl-list").addEventListener("click", async (e) => {
      const c = e.target.closest("[data-copy]");
      if (c) return copy(c.dataset.copy);
      const x = e.target.closest("[data-cancel]");
      if (!x) return;
      if (!confirm("¿Anular este link? El cliente ya no podrá entrar ni pagar con él.")) return;
      try { await api("/" + encodeURIComponent(x.dataset.cancel) + "/cancel", { method: "POST" }); } catch (err) { alert(err.message); }
      loadList();
    });
  }

  async function open() {
    try {
      if (!options) { options = await api("/options"); renderChips(); }
    } catch (e) {
      $("sl-products").innerHTML = `<span class="panel-hint">${esc(e.message)}</span>`;
    }
    loadList();
    clearInterval(listTimer);
    // Mientras la sección está a la vista, el estado (abierto/pagado) se refresca solo.
    listTimer = setInterval(() => {
      if ($("customers-section-ventas").hidden || document.hidden) return;
      loadList();
    }, 20000);
  }

  init();
  window.LiordarkSaleLinks = { open };
})();
