import { createDeepAgent, StateBackend } from "deepagents";
import { createMiddleware, toolStrategy, StructuredOutputParsingError } from "langchain";
import { tool } from "@langchain/core/tools";
import { ToolMessage, isAIMessage } from "@langchain/core/messages";
import { Command, ReducedValue, StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import { validateEvidenceBundle, type AiTaskEvent, type EvidenceItem } from "@zhishu/ai-contracts";
import { AiRuntimeError, fail } from "./errors.js";
import {
  AuthoringOutputSchema,
  compileProposal,
  hashContent,
  validateInput,
} from "./proposal-compiler.js";
import { systemPrompt, userPrompt } from "./prompts.js";
import type { AuthoringInput, AuthoringRuntime, RuntimeOptions } from "./types.js";

const RUNTIME_VERSION = "zhishu-authoring-v1";
const counter = () =>
  new ReducedValue(z.number().int().nonnegative().default(0), {
    reducer: (a, b) => Math.max(a, b),
  });
const evidenceState = new ReducedValue(z.array(z.custom<EvidenceItem>()).default([]), {
  reducer: (current, next) => {
    const byId = new Map(current.map((item) => [item.evidenceId, item]));
    for (const item of next) {
      const existing = byId.get(item.evidenceId);
      if (existing && hashContent(existing) !== hashContent(item)) fail("INVALID_CITATION");
      byId.set(item.evidenceId, item);
    }
    if (byId.size > 256) fail("BUDGET_EXCEEDED");
    return [...byId.values()];
  },
});
const runtimeState = new StateSchema({
  inputFingerprint: z.string(),
  evidence: evidenceState,
  modelCalls: counter(),
  searchCalls: counter(),
  sourceReads: counter(),
  inputTokens: counter(),
  outputTokens: counter(),
  authoringOutput: z.unknown().optional(),
  expiresAt: z.number(),
});
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
function evidenceFrom(value: unknown): EvidenceItem[] {
  const validated = validateEvidenceBundle({ freshness: "current", items: value ?? [] });
  if (!validated.success) fail("INVALID_CITATION");
  return validated.data.items;
}
export function createAuthoringRuntime(options: RuntimeOptions): AuthoringRuntime {
  for (const value of Object.values(options.limits))
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("INVALID_GENERATION_LIMITS");
  if (
    options.limits.timeoutMs < 1 ||
    options.limits.maxModelCalls < 1 ||
    options.limits.maxInputTokens < 1 ||
    options.limits.maxOutputTokens < 1 ||
    options.limits.maxOutputBytes < 1 ||
    options.limits.maxOutputBytes > 65_536 ||
    !options.modelVersion
  )
    throw new Error("INVALID_GENERATION_LIMITS");
  // This is only process-local admission. Applications must also hold their distributed thread lock.
  const active = new Set<string>();
  const execute = async function* (
    originalInput: AuthoringInput,
    externalSignal: AbortSignal,
    resume: boolean,
  ): AsyncGenerator<AiTaskEvent> {
    const input = structuredClone(originalInput);
    let seq = 0;
    const event = <T extends AiTaskEvent["type"]>(
      type: T,
      payload: Extract<AiTaskEvent, { type: T }>["payload"],
    ): AiTaskEvent =>
      ({
        protocolVersion: 1,
        requestId: input.request.requestId,
        seq: ++seq,
        type,
        payload,
      }) as AiTaskEvent;
    const controller = new AbortController();
    const signal = AbortSignal.any([externalSignal, controller.signal]);
    let timedOut = false,
      timer: ReturnType<typeof setTimeout> | undefined,
      admitted = false;
    yield event("started", { kind: "authoring" });
    try {
      validateInput(input, {
        compatibility: options.compatibility,
        researchAvailable: !!(options.researchTools && options.verifyEvidence),
      });
      signal.throwIfAborted();
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options.limits.timeoutMs);
      if (active.has(input.threadId)) fail("THREAD_EXISTS");
      active.add(input.threadId);
      admitted = true;
      const config = {
        configurable: { thread_id: input.threadId },
        signal,
        recursionLimit: Math.max(32, options.limits.maxModelCalls * 8),
      };
      const fingerprint = hashContent([
        RUNTIME_VERSION,
        options.modelVersion,
        input,
        options.limits,
      ]);
      let calls = 0,
        searches = 0,
        reads = 0,
        totalInput = 0,
        totalOutput = 0;
      const count = (text: string): number => {
        const tokens = options.countTokens(text);
        if (!Number.isSafeInteger(tokens) || tokens < 0 || (text.length > 0 && tokens === 0))
          fail("BUDGET_EXCEEDED");
        return tokens;
      };
      const reserve = async (kind: "model" | "search" | "read", inputTokens = 0): Promise<void> => {
        signal.throwIfAborted();
        if (
          (kind === "model" && ++calls > options.limits.maxModelCalls) ||
          (kind === "search" && ++searches > options.limits.maxSearchCalls) ||
          (kind === "read" && ++reads > options.limits.maxSourceReads)
        )
          fail("BUDGET_EXCEEDED");
        await options.reserveUsage?.(
          {
            threadId: input.threadId,
            kind,
            inputTokens,
            maxOutputTokens: kind === "model" ? options.limits.maxOutputTokens : 0,
          },
          signal,
        );
        signal.throwIfAborted();
      };
      const search = tool(
        async ({ query }, runtime) => {
          if (!options.researchTools) fail("INSUFFICIENT_EVIDENCE");
          await reserve("search");
          const hits = await options.researchTools.searchKnowledge(query, signal);
          signal.throwIfAborted();
          if (
            hits.length > 64 ||
            hits.some(
              (hit) =>
                !hit.sourceId ||
                hit.sourceId.length > 160 ||
                hit.title.length > 512 ||
                hit.excerpt.length > 2_000,
            ) ||
            Buffer.byteLength(JSON.stringify(hits)) > options.limits.maxOutputBytes
          )
            fail("BUDGET_EXCEEDED");
          return new Command({
            update: {
              searchCalls: searches,
              messages: [
                new ToolMessage({
                  content: JSON.stringify(hits),
                  tool_call_id: runtime.toolCall?.id ?? "",
                }),
              ],
            },
          });
        },
        {
          name: "searchKnowledge",
          description: "搜索当前授权知识域。只返回候选摘要；必须 readSource 才能引用。",
          schema: z.object({ query: z.string().min(1).max(2_000) }).strict(),
        },
      );
      const read = tool(
        async ({ sourceId }, runtime) => {
          if (!options.researchTools) fail("INSUFFICIENT_EVIDENCE");
          await reserve("read");
          const items = evidenceFrom([
            ...(await options.researchTools.readSource(sourceId, signal)),
          ]);
          signal.throwIfAborted();
          if (
            items.some((item) => item.source.sourceId !== sourceId) ||
            Buffer.byteLength(JSON.stringify(items)) > options.limits.maxInputTokens * 4
          )
            fail("INVALID_CITATION");
          return new Command({
            update: {
              sourceReads: reads,
              evidence: items,
              messages: [
                new ToolMessage({
                  content: JSON.stringify(items),
                  tool_call_id: runtime.toolCall?.id ?? "",
                }),
              ],
            },
          });
        },
        {
          name: "readSource",
          description: "重新授权后读取原文并登记可引用的 evidenceId。",
          schema: z.object({ sourceId: z.string().min(1).max(160) }).strict(),
        },
      );
      const guard = createMiddleware({
        // Replace automatic summarization: every model call must pass the same hard budgets.
        name: "SummarizationMiddleware",
        stateSchema: runtimeState,
        wrapModelCall: async (request, handler) => {
          const tokens =
            count(
              JSON.stringify({
                system: request.systemMessage.content,
                messages: request.messages,
                tools: request.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  schema: "schema" in t ? t.schema : undefined,
                })),
                responseFormat: AuthoringOutputSchema.toJSONSchema(),
              }),
            ) + 256;
          if (tokens + options.limits.maxOutputTokens > options.limits.maxInputTokens)
            fail("BUDGET_EXCEEDED");
          await reserve("model", tokens);
          const response = await handler({
            ...request,
            modelSettings: { ...request.modelSettings, maxTokens: options.limits.maxOutputTokens },
            tools: request.tools.filter((t) => t.name !== "task" && t.name !== "execute"),
          });
          signal.throwIfAborted();
          const serialized = JSON.stringify({
            content: response.content,
            toolCalls: response.tool_calls,
          });
          if (
            Buffer.byteLength(serialized) > options.limits.maxOutputBytes ||
            (response.usage_metadata?.output_tokens ?? count(serialized)) >
              options.limits.maxOutputTokens
          )
            fail("BUDGET_EXCEEDED");
          totalInput += response.usage_metadata?.input_tokens ?? tokens;
          totalOutput += response.usage_metadata?.output_tokens ?? count(serialized);
          return response;
        },
        beforeModel: () => ({ modelCalls: calls + 1 }),
        afterModel: (state) => {
          const resultCalls = state.messages
            .filter(isAIMessage)
            .flatMap((message) => message.tool_calls ?? [])
            .filter((call) => call.name === "authoring_result");
          return {
            modelCalls: calls,
            inputTokens: totalInput,
            outputTokens: totalOutput,
            ...(resultCalls?.length === 1 ? { authoringOutput: resultCalls[0]!.args } : {}),
          };
        },
        wrapToolCall: async (request, handler) => {
          signal.throwIfAborted();
          if (["task", "execute"].includes(request.toolCall.name)) fail("UNSUPPORTED_TARGET");
          return handler(request);
        },
      });
      const responseSchema: { type: "object"; [key: string]: unknown } = {
        ...AuthoringOutputSchema.toJSONSchema(),
        type: "object",
        title: "authoring_result",
      };
      const responseFormat = toolStrategy(responseSchema, { handleError: false });
      const agent = createDeepAgent({
        model: options.model,
        checkpointer: options.checkpointer,
        stateSchema: runtimeState,
        backend: (state) => new StateBackend(state),
        tools: input.request.intent === "research" ? [search, read] : [],
        middleware: [guard],
        systemPrompt: systemPrompt(input),
        responseFormat,
      });
      const saved = await agent.graph.getState(config);
      signal.throwIfAborted();
      const existing = record(saved.values);
      if (resume) {
        if (!existing.inputFingerprint) fail("CHECKPOINT_UNAVAILABLE");
        if (existing.inputFingerprint !== fingerprint) fail("INCOMPATIBLE_CHECKPOINT");
        calls = Number(existing.modelCalls ?? 0);
        searches = Number(existing.searchCalls ?? 0);
        reads = Number(existing.sourceReads ?? 0);
        totalInput = Number(existing.inputTokens ?? 0);
        totalOutput = Number(existing.outputTokens ?? 0);
        const oldEvidence = evidenceFrom(existing.evidence);
        if (
          oldEvidence.length &&
          (!options.verifyEvidence || !(await options.verifyEvidence(oldEvidence, signal)))
        )
          fail("ACCESS_REVOKED");
      } else if (existing.inputFingerprint || Object.keys(existing).length > 0)
        fail("THREAD_EXISTS");
      const expiresAt = resume ? Number(existing.expiresAt) : Date.now() + options.limits.timeoutMs;
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) fail("TIMEOUT");
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, expiresAt - Date.now());
      let final: Record<string, unknown> = existing;
      yield event("progress", {
        stage: input.request.intent === "research" ? "planning" : "generating",
      });
      // A completed graph is compiled again without a model call. Pending graphs resume with null.
      if (!resume || saved.next.length > 0) {
        const stream = await agent.stream(
          resume
            ? null
            : {
                messages: [{ role: "user", content: userPrompt(input) }],
                inputFingerprint: fingerprint,
                evidence: input.request.intent === "research" ? [] : (input.evidence?.items ?? []),
                expiresAt,
              },
          { ...config, streamMode: ["values", "messages"] },
        );
        const previews = new Map<string, { name: string; args: string; shown: number }>();
        let lastSearches = searches,
          lastReads = reads,
          previewBytes = 0;
        for await (const update of stream) {
          signal.throwIfAborted();
          const [mode, value] = update as [string, unknown];
          if (mode === "values") {
            final = record(value);
            if (Number(final.searchCalls ?? 0) > lastSearches) {
              lastSearches = Number(final.searchCalls);
              yield event("progress", { stage: "searching" });
            }
            if (Number(final.sourceReads ?? 0) > lastReads) {
              lastReads = Number(final.sourceReads);
              yield event("progress", { stage: "reading" });
            }
          } else if (mode === "messages" && Array.isArray(value)) {
            const message = record(value[0]),
              metadata = record(value[1]);
            if (!Array.isArray(message.tool_call_chunks)) continue;
            for (const raw of message.tool_call_chunks) {
              const chunk = record(raw),
                key = `${metadata.langgraph_step}:${chunk.index ?? 0}`;
              const buffer = previews.get(key) ?? { name: "", args: "", shown: 0 };
              if (typeof chunk.name === "string") buffer.name += chunk.name;
              if (typeof chunk.args === "string") buffer.args += chunk.args;
              if (Buffer.byteLength(buffer.args) > options.limits.maxOutputBytes)
                fail("BUDGET_EXCEEDED");
              previews.set(key, buffer);
              if (buffer.name !== responseFormat[0]?.name) continue;
              const matches = [...buffer.args.matchAll(/"text"\s*:\s*("(?:\\.|[^"\\])*")/g)];
              for (const match of matches.slice(buffer.shown)) {
                const text: unknown = JSON.parse(match[1]!);
                if (typeof text !== "string") continue;
                previewBytes += Buffer.byteLength(text);
                if (previewBytes > options.limits.maxOutputBytes) fail("BUDGET_EXCEEDED");
                for (let offset = 0; offset < text.length; offset += 1_024)
                  yield event("text-delta", { text: text.slice(offset, offset + 1_024) });
              }
              buffer.shown = matches.length;
            }
          }
        }
      }
      signal.throwIfAborted();
      const evidence = { freshness: "current" as const, items: evidenceFrom(final.evidence) };
      if (
        input.request.intent === "research" &&
        (!evidence.items.length || Number(final.sourceReads ?? 0) === 0)
      )
        fail("INSUFFICIENT_EVIDENCE");
      if (
        evidence.items.length &&
        (!options.verifyEvidence || !(await options.verifyEvidence(evidence.items, signal)))
      )
        fail("ACCESS_REVOKED");
      const finalOutput = final.authoringOutput ?? final.structuredResponse;
      const serialized = JSON.stringify(finalOutput);
      if (
        !serialized ||
        Buffer.byteLength(serialized) > options.limits.maxOutputBytes ||
        count(serialized) > options.limits.maxOutputTokens
      )
        fail("BUDGET_EXCEEDED");
      const proposal = compileProposal(input, finalOutput, evidence);
      // Leave room for the protocol envelope; oversized proposals fail instead of violating SSE limits.
      if (Buffer.byteLength(JSON.stringify(proposal)) > 31_000) fail("BUDGET_EXCEEDED");
      signal.throwIfAborted();
      yield event("proposal", proposal);
      signal.throwIfAborted();
      yield event("completed", {
        resultKind: "proposal",
        usage: {
          inputTokens: Number(final.inputTokens ?? 0),
          outputTokens: Number(final.outputTokens ?? 0),
          modelCalls: calls,
          searchCalls: searches,
          sourceReads: reads,
        },
      });
    } catch (error) {
      let cause: unknown = error;
      for (
        let depth = 0;
        depth < 16 &&
        cause instanceof Error &&
        !(cause instanceof AiRuntimeError) &&
        !(cause instanceof StructuredOutputParsingError) &&
        cause.cause;
        depth++
      )
        cause = cause.cause;
      yield event("failed", {
        code: timedOut
          ? "TIMEOUT"
          : externalSignal.aborted
            ? "CANCELLED"
            : cause instanceof AiRuntimeError
              ? cause.code
              : cause instanceof StructuredOutputParsingError
                ? "INVALID_OUTPUT"
                : "MODEL_FAILED",
        retryable: false,
      });
    } finally {
      controller.abort();
      if (timer) clearTimeout(timer);
      if (admitted) active.delete(input.threadId);
    }
  };
  return {
    generate: (input, signal) => execute(input, signal, false),
    resume: (input, signal) => execute(input, signal, true),
  };
}
