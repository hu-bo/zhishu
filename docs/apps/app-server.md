# app-server 设计规划

状态：M2 基础实现中。文档创建、短时协同会话、PostgreSQL Yjs 更新日志、版本/资产 API 和最新 JSON 投影/outbox 已实现；真实对象存储、大文档版本恢复、完整 ACL 和其他业务仍按阶段补齐。对应 `apps/app-server`；[返回文档地图](../README.md)。本文统一维护服务端、数据业务层、协同持久化、知识库及 AI/RAG 的设计。

2026-10-02 已接通知识库目录与元信息：`GET/POST /api/knowledge/workspaces`、`GET /api/knowledge/workspaces/:workspaceId/tree`、`PATCH /api/knowledge/documents/:documentId/location`、`GET /api/knowledge/search` 和 `POST /api/knowledge/workspaces/:workspaceId/presets`。实现位于 documents feature，Zod 驱动 OpenAPI 与 Orval。迁移 0023 增加 Emoji/彩色标签；0024 建立租户工作区、父子关系、排序和预设安装记录，并为已有文档补默认工作区。迁移需显式执行，本次只应用于隔离测试数据库。

目录只返回当前主体可访问的活动文档；不可见父页的可见子页显示在根目录，面包屑与搜索路径不会暴露隐藏祖先名称。移动只允许所有者，校验 metadataRevision、目标父页写权限、循环和 64 层上限；跨工作区移动还要求拥有整个子树。树操作在租户 advisory lock 下串行；删除或归档父页将直接子页保留到原工作区根目录，恢复父页不会重新收走这些子页。图标、标签和目录变化与正文快照修订分开。

搜索按租户、文档 ACL 和可选工作区过滤标题与已保存正文，使用 PostgreSQL 字面 `ILIKE`，转义 `%`/`_`；普通文档读取 JSON 快照，协同文档读取当前 generation 的投影，结果含匹配片段与可见祖先路径。每次最多 30 项；协同投影存在延迟，暂未提供全文索引排名或附件内搜索。预设初始化是显式事务，同一身份/工作区重复执行跳过已有安装记录；删除后保留安装标记，避免重新播种。内容哈希复用普通保存的规范化算法。

对象存储继续使用既有 S3 兼容客户端，对应 MinIO endpoint `http://minio.8and1.cn:80`、HTTP、80 端口。`ASSET_STORAGE_CHECK_ON_STARTUP=false` 跳过启动连接检查，`ASSET_STORAGE_AUTO_CREATE_BUCKET=false` 禁止自动建桶。开发环境未填凭据时不构造存储客户端，附件返回 unavailable；生产环境仍要求完整配置。实际密钥须由部署者填写，当前域名暂不可用，本次未连接或测试对象存储。

## 1. 服务定位与部署组合

沿用 Fastify、PostgreSQL、Drizzle、Zod 与现有 domain-error 约定。feature 在 `src/modules` 内组装 repository/service，业务服务接收明确的身份上下文和 port，不依赖 FastifyRequest/Reply。数据库仍位于 `database` 内部目录，与 src 一起编译；运行入口维持 `dist/src/server.js`。协同 WebSocket 由同进程的自托管 Hocuspocus listener 提供独立端口，反向代理可暴露在同一 WSS 域名下；本地默认 API 3000、协同 3001，优雅停机同时关闭两者。

| 运行配置        | 必需模块/依赖                                                                      | 可选能力                                 |
| --------------- | ---------------------------------------------------------------------------------- | ---------------------------------------- |
| standalone-docs | 身份/文档授权、documents、collaboration、versions、基础审计、PostgreSQL 与快照任务 | 附件存储、评论；不要求空间、向量库或模型 |
| enterprise      | standalone-docs + spaces/成员、knowledge-base、检索/创作任务及策略                 | 审批、外部数据源、模型治理与高级审计     |

独立模式仍有真实身份与文档级授权。租户可由部署固定为单租户，document 的 spaceId 可为空；不得把“独立”实现成匿名任意读写。宿主接入可通过身份/权限适配器映射外部主体。

首期保留一个应用包。后台任务可使用该包的独立 worker 入口运行并复用业务模块，具有自己的启动/停止和数据库连接；不依附单次 HTTP 请求的无人管理 Promise。将来确有独立应用时再增加 workspace 与主文档。

## 2. 模块与功能清单

| 编号  | 模块                         | 功能细节                                                                 | 阶段                  |
| ----- | ---------------------------- | ------------------------------------------------------------------------ | --------------------- |
| SV-01 | identity / authorization     | 身份校验、租户上下文、文档 ACL、读写/评论/分享/导出/AI action、宿主适配  | M2                    |
| SV-02 | documents                    | 创建、模板复制、元数据、目录、收藏/最近使用、归档、回收站、恢复/彻底删除 | M2；空间组织 M3       |
| SV-03 | collaboration                | WS 会话、代次/Schema 协商、同步、落库回执、恢复、撤权与连接治理          | M2                    |
| SV-04 | versions                     | 自动/命名版本、差异、版本预览、恢复为新代次、保留策略                    | M2                    |
| SV-05 | assets                       | 上传、完成确认、授权读取、引用关系、取消/失败、孤立文件清理              | M2                    |
| SV-06 | spaces / memberships         | 空间、成员角色、文档归属、继承与覆盖策略、知识库关联                     | M3                    |
| SV-07 | comments / notifications     | 线程、锚点、回复/解决、提及、已读、通知投递及去重                        | M3                    |
| SV-08 | document-projection / jobs   | 持久化事件、JSON 快照、增量摘要、队列、重试/死信与任务状态               | M2 起                 |
| SV-09 | knowledge-base               | 知识来源、增量分块、Embedding、索引代次、移除、重建和状态                | M3                    |
| SV-10 | retrieval                    | Query Embedding、过滤/召回、Rerank、上下文、引用问答与无证据处理         | M3                    |
| SV-11 | ai-authoring                 | 生成/续写/改写/摘要/翻译、输出校验、SSE、取消和配额                      | M3                    |
| SV-12 | workflows                    | 指定版本审批、提交/撤回/通过/驳回、发布策略与审计                        | M4                    |
| SV-13 | audit / operations           | 关键操作审计、健康/指标、备份恢复、迁移、容量和租户资源上限              | M2 基础；M4 完整      |
| SV-14 | search                       | 文档标题/正文搜索、权限过滤、排序/分页、定位片段                         | M3                    |
| SV-15 | model-config / quotas        | 模型适配、Prompt 版本、调用限额、用量、超时/降级与配置审计               | M3 基础；M4 完整      |
| SV-16 | import-export / data-sources | 内容导入报告、授权导出、批量任务、外部数据源同步                         | M2 JSON 基础；M4 扩展 |

