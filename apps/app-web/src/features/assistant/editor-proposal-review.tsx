import { useEffect, useMemo, useState } from 'react';
import type { ProposalApplicationState, WritingProposalPayload } from '@zhishu/ai-contracts';
import type { DocumentContent } from '@zhishu/document-contracts';
import { applyOperationBatch } from '@zhishu/document-contracts';
import type { EditorReplacementPreviewData } from '@zhishu/editor-core';
import { EditorReplacementReview } from '@zhishu/editor-ui';
import { useEditorInstance } from '@zhishu/editor-react';
import {
  readArtifact,
  type ConversationTransport,
} from '../../components/chat/conversation-transport';
import { errorMessage } from '../../api/api-error';

/** Open proposal fact derived from the conversation snapshot, handed to the editor pane. */
export interface PendingProposal {
  conversationId: string;
  artifactId: string;
  reviewRevision: number;
  applicationState: ProposalApplicationState;
  decidedBlockIds: string[];
}

function operationBlockId(operation: {
  type: string;
  targetBlockId?: string;
  block?: { attrs?: Record<string, unknown> };
}): string {
  if (operation.type === 'insert-block') return String(operation.block?.attrs?.blockId ?? '');
  return String(operation.targetBlockId ?? '');
}

/**
 * In-body proposal review: decorations are derived from the live editor content and every
 * decision (single block or the rest) goes through the existing review API. Nothing here
 * writes the body directly — adoption lands only through the durable structural channel,
 * and the open state closes when the snapshot reports all changes decided.
 */
export function EditorProposalReview({
  transport,
  proposal,
}: {
  transport: ConversationTransport;
  proposal: PendingProposal;
}) {
  const { controller } = useEditorInstance();
  const [payload, setPayload] = useState<WritingProposalPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Any document change (remote adoption of our own decision included) clears the
  // decorations; instead of declaring staleness we recompute the preview against the
  // newest content. Only changes that make the remaining operations impossible are stale.
  const [recomputeTick, setRecomputeTick] = useState(0);

  useEffect(() => {
    setPayload(null);
    setError(null);
    void readArtifact<WritingProposalPayload>(
      transport,
      proposal.conversationId,
      proposal.artifactId,
    )
      .then(setPayload)
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [transport, proposal.conversationId, proposal.artifactId]);

  const decided = useMemo(() => new Set(proposal.decidedBlockIds), [proposal.decidedBlockIds]);
  const preview = useMemo<{ data: EditorReplacementPreviewData | null; invalid: boolean }>(() => {
    if (!payload || !controller || controller.isDestroyed) return { data: null, invalid: false };
    const operations = payload.operationBatch.operations.filter(
      (operation) => !decided.has(operationBlockId(operation)),
    );
    if (!operations.length) return { data: null, invalid: false };
    const original = controller.getSnapshot();
    const applied = applyOperationBatch(
      original,
      {
        ...payload.operationBatch,
        // Preview-only identity: the schema requires an op_ prefixed id; nothing is written.
        operationId: `op_preview-${proposal.artifactId.slice(4)}-${proposal.reviewRevision}`,
        preconditions: [],
        operations,
      },
      { documentId: payload.document.documentId, generationId: payload.document.generationId },
    );
    if (!applied.success) return { data: null, invalid: true };
    return {
      data: {
        id: `${proposal.artifactId}:${proposal.reviewRevision}`,
        original,
        proposed: applied.content,
      },
      invalid: false,
    };
  }, [payload, controller, decided, proposal.artifactId, proposal.reviewRevision, recomputeTick]);

  async function decide(action: 'accept' | 'reject', blockIds?: string[]) {
    setBusy(true);
    setError(null);
    try {
      const { reviewAiProposal } = await import('../../api/generated/ai');
      await reviewAiProposal(proposal.artifactId, {
        decisionId: crypto.randomUUID(),
        revision: proposal.reviewRevision,
        action,
        ...(blockIds?.length ? { blockIds } : {}),
      });
      // No explicit refetch: the durable artifact.application-updated event arrives over SSE
      // and the snapshot re-derives decided blocks, shrinking the preview to what remains.
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const stale = preview.invalid || proposal.applicationState === 'conflict';
  return (
    <EditorReplacementReview
      preview={stale ? null : preview.data}
      waitForOriginal
      stale={stale}
      busy={busy}
      error={error}
      onReplace={() => void decide('accept')}
      onDismiss={() => void decide('reject')}
      onAcceptBlock={(blockId) => void decide('accept', [blockId])}
      onRejectBlock={(blockId) => void decide('reject', [blockId])}
      onInvalidated={() => setRecomputeTick((tick) => tick + 1)}
    />
  );
}
