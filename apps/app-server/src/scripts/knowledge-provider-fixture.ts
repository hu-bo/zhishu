import { createServer } from "node:http";
import type { EvidenceItem } from "@zhishu/ai-contracts";

/** Deterministic protocol fixture. It verifies transport/persistence, never semantic model quality. */
export async function startKnowledgeProviderFixture() {
  const controls = { embeddingFailure: false, documentEmbeddings: 0, queryEmbeddings: 0 };
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString()) as {
        model: string;
        input?: string | string[];
        dimensions?: number;
        stream?: boolean;
        messages?: { role: string; content: string | { type: string; text?: string }[] }[];
        tools?: { function: { name: string } }[];
      };
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/embeddings") {
        if (controls.embeddingFailure) {
          res.writeHead(401);
          res.end(
            JSON.stringify({
              error: { code: "invalid_api_key", message: "Fixture authorization failure" },
            }),
          );
          return;
        }
        const texts = Array.isArray(input.input) ? input.input : [input.input ?? ""];
        if (Array.isArray(input.input)) controls.documentEmbeddings += texts.length;
        else controls.queryEmbeddings++;
        res.end(
          JSON.stringify({
            object: "list",
            model: input.model,
            data: texts.map((text, index) => {
              const embedding = Array.from({ length: input.dimensions ?? 32 }, () => 0.001);
              for (const char of text) embedding[char.codePointAt(0)! % embedding.length]! += 1;
              return { object: "embedding", index, embedding };
            }),
            usage: { prompt_tokens: texts.join("").length, total_tokens: texts.join("").length },
          }),
        );
        return;
      }
      if (req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end("{}");
        return;
      }
      const writing = input.tools?.some((t) => t.function.name === "authoring_result");
      const name = writing ? "authoring_result" : "chat_result";
      const paragraphs = [
        "星舟计划代号为ZK-7429。",
        "灰度比例为17%。",
        "灰度观察期为43小时。",
        "目标是为团队提供稳定可追溯的上线体验。",
        "灰度范围在上线前登记并由团队复核。",
        "逐步收集用户反馈并记录问题。",
        "上线期间持续监测关键指标。",
        "每次阶段切换都应检查上一阶段结果。",
        "异常处理需要保留现场和日志。",
        "发生阻断问题时停止继续发布。",
        "回滚负责人是林澈。",
        "回滚过程先恢复服务再分析原因。",
        "验收口令是松塔蓝鲸。",
        "验收通过后记录最终结论并归档。",
      ];
      let args: unknown;
      if (writing)
        args = {
          blocks: [
            { type: "heading", level: 1, text: "星舟计划上线规范" },
            ...paragraphs.map((text) => ({ type: "paragraph", text })),
          ],
          summary: "起草上线规范",
          citations: [],
        };
      else {
        const objects = (input.messages ?? []).flatMap((m) => {
          try {
            return [
              JSON.parse(
                typeof m.content === "string"
                  ? m.content
                  : m.content.map((c) => c.text ?? "").join(""),
              ) as { message?: string; evidence?: EvidenceItem[] },
            ];
          } catch {
            return [];
          }
        });
        const question = objects.find((o) => typeof o.message === "string"),
          evidence = question?.evidence ?? [];
        const text = evidence.map((e) => e.text).join("\n");
        args =
          !evidence.length || question?.message?.includes("火星")
            ? { status: "insufficient-evidence", text: "所选资料没有这项信息。", citations: [] }
            : {
                status: "replied",
                text,
                citations: evidence
                  .slice(0, 16)
                  .map((e) => ({ evidenceId: e.evidenceId, quote: e.text })),
              };
      }
      const call = {
        id: "fixture_tool",
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      };
      if (input.stream) {
        res.setHeader("content-type", "text/event-stream");
        const frame = (delta: unknown, finish_reason: string | null = null) =>
          `data: ${JSON.stringify({ id: "fixture_completion", object: "chat.completion.chunk", created: 0, model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        res.write(frame({ role: "assistant", tool_calls: [{ index: 0, ...call }] }));
        res.write(frame({}, "tool_calls"));
        res.end("data: [DONE]\n\n");
      } else
        res.end(
          JSON.stringify({
            id: "fixture_completion",
            object: "chat.completion",
            created: 0,
            model: input.model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: null, tool_calls: [call] },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 200, completion_tokens: 200, total_tokens: 400 },
          }),
        );
    } catch {
      res.writeHead(500);
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("FIXTURE_LISTEN_FAILED");
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    controls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
