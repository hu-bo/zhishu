import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import type { CitationPresentation } from './citation-model';
import './chat.css';

/** Inline citation markers ([1], [2]) rendered next to the text they support. */
export function CitationText({
  text,
  citations,
}: {
  text: string;
  citations: readonly CitationPresentation[];
}): ReactNode {
  const nodes: ReactNode[] = [];
  let rest = text;
  const used = new Map(citations.map((citation) => [citation.citation.quote, citation]));
  let guard = 0;
  while (rest && guard++ < 200) {
    let best: { index: number; length: number; citation: CitationPresentation } | undefined;
    for (const [quote, citation] of used) {
      const index = rest.indexOf(quote);
      if (index >= 0 && (!best || index < best.index))
        best = { index, length: quote.length, citation };
    }
    if (!best) break;
    nodes.push(rest.slice(0, best.index + best.length));
    nodes.push(
      <CitationMark
        key={`${best.citation.citation.citationId}-${guard}`}
        citation={best.citation}
      />,
    );
    used.delete(best.citation.citation.quote);
    rest = rest.slice(best.index + best.length);
  }
  nodes.push(rest);
  return <>{nodes}</>;
}

export function CitationMark({ citation }: { citation: CitationPresentation }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-block">
      <button
        type="button"
        className="citation-mark"
        aria-label={`来源 ${citation.ordinal}：${citation.title}`}
        onClick={() => setOpen((value) => !value)}
      >
        [{citation.ordinal}]
      </button>
      {open && (
        <span className="citation-popover" role="dialog" aria-label="引用来源">
          <CitationBody citation={citation} />
          <button type="button" onClick={() => setOpen(false)}>
            关闭
          </button>
        </span>
      )}
    </span>
  );
}

export function CitationBody({ citation }: { citation: CitationPresentation }) {
  return (
    <span className="citation-body">
      <span className="citation-kind">{citation.kind === 'web' ? '网页来源' : '平台文档'}</span>
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
      {citation.workspaceLabel ? (
        <span className="citation-meta">{citation.workspaceLabel}</span>
      ) : null}
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
      <blockquote className="citation-quote">{citation.excerpt}</blockquote>
    </span>
  );
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Source list panel: only the sources actually cited by an answer. */
export function CitationList({ citations }: { citations: readonly CitationPresentation[] }) {
  if (!citations.length) return null;
  return (
    <ol className="citation-list" aria-label="引用来源">
      {citations.map((citation) => (
        <li key={citation.citation.citationId}>
          <span className="citation-ordinal">[{citation.ordinal}]</span>
          <CitationBody citation={citation} />
        </li>
      ))}
    </ol>
  );
}
