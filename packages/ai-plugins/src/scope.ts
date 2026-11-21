import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-system-prompt";
import { validateScopeSelection, type ScopeSelection } from "@zhishu/ai-contracts";
import { requireTurnContext, type PluginTurnAccess } from "./types.js";

/**
 * scope plugin: resolves control/natural-language scope intent into a server-validated
 * selection. The host port intersects with current authorization, persists the change and
 * advances contextRevision; it never grants access. The running turn stops delivering once
 * the revision moves, and the next turn rebuilds the allowed native context.
 */
export interface ScopePorts {
  current(): ScopeSelection;
  update(selection: ScopeSelection, signal: AbortSignal): Promise<{ contextRevision: number }>;
}

export function installScope(ctx: Context, ports: ScopePorts, access: PluginTurnAccess) {
  ctx.systemPrompt.section({
    name: "scope-intent",
    order: 90,
    text: "用户要求缩小或切换资料范围时，可用 set_conversation_scope 提交范围选择；服务器会按当前权限校验并生效。范围变化不授予新权限。不要声称已经访问了范围外的资料。",
  });
  ctx.tools.register({
    name: "set_conversation_scope",
    description: "提交会话资料范围选择，由服务器按当前授权校验后生效。",
    parameters: {
      type: "object",
      properties: {
        kind: { enum: ["all", "workspaces", "documents"] },
        workspaceIds: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 160 },
          minItems: 1,
          maxItems: 8,
          uniqueItems: true,
        },
        documentIds: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 160 },
          minItems: 1,
          maxItems: 64,
          uniqueItems: true,
        },
      },
      required: ["kind"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: { ok: { type: "boolean" }, contextRevision: { type: "integer" } },
        required: ["ok"],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      requireTurnContext(access, "scope");
      exec.signal.throwIfAborted();
      const checked = validateScopeSelection(args);
      if (!checked.success) return { ok: false };
      const { contextRevision } = await ports.update(checked.data, exec.signal);
      exec.concludeTurn();
      return { ok: true, contextRevision };
    },
  });
}
