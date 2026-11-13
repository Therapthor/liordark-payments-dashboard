import { findCustomerByPhone, clearCustomerLockout, listAllCustomers } from "../db/customer.repository";
import { clearWholesalerLockout, listLockedWholesalers } from "../db/wholesaler.repository";
import {
  grantLoginPass,
  loginFailureIps,
  resetIpLoginFailures,
  unblockIp,
  customerIpLocks,
  listBlockedIps,
  listIpFailureLocks,
} from "../db/security.repository";
import { checkLockout } from "./login-lockout.service";

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

// ─────────────────────────────────────────────────────────────
// DESBLOQUEAR A TODOS (Clientes › Bloqueados) — quita de una vez todos los
// bloqueos TEMPORALES, con lo mismo que usa cada «Quitar bloqueo»:
//  · clientes bloqueados por intentos (por su número o por su conexión),
//  · mayoristas bloqueados,
//  · conexiones (IP) bloqueadas, con su contador de fallos en cero.
// Los números baneados («🚫 Números bloqueados») NO se tocan: ese bloqueo es
// a propósito y se quita uno por uno.
// ─────────────────────────────────────────────────────────────

export type UnlockAllResult = { customers: number; wholesalers: number; ips: number };

export function unlockAllTemporaryBlocks(): UnlockAllResult {
  // Foto de lo bloqueado ANTES de tocar nada: al liberar a un cliente también
  // se limpian sus conexiones, y la cuenta de IPs saldría corta.
  const ips = new Set([...listBlockedIps().map(b => b.ip), ...listIpFailureLocks().map(f => f.ip)]);
  const ipLocks = customerIpLocks();
  let customers = 0;
  for (const c of listAllCustomers()) {
    const byPhone = !!c.lockedUntil && checkLockout(c.lockedUntil).locked;
    const byIp = ipLocks.has(c.phone.replace(/\D/g, "").slice(-9));
    if (!byPhone && !byIp) continue;
    unlockCustomerLogin(c.phone);
    customers++;
  }

  const lockedWholesalers = listLockedWholesalers();
  for (const w of lockedWholesalers) unlockWholesalerLogin(w);

  for (const ip of ips) {
    unblockIp(ip);
    resetIpLoginFailures(ip);
  }

  return { customers, wholesalers: lockedWholesalers.length, ips: ips.size };
}
