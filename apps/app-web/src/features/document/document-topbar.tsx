import { useState } from 'react';
import {
  ChevronRight,
  Eye,
  FileDown,
  History,
  Info,
  FolderInput,
  MoreHorizontal,
  Pencil,
  Share2,
  Trash2,
  ArrowLeft,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu';

export interface DocumentTopbarProps {
  workspaceName: string;
  /** Locate catalog path without the root segment; null while resolving. */
  catalogPath: { id: string; name: string }[] | null;
  title: string;
  icon: string | null;
  canManage: boolean;
  collaborative: boolean;
  durableSeq?: number;
  titleSaving: boolean;
  onTitleSave: (title: string) => void;
  viewMode: 'edit' | 'read';
  onViewModeToggle: () => void;
  onBack: () => void;
  onOpenWorkspaceRoot: () => void;
  onOpenCatalog: (catalogId: string) => void;
  onShare: () => void;
  onVersions: () => void;
  onTransfer: () => void;
  onMetadata: () => void;
  onInfo: () => void;
  onMove: () => void;
  onTrash: () => void;
}

/**
 * The single slim bar of the editing view: back · breadcrumbs · inline title ·
 * view/share/history · overflow menu. Everything else lives in dialogs.
 */
export function DocumentTopbar({
  workspaceName,
  catalogPath,
  title,
  icon,
  canManage,
  collaborative,
  durableSeq,
  titleSaving,
  onTitleSave,
  viewMode,
  onViewModeToggle,
  onBack,
  onOpenWorkspaceRoot,
  onOpenCatalog,
  onShare,
  onVersions,
  onTransfer,
  onMetadata,
  onInfo,
  onMove,
  onTrash,
}: DocumentTopbarProps) {
  // Inline title draft; resyncs whenever the persisted title changes (rename
  // saved, external metadata update). Render-phase sync per React's
  // "adjusting state when props change" pattern — no effect needed.
  const [draft, setDraft] = useState(title);
  const [syncedTitle, setSyncedTitle] = useState(title);
  if (title !== syncedTitle) {
    setSyncedTitle(title);
    setDraft(title);
  }
  const commitTitle = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== title) onTitleSave(trimmed);
    else setDraft(title);
  };
  return (
    <div className="flex h-14 shrink-0 items-center gap-1.5 border-b border-border bg-card/95 px-3 backdrop-blur">
      <Button variant="ghost" size="icon-sm" aria-label="返回目录浏览" onClick={onBack}>
        <ArrowLeft size={15} aria-hidden="true" />
      </Button>

      <nav aria-label="文档位置" className="hidden min-w-0 items-center gap-1 text-xs md:flex">
        <button
          type="button"
          onClick={onOpenWorkspaceRoot}
          className="max-w-32 truncate rounded px-1 py-0.5 text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
        >
          {workspaceName}
        </button>
        {(catalogPath ?? []).map((segment) => (
          <span key={segment.id} className="flex min-w-0 items-center gap-1">
            <ChevronRight
              size={12}
              className="shrink-0 text-muted-foreground/60"
              aria-hidden="true"
            />
            <button
              type="button"
              onClick={() => onOpenCatalog(segment.id)}
              className="max-w-32 truncate rounded px-1 py-0.5 text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
            >
              {segment.name}
            </button>
          </span>
        ))}
        <ChevronRight size={12} className="shrink-0 text-muted-foreground/60" aria-hidden="true" />
      </nav>

      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {icon && (
          <span aria-hidden="true" className="shrink-0 text-base leading-none">
            {icon}
          </span>
        )}
        <Input
          aria-label="文档标题"
          value={draft}
          disabled={titleSaving}
          maxLength={200}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitTitle}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === 'Escape') {
              setDraft(title);
              event.currentTarget.blur();
            }
          }}
          className="h-8 max-w-md border-transparent bg-transparent px-1.5 font-medium shadow-none hover:bg-muted/70 focus-visible:border-ring focus-visible:bg-background"
        />
      </div>

      {collaborative && durableSeq !== undefined && (
        <span
          aria-label={`持久化序号 ${durableSeq}`}
          className="hidden shrink-0 items-center gap-1.5 rounded-md bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground sm:inline-flex"
        >
          <span className="relative flex size-1.5" aria-hidden="true">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
            <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
          </span>
          seq {durableSeq}
        </span>
      )}

      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={viewMode === 'edit' ? '切换到阅读模式' : '切换到编辑模式'}
        title={viewMode === 'edit' ? '阅读模式' : '编辑模式'}
        onClick={onViewModeToggle}
      >
        {viewMode === 'edit' ? (
          <Eye size={15} aria-hidden="true" />
        ) : (
          <Pencil size={15} aria-hidden="true" />
        )}
      </Button>
      {canManage && (
        <Button variant="ghost" size="icon-sm" aria-label="分享文档" onClick={onShare}>
          <Share2 size={15} aria-hidden="true" />
        </Button>
      )}
      <Button variant="ghost" size="icon-sm" aria-label="历史版本" onClick={onVersions}>
        <History size={15} aria-hidden="true" />
      </Button>
      <Menu>
        <MenuTrigger
          render={
            <Button variant="ghost" size="icon-sm" aria-label="更多文档操作">
              <MoreHorizontal size={15} aria-hidden="true" />
            </Button>
          }
        />
        <MenuContent align="end">
          <MenuItem onClick={onTransfer}>
            <FileDown size={14} aria-hidden="true" />
            导入导出…
          </MenuItem>
          <MenuItem onClick={onMetadata}>
            <Pencil size={14} aria-hidden="true" />
            文档元数据…
          </MenuItem>
          <MenuItem onClick={onInfo}>
            <Info size={14} aria-hidden="true" />
            文档详情…
          </MenuItem>
          {canManage && (
            <>
              <MenuSeparator />
              <MenuItem onClick={onMove}>
                <FolderInput size={14} aria-hidden="true" />
                移动到…
              </MenuItem>
              <MenuItem variant="destructive" onClick={onTrash}>
                <Trash2 size={14} aria-hidden="true" />
                移入回收站
              </MenuItem>
            </>
          )}
        </MenuContent>
      </Menu>
    </div>
  );
}
