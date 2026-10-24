import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/spaces/$workspaceId/doc/$documentId')({
  component: SpaceDocumentRoute,
});

function SpaceDocumentRoute() {
  // The space route owns the workspace shell and reads this route's params.
  return null;
}
