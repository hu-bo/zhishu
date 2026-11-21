-- Data dictionary for the whole schema (PostgreSQL COMMENT ON; this drizzle-orm version
-- exposes no builder-level comment API for pg). Generic columns -- tenant_id, id without
-- a naming contract, created_at/updated_at/created_by/updated_by/deleted_at and plain
-- display strings -- are intentionally left uncommented. Re-runnable: comments are owned
-- by this file, never by generated migrations.

-- workspaces
COMMENT ON TABLE "workspaces" IS '工作空间主表：目录树与文档的顶层归属，分为个人、团队与未分类三种形态';--> statement-breakpoint
COMMENT ON COLUMN "workspaces"."id" IS '空间 id，格式 ws_<uuid>；其根目录 id 固定为 cat_root_<空间 id>';--> statement-breakpoint
COMMENT ON COLUMN "workspaces"."kind" IS '类型：personal 个人空间 / team 团队空间 / unclassified 未分类';--> statement-breakpoint
COMMENT ON COLUMN "workspaces"."personal_owner_id" IS '个人空间属主身份；仅 kind=personal 时非空，且必须等于 created_by';--> statement-breakpoint
COMMENT ON COLUMN "workspaces"."owner_identity_id" IS '团队空间所有者身份；个人空间为空，所有权由 personal_owner_id 判定';--> statement-breakpoint
COMMENT ON COLUMN "workspaces"."authorization_revision" IS '授权修订号，权限变更后递增，供协同会话与离线缓存校验撤权';--> statement-breakpoint
COMMENT ON COLUMN "workspaces"."offline_cache_allowed" IS '是否允许客户端将该空间的正文离线缓存';--> statement-breakpoint

-- catalogs
COMMENT ON TABLE "catalogs" IS '工作空间目录树节点；每个空间恰有一个根节点（parent_id 为空，id=cat_root_<空间 id>），文档只能挂载在目录节点下';--> statement-breakpoint
COMMENT ON COLUMN "catalogs"."id" IS '目录 id，格式 cat_<uuid>；根节点为 cat_root_<空间 id>';--> statement-breakpoint
COMMENT ON COLUMN "catalogs"."parent_id" IS '父目录 id；空为根，自引用成树';--> statement-breakpoint
COMMENT ON COLUMN "catalogs"."access_mode" IS '授权模式：inherit 继承所属空间 / restricted 独立 ACL';--> statement-breakpoint
COMMENT ON COLUMN "catalogs"."position" IS '同级排序位，由应用层维护，不代表正文块顺序';--> statement-breakpoint

-- knowledge_preset_installations
COMMENT ON TABLE "knowledge_preset_installations" IS '示例预设安装标记；文档删除后仍保留，保证幂等初始化不会复活被删除的示例';--> statement-breakpoint
COMMENT ON COLUMN "knowledge_preset_installations"."preset_id" IS '预设文档包 id';--> statement-breakpoint
COMMENT ON COLUMN "knowledge_preset_installations"."document_id" IS '安装生成的文档 id，仅作追溯，不建外键';--> statement-breakpoint

-- documents
COMMENT ON TABLE "documents" IS '文档元数据主表；正文权威来源是协同会话与 generation 日志，本表只管标题、挂载、标签与生命周期';--> statement-breakpoint
COMMENT ON COLUMN "documents"."id" IS '文档 id，格式 doc_<uuid>';--> statement-breakpoint
COMMENT ON COLUMN "documents"."catalog_id" IS '文档挂载的目录节点 id';--> statement-breakpoint
COMMENT ON COLUMN "documents"."position" IS '目录内排序位';--> statement-breakpoint
COMMENT ON COLUMN "documents"."tags" IS '彩色标签数组（DocumentTag JSON）';--> statement-breakpoint
COMMENT ON COLUMN "documents"."status" IS '生命周期：active 正常 / archived 已归档 / trashed 在回收站；归档时点不记录，以本列与审计事件为准';--> statement-breakpoint
COMMENT ON COLUMN "documents"."access_mode" IS '访问模式：personal 仅个人 / workspace-inherited 继承空间 / restricted 独立授权';--> statement-breakpoint
COMMENT ON COLUMN "documents"."metadata_revision" IS '元数据修订号，乐观并发控制用';--> statement-breakpoint

