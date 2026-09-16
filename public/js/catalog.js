(() => {
  "use strict";

  // ─────────────────────────────────────────────────────────────
  // HELPERS (propios — este archivo no depende de app.js)
  // ─────────────────────────────────────────────────────────────

  async function api(path, options = {}) {
    const res = await fetch("/api/catalog" + path, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    if (res.status === 401) { location.reload(); throw new Error("No autenticado"); }
    if (res.status === 204) return {};
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || "Error de red");
    return data;
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ─────────────────────────────────────────────────────────────
  // PRODUCTOS
  // ─────────────────────────────────────────────────────────────

  let cachedProducts = [];

  function renderProduct(p) {
    const li = document.createElement("li");
    li.className = "catalog-item" + (p.active ? "" : " catalog-item-off");
    li.dataset.id = p.id;

    const thumb = p.imageUrl
      ? `<img class="catalog-thumb" src="${escapeHtml(p.imageUrl)}" alt="" />`
      : `<div class="catalog-thumb catalog-thumb-empty">🖼</div>`;

    li.innerHTML = `
      ${thumb}
      <div class="catalog-main">
        <div class="catalog-name">
          ${escapeHtml(p.platform)}
          ${p.hasProfiles ? "" : '<span class="catalog-tag">Sin perfiles</span>'}
          ${p.active ? "" : '<span class="catalog-tag catalog-tag-off">Apagado</span>'}
        </div>
        <div class="catalog-desc">${escapeHtml(p.description) || "<em>Sin descripción todavía</em>"}</div>
      </div>
      <div class="catalog-price">S/ ${escapeHtml(p.price)}</div>
      <div class="catalog-actions">
        <button class="icon-btn-sm catalog-toggle-btn" title="${p.active ? "Apagar (deja de venderse)" : "Encender"}">${p.active ? "🟢" : "⚫"}</button>
        <button class="icon-btn-sm catalog-edit-btn" title="Editar">✏️</button>
        <button class="icon-btn-sm catalog-delete-btn" title="Eliminar">🗑️</button>
      </div>
    `;
    return li;
  }

  function renderProductList() {
    const list  = document.getElementById("catalog-list");
    const empty = document.getElementById("catalog-empty");
    list.innerHTML = "";
    if (cachedProducts.length === 0) { empty.hidden = false; return; }
    empty.hidden = true;
    for (const p of cachedProducts) list.appendChild(renderProduct(p));
  }

  let editingProductId = null;

  function openProductModal(product) {
    editingProductId = product ? product.id : null;
    document.getElementById("catalog-modal-title").textContent = product ? "Editar producto" : "Agregar producto";
    document.getElementById("catalog-platform").value       = product?.platform ?? "";
    document.getElementById("catalog-title").value          = product?.title ?? "";
    document.getElementById("catalog-price").value          = product?.price ?? "";
    document.getElementById("catalog-has-profiles").checked = product ? product.hasProfiles : true;
    document.getElementById("catalog-description").value    = product?.description ?? "";
    document.getElementById("catalog-image-url").value      = product?.imageUrl ?? "";
    document.getElementById("catalog-error").hidden = true;
    document.getElementById("catalog-modal").hidden = false;
  }

  function initProductModal() {
    document.getElementById("catalog-new-btn").addEventListener("click", () => openProductModal(null));
    document.getElementById("catalog-cancel").addEventListener("click", () => {
      document.getElementById("catalog-modal").hidden = true;
    });

    document.getElementById("catalog-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const errorEl = document.getElementById("catalog-error");
      errorEl.hidden = true;

      const body = {
        platform:    document.getElementById("catalog-platform").value.trim(),
        title:       document.getElementById("catalog-title").value.trim(),
        price:       document.getElementById("catalog-price").value,
        hasProfiles: document.getElementById("catalog-has-profiles").checked,
        description: document.getElementById("catalog-description").value.trim(),
        imageUrl:    document.getElementById("catalog-image-url").value.trim(),
      };

      try {
        if (editingProductId) {
          await api("/products/" + editingProductId, { method: "PUT", body: JSON.stringify(body) });
        } else {
          await api("/products", { method: "POST", body: JSON.stringify(body) });
        }
        document.getElementById("catalog-modal").hidden = true;
        await loadAll();
      } catch (err) {
        errorEl.textContent = err.message || "No se pudo guardar el producto.";
        errorEl.hidden = false;
      }
    });
  }

  function initProductListActions() {
    document.getElementById("catalog-list").addEventListener("click", async (e) => {
      const li = e.target.closest(".catalog-item");
      if (!li) return;
      const id = Number(li.dataset.id);
      const product = cachedProducts.find(p => p.id === id);
      if (!product) return;

      if (e.target.closest(".catalog-toggle-btn")) {
        try {
          await api("/products/" + id + "/active", {
            method: "PATCH", body: JSON.stringify({ active: !product.active }),
          });
          await loadAll();
        } catch (err) {
          alert(err.message || "No se pudo cambiar el estado.");
        }
        return;
      }

      if (e.target.closest(".catalog-edit-btn")) {
        openProductModal(product);
        return;
      }

      if (e.target.closest(".catalog-delete-btn")) {
        if (!confirm(`¿Eliminar "${product.platform}" del catálogo? También desaparece del desplegable de Accesos.`)) return;
        try {
          await api("/products/" + id, { method: "DELETE" });
          await loadAll();
        } catch (err) {
          alert(err.message || "No se pudo eliminar el producto.");
        }
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // COMBOS
  // ─────────────────────────────────────────────────────────────

  let cachedCombos = [];

  function renderCombo(c) {
    const li = document.createElement("li");
    li.className = "catalog-item" + (c.active ? "" : " catalog-item-off");
    li.dataset.id = c.id;

    const thumb = c.imageUrl
      ? `<img class="catalog-thumb" src="${escapeHtml(c.imageUrl)}" alt="" />`
      : `<div class="catalog-thumb catalog-thumb-empty">🖼</div>`;

    li.innerHTML = `
      ${thumb}
      <div class="catalog-main">
        <div class="catalog-name">
          ${escapeHtml(c.name)}
          <span class="catalog-tag catalog-tag-qty">x${c.quantity} perfiles</span>
          ${c.active ? "" : '<span class="catalog-tag catalog-tag-off">Apagado</span>'}
        </div>
        <div class="catalog-desc">${escapeHtml(c.platform)}${c.description ? " · " + escapeHtml(c.description) : ""}</div>
      </div>
      <div class="catalog-price">S/ ${escapeHtml(c.price)}</div>
      <div class="catalog-actions">
        <button class="icon-btn-sm combo-toggle-btn" title="${c.active ? "Apagar" : "Encender"}">${c.active ? "🟢" : "⚫"}</button>
        <button class="icon-btn-sm combo-edit-btn" title="Editar">✏️</button>
        <button class="icon-btn-sm combo-delete-btn" title="Eliminar">🗑️</button>
      </div>
    `;
    return li;
  }

  function renderComboList() {
    const list  = document.getElementById("combo-list");
    const empty = document.getElementById("combo-empty");
    list.innerHTML = "";
    if (cachedCombos.length === 0) { empty.hidden = false; return; }
    empty.hidden = true;
    for (const c of cachedCombos) list.appendChild(renderCombo(c));
  }

  let editingComboId = null;

  function fillComboPlatformSelect(selected) {
    const select = document.getElementById("combo-platform");
    const active = cachedProducts.filter(p => p.active);
    select.innerHTML = active.length
      ? active.map(p => `<option value="${escapeHtml(p.platform)}" ${p.platform === selected ? "selected" : ""}>${escapeHtml(p.platform)}</option>`).join("")
      : `<option value="">Agrega productos al catálogo primero</option>`;
  }

  function openComboModal(combo) {
    editingComboId = combo ? combo.id : null;
    document.getElementById("combo-modal-title").textContent = combo ? "Editar combo" : "Agregar combo";
    fillComboPlatformSelect(combo?.platform ?? "");
    document.getElementById("combo-name").value        = combo?.name ?? "";
    document.getElementById("combo-quantity").value    = combo?.quantity ?? 2;
    document.getElementById("combo-price").value       = combo?.price ?? "";
    document.getElementById("combo-description").value = combo?.description ?? "";
    document.getElementById("combo-image-url").value   = combo?.imageUrl ?? "";
    document.getElementById("combo-error").hidden = true;
    document.getElementById("combo-modal").hidden = false;
  }

  function initComboModal() {
    document.getElementById("combo-new-btn").addEventListener("click", () => openComboModal(null));
    document.getElementById("combo-cancel").addEventListener("click", () => {
      document.getElementById("combo-modal").hidden = true;
    });

    document.getElementById("combo-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const errorEl = document.getElementById("combo-error");
      errorEl.hidden = true;

      const body = {
        name:        document.getElementById("combo-name").value.trim(),
        platform:    document.getElementById("combo-platform").value,
        quantity:    document.getElementById("combo-quantity").value,
        price:       document.getElementById("combo-price").value,
        description: document.getElementById("combo-description").value.trim(),
        imageUrl:    document.getElementById("combo-image-url").value.trim(),
      };

      if (!body.platform) {
        errorEl.textContent = "Agrega al menos un producto activo al catálogo antes de crear un combo.";
        errorEl.hidden = false;
        return;
      }

      try {
        if (editingComboId) {
          await api("/combos/" + editingComboId, { method: "PUT", body: JSON.stringify(body) });
        } else {
          await api("/combos", { method: "POST", body: JSON.stringify(body) });
        }
        document.getElementById("combo-modal").hidden = true;
        await loadAll();
      } catch (err) {
        errorEl.textContent = err.message || "No se pudo guardar el combo.";
        errorEl.hidden = false;
      }
    });
  }

  function initComboListActions() {
    document.getElementById("combo-list").addEventListener("click", async (e) => {
      const li = e.target.closest(".catalog-item");
      if (!li) return;
      const id = Number(li.dataset.id);
      const combo = cachedCombos.find(c => c.id === id);
      if (!combo) return;

      if (e.target.closest(".combo-toggle-btn")) {
        try {
          await api("/combos/" + id + "/active", {
            method: "PATCH", body: JSON.stringify({ active: !combo.active }),
          });
          await loadAll();
        } catch (err) {
          alert(err.message || "No se pudo cambiar el estado.");
        }
        return;
      }

      if (e.target.closest(".combo-edit-btn")) {
        openComboModal(combo);
        return;
      }

      if (e.target.closest(".combo-delete-btn")) {
        if (!confirm(`¿Eliminar el combo "${combo.name}"?`)) return;
        try {
          await api("/combos/" + id, { method: "DELETE" });
          await loadAll();
        } catch (err) {
          alert(err.message || "No se pudo eliminar el combo.");
        }
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // CARGA + INIT
  // ─────────────────────────────────────────────────────────────

  async function loadAll() {
    const [{ products }, { combos }] = await Promise.all([api("/products"), api("/combos")]);
    cachedProducts = products;
    cachedCombos   = combos;
    renderProductList();
    renderComboList();
  }

  let initialized = false;
  function init() {
    if (initialized) return;
    initialized = true;
    initProductModal();
    initProductListActions();
    initComboModal();
    initComboListActions();
  }

  window.LiordarkCatalog = { init, load: loadAll };
})();
