import { useQuery } from '@tanstack/react-query';
import { listKnowledgeWorkspaces } from '@/api/generated/app-api';
import type { MockLogin200User } from '@/api/generated/models';
import { KnowledgeWorkspaceContext } from './workspace-context';

/** Loads and shares the workspace directory for the signed-in identity. */
export function KnowledgeWorkspaceProvider({
  user,
  children,
}: {
  user: MockLogin200User | null;
  children: React.ReactNode;
}) {
  const identityKey = user ? `${user.tenantId}:${user.identityId}` : 'anonymous';
  const query = useQuery({
    queryKey: ['knowledge-workspaces', identityKey],
    queryFn: ({ signal }) => listKnowledgeWorkspaces({ signal }),
    enabled: !!user,
    staleTime: 30_000,
  });
  return (
    <KnowledgeWorkspaceContext.Provider
      value={{
        workspaces: query.data ?? [],
        identityKey,
        enabled: !!user,
        loading: !!user && query.isPending,
        failed: query.isError,
        refreshWorkspaces: () => {
          void query.refetch();
        },
      }}
    >
      {children}
    </KnowledgeWorkspaceContext.Provider>
  );
}
