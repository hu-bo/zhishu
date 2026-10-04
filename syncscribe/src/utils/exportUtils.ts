import { Editor } from '@tiptap/core';

export interface DocumentStats {
  words: number;
  characters: number;
  readingTimeMinutes: number;
}

export function calculateStats(text: string): DocumentStats {
  const trimmed = text.trim();
  if (!trimmed) {
    return { words: 0, characters: 0, readingTimeMinutes: 0 };
  }

  const wordsArray = trimmed.split(/\s+/).filter(Boolean);
  const words = wordsArray.length;
  const characters = trimmed.length;
  const readingTimeMinutes = Math.max(1, Math.ceil(words / 200));

  return { words, characters, readingTimeMinutes };
}

export function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function exportAsMarkdown(editor: Editor, docTitle = 'SyncScribe-Document'): void {
  // Simple clean markdown conversion from HTML / Node tree
  let html = editor.getHTML();

  // Convert headings
  let md = html
    .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n')
    .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n')
    .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n')
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<b[^>]*>(.*?)<\/b>/gi, '**$1**')
    .replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*')
    .replace(/<i[^>]*>(.*?)<\/i>/gi, '*$1*')
    .replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`')
    .replace(/<div data-type="divider-with-label" data-label="(.*?)"><\/div>/gi, '\n---\n**$1**\n---\n\n')
    .replace(/<span data-type="status-badge" data-status="(.*?)"><\/span>/gi, '`[$1]`')
    .replace(/<span data-type="collaborator-mention" data-name="(.*?)".*?><\/span>/gi, '@$1')
    .replace(/<li data-type="taskItem" data-checked="true"[^>]*>(.*?)<\/li>/gi, '- [x] $1\n')
    .replace(/<li data-type="taskItem" data-checked="false"[^>]*>(.*?)<\/li>/gi, '- [ ] $1\n')
    .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
    .replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n')
    .replace(/<br\s*[\/]?>/gi, '\n')
    .replace(/<[^>]+>/g, '') // remove remaining HTML tags
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();

  downloadFile(md, `${slugify(docTitle)}.md`, 'text/markdown;charset=utf-8');
}

export function exportAsHTML(editor: Editor, docTitle = 'SyncScribe-Document'): void {
  const contentHtml = editor.getHTML();
  const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(docTitle)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; max-width: 820px; margin: 40px auto; padding: 0 20px; color: #1e293b; }
    h1 { font-size: 2.2rem; margin-bottom: 0.5rem; color: #0f172a; }
    h2 { font-size: 1.6rem; margin-top: 2rem; border-bottom: 1px solid #e2e8f0; padding-bottom: 0.3rem; }
    pre { background: #0f172a; color: #f8fafc; padding: 1rem; border-radius: 8px; overflow-x: auto; font-family: monospace; }
    code { background: #f1f5f9; padding: 0.2rem 0.4rem; border-radius: 4px; font-size: 0.9em; }
    pre code { background: none; padding: 0; }
    blockquote { border-left: 4px solid #6366f1; padding-left: 1rem; color: #475569; margin: 1rem 0; }
    ul[data-type="taskList"] { list-style: none; padding-left: 0; }
    li[data-type="taskItem"] { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
    div[data-type="callout"] { border-radius: 8px; padding: 12px 16px; margin: 16px 0; border: 1px solid #cbd5e1; background: #f8fafc; }
  </style>
</head>
<body>
  ${contentHtml}
</body>
</html>`;

  downloadFile(fullHtml, `${slugify(docTitle)}.html`, 'text/html;charset=utf-8');
}

export function exportAsJSON(editor: Editor, docTitle = 'SyncScribe-Document'): void {
  const json = editor.getJSON();
  const serialized = JSON.stringify(json, null, 2);
  downloadFile(serialized, `${slugify(docTitle)}.json`, 'application/json;charset=utf-8');
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'document';
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
