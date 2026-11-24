import { afterEach, expect, it, vi } from "vitest";
import { CasdoorClient } from "../src/client/core.js";
import type { CasdoorUser, TokenResponse, StorageConfig, ClientConfig } from "../src/types.js";

const user: CasdoorUser = {
  id: "org/alice",
  owner: "org",
  name: "alice",
  displayName: "Alice",
  avatar: "",
  email: "alice@example.com",
  phone: "",
  type: "normal-user",
  createdTime: "",
  updatedTime: "",
  isAdmin: false,
  isGlobalAdmin: false,
  isForbidden: false,
  isDeleted: false,
  signupApplication: "app-zhishu",
  score: 0,
  ranking: 0,
  properties: {},
  roles: [],
  permissions: [],
};

const token: TokenResponse = {
  access_token: "access-token",
  refresh_token: "refresh-token",
  expires_in: 3600,
  token_type: "Bearer",
};

function fakeStorage() {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
    removeItem: (key: string) => void entries.delete(key),
    clear: () => entries.clear(),
  };
}

function stubWindow() {
  const localStorage = fakeStorage();
  const sessionStorage = fakeStorage();
  sessionStorage.setItem("casdoor_oauth_state_zhishu", "oauth-state");
  vi.stubGlobal("window", {
    localStorage,
    location: {
      search: "?code=auth-code&state=oauth-state",
      href: "https://app.example/callback?code=auth-code&state=oauth-state",
    },
    history: { state: null, replaceState: () => {} },
  });
  vi.stubGlobal("sessionStorage", sessionStorage);
  vi.stubGlobal("document", { title: "" });
  return { localStorage, sessionStorage };
}

afterEach(() => vi.unstubAllGlobals());

async function completeCallback(config: Partial<ClientConfig>) {
  const storage = stubWindow();
  const client = new CasdoorClient({
    appName: "zhishu",
    redirectUri: "https://app.example/callback",
    ...config,
  });
  const exchanged = await client.handleCallback(async () => ({ token, user }));
  return { exchanged, storage };
}

it("writes the session under a configured prefix verbatim, without re-appending the app name", async () => {
  const { exchanged, storage } = await completeCallback({
    storage: { type: "localStorage", prefix: "zhishu_" },
  });

  expect(exchanged).toBe(true);
  expect(storage.localStorage.entries.get("zhishu_access_token")).toBe("access-token");
  expect(storage.localStorage.entries.get("zhishu_refresh_token")).toBe("refresh-token");
  expect(storage.localStorage.entries.get("zhishu_user")).toBe(JSON.stringify(user));
  // The regression: `zhishu_` plus the app name produced zhishu_zhishu_* keys.
  expect(storage.localStorage.entries.has("zhishu_zhishu_access_token")).toBe(false);
});

it("defaults the prefix to casdoor_ plus the app name when none is configured", async () => {
  const { exchanged, storage } = await completeCallback({});

  expect(exchanged).toBe(true);
  expect(storage.localStorage.entries.get("casdoor_zhishu_access_token")).toBe("access-token");
  expect(storage.localStorage.entries.get("casdoor_zhishu_user")).toBe(JSON.stringify(user));
});

it("restores an existing session from the prefixed keys on construction", async () => {
  const { localStorage } = stubWindow();
  localStorage.setItem("zhishu_access_token", "access-token");
  localStorage.setItem("zhishu_expires_at", String(Date.now() + 60_000));
  localStorage.setItem("zhishu_user", JSON.stringify(user));

  const client = new CasdoorClient({
    appName: "zhishu",
    redirectUri: "https://app.example/callback",
    storage: { type: "localStorage", prefix: "zhishu_" } satisfies StorageConfig,
  });

  expect(client.getState()).toMatchObject({
    isAuthenticated: true,
    accessToken: "access-token",
    user,
  });
});
