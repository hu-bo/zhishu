import { createContext, useContext } from 'react';
import type { ListKnowledgeWorkspaces200Item } from '@/api/generated/app-api.schemas';

export type WorkspaceContextValue = {
  workspaces: ListKnowledgeWorkspaces200Item[];
  identityKey: string;
  enabled: boolean;
  authPending: boolean;
  loading: boolean;
  failed: boolean;
  refreshWorkspaces: () => void;
};

export const KnowledgeWorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/**
 * Session identity + the workspace directory. The "current workspace" lives in
 * the URL (`/spaces/$workspaceId`); this context only caches the list and
 * derives the identity key used to scope query keys and offline storage.
 */
export function useKnowledgeWorkspace(): WorkspaceContextValue {
  const context = useContext(KnowledgeWorkspaceContext);
  if (!context) throw new Error('KnowledgeWorkspaceProvider is required');
  return context;
}
