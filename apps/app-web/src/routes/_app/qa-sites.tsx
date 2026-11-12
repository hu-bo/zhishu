import { createFileRoute } from '@tanstack/react-router';
import { QaSitesAdminPage } from '@/features/qa-sites/qa-sites-admin';

export const Route = createFileRoute('/_app/qa-sites')({
  component: QaSitesAdminPage,
});
