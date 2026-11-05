// /curso/aprender — aula: video protegido, progreso por alumno y recursos
// que aparecen sincronizados con el video (cues).
(() => {
  "use strict";
  const { api, esc, mango, maskPhone, prettyPhone, stepmap, toast, copy, fmtTime, bindLogin, loginFormHtml, supportLink } = window.Curso;

  const SAVE_EVERY_MS = 10000;
  const RES_META = {
    mayorista: { icon: "🏪", lockText: "Panel Mayorista + S/ 10 de regalo", hint: "↓ Tu acceso mayorista ya está disponible" },
    plantilla: { icon: "📊", lockText: "Gestor de cuentas (Excel)", hint: "↓ Tu plantilla ya está disponible" },
    cupon:     { icon: "🎟️", lockText: "Cupón −30% curso avanzado", hint: "↓ Tu cupón −30% ya está disponible" },
  };
  const RES_ORDER = ["mayorista", "plantilla", "cupon"];

  let me = null;
  let current = 1;
  const progress = new Map();   // ep → { lastSecond, maxSecond, duration, completed }
  let unlocks = new Set();
  let completedAll = false;
  const mayo = { state: "button", phone: "", panelName: "", error: "", result: null };
  let couponError = "";

  const video = document.getElementById("video");
  const player = document.getElementById("player");

  document.getElementById("brand").insertAdjacentHTML("afterbegin", mango(30));
  document.getElementById("video-empty-mango").innerHTML = mango(84);
  document.getElementById("finish-mango").innerHTML = mango(80);

  // ─── Carga inicial ─────────────────────────────────────────

  async function init() {
    let auth;
    try { auth = await api("/api/store/auth/me"); } catch { auth = { authenticated: false }; }
    if (!auth.authenticated) { showLogin(); return; }
    document.getElementById("user-label").textContent = maskPhone(auth.phone);

    try { me = await api("/api/course/me"); }
    catch (err) {
      if (err.status === 401) { showLogin(); return; }
      toast(err.message); return;
    }
    if (!me.owned) { document.getElementById("gate-buy").hidden = false; return; }

    me.progress.forEach(p => progress.set(p.episode, p));
    unlocks = new Set(me.unlocks);
    completedAll = me.completedAll;
    mayo.phone = String(me.phone || "").replace(/\D/g, "").slice(-9);
    if (me.claim) mayo.state = "claimed";

    document.getElementById("watermark").textContent = prettyPhone(me.phone);
    moveWatermark();
    setInterval(moveWatermark, 25000);

    document.getElementById("aula").hidden = false;
    current = pickStartEpisode();
    renderAllResources();
    selectEpisode(current, false);
  }

  function showLogin() {
    const box = document.getElementById("gate-login");
    box.innerHTML = `<h1>ENTRA A TU CURSO</h1>` + loginFormHtml("", "Usa el celular y el PIN con los que compraste.");
    box.hidden = false;
    bindLogin(box.querySelector("form"), () => { box.hidden = true; init(); });
  }

  function pickStartEpisode() {
    const eps = me.episodes.map(e => e.n);
    const inProgress = eps.find(n => { const p = progress.get(n); return p && !p.completed && p.lastSecond > 5; });
    if (inProgress) return inProgress;
    const pending = eps.find(n => !(progress.get(n) || {}).completed);
    return pending || 1;
  }

  function episode(n) { return me.episodes.find(e => e.n === n); }

  function doneSet() {
    return new Set([...progress.values()].filter(p => p.completed).map(p => p.episode));
  }

  // ─── Cabecera: mapa + progreso ─────────────────────────────

  function renderTop() {
    const done = doneSet();
    document.getElementById("stepmap").innerHTML = stepmap(me.steps, current, done);
    const n = done.size;
    document.getElementById("progress-label").textContent = `Progreso del curso: ${n}/${me.episodes.length}`;
    document.getElementById("progress-bar").style.width = (n / me.episodes.length * 100) + "%";
    const p = progress.get(current);
    document.getElementById("resume-label").textContent = completedAll
      ? "🏆 Curso completado"
      : p && p.lastSecond > 5 && !p.completed ? "Continúa donde te quedaste · " + fmtTime(p.lastSecond) : "";
  }

  function renderEpList() {
    document.getElementById("ep-list").innerHTML = me.episodes.map(e => {
      const p = progress.get(e.n) || {};
      const done = !!p.completed;
      const cur = e.n === current;
      const mark = cur ? "▶" : done ? "✓" : e.n;
      const dur = p.duration ? fmtTime(p.duration) : "";
      return `<button class="ep-row ${done ? "done" : ""} ${cur ? "cur" : ""}" data-ep="${e.n}">
        <span class="mk">${mark}</span><span class="t">${e.n}. ${esc(e.title)}</span><span class="d">${dur}</span></button>`;
    }).join("");
  }

  document.getElementById("ep-list").addEventListener("click", e => {
    const row = e.target.closest("[data-ep]");
    if (row) selectEpisode(Number(row.dataset.ep), true);
  });
  document.getElementById("ep-prev").addEventListener("click", () => selectEpisode(current - 1, true));
  document.getElementById("ep-next").addEventListener("click", () => selectEpisode(current + 1, true));

  // ─── Video ─────────────────────────────────────────────────

  let urlRetry = false;
  let lastSaveAt = 0;

  async function selectEpisode(n, autoplay) {
    if (!episode(n)) return;
    if (!video.paused) saveProgress();
    current = n;
    const ep = episode(n);
    document.getElementById("ep-kicker").textContent = n === 1 ? "EPISODIO 1 · INICIO" : `PASO ${n - 1} · ${ep.step}`;
    document.getElementById("ep-title").textContent = ep.title;
    document.getElementById("ep-summary").textContent = ep.summary;
    document.getElementById("ep-prev").disabled = n === 1;
    document.getElementById("ep-next").disabled = n === me.episodes.length;
    renderTop();
    renderEpList();
    renderAllResources();
    hideHint();

    video.pause();
    video.removeAttribute("src");
    video.load();
    if (!ep.available) {
      video.hidden = true;
      document.getElementById("video-empty").hidden = false;
      document.getElementById("video-empty-text").textContent = `EPISODIO ${n} · MUY PRONTO`;
      return;
    }
    document.getElementById("video-empty").hidden = false;
    document.getElementById("video-empty-text").textContent = "CARGANDO…";
    try {
      const { url } = await api("/api/course/video/" + n, { method: "POST" });
      if (current !== n) return;
      urlRetry = false;
      await loadSource(url, null, autoplay);
    } catch (err) {
      document.getElementById("video-empty-text").textContent = err.message.toUpperCase();
    }
  }

  function loadSource(url, atSecond, autoplay) {
    return new Promise(resolve => {
      video.src = url;
      video.hidden = false;
      video.addEventListener("loadedmetadata", () => {
        document.getElementById("video-empty").hidden = true;
        const p = progress.get(current);
        let t = atSecond;
        if (t === null && p && p.lastSecond > 5 && p.lastSecond < video.duration * 0.95) t = p.lastSecond;
        if (t) video.currentTime = t;
        if (autoplay) video.play().catch(() => {});
        resolve();
      }, { once: true });
    });
  }

  // El link del video vence (4 h): si falla, se pide uno nuevo y se sigue
  // desde el mismo segundo.
  video.addEventListener("error", async () => {
    if (urlRetry || !video.getAttribute("src")) return;
    urlRetry = true;
    const at = video.currentTime;
    try {
      const { url } = await api("/api/course/video/" + current, { method: "POST" });
      await loadSource(url, at, true);
    } catch { toast("No se pudo cargar el video. Recarga la página."); }
  });

  video.addEventListener("contextmenu", e => e.preventDefault());
  player.addEventListener("contextmenu", e => e.preventDefault());

  video.addEventListener("timeupdate", () => {
    checkCues(video.currentTime);
    if (!video.paused && Date.now() - lastSaveAt > SAVE_EVERY_MS) saveProgress();
  });
  video.addEventListener("pause", () => saveProgress());
  video.addEventListener("ended", () => saveProgress(true));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && video.getAttribute("src") && video.currentTime > 0) beaconProgress();
  });

  // Pantalla completa sobre el contenedor (no solo el <video>) para que la
  // marca de agua con el celular siga visible.
  document.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement === video && player.requestFullscreen) {
      player.requestFullscreen().catch(() => {});
    }
  });

  function progressBody(ended) {
    const duration = video.duration || 0;
    return { episode: current, second: ended ? duration : video.currentTime, duration };
  }

  async function saveProgress(ended = false) {
    if (!video.getAttribute("src") || !video.duration) return;
    lastSaveAt = Date.now();
    const ep = current;
    try {
      const r = await api("/api/course/progress", { method: "POST", body: progressBody(ended) });
      progress.set(ep, r.progress);
      const newUnlocks = r.unlocks.filter(id => !unlocks.has(id));
      unlocks = new Set(r.unlocks);
      if (newUnlocks.length) newUnlocks.forEach(id => { const t = cueType(id); if (t) reveal(t); });
      renderTop();
      renderEpList();
      if (r.completedAll && !completedAll) {
        completedAll = true;
        // Episodios vistos en otro dispositivo: se recarga el progreso real.
        try {
          const fresh = await api("/api/course/me");
          fresh.progress.forEach(p => progress.set(p.episode, p));
        } catch { /* se queda con lo local */ }
        renderTop();
        renderEpList();
        showFinish();
      }
    } catch { /* se reintenta en el próximo guardado */ }
  }

  function beaconProgress() {
    if (!video.duration) return;
    try {
      const blob = new Blob([JSON.stringify(progressBody(false))], { type: "application/json" });
      navigator.sendBeacon("/api/course/progress", blob);
    } catch { /* nada */ }
  }

  function moveWatermark() {
    const wm = document.getElementById("watermark");
    wm.style.left = (6 + Math.random() * 62) + "%";
    wm.style.top = (6 + Math.random() * 72) + "%";
  }

  // ─── Cues: recursos sincronizados con el video ─────────────

  function cueType(id) {
    for (const e of me.episodes) for (const c of e.cues) if (c.id === id) return c.type;
    return null;
  }

  function typeUnlocked(type) {
    return me.episodes.some(e => e.cues.some(c => c.type === type && unlocks.has(c.id)));
  }

  function typeEpisode(type) {
    const e = me.episodes.find(ep => ep.cues.some(c => c.type === type));
    return e ? e.n : null;
  }

  function checkCues(t) {
    const ep = episode(current);
    if (!ep) return;
    for (const c of ep.cues) {
      if (t >= c.start && !unlocks.has(c.id)) {
        unlocks.add(c.id);
        api("/api/course/unlock", { method: "POST", body: { cueId: c.id } }).catch(() => {});
        reveal(c.type);
      }
      const box = document.getElementById("res-" + c.type);
      if (box && box.firstElementChild) box.firstElementChild.classList.toggle("live", t >= c.start && t <= c.end);
    }
  }

  function reveal(type) {
    renderResource(type, true);
    const box = document.getElementById("res-" + type);
    const list = document.getElementById("resources");
    if (box && list.firstElementChild !== box) list.prepend(box);
    if (window.matchMedia("(max-width: 900px)").matches) showHint(type);
  }

  let hintTimer = null;
  function showHint(type) {
    const el = document.getElementById("mobile-hint");
    el.textContent = RES_META[type].hint;
    el.dataset.type = type;
    el.hidden = false;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(hideHint, 15000);
  }
  function hideHint() { document.getElementById("mobile-hint").hidden = true; }
  document.getElementById("mobile-hint").addEventListener("click", e => {
    const box = document.getElementById("res-" + e.currentTarget.dataset.type);
    if (box) box.scrollIntoView({ behavior: "smooth", block: "center" });
    hideHint();
  });

  // ─── Paneles de recursos ───────────────────────────────────

  function renderAllResources() {
    const list = document.getElementById("resources");
    // Primero los del episodio actual; después el resto en orden.
    const order = [...RES_ORDER].sort((a, b) => (typeEpisode(b) === current) - (typeEpisode(a) === current));
    list.innerHTML = order.filter(t => typeEpisode(t) !== null).map(t => `<div id="res-${t}"></div>`).join("");
    order.forEach(t => renderResource(t, false));
  }

  function renderResource(type, animate) {
    const box = document.getElementById("res-" + type);
    if (!box) return;
    if (!typeUnlocked(type)) {
      const n = typeEpisode(type);
      box.innerHTML = `<div class="res-locked"><span class="i">${RES_META[type].icon}</span>
        <span>${RES_META[type].lockText} — se desbloquea en el episodio ${n}</span><span class="l">🔒</span></div>`;
      return;
    }
    const html = type === "plantilla" ? plantillaHtml() : type === "mayorista" ? mayoristaHtml() : cuponHtml();
    box.innerHTML = `<div class="card res ${animate ? "reveal" : ""}"><span class="shine"></span>${html}</div>`;
    bindResource(type, box);
  }

  function plantillaHtml() {
    const btn = !me.gestorAvailable
      ? `<button class="c-btn block" disabled>La plantilla se está subiendo…</button>`
      : me.gestorDownloaded
        ? `<a class="c-btn done block" href="/api/course/resource/gestor" data-dl>✓ Descargada · Descargar de nuevo</a>`
        : `<a class="c-btn orange block pulse" href="/api/course/resource/gestor" data-dl>⬇ Descargar plantilla gratis</a>`;
    return `<div class="tags"><span class="tag g">GRATIS</span><span class="tag d">SIN PUBLICIDAD</span></div>
      <div class="res-head"><span style="font-size:34px">📊</span><b>Tu gestor de cuentas streaming</b></div>
      <p>Plantilla de Excel para organizar a tus clientes, perfiles, vencimientos y ganancias.</p>${btn}`;
  }

  function mayoristaHtml() {
    const head = `<div class="res-head"><span class="ico" style="background:var(--green)">🏪</span><b>Crea tu acceso al Panel Mayorista</b></div>
      <p>Incluye <b style="color:var(--brown)">S/ 10 de saldo de regalo</b> para tu primera compra.</p>`;
    const err = mayo.error ? `<p class="err">${esc(mayo.error)}</p>` : "";
    switch (mayo.state) {
      case "claimed":
        return head + `<div class="ok-box"><b>✓ Ya creaste tu acceso mayorista</b>
          <span>Con el celular <b>${esc(me.claim ? me.claim.maskedPhone : "")}</b></span></div>
          <a class="c-btn dark block" href="https://mayorista.liordark.com" target="_blank" rel="noopener">Entrar al Panel Mayorista →</a>`;
      case "form":
        return head + `<form data-mayo-form novalidate style="display:flex;flex-direction:column;gap:8px">
          <label>Número de celular</label>
          <input name="phone" inputmode="numeric" maxlength="9" value="${esc(mayo.phone)}" placeholder="987654321">
          <label>Nombre de tu panel</label>
          <input name="panelName" maxlength="30" value="${esc(mayo.panelName)}" placeholder="Ej. Streaming Rosa">
          <div class="warn">⚠️ Solo puedes hacerlo 1 vez por compra. Revisa bien tus datos.</div>
          <span class="muted" style="font-size:12px">Si ese celular ya tiene Panel Mayorista, no se crea otro: te sumamos los S/ 10 a tu panel.</span>
          ${err}
          <button type="submit" class="c-btn green block">Continuar</button></form>`;
      case "confirm":
        return head + `<div class="confirm-box"><b>¿Tus datos son correctos?</b>
          <span>📱 ${esc(mayo.phone.replace(/(\d{3})(\d{3})(\d{3})/, "$1 $2 $3"))}</span><span>🏷️ ${esc(mayo.panelName)}</span></div>
          ${err}
          <div class="row2"><button class="c-btn green" data-mayo="create">Sí, crear</button><button class="c-btn" data-mayo="edit">Corregir</button></div>`;
      case "sending":
        return head + `<div class="pay-wait"><span class="spin"></span> Creando tu acceso…</div>`;
      case "done": {
        const r = mayo.result;
        if (!r.createdNew && r.disabled) {
          return head + `<div class="ok-box"><b style="font-size:15px;color:var(--green-dark)">✓ Te sumamos S/ 10 a tu panel 🎁</b>
            <span>Ese celular ya tiene su Panel Mayorista, así que no se crea otro.</span>
            <span>Tu panel está pausado por inactividad. Tu saldo (con los S/ 10) está guardado: escríbenos para reactivarlo.</span></div>
            <a class="c-btn green block" href="${esc(supportLink("Hola, compré el curso y quiero reactivar mi Panel Mayorista (" + r.user + ")."))}" target="_blank" rel="noopener">Reactivar por WhatsApp</a>`;
        }
        if (!r.createdNew) {
          return head + `<div class="ok-box"><b style="font-size:15px;color:var(--green-dark)">✓ ¡Listo! Te sumamos S/ 10 🎁</b>
            <span>Ese celular ya tiene su Panel Mayorista, así que no se crea otro. Entra con tu contraseña de siempre.</span>
            <span>Saldo: <b>S/ ${(r.balanceCents / 100).toFixed(2)}</b></span></div>
            <a class="c-btn dark block" href="${esc(r.panelUrl)}" target="_blank" rel="noopener">Entrar al Panel Mayorista →</a>`;
        }
        return head + `<div class="ok-box"><b style="font-size:15px;color:var(--green-dark)">✓ ¡Listo! Tu acceso mayorista</b>
          <span class="row">Usuario: <b>${esc(r.user)}</b><button class="c-btn small" data-copy="${esc(r.user)}">Copiar</button></span>
          <span class="row">Contraseña: <b>${esc(r.password)}</b><button class="c-btn small" data-copy="${esc(r.password)}">Copiar</button></span>
          <span>Saldo: <b>S/ ${(r.balanceCents / 100).toFixed(2)} 🎁</b></span></div>
          <a class="c-btn dark block" href="${esc(r.panelUrl)}" target="_blank" rel="noopener">Entrar al Panel Mayorista →</a>
          <span class="muted" style="font-size:12px">Guarda tu contraseña. Cambia tu contraseña al entrar.</span>`;
      }
      default:
        return head + err + `<button class="c-btn green block pulse" data-mayo="start">Crear mi acceso</button>`;
    }
  }

  function cuponHtml() {
    const head = `<div class="res-head"><span class="coupon-badge">−30%</span><b>Curso avanzado: escala tu negocio</b></div>`;
    if (me.coupon) {
      return head + `<div style="display:flex;gap:8px"><span class="code">${esc(me.coupon)}</span><button class="c-btn small" data-copy="${esc(me.coupon)}">Copiar</button></div>
        <span class="muted" style="font-size:12px">Te avisaremos cuando abra el curso avanzado.</span>`;
    }
    return head + (couponError ? `<p class="err">${esc(couponError)}</p>` : "") +
      `<button class="c-btn amber block pulse" data-coupon>Obtener mi −30%</button>`;
  }

  function bindResource(type, box) {
    box.querySelectorAll("[data-copy]").forEach(b => b.addEventListener("click", () => copy(b.dataset.copy)));

    if (type === "plantilla") {
      const a = box.querySelector("[data-dl]");
      if (a) a.addEventListener("click", () => {
        setTimeout(() => { me.gestorDownloaded = true; renderResource("plantilla", false); }, 400);
      });
    }

    if (type === "cupon") {
      const b = box.querySelector("[data-coupon]");
      if (b) b.addEventListener("click", async () => {
        b.disabled = true;
        try {
          const { code } = await api("/api/course/coupon", { method: "POST" });
          me.coupon = code; couponError = "";
        } catch (err) { couponError = err.message; }
        renderResource("cupon", false);
      });
    }

    if (type === "mayorista") {
      box.querySelectorAll("[data-mayo]").forEach(b => b.addEventListener("click", () => {
        const act = b.dataset.mayo;
        mayo.error = "";
        if (act === "start" || act === "edit") mayo.state = "form";
        if (act === "create") { createWholesale(); return; }
        renderResource("mayorista", false);
      }));
      const form = box.querySelector("[data-mayo-form]");
      if (form) form.addEventListener("submit", e => {
        e.preventDefault();
        let phone = form.phone.value.replace(/\D/g, "");
        if (phone.length === 11 && phone.startsWith("51")) phone = phone.slice(2);
        const panelName = form.panelName.value.trim().replace(/\s+/g, " ");
        mayo.phone = phone; mayo.panelName = panelName;
        if (!/^9\d{8}$/.test(phone)) mayo.error = "El celular debe tener 9 dígitos y empezar con 9.";
        else if (panelName.length < 3 || panelName.length > 30) mayo.error = "El nombre de tu panel debe tener entre 3 y 30 caracteres.";
        else { mayo.error = ""; mayo.state = "confirm"; }
        renderResource("mayorista", false);
      });
    }
  }

  async function createWholesale() {
    mayo.state = "sending";
    renderResource("mayorista", false);
    try {
      mayo.result = await api("/api/course/wholesale", { method: "POST", body: { phone: mayo.phone, panelName: mayo.panelName } });
      mayo.state = "done";
    } catch (err) {
      if (err.status === 409 && err.data && err.data.maskedPhone) {
        me.claim = { maskedPhone: err.data.maskedPhone };
        mayo.state = "claimed";
      } else {
        mayo.state = "confirm";
        mayo.error = err.status >= 500 || !err.status
          ? "No pudimos crear tu acceso. Escríbenos al WhatsApp 963 081 436 y lo resolvemos."
          : err.message;
      }
    }
    renderResource("mayorista", false);
  }

  // ─── Pantalla final + confeti pixel ────────────────────────

  function showFinish() {
    const el = document.getElementById("finish");
    el.hidden = false;
    confetti();
  }

  document.getElementById("finish-close").addEventListener("click", () => { document.getElementById("finish").hidden = true; });
  document.getElementById("finish-coupon").addEventListener("click", () => {
    document.getElementById("finish").hidden = true;
    const box = document.getElementById("res-cupon");
    if (box) box.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  function confetti() {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const canvas = document.getElementById("confetti");
    const ctx = canvas.getContext("2d");
    const W = canvas.width = window.innerWidth;
    const H = canvas.height = window.innerHeight;
    const colors = ["#FF7D1A", "#F5941E", "#FFD373", "#FBC75C", "#25D366", "#FFFAF3"];
    const bits = Array.from({ length: 140 }, () => ({
      x: Math.random() * W, y: -Math.random() * H * 0.6,
      s: 6 + Math.floor(Math.random() * 3) * 3,
      vy: 2 + Math.random() * 3, vx: -1 + Math.random() * 2,
      c: colors[Math.floor(Math.random() * colors.length)],
    }));
    const start = performance.now();
    function frame(now) {
      ctx.clearRect(0, 0, W, H);
      bits.forEach(b => {
        b.y += b.vy; b.x += b.vx;
        ctx.fillStyle = b.c;
        ctx.fillRect(Math.round(b.x / 3) * 3, Math.round(b.y / 3) * 3, b.s, b.s);
      });
      if (now - start < 5000) requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, W, H);
    }
    requestAnimationFrame(frame);
  }

  window.addEventListener("pagehide", () => { if (video.getAttribute("src") && video.currentTime > 0) beaconProgress(); });

  init();
})();
