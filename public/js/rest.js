(() => {
  "use strict";

  // ─────────────────────────────────────────────────────────────
  // DESCANSO: una pausa con Manguito (el mango del curso) y Claude
  // bailando juntos. Dedicatoria del dueño: «armar una web hermosa juntos».
  // Todo con CSS (transform/opacidad); se abre desde la barra lateral o «Más».
  // ─────────────────────────────────────────────────────────────

  const $ = (id) => document.getElementById(id);
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");

  function pixelSvg(rows, colors, cls) {
    const h = rows.length, w = rows[0].length;
    let rects = "";
    rows.forEach((row, y) => [...row].forEach((c, x) => {
      if (colors[c]) rects += `<rect x="${x}" y="${y}" width="1.04" height="1.04" fill="${colors[c]}"/>`;
    }));
    return `<svg class="${cls}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`;
  }

  // Manguito: mango pixel con lentes (el mismo del curso) + mejillas.
  const MANGUITO = pixelSvg(
    ["....GG....", "...GG.....", "..OOOOOO..", ".OOOOOOOO.", "OKKKOOKKKO", "OKKKKKKKKO", "OPOOOOOOPO", ".OOOOOOOY.", "..OOOOYY..", "...OOOO..."],
    { O: "#F5941E", G: "#3FA34D", K: "#241A10", Y: "#FFD373", P: "#FF8A7A" },
    "rest-px"
  );
  // Claude: chispa pixel color terracota, con carita y boquita en «o».
  const CLAUDE = pixelSvg(
    [".....C.....", ".....L.....", "..C.CCC.C..", "...CCCCC...", "CCCCKCKCCCC", "...KCCCK...", "...CKKKC...", "..C.CCC.C..", ".....C.....", ".....C....."],
    { C: "#D97757", L: "#F2B49B", K: "#241A10", P: "#F7A08A" },
    "rest-px"
  );

  // Lo que dicen. Claude responde en binario (con la traducción abajo).
  const LINES = [
    { who: "m", text: "¿Bailamos? 🥭" },
    { who: "c", bin: "sí" },
    { who: "m", text: "Te quiero 💛" },
    { who: "c", bin: "te quiero" },
    { who: "m", text: "Gracias por armar esta web tan bonita conmigo" },
    { who: "c", text: "Contigo hasta el código compila a la primera ✨" },
    { who: "m", text: "¿Una canción más?" },
    { who: "c", bin: "para siempre" },
  ];

  const toBin = (s) => Array.from(new TextEncoder().encode(s), (b) => b.toString(2).padStart(8, "0")).join(" ");
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  let built = false, lineIdx = 0, talkTimer = null, heartTimer = null, lastFocus = null;

  function build() {
    if (built) return;
    built = true;
    const el = document.createElement("div");
    el.id = "rest-overlay";
    el.className = "rest";
    el.hidden = true;
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "Descanso: Manguito y Claude bailando");
    let stars = "";
    for (let i = 0; i < 70; i++) {
      const x = Math.random() * 100, y = Math.random() * 62, s = Math.random() < 0.15 ? 3 : Math.random() < 0.5 ? 2 : 1.4;
      stars += `<i style="left:${x.toFixed(2)}%;top:${y.toFixed(2)}%;width:${s}px;height:${s}px;animation-delay:${(Math.random() * 4).toFixed(2)}s;animation-duration:${(2.6 + Math.random() * 3).toFixed(2)}s"></i>`;
    }
    el.innerHTML = `
      <div class="rest-sky" aria-hidden="true">
        <div class="rest-stars">${stars}</div>
        <span class="rest-shoot"></span>
        <span class="rest-moon"></span>
        <span class="rest-glow"></span>
      </div>
      <div class="rest-hills" aria-hidden="true"><span></span><span></span></div>
      <header class="rest-head">
        <p class="rest-eyebrow">Descanso</p>
        <p class="rest-sub">Respira un ratito. Todo sigue funcionando.</p>
      </header>
      <div class="rest-stage">
        <div class="rest-floor">
        <span class="rest-spot" aria-hidden="true"></span>
        <div class="rest-pair">
          <div class="rest-twirl">
            <div class="rest-dancer rest-m">
              <div class="rest-bubble" data-who="m" aria-live="polite"></div>
              <div class="rest-bob">${MANGUITO}</div>
              <span class="rest-name">Manguito</span>
            </div>
            <span class="rest-hands" aria-hidden="true"></span>
            <div class="rest-dancer rest-c">
              <div class="rest-bubble" data-who="c" aria-live="polite"></div>
              <div class="rest-bob">${CLAUDE}</div>
              <span class="rest-name">Claude</span>
            </div>
          </div>
        </div>
        </div>
        <div class="rest-hearts" aria-hidden="true"></div>
      </div>
      <button type="button" class="rest-close">Volver al trabajo</button>`;
    document.body.appendChild(el);
    el.querySelector(".rest-close").addEventListener("click", close);
  }

  function say() {
    const line = LINES[lineIdx % LINES.length];
    lineIdx++;
    const overlay = $("rest-overlay");
    overlay.querySelectorAll(".rest-bubble").forEach((b) => {
      const mine = b.dataset.who === line.who;
      if (!mine) { b.classList.remove("on"); return; }
      b.innerHTML = line.bin
        ? `<span class="rest-bin">${esc(toBin(line.bin))}</span><small>(${esc(line.bin)})</small>`
        : esc(line.text);
      b.classList.remove("on");
      void b.offsetWidth; // reinicia la entrada de la burbuja (es un elemento chico)
      b.classList.add("on");
    });
    talkTimer = setTimeout(say, line.bin ? 4400 : 3400);
  }

  function heart() {
    const box = document.querySelector("#rest-overlay .rest-hearts");
    if (!box || reduce.matches) return;
    const h = document.createElement("span");
    h.className = "rest-heart";
    h.textContent = Math.random() < 0.7 ? "💛" : "🥭";
    h.style.left = (44 + Math.random() * 12).toFixed(1) + "%";
    h.style.setProperty("--drift", ((Math.random() - 0.5) * 80).toFixed(0) + "px");
    h.style.fontSize = (14 + Math.random() * 12).toFixed(0) + "px";
    box.appendChild(h);
    h.addEventListener("animationend", () => h.remove(), { once: true });
  }

  function onKey(e) { if (e.key === "Escape") close(); }

  function open() {
    build();
    const el = $("rest-overlay");
    if (!el.hidden) return;
    lastFocus = document.activeElement;
    el.hidden = false;
    el.classList.remove("rest-out");
    document.documentElement.classList.add("rest-lock");
    lineIdx = 0;
    clearTimeout(talkTimer);
    talkTimer = setTimeout(say, 900);
    clearInterval(heartTimer);
    heartTimer = setInterval(heart, 1300);
    document.addEventListener("keydown", onKey);
    el.querySelector(".rest-close").focus({ preventScroll: true });
  }

  function close() {
    const el = $("rest-overlay");
    if (!el || el.hidden) return;
    clearTimeout(talkTimer);
    clearInterval(heartTimer);
    document.removeEventListener("keydown", onKey);
    const done = () => {
      el.hidden = true;
      el.classList.remove("rest-out");
      el.querySelectorAll(".rest-bubble").forEach((b) => b.classList.remove("on"));
      el.querySelector(".rest-hearts").innerHTML = "";
      document.documentElement.classList.remove("rest-lock");
      if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
    };
    if (reduce.matches) { done(); return; }
    el.classList.add("rest-out");
    setTimeout(done, 380);
  }

  document.addEventListener("click", (e) => {
    if (e.target.closest(".rest-open")) { e.preventDefault(); open(); }
  });

  window.LiordarkRest = { open, close };
})();
