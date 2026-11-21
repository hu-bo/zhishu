import { readFile } from "node:fs/promises";

/** Plugin-owned Skill resources; versions travel with the package release. */
export interface SkillDefinition {
  id: "scope" | "rag-answer" | "research" | "writing" | "web-research";
  version: string;
  file: string;
  description: string;
}

export const skillDefinitions = Object.freeze([
  {
    id: "scope",
    version: "1",
    file: "skills/scope/SKILL.md",
    description: "范围意图：服务器验证的选择与 contextRevision 推进。",
  },
  {
    id: "rag-answer",
    version: "1",
    file: "skills/rag-answer/SKILL.md",
    description: "知识问答：检索门槛、逐字引用与不足状态。",
  },
  {
    id: "research",
    version: "1",
    file: "skills/research/SKILL.md",
    description: "调研：组合平台与网页检索，结论留在对话。",
  },
  {
    id: "writing",
    version: "1",
    file: "skills/writing/SKILL.md",
    description: "写作提案与草稿：意图工具、审阅与 durable 应用约束。",
  },
  {
    id: "web-research",
    version: "1",
    file: "skills/web-research/SKILL.md",
    description: "联网调研：搜索摘要与正文提取的证据升级规则。",
  },
] as const satisfies readonly SkillDefinition[]);

export async function loadSkillInstruction(id: SkillDefinition["id"]): Promise<string> {
  const definition = skillDefinitions.find((skill) => skill.id === id);
  if (!definition) throw new Error("UNKNOWN_SKILL");
  return readFile(new URL(`../${definition.file}`, import.meta.url), "utf8");
}
