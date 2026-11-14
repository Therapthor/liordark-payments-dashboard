import { db } from "./db";

// ─────────────────────────────────────────────────────────────
// AVISOS — ventana con imagen que aparece al entrar a la tienda
// (liordark.com) o al panel de mayoristas (mayorista.liordark.com).
// Una fila por sitio. «rev» cambia cada vez que cambia lo que se ve
// (imagen, texto o botón): así quien ya vio el aviso viejo ve el nuevo.
// ─────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS site_avisos (
    target          TEXT PRIMARY KEY,               -- 'store' | 'wholesale'
    active          INTEGER NOT NULL DEFAULT 0,
    image_url       TEXT    NOT NULL DEFAULT '',
    image_public_id TEXT    NOT NULL DEFAULT '',    -- Cloudinary (vacío si se guardó en data/)
    image_w         INTEGER NOT NULL DEFAULT 0,
    image_h         INTEGER NOT NULL DEFAULT 0,
    title           TEXT    NOT NULL DEFAULT '',
    button_type     TEXT    NOT NULL DEFAULT 'none', -- none | product | combo | link
    product_id      INTEGER,
    link_url        TEXT    NOT NULL DEFAULT '',
    button_text     TEXT    NOT NULL DEFAULT '',
    frequency       TEXT    NOT NULL DEFAULT 'once', -- once | daily
    ends_on         TEXT    NOT NULL DEFAULT '',     -- YYYY-MM-DD (hora de Lima), último día que se muestra
    rev             TEXT    NOT NULL DEFAULT '',
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

export type AvisoTarget = "store" | "wholesale";
export type AvisoButtonType = "none" | "product" | "combo" | "link";
export type AvisoFrequency = "once" | "daily";

export type Aviso = {
  target:        AvisoTarget;
  active:        boolean;
  imageUrl:      string;
  imagePublicId: string;
  imageW:        number;
  imageH:        number;
  title:         string;
  buttonType:    AvisoButtonType;
  productId:     number | null;
  linkUrl:       string;
  buttonText:    string;
  frequency:     AvisoFrequency;
  endsOn:        string;
  rev:           string;
  updatedAt:     string;
};

function toAviso(target: AvisoTarget, row: any): Aviso {
  return {
    target,
    active:        !!row?.active,
    imageUrl:      row?.image_url ?? "",
    imagePublicId: row?.image_public_id ?? "",
    imageW:        row?.image_w ?? 0,
    imageH:        row?.image_h ?? 0,
    title:         row?.title ?? "",
    buttonType:    (row?.button_type ?? "none") as AvisoButtonType,
    productId:     row?.product_id ?? null,
    linkUrl:       row?.link_url ?? "",
    buttonText:    row?.button_text ?? "",
    frequency:     (row?.frequency === "daily" ? "daily" : "once"),
    endsOn:        row?.ends_on ?? "",
    rev:           row?.rev ?? "",
    updatedAt:     row?.updated_at ?? "",
  };
}

export function getAviso(target: AvisoTarget): Aviso {
  const row = db.prepare(`SELECT * FROM site_avisos WHERE target = ?`).get(target);
  return toAviso(target, row);
}

export function saveAviso(a: Aviso): Aviso {
  db.prepare(`
    INSERT INTO site_avisos (target, active, image_url, image_public_id, image_w, image_h, title, button_type,
                             product_id, link_url, button_text, frequency, ends_on, rev, updated_at)
    VALUES (@target, @active, @imageUrl, @imagePublicId, @imageW, @imageH, @title, @buttonType,
            @productId, @linkUrl, @buttonText, @frequency, @endsOn, @rev, datetime('now'))
    ON CONFLICT(target) DO UPDATE SET
      active = excluded.active, image_url = excluded.image_url, image_public_id = excluded.image_public_id,
      image_w = excluded.image_w, image_h = excluded.image_h, title = excluded.title,
      button_type = excluded.button_type, product_id = excluded.product_id, link_url = excluded.link_url,
      button_text = excluded.button_text, frequency = excluded.frequency, ends_on = excluded.ends_on,
      rev = excluded.rev, updated_at = excluded.updated_at
  `).run({ ...a, active: a.active ? 1 : 0 });
  return getAviso(a.target);
}
