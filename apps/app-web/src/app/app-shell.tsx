import { useEffect, useState } from 'react';
import { Link, Outlet, useBlocker, useRouterState } from '@tanstack/react-router';
import {
  Check,
  ChevronDown,
  CircleUserRound,
  Download,
  FolderKanban,
  Sparkles,
  Layers,
  LogIn,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Sun,
  Moon,
  Monitor,
  X,
} from 'lucide-react';
import { getCurrentUser, mockLogin, mockLogout, useListMockUsers } from '@/api/generated/app-api';
import type { MockLogin200User } from '@/api/generated/models';
import {
  Menu as MenuRoot,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
} from '@/components/ui/menu';
import { WORKSPACE_ROLE_LABELS } from '@/features/knowledge/workspace-roles';
import {
  exportableUnconfirmedDrafts,
  getAccessToken,
  hasUnconfirmedChanges,
  setAccessToken,
  discardUnconfirmedChanges,
} from '@/api/transport';
import { Button } from '@/components/ui/button';
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
import { isCollaborationCheckpoint, recordsForIdentity } from '@/features/offline/storage';
import { downloadLocalDraft } from '@/features/offline/draft-download';
import { useTheme } from '@/lib/theme';

const themeOptions = [
  { value: 'light', label: '浅色外观', icon: Sun },
  { value: 'dark', label: '深色外观', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor },
] as const;

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
      ? 'bg-primary/8 font-medium text-primary'
      : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
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
    <div className="zhishu-sidebar flex h-full min-h-0 w-full min-w-0 flex-col text-foreground">
      <div
        className={`flex min-h-20 items-center ${collapsed ? 'justify-center px-2' : 'gap-3 px-5'}`}
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-foreground text-base font-semibold text-background shadow-sm">
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
            <p className="mt-0.5 truncate text-[11px] tracking-wide text-muted-foreground">
              让知识生长
            </p>
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
      <nav
        aria-label="主导航"
        className={`flex flex-col gap-1 pt-1 ${collapsed ? 'px-2' : 'px-2 sm:px-3'}`}
      >
        <Link
          to="/documents"
          search={WORKBENCH_SEARCH}
          onClick={onNavigate}
          title={collapsed ? '文档工作台' : undefined}
          aria-current={pathname.startsWith('/documents') ? 'page' : undefined}
          className={navLinkClass(collapsed, pathname.startsWith('/documents'))}
        >
          <Layers size={17} aria-hidden="true" className="shrink-0" />
          {!collapsed && <span className="truncate">我的文档</span>}
        </Link>
        <Link
          to="/spaces"
          onClick={onNavigate}
          title={collapsed ? '空间与目录' : undefined}
          aria-current={pathname.startsWith('/spaces') ? 'page' : undefined}
          className={navLinkClass(collapsed, pathname.startsWith('/spaces'))}
        >
          <FolderKanban size={17} aria-hidden="true" className="shrink-0" />
          {!collapsed && <span className="truncate">知识空间</span>}
        </Link>
      </nav>
      <nav aria-label="创作导航" className={`mt-1 ${collapsed ? 'px-2' : 'px-2 sm:px-3'}`}>
        <Link
          to="/ai"
          search={{}}
          onClick={onNavigate}
          title={collapsed ? 'AI 创作' : undefined}
          aria-current={pathname === '/ai' ? 'page' : undefined}
          className={navLinkClass(collapsed, pathname === '/ai')}
        >
          <Sparkles size={17} aria-hidden="true" className="shrink-0" />
          {!collapsed && <span>AI 创作</span>}
        </Link>
      </nav>
      {!collapsed && workspaces.length > 0 && (
        <div className="mt-8 flex min-h-0 flex-1 flex-col px-3 sm:px-4">
          <p className="px-2 pb-1.5 text-xs font-medium tracking-wide text-muted-foreground">
            我的空间
          </p>
          <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1 pb-2">
            {workspaces.map((workspace) => {
              const active =
                pathname === `/spaces/${workspace.id}` ||
                pathname.startsWith(`/spaces/${workspace.id}/`);
              return (
                <Link
                  key={workspace.id}
                  to="/spaces/$workspaceId"
                  params={{ workspaceId: workspace.id }}
                  onClick={onNavigate}
                  aria-current={active ? 'page' : undefined}
                  className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm transition-colors duration-150 ${
                    active
                      ? 'bg-secondary font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
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
        <div className="mx-5 mb-4 border-t border-border/70 pt-4 text-[11px] leading-6 text-muted-foreground">
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

// Dev-only identity switcher: lists the server's mock users so permissions can
// be exercised across roles (admin / editor / viewer / non-member).
function MockUserSwitcher({
  user,
  busy,
  onLogin,
  onSignOut,
}: {
  user: MockLogin200User;
  busy: boolean;
  onLogin: (userId: string) => void;
  onSignOut: () => void;
}) {
  const { data, isPending, isError } = useListMockUsers({
    query: { staleTime: Infinity, retry: false },
  });
  const mockUsers = data?.users ?? [];

  // Without the user list (server unreachable) fall back to the compact
  // identity + sign-out pair so leaving stays possible.
  if (isError) {
    return (
      <>
        <span className="hidden items-center gap-2 text-sm sm:flex">
          <CircleUserRound size={17} className="text-primary" aria-hidden="true" />
          {user.displayName}
        </span>
        <Button variant="ghost" size="sm" onClick={onSignOut} disabled={busy} aria-label="退出登录">
          <LogOut aria-hidden="true" />
          <span className="hidden sm:inline">退出</span>
        </Button>
      </>
    );
  }

  return (
    <MenuRoot>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            disabled={busy || isPending}
            aria-label={busy ? '正在切换身份' : '切换 Mock 用户'}
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
              {user.displayName.slice(0, 1)}
            </span>
            <span className="hidden max-w-28 truncate text-sm sm:inline">{user.displayName}</span>
            <ChevronDown size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
          </Button>
        }
      />
      <MenuContent align="end" className="w-60">
        <MenuLabel>切换 Mock 用户（调试身份）</MenuLabel>
        {mockUsers.map((mockUser) => {
          const current = mockUser.identityId === user.identityId;
          return (
            <MenuItem key={mockUser.identityId} onClick={() => onLogin(mockUser.identityId)}>
              <span className="min-w-0 flex-1 truncate">{mockUser.displayName}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {mockUser.role ? WORKSPACE_ROLE_LABELS[mockUser.role] : '非成员'}
              </span>
              {current && <Check size={15} className="shrink-0 text-primary" aria-hidden="true" />}
            </MenuItem>
          );
        })}
        <MenuSeparator />
        <MenuItem variant="destructive" onClick={onSignOut}>
          <LogOut size={15} aria-hidden="true" />
          退出登录
        </MenuItem>
      </MenuContent>
    </MenuRoot>
  );
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
        section:
          pathname === '/ai'
            ? 'AI 创作'
            : pathname.startsWith('/spaces')
              ? '空间'
              : pathname.startsWith('/documents')
                ? '文档工作台'
                : '知书',
        fullBleed: inSpaceDetail || pathname === '/ai',
        editing:
          inSpaceDetail &&
          (/^\/spaces\/[^/]+\/doc\/[^/]+/.test(pathname) ||
            (typeof doc === 'string' && doc.length > 0)),
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
  const { theme: themeMode, setTheme: setThemeMode } = useTheme();

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
        if (isCollaborationCheckpoint(value) && value.content && value.pendingUpdates.length) {
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
    const cleanup = initializeOfflineState();
    let active = true;
    if (!getAccessToken()) {
      if (!navigator.onLine) {
        void readOfflineAccount().then(async (account) => {
          if (!active || !account) return;
          await rememberAccount(account, false);
          if (active) setUser(account);
        });
      } else if (import.meta.env.DEV) {
        // Dev convenience: sign in as the default mock user without a button.
        void mockLogin({})
          .then(async (session) => {
            if (!active) return;
            await rememberAccount(session.user, true);
            setAccessToken(session.accessToken);
            if (active) setUser(session.user);
          })
          .catch(() => {
            if (active) setAuthError('开发环境自动登录失败，请确认后端服务已启动后再试。');
          });
      }
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

  const signIn = async (userId?: string) => {
    setAuthBusyAction('login');
    setAuthError(null);
    setAuthFeedback(null);
    try {
      const session = await mockLogin(userId ? { userId } : {});
      if (user && cacheIdentity(user) !== cacheIdentity(session.user)) queryClient.clear();
      await rememberAccount(session.user, true);
      setAccessToken(session.accessToken);
      setUser(session.user);
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
          className={`zhishu-sidebar hidden shrink-0 border-r border-border/70 lg:flex ${sidebarExpanded && !shell.fullBleed ? 'w-72' : 'w-14'} transition-[width] duration-150 motion-reduce:transition-none`}
        >
          <WorkspaceNavigation
            collapsed={!sidebarExpanded || shell.fullBleed}
            onToggleCollapsed={
              shell.fullBleed ? undefined : () => setSidebarExpanded((expanded) => !expanded)
            }
          />
        </aside>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {
            <header
              className={`z-20 flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-border/70 bg-card/90 px-3 backdrop-blur sm:min-h-16 sm:px-5 ${shell.editing && user ? 'lg:hidden' : ''}`}
            >
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
                  <span className="hidden sm:inline">知书</span>
                  <span aria-hidden="true" className="hidden sm:inline">
                    /
                  </span>
                  <span className="truncate font-medium text-foreground">{shell.section}</span>
                </div>
              </div>
              <div className="flex min-w-0 items-center gap-1.5 sm:gap-3">
                <GlobalSearch />
                <MenuRoot>
                  <MenuTrigger
                    render={
                      <Button variant="ghost" size="icon" aria-label="界面主题" title="切换外观">
                        {themeMode === 'dark' ? (
                          <Moon aria-hidden="true" />
                        ) : themeMode === 'light' ? (
                          <Sun aria-hidden="true" />
                        ) : (
                          <Monitor aria-hidden="true" />
                        )}
                      </Button>
                    }
                  />
                  <MenuContent align="end">
                    {themeOptions.map(({ value, label, icon: Icon }) => (
                      <MenuItem key={value} onClick={() => setThemeMode(value)}>
                        <Icon size={16} aria-hidden="true" />
                        <span className="flex-1">{label}</span>
                        {themeMode === value && (
                          <Check size={14} aria-hidden="true" className="text-primary" />
                        )}
                      </MenuItem>
                    ))}
                  </MenuContent>
                </MenuRoot>
                {import.meta.env.DEV ? (
                  user ? (
                    <MockUserSwitcher
                      user={user}
                      busy={authBusyAction !== null}
                      onLogin={(userId) => void signIn(userId)}
                      onSignOut={() => void signOut()}
                    />
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => void signIn()}
                      disabled={authBusyAction !== null}
                    >
                      <LogIn aria-hidden="true" />
                      {authBusyAction === 'login' ? '正在连接…' : '重新登录'}
                    </Button>
                  )
                ) : user ? (
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
                ) : (
                  <span className="text-xs text-muted-foreground">请通过宿主完成身份认证</span>
                )}
              </div>
            </header>
          }
          {user && (!offline.online || !offline.verified || offline.cached) && (
            <div
              role="status"
              className="flex flex-wrap items-center gap-3 border-b bg-secondary px-5 py-2 text-sm sm:px-9 lg:px-12"
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
              <div className="w-full px-4 py-4 sm:px-6 sm:py-5">
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
          className="fixed inset-y-0 left-0 z-50 m-0 h-dvh max-h-none w-[min(18rem,calc(100vw-2rem))] max-w-none translate-x-0 translate-y-0 grid-rows-[auto_1fr] gap-0 overflow-hidden rounded-none border-r p-0 sm:max-w-none"
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