comments、notifications 等模块可以先在相关 feature 内实现，复杂度和变更责任清晰后再细分目录。模块通过公开 port/event 通信，不读取其他模块的私有 repository 或 ORM 结构。

## 3. 身份、权限与数据隔离

鉴权产生可信 `Principal` 与 tenantId；路径/请求体中的空间和文档 ID 只作为待验证资源标识。服务端所有查询、写入、WS 加入、附件读取、检索、SSE 任务及导出均携带可信租户和 action 范围。

权限 port 接收 principal、resource、action、当前上下文，返回允许/拒绝和安全原因码。默认拒绝；独立模式提供最小文档 ACL 实现，企业策略插件可结合角色、组织与文档继承规则，但不能绕过租户边界。审计记录策略版本和决策结果，不记录敏感凭据。

HTTP 每次请求检查权限；WS 在加入与写入处理时检查当前授权，订阅撤权事件或使用可失效的授权版本，不能只在连接建立时检查。知识召回在文本进入 Rerank/LLM 前完成文档级过滤，引用打开再次授权。长任务和 SSE 订阅权限失效信号并停止交付，返回来源内容前复核当前权限。

已实现的 M2 权限基础：`PrincipalAuthenticator` 是可替换的身份解析端口；`AUTH_MODE=external` 可通过 `buildApp` 注入可信身份适配器，Principal 带 `tenantId`，HTTP 与协同查询同时限定租户和文档 action。宿主可导入 `startServer({ identityAuthenticator })` 启动标准 HTTP/WebSocket 服务并注入实际 provider；本仓库尚未提供生产 provider，因此未注入时 external 模式会安全失败启动。`document_acl` 记录 `read`、`write`、`comment`、`share`、`export`、`ai` 授权；所有者隐式拥有全部 action，读权限也可由写、评论、导出或 AI 权限满足，写权限包含评论权限。当前 ACL 由所有者管理，更新后关闭该文档活动代次的协同连接，要求客户端重新取 session。`GET /api/documents/:id` 检查 read 并返回主体相关的 `canManage`，`GET /api/documents/:id/acl` 仅所有者可列出授权主体，`PUT/DELETE /api/documents/:id/acl/:identityId` 检查所有权；read-only reader 可取得只读协同 ticket，协同握手按 read 检查，写入、重放和结构命令复核 write。JSON 导出要求 owner 或显式 export action，并在复核权限的事务中记 `document.exported` 审计；评论、分享委托和 AI 业务接口尚未实现。migrations `0000`–`0016` 已在知书自己的 Compose PostgreSQL（`127.0.0.1:5432/app`）执行；既有项目 smoke 已覆盖 tenant ACL、只读 session、撤权、文档生命周期及版本恢复，导入导出路由仍待专项运行验收。另一个共享 PostgreSQL 实例未被更改。

## 4. 数据归属与关键约束

以下为逻辑表规划；字段/索引在实现前细化到 migration。业务模块拥有数据，Drizzle row 不穿透 repository 返回给包消费者。

| 数据集合                                                   | owner                         | 关键字段与约束                                                                                                                                                                                  |
| ---------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| documents                                                  | documents                     | tenantId、documentId、可空 spaceId、title、standard/collaborative 模式、状态、activeGenerationId、metadataRevision；租户内身份唯一                                                              |
| document_acl / memberships                                 | authorization / spaces        | 主体、资源、action/角色、策略版本；成员变更可使缓存失效                                                                                                                                         |
| document_generations                                       | collaboration                 | tenantId、documentId、generationId、Schema/扩展集、初始化标记、当前持久化序列                                                                                                                   |
| document_updates / checkpoints                             | collaboration                 | generationId、durableSeq、存储更新 hash、来源帧 hash、二进制增量与带校验和的 generation/version 检查点；序列和去重键唯一                                                                        |
| document_projection_snapshots                              | document-projection           | generationId、覆盖的 durableSeq、snapshotRevision、当前 JSON/hash 与 Block/文本/资产摘要                                                                                                        |
| document_json_snapshots                                    | documents                     | standard 模式当前 JSON/hash、snapshotRevision 与内容摘要；PUT 按修订号原子更新                                                                                                                  |
| document_outbox                                            | document-projection/jobs      | durable update 事件、增量摘要、投影载荷、租约、退避重试与 dead-letter；按代次唯一去重                                                                                                           |
| document_versions                                          | versions                      | versionId、generationId/durableSeq 位置、命名/创建者；历史 JSON 仍可从 Yjs 日志重建                                                                                                             |
| assets / asset_references / document_json_asset_references | assets / documents            | tenantId、assetId、对象键、大小/MIME/hash、上传状态及协同 durableSeq 或 standard 正文的文档引用；对象键不作为公开身份                                                                           |
| spaces / knowledge_bases                                   | spaces / knowledge-base       | 各自 ID、tenantId、关联；初期每空间一个知识库，独立文档无需空间                                                                                                                                 |
| knowledge_sources                                          | knowledge-base                | 文档/外部源引用、索引策略、目标快照、activeIndexGeneration、同步状态                                                                                                                            |
| knowledge_chunks / index_records                           | knowledge-base                | sourceId、snapshotRevision、blockId/path、chunkOrdinal、contentHash、模型/切分器版本                                                                                                            |
| authoring_tasks / task_events                              | ai-authoring                  | requestId、attempt、身份与资源范围、目标版本、状态、输出、序号/保留期限                                                                                                                         |
| comment_threads / comments                                 | comments                      | 文档、版本/锚点、创建者、解决状态；锚点失效仍保留合法讨论                                                                                                                                       |
| approval_instances / decisions                             | workflows                     | versionId、流程/策略版本、步骤与结果；决策不指向持续变化的草稿                                                                                                                                  |
| document_audit_events / outbox / jobs                      | documents / projection / jobs | 文档控制面审计含 tenant、可信 actor、request ID、资源/代次与非正文详情；与业务变更同事务提交，按 tenant/request ID 和资源建立索引，永久删除后保留；outbox/jobs 提供幂等键、租约、重试和失败状态 |

