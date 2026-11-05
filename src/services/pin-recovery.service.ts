import { Worker } from "worker_threads";
import { listCustomersForPinRecovery, savePinRecovery } from "../db/customer.repository";

// ─────────────────────────────────────────────────────────────
// RECUPERAR PIN — cuentas viejas que quedaron solo con el hash (sin la
// contraseña visible). Como el PIN es de 4 números, se prueban las 10,000
// combinaciones contra el hash, en un hilo aparte para no frenar el panel.
// Si la clave no era de 4 números (claves antiguas con letras) queda como
// «not_found» y no se vuelve a intentar.
// ─────────────────────────────────────────────────────────────

const WORKER_CODE = `
const { parentPort, workerData } = require("worker_threads");
const bcrypt = require(workerData.bcryptPath);
const { hash, phone } = workerData;
const tried = new Set();
const order = [];
const d = String(phone).replace(/\\D/g, "");
for (const c of [d.slice(-4), d.slice(0, 4), d.slice(-6, -2)]) if (/^\\d{4}$/.test(c)) order.push(c);
for (let i = 0; i < 10000; i++) order.push(String(i).padStart(4, "0"));
// Pausa entre intentos (~mitad del tiempo) para no acaparar el CPU del servidor.
const sleep = new Int32Array(new SharedArrayBuffer(4));
let found = null;
for (const pin of order) {
  if (tried.has(pin)) continue;
  tried.add(pin);
  const t = Date.now();
  if (bcrypt.compareSync(pin, hash)) { found = pin; break; }
  Atomics.wait(sleep, 0, 0, Date.now() - t);
}
parentPort.postMessage(found);
`;

function crackPin(hash: string, phone: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (!/^\$2[aby]\$/.test(hash)) return resolve(null);
    const worker = new Worker(WORKER_CODE, {
      eval: true,
      workerData: { hash, phone, bcryptPath: require.resolve("bcryptjs") },
    });
    worker.once("message", (pin) => { resolve(pin); void worker.terminate(); });
    worker.once("error", (err: any) => { console.error("⚠️ recuperar PIN:", err?.message); resolve(undefined as any); });
  });
}

let running = false;

/** Recorre las cuentas pendientes de a una. Seguro de llamar varias veces. */
export async function runPinRecovery(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const c of listCustomersForPinRecovery()) {
      const pin = await crackPin(c.passwordHash, c.phone);
      if (pin === undefined) continue; // error del hilo: se reintenta en la próxima pasada
      savePinRecovery(c.id, pin);
      console.log(pin ? `🔑 PIN recuperado para ${c.phone}` : `🔑 ${c.phone}: la clave no es un PIN de 4 números`);
    }
  } finally {
    running = false;
  }
}
