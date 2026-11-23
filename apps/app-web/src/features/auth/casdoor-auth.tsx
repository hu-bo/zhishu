import { useEffect, useRef, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CasdoorProvider, useCasdoorClient } from '@nova/casdoor/client/react';
import { setAccessToken } from '@/api/transport';
import { casdoorAuthEnabled, casdoorClientConfig } from './casdoor-config';

/**
 * Mounts the platform Casdoor SDK above the router so both the app shell and the
 * public /callback route share one client instance. In dev/mock mode the client
 * stays dormant (storage is empty and the bridge below never subscribes).
 */
export function CasdoorAuthProvider({ children }: { children: ReactNode }) {
  return (
    <CasdoorProvider config={casdoorClientConfig}>
      <CasdoorSessionBridge>{children}</CasdoorSessionBridge>
    </CasdoorProvider>
  );
}

/**
 * Bridges Casdoor session state into the API transport (the same seam mock login
 * uses via setAccessToken), and clears the query cache whenever the verified
 * identity changes so no data leaks across accounts. Token refresh flows through
 * the subscription, so long-lived tabs keep working without a reload.
 */
function CasdoorSessionBridge({ children }: { children: ReactNode }) {
  const client = useCasdoorClient();
  const queryClient = useQueryClient();
  const lastIdentity = useRef<string | null>(null);

  useEffect(() => {
    if (!casdoorAuthEnabled) return;
    // subscribe() delivers the current state synchronously, so the transport token
    // is bridged before the browser paints.
    return client.subscribe((state) => {
      setAccessToken(state.accessToken ?? undefined);
      const identity = state.isAuthenticated ? (state.user?.id ?? null) : null;
      if (lastIdentity.current !== identity) {
        lastIdentity.current = identity;
        void queryClient.cancelQueries();
        queryClient.clear();
      }
    });
  }, [client, queryClient]);

  return <>{children}</>;
}
