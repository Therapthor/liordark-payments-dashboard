import { findCustomerByPhone, clearCustomerLockout } from "../db/customer.repository";
import { clearWholesalerLockout } from "../db/wholesaler.repository";
import {
  grantLoginPass,
  loginFailureIps,
  resetIpLoginFailures,
  unblockIp,
} from "../db/security.repository";

// ─────────────────────────────────────────────────────────────
// QUITAR BLOQUEO (panel) — deja entrar YA, sin esperas:
//  · limpia el bloqueo del número (intentos fallidos),
//  · limpia el de las conexiones (IP) desde donde ese número falló,
//  · le da un pase de 24 h: ese número entra aunque su conexión esté
//    bloqueada o compartida (en Perú muchos celulares comparten IP).
// El bloqueo de su propio número sigue funcionando: si vuelve a fallar el
// PIN, se bloquea de nuevo.
// ─────────────────────────────────────────────────────────────

/** `extraIps`: conexiones a liberar del todo (ej. la del baneo al desbloquear un número). */
export function unlockCustomerLogin(phone: string, extraIps: string[] = []): void {
  const customer = findCustomerByPhone(phone);
  if (customer) clearCustomerLockout(customer.id);
  for (const ip of loginFailureIps("cliente", phone)) resetIpLoginFailures(ip);
  for (const ip of extraIps) {
    if (!ip) continue;
    unblockIp(ip);
    resetIpLoginFailures(ip);
  }
  grantLoginPass("cliente", phone);
}

export function unlockWholesalerLogin(w: { id: number; phone: string }): void {
  clearWholesalerLockout(w.id);
  grantLoginPass("mayorista", w.phone);
}
