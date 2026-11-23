/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  /** "casdoor" | "dev"; unset follows the nova convention (dev server => mock, prod build => SSO). */
  readonly VITE_AUTH_MODE?: string;
  /** Shared Auth Service API base; the Casdoor client is configured server-side there. */
  readonly VITE_AUTH_BASE_URL?: string;
  /** Casdoor application name registered with the Auth Service. */
  readonly VITE_AUTH_APP_NAME?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