-- document_audit_events
COMMENT ON TABLE "document_audit_events" IS '文档审计事件流水，只追加不修改';--> statement-breakpoint
COMMENT ON COLUMN "document_audit_events"."actor_identity_id" IS '操作人身份 id';--> statement-breakpoint
COMMENT ON COLUMN "document_audit_events"."action" IS '审计动作枚举，见 CHECK 约束（created/imported/exported/content-updated/archived/trashed/restored/version-*/acl-*/schema-migrated/share-*）';--> statement-breakpoint
COMMENT ON COLUMN "document_audit_events"."resource_type" IS '资源类型，当前恒为 document（预留多资源审计扩展位）';--> statement-breakpoint
COMMENT ON COLUMN "document_audit_events"."resource_id" IS '被审计文档 id';--> statement-breakpoint
COMMENT ON COLUMN "document_audit_events"."generation_id" IS '关联的 generation id，内容类事件携带';--> statement-breakpoint
COMMENT ON COLUMN "document_audit_events"."request_id" IS '请求 id，用于全链路串联排障';--> statement-breakpoint
COMMENT ON COLUMN "document_audit_events"."details" IS '事件附加数据 JSON';--> statement-breakpoint

-- document_migration_snapshots
COMMENT ON TABLE "document_migration_snapshots" IS '结构迁移每一步的内容快照，用于回滚、核对与审计';--> statement-breakpoint
COMMENT ON COLUMN "document_migration_snapshots"."migration_id" IS '一次迁移运行的 uuid';--> statement-breakpoint
COMMENT ON COLUMN "document_migration_snapshots"."step_index" IS '迁移内步骤序号，主键成分';--> statement-breakpoint
COMMENT ON COLUMN "document_migration_snapshots"."step_id" IS '步骤定义 id';--> statement-breakpoint
COMMENT ON COLUMN "document_migration_snapshots"."from_schema_version" IS '变更前 Schema 版本';--> statement-breakpoint
COMMENT ON COLUMN "document_migration_snapshots"."to_schema_version" IS '变更后 Schema 版本';--> statement-breakpoint
COMMENT ON COLUMN "document_migration_snapshots"."content" IS '步骤前正文 JSON 快照';--> statement-breakpoint
COMMENT ON COLUMN "document_migration_snapshots"."content_hash" IS 'content 的 sha256，校验快照完整性';--> statement-breakpoint

-- api_idempotency_records
COMMENT ON TABLE "api_idempotency_records" IS 'API 幂等记录：24 小时内同主体同操作同键重放缓存响应';--> statement-breakpoint
COMMENT ON COLUMN "api_idempotency_records"."subject_id" IS '调用主体身份 id';--> statement-breakpoint
COMMENT ON COLUMN "api_idempotency_records"."operation_id" IS '操作标识名';--> statement-breakpoint
COMMENT ON COLUMN "api_idempotency_records"."key_hash" IS 'Idempotency-Key 请求头的 sha256';--> statement-breakpoint
COMMENT ON COLUMN "api_idempotency_records"."request_hash" IS '规范化请求体的 sha256；同键不同体判定为冲突';--> statement-breakpoint
COMMENT ON COLUMN "api_idempotency_records"."response_status" IS '缓存的响应状态码（仅 2xx 会被缓存）';--> statement-breakpoint
COMMENT ON COLUMN "api_idempotency_records"."response_body" IS '缓存的响应体';--> statement-breakpoint
COMMENT ON COLUMN "api_idempotency_records"."expires_at" IS '过期时间，过期后可被清理';--> statement-breakpoint

-- document_favorites
COMMENT ON TABLE "document_favorites" IS '文档收藏关系表，每人每文档一行';--> statement-breakpoint

-- document_recents
COMMENT ON TABLE "document_recents" IS '最近打开记录；last_opened_at 同时是排序位与展示时间';--> statement-breakpoint
COMMENT ON COLUMN "document_recents"."last_opened_at" IS '最近一次打开时间';--> statement-breakpoint

-- document_shares
COMMENT ON TABLE "document_shares" IS '文档分享能力链接：invite 经登录加入获得权限，access 为公开可读入口';--> statement-breakpoint
COMMENT ON COLUMN "document_shares"."id" IS '分享 id，格式 shr_<uuid>，公开 URL 直接引用';--> statement-breakpoint
COMMENT ON COLUMN "document_shares"."permission" IS '分享档位 read/edit；invite 链接加入时授予对应 ACL';--> statement-breakpoint
COMMENT ON COLUMN "document_shares"."kind" IS '链接类型：invite 邀请 / access 访问';--> statement-breakpoint
COMMENT ON COLUMN "document_shares"."revoked_at" IS '撤销时间；空表示未撤销（到期与撤销是两种失效）';--> statement-breakpoint
COMMENT ON COLUMN "document_shares"."join_count" IS '经该链接首次获得权限的人数';--> statement-breakpoint

