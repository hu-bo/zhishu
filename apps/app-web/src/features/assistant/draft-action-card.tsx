import { useState } from 'react';
import { ActionCard, type CardTone } from '@zhishu/chat-ui';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/cn';
import { FileText, FolderDown, RefreshCw, X } from 'lucide-react';
import { CARD_BUTTON_CLASS } from './picker-shared';

/**
 * Draft command card phases. `created` is intentionally absent: the created receipt is
 * derived from the snapshot (draft artifact + server-bound targetDocumentId), never from
 * local state, so a stale page can never claim a document exists.
 */
export type DraftPhase = 'local' | 'submitting' | 'creating' | 'failed' | 'unknown';

const PHASE_VIEW = {
  local: { tone: 'info', badge: '待确认', spinner: false },
  submitting: { tone: 'info', badge: '受理中', spinner: true },
  creating: { tone: 'info', badge: '创建中', spinner: true },
  failed: { tone: 'danger', badge: '创建失败', spinner: false },
  unknown: { tone: 'warning', badge: '结果未知', spinner: false },
} as const satisfies Record<DraftPhase, { tone: CardTone; badge: string; spinner: boolean }>;

export interface DraftCardState {
  phase: DraftPhase;
  instruction: string;
  workspaceId: string | null;
  runId: string | null;
  error?: string;
}

/** One node of the 已受理 → 生成 → 初始化并绑定 track; states come from run facts. */
type StepState = 'done' | 'current' | 'todo';

function StepTrack({ steps }: { steps: { label: string; state: StepState }[] }) {
  return (
    <div className="assistant-steps" role="list">
      {steps.map((step, index) => (
        <div key={step.label} className="assistant-steps__item" role="listitem">
          {index > 0 && (
            <span className={cn('assistant-steps__line', step.state !== 'todo' && 'done')} />
          )}
          <span className={cn('assistant-steps__pt', step.state)} aria-hidden="true" />
          <span>{step.label}</span>
        </div>
      ))}
    </div>
  );
}

function draftTitle(instruction: string): string {
  const firstLine = instruction.split('\n')[0]?.trim() ?? '';
  const title = firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine;
  return title ? `创建草稿：${title}` : '创建草稿';
}

function draftSubtitle(state: DraftCardState, workspaceLabel: string | null): string | undefined {
  if (state.phase === 'local') return '尚未提交 · 确认后才会创建真实文档';
  if (workspaceLabel) return `目标：${workspaceLabel}`;
  return undefined;
}

