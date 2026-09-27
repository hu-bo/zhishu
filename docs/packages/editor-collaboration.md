# editor-collaboration 设计规划

状态：M2 实现中。Provider 决策、短时会话授权、PostgreSQL 持久化原型和服务端结构命令原型已实现；正常保存、数据库中断恢复、内容重载、双端结构冲突及正文/结构命令提交后进程崩溃注入 smoke 已通过。剩余 M2 生命周期与集成验收仍待完成。[返回文档地图](../README.md)。服务端配套见 [app-server](../apps/app-server.md)。

## 1. 产品职责与依赖

提供 Yjs 与 editor-core 的绑定、协同会话、Awareness、连接恢复和持久化状态接口。依赖 document-contracts、core 的适配器边界及 Yjs/Tiptap 协同相关运行时；不依赖 React、业务路由、知识库或 AI。

首期采用自托管 Hocuspocus v4 WebSocket Provider（上游 MIT，服务端要求 Node.js 22+），允许宿主替换。Tiptap Collaboration 和 `@tiptap/y-tiptap` 也属于 MIT 开源依赖；均可部署在自有环境，不要求使用 Tiptap Cloud。Provider 必须实现明确协议与能力，替换 URL 并不意味着两种不同协议能互通。包可从浏览器使用；服务端实现留在 app-server 的 collaboration 模块。Hocuspocus 的防抖 `onStoreDocument` 不承担 durable ack；PostgreSQL 更新日志是权威持久层。许可/部署依据：[Hocuspocus server manifest](https://github.com/ueberdosis/hocuspocus/blob/main/packages/server/package.json)、[Tiptap Collaboration manifest](https://github.com/ueberdosis/tiptap/blob/main/packages/extension-collaboration/package.json)、[y-tiptap manifest](https://github.com/ueberdosis/y-tiptap/blob/main/package.json)。

客户端可从 `@zhishu/editor-collaboration/tiptap` 使用 `createTiptapCollaborationExtension(document, field)`；`HocuspocusCollaborationSession.waitUntilSynced()` 在 provider 已连接且 state vector 同步后 resolve，不兼容、撤权、断开和超时则 reject。Provider 自动使用退避和随机抖动重连；session 的 `retry()` 可手动重新连接，重连时通过 `refreshSession` 获取新 ticket，并重放尚未确认的本地更新。core `collaborative: true` 禁止本地初始 JSON 并停用 StarterKit 普通撤销；`isTiptapCollaborationFieldEmpty()` 只供同步后检测共享 fragment 是否为空。官方要求 UniqueID editor 在 Provider 同步后挂载，且使用 collaboration 历史时关闭 StarterKit UndoRedo，参见 [Collaboration extension](https://tiptap.dev/docs/editor/extensions/functionality/collaboration) 和 [UniqueID 协同设置](https://tiptap.dev/docs/editor/extensions/functionality/uniqueid)。这完成客户端绑定入口的一部分；服务端一次性初始内容的原子初始化、React 生命周期整合、正文 XML 与 D-03 规范 Block maps 投影仍未完成，不能开放协同结构 UI。

Provider 会读取 session ticket 中的 tenant/subject 声明，仅用于比较续期前后的主体是否一致；ticket 签名验证和访问控制仍由服务端负责。Hocuspocus session 在 ticket 到期前调用 `sendToken()` 续期，服务端要求同一租户和主体，并按新票据的只读/可写状态重新检查 ACL。宿主未提供 `refreshSession` 时，客户端在 ticket 到期时切为 denied/只读并断开。WebSocket 真实账号切换、权限降级和到期续期验收仍待完成。

### D-02 决策与持久化次序

采用 `@hocuspocus/server` 4.7.x，私有部署在项目自己的 Node 服务中；官方包为 MIT 许可、要求 Node.js 22+。客户端使用匹配主版本的 Hocuspocus Provider。文档名由服务端构造为 `documentId:generationId`，客户端只提交短时 HMAC session ticket；ticket 绑定主体、tenant、文档、代次、读写权限、schemaVersion、扩展要求与过期时间，不接受请求体中的 tenant/owner 身份。HTTP session route 根据客户端报告的 schema/扩展能力与 `read`/`write` action 协商；读者取得 read-only ticket，客户端创建编辑器时必须同时设置不可编辑。连接认证按 read action 检查，写帧、durable replay 和结构命令再次检查 write；ACL 变更会关闭活动代次房间的连接，重新连接时重验权限。当前 ACL 由文档所有者管理，实际外部身份仍由宿主注入 `PrincipalAuthenticator`。

每个 SyncStep2/Update 帧通过 Hocuspocus `beforeSync` 取得 Yjs 更新字节，在应用前执行 PostgreSQL 事务：锁定 generation 行，以客户端原始帧的 SHA-256 `sourceUpdateHash` 幂等去重；服务端生成的持久化 delta 可同时包含正文和对应 Block maps，`updateHash` 则是该实际 delta 的 SHA-256。新 delta 分配严格递增的 `durableSeq` 并与两种 hash 一起提交。事务失败时 hook 抛错，服务器不得应用、广播或回执，客户端保留待确认内容。事务提交后 Hocuspocus 应用原帧；`afterHandleMessage` 再合并已持久化的 projection delta，确认它完整存在于服务端 Y.Doc 后，向文档房间广播 `persisted` stateless 帧，字段 `updateHash` 承载客户端原始帧 hash (`sourceUpdateHash`)，并携带 generationId 和 durableSeq。发送端只清除被回执覆盖的本地待确认更新，其他会话推进已知 durableSeq。

文档装载时按 durableSeq 顺序重放 Yjs 二进制更新。相同字节重试会命中唯一哈希并返回原 durableSeq。若连接断开后 Hocuspocus 用不同字节重新编码了客户端当前状态，客户端在 `synced` 后发送 `durable-replay` stateless 探测，携带本地待确认更新原字节；服务端先验证该更新完整包含于当前 Y.Doc，再复查权限。若哈希已落库，返回原序号；若重新同步的合并更新已持久化该内容，则返回重新读取的 generation durableSeq，不再重复写入原字节。客户端确认后清除对应待确认项。ACK 丢失不代表数据未保存。日志压缩/检查点留在后续容量优化中。

传输提供的是 update-level durable ack：ACK 证明该完整 Yjs update 已进入 PostgreSQL 并应用到本代次服务端文档，不表示业务版本、JSON 投影、附件或搜索索引已完成。`onStoreDocument` 可后续生成快照，但其防抖失败重试不替代逐 update 事务。

### D-06 首期 owner 与容量边界

首期一个 PostgreSQL 数据库只允许运行一个协同服务实例。app-server 在 WebSocket listener 启动前，通过连接池中的专用 PostgreSQL 连接持有 advisory lock；锁冲突则启动失败，锁连接意外结束则关闭协同服务并停止进程。连接池最小大小为 2，为锁连接保留独立槽位。该方式用于首期单实例部署，不是跨实例 fencing 或自动故障接管方案。

默认限制为每实例 100 条 TCP 连接、50 个活跃文档房间、每房间 20 条连接、每条连接 1 个文档、每个 Yjs 更新帧 1 MiB；限制可由 app-server 对应的 `COLLABORATION_MAX_*` 环境变量调整。连接上限最低为 2，以容纳正常断线恢复期间旧连接收尾与新握手的短时重叠。超过全局连接上限的 TCP socket 会被关闭；房间/文档限制在认证时拒绝并返回容量错误。它们是资源保护阈值，尚未通过固定环境压测认证并发性能。`examples/collaboration-consumer/src/capacity-smoke.ts` 验证全局连接边界；房间级并发性能与多实例能力仍待后续验收。

## 2. 功能清单

| 编号  | 能力           | 产品细节                                                           | 阶段                |
| ----- | -------------- | ------------------------------------------------------------------ | ------------------- |
| CO-01 | 会话与绑定     | doc/generation/Schema 握手、Y.Doc 生命周期、加载顺序与只初始化一次 | M2                  |
| CO-02 | 同步与重连     | 差量同步、重复更新、网络波动、退避、手动重试、鉴权续期             | M2                  |
| CO-03 | 在场信息       | 用户/会话区分、头像、光标/选区、离开/过期状态、速率控制            | M2                  |
| CO-04 | 持久化回执     | 本地待确认更新、服务端 durableSeq、失败反馈和可恢复队列            | M2                  |
| CO-05 | 撤销与并发操作 | 本人操作来源、AI 接受分组、他人编辑保留、Block 冲突处理            | M2                  |
| CO-06 | 权限变更       | 只读连接、拒绝写入、撤权断开、切换账户和令牌过期                   | M2                  |
| CO-07 | 锚点适配       | 相对位置、选区恢复、删除目标检测、版本代次隔离                     | M2；评论/AI 接入 M3 |
| CO-08 | 持久离线       | 浏览器缓存、重开恢复、缓存隔离/清理、离线变更再授权                | M4，显式启用        |
| CO-09 | 可观测与替换   | 连接/同步/持久化耗时、错误分类、协议兼容和资源释放                 | M2                  |

## 3. 三类状态分别建模

| 维度     | 状态                                                      | UI 应表达什么                                              |
| -------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| 连接     | idle、connecting、connected、reconnecting、denied、closed | 能否与服务端通信，是否需要登录或重试                       |
| 内容同步 | loading、catching-up、current、incompatible               | 本地是否完成已知远端状态的同步；没有远端数据时不伪装空白   |
| 持久化   | clean、pending、persisted、failed、unknown                | 本地变更是否获得覆盖它的落库回执；unknown 不能显示“已保存” |

connected 不代表 current；current 不代表 persisted。连接断开后可保留本地可编辑副本，但必须说明当前只是内存中的未确认修改。M2 不承诺关闭浏览器后恢复；CO-08 交付前，离开提示与可导出副本是必要的产品行为。

## 4. Provider 与宿主契约

| 接口/能力                        | 入参或结果                                                             | owner                                |
| -------------------------------- | ---------------------------------------------------------------------- | ------------------------------------ |
| `createSession`                  | documentId、generationId、Schema/扩展集、ProviderFactory、凭据获取回调 | 宿主发起，本包绑定                   |
| `connect / disconnect / destroy` | 明确生命周期与取消                                                     | 创建 session 的一方负责释放          |
| `subscribeStatus`                | 三类状态与安全错误、取消函数                                           | 本包对外统一模型                     |
| `setPresence`                    | 受限的显示信息/选区                                                    | 临时状态；用户身份由服务端认证       |
| `resolveAnchor / createAnchor`   | 当前代次中的锚点与当前位置                                             | 本包实现 core 的可替换锚点接口       |
| `flush / awaitPersisted`         | 等待已发送修改的服务端回执，超时返回 pending/failed                    | 仅对声明 durableAck 的 Provider 有效 |
| `capabilities`                   | durableAck、只读会话、凭据刷新、协议版本等                             | 创建前明确，缺失能力不可伪装         |

标准 Yjs 同步消息之外，本产品使用 Hocuspocus stateless 帧传输持久化回执、`durable-replay` 探测和 `structure-operation` 命令。结构命令返回 accepted/duplicate/conflict/rejected、revision 和 durableSeq；持久化回执携带 generationId、更新 SHA-256 标识和服务端 durableSeq。客户端 Provider 包维护内存待确认更新并暴露 `getStructureRevision()`/`submitStructureOperation()`；Editor 尚未绑定这些结构 API。`onPendingUpdate(updateId)` 在本地更新完成哈希并进入待确认队列时触发，ID 为 `generationId:sha256(update)`；`onPersisted(receipt)` 返回同一 ID 和 durableSeq。`waitForPersisted(updateIds)` 仅在所列 ID 都收到回执后成功，相关持久化错误返回失败，未知 ID 在超时后返回 pending；不传 ID 时等待当前哈希和待确认队列排空。会话仅保留最近 512 个成功回执供稍后的精确等待查询；尚未回执的更新只在当前客户端内存保留，关闭会话不会形成离线持久队列。消费方状态监听与回调异常不会中断 Provider 的协议处理。第三方基础 Provider 若不实现 durable ack，应声明 `durableAck: false`。

适配器向上暴露一致的语义接口，底层可以使用不同握手和帧编码：

```ts
interface CollaborationProvider {
  readonly capabilities: ProviderCapabilities;
  connect(signal: AbortSignal): Promise<SessionReady>;
  submit(update: Uint8Array, updateId: string): Promise<void>;
  awaitPersisted(updateIds: readonly string[], signal?: AbortSignal): Promise<PersistReceipt>;
  setAwareness(state: PresenceState | null): void;
  subscribe(listener: (event: ProviderEvent) => void): () => void;
  disconnect(reason?: "user" | "revoked" | "generation-changed"): Promise<void>;
}
```

`SessionReady` 至少返回 documentId、generationId、schemaVersion、扩展要求、readOnly、服务器已知 state vector 与 durableSeq。`PersistReceipt` 返回被确认的 updateIds 和最高 durableSeq。一个 Yjs update 可以包含同一会话内多个事务；本地层按发送批次分配 updateId，服务端持久化与确认该批次原子关联。适配器若无法提供上述确认，声明 `durableAck: false`，`awaitPersisted` 明确返回 unsupported，不能模拟成功。

### Y.Doc 与 Provider 约束

每个 generation 使用一个 Y.Doc；ProseMirror 内容根固定命名为 `content`，由 Tiptap Collaboration 绑定为共享 XmlFragment。generation、Schema 和扩展要求由会话元数据握手提供，不写成正文节点。Awareness 单独承载会话级光标与受限用户展示信息，永不持久化为文档内容。替换根字段、改变 XML 映射或扩展结构属于协同协议/内容兼容变更，必须进入兼容矩阵。普通正文更新会在服务端候选 Y.Doc 中投影为 Block/顺序 maps，并与正文 delta 一起持久化；结构命令也已实现从 maps 更新 XmlFragment，正文/maps/操作回执可作为一个 Yjs delta 保存。缺少投影或与正文不一致的旧代次仍 fail closed；双向投影已通过隔离 PostgreSQL/WebSocket smoke，但不代表完整 D-03 集成闭环。

Provider 事件至少表达 `connected`、`synced`、`update-sent`、`persisted`、`permission-changed`、`disconnected` 与 `error`。`synced` 只证明当前差量同步达到服务端所知状态；仅 `persisted` 且覆盖本地待确认 updateId 才能将对应修改显示为已保存。

## 5. 建立协同会话

1. 宿主请求当前文档访问能力和 session ticket，服务端返回当前 generation、Schema 要求与读写权限。
2. 客户端确认扩展兼容，再建立连接；服务端校验身份、文档访问权、代次和协议。
3. 加载持久化 Yjs 状态并同步，成功后才将正文视为已加载。存储错误显示失败，不能返回空 Y.Doc 让用户覆盖原文。
4. 绑定 editor-core，选择协同历史适配器；发布经过约束的在场状态。
5. 用户事务进入增量同步，收到覆盖本地更新的落库回执后显示已保存。

协同打开时序以可观察状态为准：

| 阶段   | 客户端行为                                   | 服务端确认/超时处理                                  |
| ------ | -------------------------------------------- | ---------------------------------------------------- |
| 授权   | 通过宿主获取短期 session ticket 与代次信息   | 失败返回 denied，不创建可编辑空文档                  |
| 握手   | 提交 ticket、协议能力、Schema/扩展要求       | 验证身份、ACL、generation；不匹配则拒绝写入          |
| 同步   | 接收检查点及后续更新，交换 state vector/差量 | 加载错误关闭会话；慢同步保持 loading，超时可重试     |
| 就绪   | 收到 `synced` 与 `SessionReady` 后绑定编辑器 | 明确读写权限、durableSeq 和服务端状态                |
| 持久化 | 按 updateId 发送本地更新并等待回执           | 数据提交后分配 durableSeq 并回确认；提交失败不得 ack |

重连到同一 generation 时重新授权并交换 state vector：服务端先补发它已有而客户端缺少的状态，客户端再重发尚未收到回执的 updateId；服务器以 updateId 幂等去重，客户端以确认覆盖的 updateIds 清除待确认队列。若服务端代次改变，客户端不向新代次重放旧队列，转入 generation-changed 并保留可导出的本地副本供显式恢复。

新文档初始内容仅由服务端初始化流程写入一次，使用唯一记录/事务守卫区分“未初始化”和“已初始化为空”。多个客户端不能各自从同一 JSON 插入初始正文。

协同正文按 Yjs 二进制保存；JSON 是导出、预览和索引的派生快照。不能每次连接都从 JSON 重建 Y.Doc，这会破坏协同状态并可能造成内容重复。[官方持久化说明](https://tiptap.dev/docs/hocuspocus/guides/persistence)

## 6. 编辑、撤销与锚点

普通撤销栈与 Yjs 协同撤销不得同时处理同一正文。core 的 `collaborative: true` 已关闭 StarterKit 普通 UndoRedo；Tiptap Collaboration 内置的 Y.UndoManager 默认只追踪本地 `ySyncPluginKey` origin，Hocuspocus 远端更新使用其他 origin，不进入本人的撤销栈。`@zhishu/editor-collaboration/tiptap` 提供 `runTiptapCollaborationUndoGroup(editor, apply)`，在同步应用单次本地变更前后调用 `stopCapturing()`，可把最终接受的一次 AI/宿主操作和附近输入分开撤销；只能包住同步应用回调，不能包住异步生成等待。Tiptap Editor 不存在协同 undo plugin 时该 helper 会抛出明确错误。AI 接受路径尚未实现，故分组 helper 尚无产品调用点或 AI 冲突验收。[官方 UndoManager 文档](https://docs.yjs.dev/api/undo-manager)

`createTiptapAnchor(editor, document, { documentId, generationId }, field)` 把当前 ProseMirror 选区端点映射为 Yjs relative positions，并绑定两端 Block ID 与代次；`resolveTiptapAnchor(editor, document, anchor, currentIdentity, field)` 在当前同步映射下返回有效范围，或明确返回 stale-document、stale-generation、target-missing、invalid-anchor。解析同时确认 Block 仍存在且位置仍落在对应 Block 内；调用方负责隐藏失效装饰/拒绝应用，helper 不自动移动光标，也不把映射失败降级成旧绝对偏移。

异步任务通过 core 的锚点接口使用相对位置，不保存过期的绝对下标。相对位置仍需验证目标存在、generation 一致和内容前置条件；原目标被删时应报告失效，不能把邻近内容当作原目标。[官方相对位置说明](https://docs.yjs.dev/api/relative-positions)

### D-03 结构命令协议与原型

Yjs 文本/树 CRDT 的收敛不能替代业务 ID 与结构不变量。服务端使用 Hocuspocus stateless `structure-operation` 命令，包含 `baseStructureRevision` 和完整 OperationBatch；每个文档在单 owner 实例内串行处理。服务器重新验证 owner、generation、读写权限与整个内容树，基于 revision 执行条件提交：同 revision 竞争时首个持久化操作成功，其余收到 `stale-structure-revision`，客户端需同步后明确重试。该规则粗粒度地串行化整棵结构，不按客户端时间戳作 last-write-wins。

移动保留原 `blockId`；删除会在该 generation 内形成 tombstone，不能再次插入同 ID；拆分由左侧 `replace-block` 保留源 ID、右侧插入新 ID；合并由左侧保留 ID、右侧删除并 tombstone。OperationBatch 的整批校验拒绝树内重复 ID；相同 operationId 与相同请求哈希重放返回原 revision 的 duplicate，重用 operationId 提交不同请求会拒绝。规范树按 Block JSON、父子顺序、tombstone、revision 与有限操作回执写入独立服务端 Yjs maps；变更先以 durable update 写入 PostgreSQL，再应用并广播。移动只修改相关顺序和 revision，不重写大 Block 内容。单次 Yjs 更新仍受 1 MiB 上限约束；每代最多保留 10,000 个操作回执和 100,000 个 tombstone，达到上限后结构命令 fail closed。

`examples/collaboration-consumer/src/structure-smoke.ts` 用两个实际 Hocuspocus 客户端和隔离 PostgreSQL 验证同修订并发移动、重复回执、拆分/合并身份、删除后 ID 不复用、900 KB Block 移动、普通正文更新投影、结构命令回写正文 XmlFragment、断线重载恢复及拒绝客户端直接改写规范 maps。服务端只接受该命令协议修改规范投影，投影未初始化或失配时拒绝结构命令。

这还不是完整协同编辑器闭环：普通 XmlFragment 正文更新会投影到 D-03 Block/顺序 maps，同一 durable update 携带两者；客户端原始帧 hash 与落库合并 delta hash 分开记录以支持重放。结构命令会把规范 maps 同步回正文 XmlFragment，双向投影已在隔离 PostgreSQL/WebSocket smoke 验证。core 可准备 OperationBatch，React Block 菜单在 session connected/current 且可写时提交服务端；真实 Tiptap/React 消费页已验正文输入和复制、删除、段落/标题/代码块转换、上下移菜单动作，均取得 durable ack。正文更新和结构命令在提交后进程崩溃恢复也已通过隔离数据库验收。历史重复 ID 由显式维护命令 dry-run 检查，应用时退休旧 generation、保留源更新日志并在新 generation 中重建唯一 ID 与结构投影；本地 PostgreSQL 专项 smoke 已通过。其他 ProseMirror 共享类型仍未开放。

## 7. Awareness 与身份

Awareness 用于会话级的在场状态，客户端 ID 不等于用户 ID；同一用户多个标签页有各自的 clientId。Provider 的 `setPresence()`、`getPresences()` 和 `subscribePresence()` 通过独立的 `zhishu` awareness 字段传递协议版本、显示名、颜色和可选选区；选区端点是 generation-local 的 Yjs relative-position Base64URL 编码。共享合约拒绝未知字段、无效位置编码和超过 2 KiB 的状态；客户端把本地 presence 更新合并到最多每 100 ms 一次，服务端每个连接每秒至多接受 30 次 presence 更新，超限只丢弃该次 presence 字段，不影响正文编辑。React Provider 暴露参与者订阅，EditorShell 显示最多五个参与者名字；`./tiptap` 可选入口提供 `createTiptapPresenceExtension()`，绑定后自动发布本地选区并装饰远端光标/选区，也提供独立的选区捕获 helper。当前 React 默认创建流程尚未安装该扩展；名字到认证用户的可信映射和过期状态的专门 UI 仍待完成。Yjs Awareness 负责断线/过期状态回收；手动断开先撤下本地 presence，重连后重发当前状态，不把临时在线信息写入文档版本。[官方 Awareness 文档](https://docs.yjs.dev/api/about-awareness)

服务端认证结果才是权限与审计身份来源。Presence 合约不含用户 ID；显示名和颜色是不可信展示信息，不能通过修改 Awareness 获取他人身份或访问权。当前包不传头像或外部 URL。选区相对位置必须由宿主绑定到当前 Y.Doc/generation 后解析；过期、删除或无法解析的目标应隐藏，而不能回退到绝对偏移。

## 8. 重连、撤权与版本恢复

| 场景                 | 客户端行为                                                       | 服务端配合                                 |
| -------------------- | ---------------------------------------------------------------- | ------------------------------------------ |
| 短时断网             | 保留未确认更新、退避重连、展示离线；不能将更新队列清空当保存成功 | 同代次差量同步、去重及重新确认             |
| 身份过期             | 通过宿主回调刷新；失败后暂停发送并提示登录                       | 校验新凭据，连接内不无限信任旧权限         |
| 被降为只读/撤权      | 立即停止本地写入与自动重试，将未发送内容隔离为可处理副本         | 拒绝写帧，通知/关闭失效会话                |
| 恢复旧版/Schema 迁移 | 结束旧代次会话，提示保留未确认副本，再打开新代次                 | 旧 generation 更新拒绝写回，防止内容“复活” |
| 同步状态损坏         | 暂停写入并提供重新加载/导出路径                                  | 保留诊断与原始数据，不自动清空线上文档     |

持久离线缓存以后按 tenant/user/document/generation 隔离，默认由部署策略显式允许；退出、切换用户和撤权时执行清理/隔离规则。缓存重连必须重新授权，不能将本地缓存存在视为写入资格。

## 9. 当前实现入口与验收记录

服务端 session API、HMAC ticket、owner-managed ACL、目录和版本 API 位于 `apps/app-server/src/modules/documents` 和 `src/modules/collaboration`；更新事务及重放位于 `src/modules/documents/document.repository.ts` 与 `src/modules/collaboration/hocuspocus.server.ts`；PostgreSQL 表和 migration 位于 `database/schema/document.table.ts` 与 `database/migrations/0001_cute_old_lace.sql` 至 `0005_rich_earthquake.sql`。浏览器客户端类型与状态机在 `packages/editor-collaboration/src`，`/hocuspocus` 是可选 Provider 入口；`examples/collaboration-consumer` 从构建包入口连接真实 API/WS。

在 2026-09-27 的隔离 PostgreSQL 上，正常 smoke 完成创建文档、协商 schema/generation、写入 Yjs 更新、收回执、手动断开/重连并用刷新后的 ticket 确认 pending 更新，随后断开重载；failure smoke 暂停 PostgreSQL，验证客户端仍保留 pending，恢复后重连并经重放回执清队列；同一原始更新字节重复探测两次，收到相同 durableSeq。结构 smoke 验证双端竞争、唯一 ID/拆分合并身份、900 KB Block 移动、重连恢复和服务端投影写保护。真实浏览器 Tiptap/React 消费样例验证正文输入和 Block 菜单复制、删除、段落/标题/代码块转换、上下移均获得 durable ack。新增 post-commit crash smoke 分别在正文更新与结构命令写入 PostgreSQL 事务后、服务端 Y.Doc apply/broadcast/操作回执前终止进程；新进程从数据库恢复内容和 maps，客户端重连后取得原 durableSeq，结构操作以相同 operationId 重放返回 duplicate。迁移 `0001_cute_old_lace.sql` 与 `0002_wise_venus.sql` 已在隔离库应用，后者约束 update 的 documentId/generationId 必须属于同一代次。

## 10. 交付与剩余验收

Yjs 及协同绑定依赖保持兼容且避免打包重复运行时；Provider 专属 SDK 放在独立导出入口，基础包不自动创建连接。日志记录会话标识与状态，避免写入正文、凭据和完整更新内容。

M2 必须覆盖双端输入、并发撤销、网络中断、重复更新、服务端重启、落库失败、权限撤销、Schema 不兼容和旧代次重连。模拟 WebSocket 成功不足以证明保存可靠；需要验证服务端持久化后的重新打开结果。M4 的关闭浏览器再恢复另外验收，不能沿用 M2 内存重连结论。
