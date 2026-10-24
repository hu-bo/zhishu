import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-system-prompt";
import { z } from "zod";
import type { AuthoringProposal, EvidenceBundle } from "@zhishu/ai-contracts";
import { AuthoringOutputSchema, compileProposal } from "./compiler.js";
import type { WritingInput } from "./types.js";
import { appendPluginRecord } from "@deepseek-ai/dsh-session";
declare module "@deepseek-ai/dsh-session" {
  interface PluginRecordMap {
    "plugin:zhishu/authoring": AuthoringProposal;
  }
}
export * from "./compiler.js";
export * from "./types.js";
export { AiRuntimeError, fail } from "../errors.js";

export function installWriting(
  ctx: Context,
  options: {
    input: WritingInput;
    evidence(): EvidenceBundle;
    verify(signal: AbortSignal): Promise<void>;
    save(proposal: AuthoringProposal, signal: AbortSignal): Promise<void>;
  },
) {
  ctx.systemPrompt.section({
    name: "writing-output",
    order: 9900,
    text: "按照用户意图生成文章。最后必须调用 authoring_result 提交结构化草稿；不生成 documentId、Block ID 或操作批次。引用只能使用已登记 evidenceId，quote 必须逐字匹配。草稿尚未写入正文。",
  });
  ctx.tools.register({
    name: "authoring_result",
    description: "提交待用户确认的文章提案并结束本轮。",
    parameters: z.toJSONSchema(AuthoringOutputSchema),
    output: {
      schema: {
        type: "object",
        properties: { proposalId: { type: "string" } },
        required: ["proposalId"],
        additionalProperties: false,
      },
      render: () => [{ type: "text", text: "草稿已校验，等待用户确认。" }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      await options.verify(exec.signal);
      const proposal = compileProposal(options.input, args, options.evidence());
      await options.save(proposal, exec.signal);
      if (!exec.agent) throw new Error("AGENT_REQUIRED");
      appendPluginRecord(exec.agent.session, "plugin:zhishu/authoring", proposal);
      exec.concludeTurn();
      return { proposalId: proposal.proposalId };
    },
  });
}