-- document_generations
COMMENT ON TABLE "document_generations" IS '文档协作代次；开启协作或重建时产生新一代，durable_seq 在代内单调递增';--> statement-breakpoint
COMMENT ON COLUMN "document_generations"."schema_version" IS '内容契约 Schema 版本（当前默认 5）';--> statement-breakpoint
COMMENT ON COLUMN "document_generations"."extensions" IS '启用的扩展清单 {name, version, required}';--> statement-breakpoint
COMMENT ON COLUMN "document_generations"."status" IS 'active / retired；每篇文档至多一个 active 代';--> statement-breakpoint
COMMENT ON COLUMN "document_generations"."durable_seq" IS '该代已持久化的最大 durable 序号';--> statement-breakpoint

-- document_generation_checkpoints
COMMENT ON TABLE "document_generation_checkpoints" IS '每代当前协作状态快照，重连恢复会话时的起点';--> statement-breakpoint
COMMENT ON COLUMN "document_generation_checkpoints"."durable_seq" IS '快照对应的序号';--> statement-breakpoint
COMMENT ON COLUMN "document_generation_checkpoints"."state_bytes" IS 'Yjs 状态二进制';--> statement-breakpoint
COMMENT ON COLUMN "document_generation_checkpoints"."state_hash" IS 'state_bytes 的 sha256';--> statement-breakpoint

-- document_versions
COMMENT ON TABLE "document_versions" IS '文档版本记录：named 用户命名版本，automatic 系统自动版本';--> statement-breakpoint
COMMENT ON COLUMN "document_versions"."generation_id" IS '版本锚定的 generation id';--> statement-breakpoint
COMMENT ON COLUMN "document_versions"."name" IS '版本名，同一文档内唯一';--> statement-breakpoint
COMMENT ON COLUMN "document_versions"."kind" IS '版本类型：named 命名 / automatic 自动';--> statement-breakpoint
COMMENT ON COLUMN "document_versions"."durable_seq" IS '版本锚定序号；正文由检查点回放到此处重建';--> statement-breakpoint

-- document_version_checkpoints
COMMENT ON TABLE "document_version_checkpoints" IS '版本对应的 Yjs 状态快照，版本恢复的起点';--> statement-breakpoint
COMMENT ON COLUMN "document_version_checkpoints"."state_bytes" IS 'Yjs 状态二进制';--> statement-breakpoint
COMMENT ON COLUMN "document_version_checkpoints"."state_hash" IS 'state_bytes 的 sha256，回放前先校验';--> statement-breakpoint

-- collaboration_updates
COMMENT ON TABLE "collaboration_updates" IS '协作更新持久化日志（durable log），一行一个已确认的 update';--> statement-breakpoint
COMMENT ON COLUMN "collaboration_updates"."update_hash" IS 'update 内容 sha256，代内唯一去重';--> statement-breakpoint
COMMENT ON COLUMN "collaboration_updates"."source_update_hash" IS '来源侧 update 哈希；复制/迁移保留谱系，参与幂等判定';--> statement-breakpoint
COMMENT ON COLUMN "collaboration_updates"."update_bytes" IS 'Yjs update 二进制';--> statement-breakpoint
COMMENT ON COLUMN "collaboration_updates"."durable_seq" IS '代内持久化序号';--> statement-breakpoint

-- document_projection_snapshots
COMMENT ON TABLE "document_projection_snapshots" IS '服务端 JSON 正文投影，由 update 日志物化；是派生数据，不是正文权威来源';--> statement-breakpoint
COMMENT ON COLUMN "document_projection_snapshots"."durable_seq" IS '投影对应到的更新序号';--> statement-breakpoint
COMMENT ON COLUMN "document_projection_snapshots"."snapshot_revision" IS '投影修订号';--> statement-breakpoint
COMMENT ON COLUMN "document_projection_snapshots"."content" IS '投影出的正文 JSON';--> statement-breakpoint
COMMENT ON COLUMN "document_projection_snapshots"."content_hash" IS 'content 的 sha256';--> statement-breakpoint
COMMENT ON COLUMN "document_projection_snapshots"."block_count" IS '正文块数量';--> statement-breakpoint
COMMENT ON COLUMN "document_projection_snapshots"."text_length" IS '正文字符数，字数与预计阅读时长的来源，支持中英混排';--> statement-breakpoint
COMMENT ON COLUMN "document_projection_snapshots"."asset_count" IS '正文引用资产数';--> statement-breakpoint
COMMENT ON COLUMN "document_projection_snapshots"."projected_at" IS '投影刷新时间';--> statement-breakpoint

