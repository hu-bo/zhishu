import type { Artifact } from '@zhishu/chat-contracts';
import { ActionCard } from '@zhishu/chat-ui';
import { FileText, PenLine } from 'lucide-react';
import { Button } from '../../components/ui/button';
import type { ConversationTransport } from '../../components/chat/conversation-transport';
import { ProposalReview } from './proposal-review';
import { CARD_BUTTON_CLASS } from './picker-shared';

export interface ArtifactCardContext {
  transport: ConversationTransport;
  conversationId: string;
  /** Server-bound target fact; the created receipt depends on it, never on local state. */
  targetDocumentId: string | null;
  documentTitle?: string;
  onOpenTarget?: () => void;
  onResolved: () => void | Promise<unknown>;
}

const PROPOSAL_RESOLVED = {
  applied: { tone: 'success', badge: '已应用 · 持久化确认' },
  rejected: { tone: 'neutral', badge: '已拒绝' },
} as const;

/**
 * Action cards embedded in the message stream for draft/proposal artifacts.
 * Open proposals render the interactive review card; resolved states render receipts
 * derived purely from the snapshot (applicationState / targetDocumentId facts).
 */
export function ArtifactMessage({
  artifact,
  context,
}: {
  artifact: Artifact;
  context: ArtifactCardContext;
}) {
  if (artifact.kind === 'proposal') {
    const state = artifact.applicationState ?? 'pending';
    if (state === 'pending' || state === 'partial' || state === 'conflict' || state === 'unknown')
      return (
        <ProposalReview
          transport={context.transport}
          conversationId={context.conversationId}
          artifactId={artifact.id}
          reviewRevision={artifact.reviewRevision ?? 0}
          applicationState={state}
          onResolved={() => void context.onResolved()}
        />
      );
    const view = PROPOSAL_RESOLVED[state as keyof typeof PROPOSAL_RESOLVED];
    return (
      <ActionCard
        label="修改提案"
        tone={view.tone}
        icon={<PenLine className="size-4" />}
        title="修改提案"
        subtitle={artifact.summary}
        badge={{ text: view.badge }}
      />
    );
  }
  if (artifact.kind === 'draft') {
    if (context.targetDocumentId)
      return (
        <ActionCard
          label="草稿已创建"
          tone="success"
          icon={<FileText className="size-4" />}
          title={context.documentTitle ?? '草稿文档'}
          subtitle="个人/团队空间中的真实文档，已绑定到本会话"
          badge={{ text: '已创建' }}
          footer={
            context.onOpenTarget ? (
              <Button
                variant="default"
                size="xs"
                className={`${CARD_BUTTON_CLASS} ms-auto`}
                onPress={context.onOpenTarget}
              >
                打开文档
              </Button>
            ) : undefined
          }
          footnote="文档创建与会话绑定已由服务端事务确认；正文保存状态以编辑器回执为准，检索索引完成前该文档暂不参与资料检索。"
        />
      );
    return (
      <ActionCard
        label="创建草稿"
        tone="info"
        icon={<FileText className="size-4" />}
        title="草稿内容已生成"
        subtitle={artifact.summary}
        badge={{ text: '正在初始化文档并绑定会话', spinner: true }}
        footnote="模型输出完成不等于文档已创建；仅当服务端完成文档初始化与会话绑定后才显示「已创建」。"
      />
    );
  }
  return null;
}
