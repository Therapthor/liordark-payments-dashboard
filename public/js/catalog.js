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

  // Todo junto tiene que pasar por la puerta del servidor (1 MB): si sale
  // pesada (foto con mucho detalle), se comprime un poco más.
  const UPLOAD_MAX_BYTES = 900 * 1024;

  async function compressImage(file) {
    const src = await loadBitmap(file);
    if (!src.width || !src.height) throw new Error("No se pudo leer la imagen.");
    let out = null;
    for (const [q, jq] of [[0.8, 0.84], [0.66, 0.72], [0.5, 0.6]]) {
      let main = await renderBlob(src, 720, "image/webp", q);
      let small;
      if (main.type === "image/webp") {
        small = await renderBlob(src, 360, "image/webp", q);
      } else {
        // Navegador sin WEBP (Safari viejo): todo en JPG.
        main = await renderBlob(src, 720, "image/jpeg", jq, true);
        small = await renderBlob(src, 360, "image/jpeg", jq, true);
      }
      const jpg = await renderBlob(src, 720, "image/jpeg", jq, true);
      out = { main, small, jpg };
      if (main.size + small.size + jpg.size <= UPLOAD_MAX_BYTES) break;
    }
    if (src.close) src.close();
    return out;
  }

  async function uploadProductImage(file, label, onRetry) {
    const { main, small, jpg } = await compressImage(file);
    const fd = new FormData();
    fd.append("label", label || "producto");
    fd.append("main", main, "main");
    fd.append("small", small, "small");
    fd.append("jpg", jpg, "jpg");
    // Si el panel justo se está reiniciando (una actualización), responde
    // 502/503/504 unos segundos: se reintenta solo.
    let res = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        res = await fetch("/api/catalog/image", { method: "POST", credentials: "include", body: fd });
      } catch { res = null; }
      if (res && ![502, 503, 504].includes(res.status)) break;
      if (attempt < 3) {
        if (onRetry) onRetry();
        await new Promise(r => setTimeout(r, 4000));
      }
    }
    if (!res) throw new Error("Sin conexión con el panel. Revisa tu internet e inténtalo de nuevo.");
    if (res.status === 401) { location.reload(); throw new Error("No autenticado"); }
    if (res.status === 413) throw new Error("La imagen pesa demasiado para subirla. Prueba con otra más liviana.");
    if ([502, 503, 504].includes(res.status)) throw new Error("El panel se estaba actualizando. Espera unos segundos y vuelve a intentar.");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || `No se pudo subir la imagen (error ${res.status}).`);
    return { url: data.url, kb: Math.round((main.size + small.size) / 1024) };
  }

  // La imagen sigue en un enlace externo (Cloudinary): el servidor no la
  // pudo traer (ej. Cloudinary la bloquea). Hay que subirla con 📷.
  function externalImageTag(url) {
    return /^https?:\/\//i.test(url || "")
      ? '<span class="catalog-tag catalog-tag-warn" title="Esta imagen sigue en Cloudinary y no se pudo pasar al servidor. Edita y súbela con «📷 Subir imagen».">⚠️ Súbela de nuevo</span>'
      : "";
  }

  function showImagePreview(prefix) {
    const url = document.getElementById(prefix + "-image-url").value.trim();
    const img = document.getElementById(prefix + "-image-preview");
    // Si no carga (ej. Cloudinary la bloquea), no se muestra el ícono roto.
    img.onerror = () => { img.hidden = true; };
    if (url && (url.startsWith("/media/") || /^https?:\/\//.test(url))) { img.src = url; img.hidden = false; }
    else { img.removeAttribute("src"); img.hidden = true; }
  }

  function wireImageField(prefix, labelOf, savedIdOf) {
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
        const { url, kb } = await uploadProductImage(file, labelOf(), () => { status.textContent = "El panel se está actualizando, reintentando…"; });
        urlInput.value = url;
        showImagePreview(prefix);
        // Producto/combo que ya existe: la imagen se guarda sola.
        const id = savedIdOf();
        if (id) {
          await api((prefix === "combo" ? "/combos/" : "/products/") + id + "/image", { method: "PATCH", body: JSON.stringify({ imageUrl: url }) });
          status.textContent = `✅ Imagen comprimida (${kb} KB) y guardada.`;
          loadAll().catch(() => {});
        } else {
          status.textContent = `✅ Imagen comprimida (${kb} KB). Se guarda al tocar «Guardar».`;
        }
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
          ${externalImageTag(p.imageUrl)}
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

  // ── Manguito Pro (chat con IA): servicio fijo, no se borra. Aquí solo se
  // cambian su nombre y su imagen (tienda y mayoristas). Precios, planes y
  // encendido: en la sección Manguito Pro.
  let manguitoStore = null;

  function renderManguito(st) {
    const li = document.createElement("li");
    li.className = "catalog-item catalog-item-manguito" + (st.enabled ? "" : " catalog-item-off");
    li.dataset.mg = "1";
    const prices = [st.monthly && st.monthly.enabled ? st.monthly.priceSoles : null, ...(st.packs || []).map(p => p.priceSoles)].filter(x => x > 0);
    const from = prices.length ? Math.min(...prices) : null;
    const thumb = st.imageUrl
      ? `<img class="catalog-thumb" src="${escapeHtml(st.imageUrl)}" alt="" />`
      : `<img class="catalog-thumb" src="/assets/manguito-pro.svg" alt="" />`;
    li.innerHTML = `
      ${thumb}
      <div class="catalog-main">
        <div class="catalog-name">
          ${escapeHtml(st.name)}
          <span class="catalog-tag catalog-tag-ai">Servicio · IA</span>
          ${st.enabled ? "" : '<span class="catalog-tag catalog-tag-off">Apagado</span>'}
        </div>
        <div class="catalog-desc">Se muestra en la tienda y en mayoristas (S/ 5 menos). Precios y planes: en <b>Manguito Pro</b>.</div>
      </div>
      <div class="catalog-price">
        ${from ? "Desde S/ " + escapeHtml(String(from)) : ""}
        <div class="catalog-price-wholesale text-muted">Stock ilimitado</div>
      </div>
      <div class="catalog-actions">
        <button class="icon-btn-sm catalog-mg-edit-btn" title="Cambiar nombre e imagen">✏️</button>
      </div>
    `;
    return li;
  }

  function openManguitoModal() {
    if (!manguitoStore) return;
    document.getElementById("mgcat-name").value = manguitoStore.name || "";
    document.getElementById("mgcat-image-url").value = manguitoStore.imageUrl || "";
    document.getElementById("mgcat-image-status").textContent = "";
    showImagePreview("mgcat");
    document.getElementById("mgcat-error").hidden = true;
    document.getElementById("mgcat-modal").hidden = false;
  }

  function initManguitoModal() {
    wireImageField("mgcat", () => "manguito-pro", () => null);
    document.getElementById("mgcat-image-clear").addEventListener("click", () => {
      document.getElementById("mgcat-image-url").value = "";
      document.getElementById("mgcat-image-status").textContent = "Se usará el logo de siempre al tocar «Guardar».";
      showImagePreview("mgcat");
    });
    document.getElementById("mgcat-cancel").addEventListener("click", () => {
      document.getElementById("mgcat-modal").hidden = true;
    });
    document.getElementById("mgcat-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const errorEl = document.getElementById("mgcat-error");
      errorEl.hidden = true;
      try {
        const res = await fetch("/api/manguito-admin/store", {
          method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: document.getElementById("mgcat-name").value.trim(),
            imageUrl: document.getElementById("mgcat-image-url").value.trim(),
          }),
        });
        if (res.status === 401) { location.reload(); return; }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.message || "No se pudo guardar.");
        manguitoStore = data.store || manguitoStore;
        document.getElementById("mgcat-modal").hidden = true;
        renderProductList();
      } catch (err) {
        errorEl.textContent = err.message || "No se pudo guardar.";
        errorEl.hidden = false;
      }
    });
  }

  function renderProductList() {
    const list  = document.getElementById("catalog-list");
    const empty = document.getElementById("catalog-empty");
    list.innerHTML = "";
    if (manguitoStore) list.appendChild(renderManguito(manguitoStore));
    if (cachedProducts.length === 0 && !manguitoStore) { empty.hidden = false; return; }
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
    wireImageField("catalog", () => document.getElementById("catalog-platform").value.trim() || "producto", () => editingProductId);
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
      if (li.dataset.mg) { if (e.target.closest(".catalog-mg-edit-btn")) openManguitoModal(); return; }
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
          ${externalImageTag(c.imageUrl)}
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
    wireImageField("combo", () => "combo-" + (document.getElementById("combo-name")?.value.trim() || "combo"), () => editingComboId);
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
    const manguito = fetch("/api/manguito-admin", { credentials: "include" })
      .then(r => r.ok ? r.json() : null).catch(() => null);
    const [{ products }, { combos }, mg] = await Promise.all([api("/products"), api("/combos"), manguito]);
    cachedProducts = products;
    cachedCombos   = combos;
    if (mg && mg.store) manguitoStore = mg.store;
    renderProductList();
    renderComboList();
  }

  let initialized = false;
  function init() {
    if (initialized) return;
    initialized = true;
    initProductModal();
    initManguitoModal();
    initProductListActions();
    initComboModal();
    initComboListActions();
  }

  window.LiordarkCatalog = { init, load: loadAll };
})();