export function DraftActionCard({
  state,
  workspaceLabel,
  busy,
  onInstructionChange,
  onEditWorkspace,
  onConfirm,
  onDiscard,
  onCancelRun,
  onRetry,
  onRefresh,
}: {
  state: DraftCardState;
  workspaceLabel: string | null;
  busy: boolean;
  onInstructionChange: (value: string) => void;
  onEditWorkspace: () => void;
  onConfirm: (input: { instruction: string; workspaceId: string }) => void;
  onDiscard: () => void;
  onCancelRun: () => void;
  onRetry: () => void;
  onRefresh: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const view = PHASE_VIEW[state.phase];
  const editable = state.phase === 'local';
  const canConfirm =
    state.phase === 'local' && !!state.workspaceId && state.instruction.trim().length > 0 && !busy;

  const body = () => {
    if (state.phase === 'local' || state.phase === 'submitting') {
      return (
        <>
          <div className="assistant-draft-kv">
            <span className="k">保存到</span>
            <span className="v">
              {workspaceLabel ?? '未选择'}
              {editable && (
                <button type="button" className="assistant-draft-edit" onClick={onEditWorkspace}>
                  <FolderDown className="size-3" />
                  更改
                </button>
              )}
            </span>
            <span className="k">草稿要求</span>
            <span className="v">
              {editable && !editing ? (
                <span className="assistant-draft-summary">
                  {state.instruction || '（未填写）'}
                  <button
                    type="button"
                    className="assistant-draft-edit"
                    onClick={() => setEditing(true)}
                  >
                    编辑
                  </button>
                </span>
              ) : (
                <textarea
                  className="assistant-draft-textarea"
                  value={state.instruction}
                  rows={3}
                  maxLength={8000}
                  disabled={!editable}
                  onChange={(event) => onInstructionChange(event.target.value)}
                />
              )}
            </span>
          </div>
        </>
      );
    }
    if (state.phase === 'creating') {
      return (
        <StepTrack
          steps={[
            { label: '已受理', state: 'done' },
            { label: '生成草稿并校验', state: 'current' },
            { label: '初始化并绑定文档', state: 'todo' },
          ]}
        />
      );
    }
    if (state.phase === 'failed') {
      return (
        <p className="assistant-draft-error">
          {state.error ?? '创建失败。'}
          <span className="block text-[11px] text-muted">
            重试前系统会核对是否已有创建结果，不会重复创建文档。
          </span>
        </p>
      );
    }
    return (
      <p className="assistant-draft-error warning">
        系统正按操作标识核对回执，不会重复写入或创建；如文档已创建将直接显示。
      </p>
    );
  };

  const footer = () => {
    if (state.phase === 'local') {
      return (
        <>
          <Button variant="ghost" size="xs" className={CARD_BUTTON_CLASS} onClick={onDiscard}>
            取消
          </Button>
          <Button
            variant="default"
            size="xs"
            className={cn(CARD_BUTTON_CLASS, 'ms-auto')}
            disabled={!canConfirm}
            title={state.workspaceId ? undefined : '请先选择保存位置'}
            onPress={() => {
              if (!state.workspaceId) return;
              setEditing(false);
              onConfirm({ instruction: state.instruction.trim(), workspaceId: state.workspaceId });
            }}
          >
            确认创建
          </Button>
        </>
      );
    }
    if (state.phase === 'submitting') {
      return (
        <Button variant="ghost" size="xs" className={cn(CARD_BUTTON_CLASS, 'ms-auto')} disabled>
          提交中…
        </Button>
      );
    }
    if (state.phase === 'creating') {
      return (
        <>
          <Button variant="ghost" size="xs" className={CARD_BUTTON_CLASS} onPress={onRefresh}>
            <RefreshCw className="size-3.5" />
            刷新状态
          </Button>
          <Button
            variant="secondary"
            size="xs"
            className={cn(CARD_BUTTON_CLASS, 'ms-auto')}
            onPress={onCancelRun}
          >
            取消任务
          </Button>
        </>
      );
    }
    if (state.phase === 'failed') {
      return (
        <>
          <Button variant="ghost" size="xs" className={CARD_BUTTON_CLASS} onPress={onDiscard}>
            <X className="size-3.5" />
            关闭
          </Button>
          <Button
            variant="default"
            size="xs"
            className={cn(CARD_BUTTON_CLASS, 'ms-auto')}
            disabled={busy}
            onPress={onRetry}
          >
            重试（先核对已有结果）
          </Button>
        </>
      );
    }
    return (
      <Button
        variant="secondary"
        size="xs"
        className={cn(CARD_BUTTON_CLASS, 'ms-auto')}
        onPress={onRefresh}
      >
        <RefreshCw className="size-3.5" />
        刷新状态
      </Button>
    );
  };

  return (
    <ActionCard
      label="创建草稿"
      tone={view.tone}
      icon={<FileText className="size-4" />}
      title={draftTitle(state.instruction)}
      subtitle={draftSubtitle(state, workspaceLabel)}
      badge={{ text: view.badge, spinner: view.spinner }}
      footnote={
        state.phase === 'local' || state.phase === 'submitting'
          ? '草稿将创建为所选空间中的一篇真实文档；来源范围与保存位置分别校验，创建时服务端再次判权。'
          : undefined
      }
      footer={<>{footer()}</>}
    >
      {body()}
    </ActionCard>
  );
}
