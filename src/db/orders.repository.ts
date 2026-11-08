import { db } from "./db";

export type ApprovedOrderRow = {
  id:        number;
  message:   string;
  createdAt: string;
};

/**
 * Guarda una orden aprobada — el bot no las conserva una vez entregadas.
 * createdAt debe venir del bot (ISO UTC con "Z"); si no se pasa, se usa
 * la hora del panel. No dejar que el default de SQLite (datetime('now'),
 * sin "Z") guarde la hora, porque el navegador la interpreta como hora
 * local y desfasa el horario mostrado.
 */
export function insertApprovedOrder(message: string, createdAt?: string): number {
  const result = db.prepare(`
    INSERT INTO orders_log (message, created_at) VALUES (?, ?)
  `).run(message, createdAt ?? new Date().toISOString());
  return result.lastInsertRowid as number;
}

export function getRecentApprovedOrders(limit: number): ApprovedOrderRow[] {
  return (db.prepare(`
    SELECT * FROM orders_log ORDER BY created_at DESC LIMIT ?
  `).all(limit) as any[]).map(row => ({
    id: row.id, message: row.message, createdAt: row.created_at,
  }));
}

/** Busca en el texto guardado (trae el teléfono tal cual, ej. "👤 51987654321"). */
export function searchApprovedOrders(term: string, limit: number): ApprovedOrderRow[] {
  return (db.prepare(`
    SELECT * FROM orders_log WHERE message LIKE ? ORDER BY created_at DESC LIMIT ?
  `).all("%" + term + "%", limit) as any[]).map(row => ({
    id: row.id, message: row.message, createdAt: row.created_at,
  }));
}

/**
 * Aprobados con HTML peligroso guardado (iframe, script, eventos on…=,
 * javascript:). Desde el arreglo del 8-nov el panel ya no los ejecuta;
 * esto solo avisa en el log si alguien lo intentó (auditoría C1).
 */
export function findSuspiciousApprovedOrders(): { id: number; createdAt: string }[] {
  return (db.prepare(`
    SELECT id, created_at FROM orders_log
    WHERE lower(message) LIKE '%<iframe%' OR lower(message) LIKE '%<script%' OR lower(message) LIKE '%srcdoc%'
       OR lower(message) LIKE '%javascript:%' OR lower(message) LIKE '%onerror=%' OR lower(message) LIKE '%onload=%'
       OR lower(message) LIKE '%<img%' OR lower(message) LIKE '%<svg%'
    ORDER BY id DESC LIMIT 50
  `).all() as any[]).map(r => ({ id: r.id, createdAt: r.created_at }));
}
