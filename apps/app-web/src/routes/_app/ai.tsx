import { createFileRoute } from '@tanstack/react-router';
import { CreationPage } from '@/features/assistant/creation-page';
import { useKnowledgeWorkspace } from '@/features/knowledge/workspace-context';
export const Route = createFileRoute('/_app/ai')({
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    sourceWorkspaceId?: string;
    contextDocumentId?: string;
    targetDocumentId?: string;
    conversationId?: string;
  } => ({
    sourceWorkspaceId:
      typeof search.sourceWorkspaceId === 'string' ? search.sourceWorkspaceId : undefined,
    contextDocumentId:
      typeof search.contextDocumentId === 'string' ? search.contextDocumentId : undefined,
    targetDocumentId:
      typeof search.targetDocumentId === 'string' ? search.targetDocumentId : undefined,
    conversationId: typeof search.conversationId === 'string' ? search.conversationId : undefined,
  }),
  component: AiRoute,
});
function AiRoute() {
  const search = Route.useSearch();
  const { identityKey, enabled } = useKnowledgeWorkspace();
  if (!enabled)
    return (
      <div
        role="status"
        className="flex h-full items-center justify-center text-sm text-muted-foreground"
      >
        正在校验创作身份…
      </div>
    );
  return (
    <CreationPage
      key={JSON.stringify([
        identityKey,
        search.sourceWorkspaceId,
        search.contextDocumentId,
        search.targetDocumentId,
      ])}
      sourceWorkspaceId={search.sourceWorkspaceId}
      contextDocumentId={search.contextDocumentId}
      targetDocumentId={search.targetDocumentId}
    />
  );
}
