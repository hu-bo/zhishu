import { renderWritingMarkdown } from './markdown';

/**
 * Block-level Markdown component for chat content (streaming previews and citation
 * excerpts). markdown-it runs with `html: false`, so model-authored HTML is escaped and
 * unsafe link schemes are rejected at render time; only the markup the renderer above
 * produces reaches the DOM. Answers with inline citation marks use CitationMarkdown.
 */
export function MarkdownBlock({ text, className }: { text: string; className?: string }) {
  return (
    <div
      className={className ? `chat-markdown ${className}` : 'chat-markdown'}
      dangerouslySetInnerHTML={{ __html: renderWritingMarkdown(text) }}
    />
  );
}