外键与唯一约束覆盖租户/资源归属，不能只依赖应用层过滤。Block 是文档内容身份；索引表里的 Block/片段是派生数据，不建立第二套可独立写入的正文表。正文、元数据、业务版本和知识索引各有清楚的版本号。

## 5. 协同正文与保存协议

协同模式以当前 generation 的 Yjs 二进制日志/检查点作为正文事实源。JSON 用于预览、导出、版本和索引，不作为并行写入口。普通模式以 `document_json_snapshots` 保存 JSON 正文，`GET /content` 返回 `readOnly` 能力，`PUT /content` 必须提交当前 `snapshotRevision`；权限、修订号、正文与图片/PDF 资产引用在一个事务内复核/更新。若客户端未收到成功响应并以旧修订号重试，服务端仅在当前快照恰好是该请求提交出的下一修订且规范化正文哈希相同时，返回原修订成功，不重复写正文或审计；更早修订或内容不同仍返回冲突。本地两标签页浏览器验收确认旧修订写入被拒绝，重载后读取先提交正文，未发生覆盖。该语义只覆盖普通正文 PUT。文档创建、JSON 导入、模板复制、命名版本创建、标题修订、生命周期、ACL 授权/撤销和资产上传会话创建支持可选 `Idempotency-Key`：按 tenant、subject、operation 和 key hash 隔离，成功结果与资源在同一事务保存，24 小时内同键同请求重放原响应，同键异请求返回 409；资产上传重放前重新检查活动文档写权限，容量预留仅对新会话执行；ACL 变更重放前重新确认操作者仍是活动文档所有者，重放不重复审计或再次撤销会话。项目独立 PostgreSQL HTTP 验收已确认上传会话同键重试回放同一 assetId/到期时间、同键改请求返回 409，且租户只预留一条会话；ACL 授权重试不重复审计、异权限返回 409、撤销重试返回 204。上传验收时 S3 健康检查由本地响应桩提供，不表示已完成生产对象存储验证。收藏 API 采用资源状态语义，其他变更路由仍待接入该回放协议。发起协同 session 是显式初始化：有写权限的主体把普通 JSON 正文和结构投影写入新 Yjs generation，再原子切换模式；竞争初始化会复用已启用的协同代次。进入协同模式后，正文 PUT 返回模式冲突。

`POST /api/documents/:id/versions/:versionId/restore` 也接受可选 `Idempotency-Key`。服务端先复核当前 write 权限，再回放已保存的文档响应；首次恢复、版本恢复审计和 24 小时回执在同一事务提交。standard 与 collaborative 两种目标模式均已在项目独立 PostgreSQL 上通过 HTTP 验收：重复请求分别保持同一 `snapshotRevision`/generation 与单条恢复审计；复用键提交不同恢复条件返回 409。收藏 API 采用资源状态语义，其他变更路由仍待接入该回放协议。

目标可靠写入顺序：

1. 会话握手验证身份、文档、generation、Schema 与协议，加载检查点和其后的更新；加载失败拒绝进入可写状态。
2. 当前房间 owner 串行处理更新，检查大小、授权与代次，在隔离/暂存状态验证更新后的内容结构及不变量。
3. 同一数据库事务写入二进制更新、去重标识、durableSeq 和 outbox；提交时再次确认 activeGeneration 未改变。缺少因果前提的更新先补同步或有限缓冲，不标记保存成功。
4. 提交后向客户端返回覆盖其更新的持久化回执并发布同步结果；重试相同更新返回已有结果，不重复创建业务事件。
5. 投影 worker 将 durable update 对应的 JSON 写入每代次最新快照；未来索引任务可消费投影事件。Yjs generation 检查点用于连接恢复，版本检查点固定历史序列；裁剪只清除可由检查点重建的 update 二进制，保留序号与 hash 元数据用于幂等回执和资产外键。

当前 M2 原型已实现会话认证、tenant-scoped 文档 ACL 复核、generation/schema 校验、Yjs 二进制日志、来源帧幂等键、数据库行锁序号分配、事务成功后的 stateless 回执和加载时按序重放。每个可写 Yjs 更新在落库前都会应用到临时候选 Y.Doc，将 `content` XmlFragment 转成 ProseMirror JSON，经共享 `normalizeTiptapDocumentJSON` 归一化后调用 `validateDocumentContent`；它会移除 Y-Tiptap 产生的空 Mark `attrs: {}`、`codeBlock.attrs.language: null` 和表格单元格默认跨度/空宽度/空对齐属性，其他非法节点/属性、重复 Block ID 和超出共享内容限制的更新会被拒绝。正文变更及对应的 Block/顺序 maps 现在作为同一个持久化 Yjs delta 落库。结构操作另走 `structure-operation` stateless 命令：按文档串行检查规范 JSON 树，先在候选 Y.Doc 中把 maps 状态同步回 `content` XmlFragment，再保存包含正文、maps 和操作回执的单个持久化 delta；并发使用单调 structure revision 拒绝过期命令。客户端不得直接写规范投影；结构投影失败只拒绝该操作并记录安全诊断，不终止服务进程。缺少投影或与正文失配的非空旧代次 fail closed；双向投影已由隔离 PostgreSQL/WebSocket smoke 验证。每个 Yjs 更新与 outbox 事件/摘要同事务提交；新更新会合并较旧未处理正文载荷，worker 以 PostgreSQL 行锁、租约 token 和序号条件写入最新 JSON 投影，成功后清除临时正文副本。迁移 `0010_easy_cannonball.sql` 已在项目 PostgreSQL 执行；`pnpm projection:backfill` 可为存量文档当前代次幂等构建投影，已为本地 26 个代次补齐，再次运行均报告已最新。`pnpm smoke:projection` 验证 outbox 原子性、投影和摘要、更新合并、退避重试、dead-letter 以及失败时保留最后成功快照。`/health/ready` 暴露 pending/processing/dead 数量。`document_generation_checkpoints` 保存最新可恢复 Yjs 状态，`document_version_checkpoints` 保存被裁剪前的各历史版本状态；`pnpm maintenance:compact-updates -- --apply` 先复放并验序，再在锁定文档/代次的单事务中写入检查点、SHA-256 并将前缀 updateBytes 置空，保留 update/source hash 行供重复回执和资产引用外键使用；命令只接受项目本地 `127.0.0.1:5432/app`。协同重开、导出、复制、迁移、修复和版本读取均从 generation/version 检查点加后续增量复放；版本恢复以检查点启动新代次。压缩命令与检查点恢复仍需隔离 PostgreSQL 专项验收；历史快照存储量随保留版本数增长，索引消费者尚未实现。

