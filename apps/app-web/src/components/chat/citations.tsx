import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from '@tanstack/react-router';
import { renderAnswerHtml } from './answer-markdown';
import { MarkdownBlock } from './markdown-block';
import type { CitationPresentation } from './citation-model';
import './chat.css';

interface CitationPopover {
  ordinal: number;
  presentation: CitationPresentation;
  below: boolean;
  x: number;
  y: number;
}

/**
 * The whole answer is one Markdown block; the citation marks it contains are plain
 * HTML buttons (see answer-markdown), so a single delegated click handler maps a mark
 * back to its presentation and shows the popover in a body portal.
 */
export function CitationMarkdown({
  text,
  citations,
  className,
}: {
  text: string;
  citations: readonly CitationPresentation[];
  className?: string;
}): ReactNode {
  const [popover, setPopover] = useState<CitationPopover | null>(null);
  const html = useMemo(() => renderAnswerHtml(text, citations), [text, citations]);
  useDismissPopover(popover, setPopover);
  return (
    <>
      <div
        className={className ? `chat-markdown ${className}` : 'chat-markdown'}
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={(event) => {
          const mark =
            event.target instanceof HTMLElement
              ? event.target.closest<HTMLElement>('button[data-citation-ordinal]')
              : null;
          if (!mark) return;
          const ordinal = Number(mark.dataset.citationOrdinal);
          if (popover?.ordinal === ordinal) {
            setPopover(null);
            return;
          }
          const presentation = citations.find((citation) => citation.ordinal === ordinal);
          if (!presentation) return;
          const rect = mark.getBoundingClientRect();
          // Keep the fixed popover inside the viewport; flip below when there is no room above.
          const width = Math.min(22 * 16, window.innerWidth * 0.8);
          const below = rect.top < 220;
          setPopover({
            ordinal,
            presentation,
            below,
            x: Math.min(
              Math.max(rect.left + rect.width / 2, width / 2 + 8),
              window.innerWidth - width / 2 - 8,
            ),
            y: below ? rect.bottom + 6 : rect.top - 6,
          });
        }}
      />
      {popover &&
        createPortal(
          <div
            className={`citation-popover${popover.below ? ' citation-popover--below' : ''}`}
            role="dialog"
            aria-label="引用来源"
            style={{ left: popover.x, top: popover.y }}
          >
            <CitationBody citation={popover.presentation} />
            <button type="button" onClick={() => setPopover(null)}>
              关闭
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}

/** Outside clicks, Escape, scroll and resize all retire the popover: it can no longer point at its mark. */
function useDismissPopover(popover: CitationPopover | null, close: (value: null) => void): void {
  useEffect(() => {
    if (!popover) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('.citation-popover, button[data-citation-ordinal]')) return;
      close(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close(null);
    };
    const retire = () => close(null);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', retire, true);
    window.addEventListener('resize', retire);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', retire, true);
      window.removeEventListener('resize', retire);
    };
  }, [popover, close]);
}

/** Which space or site a source belongs to, shown at the end of the article title. */
function sourceSuffix(citation: CitationPresentation): string | null {
  return citation.kind === 'document'
    ? (citation.workspaceLabel ?? null)
    : (citation.siteName ?? null);
}

export function CitationBody({ citation }: { citation: CitationPresentation }) {
  const suffix = sourceSuffix(citation);
  return (
    <div className="citation-body">
      <span className="citation-kind">{citation.kind === 'web' ? '网页来源' : '平台文档'}</span>
      <span className="citation-title-row">
        {citation.kind === 'document' && citation.documentId ? (
          <Link
            className="citation-title"
            to="/documents/$documentId"
            params={{ documentId: citation.documentId }}
            search={citation.blockId ? { block: citation.blockId } : {}}
          >
            {citation.title}
          </Link>
        ) : (
          <span className="citation-title">{citation.title}</span>
        )}
        {suffix ? <span className="citation-space">· {suffix}</span> : null}
      </span>
      {citation.url ? (
        <a
          className="citation-meta citation-url"
          href={citation.url}
          target="_blank"
          rel="noreferrer noopener"
        >
          {safeHostname(citation.url)}
        </a>
      ) : null}
      {citation.kind === 'web' ? (
        <span className="citation-meta">
          {citation.contentKind === 'extracted' ? '已读取正文摘录' : '搜索摘要（未读取全文）'}
          {citation.publishedAt ? ` · 发布于 ${citation.publishedAt.slice(0, 10)}` : ''}
          {citation.retrievedAt
            ? ` · 检索于 ${new Date(citation.retrievedAt).toLocaleString()}`
            : ''}
        </span>
      ) : null}
      <MarkdownBlock className="citation-quote" text={citation.excerpt} />
    </div>
  );
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Source footer for one answer: collapsed to a single "以上内容来源于《文章》· 空间" line,
 * with the concrete paragraphs only visible once the reader expands it.
 */
export function CitationSources({
  citations,
}: {
  citations: readonly CitationPresentation[];
}): ReactNode {
  if (!citations.length) return null;
  const articles = new Map<string, CitationPresentation>();
  for (const citation of citations) {
    const key =
      citation.kind === 'document'
        ? `doc:${citation.documentId || citation.title}`
        : `web:${citation.url || citation.title}`;
    if (!articles.has(key)) articles.set(key, citation);
  }
  return (
    <details className="citation-sources">
      <summary>
        <span className="citation-sources__label">以上内容来源于</span>
        <span className="citation-sources__titles">
          {[...articles.values()].map((citation, index) => {
            const suffix = sourceSuffix(citation);
            return (
              <Fragment
                key={`${citation.kind}:${citation.documentId ?? citation.url ?? citation.title}`}
              >
                {index > 0 ? '、' : null}《{citation.title}》
                {suffix ? <span className="citation-space">· {suffix}</span> : null}
              </Fragment>
            );
          })}
        </span>
      </summary>
      <ol className="citation-list">
        {citations.map((citation) => (
          <li key={citation.citation.citationId}>
            <span className="citation-ordinal">[{citation.ordinal}]</span>
            <CitationBody citation={citation} />
          </li>
        ))}
      </ol>
    </details>
  );
}
