import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { AiCreationPage } from '@/features/ai/ai-creation-page';
import { useKnowledgeWorkspace } from '@/features/knowledge/workspace-context';
export const Route = createFileRoute('/_app/ai')({
  validateSearch: (
    search: Record<string, unknown>,
  ): { sourceWorkspaceId?: string; contextDocumentId?: string; targetDocumentId?: string } => ({
    sourceWorkspaceId:
      typeof search.sourceWorkspaceId === 'string' ? search.sourceWorkspaceId : undefined,
    contextDocumentId:
      typeof search.contextDocumentId === 'string' ? search.contextDocumentId : undefined,
    targetDocumentId:
      typeof search.targetDocumentId === 'string' ? search.targetDocumentId : undefined,
  }),
  component: AiRoute,
});
function AiRoute() {
  const search = Route.useSearch(),
    navigate = useNavigate({ from: '/ai' }),
    { identityKey, enabled } = useKnowledgeWorkspace();
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
    <AiCreationPage
      key={JSON.stringify([identityKey, search.sourceWorkspaceId, search.contextDocumentId])}
      initialTargetDocumentId={search.targetDocumentId}
      contextDocumentId={search.contextDocumentId}
      sourceWorkspaceId={search.sourceWorkspaceId}
      onTargetChange={(id) => {
        void navigate({ search: (old) => ({ ...old, targetDocumentId: id }), replace: true });
      }}
    />
  );
}