-- document_outbox
COMMENT ON TABLE "document_outbox" IS '投影到下游（向量索引等）的事务性 outbox，可靠派发最终一致';--> statement-breakpoint
COMMENT ON COLUMN "document_outbox"."durable_seq" IS '触发本事件更新序号';--> statement-breakpoint
COMMENT ON COLUMN "document_outbox"."update_hash" IS '触发事件的更新内容哈希';--> statement-breakpoint
COMMENT ON COLUMN "document_outbox"."event_type" IS '事件类型，当前恒为 document.update（多事件类型预留位）';--> statement-breakpoint
COMMENT ON COLUMN "document_outbox"."content_changed" IS '本次更新是否改变正文';--> statement-breakpoint
COMMENT ON COLUMN "document_outbox"."summary" IS '投影统计摘要 {blockCount, textLength, assetCount}';--> statement-breakpoint
COMMENT ON COLUMN "document_outbox"."snapshot_content" IS '待派发的正文快照，仅内容变化时携带';--> statement-breakpoint
COMMENT ON COLUMN "document_outbox"."content_hash" IS '快照对应正文摘要';--> statement-breakpoint
COMMENT ON COLUMN "document_outbox"."status" IS '派发状态：pending / processing / done / dead';--> statement-breakpoint
COMMENT ON COLUMN "document_outbox"."attempts" IS '重试次数，驱动指数退避';--> statement-breakpoint
COMMENT ON COLUMN "document_outbox"."available_at" IS '下次可被领取的最早时间（退避控制）';--> statement-breakpoint
COMMENT ON COLUMN "document_outbox"."lease_until" IS '处理租约到期时间，过期行可被重新领取';--> statement-breakpoint
COMMENT ON COLUMN "document_outbox"."lease_token" IS '租约令牌，仅持有者可确认或标记失败';--> statement-breakpoint
COMMENT ON COLUMN "document_outbox"."last_error_code" IS '最近一次失败的错误码';--> statement-breakpoint
COMMENT ON COLUMN "document_outbox"."processed_at" IS '处理完成时间（运维排障用，业务不读取）';--> statement-breakpoint

-- assets
COMMENT ON TABLE "assets" IS '附件对象台账；文档清理后仍保留行，直至对象清扫器处理完私有对象';--> statement-breakpoint
COMMENT ON COLUMN "assets"."object_key" IS '对象存储私有 key，全局唯一';--> statement-breakpoint
COMMENT ON COLUMN "assets"."declared_size" IS '创建时客户端申报的字节数';--> statement-breakpoint
COMMENT ON COLUMN "assets"."actual_size" IS '上传后实测字节数，未上传为空';--> statement-breakpoint
COMMENT ON COLUMN "assets"."sha256" IS '内容摘要，complete 时由服务端计算';--> statement-breakpoint
COMMENT ON COLUMN "assets"."status" IS '上传状态机：uploading -> receiving -> uploaded -> ready；cancelled/failed 为终态';--> statement-breakpoint
COMMENT ON COLUMN "assets"."upload_expires_at" IS '上传会话过期时间，过期未完成的行由清理任务取消';--> statement-breakpoint
COMMENT ON COLUMN "assets"."uploaded_at" IS '字节传输完成时间';--> statement-breakpoint
COMMENT ON COLUMN "assets"."completed_at" IS '校验完成转 ready 的时间';--> statement-breakpoint

-- asset_references
COMMENT ON TABLE "asset_references" IS '正文块对附件的引用投影，附件 GC 依据它判断保留与清理';--> statement-breakpoint
COMMENT ON COLUMN "asset_references"."block_id" IS '持有引用的内容块 id（稳定定位身份）';--> statement-breakpoint
COMMENT ON COLUMN "asset_references"."durable_seq" IS '引入该引用的更新序号';--> statement-breakpoint

-- identity_profiles
COMMENT ON TABLE "identity_profiles" IS '受信已认证身份的可搜索投影，不是身份提供方；由网关推送 upsert';--> statement-breakpoint
COMMENT ON COLUMN "identity_profiles"."identity_id" IS '上游身份系统 id';--> statement-breakpoint
COMMENT ON COLUMN "identity_profiles"."active" IS '是否可用；false 时目录、提及与成员候选不再展示';--> statement-breakpoint

-- workspace_invitations
COMMENT ON TABLE "workspace_invitations" IS '空间邀请链接；token 只存哈希，明文不落库';--> statement-breakpoint
COMMENT ON COLUMN "workspace_invitations"."token_hash" IS '邀请 token 的 sha256，全局唯一';--> statement-breakpoint
COMMENT ON COLUMN "workspace_invitations"."role" IS '接受后获得的角色：editor / viewer';--> statement-breakpoint
COMMENT ON COLUMN "workspace_invitations"."accepted_at" IS '接受时间，空表示未接受';--> statement-breakpoint
COMMENT ON COLUMN "workspace_invitations"."accepted_by" IS '接受人身份 id';--> statement-breakpoint

