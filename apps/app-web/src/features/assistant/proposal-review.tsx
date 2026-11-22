import { useEffect, useState } from 'react';
import type { ProposalApplicationState, WritingProposalPayload } from '@zhishu/ai-contracts';
import { ActionCard, type CardTone } from '@zhishu/chat-ui';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/cn';
import { PenLine } from 'lucide-react';
import {
  readArtifact,
  type ConversationTransport,
} from '../../components/chat/conversation-transport';
import { errorMessage } from '../../api/api-error';
import { CARD_BUTTON_CLASS } from './picker-shared';

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

/** applicationState → card presentation; every tone/text is a server fact, never local hope. */
const STATE_VIEW = {
  pending: { tone: 'info', badge: '提案待确认' },
  partial: { tone: 'warning', badge: '部分应用' },
  applied: { tone: 'success', badge: '已应用 · 持久化确认' },
  rejected: { tone: 'neutral', badge: '已拒绝' },
  conflict: { tone: 'danger', badge: '冲突' },
  unknown: { tone: 'warning', badge: '结果未知' },
} as const satisfies Record<ProposalApplicationState, { tone: CardTone; badge: string }>;

const KIND_LABEL = { insert: '新增', replace: '替换', delete: '删除' } as const;

const DECISION_LABEL = { accepted: '已接受', rejected: '已拒绝' } as const;

/**
 * Proposal summary inside the chat stream. Per-block accept/reject happens in the document
 * body (EditorReplacementReview decorations); this card reports server facts — state,
 * banners and the decided marks — and points to the in-body review.
 */
export function ProposalReview({
  transport,
  conversationId,
  artifactId,
  applicationState = 'pending',
  decisions,
  onResolved,
  onReviewInDocument,
}: {
  transport: ConversationTransport;
  conversationId: string;
  artifactId: string;
  applicationState?: ProposalApplicationState;
  /** Server-recorded per-block decisions from the snapshot artifact. */
  decisions?: { blockId: string; action: 'accept' | 'reject' }[];
  onResolved: () => void;
  onReviewInDocument?: () => void;
}) {
  const [payload, setPayload] = useState<WritingProposalPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void readArtifact<WritingProposalPayload>(transport, conversationId, artifactId)
      .then(setPayload)
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [transport, conversationId, artifactId]);

  if (!payload) {
    return (
      <ActionCard
        label="提案审阅"
        tone="info"
        icon={<PenLine className="size-4" />}
        title="提案审阅"
        badge={{ text: error ? '读取失败' : '读取中', spinner: !error }}
      >
        {error ? <p role="alert">{error}</p> : <p>正在读取提案…</p>}
      </ActionCard>
    );
  }

  const changes = describe(payload);
  const view = STATE_VIEW[applicationState];
  const open = ['pending', 'conflict', 'unknown'].includes(applicationState);
  const decided = new Map<string, 'accepted' | 'rejected'>(
    (decisions ?? []).map((decision) => [
      decision.blockId,
      decision.action === 'accept' ? ('accepted' as const) : ('rejected' as const),
    ]),
  );
  const decidedCount = changes.filter((change) => decided.has(change.blockId)).length;

  const banner = () => {
    if (applicationState === 'conflict')
      return (
        <p className="proposal-banner danger" role="alert">
          文档已更新导致条件冲突，请基于最新正文重新生成提案；旧提案不会被改写应用。
        </p>
      );
    if (applicationState === 'unknown')
      return (
        <p className="proposal-banner warning">
          应用结果未知；系统正按操作标识核对回执，不会重复写入。
          <Button
            variant="ghost"
            size="xs"
            className={cn(CARD_BUTTON_CLASS, 'ms-2')}
            onPress={onResolved}
          >
            刷新状态
          </Button>
        </p>
      );
    if (applicationState === 'partial')
      return (
        <p className="proposal-banner warning">
          部分变更已应用并通过持久化确认；未应用项不会被静默丢弃，可基于最新正文重新发起。
        </p>
      );
    return null;
  };

  return (
    <ActionCard
      label="提案审阅"
      tone={view.tone}
      icon={<PenLine className="size-4" />}
      title="修改提案"
      subtitle={payload.summary}
      badge={{ text: view.badge }}
      footnote={
        payload.citations.length
          ? `本提案包含 ${payload.citations.length} 条资料引用，采纳时将写入对应句段链接与文末参考资料。`
          : undefined
      }
      footer={
        open && onReviewInDocument ? (
          <>
            <span className="proposal-counts">
              已决定 {decidedCount} / {changes.length} · 在正文中逐段确认
            </span>
            <Button
              variant="default"
              size="xs"
              className={cn(CARD_BUTTON_CLASS, 'ms-auto')}
              onPress={onReviewInDocument}
            >
              在正文中审阅
            </Button>
          </>
        ) : undefined
      }
    >
      {banner()}
      {error && (
        <p className="proposal-banner danger" role="alert">
          {error}
        </p>
      )}
      <ul className="proposal-rows">
        {changes.map((change) => {
          const decision = decided.get(change.blockId);
          return (
            <li
              key={change.blockId}
              className="proposal-row"
              data-decision={decision ?? 'undecided'}
            >
              <span className={`proposal-kind proposal-kind--${change.kind}`}>
                {KIND_LABEL[change.kind]}
              </span>
              <span className="proposal-row__name">{change.title}</span>
              {decision && (
                <span className="proposal-row__decision">{DECISION_LABEL[decision]}</span>
              )}
            </li>
          );
        })}
      </ul>
      {changes.some((change) => change.text) && (
        <p className="proposal-focus__hint">替换对照、接受与拒绝均在正文中就地完成。</p>
      )}
    </ActionCard>
  );
}
