# rag 设计规划

> 2026-10-24 应用更新：RagChat 在 app-web 独立维护问答状态与草稿，共用 chat-ui，通过原 LangChain 问答 API 保留历史、取消与 checkpoint 恢复。检索包自身不持有 checkpoint；问答执行仍使用 LangGraph。当前页面基于授权所选资料，不将检索包能力等同于全库向量问答已接入。见 [实施记录](ai-chat-implementation.md)。

> 2026-10-24 两条消费链路：RAG Chat 继续使用 LangChain 驱动问答并组合本包的检索/来源能力；协作 AI 写作的 [research 插件](ai-plugins.md#5-research调研)也可通过宿主注入本包端口。两者分别编排，写作中的 DSH Agent 不接管 RAG Chat。rag 包保持检索职责，不依赖 chat-ui 或 DSH；前端分别封装 RagChat/WritingChat，共用基础组件。

状态：2026-10-19 已按用户编码指令实现 `@zhishu/rag`，目录 `packages/rag`；[返回文档地图](../README.md)。本包只适配知书内容与成熟检索组件；应用索引调度和授权模式迁移仍由 app-server 负责。

消费说明见 [包 README](../../packages/rag/README.md)。已验证真实 LangChain 分块、Qdrant 1.17.1 的 insert_only、nested 条件 payload 更新、LangChain QdrantVectorStore 兼容读取、候选投影、授权后读取正文、租户隔离与过期构建候选扩查。Embedding 使用 LangChain 确定性测试实现，真实语义召回质量和 RG-LOAD 尚未验收。

实现增加官方客户端的显式初始化/写入/策略更新函数；写入返回前复核不可变正文与 Embedding 输入摘要。SDK 的空分隔符会拆开 UTF-16 代理对，因此只适配这个分隔动作以按 Unicode 码点切分，分块与合并仍交给 LangChain。默认以 UTF-8 字节数作保守 token 上界，可注入与模型匹配的 tokenizer 并更新 chunkerVersion。超出 document-contracts 安全整数范围的 durableSeq 明确拒绝，已接受序列号按十进制字符串存储。

aclRevision 使用十进制字符串；当前策略更新 API 按 previousRevision 精确匹配，阻止旧修订覆盖新修订，部分更新可幂等重试。应用必须核对全部 points 并追赶中间修订后才能发布同步完成；不使用浮点 range 比较 bigint。Qdrant 同分分页使用排除已读取 point ID 的过滤，避免 offset 的不稳定排序丢失候选。

本文第 2、4、6 节的 SQL 元数据、document_indexes、租约 Worker、事务推进、tombstone 清理、授权模式统一与迁移属于 app-server 集成，尚未修改应用权限或创建 SQL 表。应用必须注入真实当前关系解析、候选批量授权/版本检查及证据交付复核；包不根据 viewer 回退或客户端参数签发授权键。

## 1. 选型与首期范围

| 能力                  | 复用能力                                                                                                                                                               | 知书负责                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 分块                  | `@langchain/textsplitters`                                                                                                                                             | 中文参数、Block 到原文区间的映射            |
| Embedding / Retriever | LangChain core 与模型适配包                                                                                                                                            | 模型配置、预算、当前版本和权限              |
| 向量与切片存储        | Qdrant；[LangChain QdrantVectorStore](https://docs.langchain.com/oss/javascript/integrations/vectorstores/qdrant)，`@langchain/qdrant` 与官方 `@qdrant/js-client-rest` | 切片文本、向量、ACL payload、同步发布与清理 |
| 多轮研究              | Deep Agents 调用 searchKnowledge/readSource                                                                                                                            | 授权工具、证据登记与引用校验                |

2026-10-19 决策更新：Qdrant 保存切片、向量和稳定的资源授权键 readAclKeys；团队共享文档用 space 键，个人文档用 user 键，独立授权用 document 键，不再向每个切片展开成员名单。PostgreSQL 保存空间成员、文档直接授权与访问模式，服务端每次检索据此计算可用键并复核。普通加人/踢人不更新 Qdrant；向量阶段仍只有一张新增 SQL document_indexes 和一个 collection，不使用 pgvector 或 SQL document_chunks。

本包不负责回答生成、任务调度、数据库事务或文档写入。应用装配 LangChain 的 Embedding/Qdrant 适配；需要候选字段投影、确定 point ID、批量读取/删除时直接使用官方客户端，不强行绕过能力边界套用通用 similaritySearch。本包不再包装通用向量库接口或索引编排框架。混合检索与重排按实际质量再启用。

## 2. 一张 SQL 表、一个 collection 与稳定授权键

| 存储/字段                       | 内容                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| PostgreSQL `workspace_members`  | 复用 tenant/workspace/identity/role，维护真实团队成员关系                                                                            |
| PostgreSQL `document_acl`       | 复用 tenant/document/identity/action，维护独立文档分享和动作授权                                                                     |
| 现有表新增业务列                | workspaces.kind=personal/team；documents.accessMode=space/restricted；documents.aclRevision 仅表示索引访问策略修订                   |
| PostgreSQL `document_indexes`   | 每租户/文档一行，保存正文/策略目标与已同步版本、active/buildingIndexVersion、状态、片段数/摘要、租约和重试；不存主体名单、切片或向量 |
| Qdrant，例如 `zhishu_chunks_v1` | 每个 point 保存一个版本中的切片、向量、来源定位和少量 readAclKeys，所有租户共享 collection 并强制租户过滤                            |
| `IndexOptions`                  | collection、模型/维度/距离、分块版本与预算，派生配置指纹；不新增配置表                                                               |

普通成员增删修改已有关系表，改变的是服务端查询授权键，不改变文档的稳定键，不推进该文档的索引目标。accessMode、个人空间归属主体、文档所在空间等使键本身变化时，才在业务事务中递增 aclRevision 并推进 document_indexes。该修订不再随每次成员操作递增；成员读取与撤权不能仅依赖它。

这些是待审的新业务语义。当前代码尚无 kind/accessMode，空间角色仅管组织，不能把新规则标记为已经生效。字段属于应用元数据，不是 DocumentContent 的节点属性，不新增权限、来源、profile 或主体展开表。

document_indexes 主键为 tenantId/documentId，每篇文档一个目标配置。正文构建分配新 indexVersion，point ID 根据 tenant/document/indexVersion/chunkOrdinal 生成确定 UUID；已发布正文和向量不可变。仅稳定授权键变化时沿用 activeIndexVersion，受策略修订保护更新 payload。

### 用户、空间与文档分别授权

把“空间默认继承”和“独立文档授权”显式分开，首期不引入 deny 规则或父目录 ACL 继承：

| 场景                                    | 业务读取规则                                                            | point 的 readAclKeys         |
| --------------------------------------- | ----------------------------------------------------------------------- | ---------------------------- |
| 团队空间、accessMode=space              | 当前真实空间成员按空间角色读取；组织者/编辑者的写权限按统一业务策略计算 | `["space:s1"]`               |
| 个人空间文档                            | 默认 owner 可读；单篇分享使用原 document_acl                            | `["user:u1", "document:d1"]` |
| 团队空间受限文档、accessMode=restricted | 不接受空间默认授权，沿用文档 owner 与显式 document_acl                  | `["document:d2"]`            |

document 键只是“已获权读取这篇文档”的资源标识，不是一个凭 ID 即可加入的组。个人文档预置 document 键，因此第一次分享、后续增删分享成员均不改 points；没有授权的人不会获得这个查询键。个人 user 键取自已校验的归属 owner；个人空间的 owner/文档归属须保持一致，不能把分享者或任意创建者误作 owner。单篇受邀不允许列出整个个人空间或其他文档目录。同一文档的所有切片使用同一组键，不按用户复制向量。

团队 space 模式的空间成员默认可读，文档创建者身份本身不绕过当前成员检查；restricted 模式的空间 admin/editor 不自动获得正文权限。space 模式下删除某人的直接文档授权不会消除其空间继承权限；如果要求只允许部分人读取，应把该文档改成 restricted。针对不同人的只读/编辑/导出/AI 等差异仍由业务授权计算，readAclKeys 只表示读取，不能赋予其他 action。

移出空间撤销空间继承授权；restricted 文档中的独立分享按原文档规则单独管理。产品的“撤销全部访问”必须同时收回相关直接分享，不能把“移出空间”描述为已经清除一切独立授权。若该主体还是受限文档 owner，须显式处理文档归属或身份禁用，删除 ACL 行不能撤销隐式所有权。普通成员关系调整仍只修改 PostgreSQL，不改稳定 document 键；个人 owner 变更属于需要同步资源键的归属变更。

### 服务端计算查询键

每次查询先按当前租户、身份和选定知识范围读取主库或有撤权一致性保证的关系，得到：

- 自身个人主体键，例如 `user:u1`，不允许由分享关系推导出其他人的 user 键。
- 当前确实是成员且该角色允许读取的团队空间键，例如 `space:s1`。
- restricted/个人文档中，当前 owner 或显式 action 规则判定可读的 document 键，例如 `document:d2`。

已有 workspaceAccess 对非成员返回 viewer，用于目录浏览；这个回退角色不是成员证明，绝不能直接据此签发 space 键。必须检查空间 owner 或真实 workspace_members 记录，不能让“知道 spaceId”变成正文授权。匿名分享不开放知识库检索，服务端生成键，客户端/模型均不能自报授权键。

检索条件为 tenant、选定 workspace/document 范围、正文配置/状态和“readAclKeys 与服务端可用键至少一个相交”共同成立。不同资源键之间用 OR，整体仍与租户/范围做 AND，使用 Qdrant [match any](https://qdrant.tech/documentation/search/filtering/#match-any)，不依赖 Prompt。

查询键过多时按 token 数/请求字节有界拆批、固定相同租户/范围条件，合并分数并按 point ID 去重，再统一权限复核；不得改成无授权过滤，也不能静默截掉部分文档而声称完整结果。个人/受限文档很多时，document 键解析和筛选成本仍须压测，不宣称所有读取 O(1)。

### Qdrant point 与 ACL payload

沿用 LangChain 可配置的 content/metadata 载荷；过滤和 payload 索引使用 metadata. 前缀。具体 SDK 参数在锁定版本验证，不发布新的公共 Qdrant 类型。

| point 字段           | 内容                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| id / vector          | 构建内稳定 UUID，一个首期 dense 向量空间，维度/Cosine 由 collection 配置确定                                                           |
| payload.content      | 切片原文，检索前缀与摘录区间分开                                                                                                       |
| metadata 来源字段    | tenantId、workspaceId、documentId、indexVersion、snapshotId、chunkOrdinal、blockId、UTF-16 区间、原文/Embedding 输入摘要和有限标题路径 |
| metadata 版本字段    | generationId、durableSeq、metadataRevision、aclRevision、configFingerprint、sourceState                                                |
| metadata.readAclKeys | space/user/document 三类稳定键，首期每 point 通常一至两个；没有键默认拒绝                                                              |

collection 创建时先建立 tenantId、workspaceId、documentId、indexVersion、readAclKeys、configFingerprint、sourceState 的 keyword 索引；策略修订使用与序列化一致的类型，durableSeq 使用无损十进制字符串。不再保存 readIdentityIds 或切片级用户 action 名单。旧载荷必须重建/显式迁移，不把空键或旧 viewer 角色回退成全空间可读。

### 对象也保持精简

复用 document-contracts 的 DocumentSnapshot、ai-contracts 的 EvidenceItem/SourceReference/EvidenceBundle。配置和检索继续使用 IndexOptions 与 KnowledgeRetriever；新增格式输入 RagDocumentSource、DocumentParseOptions 和平台无关 ImageStorage，源码与完整示例见包 README。不另建向量存储接口或 SDK 类型体系。

```ts
import type { DocumentSnapshot } from "@zhishu/document-contracts";
import type { EvidenceBundle, EvidenceItem } from "@zhishu/ai-contracts";

export interface IndexOptions {
  collectionName: string;
  embeddingFingerprint: string;
  dimensions: number;
  metric: "cosine";
  normalizerVersion: string;
  chunkerVersion: string;
  targetTokens: number;
  maxTokens: number;
  overlapTokens: number;
}

export interface KnowledgeRetriever<Scope> {
  retrieve(input: {
    query: string;
    scope: Scope;
    contextTokenBudget: number;
    signal: AbortSignal;
  }): Promise<EvidenceBundle>;
}

export declare function prepareDocumentChunks(
  snapshot: DocumentSnapshot,
  options: IndexOptions,
): Promise<readonly EvidenceItem[]>;
```

Scope 是应用在服务端创建的授权上下文，不是模型或浏览器可提交的权限声明。具体构造参数在实施时按选定的 LangChain 类型收敛；本节不另外维护一套 SDK 类型体系。

## 3. 文档分块与来源定位

原生正文直接读取可信 DocumentSnapshot。首期以单个可寻址 Block 为边界，长段落用现成 splitter 切分，保存对应原文 UTF-16 半开区间；不跨块拼装需要多套来源映射的大 chunk。标题路径可作为检索前缀，但不能冒充原文摘录。

列表只遍历一次，保留层级上下文；代码优先按行切分。原生、GFM 和 HTML 表格保留行关系与表头上下文，优先按行切分；原生合并单元格展开到规范化网格。原生表格以表格 blockId 定位，外部文档以 sectionId 定位，区间对应 prepareDocument 返回的规范化 blocks 文本。CSV 支持 BOM、引号内逗号/换行、转义引号、重复表头、可选分隔符和无表头模式，公式作为文字保留。

图片通过公开 ImageStorage.readImage/uploadImage 适配任意 OSS。内嵌 data URI 直接解码，知书 assetId、外部 URL 和相对路径由宿主授权读取；包不自行下载任意网址或读取本地路径。实际类型检测、SHA-256 去重和大小/数量预算后调用上传接口，将解析结果的图片替换为稳定 URL，再执行分块/Embedding。原始知书正文继续保留 assetId，不新增持久化图片 URL 属性。上传失败和取消不返回成功结果，已有对象的生命周期由上传适配器管理。

prepareDocument 同时返回规范化全文、逐块文本、EvidenceItem[] 和上传清单。图片链接作为完整单元保留，预算不足时明确失败。上传清单参与派生来源版本，内部 rag-parser-v2 进入索引指纹，因此旧的单元格分块索引必须重建。外部来源可通过 writeDocumentIndex 的 source/version/parsing 参数走同一授权索引链路，版本与实际资源权限由宿主提供。OCR、视觉内容理解和 Word/PDF 二进制解析仍后置。

分块预算从 target 500、max 800、overlap 80 tokens 起测；标题和重复上下文也计入预算。模型返回向量数量、维度与有限数值需要验证。缓存向量属于后续优化，首期不新增 Embedding 缓存表。

SourceReference 的 sourceId 对应 documentId，snapshotId 可以由文档 generation/durableSeq/Schema/摘要确定性编码产生，都是值引用，不代表新增来源或快照记录。研究证据与最终引用复用相同的来源结构。

## 4. 索引更新，不单独建任务表

当前 document_outbox 属于 DocumentProjectionWorker，完成后清空载荷；RAG 不竞争原消费者。projection 成功时在同一事务推进 document_indexes；文档正文/元数据、访问模式、资源键、删除状态的变更同样推进目标。普通 workspace_members/document_acl 成员变更不进入索引队列。

Worker 用 SELECT FOR UPDATE SKIP LOCKED 和租约领取同一索引行。正文/配置目标变化使旧构建无法发布；策略键更新不要求重新 Embedding。策略视图与正文版本由同一可信视图固定，发布时再次核对。

1. 正文构建领取新 buildingIndexVersion/leaseToken，加载最新可信投影；投影滞后则退避。
2. 事务外分块/Embedding，使用新 point ID 和锁定版本支持的 insert_only 写入完整切片、初始资源键，等待完成并核对摘要。重传忽略已有 ID，禁止旧普通 upsert 覆盖更新后的策略，见[官方 Update Mode](https://qdrant.tech/documentation/manage-data/points/?q=batch)。
3. PostgreSQL 重新核对文档有效性、正文/配置目标和 leaseToken/buildingIndexVersion，才发布 activeIndexVersion 与实际写入修订；策略未追上则保留 pending，不覆盖新目标。
4. 失败重试留在原行。旧 Worker 无法发布；按明确废弃 indexVersion 清理，先核对当前 active/building，不能删除其他仍可能发布的构建。

空文档允许零片段。删除/撤出索引保留 tombstone，文档硬删除后不级联丢失清理责任；确认旧 Worker 结束、Qdrant 清理完成才删除该记录。跨服务没有原子事务；Qdrant wait/ordering 不能代替业务版本条件，见[一致性说明](https://qdrant.tech/documentation/scaling/consistency-guarantees/)。

### 4.1 高频成员变更仅更新授权关系

普通加人、踢人、角色/文档 action 调整，仅提交 PostgreSQL 关系与审计，定向失效受影响主体的权限上下文/协同会话/AI 交付；下一次请求重算查询键。不等待 Qdrant、不更新 points、不重传向量、不调用 Embedding。个人共享首次加人也使用预置 document 键，不需切换 payload。

相同内容的 no-op/幂等重放不反复触发失效；批量操作使用有大小上限的业务命令。不同文档可并行，同一热点关系仍受 PostgreSQL 行锁约束，需有界准入/排队，不能为 2,000 名员工创建 2,000 个数据库连接，也不能让热点锁等待占满连接池。新增权限不踢无关会话，撤权定向通知并由每次受保护操作重新检查；通知不能是唯一安全依据，多实例传播失效的要求仍需落实。

只有 accessMode、个人归属主体或空间归属等使稳定键变化时，才需要 Qdrant 同步。可按文档短窗口合并最新策略，窗口/最大等待与失败退避分开；它不再用于每次成员修改。参数与完成时延经过测试确定，不预先承诺 SLA。

### 4.2 策略键变化的条件 payload 更新

正文/metadata/模型配置不变而仅策略键变化时，沿用 activeIndexVersion：

1. 固定 activeIndexVersion 和最新策略修订 r，从当前业务规则编译少量 readAclKeys，不枚举空间/文档全部成员。
2. 通过官方 [set payload](https://api.qdrant.tech/api-reference/points/set-payload)，以 tenant/document/indexVersion 及 metadata.aclRevision < r 限定，向 metadata 子路径一并写 readAclKeys/aclRevision。不覆盖正文、向量、其他来源字段或整个 metadata。
3. 等待完成并核对预期 points 的目标修订/键摘要；超时和部分完成同目标幂等重试，旧修订不覆盖新修订。
4. PostgreSQL 以 leaseToken、活动版本和目标条件提交已同步策略；来源/配置变化时不能标记完成，改走新构建或继续同步最新目标。

锁定版本必须验证条件修改、nested key、insert_only、多副本及旧写入晚到。只有模式/归属变更才承担切片数相关的 payload 成本；普通成员关系变更的 Qdrant point 更新数为零。正文重建时可复用向量的前提仍是分块、前缀、实际 Embedding 输入摘要和模型完全一致，标题前缀变化不能只比较原文。

### 4.3 容量与迁移验收

2,000 人在线、2,000 个同时在途请求、持续 2,000 次写入/秒是不同负载。当前无相应实测；默认单实例连接池上限 10 不是容量结论。分别测试分散文档、同一空间/文档热点、持续阶梯负载，并固定员工/空间/文档数、切片数、直接授权数量和硬件，同时运行编辑与检索。

记录成功吞吐、接纳/拒绝数、P95/P99、连接池/锁等待、授权键解析与过滤字节、撤权拦截、重连数，以及模式变化的策略同步追平时间。普通成员增删须验证 Qdrant points/vector/Embedding 更新为零；429/超时单列，不算成功吞吐。容量目标通过测试前约定的场景与结果确认。

旧文档统一按 restricted 回填，保留原文档 owner/显式授权，不因增加 kind/accessMode 自动开放给所有空间成员。团队 space 继承由显式选择启用；个人空间分类和 owner 一致性也需确认，不能按“某用户创建了空间”自动认定为个人。所有 HTTP/WS/搜索/协同写入/导出/AI 共用同一新授权策略，不能仅把 Qdrant 改成继承而其他接口继续旧规则。未完成模式回填、payload 重建和越权验收前，不启用新检索键。

## 5. 检索、权限与新鲜度

应用只交付当前 activeIndexVersion 且 generation/durableSeq/metadataRevision/配置与业务头部一致的正文。Qdrant 资源键是召回过滤投影，不是权限权威库；知道 space/user/document ID 不授予访问。

最小流程：认证/选定范围 → 从当前关系解析可用键 → query Embedding → Qdrant 按 tenant/范围/稳定键检索 → 候选 ID/分数/最小版本字段 → PostgreSQL 批量复核当前模式、成员/直接授权及正文发布版本 → 按精确 point ID 取 Qdrant 文本 → 定位/摘要/预算 → EvidenceBundle。首轮 with_payload 不取正文、标题或授权名单，原始候选不对外展示；先授权再送 reranker/LLM。

不能用浏览器传入的 spaceId 列表或长效 JWT 的旧成员声明直接生成键。第一阶段按请求读取当前关系；若以后缓存，必须处理可靠失效与撤权一致性，最终复核仍走主库或能证明已追上变更的一致性读，不使用固定 TTL 的旧允许缓存。批量复核避免每个切片单独查询 SQL。

普通成员变更不改变稳定键，因此已有索引下新授权可在下一次关系读取后参与搜索，撤权者下一次解析不再获得对应键；定向通知停止其在途后续交付。已经交付的文本无法收回，模型使用前、最终结果和引用打开仍复核。仅模式/归属变化涉及 payload 延迟；旧键偶尔召回也须被当前业务检查拦截，新增键尚未同步时允许少结果。

策略 aclRevision 跟踪投影同步和乱序保护，不是成员版本或对所有用户停搜的开关。切片策略修订可落后但不得异常超前；当前用户始终按实际最新规则授权，模式变化不能绕过该检查。

旧构建/候选可能占 Top-K，允许有界扩大候选、排除已处理 ID；达到时间/数量上限返回不足，禁止放宽 tenant、范围或资源键。关键词、混合召回与重排遵守相同授权。删除/移动/新 generation 先由当前业务状态排除，后异步清理。全文/历史回看走原文档能力，不承诺保留任意旧来源独立快照。

Qdrant 是私有服务依赖，不向浏览器或模型工具暴露密钥/直连接口。首期不缓存带正文的完整答案，不增加检索权限事实表或单独 ACL collection。

## 6. 部署、模型升级与后置能力

SQL schema/migration 保留在 apps/app-server/database，Qdrant collection 与 payload 索引由应用的显式初始化/升级流程管理，普通请求不自动建 collection。配置包含 QDRANT_URL、服务端 QDRANT_API_KEY、QDRANT_COLLECTION 及超时/批量/候选上限；未启用 RAG 的独立文档模式不要求 Qdrant，OpenAPI 离线导出不连接它。

索引 Worker 可用同一服务包的独立入口，停止、租约和有界并发由应用管理；仅通过 document_indexes 领取/重建。RAG 不使用 LangGraph checkpoint；AI 研究的 PostgresSaver 仍在现有 PostgreSQL 的独立 schema 中。全部启用后共六张新增 SQL 表与一个 Qdrant collection，不增加消息中间件、检索 ACL 表或 IndexProfile 管理系统。

模型、维度、存储精度与 Qdrant 配置一并验证。相同配置空间内升级通过新指纹重新构建；不同维度/距离等不兼容变更创建新 collection 并显式更新配置、重建，首期接受可用性下降。不要直接向旧 collection 写不同维度，也不提前实现多 profile 零停机切换。

Qdrant 可独立备份以缩短恢复时间，切片/向量/ACL payload 都按正文敏感数据保护；权威正文与 ACL 可从 PostgreSQL 重建。Qdrant 备份恢复或丢数据后先将相关索引状态置为待核对/重建，核对实际 points 和完整版本后才恢复检索，不能继续信任 PostgreSQL 旧的“已同步”标记。

外部 PDF/Word、Docling 解析、独立来源同步、复杂片段拼接和完整历史证据回看后置。实际出现这些需求时，再决定是否拆 knowledge_sources 或不可变来源快照表，不能先把规划都变成表。

## 7. 交付与验收

RG-01：真实 LangChain 分块/Embedding、Qdrant point 和 Block 定位，覆盖中文、代码/表格、重复标题、空文档和无损序列号。

RG-02：一张索引表和一个 collection 验证租约/条件发布、部分写入、旧 Worker 晚到、insert_only、策略键更新、Top-K 挤占、tombstone、清理竞争和恢复后的重核。

RG-ACL：验证团队继承、个人单篇分享、restricted 文档、不同空间的不同角色、同租户直接分享、跨租户同名 ID、非成员 viewer 回退、空查询键、客户端伪造键、模式切换与移动、在途撤权/缓存来源恢复。禁止把个人单篇分享变成 owner 的整个个人空间权限，旧文档回填不能扩大访问。

RG-LOAD：测试 4.3 的负载矩阵；普通加人/踢人/角色变更不触发 Qdrant 写入或 Embedding，热点 SQL 有界，定向失效不反复踢无关用户。大量 restricted 文档的键解析/拆批和资源模式变更需单独测量。

RG-03：固定中文问题/gold sources，报告 Recall@K、引用正确性、无答案识别、P95、成本。此项需要实际模型与业务语料，当前不将确定性向量测试视为语义质量验收。包测试运行 `pnpm test:ai`，设置隔离实例的 `QDRANT_TEST_URL` 后启用真实 Qdrant 测试；测试 collection 使用随机名称并在 finally 删除。
