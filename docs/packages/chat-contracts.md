# chat-contracts 设计规划

状态：2026-10-24 已实现 TypeBox Schema、派生类型、命令边界、快照/实时 frame 与事件归并。当前 durable wire 使用完整 snapshot 事件；细粒度事件是后续目标。见 [实施记录](ai-chat-implementation.md) 和 [包 README](../../packages/chat-contracts/README.md)。

**原设计时状态（已由上方实施更新覆盖）**：2026-10-22 新增方案，尚未创建 `packages/chat-contracts`。拟定包名 `@zhishu/chat-contracts`。[总方案](ai-chat-architecture.md)；[返回文档地图](../README.md)。本文定义通用产品协议，文中的类型名是拟定接口，不是已实现导出。

## 1. 目标与边界

2026-10-24 范围明确：本次先为协作 AI 写作定义会话、Run、审批和流协议，纯内容/引用类型保持与引擎无关。RAG Chat 继续使用 LangChain 及自己的问答 API；RagChat 可以映射答案和来源到同一基础 UI，不因复用组件而必须切换 wire 协议、实现 DSH 审批或具备相同恢复能力。

为写作前端与服务端提供明确会话协议，并提供可按需复用的纯数据类型；基础 UI 不要求所有后端实现全部写作命令。采用仓库既有 TypeBox Schema 与派生类型，支持浏览器和 Node.js，无导入副作用，不依赖 React、DSH、文档编辑器、数据库和 HTTP 框架。

现有 `ai-contracts` 继续定义 EvidenceBundle、SourceCitation、AuthoringProposal、ReplacementReview 和文档目标。通用对话不因使用文本、工具或图片而安装文档 Schema。写作/研究产物通过有版本的插件载荷引用 ai-contracts，不复制其字段与校验。

## 2. 功能与入口

| 编号  | 能力                       | 约束                                           |
| ----- | -------------------------- | ---------------------------------------------- |
| CC-01 | Conversation、Message、Run | 业务身份与执行状态分离；标识不能互换           |
| CC-02 | 内容块和产物引用           | 文本、图片、工具、错误、插件内容；支持降级     |
| CC-03 | 产品持久化事件与快照       | 顺序、游标、重复检测、恢复和终态校验           |
| CC-04 | 实时预览 frame             | 不声明 durable；按 attempt/revision/index 归并 |
| CC-05 | 审批与能力声明             | 单次决定、取消/过期反馈、服务端能力限制        |
| CC-06 | 版本与安全边界             | 输入/大小/事件校验；未知命令拒绝               |

拟定入口为根入口的数据 Schema/类型、`./events` 的事件与归并前置校验、`./validation` 的纯校验。Schema 只维护一份，OpenAPI 引用共享结构；应用 Zod route contract 负责路径、鉴权外壳、分页、状态码和 HTTP 大小限制。

## 3. 公开模型

| 模型              | 关键字段                                                  | 语义                                               |
| ----------------- | --------------------------------------------------------- | -------------------------------------------------- |
| Conversation      | id、title、revision、createdAt、updatedAt                 | 用户可访问的一段对话；身份归属由应用存储           |
| Message           | id、conversationId、role、parts、status、runId、createdAt | user/assistant/tool 消息；内容不含模型凭据         |
| Run               | id、conversationId、inputMessageId、mode、status、attempt | 一次生成，模式为 chat 或注册插件 ID                |
| ArtifactReference | id、kind、schemaVersion、summary                          | 文本外的可持久化结果；详细载荷由插件契约校验       |
| Approval          | id、runId、toolCallId、action、status、expiresAt          | 待决定动作的安全展示投影，引用服务器保存的原始请求 |
| ChatSnapshot      | conversation、messages、runs、approvals、cursor           | 一致性快照，消息分页单独声明覆盖范围               |

`id` 为不透明字符串，`createdAt` 等时间采用 ISO 8601 UTC。所有可传输扩展载荷是有界 JSON；不使用开放的 `any`。引擎原生 Agent、Context、Session、AbortSignal、Promise 和 provider 错误不进入协议。

Run 状态为 `queued → running → waiting-approval/running → completed/failed/cancelled/interrupted`；恢复从 interrupted 重新进入 queued/running，attempt 增加。连接状态不是 Run 状态。Agent 的 idle/running 不能直接推断业务成功；完成必须有已确认输出与持久化结果。provider 副作用结果未知时使用 interrupted 与明确的结果未知错误码/恢复能力，不在状态未明时提供盲目重试生成。

Message 状态区分 pending、streaming、committed、failed、cancelled。消息一旦 committed，以明确修订事件变更；不能继续追加旧 attempt 的 delta。

## 4. 输入与幂等

拟定 `SubmitChatMessage` 包含 `clientMessageId`、`idempotencyKey`、文本/资源引用、模式、受支持插件的版本化参数。`conversationId` 可由路径指定。用户消息、请求大小、资料/附件数量与插件参数均验证上限。

