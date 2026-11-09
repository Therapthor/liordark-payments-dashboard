(() => {
  "use strict";

  // El botón del correo manda "token" (firmado, largo); el link del SMS
  // manda "code" (corto, ver sms-renewal-links.repository.ts) — mismo
  // destino final, solo cambia el prefijo de la ruta en el backend.
  const params = new URLSearchParams(location.search);
  const token  = params.get("token") || "";
  const code   = params.get("code") || "";
  const renewBase = token ? "/renew/" + encodeURIComponent(token) : "/renew-code/" + encodeURIComponent(code);
  const POLL_MS = 4000;

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, m => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]
    ));
  }

  async function api(path, options = {}) {
    const res = await fetch("/api/store" + path, {
      method: options.method || "GET",
      headers: { "Content-Type": "application/json" },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || "Algo salió mal. Intenta de nuevo.");
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function showState(id) {
    ["renew-lookup", "renew-loading", "renew-error", "renew-blocked", "renew-picker", "renew-form", "renew-ready", "renew-pack", "renew-success"].forEach(s => {
      document.getElementById(s).hidden = s !== id;
    });
  }

  function showError(message) {
    document.getElementById("renew-error-text").textContent = message;
    showState("renew-error");
  }

  // Mismo criterio que renderInfoRows de app.js — "Yape: 963081436\nTitular:
  // José Pérez" se parte en filas "etiqueta: valor", cada una con su botón
  // de copiar, para que el número y el nombre se puedan copiar por separado.
  function renderInfoRows(el, text) {
    const lines = (text || "").split(/\r?\n|(?<=\S) {2,}(?=\S)/).map(l => l.trim()).filter(Boolean);
    el.hidden = lines.length === 0;
    el.innerHTML = lines.map(line => {
      const i = line.indexOf(":");
      const label = i === -1 ? "" : line.slice(0, i).trim();
      const value = i === -1 ? line : line.slice(i + 1).trim();
      const copyBtn = `<button class="yape-copy-btn" type="button" data-copy="${escapeHtml(value)}" aria-label="Copiar" title="Copiar">📋</button>`;
      return `<div class="yape-info-row">${label ? `<span class="yape-info-label">${escapeHtml(label)}</span>` : ""}<span class="yape-info-value">${escapeHtml(value)}</span>${copyBtn}</div>`;
    }).join("");
  }

  document.addEventListener("click", async (e) => {
    const btn = e.target.closest(".yape-copy-btn");
    if (!btn) return;
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      const original = btn.textContent;
      btn.textContent = "✅";
      setTimeout(() => { btn.textContent = original; }, 1200);
    } catch {
      alert("No se pudo copiar. Copia manualmente: " + btn.dataset.copy);
    }
  });

  let pollTimer = null;
  let initialDaysLeft = null;
  // Cuando el link trae varias cuentas (combo), el cliente elige una acá
  // — el GET sigue devolviendo la lista completa, así que el polling y el
  // checkout necesitan saber CUÁL de todas quedó elegida.
  let selectedPlatform = null;

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(async () => {
      try {
        const info = await api(renewBase);
        const current = selectedPlatform
          ? (info.accounts || []).find(a => a.platform === selectedPlatform)
          : info;
        if (current && initialDaysLeft !== null && current.daysLeft > initialDaysLeft) {
          stopPolling();
          showState("renew-success");
        }
      } catch { /* red momentánea o ya vencido el link — sigue intentando */ }
    }, POLL_MS);
  }

  async function createOrder(clientEmail, clientPassword) {
    showState("renew-loading");
    try {
      const order = await api(renewBase + "/checkout", {
        method: "POST",
        body: { clientEmail, clientPassword, platform: selectedPlatform || undefined },
      });

      document.getElementById("renew-amount").textContent = "S/ " + order.amount;
      document.getElementById("renew-amount-copy").dataset.copy = order.amount;

      const { methods } = await api("/payment-methods").catch(() => ({ methods: [] }));
      const yape = (methods || []).find(m => m.name.toLowerCase().includes("yape"));
      const qrImg = document.getElementById("renew-qr");
      if (yape && yape.imageUrl) { qrImg.src = yape.imageUrl; qrImg.hidden = false; } else { qrImg.hidden = true; }
      renderInfoRows(document.getElementById("renew-instructions"), yape ? yape.description : "");

      showState("renew-ready");
      startPolling();
    } catch (err) {
      showError(err.message);
    }
  }

  // Ya se sabe qué cuenta renovar (la única del link, o la que el cliente
  // eligió en el picker) — pide correo/contraseña si hace falta y sigue.
  function proceedWithAccount(info) {
    if (info.canRenew === false) {
      showState("renew-blocked");
      return;
    }

    initialDaysLeft = info.daysLeft;
    document.getElementById("renew-platform-label").textContent = "Renovación — " + (info.platformTag || info.platform);
    document.getElementById("renew-form-label").textContent =
      "Para renovar " + (info.platformTag || info.platform) + " necesitamos estos datos:";

    if (info.needsEmail || info.needsPassword) {
      document.getElementById("renew-email").hidden = !info.needsEmail;
      document.getElementById("renew-password").hidden = !info.needsPassword;
      showState("renew-form");
      document.getElementById("renew-form-continue").onclick = () => {
        const email = document.getElementById("renew-email").value.trim();
        const password = document.getElementById("renew-password").value;
        if (info.needsEmail && !email) return alert("Falta tu correo.");
        if (info.needsPassword && !password) return alert("Falta tu contraseña.");
        createOrder(email, password);
      };
      return;
    }

    createOrder();
  }

  function renderPicker(accounts) {
    const list = document.getElementById("renew-picker-list");
    list.innerHTML = accounts.map((a, idx) => {
      const blocked = a.canRenew === false;
      const daysLabel = blocked
        ? (a.daysLeft <= 0 ? "Ya venció / vence hoy" : `Vence en ${a.daysLeft} día(s)`)
        : `Vence en ${a.daysLeft} día(s)`;
      return `
      <div class="renew-picker-item">
        <div class="renew-picker-info">
          <span class="renew-picker-name">${escapeHtml(a.platformTag || a.platform)}</span>
          <span class="renew-picker-days">${daysLabel}</span>
        </div>
        ${blocked
          ? `<a class="renew-picker-btn" href="https://liordark.com" style="text-decoration:none;">Cuenta nueva</a>`
          : `<button class="renew-picker-btn" type="button" data-idx="${idx}">Renovar</button>`}
      </div>
    `;
    }).join("");
    list.querySelectorAll(".renew-picker-btn[data-idx]").forEach(btn => {
      btn.addEventListener("click", () => {
        const account = accounts[Number(btn.dataset.idx)];
        selectedPlatform = account.platform;
        proceedWithAccount(account);
      });
    });
    showState("renew-picker");
  }

  // ─────────────────────────────────────────────────────────────
  // LINK DE PAGO CON VARIAS CUENTAS (?pack=CODE, 💬 Reno-manual del panel)
  // El cliente marca qué renovar (todo marcado al abrir). Cada selección
  // reserva un monto Yape (5 min); si se acaba sin pagar, se pide otro solo
  // (si la pestaña está a la vista; si no, al volver). Si cambia lo marcado,
  // se pide el monto de la nueva selección. El pago se detecta consultando
  // el link cada 4s con el nombre de la orden mostrada.
  // 10% de descuento a las plataformas sueltas si marca 2 o más (los combos
  // van completos a su precio) — el monto final lo calcula el servidor.
  // ─────────────────────────────────────────────────────────────
  const pack = (params.get("pack") || "").trim();
  const packPath = "/renew-pack/" + encodeURIComponent(pack);
  let packTimer = null;
  let packPoll = null;
  let packOrder = null;        // { name, amount, expiresAtMs }
  let packItems = [];
  let packSelected = new Set();
  let packRequesting = false;
  let packNeedsNewAmount = false;
  let packDebounce = null;
  let packDiscountMin = 2;
  let packDiscountPct = 10;

  function packStop() {
    if (packTimer) clearInterval(packTimer);
    if (packPoll) clearInterval(packPoll);
    packTimer = packPoll = null;
  }

  function packSuccess() {
    packStop();
    const n = packItems.filter(it => packSelected.has(it.key) || it.paid).length;
    document.getElementById("renew-success-text").textContent = n > 1
      ? `Se renovaron tus ${n} cuentas con las mismas que ya tenías. 🙌`
      : "Se renovó con la misma cuenta que ya tenías. 🙌";
    showState("renew-success");
  }

  function packLocalPricing() {
    const chosen = packItems.filter(it => !it.paid && packSelected.has(it.key));
    const singles = chosen.filter(i => i.kind === "single");
    const singlesSum = singles.reduce((s, i) => s + parseFloat(i.price), 0);
    const combosSum = chosen.filter(i => i.kind === "combo").reduce((s, i) => s + parseFloat(i.price), 0);
    const discount = singles.length >= packDiscountMin ? singlesSum * packDiscountPct / 100 : 0;
    return { count: chosen.length, singles: singles.length, discount, total: singlesSum + combosSum - discount };
  }

  function packRenderSummary() {
    const p = packLocalPricing();
    document.getElementById("renew-pack-count").textContent =
      p.count === 1 ? "1 cuenta" : p.count + " cuentas";
    document.getElementById("renew-pack-total").textContent = "S/ " + p.total.toFixed(2);
    const dRow = document.getElementById("renew-pack-discount-row");
    dRow.hidden = !(p.discount > 0);
    document.getElementById("renew-pack-discount-label").textContent = `Descuento ${packDiscountPct}% (${p.singles} plataformas)`;
    document.getElementById("renew-pack-discount").textContent = "−S/ " + p.discount.toFixed(2);
    const promo = document.getElementById("renew-pack-promo");
    const missing = packDiscountMin - p.singles;
    const singlesAvailable = packItems.filter(i => i.kind === "single" && !i.paid).length;
    promo.textContent = p.discount > 0
      ? `🎁 ¡Tienes ${packDiscountPct}% de descuento!`
      : (singlesAvailable >= packDiscountMin && missing > 0
          ? `🎁 Marca ${missing} más y te descontamos ${packDiscountPct}%`
          : `🎁 Renueva ${packDiscountMin} o más plataformas juntas y te descontamos ${packDiscountPct}%`);
    const none = p.count === 0;
    ["renew-pack-amount-label", "renew-pack-timer-row", "renew-pack-pay", "renew-pack-waiting"].forEach(id => {
      document.getElementById(id).hidden = none;
    });
    document.querySelector("#renew-pack .checkout-amount-row").hidden = none;
  }

  function packRenderList() {
    const list = document.getElementById("renew-pack-list");
    list.innerHTML = packItems.map((it, idx) => {
      const days = it.daysLeft === 1 ? "Vence mañana" : "Vence en " + it.daysLeft + " días";
      const sub = it.paid ? "✅ Ya renovada" : (it.kind === "combo" ? "Combo completo · " + days : days);
      const on = packSelected.has(it.key);
      return `
      <label class="renew-picker-item renew-pack-item ${it.paid ? "is-paid" : (on ? "" : "is-off")}">
        <span class="renew-pack-item-left">
          <input type="checkbox" data-idx="${idx}" ${it.paid ? "checked disabled" : (on ? "checked" : "")}>
          <span class="renew-picker-info">
            <span class="renew-picker-name">${escapeHtml(it.label)}${it.profileName ? " · " + escapeHtml(it.profileName) : ""}</span>
            <span class="renew-picker-days">${sub}</span>
          </span>
        </span>
        <span class="renew-pack-price">S/ ${escapeHtml(it.price)}</span>
      </label>`;
    }).join("");
    list.querySelectorAll("input[type=checkbox]:not([disabled])").forEach(cb => {
      cb.addEventListener("change", () => {
        const key = packItems[Number(cb.dataset.idx)].key;
        if (cb.checked) packSelected.add(key); else packSelected.delete(key);
        cb.closest(".renew-pack-item").classList.toggle("is-off", !cb.checked);
        packRenderSummary();
        clearTimeout(packDebounce);
        packDebounce = setTimeout(packRequestAmount, 500);
      });
    });
  }

  function packApply(data) {
    packDiscountMin = data.discountMin || packDiscountMin;
    packDiscountPct = data.discountPct || packDiscountPct;
    packItems = data.items || [];
    if (data.order) {
      const amountEl = document.getElementById("renew-pack-amount");
      const changed = amountEl.textContent !== "S/ " + data.order.amount;
      amountEl.textContent = "S/ " + data.order.amount;
      document.getElementById("renew-pack-amount-copy").dataset.copy = data.order.amount;
      if (changed) { amountEl.classList.remove("is-new"); void amountEl.offsetWidth; amountEl.classList.add("is-new"); }
    }
    packOrder = data.order || null;
    packRenderSummary();
  }

  function packTick() {
    if (!packOrder || packSelected.size === 0) return;
    const left = Math.max(0, packOrder.expiresAtMs - Date.now());
    const m = Math.floor(left / 60000);
    const sec = Math.floor((left % 60000) / 1000);
    document.getElementById("renew-pack-timer").textContent = m + ":" + String(sec).padStart(2, "0");
    if (left <= 30000) {
      if (document.visibilityState === "visible") packRequestAmount();
      else packNeedsNewAmount = true;
    }
  }

  async function packRequestAmount() {
    if (packRequesting) return;
    if (packSelected.size === 0) { packOrder = null; packRenderSummary(); return; }
    packRequesting = true;
    try {
      const data = await api(packPath + "/order", { method: "POST", body: { keys: [...packSelected] } });
      if (data.paid) return packSuccess();
      packApply(data);
      packNeedsNewAmount = false;
    } catch (err) {
      if (err.status === 404 || err.status === 410) { packStop(); showError(err.message); }
      // 409/502: el bot no pudo reservar ahora — se reintenta en el próximo tick.
    } finally {
      packRequesting = false;
    }
  }

  async function initPack() {
    showState("renew-loading");
    try {
      const first = await api(packPath);
      if (first.paid) { packItems = first.items || []; return packSuccess(); }
      packItems = first.items || [];
      packSelected = new Set(packItems.filter(it => !it.paid).map(it => it.key));
      const data = await api(packPath + "/order", { method: "POST", body: { keys: [...packSelected] } });
      if (data.paid) return packSuccess();
      packApply(data);
      packRenderList();
    } catch (err) {
      showError(err.message || "No se pudo abrir tu link. Intenta de nuevo en unos segundos.");
      return;
    }

    const { methods } = await api("/payment-methods").catch(() => ({ methods: [] }));
    const yape = (methods || []).find(m => m.name.toLowerCase().includes("yape"));
    const qrImg = document.getElementById("renew-pack-qr");
    if (yape && yape.imageUrl) { qrImg.src = yape.imageUrl; qrImg.hidden = false; } else { qrImg.hidden = true; }
    renderInfoRows(document.getElementById("renew-pack-instructions"), yape ? yape.description : "");

    showState("renew-pack");
    packTick();
    packTimer = setInterval(packTick, 1000);
    packPoll = setInterval(async () => {
      if (!packOrder) return;
      try {
        const data = await api(packPath + "?order=" + encodeURIComponent(packOrder.name));
        // También cuenta si pagó un monto anterior (otra selección) aún vigente.
        const newlyPaid = (data.items || []).some(it => it.paid && !packItems.find(p => p.key === it.key && p.paid));
        if (data.orderPaid || data.paid || newlyPaid) packSuccess();
      } catch (err) {
        if (err.status === 410 || err.status === 404) { packStop(); showError(err.message); }
      }
    }, POLL_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && packNeedsNewAmount) packRequestAmount();
    });
  }

  // ─────────────────────────────────────────────────────────────
  // UN SOLO LINK PARA TODOS (liordark.com/renovar): el cliente escribe su
  // celular y pasa directo a su link de pago con todo lo que vence.
  // ─────────────────────────────────────────────────────────────
  function initLookup() {
    const form = document.getElementById("renew-lookup");
    const input = document.getElementById("renew-lookup-phone");
    const errEl = document.getElementById("renew-lookup-error");
    const btn = document.getElementById("renew-lookup-btn");
    let saved = "";
    try { saved = localStorage.getItem("renew_phone") || ""; } catch { /* sin almacenamiento */ }
    if (saved) input.value = saved;
    showState("renew-lookup");
    input.focus();
    input.addEventListener("input", () => { errEl.hidden = true; });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const digits = input.value.replace(/\D/g, "").slice(-9);
      if (digits.length !== 9 || digits[0] !== "9") {
        errEl.textContent = "Escribe tu número de 9 dígitos (empieza con 9).";
        errEl.hidden = false;
        return;
      }
      btn.disabled = true;
      btn.textContent = "Buscando…";
      try {
        const { code: packCode } = await api("/renew-lookup", { method: "POST", body: { phone: digits } });
        try { localStorage.setItem("renew_phone", digits); } catch { /* sin almacenamiento */ }
        location.href = "/renovar.html?pack=" + encodeURIComponent(packCode);
      } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
        btn.disabled = false;
        btn.textContent = "Ver mis cuentas";
      }
    });
  }

  async function init() {
    if (pack) return initPack();
    if (!token && !code) return initLookup();

    try {
      const info = await api(renewBase);
      if (info.multi) {
        renderPicker(info.accounts);
        return;
      }
      proceedWithAccount(info);
    } catch (err) {
      showError(err.status === 410 || err.status === 404
        ? err.message
        : "No se pudo verificar tu link. Intenta de nuevo en unos segundos.");
    }
  }

  init();
})();
