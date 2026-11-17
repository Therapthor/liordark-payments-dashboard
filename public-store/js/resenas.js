// ─────────────────────────────────────────────────────────────
// Tienda: reseñas (carrusel) + preguntas frecuentes + «Deja tu reseña».
//  · Solo reseñas REALES: las que dejan clientes con compra (el dueño las
//    revisa y publica en el panel) o las que el dueño copia de un cliente.
//  · Carrusel con scroll-snap (se desliza con el dedo), flechas en PC y
//    avance solo cada 5 s mientras se ve y nadie lo toca.
// No toca app.js: se entera del inicio/cierre de sesión mirando el menú.
// ─────────────────────────────────────────────────────────────
(() => {
  "use strict";

  const SUPPORT_PHONE = "51963081436";
  const $ = (id) => document.getElementById(id);
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  async function getJson(url, opts) {
    const res = await fetch(url, { credentials: "include", ...opts });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.message || "No se pudo conectar. Intenta de nuevo."); e.status = res.status; throw e; }
    return data;
  }

  // ─── Preguntas frecuentes ───
  document.querySelectorAll(".faq-item > button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = btn.parentElement;
      const open = !item.classList.contains("open");
      item.parentElement.querySelectorAll(".faq-item.open").forEach((o) => {
        if (o === item) return;
        o.classList.remove("open");
        o.querySelector("button").setAttribute("aria-expanded", "false");
      });
      item.classList.toggle("open", open);
      btn.setAttribute("aria-expanded", String(open));
    });
  });
  const wl = $("faq-wholesale-link");
  if (wl) wl.href = "https://wa.me/" + SUPPORT_PHONE + "?text=" + encodeURIComponent("Hola! Quiero ser mayorista de Manguitope.");

  // Métodos de pago reales (los que están activos en el panel).
  getJson("/api/store/payment-methods").then(({ methods }) => {
    const names = [...new Set((methods || []).map((m) => String(m.name || "").trim()).filter(Boolean))];
    if (!names.length) return;
    const list = names.length === 1 ? names[0] : names.slice(0, -1).join(", ") + " y " + names[names.length - 1];
    $("faq-payments").textContent = "Aceptamos " + list + ". Al pagar te damos un monto exacto y el pago se confirma solo, en segundos.";
  }).catch(() => {});

  // ─── Carrusel de reseñas ───
  const section = $("reviews-section");
  const track = $("reviews-track");
  const dots = $("reviews-dots");
  let reviews = [];
  let mine = null; // { canReview, review }

  function starsHtml(n) {
    let h = "";
    for (let i = 1; i <= 5; i++) h += `<span class="${i <= n ? "on" : ""}">★</span>`;
    return `<div class="rs-stars" role="img" aria-label="${n} de 5 estrellas">${h}</div>`;
  }

  function cardHtml(r) {
    const initial = esc((r.author || "?").trim().charAt(0).toUpperCase());
    return `<article class="rs-card">
      ${starsHtml(r.stars)}
      <p class="rs-body">${esc(r.body)}</p>
      <div class="rs-who"><span class="rs-avatar" aria-hidden="true">${initial}</span>
        <span class="rs-who-txt"><b>${esc(r.author)}</b><small>${r.verified ? '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>Compra verificada' : "Cliente"}</small></span>
      </div>
    </article>`;
  }

  function renderReviews(summary) {
    if (!reviews.length) {
      // Sin reseñas publicadas: solo se muestra para quien puede dejar la primera.
      section.hidden = !(mine && mine.canReview && !mine.review);
      track.innerHTML = `<article class="rs-card rs-empty"><p class="rs-body">Todavía no hay reseñas publicadas. ¡Sé el primero en contarnos cómo te fue!</p></article>`;
      $("reviews-summary").textContent = "";
      dots.innerHTML = "";
      section.classList.add("rs-single");
      return;
    }
    section.hidden = false;
    section.classList.toggle("rs-single", reviews.length === 1);
    track.innerHTML = reviews.map(cardHtml).join("");
    const n = summary.count;
    $("reviews-summary").innerHTML = `<b>${Number(summary.avg).toFixed(1)}</b> <span class="rs-sum-star">★</span> · ${n} ${n === 1 ? "reseña" : "reseñas"}`;
    dots.innerHTML = reviews.map((_, i) => `<i class="${i === 0 ? "on" : ""}"></i>`).join("");
    updateArrows();
  }

  async function loadReviews() {
    try {
      const data = await getJson("/api/store/reviews");
      reviews = Array.isArray(data.reviews) ? data.reviews : [];
      renderReviews(data.summary || { count: reviews.length, avg: 0 });
    } catch { section.hidden = true; }
  }

  const cards = () => Array.from(track.querySelectorAll(".rs-card"));
  function currentIndex() {
    const list = cards();
    if (!list.length) return 0;
    const left = track.scrollLeft;
    let best = 0, bestD = Infinity;
    list.forEach((c, i) => { const d = Math.abs(c.offsetLeft - track.offsetLeft - left); if (d < bestD) { bestD = d; best = i; } });
    return best;
  }
  function atEnd() { return track.scrollLeft + track.clientWidth >= track.scrollWidth - 4; }
  function goTo(i) {
    const list = cards();
    if (!list.length) return;
    const idx = (i + list.length) % list.length;
    track.scrollTo({ left: list[idx].offsetLeft - track.offsetLeft, behavior: reduce ? "auto" : "smooth" });
  }
  function updateArrows() {
    const i = currentIndex();
    dots.querySelectorAll("i").forEach((d, k) => d.classList.toggle("on", k === i));
    $("reviews-prev").disabled = track.scrollLeft <= 4;
    $("reviews-next").disabled = atEnd();
  }
  let scrollRaf = 0;
  track.addEventListener("scroll", () => { cancelAnimationFrame(scrollRaf); scrollRaf = requestAnimationFrame(updateArrows); }, { passive: true });
  $("reviews-prev").addEventListener("click", () => { pause(); goTo(currentIndex() - 1); });
  $("reviews-next").addEventListener("click", () => { pause(); goTo(atEnd() ? 0 : currentIndex() + 1); });
  track.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") { e.preventDefault(); pause(); goTo(currentIndex() + 1); }
    if (e.key === "ArrowLeft") { e.preventDefault(); pause(); goTo(currentIndex() - 1); }
  });

  // Avance solo: cada 5 s, solo mientras se ve; se pausa al tocarlo.
  let timer = null, pausedUntil = 0, visible = false;
  function pause() { pausedUntil = Date.now() + 9000; }
  ["pointerdown", "touchstart", "wheel", "focusin"].forEach((ev) => track.addEventListener(ev, pause, { passive: true }));
  track.addEventListener("pointerenter", pause);
  function tick() {
    if (!visible || document.hidden || Date.now() < pausedUntil || cards().length < 2) return;
    goTo(atEnd() ? 0 : currentIndex() + 1);
  }
  if (!reduce && "IntersectionObserver" in window) {
    new IntersectionObserver((es) => { visible = es.some((e) => e.isIntersecting); }, { threshold: 0.35 }).observe(track);
    timer = setInterval(tick, 5000);
  }

  // ─── «Deja tu reseña» (clientes con compra) ───
  const modal = $("review-modal");
  let stars = 0;
  function paintStars(n) {
    stars = n;
    $("review-stars").querySelectorAll("button").forEach((b) => {
      const on = Number(b.dataset.v) <= n;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(Number(b.dataset.v) === n));
    });
  }
  $("review-stars").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (!b) return;
    paintStars(Number(b.dataset.v));
    b.classList.remove("pop"); void b.offsetWidth; b.classList.add("pop");
  });
  function setErr(msg) { const el = $("review-error"); el.textContent = msg || ""; el.hidden = !msg; }

  function openModal() {
    const r = mine && mine.review;
    paintStars(r ? r.stars : 0);
    $("review-author").value = r ? r.author : "";
    $("review-body").value = r ? r.body : "";
    $("review-send").disabled = false;
    $("review-send").textContent = r ? "Guardar cambios" : "Enviar reseña";
    setErr("");
    modal.hidden = false;
    setTimeout(() => { if (!stars) $("review-stars").querySelector("button").focus({ preventScroll: true }); }, 60);
  }
  function closeModal() { modal.hidden = true; }
  $("review-close").addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) closeModal(); });
  $("reviews-cta").addEventListener("click", openModal);
  $("review-ask-btn").addEventListener("click", openModal);

  $("review-send").addEventListener("click", async () => {
    if (!stars) { setErr("Elige cuántas estrellas le das."); return; }
    const btn = $("review-send");
    btn.disabled = true; btn.textContent = "Enviando…"; setErr("");
    try {
      const { review } = await getJson("/api/store/my-review", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stars, author: $("review-author").value, body: $("review-body").value }),
      });
      mine = { canReview: true, review };
      paintAsk();
      btn.textContent = "¡Gracias! 💛";
      setTimeout(closeModal, 1100);
    } catch (err) {
      btn.disabled = false; btn.textContent = "Enviar reseña";
      setErr(err.message);
    }
  });

  function paintAsk() {
    const ask = $("review-ask");
    const can = !!(mine && mine.canReview);
    ask.hidden = !can;
    $("reviews-cta").hidden = !can || !!(mine && mine.review);
    if (!can) return;
    const r = mine.review;
    $("review-ask-title").textContent = r ? "¡Gracias por tu reseña!" : "¿Qué tal tu experiencia?";
    $("review-ask-sub").textContent = !r ? "Cuéntanos en una reseña, nos ayuda muchísimo."
      : r.status === "publicada" ? "Ya está publicada en la tienda." : "La estamos revisando para publicarla.";
    $("review-ask-btn").textContent = r ? "Editar" : "Dejar reseña";
    $("review-ask-btn").className = r ? "btn-ghost btn-sm" : "btn-primary btn-sm";
  }

  async function loadMine() {
    try { mine = await getJson("/api/store/my-review"); }
    catch { mine = null; }
    paintAsk();
    if (!reviews.length) renderReviews({ count: 0, avg: 0 });
  }

  // Inicio / cierre de sesión: app.js muestra u oculta el menú de cliente.
  const authBox = $("nav-auth-actions");
  let lastAuthed = null;
  function onAuthChange() {
    const authed = !!authBox && !authBox.hidden;
    if (authed === lastAuthed) return;
    lastAuthed = authed;
    if (authed) loadMine();
    else { mine = null; paintAsk(); if (!reviews.length) renderReviews({ count: 0, avg: 0 }); }
  }
  if (authBox) new MutationObserver(onAuthChange).observe(authBox, { attributes: true, attributeFilter: ["hidden"] });

  loadReviews().then(onAuthChange);
})();
