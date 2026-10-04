import { useEffect, useState } from 'react';
import { Link, Outlet, useBlocker, useRouterState } from '@tanstack/react-router';
import {
  CircleUserRound,
  Download,
  FolderKanban,
  Layers,
  LogIn,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  X,
} from 'lucide-react';
import { getCurrentUser, mockLogin, mockLogout } from '@/api/generated/app-api';
import type { MockLogin200User } from '@/api/generated/models';
import {
  exportableUnconfirmedDrafts,
  getAccessToken,
  hasUnconfirmedChanges,
  setAccessToken,
  discardUnconfirmedChanges,
} from '@/api/transport';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useQueryClient } from '@tanstack/react-query';
import { KnowledgeWorkspaceProvider } from '@/features/knowledge/knowledge-context';
import { useKnowledgeWorkspace } from '@/features/knowledge/workspace-context';
import { GlobalSearch } from '@/features/knowledge/global-search';
import {
  cacheIdentity,
  clearOfflineAccount,
  initializeOfflineState,
  readOfflineAccount,
  rememberAccount,
  useOfflineState,
} from '@/features/offline/cache';
import {
  isCollaborationCheckpoint,
  isStandardDraft,
  recordsForIdentity,
} from '@/features/offline/storage';
import { downloadLocalDraft } from '@/features/offline/draft-download';

type ThemeMode = 'system' | 'light' | 'dark';

