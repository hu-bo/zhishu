import type { CitationPresentation } from './citation-model';
import { renderWritingMarkdown } from './markdown';

/**
 * Citation marks are interactive React nodes while the answer is one Markdown block, so
 * each matched quote gets a plain-text token *before* rendering. markdown-it passes the
 * token through untouched, and the final replace turns it into a `<button>` that the
 * host component wires (via event delegation) to its popover state.
 */

function citationToken(citation: CitationPresentation): string {
  // The sanitized citation id makes accidental collisions with model-authored text
  // practically impossible; a stray literal only ever yields a no-op mark.
  const nonce = citation.citation.citationId.replace(/[^A-Za-z0-9_-]/g, 'x');
  return `@@cite:${citation.ordinal}:${nonce}@@`;
}

const CITATION_TOKEN = /@@cite:(\d+):[A-Za-z0-9_-]+@@/g;

/** Appends one token after the first occurrence of each citation quote, earliest first. */
export function injectCitationTokens(
  text: string,
  citations: readonly CitationPresentation[],
): string {
  const remaining = new Map<string, CitationPresentation>();
  for (const citation of citations) remaining.set(citation.citation.quote, citation);
  let out = '';
  let rest = text;
  let guard = 0;
  while (rest && remaining.size && guard++ < 200) {
    let best: { index: number; quote: string; citation: CitationPresentation } | undefined;
    for (const [quote, citation] of remaining) {
      const index = rest.indexOf(quote);
      if (index >= 0 && (!best || index < best.index)) best = { index, quote, citation };
    }
    if (!best) break;
    out += rest.slice(0, best.index + best.quote.length) + citationToken(best.citation);
    remaining.delete(best.quote);
    rest = rest.slice(best.index + best.quote.length);
  }
  return out + rest;
}

/** Full pipeline: quote tokens → Markdown → clickable citation marks. */
export function renderAnswerHtml(text: string, citations: readonly CitationPresentation[]): string {
  return renderWritingMarkdown(injectCitationTokens(text, citations)).replace(
    CITATION_TOKEN,
    (_match, ordinal: string) =>
      `<button type="button" class="citation-mark" data-citation-ordinal="${ordinal}" aria-label="来源 ${ordinal}">[${ordinal}]</button>`,
  );
}
