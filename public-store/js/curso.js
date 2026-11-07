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


  async function load() {
    try {
      info = await api("/api/course/info");
    } catch {
      return;
    }
    if (!info.visible) { showSoon(); return; }
    const price = Number(info.price).toFixed(2);
    ["price", "price2", "price3"].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = price; });
    showLaunch();

    document.getElementById("eps").innerHTML = info.episodes.map(e => `
      <div class="l-ep ${e.n === 1 ? "first" : ""}">
        <span class="l-ep-n">${e.n}</span>
        <span class="l-ep-t">${esc(e.title)}</span>
        ${e.n === 1 ? `<span class="l-ep-free">Gratis</span>` : ""}
      </div>`).join("");

    if (!info.previewAvailable) {
      document.getElementById("play-icon").hidden = true;
      document.getElementById("preview-note").textContent = "Episodio 1 gratis · muy pronto";
      document.getElementById("watch-btn").hidden = true;
    }

    if (info.owned) {
      ["buy-btn", "buy-btn2", "buy-btn3"].forEach(id => {
        const b = document.getElementById(id);
        if (!b) return;
        b.textContent = "Ir a mi curso →";
        b.classList.add("owned");
      });
    }
    if (info.loggedIn) {
      try {
        const me = await api("/api/store/auth/me");
        if (me && me.phone) document.getElementById("user-label").textContent = maskPhone(me.phone);
      } catch { /* sin sesión */ }
    }
  }

  // Precio de lanzamiento: 2 semanas desde que se publica, luego sube solo.
  function showLaunch() {
    if (!info.launchActive || !(Number(info.regularPrice) > Number(info.price))) return;
    const regular = "S/ " + Number(info.regularPrice).toFixed(2);
    document.querySelectorAll("[data-regular]").forEach(el => { el.textContent = regular; el.hidden = false; });
    const until = info.launchEndsAt
      ? " hasta el " + new Date(info.launchEndsAt).toLocaleDateString("es-PE", { day: "numeric", month: "long" })
      : "";
    const note = document.getElementById("launch-note");
    note.innerHTML = `<b>Precio de lanzamiento</b>${esc(until)} · luego ${esc(regular)}`;
    note.hidden = false;
    const sub = document.getElementById("sticky-sub");
    if (sub) sub.textContent = "Precio de lanzamiento";
  }

  // Episodio 1 gratis: el video se carga recién al tocar play.
  function playPreview() {
    if (!info || !info.previewAvailable) return;
    const v = document.getElementById("preview-video");
    if (!v.src) {
      v.src = "/api/course/preview";
      v.addEventListener("contextmenu", e => e.preventDefault());
    }
    v.hidden = false;
    document.getElementById("preview-empty").hidden = true;
    v.play().catch(() => {});
  }
  document.getElementById("preview-empty").addEventListener("click", playPreview);
  document.getElementById("watch-btn").addEventListener("click", () => {
    document.getElementById("preview-section").scrollIntoView({ behavior: "smooth", block: "center" });
    playPreview();
  });

  // Curso en borrador: para el público todavía no existe.
  function showSoon() {
    document.getElementById("sticky-buy").hidden = true;
    document.querySelector(".sale").innerHTML = `
      <section class="l-box l-soon">
        ${mango(64)}
        <h1>Muy pronto</h1>
        <p>Estamos preparando el curso <b>Tus Primeros S/ 1,000</b>. Vuelve pronto.</p>
        ${info && info.loggedIn ? "" : `<button class="l-btn ghost" id="soon-login">¿Tienes acceso? Entrar</button>`}
        <a class="l-btn primary" href="/">Ir a la tienda</a>
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
  ["buy-btn", "buy-btn2", "buy-btn3"].forEach(id => document.getElementById(id).addEventListener("click", onBuy));

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
