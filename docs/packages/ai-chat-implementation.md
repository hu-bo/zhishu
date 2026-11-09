# AI Chat 实施记录（2026-10-24）

> 2026-10-30 知识检索新增了应用索引 Worker 和空间/文档向量问答。配置启用后 RagChat 的 grounded 请求使用 query Embedding → Qdrant → 当前 ACL/版本复核 → LangGraph 回答；未配置时 UI 明确禁用知识问答。原显式文档上下文 API 保留兼容。详见 [本轮验收记录](../ai-knowledge-verification.md)。

> 2026-10-30 已依据当前源码重新核验并修复生命周期及实时预览问题，见文末复核记录。10-24 的验收属于历史记录，不能当作本轮所有环境已经再次验收。

本记录区分实际代码、确定性验收和需要真实 provider 的验收。原架构文档中的阶段表继续作为目标清单，不表示每项均已完成。

## 已接入的调用链

- WritingChat：`components/writing-chat` → Orval 命令客户端 / 独立 SSE transport → `/api/writing` → `WritingService` → `@zhishu/dsh-agent` → 官方 Cordis、Agent Registry、Agent Loop、Session、Tools、LLM、Approval、Persistence、Checkpoint Policy、SessionProjectionRegistry。
- RagChat：`components/rag-chat` → 原 `/api/ai/chat` → `createChatRuntime` → LangChain / LangGraph / PostgresSaver。检索包、模型依赖、历史、取消与原 checkpoint 恢复均保留。当前应用问答使用授权所选资料；不声称新增了全库向量问答入口。
- 文章提案：原 `/api/ai/authoring` 的新任务记录 `input.engine=dsh-v1`，通过同一个 DSH runtime 执行 writing/research 工具。编译器迁至 `ai-plugins/writing`，旧编译器入口重导出。提案仍由原 AiService 接受/逐段审阅，经权限、代次、Hash、Block ID、结构修订与协同 durable ack 确认。
- 两种业务分别拥有缓存、草稿、查询键和 transport；共用 `@zhishu/chat-ui` 的受控组件。未创建 chat-react 或通用切换引擎控制器。

## 包和协议

`chat-contracts` 提供 TypeBox Schema、派生类型、输入边界、完整快照、实时文本 frame 与序列归并。首期 durable outbox 使用带 sequence 的完整 `snapshot` 事件，采用整体替换，不将 token 或 Agent idle 视为成功。细粒度 message/tool/artifact 事件仍为后续协议演进目标。实时 frame 带 conversation/run/attempt/epoch/revision/index，过滤私有推理、Prompt 和原始工具参数。

`chat-ui` 实际导出 Chat、MessageList、MessageParts、Composer、AttachmentList、ChatStatus、ApprovalCard、ArtifactCard 与纯视图类型。文本、代码、图片、工具、错误和宿主插件内容由 MessageParts 呈现。CSS 单独导出，具有作用域和主题变量，不要求宿主扫描 Tailwind；没有业务 API 或存储。

`dsh-agent` 实际提供 createDshRuntime、createSession/restoreSession、submit/snapshot/observe/cancel/resume/decide/dispose。官方增量投影读取输入、turn 终态、可见文本、工具事实与插件记录；新增实现不调用废弃的同步历史扫描 API。应用队列只负责有界准入与单 Run 投递，模型/工具迭代全部由官方 Loop 执行。

示例 `examples/chat-consumer` 为纯受控视图 fixture；`examples/dsh-consumer` 使用真实官方 Loop、确定性 adapter 和显式内存宿主。二者不是收费模型或生产存储演示。

## 持久化、取消和恢复

数据库新增 migration 0034、0035；未改写已发布 migration。新增 writing_conversations、writing_events、writing_sessions、writing_image_jobs，RAG checkpoint 表不变。

官方 provider 通过 create/open 获取写句柄；PostgreSQL advisory lock 与专用连接保证跨实例单写者。`session/event` 追加到对应写句柄，`session/flush` 等待 append 链和真实提交。连接丢失/追加错误会使句柄失效；不跳过坏日志、不吞掉 flush 错误。产品状态与 outbox 在同一事务提交，以 cursor 条件防止过期写者。

产品先持久化初始化状态和官方消息投递身份，再投递 inbox；恢复检查原生是否创建、输入与 turn 的关联以及原生终态。已经原生完成但产品提交失败的输出，在新进程中重新 flush 并提交投影，不再次调用模型。未完成状态为 interrupted；含工具调用的未知副作用不自动重放，返回 SIDE_EFFECT_REVIEW_REQUIRED。恢复不是 token 断点续传。

HTTP snapshot 与 SSE outbox 均只暴露已提交的产品快照；原生投影在提交前更新的 turn 关联不会通过读取接口泄漏，避免同一 cursor 对应不同内容。此边界有专门的输入认领并发回归用例。

