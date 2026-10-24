# app-server 设计规划

> 2026-10-24 实施更新：新增 writing-chat 模块与 /api/writing 命令/SSE，官方 DSH 在本 Server 进程运行；新 authoring 记录 dsh-v1，旧任务与 RAG 保留 LangChain checkpoint。migration 0034/0035 只在隔离验收数据库执行。见 [AI Chat 实施记录](../packages/ai-chat-implementation.md)。

> 2026-10-24 两类 Chat 分别装配：协作 AI 写作使用 [dsh-agent](../packages/dsh-agent.md)封装官方 Cordis/DSH，RAG Chat 的问答与检索链路继续使用 LangChain。业务模块分别维护授权、会话、持久化、HTTP/SSE 与取消/恢复契约；共用前端组件不要求共享执行器。以下旧写作 Deep Agents/LangGraph 记录作为写作迁移依据，不代表 RAG LangChain 路线退出。边界见[总方案](../packages/ai-chat-architecture.md)。

2026-10-22 新增段落级审阅 `POST /api/ai/requests/:requestId/review`。接受或拒绝携带 decisionId、revision、action 与可选 blockIds；省略块集合表示处理全部剩余建议。迁移 0033 为 ai_runs 增加 review JSONB，保存决定、幂等摘要及当前审阅基线，应用状态支持 partial/rejected；同时删除 auto_apply_blocked。根目录 .env 对应本地 PostgreSQL 已执行迁移。

自动写入已移除：authoring HTTP 不再接受 writeMode，任务响应不再返回模式/自动门禁，不提供 pause-auto 路由；生成、恢复、读取均不提交正文。接受由协同 owner 原子提交选中子批次、结构回执与审阅状态，拒绝仅更新状态。仅本轮成功决定能推进其后续基线；本轮目标同时作为来源时，只认可这些已知提交，其他来源版本仍严格复核。重复决定返回原结果，decisionId 换载荷或过期 revision 返回冲突。

整篇改写继续采用显式 document 目标，原始提案保持不可变。受控子批次仅从该提案中选取未决定的操作，新增尾段按提案顺序定位；接受部分后拒绝其余可形成原文与新文混合结果。隔离 PostgreSQL/HTTP/SSE/WebSocket 回归覆盖逐段隔离、持久恢复、拒绝不写入、全部处理跳过已拒绝段落、外部冲突、越权与回执丢失。真实模型装配继续通过 LangChain OpenAI/Anthropic 官方适配；凭据仅保留服务端，不转发思考内容。

2026-10-06 新增 `PATCH /api/knowledge/workspaces/:workspaceId`、`GET /api/knowledge/workspaces/:workspaceId/members`、`PUT/DELETE /api/knowledge/workspaces/:workspaceId/members/:identityId`。迁移 0029 建立带租户复合主键、空间外键和角色约束的 workspace_members；所有者由 workspaces.createdBy 隐式表示，不可被降级或移除。成员上限 500（含所有者），只有所有者可管理管理员；所有者/管理员可修改空间资料。工作区列表返回 role、canManage、canOrganize、memberCount 和 createdAt。创建空间支持 Idempotency-Key 重放及不同请求冲突。

空间角色约束新文档/目录创建、预设初始化、目录修改与移动目标；系统默认空间保持既有共享组织行为。文档读取、写入、导出、历史与协同仍遵循独立文档 ACL，添加/移除空间成员不会隐式增删文档授权。跨空间文档移动仍检查所有权、metadataRevision 和目标目录所属空间。删除目录前检查整个目录子树的所有权及文档所有权，防止将其他成员的内容级联移入回收站。

`pnpm smoke:knowledge` 已扩展统一回归，覆盖空间设置、创建幂等、角色修改/移除、所有者保护、管理员越权拒绝、成员降级立即生效、跨租户拒绝、显式 ACL 保留、跨空间移动/修订冲突及安全目录删除。迁移仅在隔离测试数据库执行；实际部署先显式运行 `pnpm db:migrate`。

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
| SV-09 | knowledge-base               | Qdrant 切片/向量/ACL 投影同步、索引版本、移除、重建和状态                | M3                    |
| SV-10 | retrieval                    | Query Embedding、强制租户/ACL 过滤、实时权限/版本复核、上下文与引用问答  | M3                    |
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

针对 2,000 员工的高频成员变更，待审要求空间/文档成员更新只改权威关系，索引使用稳定资源键，不向 Qdrant 展开名单。权限上下文和协同/生成按 tenant/workspace/document/identity 定向失效：新增权限不踢无关会话，撤销 read/write 只处理受影响主体；每次受保护操作仍重新授权，已发布的消息无法收回。当前 setAcl/removeAcl 调用整篇文档 revokeDocumentSessions，需先区分权限增减及主体再做容量验收；文档删除/代次更换仍可整体失效，多实例传播要求不能省略。

已实现的 M2 权限基础：`PrincipalAuthenticator` 是可替换的身份解析端口；`AUTH_MODE=external` 可通过 `buildApp` 注入可信身份适配器，Principal 带 `tenantId`，HTTP 与协同查询同时限定租户和文档 action。宿主可导入 `startServer({ identityAuthenticator })` 启动标准 HTTP/WebSocket 服务并注入实际 provider；本仓库尚未提供生产 provider，因此未注入时 external 模式会安全失败启动。`document_acl` 记录 `read`、`write`、`comment`、`share`、`export`、`ai` 授权；所有者隐式拥有全部 action，读权限也可由写、评论、导出或 AI 权限满足，写权限包含评论权限。当前 ACL 由所有者管理，更新后关闭该文档活动代次的协同连接，要求客户端重新取 session。`GET /api/documents/:id` 检查 read 并返回主体相关的 `canManage`，`GET /api/documents/:id/acl` 仅所有者可列出授权主体，`PUT/DELETE /api/documents/:id/acl/:identityId` 检查所有权；read-only reader 可取得只读协同 ticket，协同握手按 read 检查，写入、重放和结构命令复核 write。JSON 导出要求 owner 或显式 export action，并在复核权限的事务中记 `document.exported` 审计；评论、分享委托和 AI 业务接口尚未实现。migrations `0000`–`0016` 已在知书自己的 Compose PostgreSQL（`127.0.0.1:5432/app`）执行；既有项目 smoke 已覆盖 tenant ACL、只读 session、撤权、文档生命周期及版本恢复，导入导出路由仍待专项运行验收。另一个共享 PostgreSQL 实例未被更改。

