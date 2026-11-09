import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { readRecord, writeRecord, writeRecordOnPageExit } from '@/features/offline/storage';

type ChatKind = 'writing' | 'rag' | 'proposal';

/** Page selection only; each business owns its conversation and draft separately. */
export function useChatContext(
  identity: string | null | undefined,
  scope: string,
  sourceDocumentId?: string,
  defaultChatKind?: ChatKind,
) {
  const [sourceIds, setSourceIds] = useState<string[]>(sourceDocumentId ? [sourceDocumentId] : []);
  const [chatKind, setChatKind] = useState<ChatKind>(defaultChatKind ?? 'writing');
  const contextKey = JSON.stringify([identity, scope]);
  const [hydratedKey, setHydratedKey] = useState<string | null>(null);
  const hydrated = hydratedKey === contextKey;
  const latest = useRef({ sourceIds, chatKind, hydrated });
  useLayoutEffect(() => {
    latest.current = { sourceIds, chatKind, hydrated };
  }, [sourceIds, chatKind, hydrated]);
  useEffect(() => {
    let active = true;
    if (!identity) return;
    void readRecord(identity, 'chat-context', scope)
      .then((value) => {
        if (!active) return;
        setSourceIds(sourceDocumentId ? [sourceDocumentId] : []);
        setChatKind(defaultChatKind ?? 'writing');
        if (!value || typeof value !== 'object') return;
        if (
          'sourceIds' in value &&
          Array.isArray(value.sourceIds) &&
          value.sourceIds.length <= 4 &&
          value.sourceIds.every(
            (id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 256,
          )
        )
          setSourceIds([...new Set(value.sourceIds as string[])]);
        if (
          !defaultChatKind &&
          'chatKind' in value &&
          ['writing', 'rag', 'proposal'].includes(String(value.chatKind))
        )
          setChatKind(value.chatKind as ChatKind);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setHydratedKey(contextKey);
      });
    return () => {
      active = false;
    };
  }, [identity, scope, contextKey, sourceDocumentId, defaultChatKind]);
  useEffect(() => {
    if (!identity || !hydrated) return;
    void writeRecord(identity, 'chat-context', scope, { sourceIds, chatKind }).catch(
      () => undefined,
    );
  }, [identity, scope, hydrated, sourceIds, chatKind]);
  useEffect(() => {
    const flush = () => {
      if (identity && latest.current.hydrated)
        writeRecordOnPageExit(identity, 'chat-context', scope, latest.current);
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [identity, scope]);
  return { sourceIds, setSourceIds, chatKind, setChatKind, contextHydrated: hydrated };
}