-- notifications
COMMENT ON TABLE "notifications" IS '站内通知；event_key 对同接收人去重；故意不建文档外键，资源移除后消息仍存活';--> statement-breakpoint
COMMENT ON COLUMN "notifications"."recipient_id" IS '接收人身份 id';--> statement-breakpoint
COMMENT ON COLUMN "notifications"."actor_id" IS '触发人身份 id';--> statement-breakpoint
COMMENT ON COLUMN "notifications"."type" IS '类型：comment 评论 / mention 提及 / permission 权限 / share 分享 / deleted 删除';--> statement-breakpoint
COMMENT ON COLUMN "notifications"."event_key" IS '去重幂等键（类型:uuid），同接收人同键只落一条';--> statement-breakpoint
COMMENT ON COLUMN "notifications"."document_id" IS '关联文档；不设外键以便文档删除或撤权后消息仍可见';--> statement-breakpoint
COMMENT ON COLUMN "notifications"."read_at" IS '已读时间，空表示未读';--> statement-breakpoint

-- document_comments
COMMENT ON TABLE "document_comments" IS '文档评论，当前为平铺结构，无回复线程';--> statement-breakpoint
COMMENT ON COLUMN "document_comments"."mention_ids" IS '被提及身份 id 列表，驱动提及通知';--> statement-breakpoint

-- resource_acl
COMMENT ON TABLE "resource_acl" IS '统一资源授权表；每行至多绑定空间、目录、文档三种资源之一';--> statement-breakpoint
COMMENT ON COLUMN "resource_acl"."source_share_id" IS '经分享链接授予时的来源 share id，随分享撤销级联清理';--> statement-breakpoint
COMMENT ON COLUMN "resource_acl"."identity_id" IS '被授予身份 id';--> statement-breakpoint
COMMENT ON COLUMN "resource_acl"."role" IS 'admin/editor/viewer 为角色；read/write/comment/share/export/ai/manage/move 为历史动作授权';--> statement-breakpoint

-- authorization_events
COMMENT ON TABLE "authorization_events" IS '权限变更事务事件流；id 在全局咨询锁下顺序分配，消费者不会跳过晚提交';--> statement-breakpoint
COMMENT ON COLUMN "authorization_events"."actor_id" IS '操作人；系统内部变更时为空';--> statement-breakpoint
COMMENT ON COLUMN "authorization_events"."operation" IS '变更操作名';--> statement-breakpoint
COMMENT ON COLUMN "authorization_events"."before" IS '变更前授权记录快照';--> statement-breakpoint
COMMENT ON COLUMN "authorization_events"."after" IS '变更后授权记录快照';--> statement-breakpoint

-- role_permissions
COMMENT ON TABLE "role_permissions" IS '角色权限点覆盖表；无行即使用版本化内置默认策略';--> statement-breakpoint
COMMENT ON COLUMN "role_permissions"."resource_type" IS '覆盖的资源类型：space / catalog / document';--> statement-breakpoint
COMMENT ON COLUMN "role_permissions"."role" IS '被覆盖的角色：admin / editor / viewer';--> statement-breakpoint
COMMENT ON COLUMN "role_permissions"."actions" IS '覆盖后的动作全集；授予操作权限时必须包含 read';--> statement-breakpoint

-- ai_conversations
COMMENT ON TABLE "ai_conversations" IS '助手会话：一个会话承载问答、研究与写作；命令与意图存于 Run 上下文，不设用途列';--> statement-breakpoint
COMMENT ON COLUMN "ai_conversations"."id" IS '会话 id，格式 ai_<32位十六进制>';--> statement-breakpoint
COMMENT ON COLUMN "ai_conversations"."identity_id" IS '内部拥有者；与 visitor_id 二选一（CHECK 互斥）';--> statement-breakpoint
COMMENT ON COLUMN "ai_conversations"."visitor_id" IS '公开访客 id（cookie 派生），仅站点会话存在';--> statement-breakpoint
COMMENT ON COLUMN "ai_conversations"."site_id" IS '所属公开问答站点；站点会话禁止作为写作目标';--> statement-breakpoint
COMMENT ON COLUMN "ai_conversations"."scope_selection" IS '会话检索范围选择 JSON';--> statement-breakpoint
COMMENT ON COLUMN "ai_conversations"."context_revision" IS '上下文修订号；范围变化时递增并派生新的原生 Session';--> statement-breakpoint
COMMENT ON COLUMN "ai_conversations"."target_document_id" IS '写作目标文档；公开站点会话必须为空';--> statement-breakpoint
COMMENT ON COLUMN "ai_conversations"."configuration_id" IS '创建时的助手配置指纹，配置漂移时拒绝继续写入';--> statement-breakpoint
COMMENT ON COLUMN "ai_conversations"."creation_key" IS '会话创建去重键；NULL 不参与部分唯一索引';--> statement-breakpoint
COMMENT ON COLUMN "ai_conversations"."event_sequence" IS '会话内事件发号器（bigint）';--> statement-breakpoint
COMMENT ON COLUMN "ai_conversations"."status" IS 'active 正常 / target-unavailable 目标不可用 / closed 已关闭';--> statement-breakpoint
COMMENT ON COLUMN "ai_conversations"."expires_at" IS '过期时间，主要用于访客会话回收';--> statement-breakpoint

