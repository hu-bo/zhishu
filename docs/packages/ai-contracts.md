# ai-contracts 设计规划

> 2026-10-24 包边界：协作 AI 写作的新会话、Run、审批与流协议由 [chat-contracts](chat-contracts.md)维护；本包继续承载文档目标、证据、引用、写作提案及既有任务契约。RAG Chat 保持 LangChain 和自己的 API，可复用证据/引用结构；共用 UI 不要求统一为 DSH 协议。写作迁移与边界见[总方案](ai-chat-architecture.md)。

状态：已创建 `@zhishu/ai-contracts` 工作区包，目录 `packages/ai-contracts`；[返回文档地图](../README.md)。已实现 TypeBox 请求/来源/提案/事件、受限提案与引用区间校验、流顺序/重复/大小校验及应用 OpenAPI/SSE 接入。2026-10-22 增加整篇改写意图 `rewrite-document` 与显式 `document` 目标；`isReplacementIntent` 统一识别整篇改写、段落改写与翻译，应用只允许用户主动确认。本文是 AI 请求、事件、提案与引用的规范源，接续原 DC-08 规划。

## 1. 职责与边界

写作插件通过 `ai-plugins/contracts` 复用本包文档/证据结构，基础 chat-ui 不依赖本包。新写作 ChatEvent 不在这里重复声明；RAG 现有请求/引用契约与旧写作 v1/v2 分别按业务需要保留，不把它们的 seq 重解释为 DSH 写作游标。

让浏览器、生成服务、检索服务与编辑器对同一项 AI 任务有一致理解。包只包含 TypeBox Schema、派生类型、语义校验与协议兼容判断，可用于浏览器和 Node.js，导入无副作用。

文档树、`DocumentSnapshot`、`Anchor`、`OperationBatch` 继续来自 `document-contracts`；AI 契约引用它们，不复制节点或操作定义。本包只定义知书需要的公开载荷，不复制 Deep Agents/LangGraph 的内部状态、消息和工具协议。文档持久化事件仍由 document-contracts 定义。身份、工作区、ACL、Prompt、模型配置、数据库、HTTP/SSE 编码不属于本包。

## 2. 入口与依赖

| 入口                          | 内容                                       | 依赖                        |
| ----------------------------- | ------------------------------------------ | --------------------------- |
| `@zhishu/ai-contracts`        | 请求、最终结果、提案、引用、验证与兼容接口 | TypeBox、document-contracts |
| `@zhishu/ai-contracts/events` | 版本化流事件 Schema、类型、流状态校验      | 同上，不引入传输库          |

根入口和 events 入口共用内部定义。类型从同一 TypeBox Schema 推导；JSON Schema 供服务端 OpenAPI 和模型输出约束引用，不另外维护 Zod 版 AI 载荷。HTTP 外壳、鉴权、分页与错误响应仍由 app-server 的 Zod route contract 拥有。

## 3. 公共数据形状

以下 TypeScript 展示拟定导出形状，实现时由 Schema 派生。`requestId` 标识一轮生成；取消后重新生成使用新 ID，checkpoint 恢复沿用原 ID 和不可变输入。网络重发沿用同一 ID，服务端按租户、主体、requestId 判定幂等并比对请求摘要，同 ID 不同输入返回冲突；发起会话作为任务元信息记录。requestId 不承担授权，也不替代 HTTP trace ID。threadId/checkpoint_id 属于服务端 SDK 装配，不进入公共请求。

