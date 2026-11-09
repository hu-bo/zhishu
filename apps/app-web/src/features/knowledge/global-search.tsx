import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { searchKnowledgeDocuments } from '@/api/generated/knowledge';
import { errorMessage } from '@/api/api-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useKnowledgeWorkspace } from './workspace-context';

function highlightMatch(value: string, query: string): ReactNode {
  if (!query) return value;
  const pieces: ReactNode[] = [];
  const normalized = value.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  let offset = 0;
  let index = normalized.indexOf(needle);
  while (index >= 0) {
    pieces.push(value.slice(offset, index));
    pieces.push(
      <mark key={index} className="rounded bg-primary/15 text-inherit">
        {value.slice(index, index + query.length)}
      </mark>,
    );
    offset = index + query.length;
    index = normalized.indexOf(needle, offset);
  }
  pieces.push(value.slice(offset));
  return pieces;
}

export function GlobalSearch() {
  const { identityKey, enabled } = useKnowledgeWorkspace();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [queryText, setQueryText] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnRef = useRef<HTMLElement | null>(null);
  const resultId = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const show = () => {
    returnRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelected(0);
    setOpen(true);
  };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        !enabled ||
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== 'k'
      )
        return;
      // Active dialogs own their shortcuts; an editor selection reserves Ctrl/Cmd+K for links.
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[role="dialog"]')) return;
      const editor = target?.closest('[contenteditable="true"]');
      if (editor && !window.getSelection()?.isCollapsed) return;
      event.preventDefault();
      returnRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setSelected(0);
      setOpen(true);
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [enabled]);
  useEffect(() => {
    const timer = window.setTimeout(() => setQueryText(input.trim()), 180);
    return () => window.clearTimeout(timer);
  }, [input]);
  const results = useQuery({
    queryKey: ['knowledge-search', identityKey, queryText],
    queryFn: ({ signal }) => searchKnowledgeDocuments({ q: queryText }, { signal }),
    enabled: open && enabled && queryText.length > 0,
    staleTime: 0,
  });
  const current = input.trim() === queryText;
  const items = current ? (results.data?.items ?? []) : [];
  const activeIndex = Math.min(selected, Math.max(0, items.length - 1));
  const go = async (index: number) => {
    const item = items[index];
    if (!item) return;
    setOpen(false);
    await navigate({
      to: '/spaces/$workspaceId/doc/$documentId',
      params: { workspaceId: item.workspaceId, documentId: item.id },
    });
  };
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${resultId}-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open, resultId]);

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="gap-2 border border-border/70 bg-background px-2.5 text-muted-foreground sm:w-56 sm:justify-start"
        aria-label="搜索知识库（Ctrl 或 Cmd + K）"
        disabled={!enabled}
        onClick={show}
      >
        <Search aria-hidden="true" />
        <span className="hidden sm:inline">搜索文档与知识…</span>
        <kbd className="ml-auto hidden rounded border border-border bg-card px-1.5 py-0.5 font-sans text-[10px] text-muted-foreground sm:inline">
          {typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
            ? '⌘'
            : 'Ctrl'}{' '}
          K
        </kbd>
      </Button>
      <Dialog
        open={open && enabled}
        onOpenChange={(next) => {
          if (!next)
            void queryClient.cancelQueries({ queryKey: ['knowledge-search', identityKey] });
          setOpen(next);
        }}
        initialFocus={inputRef}
        finalFocus={returnRef}
      >
        <DialogContent className="max-h-[85dvh] sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>搜索知识库</DialogTitle>
            <DialogDescription>在你的知识空间中，找到需要的内容。</DialogDescription>
          </DialogHeader>
          <Input
            ref={inputRef}
            autoFocus
            placeholder="输入标题或正文关键词…"
            className="h-12 bg-background text-base"
            aria-label="搜索标题与正文"
            role="combobox"
            aria-expanded={items.length > 0}
            aria-controls={resultId}
            aria-autocomplete="list"
            aria-activedescendant={items.length ? `${resultId}-${activeIndex}` : undefined}
            maxLength={200}
            value={input}
            onChange={(event) => {
              void queryClient.cancelQueries({ queryKey: ['knowledge-search', identityKey] });
              setInput(event.target.value);
              setSelected(0);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setSelected((index) =>
                  items.length
                    ? (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
                    : 0,
                );
              }
              if (event.key === 'Enter' && items.length) {
                event.preventDefault();
                void go(activeIndex);
              }
            }}
          />
          <div className="min-h-20 max-h-[50dvh] overflow-y-auto">
            {!input.trim() ? (
              <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-muted-foreground">
                <Search size={24} strokeWidth={1.5} aria-hidden="true" />
                <p className="text-[13px]">从一个关键词开始，找回你的灵感。</p>
              </div>
            ) : !current || results.isFetching ? (
              <p role="status" className="p-4 text-sm text-muted-foreground">
                正在搜索…
              </p>
            ) : results.isError ? (
              <div role="alert" className="p-4">
                <p>{errorMessage(results.error)}</p>
                <Button variant="outline" onClick={() => void results.refetch()}>
                  重试搜索
                </Button>
              </div>
            ) : !items.length ? (
              <p role="status" className="py-12 text-center text-[13px] text-muted-foreground">
                没有找到相关文档，试试其他关键词。
              </p>
            ) : null}
            <ul id={resultId} role="listbox" aria-label="搜索结果" className="space-y-1">
              {items.map((item, index) => (
                <li
                  key={item.id}
                  id={`${resultId}-${index}`}
                  role="option"
                  className="zhishu-search-result overflow-hidden rounded-xl transition-colors"
                  aria-selected={index === activeIndex}
                  onMouseMove={() => setSelected(index)}
                >
                  <button
                    type="button"
                    tabIndex={-1}
                    className="w-full px-4 py-3.5 text-left text-foreground hover:bg-secondary/60"
                    onClick={() => void go(index)}
                  >
                    <span className="block truncate font-medium">
                      {item.icon || '📄'} {highlightMatch(item.title, queryText)}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {[item.workspaceName, ...item.path].join(' / ')} ·{' '}
                      {item.match === 'title' ? '标题匹配' : '正文匹配'}
                    </span>
                    <span className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">
                      {highlightMatch(item.excerpt, queryText)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <p className="border-t border-border/70 pt-4 text-[11px] text-muted-foreground">
            ↑ ↓ 选择 · Enter 打开 · Escape 关闭
            {results.data?.hasMore ? ' · 还有更多结果，请缩小关键词范围' : ''}
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
