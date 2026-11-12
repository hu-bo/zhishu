import { useQuery } from '@tanstack/react-query';
import type { Citation } from '@zhishu/ai-contracts';
import { readArtifact, type ConversationTransport } from './conversation-transport';

/**
 * Citation presentation model: display data is always resolved from server-registered
 * evidence artifacts; model-authored links never appear. Data fetching is plain
 * TanStack Query state, so no manual effect synchronization is needed.
 */

export interface CitationPresentation {
  citation: Citation;
  ordinal: number;
  title: string;
  kind: 'document' | 'web';
  /** Internal document route + block anchor for document sources. */
  documentId?: string;
  blockId?: string;
  workspaceLabel?: string | null;
  url?: string;
  siteName?: string;
  retrievedAt?: string;
  publishedAt?: string;
  contentKind?: string;
  excerpt: string;
}

type ArtifactEvidencePayload = {
  sources: Array<Record<string, unknown>>;
  items: Array<{ evidenceId: string; text: string; sourceId: string; snapshotId: string }>;
};

export function useCitationPresentations(
  transport: ConversationTransport,
  conversationId: string,
  citations: readonly Citation[],
): { presentations: CitationPresentation[]; loading: boolean; error: string | null } {
  const artifactIds = [...new Set(citations.map((citation) => citation.evidenceArtifactId))].sort();
  const query = useQuery({
    queryKey: ['citation-artifacts', conversationId, artifactIds],
    enabled: artifactIds.length > 0,
    queryFn: async () => {
      const entries = await Promise.all(
        artifactIds.map(
          async (id) =>
            [
              id,
              await readArtifact<ArtifactEvidencePayload>(transport, conversationId, id),
            ] as const,
        ),
      );
      return Object.fromEntries(entries);
    },
  });
  const cache = query.data ?? {};
  const presentations: CitationPresentation[] = [];
  const ordinals = new Map<string, number>();
  for (const citation of citations) {
    const payload = cache[citation.evidenceArtifactId];
    if (!payload) continue;
    const item = payload.items.find((candidate) => candidate.evidenceId === citation.evidenceId);
    const source = payload.sources.find(
      (candidate) =>
        candidate.sourceId === item?.sourceId && candidate.snapshotId === item?.snapshotId,
    );
    if (!item || !source) continue;
    const key = citation.citationId;
    let ordinal = ordinals.get(key);
    if (!ordinal) {
      ordinal = ordinals.size + 1;
      ordinals.set(key, ordinal);
    }
    const locator = citation.locator;
    presentations.push({
      citation,
      ordinal,
      title: String(source.title ?? '未知来源'),
      kind: source.sourceKind === 'web' ? 'web' : 'document',
      ...(source.sourceKind === 'web'
        ? {
            url: String(source.canonicalUrl ?? ''),
            siteName: source.siteName ? String(source.siteName) : undefined,
            retrievedAt: String(source.retrievedAt ?? ''),
            publishedAt: source.publishedAt ? String(source.publishedAt) : undefined,
            contentKind: String(source.contentKind ?? 'search-snippet'),
          }
        : {
            documentId: String(source.documentId ?? ''),
            blockId: locator.kind === 'block' ? locator.blockId : undefined,
            workspaceLabel:
              source.workspaceLabel == null
                ? (source.workspaceLabel as null | undefined)
                : String(source.workspaceLabel),
          }),
      excerpt: citation.quote,
    });
  }
  return {
    presentations,
    loading: query.isFetching,
    error: citationReadError(query),
  };
}

function citationReadError(query: { isError: boolean; error: unknown }): string | null {
  if (!query.isError) return null;
  return query.error instanceof Error ? query.error.message : '来源读取失败';
}
