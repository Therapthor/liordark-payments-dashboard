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
    ["renew-loading", "renew-error", "renew-form", "renew-ready", "renew-success"].forEach(s => {
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

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(async () => {
      try {
        const info = await api(renewBase);
        if (initialDaysLeft !== null && info.daysLeft > initialDaysLeft) {
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
        body: { clientEmail, clientPassword },
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

  async function init() {
    if (!token && !code) {
      showError("Este link no es válido. Entra a liordark.com para renovar.");
      return;
    }

    try {
      const info = await api(renewBase);
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

      await createOrder();
    } catch (err) {
      showError(err.status === 410 || err.status === 404
        ? err.message
        : "No se pudo verificar tu link. Intenta de nuevo en unos segundos.");
    }
  }

  init();
})();
