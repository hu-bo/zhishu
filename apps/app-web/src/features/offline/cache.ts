import { useSyncExternalStore } from 'react';
import { z } from 'zod';
import type { MockLogin200User } from '@/api/generated/models';
import { CURRENT_DOCUMENT_SCHEMA_VERSION } from '@zhishu/document-contracts';
import {
  deleteRecord,
  deleteRecords,
  isCollaborationCheckpoint,
  readRecord,
  recordsForIdentity,
  subscribeStorageError,
  writeRecord,
} from './storage';

const accountSchema = z.object({
  identityId: z.string(),
  tenantId: z.string(),
  username: z.string(),
  displayName: z.string(),
  email: z.string(),
  globalRoles: z.array(z.string()),
  active: z.literal(true),
});
const accountNamespace = `account:${import.meta.env.VITE_API_BASE_URL ?? ''}`;
const accountMarker = `zhishu.offline-account:${import.meta.env.VITE_API_BASE_URL ?? ''}`;
export const cacheIdentity = (user: MockLogin200User) =>
  JSON.stringify([import.meta.env.VITE_API_BASE_URL ?? '', user.tenantId, user.identityId]);
let state = {
  identity: null as string | null,
  verified: false,
  online: navigator.onLine,
  cached: false,
  storageError: false,
  shellError: false,
};
const listeners = new Set<() => void>();
const notify = (patch: Partial<typeof state>) => {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
};
export function useOfflineState() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => state,
  );
}
export function currentCacheIdentity() {
  return state.identity;
}
export function hasVerifiedAccount() {
  return state.verified;
}
export function initializeOfflineState() {
  const online = () => notify({ online: true });
  const offline = () => notify({ online: false, cached: true });
  const shellError = () => notify({ shellError: true });
  window.addEventListener('online', online);
  window.addEventListener('offline', offline);
  window.addEventListener('zhishu-offline-worker-error', shellError);
  const unsubscribe = subscribeStorageError(() => notify({ storageError: true }));
  return () => {
    window.removeEventListener('online', online);
    window.removeEventListener('offline', offline);
    window.removeEventListener('zhishu-offline-worker-error', shellError);
    unsubscribe();
  };
}
export async function rememberAccount(user: MockLogin200User, verified: boolean) {
  notify({ identity: cacheIdentity(user), verified, cached: !verified, storageError: false });
  if (verified) {
    try {
      localStorage.setItem(accountMarker, 'disabled');
      await writeRecord(accountNamespace, 'account', 'active', user);
      if (state.identity === cacheIdentity(user) && state.verified)
        localStorage.setItem(accountMarker, cacheIdentity(user));
    } catch {
      notify({ storageError: true });
    }
  }
}
export async function readOfflineAccount(): Promise<MockLogin200User | null> {
  const result = accountSchema.safeParse(
    await readRecord(accountNamespace, 'account', 'active').catch(() => null),
  );
  if (!result.success) return null;
  try {
    return localStorage.getItem(accountMarker) === cacheIdentity(result.data) ? result.data : null;
  } catch {
    return null;
  }
}
export async function clearOfflineAccount(identityOverride?: string) {
  const identity = identityOverride ?? state.identity;
  notify({ identity: null, verified: false, cached: false });
  try {
    localStorage.setItem(accountMarker, 'disabled');
  } catch {
    notify({ storageError: true });
  }
  await Promise.all([
    deleteRecord(accountNamespace, 'account', 'active'),
    ...(identity ? [deleteRecords(identity)] : []),
  ]).catch(() => undefined);
}
export function revokeOfflineAccount() {
  notify({ verified: false, identity: null, cached: false });
  try {
    localStorage.setItem(accountMarker, 'disabled');
  } catch {
    notify({ storageError: true });
  }
}
const cacheable = (path: string) =>
  /^\/api\/knowledge\/workspaces(?:\?[^#]*)?$/.test(path) ||
  /^\/api\/knowledge\/workspaces\/[^/]+\/catalogs\/[^/]+\/children(?:\?[^#]*)?$/.test(path) ||
  /^\/api\/knowledge\/documents\/doc_[A-Za-z0-9_-]+\/locate(?:\?[^#]*)?$/.test(path) ||
  /^\/api\/documents(?:\?[^#]*)?$/.test(path) ||
  /^\/api\/documents\/doc_[A-Za-z0-9_-]+(?:\/(?:content|export))?(?:\?[^#]*)?$/.test(path);
export function responseCacheScope(path: string, options: RequestInit): string | null {
  return (!options.method || options.method.toUpperCase() === 'GET') && cacheable(path)
    ? state.identity
    : null;
}
export async function cachedResponse(
  identity: string,
  path: string,
): Promise<{ found: true; value: unknown } | { found: false }> {
  if (state.identity !== identity) return { found: false };
  const value = await readRecord(identity, 'response', path).catch(() => null);
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { schema?: unknown }).schema !== CURRENT_DOCUMENT_SCHEMA_VERSION
  )
    return { found: false };
  notify({ cached: true });
  return { found: true, value: (value as { data: unknown }).data };
}
export async function cacheResponse(identity: string, path: string, data: unknown) {
  if (state.identity !== identity || !state.verified) return;
  await writeRecord(identity, 'response', path, {
    schema: CURRENT_DOCUMENT_SCHEMA_VERSION,
    data,
  }).catch(() => undefined);
  const entries = await recordsForIdentity(identity).catch(() => []);
  const stale = entries
    .filter((entry) => entry.kind === 'response')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(200);
  if (stale.length)
    await deleteRecords(identity, (entry) => stale.some((item) => item.key === entry.key)).catch(
      () => undefined,
    );
}
export async function evictUnauthorizedResponses(identity: string, path: string, all: boolean) {
  const id = /^\/api\/documents\/(doc_[A-Za-z0-9_-]+)/.exec(path)?.[1];
  await deleteRecords(
    identity,
    (entry) =>
      (entry.kind === 'response' &&
        (all ||
          Boolean(
            id &&
            (entry.id.includes(id) ||
              (
                entry.value as { data?: { items?: { id: string }[] } } | undefined
              )?.data?.items?.some((item) => item.id === id)),
          ))) ||
      (entry.kind === 'collaboration' &&
        isCollaborationCheckpoint(entry.value) &&
        !entry.value.pendingUpdates.length &&
        (all || entry.value.documentId === id)),
  ).catch(() => undefined);
  if (all) await deleteRecord(accountNamespace, 'account', 'active').catch(() => undefined);
}
export async function writeScopedRecord(
  identity: string,
  kind: string,
  id: string,
  value: unknown,
) {
  if (state.identity !== identity) return;
  await writeRecord(identity, kind, id, value);
}