## 4. 数据归属与关键约束

以下为逻辑表规划；字段/索引在实现前细化到 migration。业务模块拥有数据，Drizzle row 不穿透 repository 返回给包消费者。

| 数据集合                                                                                 | owner                         | 关键字段与约束                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| documents                                                                                | documents                     | tenantId/documentId、空间/归属/正文头部与 metadataRevision；待审增加 accessMode 和仅在索引资源键变化时递增的 aclRevision                                                                        |
| document_acl / memberships                                                               | authorization / spaces        | 主体、资源、action/角色、策略版本；成员变更可使缓存失效                                                                                                                                         |
| document_generations                                                                     | collaboration                 | tenantId、documentId、generationId、Schema/扩展集、初始化标记、当前持久化序列                                                                                                                   |
| document_updates / checkpoints                                                           | collaboration                 | generationId、durableSeq、存储更新 hash、来源帧 hash、二进制增量与带校验和的 generation/version 检查点；序列和去重键唯一                                                                        |
| document_projection_snapshots                                                            | document-projection           | generationId、覆盖的 durableSeq、snapshotRevision、当前 JSON/hash 与 Block/文本/资产摘要                                                                                                        |
| document_outbox                                                                          | document-projection/jobs      | durable update 事件、增量摘要、投影载荷、租约、退避重试与 dead-letter；按代次唯一去重                                                                                                           |
| document_versions                                                                        | versions                      | versionId、generationId/durableSeq 位置、命名/创建者；历史 JSON 仍可从 Yjs 日志重建                                                                                                             |
| assets / asset_references                                                                | assets / documents            | tenantId、assetId、对象键、大小/MIME/hash、上传状态及协同 durableSeq 的文档引用；对象键不作为公开身份                                                                                           |
| workspaces / workspace_members                                                           | documents / spaces            | 复用空间与真实成员角色；待审增加 personal/team 类型，space 模式继承角色，restricted 保留独立正文授权                                                                                            |
| document_indexes                                                                         | knowledge-index               | PostgreSQL 每租户/文档一行：正文/ACL 目标与已发布版本、配置指纹、active/buildingIndexVersion、片段数/摘要、租约/重试和删除 tombstone；不存切片/向量/主体清单                                    |
| zhishu_chunks_v1（Qdrant collection）                                                    | knowledge-index               | 切片文本/向量/版本/Block 区间与稳定 readAclKeys；普通空间/文档成员增删不修改 points                                                                                                             |
| ai_runs                                                                                  | ai-authoring                  | requestId/主体/目标、不可变恢复输入、生成/中断状态、执行归属、提案 JSONB、预算与过期；不镜像 SDK 状态或 token 事件                                                                              |
| ai_checkpoint.checkpoints / checkpoint_blobs / checkpoint_writes / checkpoint_migrations | 官方 PostgresSaver            | 现有 PostgreSQL 中的独立 schema；三张运行数据表与一张迁移版本表由 SDK 管理，应用只负责装配、授权、互斥与整 thread 清理                                                                          |
| comment_threads / comments                                                               | comments                      | 文档、版本/锚点、创建者、解决状态；锚点失效仍保留合法讨论                                                                                                                                       |
| approval_instances / decisions                                                           | workflows                     | versionId、流程/策略版本、步骤与结果；决策不指向持续变化的草稿                                                                                                                                  |
| document_audit_events / outbox / jobs                                                    | documents / projection / jobs | 文档控制面审计含 tenant、可信 actor、request ID、资源/代次与非正文详情；与业务变更同事务提交，按 tenant/request ID 和资源建立索引，永久删除后保留；outbox/jobs 提供幂等键、租约、重试和失败状态 |

外键与唯一约束覆盖租户/资源归属，不能只依赖应用层过滤。Block 是文档内容身份；索引表里的 Block/片段是派生数据，不建立第二套可独立写入的正文表。正文、元数据、业务版本和知识索引各有清楚的版本号。

## 5. 协同正文与保存协议

所有文档统一以当前 generation 的 Yjs 二进制日志/检查点作为正文事实源，不保留显式保存的 `PUT /content`。JSON 用于预览、导出、版本和索引，不作为并行写入口；`GET /content` 返回只读投影快照。文档创建、JSON 导入、模板复制、命名版本创建、标题修订、生命周期、ACL 授权/撤销和资产上传会话创建支持可选 `Idempotency-Key`：按 tenant、subject、operation 和 key hash 隔离，成功结果与资源在同一事务保存，24 小时内同键同请求重放原响应，同键异请求返回 409；资产上传重放前重新检查活动文档写权限，容量预留仅对新会话执行；ACL 变更重放前重新确认操作者仍是活动文档所有者，重放不重复审计或再次撤销会话。项目独立 PostgreSQL HTTP 验收已确认上传会话同键重试回放同一 assetId/到期时间、同键改请求返回 409，且租户只预留一条会话；ACL 授权重试不重复审计、异权限返回 409、撤销重试返回 204。上传验收时 S3 健康检查由本地响应桩提供，不表示已完成生产对象存储验证。收藏 API 采用资源状态语义，其他变更路由仍待接入该回放协议。创建文档即建立首个协同 generation、`collaboration_updates` 与投影快照；竞争初始化会复用已启用的协同代次。存量标准文档由一次性迁移脚本批量转为协同，正文 `PUT` 已移除。

`POST /api/documents/:id/versions/:versionId/restore` 也接受可选 `Idempotency-Key`。服务端先复核当前 write 权限，再回放已保存的文档响应；首次恢复、版本恢复审计和 24 小时回执在同一事务提交。恢复会创建新的 Yjs generation，已在项目独立 PostgreSQL 上通过 HTTP 验收：重复请求保持同一 generation 与单条恢复审计；复用键提交不同恢复条件返回 409。收藏 API 采用资源状态语义，其他变更路由仍待接入该回放协议。

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

