// 🎓 Curso — panel admin: archivos (subida por partes), tiempos de los
// recursos, precio, acceso manual y alumnos.
window.LiordarkCourse = (() => {
  "use strict";

  const CHUNK = 768 * 1024; // < 1 MB por parte (límite típico de nginx)
  const MEDIA_LABELS = {
    ep1: "Episodio 1 — Inicio (gratis en la página de venta)",
    ep2: "Episodio 2 — Entender",
    ep3: "Episodio 3 — Planear",
    ep4: "Episodio 4 — Gestionar",
    ep5: "Episodio 5 — Fidelizar",
    gestor: "📊 Gestor de cuentas (Excel .xlsx)",
  };
  const CUE_LABELS = { mayorista: "🏪 Acceso Panel Mayorista", plantilla: "📊 Plantilla Excel", cupon: "🎟️ Cupón −30%" };

  let data = null;
  const uploading = {};

  async function api(path, options = {}) {
    const res = await fetch("/api/course-admin" + path, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    if (res.status === 401) { location.reload(); throw new Error("No autenticado"); }
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.message || "Error de red");
    return out;
  }

  const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const money = cents => "S/ " + ((Number(cents) || 0) / 100).toFixed(2);
  const mb = b => b >= 1024 * 1024 * 1024 ? (b / 1024 / 1024 / 1024).toFixed(2) + " GB" : (b / 1024 / 1024).toFixed(1) + " MB";
  const toSec = v => {
    const m = String(v).trim().match(/^(\d+)(?::(\d{1,2}))?$/);
    if (!m) return NaN;
    return m[2] === undefined ? Number(m[1]) : Number(m[1]) * 60 + Number(m[2]);
  };
  const fmt = s => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
  const fmtDate = s => {
    if (!s) return "";
    const d = new Date(String(s).replace(" ", "T") + (String(s).endsWith("Z") ? "" : "Z"));
    return d.toLocaleString("es-PE", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
  };

  async function load() {
    try {
      data = await api("/overview");
    } catch (err) {
      document.getElementById("crs-stats").innerHTML = `<p class="panel-hint">${esc(err.message)}</p>`;
      return;
    }
    renderPublish();
    renderStats();
    renderMedia();
    renderCues();
    renderStudents();
    document.getElementById("crs-price").value = Number(data.launchPrice ?? data.price).toFixed(2);
    document.getElementById("crs-regular-price").value = Number(data.regularPrice ?? data.price).toFixed(2);
    renderLaunchHint();
  }

  // Lanzamiento: 2 semanas desde que se publica; luego pasa solo al precio normal.
  function renderLaunchHint() {
    const el = document.getElementById("crs-launch-hint");
    const fmt = (iso) => new Date(iso).toLocaleDateString("es-PE", { day: "numeric", month: "long" });
    const lp = Number(data.launchPrice).toFixed(2), rp = Number(data.regularPrice).toFixed(2);
    if (!data.launchEndsAt) {
      el.textContent = `Precio de lanzamiento S/ ${lp} durante 2 semanas desde que publiques. Luego pasa solo a S/ ${rp}.`;
    } else if (data.launchActive) {
      el.textContent = `🚀 Lanzamiento activo: S/ ${lp} hasta el ${fmt(data.launchEndsAt)}. Luego pasa solo a S/ ${rp}.`;
    } else {
      el.textContent = `El lanzamiento terminó el ${fmt(data.launchEndsAt)}. Precio actual: S/ ${rp}.`;
    }
  }

  function renderPublish() {
    const on = !!data.published;
    document.getElementById("crs-publish").classList.toggle("on", on);
    document.getElementById("crs-publish-state").textContent = on ? "✅ Publicado — todos lo ven en liordark.com/curso" : "Borrador — todavía no es público";
    document.getElementById("crs-publish-hint").textContent = on
      ? "Aparece en la tienda y cualquiera lo puede comprar."
      : "Solo lo ve y lo puede comprar el celular de prueba (" + (data.previewPhones || []).join(", ") + "). Cuando esté todo listo, dale a Publicar.";
    const btn = document.getElementById("crs-publish-btn");
    btn.textContent = on ? "Volver a borrador" : "Publicar curso";
    btn.className = on ? "btn-secondary" : "btn-primary";
  }

  document.getElementById("crs-publish-btn").addEventListener("click", async () => {
    const next = !data.published;
    const msg = next
      ? "¿Publicar el curso? Aparecerá en la tienda y cualquiera lo podrá comprar."
      : "¿Volver a borrador? Dejará de verse en la tienda (quien ya lo compró sigue entrando).";
    if (!confirm(msg)) return;
    try {
      const r = await api("/published", { method: "PUT", body: JSON.stringify({ published: next }) });
      data.published = r.published;
      renderPublish();
    } catch (err) { alert(err.message); }
  });

  function renderStats() {
    const t = data.totals;
    const card = (label, value, sub) => `<div class="panel"><div class="stat-label">${label}</div><div class="stat-value">${value}</div>${sub ? `<div class="stat-sub">${sub}</div>` : ""}</div>`;
    document.getElementById("crs-stats").innerHTML =
      card("Alumnos", t.students, "") +
      card("Ingresos del curso", money(t.incomeCents), "") +
      card("Regalos mayorista", money(t.giftCents), "S/ 10 por acceso creado") +
      card("Neto", money(t.netCents), "ingresos − regalos") +
      card("Terminaron", t.finished, "vieron los 5 episodios");
  }

  function renderMedia() {
    document.getElementById("crs-media").innerHTML = Object.keys(MEDIA_LABELS).map(kind => {
      const m = data.media[kind];
      const up = uploading[kind];
      const state = up
        ? `Subiendo… <b>${Math.floor(up.pct)}%</b><div class="crs-bar"><i style="width:${up.pct}%"></i></div>`
        : m.exists ? `✅ Subido · ${mb(m.size)} · ${fmtDate(m.updatedAt)}` : `⚠️ Falta subir`;
      const accept = kind === "gestor" ? ".xlsx" : "video/mp4,.mp4";
      return `<div class="crs-media-row">
        <div class="name"><b>${MEDIA_LABELS[kind]}</b></div>
        <div class="state" id="crs-state-${kind}">${state}</div>
        <div class="acts">
          ${m.exists && !up ? `<a class="btn-secondary btn-sm" href="/api/course-admin/media/${kind}" target="_blank" rel="noopener" style="text-decoration:none">${kind === "gestor" ? "Descargar" : "Ver"}</a>` : ""}
          <label class="btn-primary btn-sm" style="cursor:pointer">${m.exists ? "Reemplazar" : "Subir"}
            <input type="file" accept="${accept}" data-kind="${kind}" hidden ${up ? "disabled" : ""}></label>
        </div>
      </div>`;
    }).join("");
    document.querySelectorAll("#crs-media input[type=file]").forEach(inp => {
      inp.addEventListener("change", () => { if (inp.files[0]) upload(inp.dataset.kind, inp.files[0]); });
    });
  }

  async function upload(kind, file) {
    if (kind !== "gestor" && !/\.mp4$/i.test(file.name)) { alert("El video tiene que ser .mp4"); return; }
    if (kind === "gestor" && !/\.xlsx$/i.test(file.name)) { alert("La plantilla tiene que ser .xlsx"); return; }
    const uploadId = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, "0")).join("");
    uploading[kind] = { pct: 0 };
    renderMedia();

    let offset = 0;
    let fails = 0;
    while (offset < file.size) {
      const part = file.slice(offset, offset + CHUNK);
      try {
        const res = await fetch(`/api/course-admin/upload?kind=${kind}&uploadId=${uploadId}&offset=${offset}&total=${file.size}`, {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/octet-stream" },
          body: part,
        });
        const out = await res.json().catch(() => ({}));
        if (res.status === 409 && Number.isInteger(out.expectedOffset)) { offset = out.expectedOffset; continue; }
        if (!res.ok) {
          if (res.status >= 500 && res.status !== 507 && fails < 5) throw new Error(out.message || "Error");
          delete uploading[kind];
          alert("No se pudo subir: " + (out.message || "error"));
          renderMedia();
          return;
        }
        offset = out.received;
        fails = 0;
      } catch (err) {
        // Red inestable: reintenta la misma parte (hasta 5 veces seguidas).
        fails++;
        if (fails > 5) {
          delete uploading[kind];
          alert("Se cortó la conexión subiendo el archivo. Vuelve a intentarlo.");
          renderMedia();
          return;
        }
        await new Promise(r => setTimeout(r, 1500 * fails));
        continue;
      }
      uploading[kind].pct = offset / file.size * 100;
      const st = document.getElementById("crs-state-" + kind);
      if (st) st.innerHTML = `Subiendo… <b>${Math.floor(uploading[kind].pct)}%</b> · ${mb(offset)} de ${mb(file.size)}<div class="crs-bar"><i style="width:${uploading[kind].pct}%"></i></div>`;
    }
    delete uploading[kind];
    await load();
  }

  function renderCues() {
    const rows = [];
    for (const ep of data.episodes) {
      (data.cues[ep.n] || []).forEach((c, i) => {
        rows.push(`<div class="crs-cue" data-ep="${ep.n}" data-i="${i}">
          <span class="lbl">Ep. ${ep.n} · ${CUE_LABELS[c.type] || c.type}</span>
          <label>Aparece en <input data-f="start" value="${fmt(c.start)}"></label>
          <label>Resaltado hasta <input data-f="end" value="${fmt(c.end)}"></label>
        </div>`);
      });
    }
    document.getElementById("crs-cues").innerHTML = rows.join("") || `<p class="panel-hint">Sin recursos configurados.</p>`;
  }

  document.getElementById("crs-cues-save").addEventListener("click", async () => {
    const cues = JSON.parse(JSON.stringify(data.cues));
    for (const row of document.querySelectorAll("#crs-cues .crs-cue")) {
      const c = cues[row.dataset.ep][Number(row.dataset.i)];
      const start = toSec(row.querySelector('[data-f="start"]').value);
      const end = toSec(row.querySelector('[data-f="end"]').value);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        alert("Revisa los tiempos del episodio " + row.dataset.ep + ": usa minutos:segundos y que «hasta» sea después de «aparece».");
        return;
      }
      c.start = start; c.end = end;
    }
    try {
      await api("/cues", { method: "PUT", body: JSON.stringify({ cues }) });
      data.cues = cues;
      alert("✅ Tiempos guardados");
    } catch (err) { alert(err.message); }
  });

  document.getElementById("crs-price-save").addEventListener("click", async () => {
    const price = Number(document.getElementById("crs-price").value);
    const regularPrice = Number(document.getElementById("crs-regular-price").value);
    try {
      const r = await api("/price", { method: "PUT", body: JSON.stringify({ price, regularPrice }) });
      Object.assign(data, r);
      renderLaunchHint();
      alert("✅ Precios guardados: lanzamiento S/ " + price.toFixed(2) + " · normal S/ " + regularPrice.toFixed(2));
    } catch (err) { alert(err.message); }
  });

  document.getElementById("crs-grant-btn").addEventListener("click", async () => {
    const phone = document.getElementById("crs-grant-phone").value;
    const amount = Number(document.getElementById("crs-grant-amount").value);
    const out = document.getElementById("crs-grant-result");
    try {
      const r = await api("/grant", { method: "POST", body: JSON.stringify({ phone, amount }) });
      out.textContent = r.newPin
        ? `✅ Acceso dado. Era cliente nuevo: entra en liordark.com/curso/aprender con su celular y el PIN ${r.newPin}.`
        : "✅ Acceso dado. Entra en liordark.com/curso/aprender con su celular y su PIN de siempre.";
      document.getElementById("crs-grant-phone").value = "";
      load();
    } catch (err) { out.textContent = "❌ " + err.message; }
  });

  function renderStudents() {
    const tb = document.getElementById("crs-students");
    document.getElementById("crs-students-empty").hidden = data.students.length > 0;
    tb.innerHTML = data.students.map(s => `<tr${s.status === "revoked" ? ' style="opacity:.5"' : ""}>
      <td>${esc(s.phone)}</td>
      <td>S/ ${esc(Number(s.amount).toFixed(2))}${s.source === "admin" ? " <small>(manual)</small>" : ""}</td>
      <td>${fmtDate(s.paidAt)}</td>
      <td>${s.completedEpisodes}/5</td>
      <td>${s.downloads ? "✓ " + s.downloads : "—"}</td>
      <td>${s.panelName ? esc(s.panelName) + " · " + esc(s.claimPhone) : "—"}</td>
      <td>${s.coupon ? esc(s.coupon) : "—"}</td>
      <td>${s.status === "paid" ? `<button class="btn-secondary btn-sm" data-revoke="${s.id}">Quitar acceso</button>` : "Sin acceso"}</td>
    </tr>`).join("");
    tb.querySelectorAll("[data-revoke]").forEach(b => b.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("¿Quitar el acceso al curso a este alumno?")) return;
      try { await api("/purchases/" + b.dataset.revoke + "/revoke", { method: "POST" }); load(); }
      catch (err) { alert(err.message); }
    }));
  }

  return { load };
})();
