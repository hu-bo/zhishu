import { Link, Outlet } from '@tanstack/react-router';
import { ArrowUpRight, FolderOpen, Workflow } from 'lucide-react';

export function AppShell() {
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[244px_minmax(0,1fr)]">
      <a href="#main-content" className="sr-only z-50 bg-card p-4 focus:not-sr-only focus:fixed">
        跳转到主要内容
      </a>
      <aside className="flex flex-col bg-[#182b27] text-[#e8efe9] lg:fixed lg:inset-y-0 lg:w-[244px]">
        <div className="flex items-center justify-between gap-5 p-5 lg:block lg:px-7 lg:py-9">
          <Link
            to="/workflows"
            search={{ limit: 20, offset: 0 }}
            className="flex items-center gap-3 rounded-md focus-visible:outline-2 focus-visible:outline-white"
          >
            <span className="flex size-10 items-center justify-center rounded-xl bg-[#cfe8a7] text-[#20332e]">
              <Workflow size={23} />
            </span>
            <span className="text-xl font-semibold tracking-tight">
              nova<span className="ml-1 font-normal text-[#9fac9f]">/ flow</span>
            </span>
          </Link>
          <span className="text-xs text-[#aebfb5] lg:mt-4 lg:block lg:pl-[52px]">
            你的工作流空间
          </span>
        </div>
        <nav aria-label="主导航" className="px-4 pb-4 lg:mt-6">
          <p className="mb-3 hidden px-3 text-[10px] font-semibold tracking-[0.18em] text-[#92a89b] lg:block">
            WORKSPACE
          </p>
          <Link
            to="/workflows"
            search={{ limit: 20, offset: 0 }}
            className="flex items-center gap-3 rounded-lg bg-white/10 px-4 py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-white"
          >
            <FolderOpen size={18} />
            <span>工作流</span>
            <ArrowUpRight className="ml-auto text-[#b9d59d]" size={16} />
          </Link>
        </nav>
        <div className="mt-auto hidden px-7 py-7 lg:block">
          <div className="border-t border-white/15 pt-5 text-xs leading-6 text-[#aebfb5]">
            <span className="block font-medium text-[#e8efe9]">从一个好想法开始。</span>
            为每个流程，留一个清晰的起点。
          </div>
        </div>
      </aside>
      <div className="min-w-0 lg:col-start-2">
        <header className="flex h-[76px] items-center justify-between border-b bg-card/75 px-5 sm:px-9 lg:px-12">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>Workspace</span>
            <span aria-hidden="true">/</span>
            <span className="font-medium text-foreground">Workflows</span>
          </div>
          <span className="rounded-full border px-3 py-1 text-[11px] tracking-wide text-muted-foreground">
            NOVA WORKFLOW
          </span>
        </header>
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