-- ai_runs
COMMENT ON TABLE "ai_runs" IS '助手运行任务：一次用户输入对应一个 Run；同一会话至多一个进行中 Run';--> statement-breakpoint
COMMENT ON COLUMN "ai_runs"."id" IS 'Run id，格式 run_<32位十六进制>';--> statement-breakpoint
COMMENT ON COLUMN "ai_runs"."conversation_id" IS '所属会话';--> statement-breakpoint
COMMENT ON COLUMN "ai_runs"."idempotency_key" IS '客户端幂等键，会话内唯一';--> statement-breakpoint
COMMENT ON COLUMN "ai_runs"."input_hash" IS '输入内容 sha256；同键不同哈希视为冲突';--> statement-breakpoint
COMMENT ON COLUMN "ai_runs"."context" IS '运行上下文 JSON（command/intent/plugins/scope/capture）';--> statement-breakpoint
COMMENT ON COLUMN "ai_runs"."status" IS 'queued / running / waiting-approval / completed / interrupted / failed / cancelled';--> statement-breakpoint
COMMENT ON COLUMN "ai_runs"."attempt" IS '执行尝试次数';--> statement-breakpoint
COMMENT ON COLUMN "ai_runs"."lease_owner" IS '持有执行租约的 worker 标识';--> statement-breakpoint
COMMENT ON COLUMN "ai_runs"."lease_expires_at" IS '租约到期时间，过期任务可被接管';--> statement-breakpoint
COMMENT ON COLUMN "ai_runs"."fencing_token" IS '栅栏令牌，配合 generation_attempt 阻止过期 worker 写入';--> statement-breakpoint
COMMENT ON COLUMN "ai_runs"."execution" IS '执行器调度信息 JSON（模型、插件、步进状态）';--> statement-breakpoint
COMMENT ON COLUMN "ai_runs"."usage" IS '模型与检索调用用量统计';--> statement-breakpoint
COMMENT ON COLUMN "ai_runs"."error_code" IS '终态失败错误码（大写字母下划线）';--> statement-breakpoint
COMMENT ON COLUMN "ai_runs"."cancel_requested" IS '已请求取消，由执行器协作退出';--> statement-breakpoint
COMMENT ON COLUMN "ai_runs"."expires_at" IS '记录保留期限';--> statement-breakpoint

-- ai_messages
COMMENT ON TABLE "ai_messages" IS '会话消息：staged 可撤回，committed 后才对外可见';--> statement-breakpoint
COMMENT ON COLUMN "ai_messages"."id" IS '消息 id：用户消息 msg_<32位十六进制>，助手消息 amsg_<Run id>';--> statement-breakpoint
COMMENT ON COLUMN "ai_messages"."run_id" IS '触发它的 Run；每个 Run 至多各有一行 user 与 assistant';--> statement-breakpoint
COMMENT ON COLUMN "ai_messages"."role" IS 'user 用户消息 / assistant 助手消息';--> statement-breakpoint
COMMENT ON COLUMN "ai_messages"."parts" IS '消息内容部件 JSON 数组';--> statement-breakpoint
COMMENT ON COLUMN "ai_messages"."client_message_id" IS '客户端去重 id，仅用户消息使用';--> statement-breakpoint
COMMENT ON COLUMN "ai_messages"."state" IS 'staged 暂存 / committed 已提交 / withdrawn 已撤回';--> statement-breakpoint
COMMENT ON COLUMN "ai_messages"."generation_attempt" IS '写入该正文的生成尝试号，与栅栏令牌共同阻止过期写入';--> statement-breakpoint
COMMENT ON COLUMN "ai_messages"."committed_at" IS '提交时间，非 committed 为空';--> statement-breakpoint

