import { useState } from 'react';
import { Description, Dropdown, Header, Label } from '@heroui/react';
import { BookOpen, FileText, FolderOpen, Info, Search } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ScopeSelection } from '@zhishu/ai-contracts';
import type { ListKnowledgeWorkspaces200Item } from '../../api/generated/app-api.schemas';
import {
  CheckTick,
  PickerNote,
  PickerTrigger,
  RadioTick,
  pickerPopoverClass,
} from './picker-shared';
import { workspaceKindLabel } from './workspace-labels';

const MAX_WORKSPACES = 8;

const SCOPE_ICON = {
  all: BookOpen,
  workspaces: FolderOpen,
  documents: FileText,
} as const satisfies Record<ScopeSelection['kind'], LucideIcon>;

function scopeLabel(
  value: ScopeSelection,
  documentLabel?: { documentId: string; title: string },
): string {
  switch (value.kind) {
    case 'all':
      return '全部有权限资料';
    case 'workspaces':
      return `${value.workspaceIds.length} 个空间`;
    case 'documents':
      return documentLabel ? `文档：${documentLabel.title}` : `${value.documentIds.length} 篇文档`;
  }
}

function toggleWorkspace(id: string, current: ScopeSelection): ScopeSelection {
  const selected = current.kind === 'workspaces' ? current.workspaceIds : [];
  const next = selected.includes(id)
    ? selected.filter((item) => item !== id)
    : [...selected, id].slice(0, MAX_WORKSPACES);
  return next.length ? { kind: 'workspaces', workspaceIds: next } : { kind: 'all' };
}

/** Toolbar scope control: 全部资料 / 指定空间（≤8）/ 当前文档. The server computes the final set. */
export function ScopePicker({
  workspaces,
  value,
  onChange,
  documentLabel,
}: {
  workspaces: readonly ListKnowledgeWorkspaces200Item[];
  value: ScopeSelection;
  onChange: (next: ScopeSelection) => void;
  documentLabel?: { documentId: string; title: string };
}) {
  const [open, setOpen] = useState(false);
  const label = scopeLabel(value, documentLabel);
  const Icon = SCOPE_ICON[value.kind];
  const selected = value.kind === 'workspaces' ? new Set(value.workspaceIds) : new Set<string>();
  const full = selected.size >= MAX_WORKSPACES;
  return (
    <Dropdown isOpen={open} onOpenChange={setOpen}>
      <PickerTrigger
        icon={Icon}
        label={label}
        ariaLabel={`来源范围：${label}`}
        open={open}
        tone={value.kind === 'all' ? 'default' : 'narrowed'}
      />
      <Dropdown.Popover placement="top start" className={pickerPopoverClass}>
        <Dropdown.Menu
          shouldCloseOnSelect={false}
          className="gap-0.5 text-[13px]"
          disabledKeys={full ? workspaces.filter((w) => !selected.has(w.id)).map((w) => w.id) : []}
        >
          <Dropdown.Section>
            <Header className="px-2 text-xs font-medium text-muted-foreground">检索范围</Header>
            <Dropdown.Item
              id="scope-all"
              textValue="全部有权限资料"
              onAction={() => {
                onChange({ kind: 'all' });
                setOpen(false);
              }}
            >
              <RadioTick active={value.kind === 'all'} />
              <div className="flex flex-col">
                <Label className="flex items-center gap-2 font-normal">
                  <BookOpen className="size-4 shrink-0 text-muted" />
                  全部有权限资料
                </Label>
                <Description>按当前权限由服务端实时计算</Description>
              </div>
            </Dropdown.Item>
            {documentLabel && (
              <Dropdown.Item
                id="scope-document"
                textValue={`仅当前文档 ${documentLabel.title}`}
                onAction={() => {
                  onChange({ kind: 'documents', documentIds: [documentLabel.documentId] });
                  setOpen(false);
                }}
              >
                <RadioTick active={value.kind === 'documents'} />
                <div className="flex flex-col">
                  <Label className="flex items-center gap-2 font-normal">
                    <FileText className="size-4 shrink-0 text-muted" />
                    仅当前文档
                  </Label>
                  <Description>{documentLabel.title}</Description>
                </div>
              </Dropdown.Item>
            )}
          </Dropdown.Section>
          <Dropdown.Section>
            <Header className="px-2 text-xs font-medium text-muted-foreground">
              指定空间（最多 {MAX_WORKSPACES} 个）
              {selected.size > 0 && ` · 已选 ${selected.size}`}
            </Header>
            {workspaces.length === 0 ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">正在载入空间…</p>
            ) : (
              workspaces.map((workspace) => (
                <Dropdown.Item
                  key={workspace.id}
                  id={workspace.id}
                  textValue={workspace.name}
                  onAction={() => onChange(toggleWorkspace(workspace.id, value))}
                >
                  <CheckTick active={selected.has(workspace.id)} />
                  <div className="flex flex-col">
                    <Label className="font-normal">{workspace.name}</Label>
                    <Description>{workspaceKindLabel(workspace.kind)}空间</Description>
                  </div>
                </Dropdown.Item>
              ))
            )}
          </Dropdown.Section>
          <Dropdown.Item id="scope-documents" textValue="指定文章" isDisabled>
            <div className="flex flex-col">
              <Label className="flex items-center gap-2 font-normal">
                <Search className="size-4 shrink-0 text-muted" />
                指定文章…
              </Label>
              <Description>文档多选（即将支持）</Description>
            </div>
          </Dropdown.Item>
        </Dropdown.Menu>
        <PickerNote>
          <Info className="me-1 inline-block size-3 align-[-2px]" />
          最终检索集合由服务端按当前授权计算；变更范围会停止进行中的旧任务并推进上下文修订。
        </PickerNote>
      </Dropdown.Popover>
    </Dropdown>
  );
}
