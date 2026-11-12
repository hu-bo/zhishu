import { readFile } from "node:fs/promises";

/**
 * Neutral Skill resources shared by the qa flow and writing tools. Versions travel with the
 * package release; permissions, budgets and public ranges stay enforced by the server.
 */
export interface SkillDefinition {
  id: "scope" | "rag";
  version: string;
  file: string;
  description: string;
}

export const skillDefinitions = Object.freeze([
  {
    id: "scope",
    version: "1",
    file: "skills/scope/SKILL.md",
    description: "范围选择：意图到服务端验证的 scopeRef、contextRevision 与覆盖摘要。",
  },
  {
    id: "rag",
    version: "1",
    file: "skills/rag/SKILL.md",
    description: "平台资料检索：有界预算到 evidence artifact、来源版本与引用候选。",
  },
] as const satisfies readonly SkillDefinition[]);

export async function loadSkillInstruction(id: SkillDefinition["id"]): Promise<string> {
  const definition = skillDefinitions.find((skill) => skill.id === id);
  if (!definition) throw new Error("UNKNOWN_SKILL");
  return readFile(new URL(`../${definition.file}`, import.meta.url), "utf8");
}

/** Tool JSON Schemas shared by the QA controlled steps and the DSH writing tools. */
export const retrievalToolSchemas = Object.freeze({
  searchPlatform: {
    name: "search_platform",
    description: "在当前授权资料范围检索候选来源。",
    parameters: {
      type: "object",
      properties: { query: { type: "string", minLength: 1, maxLength: 1_000 } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  readPlatformSource: {
    name: "read_platform_source",
    description: "重新校验权限并读取已检索来源的证据片段。",
    parameters: {
      type: "object",
      properties: { sourceId: { type: "string", minLength: 1, maxLength: 160 } },
      required: ["sourceId"],
      additionalProperties: false,
    },
  },
} as const);
