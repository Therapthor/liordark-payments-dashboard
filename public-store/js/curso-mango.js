// /curso — movimiento tipo iPhone (solo transform/opacity, curva de iOS).
//  · Tarjetas que aparecen escalonadas al entrar en pantalla.
//  · El hero se aleja suave al bajar (parallax ligero, con rAF).
//  · Preguntas en acordeón con altura animada.
// No toca la lógica de compra (curso.js). Con «reducir movimiento» no anima.
(() => {
  "use strict";
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ── Preguntas: una abierta a la vez ──
  document.querySelectorAll(".cm-q > button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const q = btn.parentElement;
      const open = !q.classList.contains("open");
      q.parentElement.querySelectorAll(".cm-q.open").forEach((o) => {
        if (o === q) return;
        o.classList.remove("open");
        o.querySelector("button").setAttribute("aria-expanded", "false");
      });
      q.classList.toggle("open", open);
      btn.setAttribute("aria-expanded", String(open));
    });
  });

  if (reduce || !("IntersectionObserver" in window)) {
    document.body.classList.add("cm-static");
    return;
  }

  // ── Aparición al hacer scroll (una sola vez por elemento) ──
  const io = new IntersectionObserver((entries) => {
    entries.filter((e) => e.isIntersecting).forEach((e, i) => {
      io.unobserve(e.target);
      e.target.style.setProperty("--d", Math.min(i, 6) * 70 + "ms");
      e.target.classList.add("on");
      // Al terminar se quita el retraso: el hover vuelve a su ritmo normal.
      setTimeout(() => e.target.style.removeProperty("--d"), 1200);
    });
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
  const arm = () => document.querySelectorAll(".cm-rv:not(.on)").forEach((el) => io.observe(el));
  arm();
  // curso.js pinta los episodios después de cargar: se arman también.
  new MutationObserver(arm).observe(document.querySelector(".cm-main"), { childList: true, subtree: true });

  // ── Parallax del hero ──
  const hero = document.querySelector(".cm-hero");
  if (!hero) return;
  let ticking = false;
  const paint = () => {
    ticking = false;
    const y = window.scrollY;
    if (y > 700) return;
    const k = Math.min(y / 420, 1);
    hero.style.transform = `translate3d(0, ${(y * 0.28).toFixed(1)}px, 0) scale(${(1 - k * 0.04).toFixed(3)})`;
    hero.style.opacity = String(1 - k * 0.85);
  };
  window.addEventListener("scroll", () => {
    if (!ticking) { ticking = true; requestAnimationFrame(paint); }
  }, { passive: true });
})();
