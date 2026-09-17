(() => {
  "use strict";

  // ─────────────────────────────────────────────────────────────
  // HELPERS (propios — este archivo no depende de app.js)
  // ─────────────────────────────────────────────────────────────

  async function api(base, path, options = {}) {
    const res = await fetch(base + path, {
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
  // MÉTODOS DE PAGO
  // ─────────────────────────────────────────────────────────────

  let cachedMethods = [];

  function methodApi(path, options) { return api("/api/payment-methods", path, options); }

  function renderMethod(m) {
    const li = document.createElement("li");
    li.className = "catalog-item" + (m.active ? "" : " catalog-item-off");
    li.dataset.id = m.id;
    li.innerHTML = `
      <div class="catalog-thumb catalog-thumb-empty">💳</div>
      <div class="catalog-main">
        <div class="catalog-name">
          ${escapeHtml(m.name)}
          ${m.active ? "" : '<span class="catalog-tag catalog-tag-off">Apagado</span>'}
        </div>
        <div class="catalog-desc">${escapeHtml(m.description) || "<em>Sin descripción</em>"}</div>
      </div>
      <div class="catalog-actions">
        <button class="icon-btn-sm method-toggle-btn" title="${m.active ? "Apagar" : "Encender"}">${m.active ? "🟢" : "⚫"}</button>
        <button class="icon-btn-sm method-edit-btn" title="Editar">✏️</button>
        <button class="icon-btn-sm method-delete-btn" title="Eliminar">🗑️</button>
      </div>
    `;
    return li;
  }

  function renderMethodList() {
    const list  = document.getElementById("payment-method-list");
    const empty = document.getElementById("payment-method-empty");
    list.innerHTML = "";
    if (cachedMethods.length === 0) { empty.hidden = false; return; }
    empty.hidden = true;
    for (const m of cachedMethods) list.appendChild(renderMethod(m));
  }

  async function loadMethods() {
    const { methods } = await methodApi("/");
    cachedMethods = methods;
    renderMethodList();
  }

  let editingMethodId = null;

  function openMethodModal(method) {
    editingMethodId = method ? method.id : null;
    document.getElementById("payment-method-modal-title").textContent = method ? "Editar método" : "Agregar método";
    document.getElementById("payment-method-name").value        = method?.name ?? "";
    document.getElementById("payment-method-description").value = method?.description ?? "";
    document.getElementById("payment-method-error").hidden = true;
    document.getElementById("payment-method-modal").hidden = false;
  }

  function initMethodModal() {
    document.getElementById("payment-method-new-btn").addEventListener("click", () => openMethodModal(null));
    document.getElementById("payment-method-cancel").addEventListener("click", () => {
      document.getElementById("payment-method-modal").hidden = true;
    });

    document.getElementById("payment-method-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const errorEl = document.getElementById("payment-method-error");
      errorEl.hidden = true;

      const body = {
        name:        document.getElementById("payment-method-name").value.trim(),
        description: document.getElementById("payment-method-description").value.trim(),
      };

      try {
        if (editingMethodId) {
          await methodApi("/" + editingMethodId, { method: "PUT", body: JSON.stringify(body) });
        } else {
          await methodApi("/", { method: "POST", body: JSON.stringify(body) });
        }
        document.getElementById("payment-method-modal").hidden = true;
        await loadMethods();
      } catch (err) {
        errorEl.textContent = err.message || "No se pudo guardar el método.";
        errorEl.hidden = false;
      }
    });
  }

  function initMethodListActions() {
    document.getElementById("payment-method-list").addEventListener("click", async (e) => {
      const li = e.target.closest(".catalog-item");
      if (!li) return;
      const id = Number(li.dataset.id);
      const method = cachedMethods.find(m => m.id === id);
      if (!method) return;

      if (e.target.closest(".method-toggle-btn")) {
        try {
          await methodApi("/" + id + "/active", { method: "PATCH", body: JSON.stringify({ active: !method.active }) });
          await loadMethods();
        } catch (err) { alert(err.message || "No se pudo cambiar el estado."); }
        return;
      }
      if (e.target.closest(".method-edit-btn")) { openMethodModal(method); return; }
      if (e.target.closest(".method-delete-btn")) {
        if (!confirm(`¿Eliminar el método "${method.name}"?`)) return;
        try {
          await methodApi("/" + id, { method: "DELETE" });
          await loadMethods();
        } catch (err) { alert(err.message || "No se pudo eliminar el método."); }
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // PROVEEDORES
  // ─────────────────────────────────────────────────────────────

  let cachedProviders = [];

  function providerApi(path, options) { return api("/api/providers", path, options); }

  function renderProvider(p) {
    const li = document.createElement("li");
    li.className = "catalog-item" + (p.active ? "" : " catalog-item-off");
    li.dataset.id = p.id;
    li.innerHTML = `
      <div class="catalog-thumb catalog-thumb-empty">🏷</div>
      <div class="catalog-main">
        <div class="catalog-name">
          ${escapeHtml(p.name)}
          ${p.active ? "" : '<span class="catalog-tag catalog-tag-off">Apagado</span>'}
        </div>
        <div class="catalog-desc">${p.whatsapp ? "📱 " + escapeHtml(p.whatsapp) : "<em>Sin WhatsApp</em>"}${p.notes ? " · " + escapeHtml(p.notes) : ""}</div>
      </div>
      <div class="catalog-actions">
        <button class="icon-btn-sm provider-toggle-btn" title="${p.active ? "Apagar" : "Encender"}">${p.active ? "🟢" : "⚫"}</button>
        <button class="icon-btn-sm provider-edit-btn" title="Editar">✏️</button>
        <button class="icon-btn-sm provider-delete-btn" title="Eliminar">🗑️</button>
      </div>
    `;
    return li;
  }

  function renderProviderList() {
    const list  = document.getElementById("provider-list");
    const empty = document.getElementById("provider-empty");
    list.innerHTML = "";
    if (cachedProviders.length === 0) { empty.hidden = false; return; }
    empty.hidden = true;
    for (const p of cachedProviders) list.appendChild(renderProvider(p));
  }

  async function loadProviders() {
    const { providers } = await providerApi("/");
    cachedProviders = providers;
    renderProviderList();
  }

  let editingProviderId = null;

  function openProviderModal(provider) {
    editingProviderId = provider ? provider.id : null;
    document.getElementById("provider-modal-title").textContent = provider ? "Editar proveedor" : "Agregar proveedor";
    document.getElementById("provider-name").value     = provider?.name ?? "";
    document.getElementById("provider-whatsapp").value = provider?.whatsapp ?? "";
    document.getElementById("provider-notes").value    = provider?.notes ?? "";
    document.getElementById("provider-error").hidden = true;
    document.getElementById("provider-modal").hidden = false;
  }

  function initProviderModal() {
    document.getElementById("provider-new-btn").addEventListener("click", () => openProviderModal(null));
    document.getElementById("provider-cancel").addEventListener("click", () => {
      document.getElementById("provider-modal").hidden = true;
    });

    document.getElementById("provider-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const errorEl = document.getElementById("provider-error");
      errorEl.hidden = true;

      const body = {
        name:     document.getElementById("provider-name").value.trim(),
        whatsapp: document.getElementById("provider-whatsapp").value.trim(),
        notes:    document.getElementById("provider-notes").value.trim(),
      };

      try {
        if (editingProviderId) {
          await providerApi("/" + editingProviderId, { method: "PUT", body: JSON.stringify(body) });
        } else {
          await providerApi("/", { method: "POST", body: JSON.stringify(body) });
        }
        document.getElementById("provider-modal").hidden = true;
        await loadProviders();
      } catch (err) {
        errorEl.textContent = err.message || "No se pudo guardar el proveedor.";
        errorEl.hidden = false;
      }
    });
  }

  function initProviderListActions() {
    document.getElementById("provider-list").addEventListener("click", async (e) => {
      const li = e.target.closest(".catalog-item");
      if (!li) return;
      const id = Number(li.dataset.id);
      const provider = cachedProviders.find(p => p.id === id);
      if (!provider) return;

      if (e.target.closest(".provider-toggle-btn")) {
        try {
          await providerApi("/" + id + "/active", { method: "PATCH", body: JSON.stringify({ active: !provider.active }) });
          await loadProviders();
        } catch (err) { alert(err.message || "No se pudo cambiar el estado."); }
        return;
      }
      if (e.target.closest(".provider-edit-btn")) { openProviderModal(provider); return; }
      if (e.target.closest(".provider-delete-btn")) {
        if (!confirm(`¿Eliminar el proveedor "${provider.name}"? También deja de estar disponible en Accesos.`)) return;
        try {
          await providerApi("/" + id, { method: "DELETE" });
          await loadProviders();
        } catch (err) { alert(err.message || "No se pudo eliminar el proveedor."); }
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
    initMethodModal();
    initMethodListActions();
    initProviderModal();
    initProviderListActions();
  }

  window.LiordarkSettings = { init, loadMethods, loadProviders };
})();
