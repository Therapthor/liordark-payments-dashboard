(() => {
  "use strict";

  // ─────────────────────────────────────────────────────────────
  // GAME OVER — pantalla para una conexión bloqueada en el login del panel
  // (2 contraseñas mal). El manguito pixel del curso, contento, saca el
  // dedo una y otra vez. Solo es la cara: el bloqueo lo hace el servidor.
  // ─────────────────────────────────────────────────────────────

  const C = { k: "#141110", w: "#f6f2e8", q: "#c7bfae", O: "#f0861f", Y: "#ffb64d", y: "#ffd27c", R: "#e0373d", G: "#2fc46c", g: "#1b8a4a" };
  const rect = (x, y, c, w = 1, h = 1) => `<rect x="${x}" y="${y}" width="${w + .02}" height="${h + .02}" fill="${C[c] || c}"/>`;

  function mangoBody(cx, top) {
    const hw = [3, 5, 6, 7, 8, 9, 9, 10, 10, 10, 11, 11, 11, 11, 11, 11, 11, 11, 10, 10, 10, 9, 9, 8, 7, 6, 4];
    const cells = new Map();
    const set = (x, y, c) => cells.set(x + "," + y, c);
    const fill = new Set();
    hw.forEach((h, i) => {
      for (let x = cx - h; x < cx + h; x++) {
        fill.add(x + "," + (top + i));
        set(x, top + i, x >= cx + Math.round(h * 0.3) ? "Y" : "O");
      }
    });
    [[cx + 4, top + 3], [cx + 5, top + 3], [cx + 5, top + 4], [cx + 6, top + 5]].forEach(([x, y]) => set(x, y, "y"));
    for (let y = top - 3; y <= top + hw.length + 2; y++) {
      for (let x = cx - 15; x <= cx + 15; x++) {
        if (fill.has(x + "," + y)) continue;
        let d = 9;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++)
          if (fill.has((x + dx) + "," + (y + dy))) d = Math.min(d, Math.max(Math.abs(dx), Math.abs(dy)));
        if (d === 1) set(x, y, "k"); else if (d === 2) set(x, y, "w");
      }
    }
    const g = top + 9;
    for (let x = cx - 9; x <= cx + 8; x++) set(x, g, "k");
    for (let x = cx - 8; x <= cx - 2; x++) set(x, g + 1, "k");
    for (let x = cx + 1; x <= cx + 7; x++) set(x, g + 1, "k");
    for (let x = cx - 7; x <= cx - 3; x++) set(x, g + 2, "k");
    for (let x = cx + 2; x <= cx + 6; x++) set(x, g + 2, "k");
    [cx - 9, cx - 8, cx + 7, cx + 8].forEach(x => set(x, top + 14, "R"));
    set(cx - 5, top + 14, "k"); set(cx + 4, top + 14, "k");
    for (let x = cx - 4; x <= cx + 3; x++) set(x, top + 15, "k");
    set(cx - 4, top + 16, "k"); for (let x = cx - 3; x <= cx + 2; x++) set(x, top + 16, "k"); set(cx + 3, top + 16, "k");
    for (let x = cx - 2; x <= cx + 1; x++) set(x, top + 16, "R");
    for (let x = cx - 2; x <= cx + 1; x++) set(x, top + 17, "k");
    set(cx, top - 3, "w"); set(cx, top - 4, "w"); set(cx + 1, top - 5, "w");
    [[cx + 2, top - 7], [cx + 3, top - 7], [cx + 4, top - 7], [cx + 1, top - 6], [cx + 5, top - 6], [cx + 2, top - 5], [cx + 3, top - 5], [cx + 4, top - 5]].forEach(([x, y]) => set(x, y, "w"));
    [[cx + 2, top - 6], [cx + 3, top - 6], [cx + 4, top - 6]].forEach(([x, y]) => set(x, y, "G"));
    const b = top + hw.length + 2;
    for (let y = b + 1; y <= b + 3; y++) { set(cx - 5, y, "w"); set(cx - 3, y, "w"); set(cx + 2, y, "w"); set(cx + 4, y, "w"); }
    for (let x = cx - 7; x <= cx - 3; x++) set(x, b + 4, "w");
    for (let x = cx + 2; x <= cx + 6; x++) set(x, b + 4, "w");
    let s = "";
    cells.forEach((c, k) => { const [x, y] = k.split(",").map(Number); s += rect(x, y, c); });
    s += `<g class="go-glint">${rect(cx - 7, g + 1, "w")}${rect(cx - 6, g + 1, "w")}${rect(cx + 2, g + 1, "w")}${rect(cx + 3, g + 1, "w")}</g>`;
    return { svg: s, feetY: b + 4 };
  }

  const FINGER = ["...kkkk...", "...kwwk...", "...kwwk...", "...kwwk...", ".kkkwwkkk.", "kwwqwwqwwk", "kwwqwwqwwk", "kwwwwwwwwk", ".kwwwwwwk.", "..kwwwwk.."];
  const FIST = ["..........", "..........", "..........", "..........", ".kkkkkkkk.", "kwwqwwqwwk", "kwwqwwqwwk", "kwwwwwwwwk", ".kwwwwwwk.", "..kwwwwk.."];
  const drawRows = (rows, ox, oy) => rows.map((r, y) => [...r].map((c, x) => C[c] ? rect(ox + x, oy + y, c) : "").join("")).join("");

  function arm(cx, top, side) {
    const pts = [];
    const sx = side > 0 ? cx + 13 : cx - 14;
    [[0, 0], [0, -1], [1, -1], [1, -2], [2, -2], [2, -3], [3, -3], [3, -4]].forEach(([dx, dy]) => pts.push([sx + side * dx, top + 14 + dy]));
    const vx = sx + side * 3;
    for (let y = top + 9; y >= top + 5; y--) { pts.push([vx, y]); pts.push([vx + side, y]); }
    const wristX = side > 0 ? vx : vx - 1;
    return { svg: pts.map(([x, y]) => rect(x, y, "w")).join(""), handX: wristX - 4, handY: top + 5 - 10 };
  }

  function mangoSvg() {
    const cx = 22, top = 14;
    const b = mangoBody(cx, top);
    const ra = arm(cx, top, 1), la = arm(cx, top, -1);
    const floor = rect(cx - 13, b.feetY + 1, "G", 26, 1) + rect(cx - 13, b.feetY + 2, "g", 26, 1);
    return `<svg class="go-mango" viewBox="-2 2 50 ${b.feetY + 2}" width="250" aria-hidden="true">
      ${floor}
      <g class="go-hop">
        ${b.svg}${la.svg}${ra.svg}
        <g>${drawRows(FIST, la.handX, la.handY)}</g>
        <g class="go-pop"><g class="go-fist">${drawRows(FIST, ra.handX, ra.handY)}</g><g class="go-finger">${drawRows(FINGER, ra.handX, ra.handY)}</g></g>
      </g>
    </svg>`;
  }

  const FONT = {
    A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
    B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
    D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
    E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
    G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".####"],
    I: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"],
    L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
    M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
    O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
    P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
    Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
    R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
    U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
    V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
    " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
  };

  function pixelText(text, cell, colors) {
    const chars = [...text];
    const W = chars.length * 6 - 1;
    let s = "", sh = "";
    chars.forEach((ch, i) => (FONT[ch] || FONT[" "]).forEach((row, y) => [...row].forEach((c, x) => {
      if (c !== "#") return;
      const X = i * 6 + x;
      sh += `<rect x="${X + .6}" y="${y + .6}" width="1.02" height="1.02" fill="#7a3200"/>`;
      s += `<rect x="${X}" y="${y}" width="1.02" height="1.02" fill="${y < 4 ? colors[0] : colors[1]}"/>`;
    })));
    return `<svg class="go-text" viewBox="0 0 ${W + 1} 8" width="${(W + 1) * cell}" aria-hidden="true">${sh}${s}</svg>`;
  }

  let el = null;

  /** Muestra el GAME OVER. ip: la conexión bloqueada. onBack: volver al login. */
  function show(ip, onBack) {
    if (!el) {
      el = document.createElement("div");
      el.className = "gameover";
      el.setAttribute("role", "alert");
      el.innerHTML = `
        <div class="go-blink">${pixelText("GAME OVER", 5.2, ["#ffd98a", "#ff9a2e"])}</div>
        ${mangoSvg()}
        ${pixelText("IP BLOQUEADA", 4, ["#ffffff", "#f5c56b"])}
        <p class="go-ip"></p>
        <span class="go-sr">Game over: esta conexión quedó bloqueada para siempre.</span>
        <button type="button" class="go-back">¿Eres el dueño? Entra con tu llave de acceso</button>`;
      document.body.appendChild(el);
    }
    el.querySelector(".go-ip").textContent = "TU IP " + (ip || "?") + " · PARA SIEMPRE";
    el.querySelector(".go-back").onclick = () => { hide(); if (onBack) onBack(); };
    el.hidden = false;
  }

  function hide() { if (el) el.hidden = true; }

  window.LiordarkGameOver = { show, hide };
})();