同一会话和主体下，相同幂等键与相同摘要返回原 RunReceipt；相同键不同输入返回冲突。写作服务端生成 Run ID，在 dsh-agent adapter 内建立 DSH Session ID 与 turn 绑定；这些原生关联不作为 RAG 接口字段。重发不追加第二条用户消息；重新生成建立新 Run 并记录来源消息。浏览器不提交任意 Session 日志、工具执行权限、系统 Prompt 或 SDK 恢复状态。

附件输入是引用，不是“已经授权”的证明。文件上传完成前的本地 File 与浏览器 object URL 只属于输入草稿，提交时需先获得宿主资源引用。

## 5. 持久化事件与实时 frame

### 5.1 事件信封

拟定持久化 `ChatEvent` 包含 `protocolVersion`、`eventId`、`conversationId`、`runId?`、`sequence`、`occurredAt`、`type`、`payload`。`sequence` 使用十进制字符串，由服务端在会话维度分配；客户端不能用字符串字典序比较。cursor 是服务器签发/验证的不透明恢复位置，不混用 DSH 原生 seq。

持久化事件包括 conversation.updated、message.accepted、message.committed、run.updated、tool.settled、approval.requested、approval.resolved、artifact.committed。工具开始等实时状态可以采用 frame，只有进入产品 outbox 后才能携带持久化 sequence。

同一会话序号严格递增；相同 eventId/sequence 的重复内容忽略，不同内容视为协议损坏。发现断档时获取快照或补事件，不能把不完整状态当成成功。终态确认在相关 Session flush 与业务提交成功后发布。

### 5.2 实时 frame

`ChatLiveFrame` 不带持久化 sequence/cursor，包含运行实例标识 `streamEpoch`、runId、messageId、attemptId、revision、index 和明确类型的内容。支持 assistant.started、assistant.delta、assistant.reset、tool.progress、plugin.progress 等类型。

revision 标识一次活跃流替换，index 在 attempt 内连续。旧实例、旧 attempt 或重复 index 不再追加。断档或 reset 使当前预览失效，转向快照/确认消息。`message.committed` 用完整权威内容替换预览，不在 delta 尾部重复拼接完整文本。

### 5.3 订阅与快照

`ChatFrame` 是持久化事件、实时 frame 和控制帧的判别联合。控制帧包括 ready、heartbeat、resync-required、access-revoked、stream-error。heartbeat 不改变恢复位置。

重连以当前权限获取快照 cursor，再订阅之后的确认事件。快照和订阅必须具有同一恢复屏障，防止两次读取之间漏事件。实时 token 丢失允许回退到最近确认结果；若支持活跃预览快照，必须同时给出 streamEpoch/attempt/revision/index 水位。未实现活跃预览快照时明确显示恢复中，不用旧 token 拼新流。

## 6. 审批与错误

浏览器提交 `approvalId`、`decisionId` 和 allow-once/reject，不回传可修改的工具参数作为执行依据。服务端校验当前主体、Run、请求版本、有效期及 owner attempt；重复 decisionId 返回已有决定。前端显示 pending、submitting、allowed、rejected、cancelled、unavailable、expired 等投影状态。

DSH outcome 由 adapter 转换：`allowed-once` 是单次许可，其他结果都不执行请求动作。产品 expired 是展示状态，不伪装成 SDK 新 outcome。通用 UI 不提供 DSH 未支持的 allow-always 或永久授权按钮。

错误信封包含 code、用户可读 message、retryable、可选 requestId；不包含 stack、SQL、模型密钥、原始 provider 响应或完整 Prompt。重新订阅、重试生成、恢复原 Run、重试产物动作是不同命令，不能共用一个含糊的 retry。

## 7. 插件内容与兼容

插件内容使用 `kind + schemaVersion + 有界 JSON payload + fallbackText`，由 ai-plugins 的纯契约入口注册校验。引用资源必须是宿主签发的 ID，Markdown 中不直接持久化短效下载 URL。

未知插件或载荷版本显示 fallback 和“不支持此结果格式”，禁止执行未知业务动作。未知执行命令、未知审批决定和结构不合法事件拒绝。协议升级说明旧客户端行为；现有 AiTaskEvent v1/v2 保留旧端点，新协议不重新解释其 seq 或 completed。

## 8. 质量与交付

| 阶段  | 验收                                                                   |
| ----- | ---------------------------------------------------------------------- |
| P1    | Schema/类型一致、浏览器/Node 导入、幂等字段、完整消息和实时 frame 样例 |
| P2    | 重复/乱序/断档/旧 attempt、快照屏障、取消与终态、审批过期/重复决定     |
| P3—P5 | 三类产物 Schema、未知版本降级、引用与现有 ai-contracts 校验联动        |

独立消费者只安装构建后的 chat-contracts 即可验证示例 JSON；不需要 DSH、React 或 document-contracts。实现时补协议 fixtures 和一次覆盖关键状态迁移的综合测试，避免维护手写的平行类型。
