// ─────────────────────────────────────────────────────────────
// IMPORTAR CUENTAS DESDE EL EXPORT DEL BOT (Sheets → panel)
//
// Lee el JSON generado por export-accounts.ts (repo del bot) y llena
// Accesos: cuentas activas van a access_accounts/access_profiles, las ya
// vencidas van directo a access_accounts_history.
//
// Cada cuenta (bloque de perfiles) usa UNA sola fecha de vencimiento — la
// más lejana entre sus clientes ocupados — para no archivar por error a
// alguien que todavía sigue vigente.
//
// Uso:
//   npx tsx src/scripts/import-accounts.ts export-accounts.json          (simulación — no escribe nada)
//   npx tsx src/scripts/import-accounts.ts export-accounts.json --apply  (escribe de verdad)
// ─────────────────────────────────────────────────────────────

import fs from "fs";
import { db } from "../db/db";

type ExportedProfile = {
  slotNumber:  number;
  profileName: string;
  clientPhone: string;
  expiresAt:   string | null;
};

type ExportedAccount = {
  email:    string;
  password: string;
  profiles: ExportedProfile[];
};

type ExportedPlatform = {
  platform:    string;
  hasProfiles: boolean;
  accounts:    ExportedAccount[];
};

type ExportFile = {
  generatedAt: string;
  platforms:   ExportedPlatform[];
};

function todayISO(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date());
}

function slotsFor(hasProfiles: boolean): number {
  return hasProfiles ? 5 : 1;
}

/** La fecha de la cuenta = la más lejana entre sus clientes ocupados con fecha. null si ninguno tiene. */
function accountExpiry(account: ExportedAccount): string | null {
  const dates = account.profiles
    .filter(p => p.clientPhone && p.expiresAt)
    .map(p => p.expiresAt as string);
  if (dates.length === 0) return null;
  return dates.reduce((max, d) => (d > max ? d : max));
}

function main(): void {
  const args    = process.argv.slice(2);
  const apply   = args.includes("--apply");
  const force   = args.includes("--force");
  const jsonPath = args.find(a => !a.startsWith("--"));

  if (!jsonPath) {
    console.error("Uso: npx tsx src/scripts/import-accounts.ts <export.json> [--apply] [--force]");
    process.exit(1);
  }

  const data: ExportFile = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  const today = todayISO();

  const existingAccounts = (db.prepare(`SELECT COUNT(*) AS c FROM access_accounts`).get() as any).c as number;
  if (apply && existingAccounts > 0 && !force) {
    console.error(
      `❌ Ya hay ${existingAccounts} cuenta(s) en Accesos. Para no duplicar, corre con --force si de ` +
      `verdad quieres importar igual (ej. si ya sabes que son datas de prueba tuyas).`
    );
    process.exit(1);
  }

  const insertAccount = db.prepare(`
    INSERT INTO access_accounts (platform, email, password, has_profiles, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertProfile = db.prepare(`
    INSERT INTO access_profiles (account_id, slot_number, profile_name, client_phone)
    VALUES (?, ?, ?, ?)
  `);
  const insertHistory = db.prepare(`
    INSERT INTO access_accounts_history
      (original_account_id, platform, email, password, has_profiles, expires_at, profiles_json)
    VALUES (0, ?, ?, ?, ?, ?, ?)
  `);

  let totalActive = 0, totalHistory = 0, totalOccupied = 0, totalFree = 0;

  const runImport = db.transaction(() => {
    for (const plat of data.platforms) {
      let platActive = 0, platHistory = 0;

      for (const acc of plat.accounts) {
        if (!acc.email) continue; // fila vacía/mal formada — se ignora

        const expiresAt = accountExpiry(acc);
        const occupied = acc.profiles.filter(p => p.clientPhone).length;
        const free     = acc.profiles.length - occupied;
        totalOccupied += occupied;
        totalFree     += free;

        const isExpired = expiresAt !== null && expiresAt < today;

        if (isExpired) {
          platHistory++;
          totalHistory++;
          if (apply) {
            const profilesJson = acc.profiles.map(p => ({
              slotNumber: p.slotNumber, profileName: p.profileName,
              clientPhone: (p.clientPhone || "").replace(/\D/g, ""), renewalStatus: "",
            }));
            insertHistory.run(
              plat.platform, acc.email, acc.password,
              plat.hasProfiles ? 1 : 0, expiresAt, JSON.stringify(profilesJson)
            );
          }
        } else {
          platActive++;
          totalActive++;
          if (apply) {
            const result = insertAccount.run(
              plat.platform, acc.email, acc.password, plat.hasProfiles ? 1 : 0, expiresAt
            );
            const accountId = result.lastInsertRowid as number;

            const slots = Math.max(slotsFor(plat.hasProfiles), acc.profiles.length);
            for (let slot = 1; slot <= slots; slot++) {
              const p = acc.profiles.find(pr => pr.slotNumber === slot);
              insertProfile.run(
                accountId, slot,
                p?.profileName || (slots === 1 ? "" : "Perfil " + slot),
                (p?.clientPhone || "").replace(/\D/g, "") // por si el JSON trae espacios/guiones sin limpiar
              );
            }
          }
        }
      }

      console.error(`${plat.platform}: ${platActive} activa(s), ${platHistory} al historial`);
    }
  });

  runImport();

  console.error("");
  console.error(`Total cuentas activas:   ${totalActive}`);
  console.error(`Total al historial:      ${totalHistory}`);
  console.error(`Clientes ocupados:       ${totalOccupied}`);
  console.error(`Perfiles libres (stock): ${totalFree}`);
  console.error("");
  console.error(apply ? "✅ Importado de verdad." : "👀 Simulación — no se escribió nada. Corre con --apply para hacerlo real.");
}

main();
