# Liordark — panel, tienda, mayoristas y Manguito Pro

La memoria completa (dueño, publicación, verificación y reglas de seguridad) está en `CLAUDE.md` del repo `Therapthor/proyecto-cuentas-bot-backend`. Si no está en la sesión, agregarlo con `add_repo` y leerlo. Resumen obligatorio:

- Responder en español, preciso y breve; el dueño no es técnico. Aprobación permanente para publicar.
- Nunca en código, commits ni chat: claves, tokens, contraseñas, celulares o correos de clientes, buzones del dueño, enlaces de bandejas de proveedores, URLs de Apps Script, llaves privadas. Revisar `git diff --cached` antes de cada commit.
- Pruebas solo con mocks; nunca proveedores reales.

## Este repo
- **Mapa de dónde está cada cosa: `docs/MAPA.md`** — leerlo antes de buscar; actualizarlo si se mueve o crea algo importante.
- Express 5 + TypeScript + better-sqlite3 (`data/payments.db`).
- `public/` = panel (panel.liordark.com) · `public-store/` = tienda (liordark.com) y Manguito Pro (`/manguito/`) · `public-wholesale/` = mayorista.liordark.com.
- `src/routes`, `src/services`, `src/db` (repositorios con migraciones `PRAGMA table_info` + `ALTER TABLE`).
- Publicar: rama nueva desde `origin/main`, `npx tsc --noEmit`, `git merge-base --is-ancestor origin/main HEAD` y push a `main` → «Deploy al VPS» (~20 s).
- Verificar: workflow `vps-diagnostics.yml` del repo del bot (revisión `estado` muestra el commit en el servidor; `tienda-version` lo que ve el público).
- Manguito Pro: sin herramientas para el modelo, CSP estricta, todo escapado; subidas en partes de 900 KB (límite de nginx ~1 MB).
