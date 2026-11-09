# ai-runtime 设计规划

> 2026-10-24 实施更新：新建 authoring 任务已由 app-server 转入 DSH；提案编译器迁至 ai-plugins/writing，原入口重导出兼容。RAG createChatRuntime 和旧任务 LangChain/LangGraph/checkpoint 仍实际保留，未做跨引擎转换。见 [实施记录](ai-chat-implementation.md)。

> 清理更新：应用通过公开 `./chat`、`./policy` 子路径消费当前能力，仅在恢复历史写作时动态加载 `./legacy-authoring`；DSH 缺失直接失败，禁止回退或创建新的 LangChain 写作任务。AuthoringInput 复用 WritingInput，不再平行声明；新写作服务不依赖旧 RuntimeOptions。

> 2026-10-24 迁移范围：只有协作 AI 写作 Chat 向官方 Cordis/DSH 迁移，规范见 [dsh-agent](dsh-agent.md)与[写作总方案](ai-chat-architecture.md)。RAG Chat 继续使用 LangChain，所需模型、问答、历史与 checkpoint 保持独立，不因写作迁移退出。本文既有实现记录继续用于历史写作兼容和实际仍被消费的能力，不能将整个 LangChain 路线视为旧引擎。

2026-10-22 已实现 `rewrite-document` 整篇提案编译。显式 `document` 目标捕获全文，在最多 256 个原顶层块与输出块之间按位置保留重叠 Block ID，删除旧尾部或追加新尾部；全部原块带存在性前置条件，请求固定整文 Hash 与版本。运行时只返回提案，应用强制替换意图手动确认，正文预览由编辑器包负责。已覆盖生成不改变输入、增长/缩短/等长结果、ID 保留、目标篡改与遗漏删除拒绝。

状态：2026-10-19 已按用户编码指令实现 `@zhishu/ai-runtime` 包，目录 `packages/ai-runtime`；[返回文档地图](../README.md)。共享载荷见 [ai-contracts](ai-contracts.md)，检索适配见 [rag](rag.md)，编辑器应用见 [editor-ai-bridge](editor-ai-bridge.md)。应用集成设计与包实现验收分别记录，不将包测试等同于应用上线。

实现入口与消费说明见 [包 README](../../packages/ai-runtime/README.md)。已验证真实 Deep Agents SDK 的工具结构化输出、流式草稿、目标编译、引用区间、预算、取消、研究工具、恢复前撤权复核，以及官方 PostgresSaver 四表与独立 Node 子进程回读。模型使用确定性 LangChain 测试模型；没有调用付费模型。

公共接口增加应用提供的可信 `structureRevision`、`modelVersion`，并提供 `verifyEvidence` 和原子预算预留回调 `reserveUsage`。`structureRevision` 不从 snapshotRevision 推断。生成结果使用稳定命名的 `authoring_result` 工具策略；最终结果保存在自定义 SDK 状态，解决 structuredResponse 不进入 checkpoint 的实际行为。自动摘要中间件替换为预算中间件，禁止未计数的模型调用；首期禁用 task/execute。

第 5、6 节中 ai_runs、advisory lock、HTTP/SSE、任务恢复状态机、TTL、协同接受与应用关键词工具已在 app-server 接入。隔离 PostgreSQL 的应用验收覆盖真实 SSE/WebSocket、自动冲突、撤权、取消、恢复及重复接受；使用确定性模型，实际模型质量、费用与生产部署仍需另行验收。

