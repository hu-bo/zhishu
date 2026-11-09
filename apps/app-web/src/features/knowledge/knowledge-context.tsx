import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getAuthorizationState } from '@/api/generated/authorization';
import { listKnowledgeWorkspaces } from '@/api/generated/knowledge';
import { cacheIdentity, synchronizeAuthorizationCache } from '@/features/offline/cache';
import type { MockLogin200User } from '@/api/generated/app-api.schemas';
import { KnowledgeWorkspaceContext } from './workspace-context';

/** Loads and shares the workspace directory for the signed-in identity. */
export function KnowledgeWorkspaceProvider({
  user,
  authPending,
  children,
}: {
  user: MockLogin200User | null;
  authPending: boolean;
  children: React.ReactNode;
}) {
  const identityKey = user ? `${user.tenantId}:${user.identityId}` : 'anonymous';
  const queryClient = useQueryClient();
  const authorization = useQuery({
    queryKey: ['authorization-state', identityKey],
    queryFn: ({ signal }) => getAuthorizationState({ signal }),
    enabled: !!user,
    refetchInterval: 5000,
    refetchOnWindowFocus: 'always',
    retry: false,
  });
  useEffect(() => {
    if (!user || !authorization.data) return;
    let active = true;
    void synchronizeAuthorizationCache(cacheIdentity(user), authorization.data)
      .then((changed) => {
        if (active && changed)
          void queryClient.invalidateQueries({
            predicate: (q) => q.queryKey[0] !== 'authorization-state',
          });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [user, authorization.data, queryClient]);
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
        authPending,
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