-- ai_artifacts
COMMENT ON TABLE "ai_artifacts" IS '运行产物：evidence/draft/proposal/image；复核与应用回执字段仅提案使用';--> statement-breakpoint
COMMENT ON COLUMN "ai_artifacts"."id" IS '产物 id，格式 art_<32位十六进制>';--> statement-breakpoint
COMMENT ON COLUMN "ai_artifacts"."producer_call_id" IS '服务端执行身份（stepId/toolCallId），绝不用模型自报 id';--> statement-breakpoint
COMMENT ON COLUMN "ai_artifacts"."result_index" IS '同一调用内的产物序号，与 producer_call_id 联合唯一';--> statement-breakpoint
COMMENT ON COLUMN "ai_artifacts"."kind" IS 'evidence 证据 / draft 草稿 / proposal 提案 / image 图片';--> statement-breakpoint
COMMENT ON COLUMN "ai_artifacts"."schema_version" IS 'payload 契约版本';--> statement-breakpoint
COMMENT ON COLUMN "ai_artifacts"."payload" IS '产物内容 JSON';--> statement-breakpoint
COMMENT ON COLUMN "ai_artifacts"."evidence_refs" IS '引用的证据定位列表，复核时按当前权限与版本校验';--> statement-breakpoint
COMMENT ON COLUMN "ai_artifacts"."review_revision" IS '复核状态的乐观并发修订号';--> statement-breakpoint
COMMENT ON COLUMN "ai_artifacts"."review" IS '提案复核状态 JSON';--> statement-breakpoint
COMMENT ON COLUMN "ai_artifacts"."application_state" IS '应用状态：pending / partial / applied / rejected / conflict / unknown';--> statement-breakpoint
COMMENT ON COLUMN "ai_artifacts"."receipt" IS '结构操作通道的 durable 持久化回执';--> statement-breakpoint

-- ai_events
COMMENT ON TABLE "ai_events" IS '会话事件流（SSE 重放来源）；随会话删除级联清理';--> statement-breakpoint
COMMENT ON COLUMN "ai_events"."sequence" IS '会话内单调序号（>0）';--> statement-breakpoint
COMMENT ON COLUMN "ai_events"."type" IS '事件类型：message.created / run.updated / artifact.created / artifact.application-updated / scope.changed / conversation.updated';--> statement-breakpoint
COMMENT ON COLUMN "ai_events"."entity_id" IS '关联实体 id（消息/Run/产物）';--> statement-breakpoint
COMMENT ON COLUMN "ai_events"."payload" IS '事件负载';--> statement-breakpoint

-- ai_sessions
COMMENT ON TABLE "ai_sessions" IS 'DSH 原生 Session 日志：仅用于崩溃恢复与产品投影，不是第二份可写正文快照，不直接对外服务';--> statement-breakpoint
COMMENT ON COLUMN "ai_sessions"."id" IS '可推导主键 ws_<会话十六进制 id>_<上下文修订号>';--> statement-breakpoint
COMMENT ON COLUMN "ai_sessions"."context_revision" IS '对应会话的上下文修订号';--> statement-breakpoint
COMMENT ON COLUMN "ai_sessions"."header" IS 'Session 头 JSON（格式由官方 SDK 决定）';--> statement-breakpoint
COMMENT ON COLUMN "ai_sessions"."inherited_event_count" IS '继承自父 Session 的事件数（回放偏移）';--> statement-breakpoint
COMMENT ON COLUMN "ai_sessions"."events" IS '事件序列 JSON';--> statement-breakpoint
COMMENT ON COLUMN "ai_sessions"."next_seq" IS '下一条事件的序号';--> statement-breakpoint

-- ai_image_jobs
COMMENT ON TABLE "ai_image_jobs" IS '图片生成外部副作用台账；长 base64 与签名 URL 不进消息与原生日志';--> statement-breakpoint
COMMENT ON COLUMN "ai_image_jobs"."id" IS '服务端键 <Run id>:<toolCallId>；供应商 job id 在 provider_result 内';--> statement-breakpoint
COMMENT ON COLUMN "ai_image_jobs"."tool_call_id" IS '触发生成的工具调用 id';--> statement-breakpoint
COMMENT ON COLUMN "ai_image_jobs"."status" IS 'pending / unknown（对账中）/ ready / failed';--> statement-breakpoint
COMMENT ON COLUMN "ai_image_jobs"."asset_id" IS 'ready 后的附件 asset id，ready 态必填';--> statement-breakpoint
COMMENT ON COLUMN "ai_image_jobs"."provider_result" IS '供应商原始输出与失败详情，等待对账收敛';--> statement-breakpoint