2026-10-21 新增 `createChatRuntime`：基于官方 LangGraph/checkpointer 的单步结构化 Chat，输出 v2 完整 chat/completed，不提供 Chat token 预览。团队支持 Chat、资料讨论与草稿，AI 正文写入仅限发起者本人个人空间；正文只由用户显式确认后写入。本包只产出结果，不负责空间权限或改正文，页面方案见 [app-web](../apps/app-web.md#知识问答与-ai-创作)。

## 1. 职责与依赖

本节迁移表仅针对写作路径。下文 SDK 装配、checkpoint 和 thread 规则保留实际实现依据；RAG 使用的 LangChain 能力继续按自身业务契约消费。

| 当前能力                     | 迁移目标                            | 保留条件                                                |
| ---------------------------- | ----------------------------------- | ------------------------------------------------------- |
| 协作写作 Chat 与执行生命周期 | dsh-agent + chat-contracts          | 旧写作 v1/v2 结果和任务按兼容策略回读                   |
| 写作模型/工具循环、检查点    | 官方 DSH 装配与 Session persistence | 旧写作 checkpoint 不直接转换，RAG 的 LangChain 存储保留 |
| 文档提案编译                 | ai-plugins/writing 内部纯逻辑       | 保留 Block ID、目标、Hash 与原回归用例                  |
| 写作调研策略与工具适配       | ai-plugins/research                 | 独立 RAG 问答仍用 LangChain，检索端口可复用             |
| RAG 问答与执行生命周期       | 继续使用 LangChain RAG 链路         | 保留 RAG 的模型、历史、查询及实际恢复能力               |
| 证据、提案、审阅校验         | 继续复用 ai-contracts               | 不复制业务 Schema                                       |

写作路径退出前必须记录 engine/version、旧写作恢复与过期策略、历史回显及 P3/P4 兼容验收。RAG 或其他业务仍依赖本包/LangChain 时继续保留对应入口、依赖和存储，不能按写作迁移整体删除。

负责把可信的写作/问答输入转换为受约束的生成结果：构造 Prompt、调用模型、流化预览、验证最终结构和引用、编译编辑提案、传播取消及统计用量。运行于 Node.js，不依赖 Fastify、数据库、React、Yjs 或应用全局配置。

选用 [Deep Agents TypeScript](https://github.com/langchain-ai/deepagentsjs) 作为现成 agent harness，模型和工具使用 LangChain 接口。执行循环、上下文管理、虚拟文件和可选子 Agent 由 SDK 提供；本包只负责写作/研究策略、知书内容提案编译和 SDK 事件适配。模型凭据、授权、额度和数据存储由应用注入。

普通创作处理目标内容与指令；Deep Research 在同一 SDK 上反复搜索、阅读、识别缺口，再形成带来源的草稿。研究流程参考[官方 TypeScript Deep Research 示例](https://docs.langchain.com/oss/javascript/deepagents/deep-research)，无需另建一套 Agent 编排框架。

| 项目     | 设计                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------- |
| 根入口   | 当前 `createAuthoringRuntime` 覆盖写作和 research；创作页需要新增独立 Chat 运行时，知识问答仍需接入      |
| 依赖     | `deepagents`、`langchain`、`@langchain/core`、SDK 配套 checkpoint 类型、ai-contracts、document-contracts |
| 模型接入 | 应用注入 LangChain `BaseChatModel`，供应商适配包按实际模型选用                                           |
| RAG 接入 | 注入 `searchKnowledge` / `readSource` 或已有 `EvidenceBundle`                                            |
| 输出     | `AsyncIterable<AiTaskEvent>`，SDK 的内部事件在本包转换为产品事件                                         |

审核通过后再按 Deep Agents 的实际 peerDependencies 锁定 LangChain、LangGraph、模型适配包与可观测依赖的兼容组合。SDK 升级只影响本包内部和模型装配边界，不改变浏览器协议；不并行引入 Vercel AI SDK 作为第二套 Agent 执行引擎。首期不额外发布 providers、agents、workflow 等包。

### LangGraph 的使用范围

Deep Agents 内部基于 LangGraph，createDeepAgent 返回编译后的图，相关依赖需要按 SDK 要求保留，见[官方说明](https://github.com/langchain-ai/deepagentsjs#langgraph-native)。写作/研究直接调用 Deep Agents 的执行/流接口；Chat 仅用一个 StateGraph 节点调用 chat_result 工具并保存最终对象，复用同一官方 checkpoint 与预算边界，不建立第二套 Agent 循环。

首期启用官方 `@langchain/langgraph-checkpoint-postgres` 的 PostgresSaver，由 app-server 创建并注入 Deep Agents 的 checkpointer 参数；本包只依赖 SDK 的 BaseCheckpointSaver 类型，不直接连接 PostgreSQL。仍不部署 LangGraph Server。恢复从 SDK 已持久化的步骤边界继续，不承诺从模型 token 或工具函数内部断点继续，见[官方 checkpointer 说明](https://docs.langchain.com/oss/javascript/langgraph/checkpointers)。

每个业务 requestId 对应独立 thread，不建立会话/线程表。应用按租户、主体、requestId 生成无歧义的 threadId，并绑定 ai_runs；同一任务恢复沿用该值，重新生成使用新 requestId/threadId。threadId 不接受模型或浏览器指定，也不承担授权。checkpoint_ns 由 SDK 管理子图命名空间，不用来替代租户隔离。

每轮请求使用独立的 StateBackend/虚拟工作区，研究笔记随该 thread 的 checkpoint 保留，过期后整组清理；不增加跨 thread 的 PostgresStore 或长期记忆表。默认单个研究 Agent；确需拆分问题时才使用 SDK 子 Agent，并共享总预算。首期不挂载宿主文件系统、Shell、任意数据库或无范围限制的网页读取工具。规划工具是否需要显式 middleware，以锁定版本文档为准。

## 2. 公共接口

以下展示核心 API；完整已实现类型以包的 src/types.ts 为准。内容/事件来自 ai-contracts，模型直接采用 LangChain 的 BaseChatModel，不另造通用模型 SDK 接口。

```ts
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { DocumentSnapshot } from "@zhishu/document-contracts";
import type {
  AiTaskEvent,
  AuthoringRequest,
  EvidenceItem,
  EvidenceBundle,
} from "@zhishu/ai-contracts";

export interface GenerationLimits {
  timeoutMs: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxOutputBytes: number;
  maxModelCalls: number;
  maxSearchCalls: number;
  maxSourceReads: number;
}

export interface PromptPolicy {
  id: string;
  version: string;
  systemInstruction: string;
}

export interface AuthoringInput {
  threadId: string;
  request: AuthoringRequest;
  snapshot: DocumentSnapshot;
  structureRevision: number;
  evidence?: EvidenceBundle;
  prompt: PromptPolicy;
}

export interface ResearchHit {
  sourceId: string;
  title: string;
  excerpt: string;
}

export interface ResearchTools {
  searchKnowledge(query: string, signal: AbortSignal): Promise<readonly ResearchHit[]>;
  readSource(sourceId: string, signal: AbortSignal): Promise<readonly EvidenceItem[]>;
}

export interface RuntimeOptions {
  model: BaseChatModel;
  modelVersion: string;
  checkpointer: BaseCheckpointSaver;
  limits: GenerationLimits;
  researchTools?: ResearchTools;
  countTokens(text: string): number;
}

export interface AuthoringRuntime {
  generate(input: AuthoringInput, signal: AbortSignal): AsyncIterable<AiTaskEvent>;
  resume(input: AuthoringInput, signal: AbortSignal): AsyncIterable<AiTaskEvent>;
}

export declare function createAuthoringRuntime(options: RuntimeOptions): AuthoringRuntime;
```

运行时再次核对请求版本、目标和传入快照，不能把任意客户端正文当成服务端事实。该验证只证明输入自洽；应用服务仍负责身份、文档 `write/ai` 权限、检索范围与 evidence 的授权。

generate 只初始化未执行的 thread；resume 从应用保存的原始输入装配上下文，并以同一 threadId 恢复，不再次追加初始消息。恢复所需的 evidenceId 登记、来源定位、SDK 虚拟文件和模型输出必须进入 SDK 可序列化状态，不能仅保存在进程闭包；使用 SDK 支持的 middleware/state 扩展完成，不自建 StateGraph。凭据与绑定当前权限的工具闭包在每次执行时重新注入，不写入 checkpoint。

`countTokens` 必须覆盖当前模型的输入格式开销；不支持准确 tokenizer 时采取保守估算并预留余量，不能使用中文字符数代替 token。输出 token 和字节分别限制，调用方可进一步收紧默认预算。

ResearchTools 在服务端绑定当前主体、租户与已授权知识域，模型只提供 query/sourceId。search 返回候选摘要，read 在当次调用重新授权后返回原文与稳定来源定位；猜测 sourceId 不授予读取权限。最终引用只允许来自 read 实际登记的 EvidenceItem。

首期工具实现复用知书现有的标题/正文关键词搜索；这能支持多轮知识研究，但不代表已经具备向量 RAG。后续 rag 接入 LangChain + Qdrant，切片/向量与稳定 space/user/document 授权键一起存储，工具合约不变。应用按当前成员/独立文档关系计算检索键，模型调用不能指定或复用旧授权键；普通成员增删不触发向量索引。读取、恢复和最终交付按统一访问模式复核当前权限及版本，Qdrant 不向模型直连开放。网页研究是独立可选工具，密钥/范围由应用配置。

## 3. 写作流程与提案编译

1. 校验版本、目标、Schema/扩展和预算，捕获不可变上下文；应用在此之前已完成限额预留与授权。
2. 从可信快照提取目标和有限前后文，拼装 Prompt；research 由 Deep Agents 调用搜索/阅读工具并补查缺口，检索材料以带 evidenceId 的资料区传入。
3. 使用 LangChain/Deep Agents 已提供的结构化输出或工具策略取得受限内容与 evidenceId 引用；根据锁定版本的 API 选择，不自研模型循环。完整对象形成前只发预览，部分结构化输出不可当成有效 DocumentContent。
4. 完整结果经过内容语义、扩展、URL、引用、输出大小校验。校验失败产生 failed，不发可接受提案。
5. 运行时为新块分配 ID，保持被替换块的合法身份，以受信目标编译 OperationBatch，绑定生成前的 baseStructureRevision 和必要目标条件，生成 proposal → completed。

模型不直接生成任意 OperationBatch，不允许其更改其他文档、绕过目标范围或引用没有登记的资产。已有内容的 create 必须指定插入目标，全文替换需要显式目标与预览。

首期 intent 和目标矩阵：

| intent              | 支持目标                               | 编译行为                                      |
| ------------------- | -------------------------------------- | --------------------------------------------- |
| create / continue   | document-end、明确 blocks 后方         | 在稳定邻接块之后插入新块                      |
| rewrite / translate | 单个顶层 paragraph/heading 完整块      | 预览后替换该完整块，界面明确显示作用范围      |
| rewrite-document    | 显式 document，最多 256 个顶层块       | 全文生成后审阅，点击替换才应用完整提案        |
| summarize           | 完整块或文档上下文作为输入             | 在明确目标后插入摘要，原文保留                |
| research            | 指定问题 + 已授权知识域 + document-end | 多轮搜索/阅读后生成带引用草稿，接受后插入新块 |

首期只输出段落、H1/H2/H3 标题和代码块，沿用已有内容契约；列表、表格等复杂生成后置。选区内精确替换也后置，不能把“改写选区”静默扩展成覆盖整个段落。现有入口如果传入局部选区，应说明限制并让用户选择完整段落。

服务端协同 owner 校验块存在性，并在持久化事务内核对 generationId/durableSeq/baseStructureRevision。首期采用整文档保守冲突策略，普通文本更新也会阻止旧提案；隔离 PostgreSQL/WebSocket 测试已覆盖真实人工编辑后保留完整草稿且不写入。后续如需允许目标以外的编辑，仍需单独设计与验收放宽策略。

多块跨边界选区、表格内部片段、原子 NodeView 内部文字先返回 `UNSUPPORTED_TARGET`，UI 提供选择完整块的入口。后续支持时先补 core 的安全目标捕获/编译能力与综合验收，不在业务页面用绝对位置拼接 JSON。摘要若来源和插入位置不同，服务端同时校验两者。

## 4. 研究、问答与引用

research 需要先调用工具取得证据，最终报告必须携带真实来源；没有可用证据时返回明确不足，不能降级成无来源报告。独立知识问答 API 使用 EvidenceBundle，证据为空时直接产出 insufficient-evidence；证据非空也不保证足以回答。普通 Chat 为创作页新增的独立能力，允许无来源讨论，但一旦使用知识资料作答就必须登记真实引用；不能放宽 v1 AnswerResult 的证据要求来实现自由对话。

Chat 运行时应沿用现有模型注入、取消、预算、安全进度和 checkpoint 装配。应用从同主体已完成任务装配有界历史，每轮使用新 requestId/threadId，当前轮中断恢复才复用原 threadId。历史消息和资料每轮重新授权，过期上下文不自动从 checkpoint 泄露或无限拼接。新增 ChatResult 和版本化流协议先落到 [ai-contracts 扩展设计](ai-contracts.md#7-chat-与写入模式扩展2026-10-21-设计)，运行时不从 ChatResult 自动编译正文提案。

模型只能输出本轮 evidenceId；运行时将其解析为服务端提供的 SourceReference。引用摘录须匹配本轮固定的快照文本与定位，不能只验证 ID 存在。未知 ID、越界摘录或捏造引用使最终结果失败。非空引用不等于语义正确，仍须在评测中检查答案是否得到证据支持。

应用在发送正文给 reranker/LLM 前检查权限，并在最终结果交付前再次复核 evidence 的权限与版本。运行时先产出内部事件，由应用服务控制转发；复核失败时抑制 proposal/answer/completed，输出安全 failed。已经传出的预览无法收回，客户端须清空因撤权终止的来源与草稿；主动权限失效通知应取消在途生成。

应用服务包装运行时事件流时拥有对外事件序号：仅给实际转发的事件分配连续 seq。被拦截的内部最终事件不占对外序号，拒绝交付时用下一个 seq 发送 failed 并取消内部迭代器，避免权限复核产生协议缺口或两个终态。

普通写作允许不使用 RAG；知识问答和“根据知识库撰写”的严格模式须使用有证据的策略。模式由服务端 Prompt 策略决定，不能由模型自行降级成无来源回答。

## 5. Checkpoint、取消与任务归属

每次 generate/resume 拥有自己的超时控制器、模型请求和局部缓冲；外部 AbortSignal 与 timeout 合并传递，迭代器 return、客户端断开、撤权和应用关闭都要释放资源。首次 SSE 断开时停止执行，确认执行退出后记录 interrupted，保留已落库 checkpoint；显式取消记录 cancelled，不能恢复。不会在无人管理的 Promise 中继续生成。

运行时不自动重试已经向用户输出的生成过程。未交付事件前的短暂错误可由应用按费用/幂等策略有限重试；恢复沿用原 requestId，重新生成使用新 requestId。供应商忽略取消时停止交付结果，并继续以受限方式收集实际计费用量。

运行时只负责一次执行或恢复；跨请求幂等、任务记录、主体/租户并发与额度、执行归属和审计属于应用。首次业务流由 Fastify transport 编码为 SSE；transport 负责背压、代理缓冲配置、心跳和响应关闭。慢消费者超过缓冲上限时停止执行并按中断处理。

### 5.1 最小持久化：一张业务表 + 四张官方表

AI 写作/关键词研究阶段新增五张 SQL 表；向量 RAG 后续仅加 document_indexes，累计六张 SQL 表，切片文本、向量和 ACL payload 存一个 Qdrant collection，不建 SQL document_chunks。checkpoint 继续复用 PostgreSQL，官方四表放在独立 `ai_checkpoint` schema。官方当前表结构见 [TypeScript saver migrations](https://github.com/langchain-ai/langgraphjs/blob/main/libs/checkpoint-postgres/src/migrations.ts)，实施时以锁定版本为准。

| 表                                    | owner              | 内容                                                       |
| ------------------------------------- | ------------------ | ---------------------------------------------------------- |
| `ai_runs`                             | 应用               | 授权归属、请求幂等、恢复输入、业务状态、最终提案和用量预算 |
| `ai_checkpoint.checkpoints`           | 官方 PostgresSaver | thread/namespace/checkpoint 身份、父检查点、图快照元信息   |
| `ai_checkpoint.checkpoint_blobs`      | 官方 PostgresSaver | 按 channel/version 保存的状态数据与序列化类型              |
| `ai_checkpoint.checkpoint_writes`     | 官方 PostgresSaver | 步骤内已完成任务的中间写入，供恢复时复用                   |
| `ai_checkpoint.checkpoint_migrations` | 官方 PostgresSaver | SDK 表结构迁移版本；整个 schema 共用，非每任务一份         |

保留官方四表及主键，不合并到 ai_runs.jsonb，不手写精简版 Saver。ai_runs 不复制 messages、虚拟文件、图状态、checkpoint_id 或逐 token 事件；最终提案另存是为了保持业务结果独立于 SDK 状态格式。具体字段和索引只在 [app-server 的 AI 表设计](../apps/app-server.md#91-checkpoint-的最小表设计待审) 维护。首期不拆 threads、tasks、proposals、task_events、usage_records、接受记录或 Store 表。

### 5.2 恢复与结果回读

1. 首次生成先插入 ai_runs，固定原请求、可信快照、目标修订、模型/策略/运行时版本及预算；取得唯一执行归属后，以 threadId 启动 Deep Agents。请求和 checkpoint 分属不同事务，不能假定原子提交。
2. 可恢复的传输/进程中断在确认旧执行退出后标记 interrupted；只有此状态可恢复。显式取消、超时/预算耗尽、撤权、无效结果和不兼容版本属于终止，不能借恢复绕过限制。异常退出后的 running 不因超时就直接启动第二个执行。
3. 恢复前重新验证任务主体、当前目标权限/版本、所有已读取来源与知识范围、配置兼容性和剩余预算。不能因 checkpoint 已缓存正文而跳过授权；来源或目标变化时保留可见草稿并终止旧任务，重新生成使用新 ID。
4. 读取同一 thread 最新状态；存在未完成步骤时，按 SDK 的恢复调用继续，不重发初始消息。没有可用 checkpoint 时明确无法恢复；已经结束的图只重新校验、编译最终提案并持久化，不再次调用模型。原快照与 baseStructureRevision 不刷新。
5. 最终结果和 completed 状态先以一次 ai_runs 条件更新提交，再交付浏览器。提案/operationId 按任务稳定分配或在最终提交时固定，避免“图已完成、业务结果未写入”时恢复生成不同操作。

首期恢复接口返回 202，由应用受管理的执行器续跑，客户端查询任务状态和最终结果；不再发第二条同 requestId 的 SSE 流。最终回读仍需授权，并复用共享提案/答案 Schema；不返回 checkpoint、内部推理或工具原文。这样无需 attempt 流标识、事件表或 token 重放。首期不建设通用排队系统，也不承诺重启后自动调度；interrupted 由用户显式恢复。

同一 thread 的发起、恢复与清理使用 PostgreSQL advisory lock 串行化，执行期间由明确 owner 持有锁；取消信号由该 owner 处理。PostgresSaver 自身不提供执行互斥或 fencing，ai_runs 的 attempt 条件更新也只保护业务终态。锁连接丢失时须中止旧执行，不能仅凭租约/心跳过期接管仍可能写 checkpoint 的旧实例；首期仅在旧执行已确认退出后恢复，网络分区导致归属不明时拒绝恢复。自动跨实例故障接管后置。

模型、搜索和读取的累计预算以 ai_runs 为准，在外部调用前原子预留，恢复时不重置；未知是否计费的调用保守占用预算。用量摘要服务于限额和观察，不是精确计费账本。checkpoint 不能保证外部模型调用恰好一次：调用已完成但写入未落库时可能重做；首期工具只读，文档写入仍在手动接受或本轮自动授权触发的独立幂等通道执行。

### 5.3 初始化、数据保留与兼容

官方 setup 只在显式部署/数据库初始化步骤执行，先完成应用 migration，再按锁定 SDK 版本在独立 schema 初始化/升级官方表；不在每次请求、普通服务启动或 OpenAPI 离线导出时建表。版本升级先备份并验证旧 checkpoint 兼容性，不兼容任务明确终止；应用恢复输入保留运行时/模型/策略版本引用，不静默套用新 Prompt。

checkpoint 可能保存模型消息、检索原文与研究笔记，须按正文敏感数据管理；不能再宣称开启 checkpoint 后服务端不落任何 Prompt/工具内容。密钥、Cookie、授权闭包和不可序列化资源不进入图状态，日志与对外结果继续过滤。ai_runs 仅保存有界原始请求/可信快照和配置版本，不再额外镜像完整 Prompt 或工具轨迹。

采用任务级 TTL，例如中断任务 24 小时、最终提案 7 天，可由部署收紧。先禁止新执行并确认 owner 退出，再调用 saver.deleteThread 清除该 thread 所有 namespace 的 checkpoint/blobs/writes，最后删除 ai_runs；迁移表保留。删除中断可重复清理，清理前不先删归属记录。暂不剪裁活跃 thread 的单个旧 checkpoint，避免删除仍被引用的 blobs/pending writes；不增加清理任务表。

初始预算建议：单次执行最长 120 秒，原任务累计模型调用至多 12 次、搜索至多 6 次、原文读取至多 6 次、单次输出最多 4,096 tokens、每主体一个在途任务。恢复仍受原任务的过期时间和累计调用/token 预算约束，超时已经终止的任务不能恢复。LangGraph recursionLimit 限制图执行步骤，不等于模型调用次数；模型、工具、子 Agent 的总预算需分别计数。参数在真实模型验收后收敛。

不将 SDK 内部推理、完整工具响应或研究笔记转发给浏览器；公开进度仅描述“规划/检索/阅读/生成”等阶段，文本增量只来自允许展示的草稿部分。只具备单次 JSON 返回能力的过渡实现必须明确标注，不冒充已实现流式协议。

## 6. app-server 接入

建议新增 `src/modules/ai`，按 route → controller → service 组装 runtime；应用 orchestration 与 rag 通过公开入口组合。数据留在 `apps/app-server/database`，不新增共享 database 包。

| 应用职责        | 具体要求                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------- |
| `ai.service`    | 分离资料与写入目标；验证本人个人空间、write/ai、模式、幂等/限额，装配历史/快照，交付前复核   |
| `ai.repository` | 只维护 ai_runs：幂等、归属、原始输入、状态/预算/提案/过期；官方 checkpoint 表交由 Saver 管理 |
| checkpoint 装配 | 创建 PostgresSaver、注入 runtime、管理连接/恢复互斥与 TTL；不额外封装通用存储框架            |
| `ai.schema`     | HTTP 外壳和 Zod route contract，引用 ai-contracts JSON Schema                                |
| transport       | 鉴权 fetch SSE、背压、心跳、断开中止；显式取消另走 cancel，不解析模型专属载荷                |

拟定配置为 AI_MODEL、AI_API_KEY、可选 AI_BASE_URL，以及超时、模型/工具调用数、输出和并发上限。模型须支持工具调用与选定的结构化输出策略；provider 由应用选用兼容的 LangChain 适配包。未配置时明确返回功能不可用，OpenAPI 离线导出仍不连接模型或数据库。密钥只进入服务端配置。

拟定接口为 `POST /api/ai/authoring`、`POST /api/ai/chat`、`POST /api/ai/answers`、`GET /api/ai/requests/:requestId`，以及任务的 `POST .../resume`、`POST .../accept`、`POST .../cancel`。创建接口校验后流式响应；重复创建不启动第二个模型请求或隐式恢复。GET 只返回授权后的业务状态及已完成结果；resume 只恢复 interrupted，同一任务重复请求不并发执行，返回 202/当前状态。取消幂等且只允许任务主体执行；执行未退出前保持 running 并标记取消意图，阻止交付，确认退出后再进入 cancelled。实际路径与响应以实现时导出的 OpenAPI 为准。

accept 接口属于应用业务，runtime 不执行它。应用在交付前保存校验后的不可变提案，将 requestId/proposalId 绑定确定的 operationId 与批次摘要；接受请求只引用登记提案，不允许客户端上传替换后的任意批次或刷新版本基线。服务端复核任务主体、本人个人空间、write/ai、当前目标及来源引用，在协同公开结构 owner 的同一受控顺序内核对原 generationId/durableSeq/baseStructureRevision 后执行，复用幂等落库与广播。该端口需在实现时从现有结构链路提取并补齐原子版本检查，不能先独立查修订再无保护提交，也不能绕过 owner 直接改表或 Y.Doc。

生成、恢复与任务回读均不改正文。逐段或批量确认由应用审阅用例处理，运行时保留原提案及不可变输入；只有本轮已知提交可推进后续审阅基线，外部编辑仍冲突。未知结果先查询原决定，不能依靠 checkpoint 重跑制造新批次。空间与事务规则见 [app-server](../apps/app-server.md#92-空间与写入策略2026-10-21-设计)。

接受归属绑定租户、主体和请求，跨主体共享提案首期不开放。同主体多会话或网络重复提交沿用相同 operationId；应用状态从真实结构操作回执派生，提交后崩溃仍可重试查得 accepted/duplicate。AI 任务与协议不进入 editor-collaboration 包，协同端口只接收通用结构命令。

重复接受先复核任务主体与当前访问权，再查询既有操作回执；已有成功结果直接返回，不因该次接受已经改变目标而误报冲突。只有尚未执行的批次才检查当前目标和结构修订。提案按受限保留期保存，过期未接受的提案只能复制或重新生成；任务记录的清理不得删除文档权威操作回执。

任务状态只记录 running/interrupted/completed/failed/cancelled；completed 只表示最终生成结果。应用提案与 durableSeq 使用现有结构操作回执，ai_runs 可记录关联的 operationId，但不再建立另一份接受记录或持久化回执表。

## 7. 建议源码、交付与验收

```text
src/
  index.ts
  authoring.ts
  answers.ts
  prompts.ts
  research.ts
  proposal-compiler.ts
  citations.ts
  errors.ts
```

AR-01：核对 Deep Agents/peer 兼容并完成模型桩、无知识库写作、输出校验和提案编译；证明使用真实 SDK 执行，而非仅安装依赖或直接绕过 harness 调模型。

AR-02：接入实际 searchKnowledge/readSource，验证多轮研究、补查缺口、真实引用、无证据、权限撤销和调用预算；首期关键词检索与后续向量 RAG 分别标注验收范围。结构化输出不支持时明确拒绝，不静默放宽验证。

AR-03：同一输入生成的提案只作用于声明目标，目标块以外内容保真；文档变化时保留草稿并阻止接受，失败不产生可接受结果，取消后没有事件继续更新 UI。指标只记录模型/Prompt 版本、阶段时延、安全错误码、token 和费用，不默认记录正文、Prompt 或完整 evidence。

AR-04：隔离 PostgreSQL 验证官方四表初始化、进程重启后显式恢复、工具中断与 pending writes、图完成但业务终态未提交、重复恢复互斥、锁连接丢失时拒绝不安全接管、来源撤权/变更、取消不恢复、累计预算和 TTL 清理。恢复后仍使用原目标修订，最终回读不泄露 checkpoint，已有结构命令保证接受幂等。

AR-05：Chat 有界历史、个人空间写入、逐段接受/拒绝隔离、批量处理跳过已决定项、持久恢复、外部编辑冲突、多标签页旧 revision 拒绝及回执丢失不重复提交。生成包测试不替代应用事务验收。

实现验收：运行 `pnpm test:ai`；设置指向隔离数据库的 `AI_TEST_DATABASE_URL` 后执行官方 PostgreSQL 集成测试。普通测试不初始化应用数据库，包不读取 .env、不安装全局模型凭据。应用验收 AR-04 中执行互斥、取消不可恢复、累计持久化预算和 TTL 仍由 app-server 完成。
