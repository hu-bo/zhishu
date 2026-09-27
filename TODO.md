# 知书项目 TODO

本文把项目文档中的规划转为可执行清单。所有复选框初始未勾选；只有功能已实现、对应验收完成且限制已记录，才勾选。功能编号沿用设计文档，避免在这里维护第二套规格。

## 参考文档

- [项目文档地图](docs/README.md)：产品边界、包依赖、跨包状态归属、阶段顺序、决策项和发布约束。
- [原始需求](docs/resreach.md)：需求来源与完整能力覆盖清单。
- Packages： [document-contracts](docs/packages/document-contracts.md)、[editor-core](docs/packages/editor-core.md)、[editor-react](docs/packages/editor-react.md)、[editor-collaboration](docs/packages/editor-collaboration.md)、[editor-ui](docs/packages/editor-ui.md)、[editor-ai-bridge](docs/packages/editor-ai-bridge.md)。
- Apps： [app-web](docs/apps/app-web.md)、[app-server](docs/apps/app-server.md)。

## 架构决策清单

各决策按文档地图规定的阶段收敛：D-01 在 M1 前；D-02/D-03 在 M2 前完成候选方案和语义设计、M2 原型验证；D-05 在 M3 评测；D-06 在多实例扩容前；D-07 每阶段开始前；D-04 在采用对应扩展前。