历史重复 Block ID 使用 `pnpm --filter @react-fastify-template/app-server maintenance:repair-block-ids` 检查；默认只扫描并 dry-run，`--document <documentId>` 可限定单篇文档。只有明确附加 `--apply` 和单一文档 ID 时才会提交修复；命令会申请与协同服务相同的 PostgreSQL advisory owner lock，服务未停止时拒绝写入。修复只接受错误全为 `duplicate-block-id` 的内容，保留首次 ID、为后续重复项生成新 ID，以 XmlFragment 正文重建结构投影，在一个事务中退休旧 generation 并创建新的当前 generation；源更新日志保留供审计/历史读取。其他内容问题、更新日志缺口或并发代次变化均 fail closed。专项 `smoke:repair-block-ids` 在本地 PostgreSQL 验证 dry-run 无副作用、内容保留、ID 唯一、投影重建和旧代次退休。

协同 session 为有写权限的客户端提供 Schema 迁移入口：服务端按 active generation 的 `durableSeq` 重放更新日志生成候选 JSON，检查更新序列连续性并验证源内容，再执行显式注册的单向迁移。当前 server 目标为 Schema v4，支持 v1→v2 任务清单、v2→v3 表格以及 v3→v4 文字格式的内容保留步骤；v3→v4 不重写既有正文。成功后一个 PostgreSQL 事务检查源 generation/schema/序列未变化，创建新 generation 和迁移后的 Yjs 初始更新、退休旧 generation、写入迁移步骤审计及独立 JSON 中间快照，并增加 metadataRevision；提交后关闭旧代次连接。失败或源文档并发变化时保留原代次。源正文仍可从旧 generation 重建，目标正文随新 generation 和 projection outbox 提交；审计事件只存 migrationId 和步骤报告，不含正文快照。版本迁移仍重放 Yjs 日志，并不以可能滞后的当前投影作为输入。迁移 `0020_spotty_living_tribunal.sql` 与 `0021_public_starjammers.sql` 已应用到项目本地 PostgreSQL；新迁移 `0022_perfect_matthew_murdock.sql` 已生成，将 schema_version 默认值升级为 4，尚未在数据库执行。此前 v1→v3 与 v2→v3 的本地 PostgreSQL/HTTP 回滚和持久化验收结果仍适用于旧步骤；v3→v4 的 schema 校验与格式 JSON/HTML 往返已在 Chromium 和共享 contracts 验证。共享数据库未改动。

普通正文帧落库前会在同一候选 Yjs 更新内刷新服务端 Block/顺序 maps；该更新与正文一起只分配一个 durableSeq。`update_hash` 是实际落库 Yjs delta 的 hash，`source_update_hash` 保留客户端原始帧 hash 用于 pending replay 去重和回执。历史行的来源 hash 保持 NULL，重放查询会回退匹配历史 `update_hash`。若当前 maps 与 XmlFragment 投影不一致，服务器拒绝后续正文写入并保留原更新，避免静默覆盖投影差异。结构命令会在候选 Y.Doc 中通过 Tiptap schema 校验并同步 maps→XmlFragment；结构投影缺失或不一致时拒绝命令。隔离 PostgreSQL/WebSocket smoke 已覆盖双向投影、重开恢复、幂等与大 Block 移动；另有仅在 `NODE_ENV=test` 可配置的提交后崩溃注入，默认关闭且在其他运行模式启动校验时拒绝启用。

2026-09-27 的本地 PostgreSQL smoke 完成创建、写入、durable ack、断开后重载；第二个 Yjs 客户端同步首端内容并独立编辑，远端变更得到 durable ack。暂停 PostgreSQL 的 failure smoke 验证事务失败时客户端 pending 不清空，数据库恢复后重新同步和 replay probe 才清除队列；重复投递相同 update hash 得到相同 durableSeq。协同 smoke 还验证手动断线/重连时刷新 session ticket、pending 更新持久化；在 durableSeq 记录命名版本、继续写入后恢复到该版本，并确认新 generation 重开后只包含版本记录时的两端正文。D-03 structure smoke 验证两个真实 WebSocket 客户端的并发结构冲突、身份规则、900 KB Block 移动、重载及投影写保护。真实浏览器公开包消费页已对正文输入和 Block 菜单复制、删除、段落/标题/代码块转换、上移/下移完成逐项验收，所有操作均获得 durable ack。`examples/collaboration-consumer/src/post-commit-crash-smoke.ts` 分别在正文更新和结构命令事务提交后立即终止测试进程；重启后验证正文/maps 重载、pending update 获原 durableSeq 回执，以及相同 operationId 重放返回 duplicate，均在 loopback 隔离 PostgreSQL 上通过。验证脚本位于 `examples/collaboration-consumer/src/smoke.ts`、`src/structure-smoke.ts` 与 `src/post-commit-crash-smoke.ts`；数据库表定义与 migrations 为 `database/schema/document.table.ts`、`database/migrations/0001_cute_old_lace.sql` 和 `database/migrations/0002_wise_venus.sql`；后者保证更新行引用的 document/generation 配对一致。不能把 Provider 的“synced”事件直接映射成数据库保存成功。

