// ─────────────────────────────────────────────────────────────
// Gatito de los códigos — dibujo propio (SVG en línea), colores Mango Pro.
// El mismo archivo vive en public/, public-store/ y public-wholesale/
// (cada app tiene su carpeta); su estilo, en css/cat.css.
//   idle      → feliz, esperando
//   searching → con una lupa (la lupa se mece y parpadea)
//   found     → contento: ojos cerrados y un brillito
//   sad       → triste: orejas caídas y una lágrima
// Uso: <span class="ld-cat" data-cat="idle"></span> se dibuja solo;
// LiordarkCat.set(el, "found") cambia el estado; LiordarkCat.html("sad")
// devuelve el HTML para armar tarjetas con innerHTML.
// ─────────────────────────────────────────────────────────────
window.LiordarkCat = (() => {
  "use strict";

  const MANGO = "#FFC93C", MANGO_DEEP = "#E9A21A", INK = "#2B1B0E", CREAM = "#FFF3DC";
  const BLUSH = "#FF8F6B", TEAR = "#8FD0FF";
  const STATES = ["idle", "searching", "found", "sad"];
  const LABELS = {
    idle: "Gatito esperando", searching: "Gatito buscando con una lupa",
    found: "Gatito feliz: llegó el código", sad: "Gatito triste: no llegó",
  };

  // Partes que se repiten
  const ink = (w) => `stroke="${INK}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`;

  function tail(sad) {
    const d = sad ? "M83 106 C 96 112, 108 111, 113 103" : "M83 104 C 104 104, 111 84, 99 74";
    return `<g class="cat-tail"><path d="${d}" fill="none" ${ink(11)}/><path d="${d}" fill="none" stroke="${MANGO}" stroke-width="5.5" stroke-linecap="round"/></g>`;
  }

  function ears(sad) {
    // Caídas: giradas hacia afuera y abajo desde su base.
    const left = `<path d="M33 47 L31 17 L55 33 Z" fill="${MANGO}" ${ink(3)}/><path d="M37 40 L36 25 L48 33 Z" fill="${CREAM}"/>`;
    const right = `<path d="M87 47 L89 17 L65 33 Z" fill="${MANGO}" ${ink(3)}/><path d="M83 40 L84 25 L72 33 Z" fill="${CREAM}"/>`;
    return sad
      ? `<g transform="rotate(-62 42 42)">${left}</g><g transform="rotate(62 78 42)">${right}</g>`
      : left + right;
  }

  function eyes(state) {
    if (state === "found") {
      return `<path d="M41 58 q5.5 -6.5 11 0" fill="none" ${ink(3.2)}/><path d="M68 58 q5.5 -6.5 11 0" fill="none" ${ink(3.2)}/>`;
    }
    const eye = (cx, cy, rx, ry) =>
      `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${INK}"/><circle cx="${cx + 1.6}" cy="${cy - 2.2}" r="1.7" fill="#fff"/>`;
    if (state === "searching") return `<g class="cat-blink">${eye(46, 57, 4.4, 5.4)}</g>`; // el otro va en la lupa
    if (state === "sad") {
      return `<path d="M40 50.5 L50.5 46.5" fill="none" ${ink(2.4)}/><path d="M80 50.5 L69.5 46.5" fill="none" ${ink(2.4)}/>` +
        eye(46, 58.5, 4, 4.6) + eye(74, 58.5, 4, 4.6) +
        `<path class="cat-tear" d="M44.5 64 q-3.4 5.2 0 8 q3.4 -2.8 0 -8 Z" fill="${TEAR}" ${ink(1.2)}/>`;
    }
    return `<g class="cat-blink">${eye(47, 57, 4.6, 5.6)}${eye(73, 57, 4.6, 5.6)}</g>`;
  }

  function mouth(state) {
    if (state === "sad") return `<path d="M54.5 73.5 q5.5 -4.5 11 0" fill="none" ${ink(2.2)}/>`;
    if (state === "searching") return `<ellipse cx="60" cy="71.5" rx="2.3" ry="2.7" fill="${INK}"/>`;
    if (state === "found") return `<path d="M53.5 69 q3.2 4.2 6.5 0 q3.3 4.2 6.5 0" fill="none" ${ink(2.2)}/>`;
    return `<path d="M54 69 q3 3.6 6 0 q3 3.6 6 0" fill="none" ${ink(2)}/>`;
  }

  // Lupa (con el otro ojo agrandado adentro) sostenida por la pata derecha.
  function lens() {
    return `<path d="M80 95 C 88 92, 92 88, 94 83" fill="none" ${ink(10)}/>` +
      `<path d="M80 95 C 88 92, 92 88, 94 83" fill="none" stroke="${MANGO}" stroke-width="5" stroke-linecap="round"/>` +
      `<g class="cat-lens">` +
        `<path d="M84 67 L97 84" ${ink(7.5)}/><path d="M85.5 69 L96 82.5" stroke="${MANGO_DEEP}" stroke-width="3" stroke-linecap="round"/>` +
        `<circle cx="75" cy="57" r="12.5" fill="${MANGO}"/>` +
        `<g class="cat-blink"><ellipse cx="75" cy="57.5" rx="6.6" ry="7.8" fill="${INK}"/><circle cx="77.4" cy="54.2" r="2.4" fill="#fff"/></g>` +
        `<circle cx="75" cy="57" r="12.5" fill="${CREAM}" fill-opacity=".38" ${ink(4)}/>` +
        `<path d="M67.5 52.5 q2.6 -4.6 8 -5.2" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" opacity=".85"/>` +
        `<ellipse cx="95" cy="83" rx="6.4" ry="5.4" fill="${MANGO}" ${ink(2.6)}/>` +
      `</g>`;
  }

  function sparkles() {
    const star = (x, y, s, cls) =>
      `<path class="cat-sparkle ${cls}" d="M${x} ${y - s} q${s * .18} ${s * .82} ${s} ${s} q${-s * .82} ${s * .18} ${-s} ${s} q${-s * .18} ${-s * .82} ${-s} ${-s} q${s * .82} ${-s * .18} ${s} ${-s} Z" fill="${MANGO}" ${ink(1.8)}/>`;
    return star(101, 27, 9, "s1") + star(18, 36, 5.5, "s2");
  }

  function svg(state) {
    const s = STATES.includes(state) ? state : "idle";
    const sad = s === "sad";
    const paws = s === "searching"
      ? `<ellipse cx="49" cy="110.5" rx="7.5" ry="4.6" fill="${MANGO}" ${ink(2.6)}/>`
      : `<ellipse cx="49" cy="110.5" rx="7.5" ry="4.6" fill="${MANGO}" ${ink(2.6)}/><ellipse cx="71" cy="110.5" rx="7.5" ry="4.6" fill="${MANGO}" ${ink(2.6)}/>`;
    const blush = s === "idle" || s === "found"
      ? `<ellipse cx="39.5" cy="66.5" rx="5" ry="3" fill="${BLUSH}" opacity=".55"/><ellipse cx="80.5" cy="66.5" rx="5" ry="3" fill="${BLUSH}" opacity=".55"/>`
      : "";
    return `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" focusable="false" aria-hidden="true">` +
      `<ellipse cx="60" cy="114" rx="31" ry="4" fill="${INK}" opacity=".12"/>` +
      tail(sad) +
      `<ellipse cx="60" cy="94" rx="28" ry="20" fill="${MANGO}" ${ink(3)}/>` +
      `<ellipse cx="60" cy="99" rx="14" ry="11" fill="${CREAM}"/>` +
      paws + ears(sad) +
      `<ellipse cx="60" cy="58" rx="34" ry="28" fill="${MANGO}" ${ink(3)}/>` +
      `<path d="M60 31.5 v6.5 M52.5 33 l1.8 5.8 M67.5 33 l-1.8 5.8" fill="none" stroke="${MANGO_DEEP}" stroke-width="3" stroke-linecap="round"/>` +
      `<ellipse cx="60" cy="68" rx="11" ry="7.5" fill="${CREAM}"/>` +
      blush +
      `<path d="M24 63 l12 1.6 M25 70.5 l11 -1.6 M96 63 l-12 1.6 M95 70.5 l-11 -1.6" fill="none" ${ink(1.6)} opacity=".6"/>` +
      eyes(s) +
      `<path d="M56.5 64 h7 l-3.5 3.6 Z" fill="${INK}" ${ink(1.4)}/>` +
      mouth(s) +
      (s === "searching" ? lens() : "") +
      (s === "found" ? sparkles() : "") +
      `</svg>`;
  }

  function html(state, extraClass) {
    const s = STATES.includes(state) ? state : "idle";
    return `<span class="ld-cat ld-cat--${s}${extraClass ? " " + extraClass : ""}" data-cat-state="${s}" role="img" aria-label="${LABELS[s]}">${svg(s)}</span>`;
  }

  // Cambia el estado de un gatito ya puesto (con su entrada suave).
  function set(el, state) {
    if (!el) return;
    const s = STATES.includes(state) ? state : "idle";
    if (el.dataset.catState === s && el.firstElementChild) return;
    el.classList.add("ld-cat");
    STATES.forEach(x => el.classList.toggle("ld-cat--" + x, x === s));
    el.dataset.catState = s;
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", LABELS[s]);
    el.innerHTML = svg(s);
    el.style.animation = "none";
    void el.offsetWidth; // reinicia la animación de entrada
    el.style.animation = "";
  }

  function mountAll(root) {
    (root || document).querySelectorAll("[data-cat]").forEach(el => set(el, el.dataset.cat));
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => mountAll());
  else mountAll();

  return { svg, html, set, mountAll, STATES };
})();