`POST /api/documents/:id/copy` 允许复制当前可读且仍处于同一 active generation/durableSeq 的模板。服务端按序重放 Yjs 更新，在内存中归一化并校验正文，再为每个 Block 生成新 ID、重建新协同代次的结构 maps 与唯一初始 update；创建 document、generation 与该 update 在一个事务中提交。事务会重新检查模板读取权及来源代次，避免权限撤销或并发编辑期间创建不一致副本。路由接受可选 `Idempotency-Key`，副本和 24 小时回执原子提交；同键重试重放原副本，同键异请求返回 409。副本不继承 ACL、操作回执或旧代次 tombstone；空模板仍以 durableSeq 0 创建。含图片或 PDF 的模板因资产克隆策略未实现而明确拒绝。`apps/app-server/src/scripts/template-copy-smoke.ts` 在项目独立 PostgreSQL 上验证协同模板的正文/格式保留、新 Block ID、结构投影重建和源代次不变。空间/文件夹目录移动、模板资产复制策略和评论/审批身份隔离尚未实现。metadataRevision 从 1 开始，每次标题或生命周期变化递增；标题修订接受可选 `Idempotency-Key`，成功更新、审计和响应回执原子提交，重放前复核 active 状态及 write 权限；旧 metadataRevision 的相同请求重放原响应，同键异请求返回 409。

所有文档统一为协同版本历史。版本创建请求携带 generation/durableSeq；命名版本创建接受可选 `Idempotency-Key`，版本、审计和回执在同一事务提交；重放前会复核当前文档仍 active 且请求主体仍有 write 权限。恢复请求以当前 generation/durableSeq 为前置条件，创建新的 Yjs generation 与结构投影。恢复保留审计并拒绝旧代次写入。

自动版本在 generation 首次有意义的持久化正文变更时创建，之后遵守至少 30 分钟间隔。每篇文档保留最新 50 个自动版本，命名版本不自动清理。历史内容在 app-web 以只读结果展示，并通过版本内容 API 读取，不另建可写 Y.Doc。临时 MinIO/PostgreSQL 验收确认当前正文删除后历史附件引用仍阻止孤儿清理、永久删除文档后清理器删除附件对象。大文档、多版本恢复和保留策略运营验收仍未完成。

资产服务使用私有 S3 兼容对象存储。创建上传会话时检查文档 write ACL、文件名/MIME/声明大小和配置上限；文件通过 `application/json` Base64 API 代理上传，服务端校验 PNG/JPEG/WebP/PDF 文件签名、准确字节数并计算 SHA-256，再写入不可预测的对象键。完成接口复核对象长度、MIME 和服务端 SHA 元数据后返回 `assetId`。取消会删除对象并转为可清理状态。读取接口每次复核文档 read ACL 后返回最多 5 分钟、默认 60 秒的签名 URL；图片响应为 `Content-Disposition: inline`，PDF 保持 `attachment`。正文持久化事务提取图片/PDF Block 的 assetId/Block ID/MIME，锁定文档后复核资产属于同租户/同文档且已 ready，再按新 durableSeq 写入引用；当前头部与保留版本各自保持引用，版本恢复会把对应引用复制到新 generation。模板复制遇到图片或 PDF 会拒绝并说明暂不支持跨文档资产克隆。

`pnpm assets:cleanup` 清除超时上传、失败/取消残留、长期无引用资产和硬删除文档遗留的对象及元数据，可由部署调度器周期调用。资产记录在 document 硬删除时保留到该清理命令确认对象删除，避免数据库先删行后丢失对象键。正文 Image Block 支持 PNG/JPEG/WebP，PDF 正文附件 Block 已接入 Schema、编辑器与资产引用链；2026-09-28 项目本地 MinIO/PostgreSQL 浏览器验收确认 PDF 协同插入达到 durableSeq 3；授权读取取得短时签名 URL，无身份访问返回 401；GET 返回 603 字节、application/pdf 且 SHA-256 与上传源文件一致。测试数据与临时 MinIO 实例已清理；生产 provider 和故障恢复仍待验收。Base64 代理上传上限默认 10 MiB。migration `0009_exotic_molten_man.sql` 为资产引用绑定 durableSeq，并以 Yjs update 外键保证只能引用已持久化序号。`pnpm smoke:asset-references` 在项目专用 PostgreSQL 上覆盖同文档资产校验、已存版本引用保留、恢复后的引用继承、失败事务回滚和移除图片后的引用清理，已通过。临时本地 MinIO/PostgreSQL 浏览器/API 验收确认图片上传后签名读取、错误 MIME 拒绝后上传重试成功、取消上传，以及标准历史版本对资产的保留；删除文档后清理器移除了对象和元数据。上传 API 对象写入或 complete 前对象 HEAD 失败会把会话置为可重试并返回不含供应商详情的 503；会话过期前重试仍保留租户容量预留。内容已进入 uploaded/ready 后，同 SHA-256 重试返回成功而不重复写对象，不同内容返回 409；HEAD 暂时失败时可再次调用 complete。项目 PostgreSQL HTTP 验收通过本机 S3 协议桩注入首次 403，覆盖 503、同会话重试、同内容回放、异内容冲突、complete 与 ready 后回放。协议桩只验证 API 状态转换，不代表真实 S3/MinIO 故障恢复；生产对象存储 provider 和端到端验收仍待完成。

普通文档的旧 Schema PUT 升级先校验/迁移基础内容，在同一事务创建当前格式新 generation、快照和审计记录，退休旧代次，保留旧历史的格式及内容。历史恢复也创建新代次，不回写已发布历史元数据；版本读取按来源 Schema 校验。当前写入 Schema v5，4→5 保留旧内容，迁移 `0025_bitter_tattoo.sql` 更新新代次默认格式。

原生协同更新仍先验证再持久化，durable ack 只在持久化成功后广播。重连 SyncStep2 中已经接受的受保护结构项及已删除项允许幂等重放；新增结构项和新的保护项删除继续拒绝，客户端结构操作须走受控通道。

## 7. 知识库与增量索引

通用索引/授权键设计见 [rag](../packages/rag.md)。知识域复用 workspace，不另建 knowledge_bases、knowledge_sources 或来源快照。2026-10-19 待审优化采用“团队空间默认继承 + 个人空间主体 + 受限文档独立授权”，取代每个切片展开 readIdentityIds。

