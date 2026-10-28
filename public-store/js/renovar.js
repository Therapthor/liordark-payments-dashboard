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
    ["renew-loading", "renew-error", "renew-blocked", "renew-picker", "renew-form", "renew-ready", "renew-success"].forEach(s => {
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

  async function init() {
    if (!token && !code) {
      showError("Este link no es válido. Entra a liordark.com para renovar.");
      return;
    }

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
