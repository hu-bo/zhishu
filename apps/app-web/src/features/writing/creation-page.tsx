import { useMemo, useRef, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getDocument, getDocumentContent } from '@/api/generated/documents';
import { listKnowledgeWorkspaces } from '@/api/generated/knowledge';
import { errorMessage } from '@/api/api-error';
import { hasUnconfirmedChanges } from '@/api/transport';
import { DocumentCollaborationEditor } from '@/features/document/document-collaboration-editor';
import { WritingChat } from './writing-chat';
import { WritingDraft } from './writing-draft';
import { QaChat } from '../qa/qa-chat';
import { internalTransport } from '@/components/chat/conversation-transport';
import { createWritingFromQaMessage } from '@/api/generated/qa';

/**
 * Creation workbench: writing (bound to a document or free drafts) and knowledge QA share
 * one page but keep independent sessions, contexts and drafts. The QA panel's
 * “write from these sources” creates a NEW purpose=writing session after server-side
 * re-validation; nothing is copied client-side.
 */
export function CreationPage({
  sourceWorkspaceId,
  contextDocumentId,
  targetDocumentId,
}: {
  sourceWorkspaceId?: string;
  contextDocumentId?: string;
  targetDocumentId?: string;
}) {
  const navigate = useNavigate();
  const search = useSearch({ from: '/_app/ai' });
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'writing' | 'qa'>(search.conversationId ? 'writing' : 'writing');
  const [draftText, setDraftText] = useState<string | null>(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const selectionRef = useRef<string[]>([]);

  const target = targetDocumentId ?? null;
  const document = useQuery({
    queryKey: ['document', target],
    queryFn: () => getDocument(target!),
    enabled: !!target,
  });
  const content = useQuery({
    queryKey: ['document-content', target, document.data?.generationId],
    queryFn: () => getDocumentContent(target!),
    enabled: !!target,
  });

  const editorContext = useMemo(
    () => () =>
      target
        ? {
            documentId: target,
            selectionBlockIds: selectionRef.current,
            hasUnconfirmedChanges: () => hasUnconfirmedChanges(),
          }
        : null,
    [target],
  );

  async function handoff(input: { conversationId: string; messageId: string }) {
    setHandoffError(null);
    try {
      const created = await createWritingFromQaMessage(input.conversationId, input.messageId, {
        instruction: '基于这些资料继续写作；先给出结构建议，再按我的要求成文。',
        ...(target ? { targetDocumentId: target } : {}),
        creationKey: crypto.randomUUID(),
      });
      await queryClient.invalidateQueries({ queryKey: ['writing-chat'] });
      setTab('writing');
      await navigate({
        to: '/ai',
        search: {
          ...search,
          conversationId: created.conversationId,
          targetDocumentId: created.replayed
            ? search.targetDocumentId
            : (target ?? search.targetDocumentId),
        },
      });
    } catch (error) {
      setHandoffError(errorMessage(error));
    }
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_400px]">
      <section className="flex min-h-0 flex-col border-r border-neutral-200 dark:border-neutral-800">
        {target && document.data && content.data ? (
          <DocumentCollaborationEditor
            document={document.data}
            viewMode="edit"
            versionsOpen={false}
            onVersionsOpenChange={() => undefined}
            onSelectionBlocksChange={(ids) => {
              selectionRef.current = ids;
            }}
          />
        ) : draftText ? (
          <WritingDraft
            draft={{ id: 'free', text: draftText }}
            canCreate
            resolveWorkspace={async () => {
              const spaces = await listKnowledgeWorkspaces();
              const personal = spaces.find((space) => space.kind === 'personal') ?? spaces[0];
              if (!personal) throw new Error('没有可用的个人空间');
              return personal.id;
            }}
            onBusyChange={() => undefined}
            onClose={() => setDraftText(null)}
            onCreated={(id) => {
              setDraftText(null);
              void navigate({ to: '/documents/$documentId', params: { documentId: id } });
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-10 text-center text-sm text-neutral-500">
            <div>
              <p className="text-base font-medium">独立创作</p>
              <p className="mt-2">未绑定目标文档。写作结果先作为草稿呈现，满意后可“保存为文档”。</p>
              {tab === 'writing' ? (
                <button
                  className="mt-4 rounded border px-3 py-1.5 text-sm"
                  onClick={() => setTab('qa')}
                >
                  切换到问答
                </button>
              ) : null}
            </div>
          </div>
        )}
      </section>
      <aside className="flex min-h-0 flex-col">
        <div
          role="tablist"
          className="flex border-b border-neutral-200 p-2 dark:border-neutral-800"
        >
          {(['writing', 'qa'] as const).map((value) => (
            <button
              key={value}
              role="tab"
              aria-selected={tab === value}
              className={`flex-1 rounded px-3 py-1.5 text-sm ${tab === value ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900' : ''}`}
              onClick={() => setTab(value)}
            >
              {value === 'writing' ? '写作' : '问答'}
            </button>
          ))}
        </div>
        {handoffError ? <p className="px-3 py-2 text-xs text-red-600">{handoffError}</p> : null}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === 'writing' ? (
            <WritingChat
              key={`${identity()}:${target ?? 'free'}:${search.conversationId ?? ''}`}
              scopeKey={[
                sourceWorkspaceId ?? '',
                contextDocumentId ?? '',
                search.conversationId ?? '',
              ]}
              targetDocumentId={target}
              getEditorContext={editorContext}
              onDraft={setDraftText}
              initialConversationId={search.conversationId}
              onTargetChange={(next) =>
                void navigate({
                  to: '/ai',
                  search: { ...search, targetDocumentId: next ?? undefined },
                })
              }
            />
          ) : contextDocumentId ? (
            <QaChat
              transport={internalTransport('qa')}
              key={`qa-doc:${contextDocumentId}`}
              scopeKey={[contextDocumentId]}
              initialScope={{ kind: 'documents', documentIds: [contextDocumentId] }}
              canHandoff
              onHandoff={(input) =>
                void handoff({ conversationId: input.conversationId, messageId: input.messageId })
              }
              documentLabel={{
                documentId: contextDocumentId,
                title: document.data?.title ?? '当前文档',
              }}
            />
          ) : (
            <QaChat
              transport={internalTransport('qa')}
              key={`qa-global:${sourceWorkspaceId ?? ''}`}
              scopeKey={['global']}
              canHandoff
              onHandoff={(input) =>
                void handoff({ conversationId: input.conversationId, messageId: input.messageId })
              }
            />
          )}
        </div>
      </aside>
    </div>
  );
}

function identity(): string {
  return 'session';
}
