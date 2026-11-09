import { useMemo } from 'react';
import { renderWritingMarkdown } from './markdown';

export function WritingMarkdown({ text }: { text: string }) {
  const html = useMemo(() => renderWritingMarkdown(text), [text]);
  return <div className="writing-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
