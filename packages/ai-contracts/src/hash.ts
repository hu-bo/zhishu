import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";

/**
 * Server-side content identity. Lives in a subpath so browser consumers of
 * @zhishu/ai-contracts never pull Node crypto into their bundles.
 */
export const hashContent = (value: unknown): string =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
