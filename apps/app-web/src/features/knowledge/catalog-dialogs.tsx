import { useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, LoaderCircle } from 'lucide-react';
import {
  createCatalog,
  createDocument,
  deleteCatalog,
  getCatalogDeletionImpact,
  listCatalogChildren,
  moveCatalog,
  moveKnowledgeDocument,
  updateCatalog,
} from '@/api/generated/app-api';
import { errorMessage } from '@/api/api-error';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { invalidateSpaceData } from './space-data';
import { useKnowledgeWorkspace } from './workspace-context';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * Catalog/document structure actions. The tree, the browse panel, and the
 * document pane all emit these; the space page hosts a single set of dialogs.
 */
export type CatalogAction =
  | { kind: 'create-catalog'; parentId: string }
  | { kind: 'rename-catalog'; catalog: { id: string; name: string; icon: string | null } }
  | { kind: 'delete-catalog'; catalog: { id: string; name: string } }
  | { kind: 'move-catalog'; catalog: { id: string; name: string } }
  | { kind: 'create-document'; catalogId: string }
  | {
      kind: 'move-document';
      document: { id: string; title: string; metadataRevision: number };
    };

const EMOJI_PRESETS = [
  '📁',
  '📚',
  '📝',
  '💡',
  '🚀',
  '🎯',
  '🧭',
  '🗂️',
  '📊',
  '🧪',
  '🛠️',
  '🎨',
  '📣',
  '🤝',
  '💼',
  '🏷️',
  '🔖',
  '🌱',
  '⭐',
  '🔥',
  '🌐',
  '🧩',
];

