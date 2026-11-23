import { useEffect } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ShieldAlert } from 'lucide-react';
import { useCasdoorCallback } from '@nova/casdoor/client/react';
import { Button } from '@/components/ui/button';

export const Route = createFileRoute('/callback')({
  component: SsoCallbackPage,
});

/**
 * Top-level route (no shell chrome): the OAuth code/state exchange runs inside the
 * platform SDK against the shared Auth Service — single-flight, pending-state check
 * and query cleanup included. On success the document reloads at '/', where the
 * shell restores the verified identity from /api/auth/me and seeds the offline cache.
 */
function SsoCallbackPage() {
  const result = useCasdoorCallback();

  useEffect(() => {
    if (result.success) window.location.replace('/');
  }, [result.success]);

  if (result.error) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="w-full max-w-sm space-y-4 text-center">
          <ShieldAlert className="mx-auto size-8 text-danger" aria-hidden="true" />
          <h1 className="text-lg font-semibold text-foreground">统一登录未完成</h1>
          <p className="text-sm text-muted-foreground">{result.error.message}</p>
          <Button
            size="sm"
            onClick={() => window.location.replace('/')}
            className="w-full justify-center"
          >
            返回登录
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <p className="text-sm text-muted-foreground" role="status">
        正在完成统一登录…
      </p>
    </main>
  );
}
