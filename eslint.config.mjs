import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/migrations/**",
      "syncscribe/**",
      "output/**",
      // Design-reference demo, not part of the shipped workspace.
      "zhishu-demo-gemini/**",
      // app-web has its own flat config (react-hooks / react-refresh plugins)
      // and is linted through its package script; see the root "lint" script.
      "apps/app-web/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
