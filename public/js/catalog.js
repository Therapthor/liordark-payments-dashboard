(() => {
  "use strict";

  // ─────────────────────────────────────────────────────────────
  // HELPERS (propios — este archivo no depende de app.js)
  // ─────────────────────────────────────────────────────────────

  // ── Imagen del producto/combo: se comprime aquí (en el navegador) y se
  // sube al servidor. 3 versiones: 720 px (detalle), 360 px (tarjetas) y
  // JPG 720 px (WhatsApp y PDF). El servidor no puede comprimir. ──
  async function loadBitmap(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { /* plan B */ }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = "async";
      img.src = url;
      await img.decode();
      return img;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }

  function renderBlob(src, maxW, type, quality, whiteBg) {
    const w0 = src.width, h0 = src.height;
    const scale = Math.min(1, maxW / w0);
    const w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    if (whiteBg) { ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, w, h); }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, w, h);
    return new Promise((resolve, reject) => c.toBlob(b => b ? resolve(b) : reject(new Error("No se pudo comprimir la imagen.")), type, quality));
  }

  async function compressImage(file) {
    const src = await loadBitmap(file);
    if (!src.width || !src.height) throw new Error("No se pudo leer la imagen.");
    let main = await renderBlob(src, 720, "image/webp", 0.8);
    let small;
    if (main.type === "image/webp") {
      small = await renderBlob(src, 360, "image/webp", 0.78);
    } else {
      // Navegador sin WEBP (Safari viejo): todo en JPG.
      main = await renderBlob(src, 720, "image/jpeg", 0.84, true);
      small = await renderBlob(src, 360, "image/jpeg", 0.8, true);
    }
    const jpg = await renderBlob(src, 720, "image/jpeg", 0.84, true);
    if (src.close) src.close();
    return { main, small, jpg };
  }

  async function uploadProductImage(file, label) {
    const { main, small, jpg } = await compressImage(file);
    const fd = new FormData();
    fd.append("label", label || "producto");
    fd.append("main", main, "main");
    fd.append("small", small, "small");
    fd.append("jpg", jpg, "jpg");
    const res = await fetch("/api/catalog/image", { method: "POST", credentials: "include", body: fd });
    if (res.status === 401) { location.reload(); throw new Error("No autenticado"); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || "No se pudo subir la imagen.");
    return { url: data.url, kb: Math.round((main.size + small.size) / 1024) };
  }

  function showImagePreview(prefix) {
    const url = document.getElementById(prefix + "-image-url").value.trim();
    const img = document.getElementById(prefix + "-image-preview");
    if (url && (url.startsWith("/media/") || /^https?:\/\//.test(url))) { img.src = url; img.hidden = false; }
    else { img.removeAttribute("src"); img.hidden = true; }
  }

  function wireImageField(prefix, labelOf) {
    const fileInput = document.getElementById(prefix + "-image-file");
    const status = document.getElementById(prefix + "-image-status");
    const urlInput = document.getElementById(prefix + "-image-url");
    urlInput.addEventListener("input", () => showImagePreview(prefix));
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = "";
      if (!file) return;
      status.textContent = "Comprimiendo y subiendo…";
      try {
        const { url, kb } = await uploadProductImage(file, labelOf());
        urlInput.value = url;
        showImagePreview(prefix);
        status.textContent = `✅ Lista (${kb} KB). Toca «Guardar».`;
      } catch (err) {
        status.textContent = "⚠️ " + (err.message || "No se pudo subir.");
      }
    });
  }

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
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
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
      <div class="catalog-price">
        S/ ${escapeHtml(p.price)}
        <div class="catalog-price-wholesale text-muted">Mayorista: S/ ${escapeHtml(p.wholesalePrice)} · Completa: S/ ${escapeHtml(p.wholesaleFullPrice)}</div>
      </div>
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
    document.getElementById("catalog-wholesale-price").value      = product?.wholesalePrice ?? "";
    document.getElementById("catalog-wholesale-full-price").value = product?.wholesaleFullPrice ?? "";
    document.getElementById("catalog-has-profiles").checked = product ? product.hasProfiles : true;
    document.getElementById("catalog-description").value    = product?.description ?? "";
    document.getElementById("catalog-image-url").value      = product?.imageUrl ?? "";
    document.getElementById("catalog-image-status").textContent = "";
    showImagePreview("catalog");
    document.getElementById("catalog-keywords").value       = product?.keywords ?? "";
    document.getElementById("catalog-error").hidden = true;
    document.getElementById("catalog-modal").hidden = false;
  }

  function initProductModal() {
    document.getElementById("catalog-new-btn").addEventListener("click", () => openProductModal(null));
    wireImageField("catalog", () => document.getElementById("catalog-platform").value.trim() || "producto");
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
        wholesalePrice:     document.getElementById("catalog-wholesale-price").value,
        wholesaleFullPrice: document.getElementById("catalog-wholesale-full-price").value,
        hasProfiles: document.getElementById("catalog-has-profiles").checked,
        description: document.getElementById("catalog-description").value.trim(),
        imageUrl:    document.getElementById("catalog-image-url").value.trim(),
        keywords:    document.getElementById("catalog-keywords").value.trim(),
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

  function comboItemsLabel(items) {
    return items.map(it => it.platform + (it.quantity > 1 ? ` x${it.quantity}` : "")).join(" + ");
  }

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
          ${c.active ? "" : '<span class="catalog-tag catalog-tag-off">Apagado</span>'}
        </div>
        <div class="catalog-desc">${escapeHtml(comboItemsLabel(c.items))}${c.description ? " · " + escapeHtml(c.description) : ""}</div>
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

  function platformOptionsHtml(selected) {
    const active = cachedProducts.filter(p => p.active);
    return active.length
      ? active.map(p => `<option value="${escapeHtml(p.platform)}" ${p.platform === selected ? "selected" : ""}>${escapeHtml(p.platform)}</option>`).join("")
      : `<option value="">Agrega productos al catálogo primero</option>`;
  }

  function addComboItemRow(platform, quantity) {
    const row = document.createElement("div");
    row.className = "combo-item-row";
    row.innerHTML = `
      <select class="combo-item-platform">${platformOptionsHtml(platform ?? "")}</select>
      <input type="number" class="combo-item-qty" min="1" max="10" step="1" value="${quantity ?? 1}" title="Cantidad de esta plataforma" />
      <button type="button" class="icon-btn-sm combo-item-remove" title="Quitar">✕</button>
    `;
    row.querySelector(".combo-item-remove").addEventListener("click", () => row.remove());
    document.getElementById("combo-items-list").appendChild(row);
  }

  function readComboItems() {
    return [...document.querySelectorAll("#combo-items-list .combo-item-row")].map(row => ({
      platform: row.querySelector(".combo-item-platform").value,
      quantity: Number(row.querySelector(".combo-item-qty").value) || 1,
    })).filter(it => it.platform);
  }

  function openComboModal(combo) {
    editingComboId = combo ? combo.id : null;
    document.getElementById("combo-modal-title").textContent = combo ? "Editar combo" : "Agregar combo";
    document.getElementById("combo-name").value        = combo?.name ?? "";
    document.getElementById("combo-price").value       = combo?.price ?? "";
    document.getElementById("combo-description").value = combo?.description ?? "";
    document.getElementById("combo-image-url").value   = combo?.imageUrl ?? "";
    document.getElementById("combo-image-status").textContent = "";
    showImagePreview("combo");

    document.getElementById("combo-items-list").innerHTML = "";
    const items = combo?.items?.length ? combo.items : [{ platform: "" }, { platform: "" }];
    for (const it of items) addComboItemRow(it.platform, it.quantity);

    document.getElementById("combo-error").hidden = true;
    document.getElementById("combo-modal").hidden = false;
  }

  function initComboModal() {
    document.getElementById("combo-new-btn").addEventListener("click", () => openComboModal(null));
    wireImageField("combo", () => "combo-" + (document.getElementById("combo-name")?.value.trim() || "combo"));
    document.getElementById("combo-cancel").addEventListener("click", () => {
      document.getElementById("combo-modal").hidden = true;
    });
    document.getElementById("combo-add-item-btn").addEventListener("click", () => addComboItemRow());

    document.getElementById("combo-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const errorEl = document.getElementById("combo-error");
      errorEl.hidden = true;

      const items = readComboItems();
      if (items.length < 2) {
        errorEl.textContent = "Un combo necesita al menos 2 plataformas.";
        errorEl.hidden = false;
        return;
      }

      const body = {
        name:        document.getElementById("combo-name").value.trim(),
        price:       document.getElementById("combo-price").value,
        description: document.getElementById("combo-description").value.trim(),
        imageUrl:    document.getElementById("combo-image-url").value.trim(),
        items,
      };

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
