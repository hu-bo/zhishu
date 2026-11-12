import MarkdownIt from 'markdown-it';
import {
  displayLatexPattern,
  inlineLatexPattern,
  isValidMathSource,
  MAX_LATEX_LENGTH,
} from '@zhishu/document-contracts';
import { renderMathToHtml } from '@zhishu/editor-core';

const markdown = new MarkdownIt({ html: false, breaks: true });
markdown.renderer.rules.image = (tokens, index) =>
  markdown.utils.escapeHtml(tokens[index]?.content || '图片');

const inlineMath = new RegExp(inlineLatexPattern.source, 'uy');
markdown.inline.ruler.before('escape', 'latex_inline', (state, silent) => {
  if (state.src[state.pos] !== '$') return false;
  inlineMath.lastIndex = state.pos;
  const match = inlineMath.exec(state.src);
  if (!match || inlineMath.lastIndex > state.posMax) return false;
  const latex = (match[1] ?? match[2]!).trim();
  if (!isValidMathSource(latex)) return false;
  if (!silent) state.push('latex_inline', 'span', 0).content = latex;
  state.pos = inlineMath.lastIndex;
  return true;
});

markdown.block.ruler.before(
  'fence',
  'latex_block',
  (state, startLine, endLine, silent) => {
    const start = state.bMarks[startLine]! + state.tShift[startLine]!;
    if (!state.src.startsWith('$$', start)) return false;
    for (let line = startLine; line < endLine; line += 1) {
      if (state.sCount[line]! < state.blkIndent) return false;
      const end = state.eMarks[line]!;
      if (end - start > MAX_LATEX_LENGTH + 4) return false;
      const lineStart = line === startLine ? start + 2 : state.bMarks[line]! + state.tShift[line]!;
      if (!state.src.slice(lineStart, end).includes('$$')) continue;
      const source = state.getLines(startLine, line + 1, state.blkIndent, false);
      const match = displayLatexPattern.exec(source);
      if (!match || match[0] !== source) return false;
      const latex = match[1]!.trim();
      if (!isValidMathSource(latex)) return false;
      if (!silent) {
        state.push('latex_block', 'div', 0).content = latex;
        state.line = line + 1;
      }
      return true;
    }
    return false;
  },
  { alt: ['paragraph', 'reference', 'blockquote', 'list'] },
);

function renderFormula(latex: string, block: boolean): string {
  const escaped = markdown.utils.escapeHtml(latex);
  const body = renderMathToHtml(latex, block) ?? escaped;
  return block
    ? `<div data-type="block-math" data-latex="${escaped}">${body}</div>\n`
    : `<span data-type="inline-math" data-latex="${escaped}">${body}</span>`;
}
markdown.renderer.rules.latex_inline = (tokens, index) =>
  renderFormula(tokens[index]!.content, false);
markdown.renderer.rules.latex_block = (tokens, index) =>
  renderFormula(tokens[index]!.content, true);

export function renderWritingMarkdown(text: string) {
  return markdown.render(text);
}
