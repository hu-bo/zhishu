import { RouterProvider } from '@tanstack/react-router';
import { AppProviders } from '@/app/providers';
import { CasdoorAuthProvider } from '@/features/auth/casdoor-auth';
import { createQueryClient } from '@/app/query-client';
import { createAppRouter } from '@/app/router';

const queryClient = createQueryClient();
const router = createAppRouter(queryClient);

export function App() {
  return (
    <AppProviders queryClient={queryClient}>
      <CasdoorAuthProvider>
        <RouterProvider router={router} />
      </CasdoorAuthProvider>
    </AppProviders>
  );
}
