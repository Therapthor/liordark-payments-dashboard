// Helpers compartidos por /curso (venta) y /curso/aprender (aula).
window.Curso = (() => {
  "use strict";

  const SUPPORT_PHONE = "51963081436";

  async function api(path, options = {}) {
    const res = await fetch(path, {
      credentials: "include",
      headers: options.body ? { "Content-Type": "application/json" } : {},
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || "Algo falló. Intenta de nuevo.");
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function esc(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // Manguito: mango pixel con lentes (cuadrícula 10x10).
  function mango(size = 40) {
    const rows = ["....GG....", "...GG.....", "..OOOOOO..", ".OOOOOOOO.", "OKKKOOKKKO", "OKKKKKKKKO", "OOOOOOOOOO", ".OOOOOOOY.", "..OOOOYY..", "...OOOO..."];
    const col = { O: "#F5941E", G: "#3FA34D", K: "#241A10", Y: "#FFD373" };
    let rects = "";
    rows.forEach((row, y) => [...row].forEach((c, x) => {
      if (col[c]) rects += `<rect x="${x}" y="${y}" width="1.05" height="1.05" fill="${col[c]}"/>`;
    }));
    return `<svg class="mango" width="${size}" height="${size}" viewBox="0 0 10 10" shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`;
  }

  function maskPhone(phone) {
    const d = String(phone || "").replace(/\D/g, "").slice(-9);
    return d.length === 9 ? d[0] + "•• ••• " + d.slice(-3) : "";
  }

  function prettyPhone(phone) {
    const d = String(phone || "").replace(/\D/g, "").slice(-9);
    return d.length === 9 ? "+51 " + d.slice(0, 3) + " " + d.slice(3, 6) + " " + d.slice(6) : d;
  }

  // Mapa de pasos: 1 INICIO · 2 ENTENDER · 3 PLANEAR · 4 GESTIONAR · 5 FIDELIZAR,
  // con Manguito parado sobre el paso actual.
  function stepmap(steps, current, doneSet) {
    let html = "";
    steps.forEach((s, i) => {
      const n = i + 1;
      const done = doneSet.has(n);
      const cur = n === current;
      html += `<div class="st ${done ? "done" : ""} ${cur ? "cur" : ""}">
        ${cur ? `<span class="walker">${mango(26)}</span>` : ""}
        <span class="dot">${done && !cur ? "✓" : n}</span>
        <span class="lbl">${esc(s)}</span>
      </div>`;
      if (n < steps.length) html += `<span class="line ${done ? "done" : ""}"></span>`;
    });
    return html;
  }

  let toastTimer = null;
  function toast(text) {
    let el = document.getElementById("c-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "c-toast";
      el.className = "toast";
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast("✓ Copiado"); }
    catch {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); toast("✓ Copiado"); } catch { /* nada */ }
      ta.remove();
    }
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
  }

  // Formulario de ingreso (celular + PIN). Mismo endpoint que la tienda:
  // si el celular no tiene cuenta, la crea con ese PIN.
  function bindLogin(form, onDone) {
    const err = form.querySelector(".form-err");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.hidden = true;
      const phone = form.phone.value.replace(/\D/g, "");
      const pin = form.pin.value.replace(/\D/g, "");
      if (!/^9\d{8}$/.test(phone.slice(-9)) || phone.length < 9) {
        err.textContent = "Escribe tu celular de 9 dígitos (empieza con 9).";
        err.hidden = false; return;
      }
      if (!/^\d{4}$/.test(pin)) {
        err.textContent = "El PIN es de 4 números.";
        err.hidden = false; return;
      }
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        await api("/api/store/auth/quick", { method: "POST", body: { phone: phone.slice(-9), password: pin } });
        onDone();
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      } finally {
        btn.disabled = false;
      }
    });
  }

  function loginFormHtml(title, hint) {
    return `<form class="login-form" novalidate>
      ${title ? `<h3>${esc(title)}</h3>` : ""}
      <p class="muted" style="margin:0 0 12px;font-size:13px">${esc(hint)}</p>
      <div class="field"><label>Tu celular</label><input name="phone" inputmode="numeric" autocomplete="tel" maxlength="12" placeholder="987 654 321"></div>
      <div class="field" style="margin-top:10px"><label>PIN de 4 dígitos</label><input name="pin" type="password" inputmode="numeric" autocomplete="current-password" maxlength="4" placeholder="••••"></div>
      <p class="form-err" hidden style="margin-top:10px"></p>
      <button type="submit" class="c-btn orange block" style="margin-top:14px">Continuar</button>
    </form>`;
  }

  function supportLink(text) {
    return "https://wa.me/" + SUPPORT_PHONE + "?text=" + encodeURIComponent(text);
  }

  return { api, esc, mango, maskPhone, prettyPhone, stepmap, toast, copy, fmtTime, bindLogin, loginFormHtml, supportLink, SUPPORT_PHONE };
})();
