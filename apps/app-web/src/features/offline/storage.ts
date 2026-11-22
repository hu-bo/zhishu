import type { DocumentContent, ExtensionRequirement } from '@zhishu/document-contracts';
import {
  CURRENT_DOCUMENT_SCHEMA_VERSION,
  validateDocumentContent,
} from '@zhishu/document-contracts';
import { openDB, unwrap } from 'idb';
import type { DBSchema, IDBPDatabase, IDBPObjectStore } from 'idb';

type Entry = {
  key: string;
  identity: string;
  kind: string;
  id: string;
  value: unknown;
  updatedAt: number;
};
export type CollaborationCheckpoint = {
  documentId: string;
  workspaceId: string;
  generationId: string;
  schemaVersion: number;
  extensions: ExtensionRequirement[];
  structureRevision: number;
  title: string;
  content: DocumentContent | null;
  pendingUpdates: Uint8Array[];
  updatedAt: number;
  tabId: string;
};
interface OfflineSchema extends DBSchema {
  entries: {
    key: string;
    value: Entry;
    indexes: { identity: string };
  };
}
let database: Promise<IDBPDatabase<OfflineSchema>> | undefined;
let openConnection: IDBDatabase | undefined;
const errorListeners = new Set<() => void>();
export function subscribeStorageError(listener: () => void) {
  errorListeners.add(listener);
  return () => {
    errorListeners.delete(listener);
  };
}
function storageFailure() {
  for (const listener of errorListeners) listener();
}
/** Keeps the old semantics: a blocked upgrade rejects right away, and a late connection is closed instead of leaking. */
function openDatabase(): Promise<IDBPDatabase<OfflineSchema>> {
  if (!database) {
    database = new Promise<IDBPDatabase<OfflineSchema>>((resolve, reject) => {
      let settled = false;
      openDB<OfflineSchema>('zhishu-offline', 1, {
        upgrade: (db) => {
          const store = db.createObjectStore('entries', { keyPath: 'key' });
          store.createIndex('identity', 'identity');
        },
        blocked: () => {
          if (settled) return;
          settled = true;
          database = undefined;
          reject(new Error('Offline storage upgrade blocked'));
        },
      })
        .then((db) => {
          if (settled) {
            db.close();
            return;
          }
          settled = true;
          db.onversionchange = () => {
            db.close();
            database = undefined;
            openConnection = undefined;
          };
          openConnection = unwrap(db);
          resolve(db);
        })
        .catch((error: unknown) => {
          if (settled) return;
          settled = true;
          database = undefined;
          reject(error);
        });
    });
  }
  return database;
}
const entryKey = (identity: string, kind: string, id: string) =>
  JSON.stringify([identity, kind, id]);