```ts
import type { Anchor, OperationBatch } from "@zhishu/document-contracts";

export interface AuthoringDocumentVersion {
  documentId: string;
  generationId: string;
  durableSeq: number;
  contentHash: string;
}

export type AuthoringTarget =
  | { kind: "document" }
  | { kind: "selection"; anchor: Anchor; selectedTextHash: string }
  | {
      kind: "blocks";
      blocks: readonly { blockId: string; contentHash: string }[];
    }
  | { kind: "document-end"; afterBlockId: string | null };

export interface AuthoringRequest {
  kind: "authoring";
  requestId: string;
  intent:
    "create" | "continue" | "rewrite" | "rewrite-document" | "summarize" | "translate" | "research";
  document: AuthoringDocumentVersion;
  baseStructureRevision: number;
  target: AuthoringTarget;
  instruction: string;
  contextRef?: string;
  constraints?: { language?: string; maxBlocks?: number; maxCharacters?: number };
}

export interface AnswerRequest {
  kind: "answer";
  requestId: string;
  question: string;
  contextRef: string;
}

export type AiTaskRequest = AuthoringRequest | AnswerRequest;

export type SourceLocator =
  | { kind: "block"; blockId: string; start: number; end: number }
  | { kind: "page"; page: number; segmentId: string }
  | { kind: "section"; sectionId: string; start: number; end: number };

export interface SourceReference {
  sourceId: string;
  snapshotId: string;
  locator: SourceLocator;
}

export interface SourceCitation {
  citationId: string;
  source: SourceReference;
  quote: string;
}

export interface EvidenceItem {
  evidenceId: string;
  source: SourceReference;
  title: string;
  text: string;
}

export interface EvidenceBundle {
  items: readonly EvidenceItem[];
  freshness: "current";
}

export interface AuthoringProposal {
  proposalId: string;
  requestId: string;
  document: AuthoringDocumentVersion;
  baseStructureRevision: number;
  target: AuthoringTarget;
  operationBatch: OperationBatch;
  summary: string;
  citations: readonly SourceCitation[];
}

export interface AnswerResult {
  status: "answered" | "insufficient-evidence";
  text: string;
  citations: readonly SourceCitation[];
}
```

`contextRef` 只是应用解释的检索范围引用，客户端不能借它授予访问权限。服务端重新解析范围、来源版本和目标内容；请求里的版本、Hash 与锚点均为待核对的前置条件。

`rewrite-document` 与 `target.kind=document` 必须同时出现。整篇提案必须覆盖所有原顶层块的存在性前置条件，按原顺序替换重叠位置，再删除原文多余尾块或追加新尾块；禁止遗漏原块、删除后继续替换或夹带其他操作。输出限段落、标题和代码块，最多 256 个操作，至少保留一个结果块。请求固定整文 Hash 与版本，应用在生成前核对 Hash，接受时原子核对 generation/durableSeq/structureRevision。生成与预览不会写入，应用仅在用户确认后提交选中的受控子批次；原始提案不变。

Source 的 sourceId 在首期对应已有 documentId，snapshotId 由文档 generation、durableSeq、Schema 与摘要确定性编码产生；它们是版本引用值，不要求独立来源/快照表。引用打开时检查当前权限与版本；来源已更新则提示变化，需要精确历史回看时复用既有文档历史能力。PDF 等外部来源以后再扩展，snapshotId 不是下载 URL，也不等于索引构建版本。

Block/section 区间为对应快照规范化文本的 UTF-16 半开区间 `[start, end)`，与编辑器 token 数、ProseMirror 位置区分；转换器维护原始定位映射，禁止将生成文本的偏移冒充原文位置。PDF 页码从 1 开始，segmentId 由解析结果分配。

## 4. 流协议 v1

所有事件包含 `protocolVersion: 1`、`requestId`、从 1 开始连续递增的 `seq`、`type` 与 `payload`。事件为按 type 区分的 Schema 联合，不接受任意 object。

| type         | payload                    | 规则                                                |
| ------------ | -------------------------- | --------------------------------------------------- |
| `started`    | `kind`                     | 第一条事件，仅一次                                  |
| `progress`   | `stage`                    | 可选规划/检索/阅读/生成阶段，不含内部推理或工具原文 |
| `text-delta` | `text`                     | 只更新临时预览，不表示正文或引用已验证              |
| `proposal`   | `AuthoringProposal`        | authoring 成功流的唯一最终提案                      |
| `answer`     | `AnswerResult`             | answer 成功流的唯一最终结果                         |
| `completed`  | `resultKind`、可选安全用量 | 最终结果验证成功后才允许发送                        |
| `failed`     | `code`、`retryable`        | 安全错误终态，不含供应商原文                        |

合法成功顺序为 `started → (progress | text-delta)* → proposal/answer → completed`。无证据问答可直接产生 insufficient-evidence answer，再 completed；普通写作允许无来源生成，但必须标明没有知识证据。research 先取得证据，再产生带引用的最终提案；失败返回 INSUFFICIENT_EVIDENCE。