-- document_indexes
COMMENT ON TABLE "document_indexes" IS '文档向量索引调度台账；只记录进度与租约，不存向量数据本身';--> statement-breakpoint
COMMENT ON COLUMN "document_indexes"."document_id" IS '被索引文档；不设级联外键，向量数据的清除由删除流程负责';--> statement-breakpoint
COMMENT ON COLUMN "document_indexes"."active_index_version" IS '当前生效的向量批次 uuid';--> statement-breakpoint
COMMENT ON COLUMN "document_indexes"."generation_id" IS '已索引内容所属的 generation id';--> statement-breakpoint
COMMENT ON COLUMN "document_indexes"."durable_seq" IS '已索引到的更新序号';--> statement-breakpoint
COMMENT ON COLUMN "document_indexes"."metadata_revision" IS '已索引到的标题/标签元数据修订号';--> statement-breakpoint
COMMENT ON COLUMN "document_indexes"."config_fingerprint" IS '嵌入配置指纹，不匹配即触发重建';--> statement-breakpoint
COMMENT ON COLUMN "document_indexes"."snapshot_id" IS '本次索引采用的投影快照标识';--> statement-breakpoint
COMMENT ON COLUMN "document_indexes"."chunk_count" IS '当前分块数';--> statement-breakpoint
COMMENT ON COLUMN "document_indexes"."lease_token" IS 'worker 租约令牌';--> statement-breakpoint
COMMENT ON COLUMN "document_indexes"."lease_until" IS '租约到期时间，过期处理中行可被回收';--> statement-breakpoint
COMMENT ON COLUMN "document_indexes"."attempts" IS '连续失败次数（退避调度）';--> statement-breakpoint
COMMENT ON COLUMN "document_indexes"."available_at" IS '下次最早可调度时间';--> statement-breakpoint
COMMENT ON COLUMN "document_indexes"."last_error_code" IS '最近一次失败错误码';--> statement-breakpoint

-- qa_sites
COMMENT ON TABLE "qa_sites" IS '公开问答站点：委托来源空间与逐文档公开审批的授权边界';--> statement-breakpoint
COMMENT ON COLUMN "qa_sites"."id" IS '站点 id，格式 site_<32位十六进制>';--> statement-breakpoint
COMMENT ON COLUMN "qa_sites"."owner_workspace_id" IS '归属工作空间；管理权属于该空间当前管理员';--> statement-breakpoint
COMMENT ON COLUMN "qa_sites"."slug" IS '公开访问路径名；全局唯一，禁用站点仍占位不释放';--> statement-breakpoint
COMMENT ON COLUMN "qa_sites"."welcome" IS '访客欢迎语';--> statement-breakpoint
COMMENT ON COLUMN "qa_sites"."suggested_questions" IS '预置问题列表 JSON 数组';--> statement-breakpoint
COMMENT ON COLUMN "qa_sites"."access_mode" IS 'public 免密 / code 口令访问';--> statement-breakpoint
COMMENT ON COLUMN "qa_sites"."access_code_hash" IS '访问口令哈希；access_mode=code 时必填';--> statement-breakpoint
COMMENT ON COLUMN "qa_sites"."status" IS 'draft / pending / active / paused / disabled';--> statement-breakpoint
COMMENT ON COLUMN "qa_sites"."revision" IS '业务配置修订号；来源/审批/展示变更时递增，CAS 用';--> statement-breakpoint
COMMENT ON COLUMN "qa_sites"."access_revision" IS '凭证修订号；仅在暂停/撤权/口令/访问模式变更时递增';--> statement-breakpoint
COMMENT ON COLUMN "qa_sites"."quota_policy" IS '访客限流策略 JSON（每小时消息数/并发 Run/最大范围文档数）';--> statement-breakpoint
COMMENT ON COLUMN "qa_sites"."expires_at" IS '站点到期时间';--> statement-breakpoint

-- qa_site_sources
COMMENT ON TABLE "qa_site_sources" IS '委托给站点的来源空间；granted_by 的授权需要持续复核';--> statement-breakpoint
COMMENT ON COLUMN "qa_site_sources"."id" IS '来源 id，格式 src_<32位十六进制>';--> statement-breakpoint
COMMENT ON COLUMN "qa_site_sources"."public_label" IS '访客侧展示的空间名称';--> statement-breakpoint
COMMENT ON COLUMN "qa_site_sources"."granted_by" IS '委托管理员身份 id';--> statement-breakpoint

-- qa_site_documents
COMMENT ON TABLE "qa_site_documents" IS '逐文档公开审批记录；绑定来源与其真实所属空间';--> statement-breakpoint
COMMENT ON COLUMN "qa_site_documents"."id" IS '记录 id，格式 qsdoc_<32位十六进制>';--> statement-breakpoint
COMMENT ON COLUMN "qa_site_documents"."workspace_id" IS '反范式列；复合外键据此证明文档确属该来源空间';--> statement-breakpoint
COMMENT ON COLUMN "qa_site_documents"."approved_by" IS '最近一次批准的审批人';--> statement-breakpoint
COMMENT ON COLUMN "qa_site_documents"."state" IS 'active 已公开 / suspended 已暂停';--> statement-breakpoint
COMMENT ON COLUMN "qa_site_documents"."suspension_reason" IS '暂停原因；suspended 时必填';--> statement-breakpoint