async function transact<Mode extends IDBTransactionMode, T>(
  mode: Mode,
  run: (store: IDBPObjectStore<OfflineSchema, ['entries'], 'entries', Mode>) => Promise<T>,
): Promise<T> {
  try {
    const db = await openDatabase();
    const tx = db.transaction('entries', mode);
    try {
      const result = await run(tx.objectStore('entries'));
      await tx.done;
      return result;
    } catch (error) {
      // The wrapper aborts the transaction when run throws; consume tx.done so the
      // original request error surfaces instead of an unhandled rejection.
      await tx.done.catch(() => undefined);
      throw error;
    }
  } catch (error) {
    storageFailure();
    throw error;
  }
}
export function readRecord(identity: string, kind: string, id: string): Promise<unknown> {
  return transact('readonly', async (store) => {
    const entry = await store.get(entryKey(identity, kind, id));
    return entry?.value;
  });
}
export function writeRecord(
  identity: string,
  kind: string,
  id: string,
  value: unknown,
): Promise<void> {
  return transact('readwrite', async (store) => {
    await store.put({
      key: entryKey(identity, kind, id),
      identity,
      kind,
      id,
      value,
      updatedAt: Date.now(),
    } satisfies Entry);
  });
}
/** Start the transaction before pagehide returns; awaiting database opening can lose the final edit. */
export function writeRecordOnPageExit(
  identity: string,
  kind: string,
  id: string,
  value: unknown,
): void {
  if (!openConnection) return;
  try {
    const tx = openConnection.transaction('entries', 'readwrite');
    tx.onerror = storageFailure;
    tx.onabort = storageFailure;
    tx.objectStore('entries').put({
      key: entryKey(identity, kind, id),
      identity,
      kind,
      id,
      value,
      updatedAt: Date.now(),
    } satisfies Entry);
  } catch {
    storageFailure();
  }
}
export function deleteRecord(identity: string, kind: string, id: string): Promise<void> {
  return transact('readwrite', async (store) => {
    await store.delete(entryKey(identity, kind, id));
  });
}
export function deleteRecordIf(
  identity: string,
  kind: string,
  id: string,
  predicate: (value: unknown) => boolean,
): Promise<void> {
  return transact('readwrite', async (store) => {
    const key = entryKey(identity, kind, id);
    const entry = await store.get(key);
    if (entry && predicate(entry.value)) await store.delete(key);
  });
}
export function recordsForIdentity(identity: string): Promise<Entry[]> {
  return transact('readonly', async (store) => store.index('identity').getAll(identity));
}
export function deleteRecords(
  identity: string,
  predicate: (entry: Entry) => boolean = () => true,
): Promise<void> {
  return transact('readwrite', async (store) => {
    for await (const cursor of store.index('identity').iterate(identity)) {
      if (predicate(cursor.value)) await cursor.delete();
    }
  });
}
export function isCollaborationCheckpoint(value: unknown): value is CollaborationCheckpoint {
  if (!value || typeof value !== 'object') return false;
  const checkpoint = value as Partial<CollaborationCheckpoint>;
  return (
    typeof checkpoint.documentId === 'string' &&
    typeof checkpoint.workspaceId === 'string' &&
    typeof checkpoint.generationId === 'string' &&
    typeof checkpoint.title === 'string' &&
    typeof checkpoint.tabId === 'string' &&
    checkpoint.schemaVersion === CURRENT_DOCUMENT_SCHEMA_VERSION &&
    Array.isArray(checkpoint.extensions) &&
    Number.isSafeInteger(checkpoint.structureRevision) &&
    Number(checkpoint.structureRevision) >= 0 &&
    Array.isArray(checkpoint.pendingUpdates) &&
    checkpoint.pendingUpdates.length <= 1000 &&
    checkpoint.pendingUpdates.every(
      (update) => update instanceof Uint8Array && update.byteLength <= 2 * 1024 * 1024,
    ) &&
    (checkpoint.content === null || validateDocumentContent(checkpoint.content).success)
  );
}
export async function readCollaborationCheckpoint(
  identity: string,
  documentId: string,
): Promise<{ key: string; value: CollaborationCheckpoint } | null> {
  const entries = (await recordsForIdentity(identity)).filter(
    (entry) => entry.kind === 'collaboration' && isCollaborationCheckpoint(entry.value),
  );
  const records = entries
    .map((entry) => ({ key: entry.id, value: entry.value as CollaborationCheckpoint }))
    .filter((entry) => entry.value.documentId === documentId);
  const own = records.filter((entry) => entry.value.tabId === currentTabId());
  return (
    (own.length ? own : records).sort(
      (a, b) =>
        Number(b.value.pendingUpdates.length > 0) - Number(a.value.pendingUpdates.length > 0) ||
        b.value.updatedAt - a.value.updatedAt,
    )[0] ?? null
  );
}
let tabId: string | undefined;
export function currentTabId(): string {
  if (!tabId) {
    try {
      tabId = sessionStorage.getItem('zhishu.draft-tab') || crypto.randomUUID();
      sessionStorage.setItem('zhishu.draft-tab', tabId);
    } catch {
      tabId = crypto.randomUUID();
    }
  }
  return tabId;
}