function readPreference<T extends string>(key: string, fallback: T, accepted: readonly T[]): T {
  try {
    const value = window.localStorage.getItem(key);
    return accepted.includes(value as T) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

const WORKBENCH_SEARCH = {
  view: 'recent',
  sort: 'recent',
  direction: 'desc',
  limit: 20,
  offset: 0,
} as const;

function navLinkClass(collapsed: boolean, active: boolean): string {
  return `flex items-center rounded-lg text-sm transition-colors duration-150 ${
    collapsed ? 'mx-auto size-10 justify-center' : 'gap-3 px-3 py-2'
  } ${
    active
      ? 'bg-secondary font-medium text-primary'
      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
  }`;
}

function WorkspaceNavigation({
  collapsed = false,
  mobile = false,
  onNavigate,
  onToggleCollapsed,
}: {
  collapsed?: boolean;
  mobile?: boolean;
  onNavigate?: () => void;
  onToggleCollapsed?: () => void;
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { workspaces } = useKnowledgeWorkspace();
  return (
    <div className="flex h-full min-h-0 flex-col bg-card text-foreground">
      <div
        className={`flex min-h-16 items-center border-b border-border/70 ${collapsed ? 'justify-center px-2' : 'gap-3 px-4'}`}
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-base font-semibold text-primary-foreground">
          知
        </span>
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <Link
              to="/documents"
              search={WORKBENCH_SEARCH}
              onClick={onNavigate}
              className="block truncate text-base font-semibold tracking-tight"
            >
              知书
            </Link>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">文档与知识空间</p>
          </div>
        )}
        {mobile ? (
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto lg:hidden"
            aria-label="关闭导航"
            onClick={onNavigate}
          >
            <X aria-hidden="true" />
          </Button>
        ) : onToggleCollapsed && !collapsed ? (
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto"
            aria-label="收起导航栏"
            title="收起导航栏"
            onClick={onToggleCollapsed}
          >
            <PanelLeftClose aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {!mobile && collapsed && onToggleCollapsed && (
        <Button
          variant="ghost"
          size="icon"
          className="mx-auto mt-3"
          aria-label="展开导航栏"
          title="展开导航栏"
          onClick={onToggleCollapsed}
        >
          <PanelLeftOpen aria-hidden="true" />
        </Button>
      )}
      <nav aria-label="主导航" className="flex flex-col gap-1 px-2 pt-3 sm:px-3">
        <Link
          to="/documents"
          search={WORKBENCH_SEARCH}
          onClick={onNavigate}
          title={collapsed ? '文档工作台' : undefined}
          aria-current={pathname.startsWith('/documents') ? 'page' : undefined}
          className={navLinkClass(collapsed, pathname.startsWith('/documents'))}
        >
          <Layers size={17} aria-hidden="true" className="shrink-0" />
          {!collapsed && <span className="truncate">文档工作台</span>}
        </Link>
        <Link
          to="/spaces"
          onClick={onNavigate}
          title={collapsed ? '空间与目录' : undefined}
          aria-current={pathname.startsWith('/spaces') ? 'page' : undefined}
          className={navLinkClass(collapsed, pathname.startsWith('/spaces'))}
        >
          <FolderKanban size={17} aria-hidden="true" className="shrink-0" />
          {!collapsed && <span className="truncate">空间与目录</span>}
        </Link>
      </nav>
      {!collapsed && workspaces.length > 0 && (
        <div className="mt-4 flex min-h-0 flex-1 flex-col px-3 sm:px-4">
          <p className="px-2 pb-1.5 text-xs font-medium tracking-wide text-muted-foreground">
            空间
          </p>
          <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1 pb-2">
            {workspaces.map((workspace) => {
              const active = pathname === `/spaces/${workspace.id}`;
              return (
                <Link
                  key={workspace.id}
                  to="/spaces/$workspaceId"
                  params={{ workspaceId: workspace.id }}
                  onClick={onNavigate}
                  aria-current={active ? 'page' : undefined}
                  className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm transition-colors duration-150 ${
                    active
                      ? 'bg-muted font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className="flex size-6 shrink-0 items-center justify-center rounded-md bg-secondary text-xs"
                  >
                    {workspace.icon || '📁'}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70">
                    {workspace.documentCount}
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      )}
      {collapsed && <div className="flex-1" />}
      {!collapsed && !mobile && (
        <div className="border-t border-border/70 px-5 py-4 text-xs leading-5 text-muted-foreground">
          <span className="block font-medium text-foreground">让想法有处安放。</span>
          写下、整理，再和团队一起完善。
        </div>
      )}
    </div>
  );
}

function downloadUnconfirmedDrafts(): number {
  const drafts = exportableUnconfirmedDrafts();
  drafts.forEach((draft, index) => {
    const title = [...draft.title]
      .map((character) => (character.charCodeAt(0) < 32 ? '_' : character))
      .join('')
      .replace(/[<>:"/\\|?*]/gu, '_')
      .trim()
      .slice(0, 100);
    const blob = new Blob([JSON.stringify(draft, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = `${title || `未保存草稿-${index + 1}`}.zhishu.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  });
  return drafts.length;
}

export function AppShell() {
  const offline = useOfflineState();
  const queryClient = useQueryClient();
  // Space detail pages own their layout edge-to-edge; opening a document there
  // promotes the editor's slim topbar to the only bar, so the shell header hides.
  const shell = useRouterState({
    select: (state) => {
      const { pathname, search } = state.location;
      const inSpaceDetail = /^\/spaces\/[^/]+/.test(pathname);
      const doc = (search as { doc?: unknown }).doc;
      return {
        section: pathname.startsWith('/spaces')
          ? '空间'
          : pathname.startsWith('/documents')
            ? '文档工作台'
            : '知书',
        fullBleed: inSpaceDetail,
        editing: inSpaceDetail && typeof doc === 'string' && doc.length > 0,
      };
    },
  });
  const [user, setUser] = useState<MockLogin200User | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authFeedback, setAuthFeedback] = useState<string | null>(null);
  const [authBusyAction, setAuthBusyAction] = useState<'login' | 'logout' | null>(null);
  const [sidebarExpanded, setSidebarExpanded] = useState(
    () =>
      readPreference<'true' | 'false'>('zhishu.sidebar-expanded', 'true', ['true', 'false']) ===
      'true',
  );
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() =>
    readPreference<ThemeMode>('zhishu.theme', 'system', ['system', 'light', 'dark']),
  );

  const blocker = useBlocker({
    shouldBlockFn: () => hasUnconfirmedChanges(),
    enableBeforeUnload: () => hasUnconfirmedChanges(),
    withResolver: true,
  });
  const [draftExportError, setDraftExportError] = useState<string | null>(null);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const exportCachedDrafts = async () => {
    if (!user) return;
    try {
      const entries = await recordsForIdentity(cacheIdentity(user));
      let count = 0;
      for (const { value } of entries) {
        if (isStandardDraft(value)) {
          downloadLocalDraft(value);
          count += 1;
        } else if (
          isCollaborationCheckpoint(value) &&
          value.content &&
          value.pendingUpdates.length
        ) {
          downloadLocalDraft({ ...value, content: value.content });
          count += 1;
        }
      }
      setAuthFeedback(count ? `已导出 ${count} 份本机草稿。` : '没有可导出的本机草稿。');
    } catch {
      setAuthError('无法读取本机草稿，请导出当前编辑器中的内容。');
    }
  };

  useEffect(() => {
    try {
      window.localStorage.setItem('zhishu.sidebar-expanded', String(sidebarExpanded));
    } catch {
      // The workspace remains usable when browser storage is unavailable.
    }
  }, [sidebarExpanded]);

  useEffect(() => {
    try {
      window.localStorage.setItem('zhishu.theme', themeMode);
    } catch {
      // The selected theme still applies for the current page session.
    }
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const applyTheme = () => {
      const isDark = themeMode === 'dark' || (themeMode === 'system' && media.matches);
      document.documentElement.classList.toggle('dark', isDark);
      document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
    };
    applyTheme();
    if (themeMode !== 'system') return;
    media.addEventListener('change', applyTheme);
    return () => media.removeEventListener('change', applyTheme);
  }, [themeMode]);

  useEffect(() => {
    const cleanup = initializeOfflineState();
    let active = true;
    if (!getAccessToken()) {
      if (!navigator.onLine)
        void readOfflineAccount().then(async (account) => {
          if (!active || !account) return;
          await rememberAccount(account, false);
          if (active) setUser(account);
        });
      return () => {
        active = false;
        cleanup();
      };
    }
    void getCurrentUser()
      .then((principal) => {
        if (active) {
          void rememberAccount(principal, true);
          setUser(principal);
        }
      })
      .catch(() => {
        setAccessToken(undefined);
      });
    return () => {
      active = false;
      cleanup();
    };
  }, []);

  const signIn = async () => {
    setAuthBusyAction('login');
    setAuthError(null);
    setAuthFeedback(null);
    try {
      const session = await mockLogin();
      if (user && cacheIdentity(user) !== cacheIdentity(session.user)) queryClient.clear();
      await rememberAccount(session.user, true);
      setAccessToken(session.accessToken);
      setUser(session.user);
      setAuthFeedback(`已登录：${session.user.displayName}`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['documents'] }),
        queryClient.invalidateQueries({ queryKey: ['document'] }),
        queryClient.invalidateQueries({ queryKey: ['knowledge-workspaces'] }),
        queryClient.invalidateQueries({ queryKey: ['knowledge-tree'] }),
        queryClient.invalidateQueries({ queryKey: ['knowledge-search'] }),
      ]);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : '登录失败，请稍后重试。');
    } finally {
      setAuthBusyAction(null);
    }
  };

  const completeSignOut = async () => {
    setConfirmingSignOut(false);
    setAuthBusyAction('logout');
    setAuthError(null);
    setAuthFeedback(null);
    let logoutFailed = false;
    try {
      await mockLogout();
    } catch {
      // Local credentials and cached documents must be cleared even if the API is unavailable.
      logoutFailed = true;
    } finally {
      setAccessToken(undefined);
      await clearOfflineAccount(user ? cacheIdentity(user) : undefined);
      setUser(null);
      queryClient.clear();
      setAuthFeedback(logoutFailed ? '本地会话已清除，服务端退出确认暂不可用。' : '已退出登录。');
      setAuthBusyAction(null);
    }
  };

  const signOut = async () => {
    if (hasUnconfirmedChanges()) {
      setDraftExportError(null);
      setConfirmingSignOut(true);
      return;
    }
    await completeSignOut();
  };

  const exportDraftAndLeave = () => {
    if (downloadUnconfirmedDrafts() === 0) {
      setDraftExportError('当前未能读取可导出的草稿，请继续编辑或选择放弃后离开。');
      return;
    }
    setDraftExportError(null);
    blocker.proceed?.();
    if (confirmingSignOut) void completeSignOut();
  };

  const leaveWithoutSaving = async () => {
    try {
      await discardUnconfirmedChanges();
    } catch {
      setDraftExportError('未能清理本机草稿，请重试或先导出草稿。');
      return;
    }
    blocker.proceed?.();
    if (confirmingSignOut) void completeSignOut();
  };

  return (
    <KnowledgeWorkspaceProvider user={user}>
      <div className="flex h-dvh min-h-[100dvh] overflow-hidden bg-background text-foreground">
        <a href="#main-content" className="sr-only z-50 bg-card p-4 focus:not-sr-only focus:fixed">
          跳转到主要内容
        </a>
        <aside
          aria-label="桌面导航"
          className={`hidden shrink-0 border-r border-border/70 bg-card lg:flex ${sidebarExpanded ? 'w-72' : 'w-14'} transition-[width] duration-150 motion-reduce:transition-none`}
        >
          <WorkspaceNavigation
            collapsed={!sidebarExpanded}
            onToggleCollapsed={() => setSidebarExpanded((expanded) => !expanded)}
          />
        </aside>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!shell.editing && (
            <header className="z-20 flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-border/70 bg-card/90 px-3 backdrop-blur sm:min-h-16 sm:px-5">
              <div className="flex min-w-0 items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon"
                  className="lg:hidden"
                  aria-label="打开导航"
                  aria-expanded={mobileNavOpen}
                  onClick={() => setMobileNavOpen(true)}
                >
                  <Menu aria-hidden="true" />
                </Button>
                <div className="flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
                  <span>知书</span>
                  <span aria-hidden="true">/</span>
                  <span className="truncate font-medium text-foreground">{shell.section}</span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <GlobalSearch />
                <label className="sr-only" htmlFor="theme-mode">
                  界面主题
                </label>
                <Select
                  value={themeMode}
                  onValueChange={(value) => {
                    if (value) setThemeMode(value);
                  }}
                  items={{ system: '跟随系统', light: '亮色', dark: '暗色' }}
                >
                  <SelectTrigger
                    id="theme-mode"
                    aria-label="界面主题"
                    className="h-9 min-w-24 text-xs"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="system">跟随系统</SelectItem>
                    <SelectItem value="light">亮色</SelectItem>
                    <SelectItem value="dark">暗色</SelectItem>
                  </SelectContent>
                </Select>
                {user ? (
                  <>
                    <span className="hidden items-center gap-2 text-sm sm:flex">
                      <CircleUserRound size={17} className="text-primary" aria-hidden="true" />
                      {user.displayName}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void signOut()}
                      disabled={authBusyAction !== null}
                      aria-label={authBusyAction === 'logout' ? '正在退出登录' : '退出登录'}
                    >
                      <LogOut aria-hidden="true" />
                      <span className="hidden sm:inline">
                        {authBusyAction === 'logout' ? '正在退出…' : '退出'}
                      </span>
                    </Button>
                  </>
                ) : import.meta.env.DEV ? (
                  <Button
                    size="sm"
                    onClick={() => void signIn()}
                    disabled={authBusyAction !== null}
                  >
                    <LogIn aria-hidden="true" />
                    {authBusyAction === 'login' ? '正在连接…' : '开发环境登录'}
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">请通过宿主完成身份认证</span>
                )}
              </div>
            </header>
          )}
          {user && (!offline.online || !offline.verified || offline.cached) && (
            <div
              role="status"
              className="flex flex-wrap items-center gap-3 border-b bg-muted px-5 py-2 text-sm sm:px-9 lg:px-12"
            >
              <span className="relative flex size-2.5 shrink-0" aria-hidden="true">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warning opacity-60" />
                <span className="relative inline-flex size-2.5 rounded-full bg-warning" />
              </span>
              <span>
                {offline.online
                  ? offline.verified
                    ? '服务暂不可用，当前显示本机缓存；提交修改前会重新核对服务端版本。'
                    : '请重新登录后同步本机草稿。'
                  : '当前离线，仅能访问本机已缓存内容；修改尚未提交到服务端。'}
              </span>
              {offline.online && !offline.verified && import.meta.env.DEV && (
                <Button size="sm" onClick={() => void signIn()} disabled={authBusyAction !== null}>
                  重新登录并校验权限
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => void exportCachedDrafts()}>
                导出全部本机草稿
              </Button>
            </div>
          )}
          {offline.storageError && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-3 border-b px-5 py-2 text-sm text-destructive"
            >
              <span>本机缓存不可用或空间不足，请及时导出未保存草稿。</span>
              <Button size="sm" variant="outline" onClick={downloadUnconfirmedDrafts}>
                导出当前草稿
              </Button>
            </div>
          )}
          {offline.shellError && (
            <p role="alert" className="border-b px-5 py-2 text-sm text-destructive">
              离线页面缓存安装失败，断网后刷新可能无法打开页面；请及时导出未保存草稿。
            </p>
          )}
          {authError ? (
            <p
              role="alert"
              className="border-b border-destructive/20 bg-destructive/5 px-5 py-2 text-sm text-destructive sm:px-9 lg:px-12"
            >
              {authError}
            </p>
          ) : authFeedback ? (
            <p
              role="status"
              className="border-b border-success/20 bg-success/5 px-5 py-2 text-sm text-success sm:px-9 lg:px-12"
            >
              {authFeedback}
            </p>
          ) : null}
          {shell.fullBleed ? (
            <main id="main-content" className="min-h-0 flex-1 overflow-hidden">
              <Outlet />
            </main>
          ) : (
            <main id="main-content" className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
              <div className="mx-auto w-full max-w-[1600px] p-3 sm:p-5 lg:p-6">
                <Outlet />
              </div>
            </main>
          )}
        </div>
      </div>
      <Dialog open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <DialogContent
          showCloseButton={false}
          aria-label="主导航"
          className="fixed inset-y-0 left-0 z-50 m-0 h-dvh w-[min(18rem,calc(100vw-2rem))] max-w-none translate-x-0 translate-y-0 grid-rows-[auto_1fr] gap-0 overflow-hidden rounded-none border-r p-0 sm:max-w-none"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>主导航</DialogTitle>
          </DialogHeader>
          <WorkspaceNavigation mobile onNavigate={() => setMobileNavOpen(false)} />
        </DialogContent>
      </Dialog>
      <Dialog
        open={blocker.status === 'blocked' || confirmingSignOut}
        onOpenChange={(open) => {
          if (!open) {
            setDraftExportError(null);
            if (blocker.status === 'blocked') blocker.reset?.();
            setConfirmingSignOut(false);
          }
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>离开前处理未确认修改</DialogTitle>
            <DialogDescription>
              当前正文尚未全部保存。可以下载知书 JSON
              草稿后离开，或放弃本地修改；草稿不包含图片文件。
            </DialogDescription>
          </DialogHeader>
          {draftExportError && (
            <p role="alert" className="text-sm text-destructive">
              {draftExportError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setConfirmingSignOut(false);
                blocker.reset?.();
              }}
            >
              继续编辑
            </Button>
            <Button variant="destructive" onClick={leaveWithoutSaving}>
              {confirmingSignOut ? '放弃修改并退出' : '放弃修改并离开'}
            </Button>
            <Button onClick={exportDraftAndLeave}>
              <Download aria-hidden="true" />
              {confirmingSignOut ? '导出草稿并退出' : '导出草稿并离开'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </KnowledgeWorkspaceProvider>
  );
}
