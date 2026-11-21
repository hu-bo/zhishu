import { useEffect, useState } from 'react';
import type { ProposalApplicationState, WritingProposalPayload } from '@zhishu/ai-contracts';
import { ActionCard, type CardTone } from '@zhishu/chat-ui';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/cn';
import { Check, ChevronLeft, ChevronRight, PenLine, X } from 'lucide-react';
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

type Decision = 'accepted' | 'rejected';

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

const OPEN_STATES: readonly ProposalApplicationState[] = [
  'pending',
  'partial',
  'conflict',
  'unknown',
];

/**
 * Final proposal review with per-block accept/reject decisions. Accept submits the accepted
 * block set through the existing review API (partial application is a server outcome);
 * adoption writes through the durable structural channel and only the server receipt shows 已应用.
 */
export function ProposalReview({
  transport,
  conversationId,
  artifactId,
  reviewRevision,
  applicationState = 'pending',
  onResolved,
}: {
  transport: ConversationTransport;
  conversationId: string;
  artifactId: string;
  reviewRevision: number;
  applicationState?: ProposalApplicationState;
  onResolved: () => void;
}) {
  const [payload, setPayload] = useState<WritingProposalPayload | null>(null);
  // Decisions start undecided: accepting is always an explicit user act.
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [current, setCurrent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProposalApplicationState | null>(null);

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
  const state = result ?? applicationState;
  const view = STATE_VIEW[state];
  const open = OPEN_STATES.includes(state);
  const accepted = changes.filter((change) => decisions[change.blockId] === 'accepted');
  const rejected = changes.filter((change) => decisions[change.blockId] === 'rejected');
  const undecided = changes.length - accepted.length - rejected.length;
  if (changes.length === 0)
    return (
      <ActionCard
        label="提案审阅"
        tone={view.tone}
        icon={<PenLine className="size-4" />}
        title="修改提案"
        subtitle={payload.summary}
        badge={{ text: view.badge }}
      />
    );
  const focused = changes[Math.min(current, changes.length - 1)];

  function toggle(blockId: string, decision: Decision) {
    setDecisions((currentMap) => {
      const next = { ...currentMap };
      if (next[blockId] === decision) delete next[blockId];
      else next[blockId] = decision;
      return next;
    });
  }

  function decideAll(decision: Decision) {
    setDecisions(Object.fromEntries(changes.map((change) => [change.blockId, decision])));
  }

  async function act(action: 'accept' | 'reject', blockIds?: string[]) {
    setBusy(true);
    setError(null);
    try {
      const { reviewAiProposal } = await import('../../api/generated/ai');
      const outcome = await reviewAiProposal(artifactId, {
        decisionId: crypto.randomUUID(),
        revision: reviewRevision,
        action,
        ...(blockIds?.length ? { blockIds } : {}),
      });
      setResult(outcome.applicationState);
      onResolved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const banner = () => {
    if (state === 'conflict')
      return (
        <p className="proposal-banner danger" role="alert">
          文档已更新导致条件冲突，请基于最新正文重新生成提案；旧提案不会被改写应用。
        </p>
      );
    if (state === 'unknown')
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
    if (state === 'partial')
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
      badge={{ text: view.badge, spinner: busy }}
      footnote={
        payload.citations.length
          ? `本提案包含 ${payload.citations.length} 条资料引用，采纳时将写入对应句段链接与文末参考资料。`
          : undefined
      }
      footer={
        open ? (
          <>
            <span className="proposal-counts">
              已接受 {accepted.length} · 已拒绝 {rejected.length} · 未决定 {undecided}
            </span>
            <span className="ms-auto flex gap-2">
              <Button
                variant="ghost"
                size="xs"
                className={CARD_BUTTON_CLASS}
                disabled={busy}
                onPress={() => decideAll('accepted')}
              >
                全部接受
              </Button>
              <Button
                variant="ghost"
                size="xs"
                className={cn(CARD_BUTTON_CLASS, 'text-danger')}
                disabled={busy}
                onPress={() => void act('reject')}
              >
                全部拒绝
              </Button>
              <Button
                variant="default"
                size="xs"
                className={CARD_BUTTON_CLASS}
                disabled={busy || accepted.length === 0}
                title={accepted.length === 0 ? '先接受至少一处变更' : undefined}
                onPress={() =>
                  void act(
                    'accept',
                    accepted.map((change) => change.blockId),
                  )
                }
              >
                应用提案（{accepted.length}）
              </Button>
            </span>
          </>
        ) : undefined
      }
    >
      <div
        tabIndex={0}
        className="proposal-review outline-none"
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') setCurrent((index) => (index + 1) % changes.length);
          if (event.key === 'ArrowLeft')
            setCurrent((index) => (index - 1 + changes.length) % changes.length);
        }}
      >
        {banner()}
        {error && (
          <p className="proposal-banner danger" role="alert">
            {error}
          </p>
        )}
        {open && (
          <div className="proposal-nav">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="上一处变更"
              onPress={() => setCurrent((index) => (index - 1 + changes.length) % changes.length)}
            >
              <ChevronLeft className="size-3.5" />
            </Button>
            <span className="proposal-counter">
              {Math.min(current + 1, changes.length)} / {changes.length}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="下一处变更"
              onPress={() => setCurrent((index) => (index + 1) % changes.length)}
            >
              <ChevronRight className="size-3.5" />
            </Button>
            <span className="ms-auto flex gap-2">
              <Button
                variant="ghost"
                size="xs"
                className={CARD_BUTTON_CLASS}
                disabled={busy}
                onPress={() => toggle(focused.blockId, 'accepted')}
              >
                <Check className="size-3.5" /> 接受本条
              </Button>
              <Button
                variant="ghost"
                size="xs"
                className={cn(CARD_BUTTON_CLASS, 'text-danger')}
                disabled={busy}
                onPress={() => toggle(focused.blockId, 'rejected')}
              >
                <X className="size-3.5" /> 拒绝本条
              </Button>
            </span>
          </div>
        )}
        <div className="proposal-focus">
          <div className="proposal-focus__head">
            <span className={`proposal-kind proposal-kind--${focused.kind}`}>
              {KIND_LABEL[focused.kind]}
            </span>
            <strong>{focused.title}</strong>
          </div>
          {focused.text ? <p className="proposal-focus__text">{focused.text}</p> : null}
        </div>
        <ul className="proposal-rows">
          {changes.map((change, index) => {
            const decision = decisions[change.blockId];
            return (
              <li
                key={change.blockId}
                className={cn('proposal-row', index === current && 'current')}
                data-decision={decision ?? 'undecided'}
                onClick={() => setCurrent(index)}
              >
                <span className={`proposal-kind proposal-kind--${change.kind}`}>
                  {KIND_LABEL[change.kind]}
                </span>
                <span className="proposal-row__name">{change.title}</span>
                {open && (
                  <>
                    <button
                      type="button"
                      className="proposal-row__acc"
                      aria-label={`接受${change.title}`}
                      aria-pressed={decision === 'accepted'}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggle(change.blockId, 'accepted');
                      }}
                    >
                      <Check className="size-3" />
                    </button>
                    <button
                      type="button"
                      className="proposal-row__rej"
                      aria-label={`拒绝${change.title}`}
                      aria-pressed={decision === 'rejected'}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggle(change.blockId, 'rejected');
                      }}
                    >
                      <X className="size-3" />
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </ActionCard>
  );
}
