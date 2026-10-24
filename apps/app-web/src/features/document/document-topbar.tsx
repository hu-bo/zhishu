import { useState } from 'react';
import type { ReactNode } from 'react';
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
  LockKeyhole,
  Menu as MenuIcon,
  Users,
  Settings,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu';

export interface DocumentTopbarProps {
  aiEntry?: ReactNode;
  workspaceName: string;
  workspaceMemberCount: number;
  canManageWorkspace: boolean;
  onlineCount: number;
  onOpenMembers: () => void;
  onOpenWorkspaceSettings: () => void;
  onOpenDirectory: () => void;
  /** Locate catalog path without the root segment; null while resolving. */
  catalogPath: { id: string; name: string }[] | null;
  title: string;
  icon: string | null;
  canManage: boolean;
  readOnlyReason: string | null;
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
  aiEntry,
  workspaceName,
  workspaceMemberCount,
  canManageWorkspace,
  onlineCount,
  onOpenMembers,
  onOpenWorkspaceSettings,
  onOpenDirectory,
  catalogPath,
  title,
  icon,
  canManage,
  readOnlyReason,
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
    <header className="flex h-15 min-w-0 shrink-0 items-center gap-1 border-b border-border/70 bg-card/95 px-2 backdrop-blur sm:gap-1.5 sm:px-4">
      <div className="flex shrink-0 items-center gap-0.5">
        <Button variant="ghost" size="icon-sm" aria-label="返回目录浏览" onClick={onBack}>
          <ArrowLeft size={15} aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="lg:hidden"
          aria-label="打开空间目录"
          onClick={onOpenDirectory}
        >
          <MenuIcon size={15} aria-hidden="true" />
        </Button>
      </div>

      <nav
        aria-label="文档位置"
        className="hidden min-w-0 max-w-[32%] items-center gap-1 text-xs md:flex"
      >
        <button
          type="button"
          onClick={onOpenWorkspaceRoot}
          className="max-w-32 truncate rounded px-1 py-0.5 text-muted-foreground transition-colors duration-150 hover:bg-secondary hover:text-foreground"
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
              className="max-w-32 truncate rounded px-1 py-0.5 text-muted-foreground transition-colors duration-150 hover:bg-secondary hover:text-foreground"
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
        {viewMode === 'edit' && canManage ? (
          <Input
            aria-label="文档标题"
            value={draft}
            disabled={titleSaving}
            maxLength={200}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitTitle}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === 'Escape') {
                setDraft(title);
                event.currentTarget.blur();
              }
            }}
            className="h-8 max-w-md border-transparent bg-transparent px-1.5 font-medium shadow-none hover:bg-secondary/70 focus-visible:border-ring focus-visible:bg-background"
          />
        ) : (
          <h1 className="min-w-0 truncate px-1.5 text-sm font-medium" title={title}>
            {title}
          </h1>
        )}
        {readOnlyReason && (
          <span
            className="hidden shrink-0 items-center gap-1 rounded-md bg-secondary px-1.5 py-1 text-xs text-muted-foreground sm:inline-flex"
            aria-label={`只读：${readOnlyReason}`}
            title={readOnlyReason}
          >
            <LockKeyhole size={13} aria-hidden="true" />
            只读
          </span>
        )}
      </div>

      {aiEntry}
      <Button
        variant="ghost"
        size="sm"
        aria-label={`空间成员（${workspaceMemberCount} 人）${onlineCount ? `，${onlineCount} 位在线` : ''}`}
        onClick={onOpenMembers}
        className="hidden shrink-0 gap-1.5 px-2 sm:inline-flex"
      >
        <Users size={15} aria-hidden="true" />
        <span className="hidden text-xs sm:inline">成员</span>
        <span className="text-xs">{workspaceMemberCount}</span>
        {onlineCount > 0 && (
          <span className="hidden text-xs text-muted-foreground md:inline">
            {onlineCount} 位在线
          </span>
        )}
      </Button>
      {canManageWorkspace && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="空间设置"
          title="空间设置"
          className="hidden sm:inline-flex"
          onClick={onOpenWorkspaceSettings}
        >
          <Settings size={15} aria-hidden="true" />
        </Button>
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
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 px-2.5"
          aria-label="分享文档"
          onClick={onShare}
        >
          <Share2 size={15} aria-hidden="true" />
          <span className="hidden lg:inline">分享</span>
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        className="hidden sm:inline-flex"
        aria-label="历史版本"
        onClick={onVersions}
      >
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
          <MenuItem className="sm:hidden" onClick={onOpenMembers}>
            <Users size={14} aria-hidden="true" />
            空间成员（{workspaceMemberCount}）
          </MenuItem>
          {canManageWorkspace && (
            <MenuItem className="sm:hidden" onClick={onOpenWorkspaceSettings}>
              <Settings size={14} aria-hidden="true" />
              空间设置
            </MenuItem>
          )}
          <MenuItem className="sm:hidden" onClick={onVersions}>
            <History size={14} aria-hidden="true" />
            历史版本
          </MenuItem>
          <MenuItem onClick={onTransfer}>
            <FileDown size={14} aria-hidden="true" />
            导入导出…
          </MenuItem>
          {viewMode === 'edit' && (
            <MenuItem onClick={onMetadata}>
              <Pencil size={14} aria-hidden="true" />
              图标与标签…
            </MenuItem>
          )}
          <MenuItem onClick={onInfo}>
            <Info size={14} aria-hidden="true" />
            文档详情…
          </MenuItem>
          {canManage && viewMode === 'edit' && (
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
    </header>
  );
}