- [x] **D-01 合约生成与 Zod/OpenAPI 对接：** 选定 JSON Schema 与服务端/前端 Zod 的生成或引用方式，验证 `content` 的结构约束能进入 OpenAPI；不绑定某一应用的 Zod 主版本。参考：[文档地图](docs/README.md#9-实现前需要收敛的决策)、[DC](docs/packages/document-contracts.md)、[SV](docs/apps/app-server.md)。
- [x] **D-02 协同 Provider 与持久化回执（方案及原型已验证）：** 自托管 Hocuspocus、短时绑定文档/代次/schema 的 HMAC ticket、Yjs 更新哈希去重与 durableSeq 事务/回执语义已实现；真实 PostgreSQL 提交失败恢复、重复重放幂等和重开恢复通过。隔离 PostgreSQL 故障注入已覆盖正文更新和结构命令在事务提交后、Y.Doc apply/broadcast/结构回执前进程退出；重启后正文/maps 恢复，待确认客户端收到原 durableSeq，重复结构命令返回原结果。参考：[文档地图](docs/README.md#9-实现前需要收敛的决策)、[CO](docs/packages/editor-collaboration.md)、[SV](docs/apps/app-server.md)。
- [x] **D-03 并发 Block 移动与唯一 ID（服务端原型已验）：** 采用 generation 内单 owner 串行结构命令与单调 `baseStructureRevision`；竞争命令由先提交者成功，旧修订命令返回冲突；移动保留 ID、删除 ID 在代次内退役、拆分左侧保留 ID、合并右侧 ID 退役。服务端规范结构采用按 Block/顺序拆分的 Yjs 投影，操作回执可幂等重放，直接写保护投影的 Yjs 更新会被拒绝。双客户端并发、拆分/合并、900 KB Block 移动、重连恢复及 ID 复用拒绝 smoke 已通过。隔离 PostgreSQL 上的真实 Tiptap/React 页面已通过正文 durable ack 和 Block 菜单复制、删除、段落/标题/代码块转换、上下移完整动作矩阵，每项结构操作均收到持久化回执；结构命令提交后崩溃恢复和 operationId 幂等重试也已通过。`maintenance:repair-block-ids` 默认只 dry-run；显式指定单一文档并持有协同 owner 锁后，原子退休旧代次、保留原更新历史并创建唯一 ID/新结构投影的代次。专项 PostgreSQL smoke 通过；项目本地库 26 篇活动文档扫描为 0 个修复候选。参考：[文档地图](docs/README.md#9-实现前需要收敛的决策)、[EC](docs/packages/editor-core.md)、[CO](docs/packages/editor-collaboration.md)、[UI](docs/packages/editor-ui.md)。
- [x] **D-04 扩展兼容与授权（候选决策已完成）：** 基础编辑、Tiptap Collaboration/Yjs/Hocuspocus、OSS 表格/图片候选许可与私有部署边界已审计；M2/M3 采用 MIT OSS 或项目自有扩展，不引入 Pro/Cloud。图片已有项目自有 contracts、服务端投影和宿主授权读取；表格仍须先补 Schema 与投影；协同须先接通规范投影 adapter。升级或新增候选仍按具体锁定版本复核许可。参考：[文档地图](docs/README.md#9-实现前需要收敛的决策)、[EC](docs/packages/editor-core.md)、[CO](docs/packages/editor-collaboration.md)、[DC](docs/packages/document-contracts.md)。
- [ ] **D-05 向量库、Embedding 与 Rerank：** M3 用同一中文评测集比较召回质量、隔离过滤、删除/重建、私有部署和资源成本，确定方案及版本策略。参考：[文档地图](docs/README.md#9-实现前需要收敛的决策)、[SV](docs/apps/app-server.md)。
- [x] **D-06 协同部署规模（首期已验证，多实例另计）：** 首期每个数据库仅运行一个协同服务实例；PostgreSQL advisory lock 冲突时启动失败。默认 TCP 连接/活跃房间/单房间连接上限为 100/50/20，单连接最多 1 个文档、更新帧最多 1 MiB；全局连接上限下限为 2。全局 TCP 连接上限超限拒连、单实例锁冲突和上限 2 下 PostgreSQL 故障恢复 smoke 已通过。锁丢失时进程自停；不提供多实例路由、fencing 或自动接管。参考：[文档地图](docs/README.md#9-实现前需要收敛的决策)、[CO](docs/packages/editor-collaboration.md)、[SV](docs/apps/app-server.md)。
- [x] **D-07 平台与内容格式：** M1 定桌面浏览器和 JSON；M2 定窄屏基础编辑；HTML/文本及后续格式逐项声明保真和损失范围。参考：[文档地图](docs/README.md#9-实现前需要收敛的决策)、[EC](docs/packages/editor-core.md)、[UI](docs/packages/editor-ui.md)、[WEB](docs/apps/app-web.md)。
- [ ] **发布策略：** 首次发布前确定 npm scope、私有 registry、包的发布/升级策略、支持矩阵与回滚方式。参考：[文档地图](docs/README.md#11-包发布与接入交付)、六份 package 文档。

## M1：可嵌入编辑器

阶段出口：React 业务可通过公开包入口编辑自己的文档；无需 app 路由；JSON 往返保真，中文输入、键盘、只读和多实例可用。

参考：[文档地图 M1](docs/README.md#7-分阶段交付)、[DC](docs/packages/document-contracts.md)、[EC](docs/packages/editor-core.md)、[ER](docs/packages/editor-react.md)、[UI](docs/packages/editor-ui.md)。

### 内容合约与编辑引擎

- [x] **DC-01：** 定义版本化内容树、基础 Node/Mark、合法嵌套、属性默认值和可执行 Schema/校验器。
- [x] **DC-02：** 实现稳定 Block ID、树内唯一性与复制/拆分/合并/移动身份规则；覆盖嵌套 Block。
- [x] **DC-03（M1 合约，M2 字段已补齐）：** 落实 schemaVersion、扩展要求、快照字段和兼容协商；协同 generationId/durableSeq 与 snapshotRevision、可写握手已补齐，最新 JSON 投影已由 SV-08 持久化。
- [x] **DC-04：** 实现 insert/delete/replace/move OperationBatch、目标前置条件、全批次原子验证和结构化错误。
- [x] **DC-05：** 校验大小、深度、节点数、属性白名单、URL 协议和未知扩展；错误包含路径、类别与可恢复性。
- [x] **DC-06（M1 定约）：** 定义显式、可重复、失败保留原件的迁移接口和报告；迁移执行链在 M2 完成。
- [x] **EC-01：** 完成基础文本、标题、列表、引用、代码、链接和分隔线等 Node/Mark。
- [ ] **EC-02：** Chromium 自动化已覆盖键盘、选区、跨块删除、空块、纯文本/HTML 粘贴和链接输入；真实系统中文 IME 已由用户确认通过；Chrome、Edge、Firefox 的剪贴板复制/粘贴往返通过。Windows Playwright CLI WebKit 的系统剪贴板粘贴成功，copy event payload 正确，但 CLI 未将其写入系统剪贴板；桥接后的第二编辑器粘贴一致，不算原生往返通过。用户决定跳过实际 macOS Safari 与完整版本矩阵；这些项目未实测，不计入已验范围。
- [x] **EC-03（M1 单机）：** 完成按 ID 插入、删除、复制、拆分、合并、移动、缩进和类型转换；协同移动等 D-03 后在 M2 验收。
- [x] **EC-04：** 完成普通撤销/重做、逻辑事务分组及变更 origin；确保初始化不进入用户撤销历史。
- [x] **EC-05：** 实现 JSON 无损导入导出；HTML/文本转换提供净化、支持/降级/拒绝报告。
- [x] **EC-07：** 完成只读、命令可执行性/禁用原因和权限改变后的即时停止写入。
- [x] **EC-08（M1 基础）：** 完成选区、Block 查找、定位/滚动和基础大纲；文内查找及完整锚点能力按 M2/M3 补齐。
- [x] **EC-10（持续）：** 增量更新 ID 索引/大纲；避免每次按键全树遍历或全文序列化；设置内容与事务上限、扩展冲突诊断。

### React 集成与基础界面

- [x] **ER-01：** 完成 editor 创建、挂载、销毁、容器切换、初始化失败与重试。
- [x] **ER-02：** 提供 EditorProvider、EditorSurface、实例访问和 selector 订阅 API。
- [x] **ER-03：** 实现初始内容/外部加载/文档切换；阻止普通 props 重渲染把旧全文覆盖到编辑器。
- [x] **ER-04：** 支持同页多实例、独立焦点/键盘、最新回调和事务来源。
- [x] **ER-05（M1 基础）：** 定义上传、外部链接、反馈等宿主服务契约；资产和协同适配在 M2 完成。
- [x] **ER-06：** 只读/能力变化即时反映到编辑区域与操作控件，同时保留允许的浏览/复制。
- [x] **ER-08：** SSR 只输出安全占位/只读内容；处理 StrictMode、重复挂载和资源释放。
- [x] **ER-09（M1 当前组件）：** 提供编辑区和控件可访问名称、表单错误关联及菜单/链接面板焦点恢复；后续新增面板继续验收。
- [x] **UI-01：** 实现 EditorShell/Toolbar、格式状态（含混合态）、只读原因、窄屏折叠和宿主插槽。
- [x] **UI-02：** 实现文本选区浮动菜单，处理滚动、边缘定位、失焦和 IME。
- [x] **UI-03：** 实现 Slash/插入菜单，支持搜索、分组、能力过滤、键盘操作、触屏和空结果。
- [x] **UI-04（M1 单机）：** 实现 Block 手柄/菜单、复制、删除、转换、上下移和键盘/触屏替代操作；协同移动服从 D-03。
- [x] **UI-05：** 完成链接创建/编辑/移除、URL 校验、显示文本和外链确认行为。
- [x] **UI-06（M1 基础）：** 展示撤销/重做状态和基础大纲/定位工具。
- [x] **UI-12（M1 当前组件，持续复验）：** 当前组件提供作用域样式、主题 token、可替换文案、键盘/ARIA 语义、焦点可见、默认配色对比度和无动画样式；新增组件与宿主 NodeView 继续复验。
- [x] **D-01：** 在内容合约与 app-server route contract 间验证生成/引用链路，不维护平行 DTO。
- [x] **D-04（M1 扩展）：** 对 M1 选用的 Tiptap/ProseMirror 扩展完成兼容、许可和离线检查。

### M1 包交付与验收

- [x] 建立 `document-contracts`、`editor-core`、`editor-react`、`editor-ui` 工作区包；包导入无副作用，禁止依赖 `apps/*`、应用别名和私有源码路径。
- [x] 输出 ESM、类型声明和明确 `exports`；统一 React/Tiptap/ProseMirror peer 范围，避免重复运行时。
- [x] 提供构建产物消费样例：最小宿主保存、同页多实例、自定义扩展/NodeView 和纯 Schema Node.js 入口。
- [x] 从构建后的公开入口验收，不依赖工作区源码别名；验证基础 contracts 可在无 React/Tiptap/Yjs 环境运行。
- [ ] 覆盖 JSON 往返保真、中文输入法、粘贴/选区、只读无本地写入、多实例和 StrictMode 生命周期；Chromium 主流程、Chrome/Edge/Firefox/WebKit 基础加载与输入、真实系统中文 IME，以及 Chrome/Edge/Firefox 剪贴板往返已验。Playwright WebKit 的 copy payload 与桥接粘贴结果一致，但原生系统剪贴板往返仍未验；用户决定跳过实际 macOS Safari 和当前/上一稳定版完整矩阵，这些项目未实测，不计入已验范围。
- [x] M1 验收确认无 `apps/*` 路径依赖；记录浏览器验证状态、Schema 版本、扩展和格式损失范围。

## M2：独立协同文档产品

阶段出口：无知识库或模型配置也可创建、多人编辑、可靠保存、重开和恢复；撤权、附件与版本有闭环。

参考：[文档地图 M2](docs/README.md#7-分阶段交付)、[CO](docs/packages/editor-collaboration.md)、[EC](docs/packages/editor-core.md)、[ER](docs/packages/editor-react.md)、[UI](docs/packages/editor-ui.md)、[WEB](docs/apps/app-web.md)、[SV](docs/apps/app-server.md)。

### 协同、合约和包能力

- [x] **DC-03（协同字段）：** DocumentSnapshot Schema 已区分普通/协同快照，协同快照要求 generationId 与 durableSeq 成对、并保留 snapshotRevision；服务端会用共享兼容 helper 检查 Schema/扩展，拒绝不兼容写入且不签 ticket，成功响应明确返回可读/可写。最新 JSON 快照已由 SV-08 持久化，历史版本仍按 Yjs 日志重建。
- [ ] **DC-06（部分）：** contracts 的执行器会克隆输入并执行显式单向迁移；app-server 的写会话路径现在可从指定 active generation/durableSeq 重建并验证 JSON，按注册链迁移后在一个事务中写入新 generation 的 Yjs 初始更新、退休旧代次并递增 metadataRevision，提交后关闭旧代次连接。提交前复核 generation/schema/durableSeq；旧代次写入由现有 active-generation 检查拒绝。当前目标仍为 Schema v1、迁移 registry 为空且无历史 Schema；JSON 中间快照未持久化，故尚无实际旧文档迁移或真实 PostgreSQL 验收。
- [x] **DC-07（合约）：** 定义稳定 assetId/媒体类型/替代文本/尺寸引用，禁止 URL/上传凭据入文档；selection Anchor 绑定 documentId/generationId/起止 Block 并保存不透明 Yjs 相对位置。图片 Block Schema 已限定同文档 assetId 与 PNG/JPEG/WebP；服务端正文持久化事务校验资产并按当前 head/版本维护引用。Yjs 锚点 adapter 仍需接入解析与拆分/合并映射，真实对象存储往返验收仍待完成。
- [ ] **EC-03（协同语义，部分）：** D-03 服务端命令原型已验证移动/删除/拆分/合并冲突与 ID 唯一性；core 提供协同模式保护和只读 `prepareStructureAction()`，可把复制/删除/转换/移动生成经本地验证的 OperationBatch；React context 暴露会话提交接口，Block 菜单仅在可写且已同步的 session 上提交，由服务端执行，不做本地乐观结构写入。普通正文更新在候选 Y.Doc 中通过共享 DC 校验，再将 Block/顺序 maps 投影并与正文 delta 一起持久化；客户端来源帧 hash 与合并 delta hash 分离以支持幂等重放。服务端结构命令把 maps 结果序列化回正文 XmlFragment，并与 maps/操作回执合并为同一个 durable delta；旧的非空正文若没有结构投影或投影不一致会 fail closed。隔离 PostgreSQL/WebSocket smoke 已验证正文/maps 往返、900 KB Block 移动、并发冲突、幂等回放、拆分/合并、ID 退役及重开恢复。`examples/editor-consumer` 的 `/collaboration` 真实 Tiptap/React 页面已完成正文编辑及复制、删除、段落/标题/代码块转换、上下移的菜单动作矩阵，每项结构操作均获 durable ack；事务提交后进程崩溃也已验证客户端重放及结构 operationId 幂等。历史重复 ID 可用显式单文档维护命令隔离到新 generation；其余协同生命周期仍未闭环。
- [ ] **EC-06（部分）：** 已实现图片 Block 稳定序列化、JSON/协同投影、服务端结构插入与上传后渲染；HTML/纯文本导出报告降级为替代文本。PDF 正文附件、替代文本编辑、尺寸调整、任务列表、表格和代码语言仍待实现及验收。
- [ ] **EC-08（部分）：** core 已实现按 Block 文内查找，大小写折叠并保留 UTF-16 到文档位置映射；搜索会跨 Mark 分段、支持换行，命中可选择/滚动定位。UI 提供上一个/下一个循环导航，并在正文更新后重算；浏览器消费样例已验证跨 Mark 命中与定位、大小写不敏感和循环。锚点映射已有 contracts/Yjs adapter 基础，但 React/业务调用点、跨块选区恢复和失效反馈仍待闭环。
- [ ] **ER-05（M2，部分）：** app-web 已实际创建/刷新 collaborative session，等 sync 后挂载 Editor，并按 session 状态强制只读；宿主上传与短时 asset URL 解析已接入并支持 AbortSignal。锚点 adapter、上传取消/失败闭环和资源释放专项验收仍待完成。
- [ ] **ER-07：** 支持 React NodeView、自定义块选中/拖拽、受控属性更新和节点级错误恢复。
- [ ] **UI-06（M2 部分）：** EditorShell 已提供文内查找、结果计数、上一个/下一个循环导航和命中定位；消费样例浏览器验收通过。历史查看、返回原编辑位置及与锚点的协同恢复仍待完成。
- [ ] **CO-01：** document/generation/Schema 可写握手和 Y.Doc 生命周期原型已实现；已提供 waitUntilSynced、Tiptap Collaboration extension factory、core 协同模式与 React sync gate。服务端创建文档与首代次在事务中提交；app-web 已创建真实 session、等待 sync、挂载 Editor，并在浏览器刷新重开恢复正文。仍需多代次切换、session 资源释放/重连失败路径的专项验收。
- [x] **CO-02：** Provider 差量同步/指数退避带抖动；collaboration session 提供手动 retry，重连时调用 refreshSession 并重放 pending update；同一 updateHash 按 durableSeq 幂等。PostgreSQL/WebSocket smoke 已验证手动断线、刷新 ticket、pending 更新持久化并在重开后恢复。
- [ ] **CO-03（部分）：** 已建立共享 Presence Schema（≤2 KiB、协议版本、显示名/颜色、generation-local Yjs relative-position 选区），Provider 提供限频的 set/get/subscribePresence，服务端按连接限流并丢弃无效/超限 Presence；React hook 与 EditorShell 参与者名字列表已接通。可选 Tiptap adapter 已实现本地选区发布和远端光标/选区装饰，但尚未接入 EditorProvider/EditorShell 默认流程；仍需可信身份到展示名映射、离开/过期的专门 UI 及真实协同会话验收后完成。
- [ ] **CO-04（部分）：** Hocuspocus session 为每个待确认更新暴露 generation-scoped updateId、pending/persisted 回调和精确 waitForPersisted；React 提供独立的 connection/sync/persistence 状态 hook，EditorShell 可分别显示连接、同步、待确认数、失败与 durableSeq。app-web 已接入 Provider，浏览器正文编辑获 durable ack 并在刷新后恢复；持久化失败、pending 重放及失败恢复验收仍待补齐。
- [ ] **CO-05（部分）：** `collaborative: true` 关闭普通 StarterKit 历史，Tiptap Collaboration 默认仅将本地 YSync origin 送入 Y.UndoManager；新增同步 `runTiptapCollaborationUndoGroup(editor, apply)` 前后 stopCapturing，用于隔离一次宿主/AI 接受操作。AI 接受路径尚不存在，仍需实际调用点与并发远端编辑撤销验收。
- [ ] **CO-06（部分）：** 服务端已实现只读 session、拒绝写帧、按 document/generation 关闭撤权连接；Provider 现在在票据到期前用 `sendToken()` 续期，校验续期前后的 tenant/subject 一致，并在无刷新器或过期时切为 denied/只读和断开。服务端续期按新票据权限重新检查 ACL。app-web 凭据变化会重建 session，登出前会提示未确认修改；仍需真实 WebSocket 账号切换、权限降级、票据续期/到期验收和失败提示闭环；多实例撤权广播由 SV-01 跟踪。
- [ ] **CO-07（部分）：** contracts 已绑定 documentId/generationId/Block ID 与 Yjs 相对位置；新增 Tiptap 选区 capture/resolve adapter，复核 Block 仍存在且解析位置仍在目标 Block 内，并区分 stale-document、stale-generation、target-missing、invalid-anchor。仍需 React/业务调用点、目标失效 UI 与异步操作前置条件闭环。
- [ ] **CO-08（M4 范围声明）：** 明确 M2 只承诺内存重连；离开前提示未确认修改并提供导出副本，不宣称关闭浏览器后可恢复。
- [ ] **CO-09：** 记录连接、同步、持久化耗时和安全错误；Provider 替换需显式协议/能力兼容，销毁释放资源。
- [x] 建立 `editor-collaboration` 工作区包；Hocuspocus SDK 从可选入口导出，Yjs/Provider 作为 optional peer，消费样例从构建包入口连接真实服务。
- [x] **D-02：** 完成真实数据库和协同 Provider 原型，验证服务端事务成功后才 ack、提交失败不清队列、重复重放返回同一 durableSeq；PostgreSQL 故障恢复后内容重开通过。
- [x] 按 D-03 实现并发 Block 结构与唯一 ID 服务端原型，并形成可复现验收用例；菜单只在已同步、可写且具备服务端提交接口的 session 上提交，真实 Tiptap/React 消费样例已通过正文输入、复制、删除、三类转换及上下移的完整菜单动作矩阵，均收到持久化回执；结构命令提交后崩溃恢复、operationId 幂等重试和历史重复 ID 的新 generation 修复均已验。
- [x] **D-06（首期）：** 限定单实例 owner、明确连接/房间/更新帧容量上限；全局 TCP 超限拒连、owner 锁冲突和数据库恢复 smoke 已通过。多实例能力另行规划。

### 服务端、文档产品与前端

- [ ] **SV-01（进行中）：** 已添加可替换的 PrincipalAuthenticator 端口、Principal.tenantId、租户隔离查询、owner-managed document_acl、文档读取与授权/撤销接口；read ACL 可取得只读协同 session，write ACL 才能写/重放/执行结构命令，ACL 改动关闭对应房间连接。导出 `startServer({ identityAuthenticator })` 供宿主注入生产身份 provider，且 CLI 入口安全失败于缺失配置。知书自己的 Compose PostgreSQL 上已执行 migrations `0000`–`0006`，`pnpm smoke` 已验证项目库上的租户 ACL、只读 session 和撤权路径；共享数据库实例未改动。仍需实际宿主身份适配、分享委托与多实例撤权广播、评论/导出/AI action 接入。
- [ ] **SV-02（进行中）：** 已实现租户/ACL 过滤的全部可访问、我的、最近、收藏、归档和回收站列表，标题搜索/分页、最近访问记录、收藏、metadataRevision 条件改名、归档/回收站/恢复/owner 永久删除与会话撤销；这些文档生命周期 API 已在知书独立 PostgreSQL 上通过 `pnpm smoke`。模板复制现在按源代次/durableSeq 重放并校验协同更新，复制正文和格式、为所有 Block 生成新 ID、重建新代次的结构投影；ACL、Block 操作回执和历史 tombstone 不复制，项目 PostgreSQL 专项 smoke 已通过。空间/文件夹目录、目录移动和完整模板/资产策略未实现。
- [ ] **SV-03（进行中）：** WebSocket ticket/租户 ACL 复核、generation/schema 协商、正文候选更新的共享 Schema 校验、正文→Block maps 的同一 durable delta 投影、按序持久化及 durable ack、数据库恢复/重复更新/重开、read-only 与 ACL 撤权断连、单实例容量治理已有实现和 smoke；结构命令→正文 XmlFragment adapter 已在隔离 PostgreSQL/WebSocket smoke 验证，真实 Tiptap/React 消费页面已验正文编辑及复制、删除、类型转换、上下移菜单动作的持久化回执；隔离 PostgreSQL 上正文与结构命令的提交后崩溃恢复均通过。历史重复 ID 维护命令已通过专项 PostgreSQL smoke，项目本地库扫描 26 篇活动文档没有修复候选。知书独立 PostgreSQL 已应用 migrations `0000`–`0006`，项目库 HTTP/ACL smoke 通过；仍需项目 WebSocket 数据库验收。
- [ ] **SV-04（进行中）：** 已实现命名版本（记录源 generation/durableSeq）、read ACL 列表/读取、按持久化序号重建并校验历史 JSON 内容、带 generation/durableSeq 前置条件的事务恢复：Yjs 日志前缀复制到新 generation 并关闭旧会话。自动版本在每个 generation 首次有意义的持久化正文变更时创建；正文继续变化时最短间隔 30 分钟创建一次，每篇文档最多保留 50 个自动版本，命名版本不自动清理。隔离 PostgreSQL/WebSocket smoke 验证条件恢复；知书独立 PostgreSQL 上 HTTP smoke 和浏览器验收覆盖版本内容、自动/命名版本列表、历史差异、恢复及新 generation。最新 JSON 投影已实现，但历史版本仍从 Yjs 序列日志读取；大文档/多版本恢复和快照/保留清理策略的完整运营验证待完成。
- [ ] **SV-05（部分）：** 已加入私有 S3 兼容存储适配、上传会话和有上限的 JSON Base64 上传、PNG/JPEG/WebP/PDF 文件签名/长度校验、SHA-256 与对象元数据确认、取消、短时 assetId 授权读取 URL，以及 `pnpm assets:cleanup` 过期上传/无引用对象回收。图片 Schema、工具栏上传、签名 URL DOM 注入和正文持久化事务中的同文档 ready asset 校验已接通；引用按 durableSeq 绑定当前正文/保留版本，版本恢复会继承引用，模板复制遇图片时安全拒绝。migration `0009_exotic_molten_man.sql` 已应用到知书独立 PostgreSQL；`pnpm smoke:asset-references` 已验证版本引用保留、恢复继承、无效资产回滚和移除后的引用清理。当前环境未配置可用 S3 endpoint，本地 MinIO 镜像拉取被镜像仓库拒绝，真实对象上传/读取、失败重试与对象存储故障恢复尚未验收，因此不勾选。
- [x] **SV-08（M2 基础）：** 每个 durable update 与 `document_outbox` 事件在同一事务提交；记录正文哈希、Block/文本/资产摘要，并由独立生命周期 worker 投影每代次最新 JSON 快照。任务使用 `SKIP LOCKED`、30 秒租约 token、防旧 worker 覆盖、1 秒起指数退避、8 次失败后 dead-letter；新更新会合并较旧待处理正文载荷，已完成任务清除 JSON 载荷。`/health/ready` 返回 pending/processing/dead 数量；migration `0010_easy_cannonball.sql` 已在知书独立 PostgreSQL 应用。`pnpm projection:backfill` 为升级前 26 个当前代次补齐投影，第二次执行确认 26 个均已是最新且无重复写入；`pnpm smoke:projection` 验证事务 outbox、投影、摘要、合并、重试、死信及旧快照保护。Yjs 更新日志仍是正文恢复事实源；投影用于派生读取，暂不压缩 Yjs 日志、也不为历史版本生成快照。
- [ ] **SV-13（基础）：** `/health/live` 与数据库 readiness 已实现，readiness 返回 SV-08 投影队列 pending/processing/dead 汇总。每个 HTTP 响应带服务端生成的 UUID `x-request-id`，忽略客户端自报 ID；文档创建/复制、改名、归档/回收站/恢复/永久删除、版本创建/恢复、ACL 变更、Schema 迁移和 Block ID 修复会在业务事务中写入 `document_audit_events`，记录租户、可信操作者、资源/代次、request ID 与非正文详情，并按 request ID 建立租户索引；永久删除后审计仍保留。migrations `0011_wide_purple_man.sql`、`0012_sour_spitfire.sql` 已应用到知书独立 PostgreSQL；一次性 PostgreSQL API 验收确认服务忽略伪造 request ID、审计行匹配真实 request ID 和可信操作者，永久删除后记录保留。设置 bearer token 后 `/metrics` 提供 HTTP 计数/延迟直方图及协同 session ticket 签发数；指标仅保存在单进程内，不含活跃 WebSocket session，也未做多实例聚合。协同正文仍以带操作者和 durableSeq 的 Yjs 更新日志追溯，不重复写逐帧审计。基础备份恢复演练和租户资源上限仍待完成。
- [ ] **SV-16（M2 基础）：** 支持 JSON 导入/导出、授权、导入报告和大任务状态；扩展格式在 M4 处理。
- [ ] **M2 API 合约（部分）：** documents 列表/创建/读取/标题修订/模板复制/收藏/生命周期/ACL（列表返回可空 deletedAt）、collaboration session、命名版本/历史正文读取与条件恢复，以及上传会话/内容/完成/取消、资产授权读取和引用登记已有 Zod route contract 并导出 OpenAPI；PNG/JPEG/WebP 的 app-web 上传宿主已接入。普通模式 content 读写、附件端到端、幂等及完整授权错误契约仍待补齐。
- [x] **M2 数据库迁移（协同基础）：** 建立 documents、document_generations、Yjs update log，含 owner/tenant、generation、唯一 update hash 和 durableSeq 约束；基础 projects migration `0000_cool_mordo.sql`、文档/协同 migration `0001_cute_old_lace.sql` 与组合 generation 外键迁移 `0002_wise_venus.sql` 已在本地 PostgreSQL 执行。
- [ ] **M2 数据库迁移（剩余）：** ACL `0003_complete_violations.sql`、metadata/lifecycle/favorites/recents `0004_smiling_quicksilver.sql`、named versions `0005_rich_earthquake.sql`、协同来源帧 hash 去重 `0006_smooth_nomad.sql`、自动版本类型 `0007_open_glorian.sql`、资产/引用 `0008_stiff_miek.sql`、按 durableSeq 绑定引用的 `0009_exotic_molten_man.sql`、JSON 投影/outbox `0010_easy_cannonball.sql`、文档审计 `0011_wide_purple_man.sql` 和 request ID 查询索引 `0012_sour_spitfire.sql` 已在知书独立 Compose PostgreSQL（`127.0.0.1:5432/app`）执行。Yjs 压缩检查点与恢复前缀裁剪仍未实现；共享数据库实例（`127.0.0.1:15000`）与其他项目数据未改动。
- [x] **WEB-01：** 实现 `/documents` 工作台：最近/我的/全部/收藏/归档/回收站视图、创建、标题搜索、服务端排序与分页、空态、收藏/归档/移入回收站/恢复/永久删除入口；URL 保存筛选状态，操作按 owner 能力显示。服务端排序和 OpenAPI 客户端已接通，app-web 已纳入根级类型检查/构建。
- [ ] **WEB-02（部分）：** 已接入 app-server/Hocuspocus 正文协同会话、Tiptap 编辑器、连接/同步/durable ack 分立状态、generation/schema/durableSeq 展示、基础大纲、只读原因、未确认修改探测及登出保护；PNG/JPEG/WebP 上传、协同图片插入和服务端授权图片读取已接入；文内查找已接入编辑器页，消费样例浏览器验证了跨 Mark 定位、大小写不敏感和循环导航。此前已实测中文正文从 durableSeq 2 保存至 24，刷新并重新登录后正文与序号恢复。真实对象存储尚未配置，附件流程尚无端到端验收；仍需版本/索引状态、分享/权限入口及 app-web 页面窄屏/离线错误验收。
- [x] **WEB-03：** 命名与自动版本列表、类型标识、作者 ID/时间/持久化序号、历史正文只读读取、Block 差异预览和带确认的新 generation 恢复已实现；本地 PostgreSQL 浏览器验收通过自动版本只在首次有效持久化更新生成、30 分钟间隔抑制重复版本、50 个自动版本保留上限、命名版本创建及恢复正文。
- [ ] **WEB-04（部分）：** 回收站列表展示移入时间和状态；提供 owner 能力控制的恢复、永久删除，并二次确认不可撤销操作、展示行级处理中状态。服务端回收站/恢复/永久删除已有授权与生命周期检查；`pnpm smoke` 已验证列表返回有效 `deletedAt`，恢复后恢复为 `null`。自动保留期限与过期清理策略尚未定义和实现；确认保留期限前不自动永久清理。
- [ ] **WEB-14（基础）：** 支持 JSON 和基础 HTML/文本导入导出、损失报告及大任务状态。
- [ ] **WEB-15（持续）：** 提供快捷键、主题/语言、连接诊断、版本兼容提示和可访问偏好。
- [ ] 建立独立文档配置；未启用知识库/模型时不请求相关接口，也不报配置缺失。
- [ ] **D-07（M2）：** 确认窄屏基础编辑、触屏和基础导入/导出格式的实际支持范围及损失提示。

### M2 集成验收

- [x] 贯通新建 → 会话授权 → 双端编辑 → durable ack → 关闭重开 → 版本恢复；隔离 PostgreSQL/WebSocket smoke 验证版本恢复到指定 durableSeq 后新 generation 正确重开。
- [ ] 覆盖服务重启、数据库失败、重复/乱序更新、服务端重开恢复结果、权限撤销、只读、Schema 不兼容和旧 generation 写回拒绝；正文更新和结构命令的提交后进程崩溃恢复已在隔离 PostgreSQL 上通过，其他场景仍需逐项验收。
- [ ] 覆盖附件取消/重试/目标删除/孤儿清理，及只读快照不连接当前可写 Y.Doc。
- [ ] 验证在线/同步/持久化是独立状态；app-web 已分别展示 connected、synced、durable ack 状态，浏览器重载确认已保存序号与正文一致；仍需在延迟/失败注入下确认 connected/synced 不会抢先显示已保存。
- [ ] M2 前固定浏览器、数据集和性能测量方式；校准基线：约 1,000 Blocks/1 MB/20 协作者，输入到绘制 P95 ≤100 ms、远端可见 P95 ≤500 ms、健康存储回执 P95 ≤2 s；超限需定义降级/限制。
- [ ] 演练导出未确认修改、路由切换、离开提示、恢复旧版本与未保存草稿保留。

## M3：知识检索与 AI 产品

阶段出口：空间/文档授权贯穿索引、搜索、检索、引用和 AI；提案冲突不覆盖他人内容，索引失败可重试。

参考：[文档地图 M3](docs/README.md#7-分阶段交付)、[DC](docs/packages/document-contracts.md)、[EC](docs/packages/editor-core.md)、[AB](docs/packages/editor-ai-bridge.md)、[UI](docs/packages/editor-ui.md)、[WEB](docs/apps/app-web.md)、[SV](docs/apps/app-server.md)。

### 合约、编辑扩展和 AI bridge

- [ ] **DC-08：** 固化 authoring 请求/事件/提案合约，包含 requestId/seq、完整 OperationBatch、目标前置条件、终态/错误和大小限制。
- [ ] **DC-09：** 固化 SourceReference、快照事件与索引所需版本/Block 定位；定义重复、乱序和旧代次事件处理。
- [ ] **EC-09：** 提供可选嵌入/引用/评论装饰/AI 操作扩展；服务器 Schema 与客户端扩展一致，AI/引用能力不成为 core 前置依赖。
- [ ] **AB-01：** 支持 create/continue/rewrite/summarize/translate 和结构化 Block 任务。
- [ ] **AB-02：** 捕获 documentId/generationId、稳定 Block/Anchor、目标摘要与允许操作范围，不保存过期绝对位置。
- [ ] **AB-03：** 消费 SSE/AsyncIterable，校验 requestId/seq、重复/缺失事件、大小/时间限制并支持 AbortSignal。
- [ ] **AB-04：** 实现增量草稿、原文对照、完整提案预览和不完整/失败草稿保留。
- [ ] **AB-05：** 实现整批或合法操作单元接受/拒绝；接受前重验并由 core 单个逻辑事务应用，重复接受幂等且可撤销。
- [ ] **AB-06：** 覆盖目标漂移/删除、他人修改、切换文档/代次、只读撤权和 IME 中接受冲突。
- [ ] **AB-07：** 处理取消、超时、限额、断流、无效结构、失败重试和重复事件；失败不得改正文，重试保留旧草稿。
- [ ] **AB-08：** 校验引用与扩展；宿主负责来源卡片授权，禁止将模型任意 URL 当可信引用。
- [ ] **AB-09：** 分别上报生成、应用、持久化结果；日志脱敏并释放请求/订阅。
- [ ] **UI-10：** 提供 AI 动作、指令输入、流式草稿、差异、接受/拒绝/取消/冲突界面。
- [ ] **UI-11：** 提供评论锚点、未读/已解决和引用来源插槽；业务数据由 app-web 管理。
- [ ] 建立 `editor-ai-bridge` 工作区包；只依赖 contracts/core，不引入 React、Yjs、模型 SDK 或平台 API，提供可替换生成服务的构建产物消费样例。

### 企业知识、检索与平台

- [ ] **SV-06：** 建立租户内空间、成员角色、文档归属/继承与覆盖策略；空间与知识库分离，默认一空间一知识库关系由服务端维护。
- [ ] **SV-07：** 完成评论线程、回复、解决/重开、Anchor 失效、提及、已读、通知去重与权限复核。
- [ ] **SV-09：** 实现知识来源、持久化快照 Block 分块、hash 增量 Embedding、索引 generation 切换、删除 tombstone、移除和重建。
- [ ] **SV-10：** 实现 Query Embedding → tenant/space/knowledgeBase 过滤 → Top-K → 文档权限/快照复核 → Rerank → 上下文预算 → 引用校验 → 流式答案；无证据时不编造引用。
- [ ] **SV-11：** 实现 AI 任务授权、模板版本、模型输出 Schema/目标/引用校验、SSE、取消、幂等、配额和安全错误码；服务端只生成提案，正文由客户端接受后写入。
- [ ] **SV-11 Prompt 设计：** 在 [app-server 设计](docs/apps/app-server.md)补充版本化系统/用户 Prompt 样例、结构化输出 Schema、引用约束和不可信检索内容的隔离规则。
- [ ] **SV-14：** 实现标题/正文搜索、权限过滤、排序/分页和片段定位。
- [ ] **SV-15（基础）：** 建立模型 Provider 适配、Prompt 版本、租户/主体限额、用量、超时降级和配置审计。
- [ ] **SV-02（空间部分）：** 接入空间目录、文档归属/移动/复制规则和租户内组织约束；文档元数据仍由 documents owner 管理。
- [ ] **M3 API 合约：** 为 spaces/memberships、comments/notifications、knowledge sources/queries、search、authoring task/events/cancel 定义 route contract、分页/条件、SSE 终态与错误，并生成前端客户端。
- [ ] **M3 数据库迁移：** 为 spaces/memberships、knowledge bases/sources/chunks/index generations、comments/notifications、authoring tasks/events、model config/quotas 建立归属与索引约束。
- [ ] **WEB-05：** 实现空间创建/加入/切换、成员角色、文档目录、移动/复制和模板。
- [ ] **WEB-06：** 实现空间内搜索、过滤、片段、相关度/时间排序和引用定位。
- [ ] **WEB-07：** 实现知识来源管理、文档关联、索引状态、失败重试和移除来源。
- [ ] **WEB-08：** 实现知识域选择、问答流、引用/来源、无证据、取消/重试和权限失效状态。
- [ ] **WEB-09：** 实现 AI 创建/续写/改写/摘要/翻译、知识上下文、目标预览差异和确认应用。
- [ ] **WEB-10：** 实现选区评论、回复、解决/重开、未读/提及及锚点失效提示。
- [ ] **WEB-11（M3 部分）：** 实现评论/提及/权限变化通知、已读状态和跳转后的重新授权；审批通知放 M4。
- [ ] **WEB-12（M3 基础）：** 实现成员、权限策略、知识/模型配置入口、容量/任务状态和基础审计检索。
- [ ] **D-05：** 用同一评测集选定向量库、Embedding、Rerank 与中文分块策略；记录质量、成本、隔离、删除/重建和私有部署结论。
- [ ] 建立索引/问答评测集：中文术语、跨空间同名、无答案、错误引用、权限撤销、文档删除和索引滞后。

### M3 集成验收

- [ ] 贯通有授权文档 → snapshot-ready → 增量索引 → 空间检索 → 带来源问答 → 打开来源复权 → AI 草稿 → 用户接受 → core 事务 → 持久化确认。
- [ ] 验证撤权/删除立即从可检索集合失效；索引任务重复、乱序、失败和重建不覆盖新版本。
- [ ] 验证检索正文在发送给 Rerank/LLM 前完成权限过滤，引用只来自服务端上下文白名单。
- [ ] 验证 AI 冲突、断流、取消、重复接受及目标删除都保留原文/草稿，且持久化状态不与“生成完成”混淆。

## M4：企业增强与运维成熟

参考：[文档地图 M4](docs/README.md#7-分阶段交付)、[CO](docs/packages/editor-collaboration.md)、[EC](docs/packages/editor-core.md)、[WEB](docs/apps/app-web.md)、[SV](docs/apps/app-server.md)。

- [ ] **CO-08：** 实现可选持久离线缓存、tenant/user/document/generation 隔离、重开恢复、撤权/登出清理和在线再授权。
- [ ] **EC-11：** 按明确格式覆盖逐项实现高级内容、受控外部嵌入和复杂导入；提供不能保真的内容损失报告。
- [ ] **SV-12：** 实现绑定不可变 versionId 的审批实例、提交/撤回/通过/驳回、策略版本、审计和编辑后重新提交规则。
- [ ] **SV-13（完整）：** 完成容量/租户配额、指标告警、RPO/RTO、备份/恢复、版本迁移演练和生产运维手册。
- [ ] **SV-15（完整）：** 完成企业模型配置治理、租户配额/用量、超时/降级策略与完整审计。
- [ ] **SV-16（扩展）：** 实现复杂格式导入/导出和外部数据源同步；每种格式列出支持范围、损失、权限与删除同步语义。
- [ ] **WEB-11（审批）：** 增加审批通知、未读状态和授权跳转。
- [ ] **WEB-12（完整）：** 补齐细粒度企业策略、模型治理、容量/租户任务和完整审计管理。
- [ ] **WEB-13：** 实现指定版本审批/发布、审批意见、撤回、通过/驳回及变更后重新提交。
- [ ] **WEB-14（复杂格式）：** 增加异步大任务、兼容报告、失败恢复和复杂格式支持范围提示。
- [ ] **M4 API 与迁移：** 为 approvals/workflows、发布、外部数据源和复杂导入导出定义版本条件、审计事件、任务状态及 OpenAPI/迁移约束。
- [ ] **D-06（扩容）：** 多实例协同前完成房间路由、owner 租约/fencing、共享事件发布、故障接管和持久化序列验证。
- [ ] **D-07（扩展）：** 每个阶段开始前确认新增浏览器、窄屏、内容格式和转换损失承诺。
- [ ] 决定是否交付协同光标跟随视图；若纳入范围，定义权限、焦点和退出行为后再排期。参考：[UI-09](docs/packages/editor-ui.md)。
- [ ] 演练完整备份恢复：元数据、Yjs 更新/检查点、文档版本和附件；验证向量索引可按记录的模型/分块配置重建。
- [ ] 完成升级迁移和回退演练；旧客户端遇到不兼容 Schema/扩展/协议时安全只读或拒绝写入，不静默丢内容。

## 跨阶段质量与交付门槛

- [ ] **安全与隔离：** HTTP、WS、SSE、检索、附件、导出和 AI 任务逐次授权；服务端不信任客户端 tenantId/spaceId；跨租户缓存、通知、引用和离线数据隔离。
- [ ] **状态语义：** 分别表达本地修改、已发送/同步、服务端已持久化、业务版本已生成和索引已完成；不以单个“保存成功”代替。
- [ ] **数据可靠性：** 未知/无效节点不静默丢弃；JSON 和 Yjs 投影一致；Block ID 稳定；备份恢复保留正文与附件引用。
- [ ] **错误与恢复：** loading/empty/error/retry/read-only/offline/saving/conflict 均有明确提示与后续动作；错误不泄露 token、secret、正文、Prompt、SQL 或供应商原始响应。
- [ ] **资源治理：** 编辑器销毁释放连接/监听/定时器；AI/上传/索引任务支持取消、超时、有限并发、幂等重试和可见失败。
- [ ] **数据与性能：** 明确文档大小、Block 数、协作者数、帧大小、索引滞后和资源限制；容量目标经固定环境压测校准，超限有降级策略。
- [ ] **任务与事务：** 主数据变更与 outbox 同事务提交；异步任务有租约、有限并发、超时、退避、幂等、死信和可重试状态；对象存储、向量库和模型副作用可独立恢复。
- [ ] **部署启动：** 按功能配置启用服务模块，仅检查已启用模块依赖；正常启动先检查数据库，OpenAPI 离线导出不连接数据库；明确 WSS/反向代理/环境变量与优雅停机配置。
- [ ] **无障碍与平台：** 真实键盘、中文 IME、屏幕阅读器、触屏/窄屏、减少动画和焦点恢复验收通过；自定义 NodeView/插槽执行相同要求。
- [ ] **API 与发布：** route contract 是 REST/OpenAPI 源；前端客户端从 OpenAPI 生成；package exports/类型/peer 范围/Schema/扩展/协同协议兼容矩阵齐全。
- [ ] **文档同步：** 每项实现后更新对应设计文档源码入口、实际支持状态、验证结果和限制；已发布 migration 不回写，合约变更附迁移/兼容说明。
- [ ] **最终端到端验收：** 真实 PostgreSQL 与协同服务覆盖数据库失败、进程重启、旧代次更新、重复任务、跨租户访问、撤权检索、失效引用、模型中断和恢复演练。
