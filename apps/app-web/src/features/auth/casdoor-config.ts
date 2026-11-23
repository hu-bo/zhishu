import type { ClientConfig } from '@nova/casdoor/client';

/**
 * Auth mode follows the platform (nova) convention: Casdoor SSO is the default,
 * the local mock login is opt-in. Production builds never enable dev identity,
 * mirroring the server rule that refuses AUTH_MODE=mock under NODE_ENV=production.
 */
function resolveAuthMode(): 'dev' | 'casdoor' {
  const flag = import.meta.env.VITE_AUTH_MODE;
  if (flag === 'casdoor') return 'casdoor';
  if (flag === 'dev') return 'dev';
  return import.meta.env.DEV ? 'dev' : 'casdoor';
}

export const authMode = resolveAuthMode();
export const casdoorAuthEnabled = authMode === 'casdoor';

/**
 * Browser SDK against the shared Auth Service: no Casdoor clientSecret or
 * certificate lives in the app — the Auth Service owns the OAuth handshake.
 * The session is tab-scoped sessionStorage (nova rule: refresh survives,
 * closing the tab clears); the per-app prefix keeps other consoles' sessions apart.
 */
export const casdoorClientConfig: ClientConfig = {
  appName: import.meta.env.VITE_AUTH_APP_NAME || 'zhishu',
  authApiBase: import.meta.env.VITE_AUTH_BASE_URL || '//auth.8and1.cn/api',
  redirectUri: `${window.location.origin}/callback`,
  storage: { type: 'sessionStorage', prefix: 'zhishu_' },
  silentRefresh: true,
};
