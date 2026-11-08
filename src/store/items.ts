import type { HubItem } from "../core/types.js";
import type { SourceRows, StoreContext } from "./context.js";
import { type HealthColumns, isHealthy } from "./health.js";

export const ITEMS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS items (
    source     TEXT    NOT NULL,
    type       TEXT    NOT NULL,
    id         TEXT    NOT NULL,
    position   INTEGER NOT NULL,
    title      TEXT    NOT NULL,
    status     TEXT    NOT NULL,
    attention  INTEGER NOT NULL,
    updated_at TEXT    NOT NULL,
    data       TEXT    NOT NULL,
    PRIMARY KEY (source, type, id)
  );
`;

/** Every field left out matches any Item. */
export interface ItemFilter {
  type?: string;
  status?: string;
  attention?: boolean;
}

/** An Item as queries return it: what the Adapter sent, plus its Source's freshness. */
export interface StoredItem extends HubItem {
  /** Whether the Item's Source is Healthy now; false means the Item is Stale. */
  sourceOk: boolean;
  /** When the Item's Source last reported success; null if it never has. */
  lastOkAt: string | null;
}

export interface ItemQueries {
  /** Ordered by Source and type, then in the order the Adapter sent them. */
  list(filter?: ItemFilter): StoredItem[];
}

/** The Items slice of the Store. */
export interface ItemsPart {
  readonly items: ItemQueries;
  /**
   * Swaps the full set for one Source and type atomically. An Item identical
   * in title, Status, Attention and data to the stored one keeps its stored
   * `updatedAt`; any other Item is stored as sent.
   */
  replaceItems(source: string, type: string, items: readonly HubItem[]): void;
}

interface ItemRow {
  source: string;
  type: string;
  id: string;
  title: string;
  status: string;
  attention: number;
  updated_at: string;
  data: string;
}

interface QueriedRow extends ItemRow, HealthColumns {
  last_ok_at: string | null;
}

export function itemsPart({ db, now }: StoreContext): ItemsPart {
  const insert = db.prepare(
    `INSERT INTO items (source, type, id, position, title, status, attention, updated_at, data)
     VALUES (@source, @type, @id, @position, @title, @status, @attention, @updatedAt, @data)`,
  );
  const select = db.prepare<[{ type: string | null; status: string | null; attention: number | null }], QueriedRow>(
    `SELECT items.*, health.ok, health.at, health.stale_after_ms, health.last_ok_at
     FROM items LEFT JOIN health USING (source)
     WHERE (@type IS NULL OR type = @type)
       AND (@status IS NULL OR status = @status)
       AND (@attention IS NULL OR attention = @attention)
     ORDER BY source, type, position`,
  );
  const selectSet = db.prepare<[string, string], ItemRow>("SELECT * FROM items WHERE source = ? AND type = ?");
  const removeSet = db.prepare("DELETE FROM items WHERE source = ? AND type = ?");

  const replace = db.transaction((source: string, type: string, items: readonly HubItem[]) => {
    const stored = new Map(selectSet.all(source, type).map((row) => [row.id, row]));
    removeSet.run(source, type);
    items.forEach((item, position) => {
      const row = {
        id: item.id,
        title: item.title,
        status: item.status,
        attention: item.attention ? 1 : 0,
        data: JSON.stringify(item.data ?? null),
      };
      const before = stored.get(item.id);
      const unchanged =
        before !== undefined &&
        before.title === row.title &&
        before.status === row.status &&
        before.attention === row.attention &&
        before.data === row.data;
      insert.run({ ...row, source, type, position, updatedAt: unchanged ? before.updated_at : item.updatedAt });
    });
  });

  return {
    items: {
      list: ({ type, status, attention } = {}) => {
        const at = now();
        return select
          .all({ type: type ?? null, status: status ?? null, attention: attention === undefined ? null : Number(attention) })
          .map((row) => ({ ...fromRow(row), sourceOk: isHealthy(row, at), lastOkAt: row.last_ok_at }));
      },
    },
    replaceItems: (source, type, items) => replace(source, type, items),
  };
}

export function itemSourceRows({ db }: StoreContext): SourceRows {
  const selectSources = db.prepare<[], { source: string }>("SELECT DISTINCT source FROM items");
  const removeSource = db.prepare("DELETE FROM items WHERE source = ?");
  return {
    sources: () => selectSources.all().map((row) => row.source),
    remove: (source) => void removeSource.run(source),
  };
}

function fromRow(row: ItemRow): HubItem {
  return {
    source: row.source,
    type: row.type,
    id: row.id,
    title: row.title,
    status: row.status,
    attention: row.attention === 1,
    updatedAt: row.updated_at,
    data: JSON.parse(row.data) as unknown,
  };
}
