(() => {
  "use strict";

  // ─────────────────────────────────────────────────────────────
  // LLAVES DE ACCESO (Face ID / huella / llavero de iCloud) — habla con
  // /api/auth/passkey/*. El teléfono firma; la llave privada nunca sale.
  // ─────────────────────────────────────────────────────────────

  const supported = () => !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create);

  function b64urlToBuf(s) {
    const pad = "=".repeat((4 - (s.length % 4)) % 4);
    const bin = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  function bufToB64url(buf) {
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  async function post(path, body) {
    const res = await fetch("/api/auth" + path, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || "Error de red");
    return data;
  }

  function friendly(err) {
    const name = err && err.name;
    if (name === "NotAllowedError") return "Se canceló o se venció el tiempo. Vuelve a intentarlo.";
    if (name === "InvalidStateError") return "Esta llave ya está registrada en este dispositivo.";
    if (name === "SecurityError") return "Las llaves de acceso solo funcionan en https://panel.liordark.com.";
    return (err && err.message) || "No se pudo usar la llave de acceso.";
  }

  /** Registra una llave nueva (pide la contraseña del panel). */
  async function register(password, name) {
    if (!supported()) throw new Error("Este navegador no admite llaves de acceso.");
    const o = await post("/passkey/register/options", { password });
    const publicKey = {
      ...o,
      challenge: b64urlToBuf(o.challenge),
      user: { ...o.user, id: b64urlToBuf(o.user.id) },
      excludeCredentials: (o.excludeCredentials || []).map(c => ({ ...c, id: b64urlToBuf(c.id) })),
    };
    let cred;
    try { cred = await navigator.credentials.create({ publicKey }); }
    catch (err) { throw new Error(friendly(err)); }
    const r = cred.response;
    const response = {
      id: cred.id,
      rawId: bufToB64url(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: bufToB64url(r.clientDataJSON),
        attestationObject: bufToB64url(r.attestationObject),
        transports: typeof r.getTransports === "function" ? r.getTransports() : [],
      },
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
    };
    return post("/passkey/register/verify", { response, name });
  }

  /** Entra al panel con una llave registrada. */
  async function login() {
    if (!supported()) throw new Error("Este navegador no admite llaves de acceso.");
    const o = await post("/passkey/login/options");
    const publicKey = {
      ...o,
      challenge: b64urlToBuf(o.challenge),
      allowCredentials: (o.allowCredentials || []).map(c => ({ ...c, id: b64urlToBuf(c.id) })),
    };
    let cred;
    try { cred = await navigator.credentials.get({ publicKey }); }
    catch (err) { throw new Error(friendly(err)); }
    const r = cred.response;
    const response = {
      id: cred.id,
      rawId: bufToB64url(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: bufToB64url(r.clientDataJSON),
        authenticatorData: bufToB64url(r.authenticatorData),
        signature: bufToB64url(r.signature),
        userHandle: r.userHandle ? bufToB64url(r.userHandle) : undefined,
      },
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
    };
    return post("/passkey/login/verify", { response });
  }

  window.LiordarkPasskey = { supported, register, login };
})();
