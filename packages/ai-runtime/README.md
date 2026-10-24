# @zhishu/ai-runtime

Node.js 写作与知识研究运行时。通过 Deep Agents 1.15.1、LangChain 1.5.10 和应用注入的模型执行，输出 ai-contracts 的事件和受限编辑提案；不写文档、不连接应用数据库、不读取环境变量。

另提供 `createChatRuntime(options)`，输入为 `{ threadId, request: ChatRequest, history, evidence, prompt }`，返回 v2 started/progress/chat/completed。Chat 使用官方 LangGraph 单步工具结构化输出与 checkpoint；普通讨论允许无引用，grounded 模式必须通过真实证据与逐字引用验证。Chat 首期交付完整回复，取消、预算预留、证据复核及 `resume` 与写作沿用同一应用边界。history 只接受应用从有权限的已完成任务重建的消息。

```ts
import { createAuthoringRuntime, DEFAULT_GENERATION_LIMITS } from "@zhishu/ai-runtime";

const runtime = createAuthoringRuntime({
  model, // LangChain BaseChatModel，需支持工具调用
  modelVersion: "provider/model/config-v1",
  checkpointer, // 应用创建的官方 BaseCheckpointSaver
  limits: DEFAULT_GENERATION_LIMITS,
  countTokens, // 计入消息/工具格式开销的 tokenizer 或保守上界
  researchTools: { searchKnowledge, readSource }, // 已绑定当前主体和知识域
  verifyEvidence, // 主库复核当前权限、来源版本、定位和原文
  reserveUsage, // 在每次外部调用前原子预留 ai_runs 的累计预算
});

for await (const event of runtime.generate(
  {
    threadId,
    request,
    snapshot,
    structureRevision,
    prompt,
  },
  signal,
)) {
  // 应用控制转发：交付 proposal/completed 前再次授权并持久化最终结果。
  await forward(event);
}
```

`structureRevision` 必须来自应用可信头部；`snapshotRevision` 是另一种修订。`hashContent(snapshot.content)` 和 `hashContent(block)` 返回请求所需的 `sha256:` 摘要。请求、快照和 Prompt 在执行时克隆；模型无法选择操作、文档 ID 或 Block ID。新 ID 和 operationId 按 thread/request 确定分配，替换保留原目标 ID。

支持 create/continue/summarize 后插入，单个顶层段落/标题的 rewrite/translate，以及显式 document 目标的 rewrite-document。整篇改写最多支持 256 个原顶层块，按位置保留重叠 Block ID，编译替换、尾部删除或追加操作；应用应强制替换意图手动确认，只在用户点击替换后提交。selection 和复杂节点局部替换返回 UNSUPPORTED_TARGET。research 必须实际 readSource，并仅允许引用登记证据的逐字区间。缺少工具、无证据或伪造引用均不会产出可接受提案。原文与搜索结果作为资料区传入；不转发内部推理、文件、搜索原文或笔记。

预览来自结构化输出工具的草稿字段，完整验证前只作为 text-delta。普通文本模型输出不作为结构化结果降级接受。工具结构化输出策略显式禁用 SDK 自动重试。自动摘要替换为预算控制，task/execute 禁用，虚拟文件采用每 thread 的 StateBackend。

恢复调用 `runtime.resume(originalInput, signal)`；使用原始不可变输入、模型/Prompt/运行时版本、原目标修订和原 thread。新进程重新注入凭据与当前授权工具。证据、原截止时间、用量和最终模型对象进入 SDK 状态；最终对象另存为自定义 channel，因为锁定 SDK 的 structuredResponse 本身不持久化。图已完成时只重新校验、编译提案，不再调用模型。不存在 checkpoint 或版本不兼容会明确失败。

应用必须拥有 ai_runs 状态机和跨进程 advisory lock，只允许 interrupted 恢复；显式取消、超时、撤权与无效结果不可恢复。运行时的 active Set 只防止同一实例重入，不承担分布式互斥。`reserveUsage` 必须由应用持久化并保守计入不确定是否计费的调用；checkpoint 无法保证外部调用恰好一次。resume 的内部事件交给受管理执行器消费，应用不为同 requestId 开第二条 SSE 流。

`verifyEvidence` 是有证据的最终交付和恢复的必要条件；缺省时拒绝交付证据结果。`compatibility` 可声明宿主可写 Schema 与扩展版本，缺省仅接受标准内容契约且无额外扩展。取消和 iterator.return 会释放本地执行资源；应用仍需确认外部执行退出后再释放分布式锁。

运行 `pnpm test:ai`。设置 `AI_TEST_DATABASE_URL` 后启用隔离 PostgreSQL 测试：只在测试中显式 saver.setup()，四张官方表位于 ai_checkpoint schema；验证独立 Node 子进程恢复、图完成回读和 deleteThread。该 URL 必须指向可清理的测试库，不能使用生产数据库。

生产 HTTP/SSE、ai_runs migration、权限广播、累计限额、TTL、关键词工具及协同接受通道由 app-server 实现，参见 [应用设计](../../docs/packages/ai-runtime.md)。模型质量和真实计费用量需要真实 provider 验收。
