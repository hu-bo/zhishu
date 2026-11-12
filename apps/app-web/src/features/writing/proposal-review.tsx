import { useEffect, useState } from 'react';
import type { WritingProposalPayload } from '@zhishu/ai-contracts';
import { ArtifactCard } from '@zhishu/chat-ui';
import {
  readArtifact,
  type ConversationTransport,
} from '../../components/chat/conversation-transport';
import { errorMessage } from '../../api/api-error';

interface ChangeItem {
  blockId: string;
  kind: 'replace' | 'insert' | 'delete';
  title: string;
  text: string;
}

function describe(payload: WritingProposalPayload): ChangeItem[] {
  return payload.operationBatch.operations.map((operation) => {
    if (operation.type === 'insert-block')
      return {
        blockId: operation.block.attrs.blockId,
        kind: 'insert' as const,
        title: blockLabel(operation.block),
        text: blockText(operation.block),
      };
    if (operation.type === 'replace-block')
      return {
        blockId: operation.targetBlockId,
        kind: 'replace' as const,
        title: blockLabel(operation.block),
        text: blockText(operation.block),
      };
    return {
      blockId: operation.targetBlockId,
      kind: 'delete' as const,
      title: '删除段落',
      text: '',
    };
  });
}

function blockLabel(block: { type: string; attrs: Record<string, unknown> }): string {
  if (block.type === 'heading') return `标题 L${String(block.attrs.level ?? 1)}`;
  if (block.type === 'codeBlock') return `代码块 ${String(block.attrs.language ?? '')}`;
  return '段落';
}
function blockText(block: {
  content?: Array<Record<string, unknown>>;
  attrs?: Record<string, unknown>;
}): string {
  const text = (block.content ?? [])
    .map((node) => (typeof node.text === 'string' ? node.text : ''))
    .join('')
    .trim();
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

/** Final proposal review with per-block decisions; adoption writes through the durable channel. */
export function ProposalReview({
  transport,
  conversationId,
  artifactId,
  reviewRevision,
  onResolved,
}: {
  transport: ConversationTransport;
  conversationId: string;
  artifactId: string;
  reviewRevision: number;
  onResolved: () => void;
}) {
  const [payload, setPayload] = useState<WritingProposalPayload | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [applicationState, setApplicationState] = useState<string>('pending');

  useEffect(() => {
    void readArtifact<WritingProposalPayload>(transport, conversationId, artifactId)
      .then((value) => {
        setPayload(value);
        setSelected(new Set(describe(value).map((change) => change.blockId)));
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [transport, conversationId, artifactId]);

  if (!payload)
    return (
      <ArtifactCard title="提案审阅">
        {error ? <p className="proposal-error">{error}</p> : <p>正在读取提案…</p>}
      </ArtifactCard>
    );
  const changes = describe(payload);

  async function act(action: 'accept' | 'reject', blockIds?: string[]) {
    setBusy(true);
    setError(null);
    try {
      const { reviewWritingProposal } = await import('../../api/generated/writing');
      const result = await reviewWritingProposal(artifactId, {
        decisionId: crypto.randomUUID(),
        revision: reviewRevision,
        action,
        ...(blockIds?.length ? { blockIds } : {}),
      });
      setApplicationState(result.applicationState);
      onResolved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ArtifactCard
      title="提案审阅"
      actions={
        <>
          <button
            type="button"
            disabled={busy || !selected.size}
            onClick={() => void act('accept', [...selected])}
          >
            应用选中（{selected.size}/{changes.length}）
          </button>
          <button type="button" disabled={busy} onClick={() => void act('reject')}>
            拒绝提案
          </button>
        </>
      }
    >
      <p>{payload.summary}</p>
      {payload.citations.length ? (
        <p className="proposal-note">
          本提案包含 {payload.citations.length} 条资料引用，采纳时将写入对应句段链接与文末参考资料。
        </p>
      ) : null}
      <ul className="proposal-changes">
        {changes.map((change) => (
          <li key={change.blockId}>
            <label>
              <input
                type="checkbox"
                checked={selected.has(change.blockId)}
                onChange={(event) => {
                  const next = new Set(selected);
                  if (event.target.checked) next.add(change.blockId);
                  else next.delete(change.blockId);
                  setSelected(next);
                }}
              />
              <span className={`proposal-kind proposal-${change.kind}`}>
                {change.kind === 'insert' ? '新增' : change.kind === 'replace' ? '替换' : '删除'}
              </span>
              <span>{change.title}</span>
            </label>
            {change.text ? <p className="proposal-text">{change.text}</p> : null}
          </li>
        ))}
      </ul>
      {applicationState === 'applied' || applicationState === 'partial' ? (
        <p className="proposal-ok">
          {applicationState === 'applied' ? '提案已应用到正文。' : '所选段落已应用。'}
        </p>
      ) : applicationState === 'conflict' ? (
        <p className="proposal-error">文档已更新导致条件冲突，请基于最新正文重新生成提案。</p>
      ) : applicationState === 'unknown' ? (
        <p className="proposal-error">应用结果未知；系统将按操作标识核对回执，不会重复写入。</p>
      ) : null}
      {error ? <p className="proposal-error">{error}</p> : null}
    </ArtifactCard>
  );
}