初始化使用数据库约束保证只执行一次，合法空文档有明确初始化标记。压缩命令只有在 generation checkpoint 与所有受影响版本的 checkpoint 都在同一事务持久化后，才会裁剪对应更新正文；旧 checkpoint 会被新 generation checkpoint 替换，版本 checkpoint 随版本记录保留。Yjs 二进制恢复的要求依据[官方持久化说明](https://tiptap.dev/docs/hocuspocus/guides/persistence)。

首期每个 PostgreSQL 数据库只允许一个协同服务实例。服务启动 WebSocket listener 前，在专用连接上获取固定 PostgreSQL advisory lock；冲突时启动失败。该连接丢失时关闭协同 listener 并触发进程自停，避免进程继续对外接受协同写入。数据库连接池至少保留 2 个连接，其中一个供 owner lock 使用。

默认容量上限为每实例 100 条协同 TCP 连接、50 个活跃房间、每房间 20 个连接、每条连接 1 个文档、每个更新帧 1 MiB；对应环境变量为 `COLLABORATION_MAX_CONNECTIONS`、`COLLABORATION_MAX_ACTIVE_ROOMS`、`COLLABORATION_MAX_ROOM_CONNECTIONS`、`COLLABORATION_MAX_DOCUMENTS_PER_CONNECTION` 和 `COLLABORATION_MAX_UPDATE_BYTES`。全局连接上限可设为 2 至 10,000；设置为 2 的恢复 smoke 已通过。超出的 TCP 连接被关闭，房间级超限在认证时以容量错误拒绝。以上是防止无界占用的首期保护值，不是经过压测认证的吞吐量或性能承诺；可通过 `examples/collaboration-consumer` 的容量 smoke 检查全局连接边界。

advisory lock 实现的是单数据库单实例约束，不包含多实例的房间路由、owner 租约/fencing、共享发布、持久化顺序协调或故障自动接管。启用多实例前必须先完成这些机制及故障演练；仅共享 PostgreSQL 或增加广播不能自动证明并发写入正确。

## 6. 文档生命周期、版本与附件

当前 documents 模块实现租户隔离的最近/我的/收藏/全部可访问列表，标题搜索、offset 分页、收藏、最近打开记录、标题 metadataRevision 条件更新、归档、回收站、恢复及所有者永久删除。归档、移入回收站、恢复和永久删除路由接受可选 `Idempotency-Key`；状态变更、审计和 24 小时回执原子提交，同键重试返回原 204，异请求返回 409。永久删除后仍可在回执有效期内重放原 204。回收站列表包含 `deletedAt`，供界面呈现移入时间；归档或移入回收站会关闭当前协同房间，回收站中的文档可恢复为 active，只有 owner 可永久删除。自动保留期限和过期清理作业尚未定义与实现。ACL 授予 read/write/comment/export/ai 的主体可进入可访问列表，但目录不暴露 tenantId 外的文档。

JSON 导出接口为 `GET /api/documents/:id/export`，输出 `zhishu.document` v1 容器，包含标题、Schema/扩展声明和规范 JSON 正文，不含内部文档 ID；协同模式从当前 generation/durableSeq 重放 Yjs，standard 模式读取 JSON 快照，二者都在事务中复核来源修订与 export 权限并记录非正文审计。导入接口 `POST /api/documents/import` 创建新文档，校验格式、Schema、扩展、正文及 editor schema，返回完成状态或带路径、错误码、可恢复性、Block/资产计数的拒绝报告。导入接受可选 `Idempotency-Key`；成功创建、初始 Yjs 更新、投影、审计和 24 小时幂等回执在同一事务提交，同键同请求重放原文档，同键异请求返回 409。内容支持 Schema v1–v4，并在创建前执行注册的迁移步骤；旧版本不能写入 v4 新格式，成功审计保存迁移 ID、摘要与版本范围。含图片或 PDF 引用的导入会安全拒绝，因为资产 ID 受原文档/租户授权，不能直接带入新文档。正文限制为 2 MiB、20,000 个节点、64 层，导入在请求内同步完成；持久化的大任务状态与恢复仍待实现。migrations `0013_mute_mercury.sql`、`0015_sticky_tyrannus.sql` 和 `0016_gigantic_spitfire.sql` 更新审计约束并建立 standard 正文快照/资产引用存储。

`POST /api/documents/:id/copy` 允许复制当前可读且仍处于同一 active generation/durableSeq 的协同模板，或仍处于同一 snapshotRevision 的 standard 模板。服务端按序重放 Yjs 更新或读取 JSON 快照，在内存中归一化并校验正文，再为每个 Block 生成新 ID、重建新协同代次的结构 maps 与唯一初始 update；创建 document、generation 与该 update 在一个事务中提交。事务会重新检查模板读取权及来源代次/修订号，避免权限撤销或并发编辑期间创建不一致副本。路由接受可选 `Idempotency-Key`，副本和 24 小时回执原子提交；同键重试重放原副本，同键异请求返回 409。副本不继承 ACL、操作回执或旧代次 tombstone；空模板仍以 durableSeq 0 创建。含图片或 PDF 的模板因资产克隆策略未实现而明确拒绝。`apps/app-server/src/scripts/template-copy-smoke.ts` 在项目独立 PostgreSQL 上验证协同模板的正文/格式保留、新 Block ID、结构投影重建和源代次不变。空间/文件夹目录移动、模板资产复制策略和评论/审批身份隔离尚未实现。metadataRevision 从 1 开始，每次标题或生命周期变化递增；标题修订接受可选 `Idempotency-Key`，成功更新、审计和响应回执原子提交，重放前复核 active 状态及 write 权限；旧 metadataRevision 的相同请求重放原响应，同键异请求返回 409。

当前版本模块同时支持 collaborative Yjs 历史与 standard JSON 快照历史。版本创建请求按文档模式分别携带 generation/durableSeq 或 snapshotRevision；版本响应包含 `sourceMode`，standard 历史内容由独立 JSON 快照和规范 hash 校验读取。命名版本创建接受可选 `Idempotency-Key`，版本、标准快照/资产引用、审计和回执在同一事务提交；重放前会复核当前文档仍 active 且请求主体仍有 write 权限。恢复请求按当前模式携带相应的前置条件：standard 文档在事务中恢复正文与资产引用并递增 snapshotRevision；collaborative 文档恢复到新 generation。若 collaborative 文档的目标版本来自 standard 快照，会用该 JSON 正文重建新 Yjs generation 和结构投影。两种恢复均保留审计并拒绝旧修订/代次写入。

自动版本在 collaborative generation 首次有意义的持久化正文变更时创建；standard 快照在首次显式保存时创建，之后遵守至少 30 分钟间隔。每篇文档保留最新 50 个自动版本，命名版本不自动清理。standard 历史 JSON 快照另存正文 hash 和资产引用，孤儿清理会计入历史版本引用；标准快照恢复校验 ready 资产后原子替换当前引用。历史内容在 app-web 以只读结果展示，并通过版本内容 API 读取，不另建可写 Y.Doc。migration `0017_safe_rick_jones.sql` 已应用到项目独立 PostgreSQL，本地浏览器已验普通快照命名/自动版本、差异、恢复与重开，并将标准历史正文恢复进新协同 generation；临时 MinIO/PostgreSQL 验收确认当前正文删除后历史附件引用仍阻止孤儿清理、永久删除文档后清理器删除附件对象。大文档、多版本恢复和保留策略运营验收仍未完成。

资产服务使用私有 S3 兼容对象存储。创建上传会话时检查文档 write ACL、文件名/MIME/声明大小和配置上限；文件通过 `application/json` Base64 API 代理上传，服务端校验 PNG/JPEG/WebP/PDF 文件签名、准确字节数并计算 SHA-256，再写入不可预测的对象键。完成接口复核对象长度、MIME 和服务端 SHA 元数据后返回 `assetId`。取消会删除对象并转为可清理状态。读取接口每次复核文档 read ACL 后返回最多 5 分钟、默认 60 秒的签名 URL；图片响应为 `Content-Disposition: inline`，PDF 保持 `attachment`。正文持久化事务提取图片/PDF Block 的 assetId/Block ID/MIME，锁定文档后复核资产属于同租户/同文档且已 ready，再按新 durableSeq 写入引用；当前头部与保留版本各自保持引用，版本恢复会把对应引用复制到新 generation。模板复制遇到图片或 PDF 会拒绝并说明暂不支持跨文档资产克隆。

`pnpm assets:cleanup` 清除超时上传、失败/取消残留、长期无引用资产和硬删除文档遗留的对象及元数据，可由部署调度器周期调用。资产记录在 document 硬删除时保留到该清理命令确认对象删除，避免数据库先删行后丢失对象键。正文 Image Block 支持 PNG/JPEG/WebP，PDF 正文附件 Block 已接入 Schema、编辑器与资产引用链；2026-09-28 项目本地 MinIO/PostgreSQL 浏览器验收确认 PDF 协同插入达到 durableSeq 3；授权读取取得短时签名 URL，无身份访问返回 401；GET 返回 603 字节、application/pdf 且 SHA-256 与上传源文件一致。测试数据与临时 MinIO 实例已清理；生产 provider 和故障恢复仍待验收。Base64 代理上传上限默认 10 MiB。migration `0009_exotic_molten_man.sql` 为资产引用绑定 durableSeq，并以 Yjs update 外键保证只能引用已持久化序号。`pnpm smoke:asset-references` 在项目专用 PostgreSQL 上覆盖同文档资产校验、已存版本引用保留、恢复后的引用继承、失败事务回滚和移除图片后的引用清理，已通过。临时本地 MinIO/PostgreSQL 浏览器/API 验收确认图片上传后签名读取、错误 MIME 拒绝后上传重试成功、取消上传，以及标准历史版本对资产的保留；删除文档后清理器移除了对象和元数据。上传 API 对象写入或 complete 前对象 HEAD 失败会把会话置为可重试并返回不含供应商详情的 503；会话过期前重试仍保留租户容量预留。内容已进入 uploaded/ready 后，同 SHA-256 重试返回成功而不重复写对象，不同内容返回 409；HEAD 暂时失败时可再次调用 complete。项目 PostgreSQL HTTP 验收通过本机 S3 协议桩注入首次 403，覆盖 503、同会话重试、同内容回放、异内容冲突、complete 与 ready 后回放。协议桩只验证 API 状态转换，不代表真实 S3/MinIO 故障恢复；生产对象存储 provider 和端到端验收仍待完成。

普通文档的旧 Schema PUT 升级先校验/迁移基础内容，在同一事务创建当前格式新 generation、快照和审计记录，退休旧代次，保留旧历史的格式及内容。历史恢复也创建新代次，不回写已发布历史元数据；版本读取按来源 Schema 校验。当前写入 Schema v5，4→5 保留旧内容，迁移 `0025_bitter_tattoo.sql` 更新新代次默认格式。

原生协同更新仍先验证再持久化，durable ack 只在持久化成功后广播。重连 SyncStep2 中已经接受的受保护结构项及已删除项允许幂等重放；新增结构项和新的保护项删除继续拒绝，客户端结构操作须走受控通道。

## 7. 知识库与增量索引

知识库管理可索引的数据集合、来源和处理状态，空间管理人员/文档组织，两者在业务层关联。首期默认一个空间一个知识库；外部系统也可将自己的文档集合映射到知识库，编辑器包无需理解该关系。

默认对纳入知识库的文档使用已持久化快照做增量索引。启用审批发布的企业可选择仅索引已发布版本；策略保存在 knowledge_source，不从编辑器状态猜测。

流程：snapshot-ready → 读取授权来源与目标版本 → 规范化 Block 文本/结构 → 计算内容 hash → 按 token 预算切分 → Embedding → 写入候选索引代次 → 校验完整 → 原子切换 activeIndexGeneration。删除块产生 tombstone，移除来源/删除文档立即使其不可检索，再异步清理物理向量。

分块需保留标题路径、列表上下文、表格表头、代码语言与来源定位；避免父子块重复索引。超长块可拆为多个 chunk，小块按结构合并，记录 blockId/path 与片段范围。相同内容但位置不同仍保留不同来源身份；缓存向量时同时考虑模型版本与规范化版本。

处理键包含 source、目标快照、切分器版本和模型版本。任务重复可幂等重跑，乱序结果不得覆盖新代次；失败显示具体阶段并允许重试。增量更新、全文重建和模型迁移均保留旧索引到新代次完整就绪，查询是否允许旧快照由明确策略决定。

首期采用严格新鲜度策略：查询要求索引快照匹配来源当前目标快照，更新期间尚未就绪的来源暂时不参与召回，并向用户展示更新状态。相应代价是更新期间召回可能减少；后续如允许带版本提示的旧快照检索，需作为显式产品策略引入。撤权、删除与来源移除始终立即生效。

向量 namespace 至少由服务端按 tenant/space/knowledgeBase 范围生成；共享数据库也必须带过滤条件。向量库、Embedding 和 Rerank 由 D-05 评测确定，选择标准包括中文效果、过滤、删除/重建、私有部署与资源成本，不在文档中预设未经验证的服务能力。

## 8. 检索、问答与引用

授权知识域 → Query 规范化/Embedding → 带范围过滤的 Top-K 召回 → 文档级权限与有效快照检查 → Rerank → 去重与上下文预算 → LLM 生成 → 引用校验 → SSE 输出。没有在向量系统中表达的 ACL 必须在取出正文送给下游前补充校验；扩大候选数量也保持相同约束。

引用携带来源文档、快照/业务版本、Block 和片段信息，返回时与生成上下文的来源白名单比对。引用展示文本由服务端快照取得，不能信任模型随意填写来源 ID。来源被删除或撤权时，引用接口拒绝读取并返回安全状态。

无证据或证据不足时明确返回无法根据当前知识回答；不能为了完成回答补造引用。上下文按 token 预算截取并保留来源，不把整个空间塞进 Prompt。将检索内容作为不可信资料处理，禁止其改变授权范围、系统指令或触发未授权工具操作。

缓存包括租户、资源范围、版本和权限相关信息，撤权可失效；不能跨租户共享带正文的回答缓存。评估集覆盖中文术语、相似文档、跨空间同名资料、无答案问题、错误引用、删除和权限变更。

## 9. AI 创作与流协议

AI 业务服务接收 intent、目标上下文、约束和知识范围，验证文档写入/AI 使用权限，按需要调用 RAG；Prompt 模板按版本维护，记录所用模型与模板版本。模型输出转换为 DC-08 的编辑提案，先通过 Schema、目标范围、引用和大小限制校验。

服务端只生成提案，客户端 ai-bridge 是默认接受流程的正文写入方。服务端不在生成时并行写入相同 Y.Doc。任务状态区分 queued/running/completed/failed/cancelled；是否被接受与是否持久化另行关联到 operationId 和文档回执。

SSE 输出统一事件，包含 requestId、seq 和事件类型；业务层返回 AsyncIterable，transport 层处理编码、心跳、背压和断连。浏览器可以使用带认证的 fetch 流消费，具体方式与宿主的凭据模型一致。

创建任务使用幂等键；事件可能重复，若支持重放须定义保留窗口、游标、缺口与任务结果回读。取消传播给生成/RAG 请求；断开后的任务是否继续必须明确，首期交互式生成默认取消。供应商不支持立即取消时，将任务标记停止交付并丢弃后续结果，记录实际用量。

限额包括每主体/租户的并发、输入与输出 token、生成时长和频率。错误转换为安全错误码，不向客户端泄露 Prompt、密钥、原始供应商响应或其他文档上下文。

## 10. REST / WebSocket / SSE 接口地图

以下均为拟定接口；详细入参、出参、分页、条件写入、幂等及错误响应由各 feature 的 Zod route contract 维护，OpenAPI 为派生产物。

| 协议/路径                                                                      | 用途                                | 关键约束                                                                                                            |
| ------------------------------------------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `POST /api/documents`                                                          | 创建空白/模板文档                   | 幂等键、Schema、授权上下文                                                                                          |
| `GET /api/documents?view=...`                                                  | 最近/我的/收藏/全部/归档/回收站列表 | tenant 隔离、ACL 过滤、标题搜索和 offset 分页；含模式及对应的 snapshotRevision/durableSeq；归档/回收站仅 owner 可见 |
| `GET /api/documents/:id` / `PATCH /api/documents/:id`                          | 元数据读取/修改                     | GET 检查 read；PATCH 校验 metadataRevision；正文不在此覆盖                                                          |
| `POST /api/documents/:id/copy`                                                 | 从文档模板创建副本                  | 读取同一 active generation/durableSeq，正文与格式经校验后复制；Block ID 重建，不复制 ACL/操作历史                   |
| `PUT/DELETE /api/documents/:id/favorite`                                       | 收藏/取消收藏                       | 当前主体必须可读；收藏与租户、主体和文档绑定                                                                        |
| `PUT /api/documents/:id/archive` / `DELETE /api/documents/:id`                 | 归档/移入回收站                     | owner 操作；切断当前协同房间；删除是可恢复状态                                                                      |
| `PUT /api/documents/:id/restore` / `DELETE /api/documents/:id/permanent`       | 恢复/永久删除                       | owner 操作；永久删除只接受回收站状态                                                                                |
| `GET /api/documents/:id/acl` / `PUT/DELETE /api/documents/:id/acl/:identityId` | 列出、授予或撤销文档 action         | ACL 仅所有者可读取或修改；变更会关闭当前代次协同连接                                                                |
| `GET/PUT /api/documents/:id/content`                                           | 快照读取/普通模式内容保存           | GET 返回内容和 snapshotRevision；PUT 仅普通模式、要求修订号并校验正文及资产引用；协同模式拒绝 PUT                   |
| `POST /api/documents/:documentId/collaboration-session`                        | 获取协同会话能力与短期 ticket       | 首位写入者原子启用协同；read ACL 可在启用后取只读 ticket；回传 generationId、durableSeq 和 compatibility            |
| `WS /collaboration`                                                            | 增量同步/在场/回执                  | 先认证再发送文档；限制帧大小、心跳和连接数                                                                          |
| `GET/POST /api/documents/:id/versions`                                         | 列出/创建命名版本                   | read/write ACL；创建条件和历史事实源按 sourceMode 区分：Yjs durableSeq 或 JSON snapshotRevision                     |
| `GET /api/documents/:id/versions/:versionId`                                   | 读取版本元数据                      | read 权限；返回 sourceMode、snapshotRevision/durableSeq、作者与时间                                                 |
| `GET /api/documents/:id/versions/:versionId/content`                           | 读取历史正文                        | read 权限；按来源读取并校验 Yjs 历史或 JSON 快照，不连接可写协同会话                                                |
| `POST /api/documents/:id/versions/:versionId/restore`                          | 从命名版本恢复                      | write 权限和当前模式修订条件；可选 24 小时 `Idempotency-Key`；按目标模式原子恢复 JSON 快照或新 Yjs generation       |
| `DELETE /api/documents/:id`                                                    | 进入回收站                          | 立即失效会话/搜索来源；永久删除另设受限操作                                                                         |
| `POST /api/documents/:id/asset-uploads`                                        | 创建受 ACL 约束的上传会话           | MIME/大小 allow-list；可选 24 小时 `Idempotency-Key`，返回 assetId 与服务端上传路径                                 |
| `POST /api/asset-uploads/:assetId/content` / `complete` / `DELETE`             | 上传、确认或取消                    | 服务端签名、长度、SHA 检查；未完成资产不可读取                                                                      |
| `GET /api/assets/:assetId/access`                                              | 获取短时授权下载 URL                | 每次按文档 ACL 复核；对象键不由客户端提供                                                                           |
| `POST /api/documents/:id/assets/:assetId/references`                           | 记录资产内容引用                    | 需活动 generation、durableSeq、Block ID 与同文档 ready asset                                                        |
| `/api/spaces` / `/api/spaces/:id/members`                                      | 空间与成员管理                      | 租户归属与管理 action                                                                                               |
| `/api/documents/:id/comments`                                                  | 评论线程与回复                      | 评论权限、锚点/代次校验                                                                                             |
| `/api/knowledge-bases/:id/sources`                                             | 知识来源与索引状态                  | 关联与移除权限；异步任务标识                                                                                        |
| `POST /api/knowledge-bases/:id/queries`                                        | 问答任务                            | 范围授权、幂等/限额、引用校验                                                                                       |
| `POST /api/authoring-tasks`                                                    | 创作任务                            | intent、目标前置条件、幂等与配额                                                                                    |
| `GET /api/authoring-tasks/:id/events`（SSE）                                   | 创作事件流                          | 任务拥有者授权、序号、终止事件                                                                                      |
| `GET /api/authoring-tasks/:id` / `POST /api/authoring-tasks/:id/cancel`        | 结果回读/取消                       | 权限与任务状态变更幂等                                                                                              |

问答 SSE、搜索、收藏、回收站恢复、通知与审批接口按同一约定在模块实现前补齐。HTTP 的校验/授权/不存在/冲突/限流错误由 root handler 统一映射；WS 和 SSE 使用对应的安全错误帧，不能在已经开始的流中伪装普通 JSON 响应。

WebSocket ticket 通过受保护的 HTTPS 接口取得，再在受限的认证握手中使用；认证前不加载/泄露文档，限制等待时间。凭据不放入持久化日志；使用 Cookie 的部署同时定义 Origin/CSRF 策略，私有化部署明确反向代理和 WSS 配置。

## 11. 任务、事务与一致性

业务事务同时写主数据和 outbox，提交后由任务消费者处理外部副作用。至少一次投递通过幂等键、唯一约束和目标版本校验保证结果可重复；数据库事务不能假装同时覆盖向量库、对象存储和模型服务。

队列可先以 PostgreSQL 持久化实现，避免独立文档配置依赖额外中间件。worker 使用租约、超时、有限并发、退避重试和死信状态；中断后可继续领取，重建任务不会覆盖新结果。索引失败、资产清理失败、通知失败分别可见，不能互相阻塞正文保存。

模块间事务由发起业务 use case 拥有，repository 接受事务上下文。为复制、恢复、永久删除、索引切换和任务接受明确并发前置条件；不使用无界后台定时器补偿所有业务。

## 12. 企业流程与运维

审批固定指向不可变 versionId。审批中发生正文修改时产生新草稿/版本，原批准不自动覆盖新内容；是否冻结当前编辑由企业策略决定。发布、撤回、成员调整、删除、导出和模型配置变更进入审计；浏览器不能自报可信操作者。

部署配置在启动边界校验。独立模式只检查已启用模块的依赖；服务正常启动先检查数据库，OpenAPI 离线导出通过独立组装路径完成，不连接数据库。migration 显式执行，已发布文件不回写。

当前 `/health/live` 提供进程存活检查，`/health/ready` 检查数据库并返回投影任务 pending/processing/dead 汇总。每个 HTTP 请求使用服务端生成的 UUID request ID，在响应 `x-request-id` 返回；忽略客户端传入的 request ID，Fastify 请求日志使用同一 ID。`document_audit_events` 记录文档创建/复制、改名、生命周期、版本、ACL、Schema 迁移和 Block ID 修复；写入与业务变更处于同一数据库事务，详情不含正文，永久删除事件不随文档清理。协同正文变更由 Yjs 更新日志按操作者与 durableSeq 追溯，不为每个高频更新帧重复生成控制面审计事件。设置 32 字符以上的 `METRICS_BEARER_TOKEN` 后，`/metrics` 暴露 Prometheus HTTP 请求计数/延迟直方图、成功签发的协同 session ticket 数、WebSocket 连接数、已认证协同 session 数和活跃房间数；未配置时端点返回 404。指标保存在进程内，重启后重置，多实例数值不聚合；生产抓取需限制在内部网络，并配置单实例抓取或外部聚合。当前仍缺备份恢复演练、租户资源限额、数据库/资产/AI 相关指标和多实例聚合。

基础配额由 `TENANT_MAX_DOCUMENTS` 控制，默认每租户 10,000 篇文档；文档创建与模板复制在事务中取得 tenant advisory lock 后计数，归档/回收站文档仍占额度，超额返回 `429 RESOURCE_LIMIT`。`TENANT_MAX_ASSET_BYTES` 默认每租户 10 GiB；上传会话创建在 tenant advisory lock 下汇总 `uploading`、`receiving`、`uploaded`、`ready`、`failed` 资产声明大小并原子预留额度，取消记录不占额度；失败记录在会话过期清理前仍保留预留额度，未清理的过期上传继续占额度，超额同样返回 429。任务并发、对象存储容量治理仍未实现。`pnpm smoke:backup-restore` 面向本 Compose 的本地 PostgreSQL：用 `pg_dump` 创建临时归档，还原到临时数据库并比较文档、Yjs 更新、投影、版本、审计和附件引用等表的行数；脚本会删除临时数据库和临时归档。该演练验证 PostgreSQL 备份可读和还原结果，不覆盖 S3 对象、向量索引、生产备份调度或 RPO/RTO。

优雅停机先停止新会话/任务，限时完成或释放进行中的持久化工作，再关闭连接。备份需要覆盖元数据、Yjs 日志/检查点、版本与附件；向量索引可以重建但需保存模型/切分配置。正式部署前确定 RPO/RTO、备份频率、保留/删除策略并演练恢复，不能仅以“备份文件存在”验收。

## 13. 分阶段完成条件

- M2：无知识库/模型配置可启动独立文档产品；创建、双端编辑、落库后重开、只读/撤权、附件与版本恢复有闭环；单房间 owner 和容量限制明确。
- M3：空间/文档权限贯穿搜索、知识索引、引用与 AI；增量更新/删除/重建可观察；流取消、结构校验和前后端单一写入成立。
- M4：企业审批绑定版本，持久离线与复杂导入范围明确，多实例或外部数据源有独立故障恢复设计；备份恢复与升级迁移能按目标完成。

现有格式、lint、类型、build 与离线 OpenAPI 检查继续沿用。OpenAPI 使用 3.1，以直接容纳 document-contracts 的 JSON Schema 2020-12；共享 `DocumentContent`/`DocumentBlock` 组件由该包输出并由 export script 检查，业务 REST DTO 仍由本 app 的 Zod route contract 维护。运行时验收需要真实 PostgreSQL 和协同连接，覆盖数据库失败、进程重启、旧代次更新、重复任务、跨租户访问、撤权检索、缺失引用与模型中断；不能用成功的单元测试替代这些数据闭环。
