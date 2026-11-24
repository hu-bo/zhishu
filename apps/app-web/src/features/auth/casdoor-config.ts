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
 * The session is persisted in localStorage so a full page reload after
 * /callback keeps it; the `zhishu_` prefix is used as-is and keeps other
 * consoles' sessions apart.
 */
export const casdoorClientConfig: ClientConfig = {
  appName: 'zhishu',
  authApiBase: '//auth.8and1.cn/api',
  redirectUri: `${window.location.origin}/callback`,
  storage: { type: 'localStorage', prefix: 'zhishu_' },
  silentRefresh: true,
};
