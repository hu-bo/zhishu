import type { DocumentContent, ExtensionRequirement } from '@zhishu/document-contracts';
import {
  CURRENT_DOCUMENT_SCHEMA_VERSION,
  validateDocumentContent,
} from '@zhishu/document-contracts';

type Entry = {
  key: string;
  identity: string;
  kind: string;
  id: string;
  value: unknown;
  updatedAt: number;
};
export type StandardDraft = {
  documentId: string;
  workspaceId: string;
  generationId: string | null;
  schemaVersion: number;
  extensions: ExtensionRequirement[];
  baseRevision: number;
  title: string;
  content: DocumentContent;
  tabId: string;
  updatedAt: number;
  draftVersion: string;
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
let database: Promise<IDBDatabase> | undefined;
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
function openDatabase(): Promise<IDBDatabase> {
  if (!database) {
    database = new Promise((resolve, reject) => {
      let blocked = false;
      const request = indexedDB.open('zhishu-offline', 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('entries', { keyPath: 'key' });
        store.createIndex('identity', 'identity');
      };
      request.onerror = () => {
        database = undefined;
        reject(request.error);
      };
      request.onblocked = () => {
        blocked = true;
        database = undefined;
        reject(new Error('Offline storage upgrade blocked'));
      };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) {
          db.close();
          return;
        }
        db.onversionchange = () => {
          db.close();
          database = undefined;
        };
        resolve(db);
      };
    });
  }
  return database;
}
const entryKey = (identity: string, kind: string, id: string) =>
  JSON.stringify([identity, kind, id]);
async function transact<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, complete: (value: T) => void) => void,
): Promise<T> {
  try {
    const db = await openDatabase();
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('entries', mode);
      let result: T;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      run(tx.objectStore('entries'), (value) => {
        result = value;
      });
    });
  } catch (error) {
    storageFailure();
    throw error;
  }
}
export function readRecord(identity: string, kind: string, id: string): Promise<unknown> {
  return transact('readonly', (store, complete) => {
    const request = store.get(entryKey(identity, kind, id));
    request.onsuccess = () => {
      const entry = request.result as Entry | undefined;
      complete(entry?.value);
    };
  });
}
export function writeRecord(
  identity: string,
  kind: string,
  id: string,
  value: unknown,
): Promise<void> {
  return transact('readwrite', (store, complete) => {
    store.put({
      key: entryKey(identity, kind, id),
      identity,
      kind,
      id,
      value,
      updatedAt: Date.now(),
    } satisfies Entry);
    complete(undefined);
  });
}
export function deleteRecord(identity: string, kind: string, id: string): Promise<void> {
  return transact('readwrite', (store, complete) => {
    store.delete(entryKey(identity, kind, id));
    complete(undefined);
  });
}
export function deleteRecordIf(
  identity: string,
  kind: string,
  id: string,
  predicate: (value: unknown) => boolean,
): Promise<void> {
  return transact('readwrite', (store, complete) => {
    const key = entryKey(identity, kind, id);
    const request = store.get(key);
    request.onsuccess = () => {
      const entry = request.result as Entry | undefined;
      if (entry && predicate(entry.value)) store.delete(key);
    };
    complete(undefined);
  });
}
export function recordsForIdentity(identity: string): Promise<Entry[]> {
  return transact('readonly', (store, complete) => {
    const request = store.index('identity').getAll(identity);
    request.onsuccess = () => complete(request.result as Entry[]);
  });
}
export function deleteRecords(
  identity: string,
  predicate: (entry: Entry) => boolean = () => true,
): Promise<void> {
  return transact('readwrite', (store, complete) => {
    const request = store.index('identity').openCursor(identity);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (predicate(cursor.value as Entry)) cursor.delete();
      cursor.continue();
    };
    complete(undefined);
  });
}
export function isStandardDraft(value: unknown): value is StandardDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<StandardDraft>;
  return (
    typeof draft.documentId === 'string' &&
    typeof draft.workspaceId === 'string' &&
    typeof draft.tabId === 'string' &&
    typeof draft.title === 'string' &&
    typeof draft.draftVersion === 'string' &&
    (draft.generationId === null || typeof draft.generationId === 'string') &&
    draft.schemaVersion === CURRENT_DOCUMENT_SCHEMA_VERSION &&
    Array.isArray(draft.extensions) &&
    Number.isSafeInteger(draft.baseRevision) &&
    Number(draft.baseRevision) > 0 &&
    typeof draft.updatedAt === 'number' &&
    validateDocumentContent(draft.content).success
  );
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
export async function readStandardDraft(
  identity: string,
  documentId: string,
): Promise<StandardDraft | null> {
  const entries = await recordsForIdentity(identity);
  const drafts = entries
    .filter((entry) => entry.kind === 'draft')
    .map((entry) => entry.value)
    .filter(isStandardDraft)
    .filter((draft) => draft.documentId === documentId);
  return (
    drafts.find((draft) => draft.tabId === currentTabId()) ??
    drafts.sort((a, b) => b.updatedAt - a.updatedAt)[0] ??
    null
  );
}