export function EmojiField({
  value,
  onChange,
  label,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  label: string;
}) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</legend>
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          aria-pressed={value === null}
          onClick={() => onChange(null)}
          className={`h-8 rounded-lg border px-2 text-xs transition-colors duration-150 ${
            value === null
              ? 'border-primary bg-secondary text-primary'
              : 'border-transparent text-muted-foreground hover:bg-secondary'
          }`}
        >
          无图标
        </button>
        {EMOJI_PRESETS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            aria-label={`使用图标 ${emoji}`}
            aria-pressed={value === emoji}
            onClick={() => onChange(value === emoji ? null : emoji)}
            className={`flex size-8 items-center justify-center rounded-lg border text-base transition-colors duration-150 hover:bg-secondary ${
              value === emoji ? 'border-primary bg-secondary' : 'border-transparent'
            }`}
          >
            {emoji}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function FormDialog({
  title,
  description,
  submitLabel,
  busy,
  error,
  onSubmit,
  onCancel,
  children,
}: {
  title: string;
  description: string;
  submitLabel: string;
  busy: boolean;
  error: string | null;
  onSubmit: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <DialogContent showCloseButton={false}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">{children}</div>
          {error && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
              取消
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <LoaderCircle className="animate-spin" aria-hidden="true" />}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Stable-per-open idempotency key: retries reuse it, success clears it. */
function useIdempotencyKey(): () => string {
  const keyRef = useRef<string | null>(null);
  return () => {
    keyRef.current ??= crypto.randomUUID();
    return keyRef.current;
  };
}

function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export function CreateCatalogDialog({
  workspaceId,
  parentId,
  identityKey,
  onClose,
}: {
  workspaceId: string;
  parentId: string;
  identityKey: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [icon, setIcon] = useState<string | null>(null);
  const { busy, error, run } = useSubmit();
  const idempotencyKey = useIdempotencyKey();
  return (
    <FormDialog
      title="新建目录"
      description="目录用于在空间内组织文档，目录本身不设置访问权限。"
      submitLabel="创建目录"
      busy={busy}
      error={error}
      onCancel={onClose}
      onSubmit={() =>
        void run(async () => {
          const trimmed = name.trim();
          if (!trimmed) {
            throw new Error('请填写目录名称。');
          }
          await createCatalog(
            workspaceId,
            { name: trimmed, icon, parentId },
            { headers: { 'Idempotency-Key': idempotencyKey() } },
          );
          invalidateSpaceData(queryClient, identityKey, workspaceId);
          onClose();
        })
      }
    >
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="catalog-name">
          目录名称
        </label>
        <Input
          id="catalog-name"
          autoFocus
          maxLength={40}
          placeholder="例如：产品手册"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <EmojiField label="图标（可选）" value={icon} onChange={setIcon} />
    </FormDialog>
  );
}

export function RenameCatalogDialog({
  catalog,
  identityKey,
  workspaceId,
  onClose,
}: {
  catalog: { id: string; name: string; icon: string | null };
  identityKey: string;
  workspaceId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(catalog.name);
  const [icon, setIcon] = useState<string | null>(catalog.icon);
  const { busy, error, run } = useSubmit();
  return (
    <FormDialog
      title="重命名目录"
      description="修改目录的名称或图标。"
      submitLabel="保存"
      busy={busy}
      error={error}
      onCancel={onClose}
      onSubmit={() =>
        void run(async () => {
          const trimmed = name.trim();
          if (!trimmed) {
            throw new Error('请填写目录名称。');
          }
          await updateCatalog(catalog.id, { name: trimmed, icon });
          invalidateSpaceData(queryClient, identityKey, workspaceId);
          onClose();
        })
      }
    >
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="rename-catalog-name">
          目录名称
        </label>
        <Input
          id="rename-catalog-name"
          autoFocus
          maxLength={40}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <EmojiField label="图标" value={icon} onChange={setIcon} />
    </FormDialog>
  );
}

export function DeleteCatalogDialog({
  catalog,
  identityKey,
  workspaceId,
  onClose,
}: {
  catalog: { id: string; name: string };
  identityKey: string;
  workspaceId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const impact = useQuery({
    queryKey: ['catalog-delete-impact', catalog.id],
    queryFn: ({ signal }) => getCatalogDeletionImpact(catalog.id, { signal }),
    staleTime: 0,
  });
  const [error, setError] = useState<string | null>(null);
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`删除目录「${catalog.name}」？`}
      description="目录删除后无法恢复；目录内的文档会移入回收站，可以在回收站中还原。"
      confirmLabel="删除目录"
      destructive
      error={error ?? (impact.isError ? errorMessage(impact.error) : null)}
      onConfirm={async () => {
        try {
          await deleteCatalog(catalog.id);
          invalidateSpaceData(queryClient, identityKey, workspaceId);
        } catch (cause) {
          setError(errorMessage(cause));
          return false;
        }
      }}
    >
      {impact.isPending ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="animate-spin" size={15} aria-hidden="true" />
          正在统计影响范围…
        </p>
      ) : impact.data ? (
        <p className="rounded-lg bg-secondary px-3 py-2 text-sm">
          将级联删除 <strong className="font-semibold">{impact.data.catalogCount}</strong>{' '}
          个子目录， 并把 <strong className="font-semibold">{impact.data.documentCount}</strong>{' '}
          篇文档移入回收站。
        </p>
      ) : null}
    </ConfirmDialog>
  );
}

function PickerRow({
  depth,
  icon,
  label,
  selected,
  disabled,
  expandable,
  expanded,
  onSelect,
  onToggle,
}: {
  depth: number;
  icon: string | null;
  label: string;
  selected: boolean;
  disabled?: boolean;
  expandable: boolean;
  expanded: boolean;
  onSelect: () => void;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center" style={{ paddingLeft: depth * 14 }}>
      <button
        type="button"
        aria-label={expanded ? '收起子目录' : '展开子目录'}
        aria-expanded={expandable ? expanded : undefined}
        disabled={!expandable}
        onClick={onToggle}
        className={`flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground ${
          expandable ? 'hover:bg-secondary hover:text-foreground' : 'invisible'
        }`}
      >
        <ChevronRight
          size={13}
          aria-hidden="true"
          className={`transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
        />
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        disabled={disabled}
        onClick={onSelect}
        className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1.5 pl-1 pr-2 text-left text-sm transition-colors duration-150 ${
          selected
            ? 'bg-secondary font-medium text-primary'
            : disabled
              ? 'cursor-not-allowed text-muted-foreground/50'
              : 'hover:bg-secondary'
        }`}
      >
        <span aria-hidden="true" className="shrink-0 text-xs">
          {icon || '📁'}
        </span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {selected && <Check size={13} aria-hidden="true" className="shrink-0" />}
      </button>
    </div>
  );
}

function PickerBranch({
  workspaceId,
  catalogId,
  depth,
  identityKey,
  excludeCatalogId,
  expanded,
  toggle,
  value,
  onChange,
}: {
  workspaceId: string;
  catalogId: string;
  depth: number;
  identityKey: string;
  excludeCatalogId?: string;
  expanded: Set<string>;
  toggle: (id: string) => void;
  value: string | null;
  onChange: (id: string) => void;
}) {
  const children = useQuery({
    queryKey: ['catalog-children', identityKey, workspaceId, catalogId],
    queryFn: ({ signal }) => listCatalogChildren(workspaceId, catalogId, { signal }),
    staleTime: 30_000,
  });
  if (children.isPending)
    return (
      <p className="py-1.5 text-xs text-muted-foreground" style={{ paddingLeft: depth * 14 + 28 }}>
        正在加载…
      </p>
    );
  if (children.isError)
    return (
      <p className="py-1.5 text-xs text-destructive" style={{ paddingLeft: depth * 14 + 28 }}>
        子目录加载失败
      </p>
    );
  return children.data.catalogs.map((catalog) => {
    const excluded = catalog.id === excludeCatalogId;
    return (
      <div key={catalog.id}>
        <PickerRow
          depth={depth}
          icon={catalog.icon}
          label={excluded ? `${catalog.name}（不可移入自身）` : catalog.name}
          selected={value === catalog.id}
          disabled={excluded}
          expandable={catalog.hasChildren && !excluded}
          expanded={expanded.has(catalog.id)}
          onSelect={() => onChange(catalog.id)}
          onToggle={() => toggle(catalog.id)}
        />
        {expanded.has(catalog.id) && !excluded && (
          <PickerBranch
            workspaceId={workspaceId}
            catalogId={catalog.id}
            depth={depth + 1}
            identityKey={identityKey}
            excludeCatalogId={excludeCatalogId}
            expanded={expanded}
            toggle={toggle}
            value={value}
            onChange={onChange}
          />
        )}
      </div>
    );
  });
}

export function CatalogPicker({
  workspaceId,
  rootCatalogId,
  identityKey,
  excludeCatalogId,
  value,
  onChange,
}: {
  workspaceId: string;
  rootCatalogId: string;
  identityKey: string;
  excludeCatalogId?: string;
  value: string | null;
  onChange: (catalogId: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([rootCatalogId]));
  const toggle = (id: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div
      role="radiogroup"
      aria-label="选择目标目录"
      className="max-h-60 min-h-28 overflow-y-auto rounded-xl border border-border bg-background p-1"
    >
      <PickerRow
        depth={0}
        icon="🏠"
        label="空间根目录"
        selected={value === rootCatalogId}
        expandable
        expanded={expanded.has(rootCatalogId)}
        onSelect={() => onChange(rootCatalogId)}
        onToggle={() => toggle(rootCatalogId)}
      />
      {expanded.has(rootCatalogId) && (
        <PickerBranch
          workspaceId={workspaceId}
          catalogId={rootCatalogId}
          depth={1}
          identityKey={identityKey}
          excludeCatalogId={excludeCatalogId}
          expanded={expanded}
          toggle={toggle}
          value={value}
          onChange={onChange}
        />
      )}
    </div>
  );
}

export function MoveCatalogDialog({
  catalog,
  workspaceId,
  rootCatalogId,
  identityKey,
  onClose,
}: {
  catalog: { id: string; name: string };
  workspaceId: string;
  rootCatalogId: string;
  identityKey: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<string | null>(null);
  const { busy, error, run } = useSubmit();
  return (
    <FormDialog
      title={`移动目录「${catalog.name}」`}
      description="选择新的父级目录；其子目录与文档将一并移动。"
      submitLabel="移动到此处"
      busy={busy}
      error={error}
      onCancel={onClose}
      onSubmit={() =>
        void run(async () => {
          if (!target) throw new Error('请选择目标目录。');
          await moveCatalog(catalog.id, { parentId: target, beforeId: null });
          invalidateSpaceData(queryClient, identityKey, workspaceId);
          onClose();
        })
      }
    >
      <CatalogPicker
        workspaceId={workspaceId}
        rootCatalogId={rootCatalogId}
        identityKey={identityKey}
        excludeCatalogId={catalog.id}
        value={target}
        onChange={setTarget}
      />
    </FormDialog>
  );
}

export function MoveDocumentDialog({
  document,
  workspaceId,
  rootCatalogId,
  identityKey,
  onClose,
}: {
  document: { id: string; title: string; metadataRevision: number };
  workspaceId: string;
  rootCatalogId: string;
  identityKey: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { workspaces } = useKnowledgeWorkspace();
  const [targetWorkspaceId, setTargetWorkspaceId] = useState(workspaceId);
  const selectedWorkspace = workspaces.find((item) => item.id === targetWorkspaceId);
  const [target, setTarget] = useState<string | null>(null);
  const { busy, error, run } = useSubmit();
  return (
    <FormDialog
      title={`移动文档「${document.title}」`}
      description="选择目标空间和目录；正文、版本及文档授权随文档保留。"
      submitLabel="移动到此处"
      busy={busy}
      error={error}
      onCancel={onClose}
      onSubmit={() =>
        void run(async () => {
          if (!target) throw new Error('请选择目标目录。');
          await moveKnowledgeDocument(document.id, {
            workspaceId: targetWorkspaceId,
            catalogId: target,
            beforeId: null,
            metadataRevision: document.metadataRevision,
          });
          invalidateSpaceData(queryClient, identityKey);
          void queryClient.invalidateQueries({ queryKey: ['document', document.id] });
          onClose();
        })
      }
    >
      <label className="space-y-1.5 text-sm">
        目标空间
        <Select
          value={targetWorkspaceId}
          onValueChange={(value) => {
            if (value) {
              setTargetWorkspaceId(value);
              setTarget(null);
            }
          }}
          items={Object.fromEntries(
            workspaces.filter((item) => item.canOrganize).map((item) => [item.id, item.name]),
          )}
        >
          <SelectTrigger aria-label="目标空间">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {workspaces
              .filter((item) => item.canOrganize)
              .map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.icon} {item.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </label>
      <CatalogPicker
        key={targetWorkspaceId}
        workspaceId={targetWorkspaceId}
        rootCatalogId={selectedWorkspace?.rootCatalogId ?? rootCatalogId}
        identityKey={identityKey}
        value={target}
        onChange={setTarget}
      />
    </FormDialog>
  );
}

export function CreateDocumentDialog({
  workspaceId,
  catalogId,
  identityKey,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  catalogId: string;
  identityKey: string;
  onClose: () => void;
  onCreated: (document: { id: string; workspaceId: string }) => void;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const { busy, error, run } = useSubmit();
  const idempotencyKey = useIdempotencyKey();
  return (
    <FormDialog
      title="新建文档"
      description="文档会创建在当前选中的目录下，并直接进入协同编辑。"
      submitLabel="创建并打开"
      busy={busy}
      error={error}
      onCancel={onClose}
      onSubmit={() =>
        void run(async () => {
          const created = await createDocument(
            {
              title: title.trim() || '未命名文档',
              workspaceId,
              catalogId,
            },
            { headers: { 'Idempotency-Key': idempotencyKey() } },
          );
          invalidateSpaceData(queryClient, identityKey, workspaceId);
          onClose();
          onCreated({ id: created.id, workspaceId: created.workspaceId });
        })
      }
    >
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="new-document-title">
          文档标题
        </label>
        <Input
          id="new-document-title"
          autoFocus
          maxLength={200}
          placeholder="未命名文档"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
    </FormDialog>
  );
}

/** Single dialog host for the whole space page; `action` decides which one shows. */
export function CatalogActionDialogs({
  action,
  onClose,
  workspaceId,
  rootCatalogId,
  identityKey,
  onDocumentCreated,
}: {
  action: CatalogAction | null;
  onClose: () => void;
  workspaceId: string;
  rootCatalogId: string;
  identityKey: string;
  onDocumentCreated: (document: { id: string; workspaceId: string }) => void;
}) {
  if (!action) return null;
  switch (action.kind) {
    case 'create-catalog':
      return (
        <CreateCatalogDialog
          workspaceId={workspaceId}
          parentId={action.parentId}
          identityKey={identityKey}
          onClose={onClose}
        />
      );
    case 'rename-catalog':
      return (
        <RenameCatalogDialog
          key={action.catalog.id}
          catalog={action.catalog}
          workspaceId={workspaceId}
          identityKey={identityKey}
          onClose={onClose}
        />
      );
    case 'delete-catalog':
      return (
        <DeleteCatalogDialog
          key={action.catalog.id}
          catalog={action.catalog}
          workspaceId={workspaceId}
          identityKey={identityKey}
          onClose={onClose}
        />
      );
    case 'move-catalog':
      return (
        <MoveCatalogDialog
          key={action.catalog.id}
          catalog={action.catalog}
          workspaceId={workspaceId}
          rootCatalogId={rootCatalogId}
          identityKey={identityKey}
          onClose={onClose}
        />
      );
    case 'create-document':
      return (
        <CreateDocumentDialog
          workspaceId={workspaceId}
          catalogId={action.catalogId}
          identityKey={identityKey}
          onClose={onClose}
          onCreated={onDocumentCreated}
        />
      );
    case 'move-document':
      return (
        <MoveDocumentDialog
          key={action.document.id}
          document={action.document}
          workspaceId={workspaceId}
          rootCatalogId={rootCatalogId}
          identityKey={identityKey}
          onClose={onClose}
        />
      );
  }
}
