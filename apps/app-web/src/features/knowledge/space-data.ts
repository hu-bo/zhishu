import type { QueryClient } from '@tanstack/react-query';

/**
 * Coarse invalidation after any structure/metadata mutation: catalog children
 * are cached per node, so the whole workspace prefix is dropped instead of
 * bookkeeping individual nodes (responses are small and cheap to refetch).
 */
export function invalidateSpaceData(
  queryClient: QueryClient,
  identityKey: string,
  workspaceId?: string,
): void {
  const catalogKey: unknown[] = ['catalog-children', identityKey];
  if (workspaceId) catalogKey.push(workspaceId);
  void queryClient.invalidateQueries({ queryKey: catalogKey });
  void queryClient.invalidateQueries({ queryKey: ['catalog-delete-impact'] });
  void queryClient.invalidateQueries({ queryKey: ['knowledge-workspaces', identityKey] });
  void queryClient.invalidateQueries({ queryKey: ['documents', identityKey] });
  void queryClient.invalidateQueries({ queryKey: ['document-locate', identityKey] });
  void queryClient.invalidateQueries({ queryKey: ['knowledge-search', identityKey] });
}