写作 SSE 断开只释放订阅，显式 cancel 才取消该 Run。旧 authoring SSE 也改为后台执行 owner + 有界订阅；RAG 保留原实际断线/取消/恢复语义。应用关闭会先撤销 SSE 订阅，再取消/排空自有会话；取消一个会话不会释放 root Context。

默认每会话最多 4 个未终结请求、128 条历史消息、12 次模型调用、128KB 模型输入/输出字节边界和配置的 deadline；订阅最多 8 个，队列/背压有界。应用另设写作 Chat 全局与主体准入，并保留原 AI task 准入。空闲句柄回收，启动时用写锁识别孤儿 Run。跨实例执行命令暂需路由至持有会话的实例，冲突返回 409；未增加进程 broker 或每用户进程。

## 插件

writing 使用原内容契约编译草稿，官方 Session 保存版本化插件产物。生成完成不修改正文；重复接受、部分接受、冲突与未知 durable ack 继续由原业务事务处理。

research 在同一个写作 Agent 中提供 search_sources/read_source，逐次复核授权版本并预留预算。研究提案只允许引用实际读取登记的证据。当前来源为所选知识文档的有界关键词检索；没有配置网页来源，不声称互联网或新向量检索能力。

image 使用独立 AI_IMAGE_MODEL / AI_IMAGE_API_KEY / 可选 AI_IMAGE_BASE_URL，按 [官方 Images API](https://developers.openai.com/api/reference/resources/images/methods/generate) 实现 HTTP PNG 创建适配。每次一张 1024×1024 PNG，费用动作经过官方单次审批，先 flush 审批审计再投递。任务预先记录未知状态；超时结果未知时阻止盲目再生成。返回的有界图片先保存在私有任务记录，落入私有对象存储后才成为 ready 资源；存储失败可用 refresh 重试落盘，不再次请求 provider。聊天日志和 outbox 不含长 base64、provider 密钥或临时签名 URL。授权预览每次解析签名 URL。未同时配置 provider 和私有存储时不注册创建工具，UI 明确不可用。当前只提供授权预览，不提供直接插入正文按钮；参考图、更多尺寸、远端取消/费用撤销不属于当前能力。

## 兼容

- 保留 v1/v2 task API 和已存结果；没有 engine 字段的旧 authoring 任务仍按原 LangChain checkpoint 回读/恢复，不转换为 DSH Session。
- RAG 不采用写作 Run/审批/Session 恢复协议。RAG 结果转写作只传文本与来源引用，新请求重新验证来源与个人文档目标。
- 老 `ai-draft/current` 在没有新写作草稿时只作为兼容读取来源；新草稿按业务、身份和上下文隔离写入。
- 页面资料选择和当前业务入口按身份、来源空间与入口上下文保存，恢复完成后才装配业务 Chat；两种 Chat 各自维护 IndexedDB 草稿，并在切换和 pagehide 时同步发起最终写事务。RAG SSE 使用独立 v2 task adapter，仅与写作共用无业务的 SSE 分帧函数。
- 包保留 private，未发布 registry；来源与上游 MIT 记录见各包 UPSTREAM。仓库没有明确的对外许可证，未擅自授予项目许可。

## 验证与剩余边界

已运行真实官方 Loop 的确定性测试：多轮流、幂等、不同主体隔离、单次审批、取消、订阅断开、max-tokens、native flush 和产品提交失败、官方历史恢复。一次性 PostgreSQL 应用验收覆盖写作/研究提案、真实 HTTP/SSE/WebSocket、来源撤权、协同冲突、重复/逐段接受、未知 durable ack、RAG 原取消及 checkpoint 恢复。独立 Node 子进程验证正常重启和模型调用被杀后的原 Run 恢复。图片通过本地 HTTP 协议 fixture + 一次性 MinIO 检查审批、落盘失败缓冲/重试、私有授权和不重复生成。

验证使用显式测试配置，不迁移现有 zhishu 数据库，不调用收费模型。实际 DeepSeek/其他文本 provider 的可用性和生成质量、真实收费图片账户、网页研究、生产多实例路由/高负载、不同外部 provider 的取消和幂等保证仍需单独验收。fixture 或包测试不代表这些项目已完成。

具体检查记录：

- `pnpm test:ai`：33 项通过、0 跳过。包含 chat-contracts 1、ai-contracts 6、ai-plugins 1、dsh-agent 7、rag 9、ai-runtime 9。使用一次性 PostgreSQL、Qdrant 和真实 PostgresSaver；模型 adapter 为显式确定性实现。
- `pnpm --filter @react-fastify-template/app-server smoke:ai`：通过，含 HTTP/SSE、写作与 research、原 RAG、正文 durable ack、进程重启、终态产品事务失败和图片私有存储场景。
- `pnpm check`：格式、lint、类型、全部构建、OpenAPI 与 Orval 漂移检查通过。浏览器验收发现的上下文恢复修复后，补跑前端 build、lint、格式和 API 漂移检查。
- `pnpm check:ai-packages`：六个 tarball 在独立临时目录安装，公开类型、SSR、CSS、纯插件入口与官方多轮内核消费通过；没有依赖仓库源码路径。
- Playwright：实际应用两轮写作、RAG 来源引用、往返切换草稿隔离、输入法组合期间 Enter、刷新恢复，以及 390×844 深色移动端检查通过。截图在 `output/playwright/ai-chat-*-final.png`。清洁加载没有运行时错误；沿用界面仍有 3 条 HeroUI PressResponder 警告。开发时并行生成客户端会产生临时 HMR 404，完成生成后重新加载并验收。

本次只在自建一次性数据库执行新增 migration，未部署或迁移现有业务数据库。仓库原有未提交工作保留；包保持 private，技术独立消费验收不代表已经发布或取得项目对外许可。

## 旧逻辑收敛（2026-10-24）

- 删除原 `ai-client.ts`、`ai-message-card.tsx`。`proposal-client` 只发送 authoring，`proposal-result` 只渲染提案和审阅动作；共享 Chat/MessageParts 负责消息外壳，Composer/AttachmentList 负责输入、输入法、发送/停止和资料标签，MessageList 负责滚动。
- 删除创作页的旧 Chat 创建/重新生成分支、自有 SSE 分帧、消息滚动和输入法事件，以及新任务中重复保存的 token 预览、阶段文案。删除与 intent 重叠的 mode 状态，research 成为明确的写作动作。结果从已保存的任务读取；旧未完成预览仍可兼容读取。
- 本轮 `features/ai` 全目录由 2124 行降至 1879 行，主页面由 1275 行降至 1100 行。保留的逻辑是文档选择/创建、权限与版本捕获、提案请求、协同审阅、冲突和 durable ack；没有通过拆分文件转移行数。
- 新提案缓存写入 `writing-proposals-v2`。旧混合缓存保持原样只读：提案只恢复 authoring，RagChat 在全局问答入口恢复旧 Chat 引用，并独立写入自己的缓存。新 HTTP 请求不能把另一业务的任务用作 previousRequestIds；显式转写作继续创建新请求并重新授权。
- DSH 未装配时直接失败，禁止静默回退。LangChain 写作图仅在恢复历史任务时动态加载，应用不再调用它的 generate。新写作使用精简 WritingExecutionPolicy，AuthoringInput 复用 WritingInput；RAG、历史写作、编译器和错误均有独立公开子路径。
- smoke 脚本现在要求显式 `AI_TEST_ADMIN_DATABASE_URL`，支持无数据库副作用的 `--help`；未知参数在连接前失败。本轮一次误传 `--help` 曾导致旧脚本连接默认地址，创建测试库被数据库权限拒绝，没有产生变更；后续测试全部使用自建一次性 PostgreSQL。

本轮验证：16 项契约/插件/运行时测试通过且无跳过，包含真实 PostgreSQL checkpoint；扩展应用 smoke 验证新写作 DSH、跨业务历史拒绝、旧图完成后产品中断的恢复不再次调用模型，并重跑原 RAG、提案接受、取消、重启和持久化失败。浏览器验证共享提案组件的输入法、生成、差异、接受、整篇替换、旧混合缓存分别恢复到两类业务，以及移动端深色布局。没有收费模型调用，也没有修改业务数据库。

完整 `pnpm check` 通过，包含 lint、类型、全部应用/包/示例构建、OpenAPI 与 Orval 漂移；`pnpm check:ai-packages` 扩展至 7 个包，验证新公开子路径和 Composer maxLength 的独立消费。浏览器清洁加载没有运行时错误，仍可见原 HeroUI/linkify 警告。旧 task API 的 supportsTokenPreview 已改为 false，当前提案交付完整保存结果；WritingChat 自身的实时文本流保持原有协议。

## 源码复核与补齐（2026-10-30）

本轮开始时已存在完整度较高的四个包、两个应用业务组件、DSH/PostgreSQL/HTTP/SSE 和插件实现，以及未提交的旧写作逻辑收敛。本轮保留这些改动，以真实源码及执行结果核验，没有重新搭包骨架，也没有迁移 RAG 引擎。

重新阅读本地官方 Agent Loop、Session、Persistence、Tools、LLM、Approval 和官方 testkit，并核对已安装的锁定发布包公开入口/声明。直接运行 `kernel-probe.mjs`，验证两轮真实官方 Loop 的输入、流、原生 turn 完成和独立句柄释放。确定性 adapter 只用于显式测试，没有收费调用。

实际修复：

- 发布包的原生 revision 每 frame 增长，原实现直接透传会把每段文本当作新流；现在按原生 attempt 固定产品 revision，并对过滤私有推理后的公开文本生成连续 index。WritingChat 处理重复、旧 revision、缺前缀和断档；不完整预览等待保存后的完整消息。
- 完整 HTTP 快照按 cursor 单调合并，较慢的命令/查询响应不再回退已经收到的 SSE 状态；确认消息和 Run 不允许被后续快照无声移除。共享契约新增 applyChatSnapshot、isApprovalDecision、可选 cancelRequested，并自动更新 OpenAPI/Orval。
- 显式取消先持久化意图，再调用官方 Agent.cancel；重启不会把该请求恢复成生成。原生已明确的 blocked/error/max-tokens 保持失败。投影通过公开 inbox splice 关联在 user/message 之前就被拒绝或失败的输入。
- 已释放会话拒绝命令；runtime 关闭屏障重新检查异步授权后的 attach，防止 shutdown 后建立孤立句柄。resume 也检查队列及应用并发准入。
- 实时订阅立即处理拒绝，超限不会产生未处理 Promise。活跃 SSE 保留其观察句柄，最后一个订阅离开后才允许空闲回收；客户端发送受理后重新建立订阅。浏览器发现的“空闲后第二轮已保存但不再更新界面”窗口据此修复。
- 写作句柄数同时受实际写作连接池约束，预留临时查询连接；保留原本独立的 writing pool、任务锁池与 LangChain saver。界面明确区分失败、取消、中断与已保存，审批提交期间禁用按钮并沿用原 decisionId 重试。

兼容处理：cancelRequested 为可选 JSON 字段，不需要数据库 migration；旧记录缺省为未请求取消。原生投影 stateVersion 从 1 升到 2，通过官方日志重放重建。旧客户端仍可忽略可选字段，新客户端遇到旧文本索引缺口时等待完整结果。协议继续使用 v1 完整快照，没有改写已发布 migration。旧写作 checkpoint、v1/v2 task 结果与 RAG LangChain 兼容路径保留；没有跨引擎恢复。

本轮验证：

- `pnpm test:ai`：38 项通过、0 跳过，包括 10 项真实官方 DSH 内核测试、真实 PostgreSQL PostgresSaver、Qdrant 1.17.1 和 2 项应用预览/SSE 分帧测试。覆盖新增终态恢复、关闭竞态、文本索引、旧快照、丢帧及分片 UTF-8/CRLF；模型和 Embedding 为显式测试 adapter。
- 应用 smoke：真实 HTTP/SSE/WebSocket、写作/研究提案、权限/来源撤销、原 RAG checkpoint 和取消、逐段/重复接受、协同冲突及 durable ack、跨进程恢复、产品终态事务失败均通过。另覆盖第 9 个订阅超限、私有推理过滤、连接预算和模拟空闲维护后的订阅保留/句柄恢复。
- `pnpm check:ai-packages`：7 个 tarball 在隔离目录独立安装并消费，公开类型、CSS、SSR、插件入口和官方多轮 Loop 通过。
- `pnpm check`：最终退出 0，格式、lint、类型、全部包/应用/示例构建、离线 OpenAPI 与 Orval 漂移检查通过。
- Playwright：两轮写作、RAG 有来源答案、写作/问答草稿往返隔离、刷新恢复、组合输入期间不提交和 390×844 亮暗主题通过；截图 `output/playwright/ai-chat-20261030-*.png`。清洁页面无运行时错误，仍有原 HeroUI PressResponder 警告。生成客户端/构建期间触发过开发 HMR 失效，生成结束后清洁加载复核。

日志位于 `output/qa/ai-tests-20261030.log`、`ai-smoke-20261030-final.log`、`ai-check-20261030-final.log` 和 `ai-consumer-20261030.log`。首轮仓库检查检出契约生成漂移，已由 OpenAPI/Orval 更新；随后测试脚本的一处推导类型错误已修复，最终完整检查通过。

本轮 PostgreSQL、Qdrant 均为单独启动的本机测试实例，只迁移随机 `zhishu_ai_test_*` 数据库，不访问现有业务库。没有使用项目模型凭据或进行收费调用。图片真实 HTTP adapter、任务、审批和私有存储代码保留；本轮未重新运行需要 MinIO 的图片落盘分支，也未验收真实收费图片账户。互联网研究、全库向量问答接入、生产多实例路由/高负载及不配合取消的外部 provider 仍不标为已验收；7 个包保持 private，未发布 registry。

当前写作重连由界面“重新连接”或下一次消息受理触发，自动退避重连仍是后续目标。图片目前仅提供授权预览，参考图、更多尺寸和直接插入正文继续按原能力边界保留为后续工作。
