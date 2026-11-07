// ─────────────────────────────────────────────────────────────
// BLOQUEO POR INTENTOS FALLIDOS — lógica compartida entre el login de
// clientitos (customer.repository.ts) y el de mayoristas
// (wholesaler.repository.ts). Cada uno guarda failed_login_count/
// locked_until en su propia tabla (mismas dos columnas) y llama a estas
// funciones puras para decidir cuánto bloquear — así la fórmula vive en
// un solo lugar, no se duplica ni puede desincronizarse entre los dos.
//
// 1-2 fallos: nada. 3: 1 min. 4: 2 min. 5: 4 min. 6: 8 min. 7+: 15 min
// (tope). Se resetea a cero en un login exitoso.
// ─────────────────────────────────────────────────────────────

const LOCKOUT_START_AT_ATTEMPT = 3;
const LOCKOUT_CAP_MINUTES      = 15;

export function computeLockoutMinutes(failedCount: number): number {
  if (failedCount < LOCKOUT_START_AT_ATTEMPT) return 0;
  return Math.min(LOCKOUT_CAP_MINUTES, 2 ** (failedCount - LOCKOUT_START_AT_ATTEMPT));
}

/** Qué guardar después de un intento fallido, dado el contador ANTES de este intento. */
export function nextLockoutState(previousFailedCount: number): { failedLoginCount: number; lockedUntil: string | null } {
  const failedLoginCount = previousFailedCount + 1;
  const minutes = computeLockoutMinutes(failedLoginCount);
  const lockedUntil = minutes > 0 ? new Date(Date.now() + minutes * 60 * 1000).toISOString() : null;
  return { failedLoginCount, lockedUntil };
}

export type LockoutCheck =
  | { locked: false }
  | { locked: true; retryAfterSeconds: number };

export function checkLockout(lockedUntil: string | null | undefined): LockoutCheck {
  if (!lockedUntil) return { locked: false };
  const remainingMs = new Date(lockedUntil).getTime() - Date.now();
  if (remainingMs <= 0) return { locked: false };
  return { locked: true, retryAfterSeconds: Math.ceil(remainingMs / 1000) };
}

// ─────────────────────────────────────────────────────────────
// CLIENTES (tienda) — más estricto: cada 2 intentos fallidos seguidos se
// bloquea más tiempo: 1 h → 8 h → 2 días → 7 días → 30 días. Se aplica por
// número y por IP. Para desbloquear antes: WhatsApp (el admin usa «Quitar
// bloqueo» o el reset de PIN).
// ─────────────────────────────────────────────────────────────

const CUSTOMER_LADDER_MINUTES = [60, 8 * 60, 2 * 24 * 60, 7 * 24 * 60, 30 * 24 * 60];

export function computeCustomerLockoutMinutes(failedCount: number): number {
  if (failedCount < 2 || failedCount % 2 !== 0) return 0;
  const step = failedCount / 2 - 1;
  return CUSTOMER_LADDER_MINUTES[Math.min(step, CUSTOMER_LADDER_MINUTES.length - 1)]!;
}

export function nextCustomerLockoutState(previousFailedCount: number): { failedLoginCount: number; lockedUntil: string | null } {
  const failedLoginCount = previousFailedCount + 1;
  const minutes = computeCustomerLockoutMinutes(failedLoginCount);
  const lockedUntil = minutes > 0 ? new Date(Date.now() + minutes * 60 * 1000).toISOString() : null;
  return { failedLoginCount, lockedUntil };
}

export function lockoutDurationText(retryAfterSeconds: number): string {
  const min = Math.ceil(retryAfterSeconds / 60);
  if (min < 60) return `${min} min`;
  const h = Math.ceil(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.ceil(h / 24)} días`;
}
