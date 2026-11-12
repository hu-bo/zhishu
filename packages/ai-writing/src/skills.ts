import { readFile } from "node:fs/promises";

/** Writing-owned Skill resources; versions travel with the package release. */
export interface WritingSkillDefinition {
  id: "writing" | "web-research";
  version: string;
  file: string;
  description: string;
}

export const writingSkillDefinitions = Object.freeze([
  {
    id: "writing",
    version: "1",
    file: "skills/writing/SKILL.md",
    description: "写作提案：意图工具、审阅与 durable 应用约束。",
  },
  {
    id: "web-research",
    version: "1",
    file: "skills/web-research/SKILL.md",
    description: "联网调研：搜索摘要与正文提取的证据升级规则。",
  },
] as const satisfies readonly WritingSkillDefinition[]);

export async function loadWritingSkill(id: WritingSkillDefinition["id"]): Promise<string> {
  const definition = writingSkillDefinitions.find((skill) => skill.id === id);
  if (!definition) throw new Error("UNKNOWN_SKILL");
  return readFile(new URL(`../${definition.file}`, import.meta.url), "utf8");
}
