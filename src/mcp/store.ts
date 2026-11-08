import { existsSync } from "node:fs";
import { openStore, type Store } from "../store/store.js";

/** The hub's store, opened read-only on first use and retried on every use until it opens. */
export interface LazyStore {
  /** The open store, or throws an Error whose message names the path and why it cannot be read. */
  get(): Store;
  close(): void;
}

export function lazyStore(dbPath: string, now: () => Date): LazyStore {
  let store: Store | undefined;
  return {
    get: () => {
      store ??= open(dbPath, now);
      return store;
    },
    close: () => {
      store?.close();
      store = undefined;
    },
  };
}

function open(dbPath: string, now: () => Date): Store {
  try {
    return openStore(dbPath, { readOnly: true, now });
  } catch (err) {
    if (!existsSync(dbPath)) throw new Error(`no store at ${dbPath}; has \`manao run\` ever run?`, { cause: err });
    throw new Error(`cannot read the store at ${dbPath}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}