每轮最多一个最终结果；结果之后不再发 delta。流客户端收到匹配的 completed 才确认最终结果；另一条合法完成路径是授权任务回读返回 status=completed 和通过共享 Schema 校验的完整 result。HTTP 任务响应由应用 Zod route contract 定义并引用本包的提案/答案 Schema，无需另造 SDK 状态对象。断流、取消或 failed 后保留预览供恢复，但不能应用未完成候选。应用在第一次读取字节前失败时使用正常 HTTP 错误；流开始后由运行时映射为 failed。

接收端按 `(requestId, seq)` 去重；已见事件的载荷摘要必须一致，重复序号不同载荷是协议错误。未声明重放能力时，序号缺口、倒序和 EOF 无终态均表示当前流不完整。v1 不提供事件重放；Agent checkpoint 恢复使用独立 HTTP resume 请求和最终任务回读，不开第二条同 requestId 的 SSE，不重置 seq 拼接草稿，因此不增加 streamId/attempt 或事件表。后续若增加流重放，必须同时定义保留窗口、授权、游标与最终结果回读，不能只添加 Last-Event-ID。

## 5. 校验与兼容

| 接口                                        | 作用                                                     |
| ------------------------------------------- | -------------------------------------------------------- |
| `validateAiTaskRequest(value, limits)`      | 结构、大小、intent/target 组合与版本字段校验             |
| `validateAuthoringProposal(value, context)` | 目标范围、generation、操作数、Hash、扩展、来源白名单校验 |
| `validateAnswerResult(value, evidence)`     | 引用归属与原文一致性、无证据结果校验                     |
| `createAiEventValidator(options)`           | 跨事件顺序、去重、终态和累计大小验证                     |
| `checkAiProtocolCompatibility(version)`     | 明确接受或拒绝协议版本                                   |

验证函数接收 `unknown`，返回判别联合 `{ success: true, data }` 或 `{ success: false, issues }`；issues 只含稳定 code、path 和安全说明。内容语义校验复用 document-contracts，不以 TypeBox 形状校验替代节点能力与资源检查。`context` 由调用者提供可信目标、可用扩展和本次 evidence，不从 proposal 自证合法。

AI proposal 强制要求 OperationBatch.generationId 与目标一致、origin 为 ai-accept、非空合法操作、既有目标/邻接块存在性条件，以及与请求一致的 baseStructureRevision。应用接受设计同时固定 document.generationId、document.durableSeq 与 baseStructureRevision，在 owner 内原子检查后写入；仅固定结构修订无法保证识别普通文本冲突。接受与重试不得刷新这些前置条件。contentHash 只有在服务端已提供一致 Hash 校验能力后才加入操作前置条件，不能把尚未实现的校验当成保证。禁止模型自选 documentId、operationId、Block ID、资产 ID 或任意删除/移动范围；由运行时按受信输入编译。

首期上限作为可收紧的默认值：指令/问题 8,000 字符、最终输出 64 KiB UTF-8、事件 32 KiB、累计流 1 MiB、256 个操作、32 条引用；字符限制不能替代 UTF-8 字节、节点深度和模型 token 预算。模型端请求上限与校验端限制保持一致。

错误码至少包含 `CANCELLED`、`TIMEOUT`、`RATE_LIMITED`、`MODEL_FAILED`、`INVALID_OUTPUT`、`INVALID_CITATION`、`INSUFFICIENT_EVIDENCE`、`TARGET_CONFLICT`、`ACCESS_REVOKED`、`UNSUPPORTED_TARGET`、`PROTOCOL_ERROR`；UI 文案由宿主按 code 映射。research 未取得有效证据时明确返回不足，不生成无来源的可接受报告。

协议版本、npm 版本、Document Schema 版本分别维护。引用在首期只存在提案/问答结果；接受正文时可转成安全的普通链接并说明来源信息降级。若要持久化带来源元信息的 Node/Mark，必须先完成 document-contracts、转换、协同和服务端校验升级。

## 6. 建议源码与验收

```text
src/
  index.ts
  requests.ts
  proposals.ts
  sources.ts
  events.ts
  validation.ts
```

