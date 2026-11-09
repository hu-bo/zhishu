import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/migrations/**",
      // Vendored agent skills contain their own runtime-specific scripts.
      ".agents/**",
      ".claude/**",
      "syncscribe/**",
      "output/**",
      ".playwright-cli/**",
      // Design-reference demo, not part of the shipped workspace.
      "zhishu-demo-gemini/**",
      // app-web has its own flat config (react-hooks / react-refresh plugins)
      // and is linted through its package script; see the root "lint" script.
      "apps/app-web/**",
      // app-web-new carries selected prototype components alongside copied
      // production files; only its prototype surface is linted here.
      "apps/app-web-new/src/api/**",
      "apps/app-web-new/src/app/**",
      "apps/app-web-new/src/features/**",
      "apps/app-web-new/src/routes/**",
      "apps/app-web-new/src/routeTree.gen.ts",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
