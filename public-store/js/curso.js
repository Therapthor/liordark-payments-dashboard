// /curso — página de venta: Ep1 gratis, mapa de pasos, compra con Yape.
(() => {
  "use strict";
  const { api, esc, mango, maskPhone, stepmap, copy, fmtTime, bindLogin, loginFormHtml, supportLink } = window.Curso;

  const PAY_WINDOW_MS = 5 * 60 * 1000;   // el monto reservado vale 5 min
  const POLL_MS = 4000;
  const POLL_MAX_MS = 15 * 60 * 1000;    // se sigue revisando un rato más

  let info = null;
  let pollTimer = null;
  let countdownTimer = null;

  document.getElementById("brand").insertAdjacentHTML("afterbegin", mango(30));

  async function load() {
    try {
      info = await api("/api/course/info");
    } catch {
      return;
    }
    if (!info.visible) { showSoon(); return; }
    const price = Number(info.price).toFixed(2);
    document.getElementById("price").textContent = price;
    document.getElementById("price2").textContent = price;
    document.getElementById("stepmap").innerHTML = stepmap(info.steps, 1, new Set());

    document.getElementById("eps").innerHTML = info.episodes.map(e => `
      <div class="card ep-card">
        <span class="kick">${e.n === 1 ? "EPISODIO 1 · INICIO" : "PASO " + (e.n - 1) + " · " + esc(e.step)}</span>
        <b>${esc(e.title)}</b>
        <p>${esc(e.summary)}</p>
        <span class="lockline">${e.n === 1 ? "▶ Gratis" : info.owned ? "✓ Incluido" : "🔒 Con el curso"}</span>
      </div>`).join("");

    if (info.previewAvailable) {
      const v = document.getElementById("preview-video");
      v.src = "/api/course/preview";
      v.hidden = false;
      document.getElementById("preview-empty").hidden = true;
      v.addEventListener("contextmenu", e => e.preventDefault());
    }

    if (info.owned) {
      ["buy-btn", "buy-btn2"].forEach(id => {
        const b = document.getElementById(id);
        b.textContent = "Ir a mi curso →";
        b.classList.remove("orange");
        b.classList.add("green");
      });
    }
    if (info.loggedIn) {
      try {
        const me = await api("/api/store/auth/me");
        if (me && me.phone) document.getElementById("user-label").textContent = maskPhone(me.phone);
      } catch { /* sin sesión */ }
    }
  }

  // Curso en borrador: para el público todavía no existe.
  function showSoon() {
    document.getElementById("sticky-buy").hidden = true;
    document.querySelector(".sale").innerHTML = `
      <section class="card gate" style="align-items:center;text-align:center">
        ${mango(72)}
        <h1>MUY PRONTO</h1>
        <p class="muted" style="margin:0">Estamos preparando el curso <b>Tus Primeros S/ 1,000</b>. Vuelve pronto.</p>
        ${info && info.loggedIn ? "" : `<button class="c-btn block" id="soon-login">¿Tienes acceso? Entrar</button>`}
        <a class="c-btn orange block" href="/">Ir a la tienda</a>
      </section>`;
    const btn = document.getElementById("soon-login");
    if (btn) btn.addEventListener("click", () => {
      openModal(loginFormHtml("Entrar", "Con tu celular y tu PIN de Manguitope."));
      bindLogin(body.querySelector("form"), () => location.reload());
    });
  }

  // ─── Compra ────────────────────────────────────────────────

  const modal = document.getElementById("buy-modal");
  const body = document.getElementById("buy-body");

  function openModal(html) {
    body.innerHTML = html;
    modal.hidden = false;
  }

  function closeModal() {
    modal.hidden = true;
    stopTimers();
  }

  function stopTimers() {
    clearInterval(pollTimer); pollTimer = null;
    clearInterval(countdownTimer); countdownTimer = null;
  }

  document.getElementById("buy-close").addEventListener("click", closeModal);
  modal.addEventListener("click", e => { if (e.target === modal) closeModal(); });

  function onBuy() {
    if (info && info.owned) { location.href = "/curso/aprender/"; return; }
    if (info && info.loggedIn) { startCheckout(); return; }
    openModal(loginFormHtml("Entra para comprar", "Si ya compraste en Manguitope, usa tu mismo PIN. Si es tu primera vez, crea un PIN de 4 números."));
    bindLogin(body.querySelector("form"), async () => {
      if (info) info.loggedIn = true;
      await load();
      if (info && info.owned) { location.href = "/curso/aprender/"; return; }
      startCheckout();
    });
  }
  document.getElementById("buy-btn").addEventListener("click", onBuy);
  document.getElementById("buy-btn2").addEventListener("click", onBuy);

  async function startCheckout() {
    stopTimers();
    openModal(`<div class="pay-wait"><span class="spin"></span> Preparando tu pago…</div>`);
    let order;
    try {
      order = await api("/api/course/checkout", { method: "POST" });
    } catch (err) {
      if (err.data && err.data.owned) { location.href = "/curso/aprender/"; return; }
      openModal(`<h3>No se pudo crear el pago</h3><p class="form-err">${esc(err.message)}</p>
        <button class="c-btn orange block" id="retry" style="margin-top:12px">Intentar de nuevo</button>`);
      body.querySelector("#retry").addEventListener("click", startCheckout);
      return;
    }

    let yape = null;
    try {
      const { methods } = await api("/api/store/payment-methods");
      yape = (methods || []).find(m => String(m.name).toLowerCase().includes("yape")) || null;
    } catch { /* sin QR, igual se puede pagar */ }

    openModal(`
      <h3>Paga con Yape</h3>
      <p class="muted" style="margin:0;font-size:13px">Yapea <b>exactamente</b> este monto (con los céntimos), así se confirma solo:</p>
      <div class="pay-amount"><b>S/ ${esc(order.amount)}</b><button class="c-btn small" id="copy-amount">Copiar</button></div>
      ${yape && yape.imageUrl ? `<img class="pay-qr" src="${esc(yape.imageUrl)}" alt="QR de Yape">` : ""}
      ${yape && yape.description ? `<div class="pay-info">${esc(yape.description)}</div>` : ""}
      <div class="pay-wait" id="pay-wait"><span class="spin"></span> <span id="pay-wait-text">Esperando tu pago…</span></div>
      <p class="muted" style="text-align:center;font-size:12px;margin:0">Este monto vale <b id="pay-left">5:00</b></p>
      <div id="pay-expired" hidden style="margin-top:12px;display:flex;flex-direction:column;gap:8px">
        <button class="c-btn orange block" id="pay-new">Generar un nuevo monto</button>
      </div>
      <p style="text-align:center;font-size:12px;margin:12px 0 0"><a href="${supportLink("Hola, tengo dudas con mi pago del curso (S/ " + order.amount + ").")}" target="_blank" rel="noopener">¿Problemas con el pago? Escríbenos</a></p>
    `);
    body.querySelector("#copy-amount").addEventListener("click", () => copy(order.amount));
    body.querySelector("#pay-new").addEventListener("click", startCheckout);

    const started = Date.now();
    countdownTimer = setInterval(() => {
      const left = PAY_WINDOW_MS - (Date.now() - started);
      const el = document.getElementById("pay-left");
      if (el) el.textContent = fmtTime(left / 1000);
      if (left <= 0) {
        clearInterval(countdownTimer); countdownTimer = null;
        const t = document.getElementById("pay-wait-text");
        if (t) t.textContent = "¿Ya yapeaste? Seguimos revisando…";
        const ex = document.getElementById("pay-expired");
        if (ex) ex.hidden = false;
      }
    }, 1000);

    pollTimer = setInterval(async () => {
      if (Date.now() - started > POLL_MAX_MS) { clearInterval(pollTimer); pollTimer = null; return; }
      try {
        const st = await api("/api/course/checkout/" + encodeURIComponent(order.orderName));
        if (st.paid) showPaid();
      } catch { /* red momentánea */ }
    }, POLL_MS);
  }

  function showPaid() {
    stopTimers();
    if (info) info.owned = true;
    openModal(`
      <div style="display:flex;flex-direction:column;align-items:center;gap:12px;text-align:center">
        ${mango(72)}
        <h3 class="pix" style="font-size:13px;line-height:1.6">¡PAGO CONFIRMADO!</h3>
        <p style="margin:0">Ya tienes el curso de por vida. ¡A ganar tus primeros S/ 1,000!</p>
        <a class="c-btn green block big" href="/curso/aprender/">Empezar el curso →</a>
      </div>`);
  }

  load();
})();
