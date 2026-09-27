import { useEffect, useState } from 'react';
import { Link, Outlet } from '@tanstack/react-router';
import { BookOpen, CircleUserRound, LogIn, LogOut } from 'lucide-react';
import { getCurrentUser, mockLogin, mockLogout } from '@/api/generated/app-api';
import type { MockLogin200User } from '@/api/generated/models';
import { getAccessToken, hasUnconfirmedChanges, setAccessToken } from '@/api/transport';
import { Button } from '@/components/ui/button';
import { useQueryClient } from '@tanstack/react-query';

export function AppShell() {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<MockLogin200User | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

  useEffect(() => {
    if (!getAccessToken()) return;
    let active = true;
    void getCurrentUser()
      .then((principal) => {
        if (active) setUser(principal);
      })
      .catch(() => {
        setAccessToken(undefined);
      });
    return () => {
      active = false;
    };
  }, []);

  const signIn = async () => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      const session = await mockLogin();
      setAccessToken(session.accessToken);
      setUser(session.user);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['documents'] }),
        queryClient.invalidateQueries({ queryKey: ['document'] }),
      ]);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : '登录失败，请稍后重试。');
    } finally {
      setAuthBusy(false);
    }
  };

  const signOut = async () => {
    if (
      hasUnconfirmedChanges() &&
      !window.confirm('正文仍有未确认的协同修改。退出会断开会话并丢弃本地待确认修改，仍要退出吗？')
    ) {
      return;
    }
    setAuthBusy(true);
    try {
      await mockLogout();
    } catch {
      // Local credentials and cached documents must be cleared even if the API is unavailable.
    } finally {
      setAccessToken(undefined);
      setUser(null);
      queryClient.clear();
      setAuthBusy(false);
    }
  };

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[244px_minmax(0,1fr)]">
      <a href="#main-content" className="sr-only z-50 bg-card p-4 focus:not-sr-only focus:fixed">
        跳转到主要内容
      </a>
      <aside className="flex flex-col border-b bg-[#203d34] text-white lg:fixed lg:inset-y-0 lg:w-[244px] lg:border-b-0">
        <div className="flex items-center gap-3 px-5 py-5 lg:px-7 lg:py-8">
          <span className="flex size-10 items-center justify-center rounded-xl bg-[#d5e9bd] text-[#203d34]">
            <BookOpen size={21} aria-hidden="true" />
          </span>
          <div>
            <Link
              to="/documents"
              search={{ view: 'recent', sort: 'recent', direction: 'desc', limit: 20, offset: 0 }}
              className="text-xl font-semibold tracking-tight"
            >
              知书
            </Link>
            <p className="mt-0.5 text-xs text-white/65">文档工作台</p>
          </div>
        </div>
        <nav aria-label="主导航" className="px-4 pb-4 lg:mt-5">
          <p className="mb-3 hidden px-3 text-[10px] font-semibold tracking-[0.18em] text-white/50 lg:block">
            WORKSPACE
          </p>
          <Link
            to="/documents"
            search={{ view: 'recent', sort: 'recent', direction: 'desc', limit: 20, offset: 0 }}
            activeOptions={{ exact: false }}
            className="flex items-center gap-3 rounded-lg bg-white/10 px-4 py-3 text-sm font-medium text-white outline-none focus-visible:ring-2 focus-visible:ring-white/80"
            activeProps={{ className: 'bg-white/15' }}
          >
            <BookOpen size={18} aria-hidden="true" />
            <span>文档</span>
          </Link>
        </nav>
        <div className="mt-auto hidden px-7 py-7 lg:block">
          <div className="border-t border-white/15 pt-5 text-xs leading-6 text-white/65">
            <span className="block font-medium text-white">让想法有处安放。</span>
            写下、整理，再和团队一起完善。
          </div>
        </div>
      </aside>
      <div className="min-w-0 lg:col-start-2">
        <header className="flex min-h-[72px] items-center justify-between gap-4 border-b bg-card/85 px-5 py-3 sm:px-9 lg:px-12">
          <div className="flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
            <span>工作空间</span>
            <span aria-hidden="true">/</span>
            <span className="truncate font-medium text-foreground">文档</span>
          </div>
          <div className="flex items-center gap-3">
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
                  disabled={authBusy}
                  aria-label="退出登录"
                >
                  <LogOut aria-hidden="true" />
                  <span className="hidden sm:inline">退出</span>
                </Button>
              </>
            ) : import.meta.env.DEV ? (
              <Button size="sm" onClick={() => void signIn()} disabled={authBusy}>
                <LogIn aria-hidden="true" />
                {authBusy ? '正在连接…' : '开发环境登录'}
              </Button>
            ) : (
              <span className="text-xs text-muted-foreground">请通过宿主完成身份认证</span>
            )}
          </div>
        </header>
        {authError && (
          <p
            role="alert"
            className="border-b border-destructive/20 bg-destructive/5 px-5 py-2 text-sm text-destructive sm:px-9 lg:px-12"
          >
            {authError}
          </p>
        )}
        <main
          id="main-content"
          className="mx-auto max-w-[1440px] px-5 py-8 sm:px-9 lg:px-12 lg:py-12"
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
