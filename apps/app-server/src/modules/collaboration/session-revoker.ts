export type CollaborationSessionRevoker = {
  revokeDocumentSessions(documentId: string, generationId: string, identityId?: string): void;
};
