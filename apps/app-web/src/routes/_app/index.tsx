import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/')({
  beforeLoad: () => {
    throw redirect({
      to: '/documents',
      search: { view: 'recent', sort: 'recent', direction: 'desc', limit: 20, offset: 0 },
    });
  },
});
