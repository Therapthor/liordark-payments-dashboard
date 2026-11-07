// Correo con forma válida y sin caracteres que puedan romper HTML
// (< > " ' `) — estos correos los escribe el cliente y después se
// muestran en el panel.
const SAFE_EMAIL_RE = /^[^\s@<>"'`]+@[^\s@<>"'`]+\.[^\s@<>"'`]+$/;

export function isSafeEmail(email: string): boolean {
  return email.length <= 254 && SAFE_EMAIL_RE.test(email);
}

/** El correo limpio, o undefined si no vino o no es válido. */
export function cleanEmail(raw: unknown): string | undefined {
  const email = raw ? String(raw).trim() : "";
  return email && isSafeEmail(email) ? email : undefined;
}
