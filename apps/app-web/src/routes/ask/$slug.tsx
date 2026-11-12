import { createFileRoute } from '@tanstack/react-router';
import { PublicAskPage } from '@/features/qa-sites/public-ask-page';

export const Route = createFileRoute('/ask/$slug')({
  component: PublicAskRoute,
  validateSearch: (search: Record<string, unknown>): { conversation?: string } => ({
    conversation: typeof search.conversation === 'string' ? search.conversation : undefined,
  }),
});

function PublicAskRoute() {
  const { slug } = Route.useParams();
  return <PublicAskPage slug={slug} />;
}