拟在已有 workspaces 增加 kind=personal/team，documents 增加 accessMode=space/restricted 与索引策略 aclRevision；workspace_members/document_acl 继续是成员和直接授权的权威关系。团队 space 模式按真实空间成员/角色授权，restricted 不继承空间正文权限，个人默认 owner 并允许原文档 ACL 单篇分享。当前代码尚无这些模式，仅有组织角色和显式文档 ACL；必须统一升级业务授权，不能只修改 Qdrant filter。

Qdrant 每个 point 的 metadata.readAclKeys 存少量稳定键：继承文档为 [space:s1]，个人文档为 [user:u1, document:d1]，受限文档为 [document:d2]。document 键只会被分配给实际 owner/直接授权主体，个人共享不授予其他人的 user 键。空间范围条件与键相交条件分别检查，不能因选择某空间就获得正文权限，详见 [资源授权规则](../packages/rag.md#用户空间与文档分别授权)。

每次检索由服务端基于当前关系解析自身 user 键、真实成员空间键、可读独立文档键；Qdrant 按 tenant/知识范围/键相交过滤，PostgreSQL 批量复核当前模式、身份、成员/直接权限与正文版本后，才读取切片。当前 workspaceAccess 对非成员的 viewer 回退仅代表目录浏览，绝不能当作可生成 space 键的真实成员证明。查询键多时按请求字节有界拆批并合并去重，不允许无过滤回退。

向量阶段仅新增 PostgreSQL document_indexes 与一个 Qdrant collection。普通空间成员、文档分享成员和角色/action 变化只提交原关系与审计、定向失效权限/协同/生成上下文；不递增索引策略修订、不更新 document_indexes，也不修改 Qdrant points。只有访问模式、个人归属主体、空间归属等使稳定键变化时才递增 aclRevision 并登记策略同步。

正文增量流程：projection 成功事务内推进 document_indexes → Worker 领取并分配新 buildingIndexVersion → 固定可信投影和稳定键 → 事务外分块/Embedding → 以确定 point ID、insert_only 写 Qdrant → 条件发布 activeIndexVersion。RAG 不竞争 projection 原 outbox；状态、租约、重试、片段摘要和删除 tombstone 合并在同一索引行，不另建 jobs/generations/Qdrant outbox。

Qdrant 与 PostgreSQL 没有跨服务事务。只交付 activeIndexVersion 和当前 generationId/durableSeq/metadataRevision/配置一致的正文；策略修订仅跟踪键同步，不能代替当前关系授权。模式/归属变化可在同一活动构建上按单调 aclRevision 条件修改 readAclKeys，正文初始写入使用 insert_only 防止旧写入回退策略。普通成员增删无需 payload 同步，下一次关系读取即生效；已有索引未发生其他内容变化时，新授权也无需等待向量任务。

热点关系仍有 PostgreSQL 锁竞争，采用短事务、有界准入、no-op/幂等和有界批量接口；失效按受影响主体定向传播，不反复踢掉整篇文档的无关协作者。旧文档按 restricted 回填以保留显式授权，团队继承通过显式选择启用；当前代码升级与历史数据回填前不自动扩权。移出空间撤销继承权限，独立分享单独管理；“撤销全部访问”还须收回直接授权并处理文档 owner 的隐式权利，普通关系调整不修改稳定 document 键。完整容量/迁移验收见 [rag](../packages/rag.md#43-容量与迁移验收)。

切片保留 Block/UTF-16 区间与原文/Embedding 输入摘要，不跨块拼接大 chunk。源码变更、删除、移动、恢复新 generation 先由业务头部排除旧数据，再同步/清理。硬删除保留 tombstone，确认旧 Worker 结束并清理 Qdrant 后才删除同步行。来源历史回看复用原文档能力，不独立复制任意历史来源。

Qdrant 使用 @langchain/qdrant 与官方客户端，collection/payload 索引显式初始化，模型/维度/精度及中文质量按 D-05 评测；不兼容配置创建新 collection 重建，不提前实现多 profile 零停机切换。新增 SQL 表仍累计六张，Qdrant 一个 collection；稳定资源键模型不新增主体/ACL 展开表。

## 8. 检索、问答与引用

授权知识域 → Query 规范化/Embedding → Qdrant 按租户/范围/ACL 召回最小候选 → PostgreSQL 核对权限、版本和 activeIndexVersion → 按 ID 从 Qdrant 取切片 → 可选 Rerank → 去重/预算 → LLM → 引用校验 → SSE。扩大候选时保留同样的范围和 ACL，达到预算返回不足；未校验原始候选、正文或 ACL 名单不对外展示。

引用携带来源文档、快照/业务版本、Block 和片段信息，返回时与来源白名单比对。引用摘录来自已授权、与可信快照定位/摘要一致的 Qdrant 切片，不能由模型任意填写；全文和历史回看仍走现有文档接口。来源被删除或撤权时，引用接口拒绝读取并返回安全状态。

无证据或证据不足时明确返回无法根据当前知识回答；不能为了完成回答补造引用。上下文按 token 预算截取并保留来源，不把整个空间塞进 Prompt。将检索内容作为不可信资料处理，禁止其改变授权范围、系统指令或触发未授权工具操作。

缓存包括租户、资源范围、版本和权限相关信息，撤权可失效；不能跨租户共享带正文的回答缓存。评估集覆盖中文术语、相似文档、跨空间同名资料、无答案问题、错误引用、删除和权限变更。

## 9. AI 创作与流协议

2026-10-24 目标架构分为两条业务链路，以下现有任务接口按所属业务保留或迁移：

| 业务              | 执行与编排                              | 会话/恢复边界                                                                     |
| ----------------- | --------------------------------------- | --------------------------------------------------------------------------------- |
| 协作 AI 写作 Chat | 官方 DSH Agent Loop、Session 与写作插件 | 写作会话、Run、审批、持久化 journal 和 HTTP/SSE；正文经用户确认与协同 durable ack |
| RAG Chat          | LangChain 问答链路 + rag 检索/来源端口  | 自己的历史、请求、存储和实际取消/恢复能力，不创建 DSH Session                     |

命令、事件订阅、历史查询和缓存按业务种类及主体隔离。RAG 的 LangChain 模型/链路及所需存储继续装配，不能在写作切换 DSH 后统一卸载。RAG 转写作通过独立业务请求交接授权资料，重新校验目标与来源；不跨引擎回放 checkpoint。具体路由以所属模块 OpenAPI 为准，本次不因 UI 复用重命名现有接口。

### 现有写作实现与迁移基线

以下现有写作任务、checkpoint 和 SSE 记录供写作迁移核对，不能作为将 RAG 换为 DSH 或统一两条 wire 协议的依据。AI 请求/事件/引用合约见 [ai-contracts](../packages/ai-contracts.md)，现有生成与提案编译见 [ai-runtime](../packages/ai-runtime.md)，编辑器接受见 [editor-ai-bridge](../packages/editor-ai-bridge.md)。目标写作会话协议另见 chat-contracts，数据库与 migration 继续由应用维护。

Deep Agents TypeScript 执行写作与研究，Chat 使用官方 LangGraph 的单步结构化调用；模型适配与 RAG 使用 LangChain。app-server 已组装 AI 模块、Chat API 和原子接受链路。首期 searchKnowledge/readSource 仅访问用户显式选择的最多 4 篇授权文档，每篇最多 8 个切片、总证据不超过 32KB；不宣称覆盖整篇长文档或全库向量召回。Qdrant 尚未接入。工具回调绑定主体与资料范围，Agent 循环由 SDK 提供，知书维护业务授权、来源定位与协同接受。

AI 业务服务区分只读 Chat / 知识问答与生成正文提案。Chat 验证所用资料的 read/ai 及部署策略；正文提案同时验证本人个人空间、目标 write/ai 权限、intent、约束和知识范围，按需要调用授权 RAG。Prompt 模板按版本维护，记录所用模型与模板版本。模型输出由 runtime 转换为合约化提案，先通过 Schema、目标范围、引用和大小限制校验；模型不能直接决定任意编辑批次或写入模式。最终交付与接受前再次检查证据权限与版本。

生成阶段只产生提案。用户逐段或批量确认后，由现有结构 owner 校验、执行并广播；拒绝只保存决定。生成模型没有写正文工具，浏览器不因 completed 提交接受，也不另行覆盖正文。ai_runs 记录生成状态、不可变恢复输入、最终结果、累计预算和审阅状态；决定与正文回执在同一事务中持久化，不另建 task_events 表。

SSE 输出统一事件，包含 requestId、seq 和事件类型；业务层返回 AsyncIterable，transport 层处理编码、心跳、背压和断连。浏览器可以使用带认证的 fetch 流消费，具体方式与宿主的凭据模型一致。

创建任务使用幂等键，目标和历史任务引用计入输入摘要，重复提交不隐式恢复。首次 SSE 断开时停止执行，确认旧执行结束后进入 interrupted；显式取消进入 cancelled，不能恢复。恢复只生成草稿，已确认决定按权威回执展示。供应商不支持立即取消时停止交付并记录实际用量。resume 返回 202，由受管理的应用执行器续跑，页面通过 GET 回读最终结果；不重开同 requestId 的 SSE，也不保存事件流。

上述断连指未正常完成的流中断，completed 后正常关闭不视为取消。cancel 只停止生成；已完成建议的拒绝通过 review 接口记录。已确认的正文变更不被取消抹除，不能仅靠客户端 AbortSignal 推断服务端结果。

限额包括每主体/租户的并发、输入与输出 token、生成时长和频率。错误转换为安全错误码，不向客户端泄露 Prompt、密钥、原始供应商响应或其他文档上下文。

### 9.1 Checkpoint 的最小表设计（待审）

AI 新增一张业务表 ai_runs 和官方 PostgresSaver 四张内部表，共五张 SQL 表；向量 RAG 仅再加 document_indexes，累计六张 SQL 表及一个 Qdrant collection。SQL 仍用现有 PostgreSQL，切片/向量/ACL payload 存 Qdrant；不额外增加线程、提案、记忆或消息队列表。官方四表定义见 [TypeScript migrations](https://github.com/langchain-ai/langgraphjs/blob/main/libs/checkpoint-postgres/src/migrations.ts)，实施时锁定版本并保留其结构。

ai_runs 建议字段：

| 字段                               | 类型与约束                   | 用途                                                                                       |
| ---------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------ |
| tenant_id、subject_id、request_id  | 沿用现有 ID 类型，联合主键   | 授权归属与网络重发幂等，不另建 taskId/thread 记录                                          |
| document_id                        | 同 tenant 文档 ID；Chat 可空 | authoring 必填且为允许写入的个人文档；团队资料引用属于 input，不作为写入目标               |
| input_hash                         | text，非空且不可改           | 同 ID 不同输入返回冲突                                                                     |
| input                              | jsonb，非空且不可改          | 原始请求、写入模式、有界历史引用、可信快照、初始 evidence、知识范围及配置版本；不保存凭据  |
| auto_apply_blocked                 | boolean，默认 false          | 单向置 true，记录断连/中断/取消等导致本轮自动授权失效；恢复、回读不重置                    |
| status                             | text，限定五态               | running / interrupted / completed / failed / cancelled                                     |
| owner_id、attempt                  | text 可空、integer 非空      | 执行实例标识与每次执行递增的版本，保护业务状态提交；不作为 Saver 写入 fencing              |
| cancel_requested                   | boolean，默认 false          | 先阻止结果提交并通知 owner，执行退出后再标记 cancelled                                     |
| result                             | jsonb，可空                  | 已校验完整 AuthoringProposal、AnswerResult 或规划中的 ChatResult；operationId 沿用提案字段 |
| usage                              | jsonb，非空                  | 模型/工具调用预留数、token/用量摘要和累计预算；恢复不清零                                  |
| error_code                         | text，可空                   | 安全失败/中断原因，无原始供应商响应                                                        |
| created_at、updated_at、expires_at | timestamptz，非空            | 展示、异常核对和任务/对应 checkpoint 的保留期                                              |

input 只存本任务恢复必需且受大小限制的可信上下文，不建立第二份正文权威存储；恢复使用该原快照，禁止加载最新正文替换原输入。模型/策略版本引用必须仍可解析，凭据、服务实例和授权工具闭包每次重新装配。研究过程新增的 evidence 映射与 SDK 虚拟文件保存在 checkpoint 状态，不再复制到 input。

threadId 由服务端对 tenantId/subjectId/requestId 的规范编码生成确定值，启动、恢复、清理使用同一个规则；无需单独 thread_id、checkpoint_id 或 conversation_id 列。官方 checkpoint_ns 留给 SDK 子图，不用其表达租户。requestId/threadId 均不授予权限，所有状态/结果/恢复/取消接口先查询业务归属并授权。

Chat 每次追问创建新 requestId/threadId；客户端仅提交有界、按顺序排列的历史 requestId。服务端从同租户、同主体、未过期且 completed 的 ai_runs 装配历史，重新授权历史资料，不接受客户端伪造的模型角色消息或旧 evidence。历史链长度、总文本/token 和单轮输出受限；到期或撤权后提示缩小上下文/新开对话。首期没有跨成员共享 Chat，不增加 conversation/messages 表；SDK checkpoint 只负责恢复当前轮，不能直接复用为下一轮对话。

除联合主键外，只增加 `expires_at` 清理索引，以及 `(tenant_id, subject_id) WHERE status = 'running'` 部分唯一索引实现首期每主体一个在途任务；指定 requestId 的回读直接使用主键，不为尚无入口的任务列表建时间线索引。恢复以条件更新检查 interrupted/attempt、未取消及未过期；结果只在 status=completed 时存在，终态提交同时检查 owner/attempt/cancel_requested。首期不为 JSONB 建通用 GIN，也不增加表级队列或单独 heartbeat 表。

官方表保留以下主键形状，不由 Drizzle 平行维护另一份 SDK schema：

| ai_checkpoint 下的表  | 主键                                                  | 主要载荷                                                           |
| --------------------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| checkpoints           | thread_id、checkpoint_ns、checkpoint_id               | parent_checkpoint_id、checkpoint JSONB、metadata JSONB、序列化类型 |
| checkpoint_blobs      | thread_id、checkpoint_ns、channel、version            | type、blob BYTEA                                                   |
| checkpoint_writes     | thread_id、checkpoint_ns、checkpoint_id、task_id、idx | channel、type、blob BYTEA、task_path                               |
| checkpoint_migrations | v                                                     | SDK schema 迁移序号，全 schema 共用                                |

独立 schema 使用官方 schema 配置。部署时显式执行应用 migration 和官方 setup，普通启动只检查可用性；OpenAPI 离线导出不创建连接、不初始化 Saver。升级和清理通过锁定 SDK 公开 API 操作，不删 checkpoint_blobs/writes 来压表数，不只保存最新一行 JSONB 替代 pending writes。正文协同原有 generation/version checkpoint 表仍归协同模块，与 AI checkpoint 分开。

同一 thread 的执行互斥、原 owner 退出确认、恢复前全量权限/版本复核、图完成但业务未提交的恢复和 TTL 清理统一遵循 [ai-runtime](../packages/ai-runtime.md#5-checkpoint取消与任务归属)。首期不自动接管归属不明的 running，不承诺 checkpoint 带来模型调用或外部副作用恰好一次。

### 9.2 空间与写入策略（2026-10-21 设计）

产品范围为团队支持 Chat、研究与草稿，AI 正文写入只允许发起者本人的个人空间。资料来源空间与写入目标空间分别授权。审阅方式不能改变此范围，也不能以管理员身份、直接调用 accept 或改变 URL 绕过。

已在首批实现中增加空间类型及个人空间所有者约束，同步 migration、创建/查询合约、OpenAPI 与前端生成客户端。既有空间迁移为 unclassified，新创建支持 personal/team。后续个人空间 AI 写入要求 `kind=personal` 且 `personalOwnerId` 等于当前主体，再叠加文档 write/ai 权限；不能把 createdBy、单人空间、空间名称或 workspace-access 的 viewer 回退当作所有权证明。既有空间和无空间归属文档在没有明确迁移归类前不开放 AI 写入，不自动将既有团队资料归为个人空间。普通设置不可转换空间类型或移交个人空间所有者。

页面能力按资源返回 Chat 可用性、写入可用性与安全原因；提交时服务端重新计算。团队目标的 authoring/accept 返回明确的业务错误（拟定 `AI_WRITE_PERSONAL_ONLY`），Chat 不因无法写团队正文而整体禁用。本人个人文档共享给别人后，其他主体仍不能把它作为 AI 写入目标。团队资料输出到个人空间还需满足资料 AI 使用与复制/导出策略；不允许通过生成路径扩大原有访问范围。

创作 HTTP 外壳携带共享 AuthoringRequest、sourceDocumentIds 与有界 previousRequestIds，不包含模式字段。历史引用和目标固定到 ai_runs.input 并计入输入摘要。生成完成仅产出提案，用户操作才进入接受用例。

替换审阅规则：

1. 重新验证任务主体、当前权限、个人空间所有者及完整原提案；客户端只选择块 ID 和接受/拒绝，不提交自己的批次。
2. decisionId 对载荷摘要幂等；revision 按每次决定递增，多标签页旧决定不能覆盖新决定。
3. 拒绝仅保存决定；接受从原提案编译选中子批次，owner 在同一事务核对 generation/durableSeq/structureRevision，保存正文、决定、后续基线及 durable 回执。
4. 已接受或拒绝的块从待审集合移除；全部操作仅针对剩余集合，拒绝的原文保留。尾段逆序接受仍按原提案排序。
5. 只有本轮已确认提交可推进基线；外部正文变化仍冲突并保留建议。未知回执查询或重试同一决定，不生成新批次。

ai_runs.status=completed 只表示生成成功。应用状态包括 pending、partial、rejected、applied、conflict、blocked；SSE completed 后不追加第二个保存终态。审阅响应只返回公开状态，内部幂等摘要不向浏览器投影。

首期采用整文档保守冲突策略，同账号多标签页和其他人工协同修改同样受控。它不依赖长时占用文档锁，也不处理语义合并；其他设备尚未上传的离线输入无法提前检测。页面的输入法/未确认本地修改门禁属于额外保护，不能替代服务端版本检查。

## 10. REST / WebSocket / SSE 接口地图

以下均为拟定接口；详细入参、出参、分页、条件写入、幂等及错误响应由各 feature 的 Zod route contract 维护，OpenAPI 为派生产物。

| 协议/路径                                                                      | 用途                                | 关键约束                                                                                                   |
| ------------------------------------------------------------------------------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `POST /api/documents`                                                          | 创建空白/模板文档                   | 幂等键、Schema、授权上下文                                                                                 |
| `GET /api/documents?view=...`                                                  | 最近/我的/收藏/全部/归档/回收站列表 | tenant 隔离、ACL 过滤、标题搜索和 offset 分页；含当前持久化序号 durableSeq；归档/回收站仅 owner 可见       |
| `GET /api/documents/:id` / `PATCH /api/documents/:id`                          | 元数据读取/修改                     | GET 检查 read；PATCH 校验 metadataRevision；正文不在此覆盖                                                 |
| `POST /api/documents/:id/copy`                                                 | 从文档模板创建副本                  | 读取同一 active generation/durableSeq，正文与格式经校验后复制；Block ID 重建，不复制 ACL/操作历史          |
| `PUT/DELETE /api/documents/:id/favorite`                                       | 收藏/取消收藏                       | 当前主体必须可读；收藏与租户、主体和文档绑定                                                               |
| `PUT /api/documents/:id/archive` / `DELETE /api/documents/:id`                 | 归档/移入回收站                     | owner 操作；切断当前协同房间；删除是可恢复状态                                                             |
| `PUT /api/documents/:id/restore` / `DELETE /api/documents/:id/permanent`       | 恢复/永久删除                       | owner 操作；永久删除只接受回收站状态                                                                       |
| `GET /api/documents/:id/acl` / `PUT/DELETE /api/documents/:id/acl/:identityId` | 列出、授予或撤销文档 action         | ACL 仅所有者可读取或修改；变更会关闭当前代次协同连接                                                       |
| `GET /api/documents/:id/content`                                               | 只读投影快照读取                    | 返回 generation、durableSeq 与当前正文；正文写入只经协同会话                                               |
| `POST /api/documents/:documentId/collaboration-session`                        | 获取协同会话能力与短期 ticket       | 每个文档都已是协同代次；read ACL 可取只读 ticket；回传 generationId、durableSeq 和 compatibility           |
| `WS /collaboration`                                                            | 增量同步/在场/回执                  | 先认证再发送文档；限制帧大小、心跳和连接数                                                                 |
| `GET/POST /api/documents/:id/versions`                                         | 列出/创建命名版本                   | read/write ACL；创建条件为当前 generation/durableSeq                                                       |
| `GET /api/documents/:id/versions/:versionId`                                   | 读取版本元数据                      | read 权限；返回 generation、durableSeq、作者与时间                                                         |
| `GET /api/documents/:id/versions/:versionId/content`                           | 读取历史正文                        | read 权限；从 generation 检查点与更新历史重建，不连接可写协同会话                                          |
| `POST /api/documents/:id/versions/:versionId/restore`                          | 从命名版本恢复                      | write 权限和当前 generation/durableSeq 条件；可选 24 小时 `Idempotency-Key`；原子恢复到新的 Yjs generation |
| `DELETE /api/documents/:id`                                                    | 进入回收站                          | 立即失效会话/搜索来源；永久删除另设受限操作                                                                |
| `POST /api/documents/:id/asset-uploads`                                        | 创建受 ACL 约束的上传会话           | MIME/大小 allow-list；可选 24 小时 `Idempotency-Key`，返回 assetId 与服务端上传路径                        |
| `POST /api/asset-uploads/:assetId/content` / `complete` / `DELETE`             | 上传、确认或取消                    | 服务端签名、长度、SHA 检查；未完成资产不可读取                                                             |
| `GET /api/assets/:assetId/access`                                              | 获取短时授权下载 URL                | 每次按文档 ACL 复核；对象键不由客户端提供                                                                  |
| `POST /api/documents/:id/assets/:assetId/references`                           | 记录资产内容引用                    | 需活动 generation、durableSeq、Block ID 与同文档 ready asset                                               |
| `/api/spaces` / `/api/spaces/:id/members`                                      | 空间与成员管理                      | 租户归属与管理 action                                                                                      |
| `/api/documents/:id/comments`                                                  | 评论线程与回复                      | 评论权限、锚点/代次校验                                                                                    |
| `POST /api/ai/answers`（fetch SSE）                                            | 知识问答流                          | contextRef 重新授权、幂等/限额、引用校验                                                                   |
| `POST /api/ai/chat`（规划中，fetch SSE）                                       | 多轮普通对话与授权资料讨论          | 协商 Chat 协议版本、同主体有界历史引用；不直接写正文                                                       |
| `POST /api/ai/authoring`（fetch SSE）                                          | 创作提案流                          | 本人个人空间、write/ai、目标前置条件、幂等、配额及主体归属                                                 |
| `GET /api/ai/requests/:requestId`                                              | 回读任务状态和已完成结果            | 校验任务主体、当前目标与来源权限；不暴露 checkpoint/内部消息                                               |
| `POST /api/ai/requests/:requestId/resume`                                      | 恢复中断任务，返回 202              | 仅 interrupted、原 owner 已退出、同 thread 串行、原输入/剩余预算；客户端查询最终结果                       |
| `POST /api/ai/requests/:requestId/accept`                                      | 接受完整非替换提案                  | 本人个人空间、主体、write/ai；原子版本检查、结构 owner 与 durable ack                                      |
| `POST /api/ai/requests/:requestId/review`                                      | 单段或全部剩余建议的接受/拒绝       | decisionId、revision；事务保存决定与正文回执，拒绝不写正文                                                 |
| `POST /api/ai/requests/:requestId/cancel`                                      | 取消生成                            | 原主体授权，取消幂等；首期不提供事件重放                                                                   |

问答 SSE、搜索、收藏、回收站恢复、通知与审批接口按同一约定在模块实现前补齐。HTTP 的校验/授权/不存在/冲突/限流错误由 root handler 统一映射；WS 和 SSE 使用对应的安全错误帧，不能在已经开始的流中伪装普通 JSON 响应。

WebSocket ticket 通过受保护的 HTTPS 接口取得，再在受限的认证握手中使用；认证前不加载/泄露文档，限制等待时间。凭据不放入持久化日志；使用 Cookie 的部署同时定义 Origin/CSRF 策略，私有化部署明确反向代理和 WSS 配置。

## 11. 任务、事务与一致性

业务事务同时写主数据和 outbox，提交后由任务消费者处理外部副作用。至少一次投递通过幂等键、唯一约束和目标版本校验保证结果可重复；数据库事务不能假装同时覆盖向量库、对象存储和模型服务。

队列可先以 PostgreSQL 持久化实现，避免独立文档配置依赖额外中间件。worker 使用租约、超时、有限并发、退避重试和死信状态；中断后可继续领取，重建任务不会覆盖新结果。索引失败、资产清理失败、通知失败分别可见，不能互相阻塞正文保存。

模块间事务由发起业务 use case 拥有，repository 接受事务上下文。为复制、恢复、永久删除、索引切换和任务接受明确并发前置条件；不使用无界后台定时器补偿所有业务。

## 12. 企业流程与运维

审批固定指向不可变 versionId。审批中发生正文修改时产生新草稿/版本，原批准不自动覆盖新内容；是否冻结当前编辑由企业策略决定。发布、撤回、成员调整、删除、导出和模型配置变更进入审计；浏览器不能自报可信操作者。

部署配置在启动边界校验。独立模式只检查已启用模块的依赖；服务正常启动先检查数据库，OpenAPI 离线导出通过独立组装路径完成，不连接数据库。migration 显式执行，已发布文件不回写。

待审的 Qdrant 配置为 QDRANT_URL、QDRANT_API_KEY、QDRANT_COLLECTION 和请求/批量上限，启用 RAG 才检查连通性、collection 配置与 payload 索引。collection 初始化显式执行，离线 OpenAPI 不连接 Qdrant。私有部署管理密钥仅保留服务端，快照和日志按切片正文/ACL 敏感数据治理；Qdrant 恢复后先核对或重建，再恢复已发布索引状态，不能把旧 SQL 标记当成向量数据仍在。

当前 `/health/live` 提供进程存活检查，`/health/ready` 检查数据库并返回投影任务 pending/processing/dead 汇总。每个 HTTP 请求使用服务端生成的 UUID request ID，在响应 `x-request-id` 返回；忽略客户端传入的 request ID，Fastify 请求日志使用同一 ID。`document_audit_events` 记录文档创建/复制、改名、生命周期、版本、ACL、Schema 迁移和 Block ID 修复；写入与业务变更处于同一数据库事务，详情不含正文，永久删除事件不随文档清理。协同正文变更由 Yjs 更新日志按操作者与 durableSeq 追溯，不为每个高频更新帧重复生成控制面审计事件。设置 32 字符以上的 `METRICS_BEARER_TOKEN` 后，`/metrics` 暴露 Prometheus HTTP 请求计数/延迟直方图、成功签发的协同 session ticket 数、WebSocket 连接数、已认证协同 session 数和活跃房间数；未配置时端点返回 404。指标保存在进程内，重启后重置，多实例数值不聚合；生产抓取需限制在内部网络，并配置单实例抓取或外部聚合。当前仍缺备份恢复演练、租户资源限额、数据库/资产/AI 相关指标和多实例聚合。

基础配额由 `TENANT_MAX_DOCUMENTS` 控制，默认每租户 10,000 篇文档；文档创建与模板复制在事务中取得 tenant advisory lock 后计数，归档/回收站文档仍占额度，超额返回 `429 RESOURCE_LIMIT`。`TENANT_MAX_ASSET_BYTES` 默认每租户 10 GiB；上传会话创建在 tenant advisory lock 下汇总 `uploading`、`receiving`、`uploaded`、`ready`、`failed` 资产声明大小并原子预留额度，取消记录不占额度；失败记录在会话过期清理前仍保留预留额度，未清理的过期上传继续占额度，超额同样返回 429。任务并发、对象存储容量治理仍未实现。`pnpm smoke:backup-restore` 面向本 Compose 的本地 PostgreSQL：用 `pg_dump` 创建临时归档，还原到临时数据库并比较文档、Yjs 更新、投影、版本、审计和附件引用等表的行数；脚本会删除临时数据库和临时归档。该演练验证 PostgreSQL 备份可读和还原结果，不覆盖 S3 对象、向量索引、生产备份调度或 RPO/RTO。

优雅停机先停止新会话/任务，限时完成或释放进行中的持久化工作，再关闭连接。备份需要覆盖元数据、Yjs 日志/检查点、版本与附件；向量索引可以重建但需保存模型/切分配置。正式部署前确定 RPO/RTO、备份频率、保留/删除策略并演练恢复，不能仅以“备份文件存在”验收。

## 13. 分阶段完成条件

- M2：无知识库/模型配置可启动独立文档产品；创建、双端编辑、落库后重开、只读/撤权、附件与版本恢复有闭环；单房间 owner 和容量限制明确。
- M3：空间/文档权限贯穿搜索、知识索引、引用与 AI；增量更新/删除/重建可观察；流取消、结构校验和前后端单一写入成立。
- M4：企业审批绑定版本，持久离线与复杂导入范围明确，多实例或外部数据源有独立故障恢复设计；备份恢复与升级迁移能按目标完成。

现有格式、lint、类型、build 与离线 OpenAPI 检查继续沿用。OpenAPI 使用 3.1，以直接容纳 document-contracts 的 JSON Schema 2020-12；共享 `DocumentContent`/`DocumentBlock` 组件由该包输出并由 export script 检查，业务 REST DTO 仍由本 app 的 Zod route contract 维护。运行时验收需要真实 PostgreSQL 和协同连接，覆盖数据库失败、进程重启、旧代次更新、重复任务、跨租户访问、撤权检索、缺失引用与模型中断；不能用成功的单元测试替代这些数据闭环。
