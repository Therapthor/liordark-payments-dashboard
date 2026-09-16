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
  // LISTA
  // ─────────────────────────────────────────────────────────────

  let cachedProducts = [];

  function renderProduct(p) {
    const li = document.createElement("li");
    li.className = "catalog-item";
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
        </div>
        <div class="catalog-desc">${escapeHtml(p.description) || "<em>Sin descripción todavía</em>"}</div>
      </div>
      <div class="catalog-price">S/ ${escapeHtml(p.price)}</div>
      <div class="catalog-actions">
        <button class="icon-btn-sm catalog-edit-btn" title="Editar">✏️</button>
        <button class="icon-btn-sm catalog-delete-btn" title="Eliminar">🗑️</button>
      </div>
    `;
    return li;
  }

  function renderList() {
    const list  = document.getElementById("catalog-list");
    const empty = document.getElementById("catalog-empty");
    list.innerHTML = "";
    if (cachedProducts.length === 0) { empty.hidden = false; return; }
    empty.hidden = true;
    for (const p of cachedProducts) list.appendChild(renderProduct(p));
  }

  async function load() {
    const { products } = await api("/products");
    cachedProducts = products;
    renderList();
  }

  // ─────────────────────────────────────────────────────────────
  // MODAL: agregar/editar producto
  // ─────────────────────────────────────────────────────────────

  let editingId = null;

  function openModal(product) {
    editingId = product ? product.id : null;
    document.getElementById("catalog-modal-title").textContent = product ? "Editar producto" : "Agregar producto";
    document.getElementById("catalog-platform").value     = product?.platform ?? "";
    document.getElementById("catalog-title").value        = product?.title ?? "";
    document.getElementById("catalog-price").value        = product?.price ?? "";
    document.getElementById("catalog-has-profiles").checked = product ? product.hasProfiles : true;
    document.getElementById("catalog-description").value  = product?.description ?? "";
    document.getElementById("catalog-image-url").value    = product?.imageUrl ?? "";
    document.getElementById("catalog-error").hidden = true;
    document.getElementById("catalog-modal").hidden = false;
  }

  function initModal() {
    document.getElementById("catalog-new-btn").addEventListener("click", () => openModal(null));
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
        if (editingId) {
          await api("/products/" + editingId, { method: "PUT", body: JSON.stringify(body) });
        } else {
          await api("/products", { method: "POST", body: JSON.stringify(body) });
        }
        document.getElementById("catalog-modal").hidden = true;
        await load();
      } catch (err) {
        errorEl.textContent = err.message || "No se pudo guardar el producto.";
        errorEl.hidden = false;
      }
    });
  }

  function initListActions() {
    document.getElementById("catalog-list").addEventListener("click", async (e) => {
      const li = e.target.closest(".catalog-item");
      if (!li) return;
      const id = Number(li.dataset.id);
      const product = cachedProducts.find(p => p.id === id);
      if (!product) return;

      if (e.target.closest(".catalog-edit-btn")) {
        openModal(product);
        return;
      }

      if (e.target.closest(".catalog-delete-btn")) {
        if (!confirm(`¿Eliminar "${product.platform}" del catálogo? También desaparece del desplegable de Accesos.`)) return;
        try {
          await api("/products/" + id, { method: "DELETE" });
          await load();
        } catch (err) {
          alert(err.message || "No se pudo eliminar el producto.");
        }
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // INIT
  // ─────────────────────────────────────────────────────────────

  let initialized = false;
  function init() {
    if (initialized) return;
    initialized = true;
    initModal();
    initListActions();
  }

  window.LiordarkCatalog = { init, load };
})();