AC-01：从 TypeBox 派生 TS/JSON Schema，在 Node 和浏览器消费；导入图无模型 SDK、React、Yjs 或应用代码。

AC-02：统一覆盖请求、最终结果和事件流的边界验证，包括跨请求事件、重复内容不一致、序号缺口、无终态、超限、伪造引用、错误代次和不支持的节点。无效载荷不能进入编辑器。

AC-03：OpenAPI 离线导出引用同一 Schema，并在导出过程中拒绝未解析 `$ref`；前端普通 HTTP API 继续由 Orval 生成，SSE 消费复用此事件合约。

## 7. Chat 与写入模式扩展（2026-10-21 设计）

2026-10-21 首批代码已实现独立的 ChatRequest / ChatResult、AiTaskRequestV2Schema、AiTaskEventV2Schema 与校验器，保留 v1 的原有形状和类型。当前 AnswerResult 是有证据知识问答，`answered` 仍必须有真实引用。应用 Chat API、历史任务归属/TTL 校验及模型执行尚待实现。

独立 ChatRequest / ChatResult：

| 合约        | 主要字段与规则                                                                                                                                                                    |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ChatRequest | `kind=chat`、requestId、message、可选 contextRef、可选 previousRequestIds（有序、唯一、最多 16 个，不能引用本轮），以及 responseMode=discussion/grounded；grounded 必须有知识范围 |
| ChatResult  | replied/insufficient-evidence、text、citations；普通讨论可无引用，基于知识的回答要求有效证据，不足时明确说明                                                                      |
| 历史输入    | 只提交历史任务引用；服务端从同主体、已完成且未过期的任务解析有限上下文，并复核资料权限；不接受客户端自报的 assistant、system、tool 消息或 evidence                                |

每轮对话建立新 requestId，与单轮 checkpoint 恢复区分。Chat 结果不是 AuthoringProposal，没有 operationBatch；选择“用于创作”后须新建 authoring 请求、捕获合法个人文档版本并重新编译，不能把聊天文本直接作为结构操作接受。

Chat 接入使用支持 chat kind、最终 chat 结果及顺序校验的协议 v2，仍需应用能力声明/请求协商。`createAiEventValidator({ requestId, protocolVersion: 2 })` 显式选择 v2，省略版本仍只接受 v1；`checkAiProtocolCompatibility(2, [1, 2])` 显式声明接收版本。v1 保持原有 authoring/answer 联合，不能在 protocolVersion=1 下发送未知 chat 事件、把普通回复伪装成 answer 或更改终态语义。authoring 现有 v1 可继续独立使用；Chat 客户端与服务端都支持新协议后才开放页面入口。v2 同样要求完整结果后 completed，未知版本失败关闭。

2026-10-22 删除写入模式。生成只产出建议，应用通过显式用户决定写正文；HTTP 不再包含 writeMode。ReplacementReview 定义 revision、decisions、version、structureRevision；replacementChanges 提取有变化的稳定块，replacementBatch 从可信原提案及当前基线编译选中操作，支持逆序接受尾段而不改变结果顺序。权限、事务和幂等凭据仍由应用服务负责。

创作需要承接已有对话时，HTTP 外壳可另带有界 previousRequestIds，按 Chat 相同归属、过期和权限规则解析；不让客户端将对话拼成可信 Prompt 或绕过 instruction 大小限制。该字段计入任务输入摘要，通用 AuthoringRequest 保持现有定义。

生成完成、正文应用、持久化是三组状态。completed 仍只结束生成，不能在其后继续发送应用事件；应用状态和回执由 app-server Zod route contract 定义，引用本包结果 Schema，并由任务查询接口返回。审阅冲突不篡改成生成失败，未知回执也不宣告已保存。

包级回归覆盖普通无引用 Chat、知识证据不足和伪造引用、历史引用形状/上限、v1 兼容、跨版本、缺失终态、重复事件与流大小限制。历史任务的过期/撤权、跨主体拒绝、逐段/批量决定的隔离、持久化及幂等性仍需应用链路验收。可运行 `pnpm --filter @zhishu/ai-contracts build` 后执行 `pnpm --filter @zhishu/ai-contracts test`；根命令 `pnpm test:ai` 也包含本包测试。
