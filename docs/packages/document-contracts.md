# document-contracts 设计规划

状态：M2 实现中。对应 `packages/document-contracts`；[返回文档地图](../README.md)。内容 Schema、语义校验、快照兼容、协同快照字段、原子操作批次、迁移执行器、资产引用/选区锚点合约、临时协同 Presence 合约和 Block ID helper 已实现；迁移代次事务、资产流程、AI/事件合约仍按阶段推进；服务端已实现最新 JSON 投影/outbox 和存量代次回填，但 snapshot-ready 消费合约和索引事件仍未接入；包尚未发布。

## 1. 产品职责

让编辑器、协同转换、AI 提案和知识索引对同一份内容有一致理解。包可用于浏览器、Node.js 和工具程序；导入时不访问 DOM、网络、存储或环境变量。

依赖仅限可跨运行时使用的校验能力。React、Tiptap/Yjs 实例、数据库表、身份认证、空间与权限策略留在各自模块。HTTP 请求/响应由 app-server 的 Zod route contract 定义，本包承载其中引用的内容合约，避免复制整套 REST DTO。

## 2. 功能清单

| 编号  | 能力                | 细节                                                                | 阶段                                        |
| ----- | ------------------- | ------------------------------------------------------------------- | ------------------------------------------- |
| DC-01 | 内容树与节点规范    | doc/文本/段落/标题/列表/引用/代码等结构、Mark、合法嵌套、属性默认值 | M1                                          |
| DC-02 | 可寻址 Block        | 稳定 blockId、树内唯一性、父子位置、复制/拆分/合并/移动规则         | M1                                          |
| DC-03 | 快照与兼容声明      | schemaVersion、所需扩展、文档代次、durableSeq 与快照版本            | M1/M2 合约已完成；快照存储 M2               |
| DC-04 | 编辑操作与结果      | 插入/删除/移动/替换、目标前置条件、批次原子性、结构化错误           | M1                                          |
| DC-05 | 运行时校验          | 大小/深度/节点数量、属性白名单、URL 协议、错误路径、未知扩展处理    | M1                                          |
| DC-06 | 内容迁移            | 显式版本迁移、可重复执行、失败保留原件、迁移前后审计信息            | M1 定约；M2 执行链                          |
| DC-07 | 资产与锚点引用      | assetId、替代文本、Block/选区定位、锚点失效与代次绑定               | M2 合约已完成；图片引用接入，锚点解析待接入 |
| DC-08 | AI 编辑提案与流事件 | 请求标识、序号、草稿、目标约束、完整提案、结束/失败事件             | M3                                          |
| DC-09 | 引用和文档事件      | 来源文档/版本/Block、持久化快照事件、索引所需版本信息               | M3                                          |

## 3. 规范源与包入口

以版本化 JSON Schema 作为内容结构规范源。本仓库以 TypeBox 编写可直接序列化的 JSON Schema 2020-12，并从同一 Schema 推导 TypeScript 类型、运行时结构校验和 OpenAPI 组件；不另行手写内容 DTO，也不将共享包绑定到 Zod 主版本。Tiptap 的可编辑结构约束在 core 中根据这些规范绑定并保持一致。树内 ID 唯一性、父子节点合法性和资源上限由同包语义校验补充。

公共入口：根入口提供基础类型、内容/快照验证、Block ID 操作和迁移接口；`/operations` 提供原子编辑操作；`/events` 提供持久化事件；`/ai` 提供可选创作协议。AI 入口不引入模型 SDK，基础入口不加载 AI 专属定义。

app-server 与 app-web 使用不同 Zod 主版本，共享包不导出任何一方的 Zod 实例。D-01 已选定：HTTP 入参/响应仍由 app-server 的 Zod route contract 拥有；文档内容在 OpenAPI 3.1 `components.schemas` 中直接引用共享 JSON Schema。服务端通过共享包的 validator 做运行时语义校验，未来 content route 的 Zod schema 只负责调用该 validator 并引用组件，不复制节点结构。OpenAPI 离线导出脚本断言规范版本、`DocumentContent` 到 `DocumentBlock` 的 `$ref` 和 Block Schema 存在。这样不会因两端 Zod 主版本不同生成两份结构，也不以 `any` 代替内容定义。

实现入口：`packages/document-contracts/src/schema.ts`、`src/validation.ts`、`src/snapshots.ts`、`src/identity.ts`；操作实现位于 `src/operations.ts`，迁移接口位于 `src/migration.ts`；OpenAPI 装配在 `apps/app-server/src/plugins/openapi.ts`。图片 Block 只保存同文档 `assetId`、PNG/JPEG/WebP MIME、替代文本和可选尺寸，不允许保存对象 URL。服务端在正文写入事务中复核 ready asset 并按当前头部/保留版本 durableSeq 维护引用。表格和锚点解析仍未实现。默认内容限制为 2 MiB、20,000 节点、64 层。

## 4. 内容与版本字段

| 对象                    | 必要信息                                                                                               | 语义                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `DocumentContent`       | `type: doc`、节点数组                                                                                  | 纯内容，可在新文档尚未分配 documentId 时使用                            |
| `DocumentSnapshot`      | documentId、schemaVersion、extensions、snapshotRevision、content；协同快照增加 generationId/durableSeq | 普通快照无代次游标；协同快照 generationId/durableSeq 必须成对出现       |
| `Block`                 | 节点 type、`attrs.blockId`、合法 attrs、content                                                        | 扩展定义哪些节点可独立寻址；文本与 Mark 无 blockId                      |
| `ExtensionRequirement`  | 扩展名、内容格式版本、是否必需                                                                         | 格式兼容声明；不等于 npm 包版本，也不装载任意代码                       |
| `OperationBatch`        | operationId、目标代次、操作列表、前置条件                                                              | 一次逻辑变更，全部通过校验才应用                                        |
| `Anchor`                | documentId、generationId、anchorVersion、起止 Block ID、Yjs relative position 编码                     | 代次绑定； contracts 检查文档/代次/Block 是否仍有效，协同适配器解析范围 |
| `AssetReference`        | assetId、媒体类型、尺寸/替代文本等内容属性                                                             | 不保存 URL、上传令牌或存储键；服务端每次读取重新授权                    |
| `SourceReference`       | 来源 documentId、版本、blockId、知识域引用                                                             | 可回溯引用；是否有权访问由服务端决定                                    |
| `CollaborationPresence` | 协议版本、显示名、颜色、可选 Yjs relative-position 选区                                                | ≤2 KiB 临时不可信数据；不进入快照，不代表身份或权限                     |

`schemaVersion` 表示内容格式，`generationId` 表示协同文档代次，`snapshotRevision` 表示 JSON 快照版本，`durableSeq` 表示该代次服务端已持久化更新的位置；这些字段不得混作一个版本号。元数据另有 `metadataRevision`，由 documents 模块维护。

本设计将 `schemaVersion` 定义为正整数主版本；任何会让旧解析器丢失/误读内容的结构变化都递增该值。向后兼容且能无损保留的可选扩展可以在当前主版本内发布，具体 Node 属性的内容版本由 `extensions[].version` 声明。`snapshotRevision` 由服务端在同 generation 内递增，内容相同的重试可复用原 revision。

建议最小内容示例：

```json
{
  "type": "doc",
  "content": [
    {
      "type": "paragraph",
      "attrs": { "blockId": "block_example_01" },
      "content": [{ "type": "text", "text": "开始编写文档" }]
    }
  ]
}
```

Block ID 固定为 `block_` 加 UUID；`createBlockId()` 创建新身份。复制整份内容或单个 Block 时，`cloneContentWithFreshBlockIds()` / `cloneBlockWithFreshIds()` 为所有嵌套 Block 生成不与源树重复的新 ID，并再次校验唯一性。`repairDuplicateBlockIds()` 仅在其余内容校验都通过时保留每个 ID 的首次出现、替换重复项，并再次验证；服务端维护工具将修复结果写入新 generation，不会改写旧更新日志。Block 拆分由当前编辑器保留左侧 ID、为右侧生成 ID；合并保留前一个 Block ID，后一个 ID 离开当前树。普通移动保留原 ID。数组索引和可变路径不作身份。上述拆分/合并规则依赖单机 Tiptap UniqueID 行为验收，不构成并发收敛保证。

当前属性默认值为标题级别 1 和有序列表起始值 1。它们写在 JSON Schema 的 `default` 注解中；`normalizeDocumentContent()` 显式补全这些值并返回副本，不修改调用方输入。运行时验证本身不悄悄改写内容。

已命名文档的快照封装代次和内容格式；普通模式没有 `durableSeq`，协同快照必须声明所覆盖的持久化序列。当前 `DocumentSnapshotSchema` 以两个 JSON Schema 分支表达普通快照与协同快照，后者要求 `generationId` 和 `durableSeq` 同时存在；共享 validator 会拒绝只提供其中一个字段的输入：

```json
{
  "documentId": "doc_01",
  "generationId": "gen_01",
  "schemaVersion": 1,
  "extensions": [{ "name": "editor-basic", "version": "1.0.0", "required": true }],
  "snapshotRevision": 12,
  "durableSeq": 48,
  "content": { "type": "doc", "content": [] }
}
```

`generationId` 与 `durableSeq` 必须成对解释；快照 `content` 始终使用 DC-01 的内容树。`snapshotRevision` 在同一 generation 中单调递增，表示 JSON 快照版本；`durableSeq` 表示快照包含的最大已持久化 Yjs 更新序列。`extensions` 是兼容性声明，不是运行时插件清单；客户端不得据此动态加载代码。

DC-07 新增 `AssetReferenceSchema` 和 `AnchorSchema`，并随内容 schemas 进入 OpenAPI components。资产身份只能是 `assetId`；alt 可为空字符串表达装饰性图片，尺寸可选且有上限，客户端不得把短时下载地址或对象存储内部键写入快照。当前内容树尚未包含图片/附件 Node，引用 Schema 本身不授权访问资产。

选区锚点用 `documentId` + `generationId` 限定作用域，以 `anchorVersion` 和 `encoding: yjs-relative-position-v1` 标识格式，记录起止 Block ID 及 base64 编码的两个相对位置。contracts 不依赖 Yjs 包、不解码位置；`checkAnchorTarget()` 先返回 `stale-document`、`stale-generation`、`target-missing` 或 `current`。`current` 只表示代次和目标仍存在；Yjs adapter 还须解码并把相对位置解析到当前文档，失败时向调用方报告 position-unresolvable，不得猜测邻近位置。拆分、合并、删除后的锚点重定位规则由编辑器协同 adapter 实现，并保留无法映射的失效状态。

## 5. Block 身份与操作不变量

| 操作              | ID 与内容规则                                                    | 对引用的影响                           |
| ----------------- | ---------------------------------------------------------------- | -------------------------------------- |
| 修改/移动         | 同一 Block 保留 ID；移动引用兄弟 ID 与插入方向，不持久化绝对位置 | 引用仍指向原对象；位置重新解析         |
| 复制/导入为新内容 | 为复制子树所有可寻址节点重新生成 ID                              | 不自动复制原文评论、审批或访问权       |
| 拆分              | 原 Block 保留左侧 ID，右侧获得新 ID                              | 锚点映射到对应内容；无法映射则标记失效 |
| 合并              | 保留第一个 Block ID，第二个 ID 退出当前内容树                    | 原第二块锚点按变换映射，无法确定则失效 |
| 删除              | 当前树不再出现此 ID，历史快照保留记录                            | 显示“原内容已删除”，不自动改指邻接块   |
| 版本恢复          | 内容 ID 可保留，但使用新的 generationId                          | 旧代次锚点不能直接作为新代次有效锚点   |

列表项、表格等复合节点由扩展声明寻址边界和可操作范围；只有登记为可寻址的节点才能接受通用 Block 命令。用于检索的“分块”是独立派生规则，不能把父块与所有子块都无差别重复向量化。

操作前置条件至少包含目标存在、代次一致、允许的节点类型；AI 替换再携带目标内容摘要。结果应区分 `invalid-content`、`unsupported-schema`、`unknown-extension`、`target-missing`、`stale-target`、`read-only` 和 `limit-exceeded`，并提供错误路径与可恢复性。应用全批次前完成验证，失败不留下半个文档变更。

操作批次用稳定 ID 和相对 Block 目标描述意图，不保存 ProseMirror 位置或数组下标。M1 `OperationBatchSchema` 限制为 1–256 个操作，包含插入、删除、替换和移动；服务端或编辑器调用层提供文档/代次与只读状态，内容摘要由调用方提供 hash 函数：

```json
{
  "operationId": "op_01",
  "documentId": "doc_01",
  "generationId": "gen_01",
  "origin": "ai-accept",
  "preconditions": [{ "blockId": "block_01", "contentHash": "sha256:..." }],
  "operations": [
    {
      "type": "replace-block",
      "targetBlockId": "block_01",
      "block": { "type": "paragraph", "attrs": { "blockId": "block_01" }, "content": [] }
    }
  ]
}
```

M1 最小操作集为 `insert-block`、`delete-block`、`replace-block`、`move-block`；插入/移动通过父 Block 加 before/after 兄弟 ID 定位，根级父节点使用 `null`。移动保留 ID，替换保留目标 ID，复制须先为整棵子树换 ID。`applyOperationBatch()` 在副本上执行并验证最终树，任一步失败不返回部分结果。错误包含类别、路径和可恢复性。`origin` 由受信任的调用层赋值，不能用于授权。`contentHash` 是应用前的冲突前置条件，不替代服务端版本检查。

## 6. 事件与流合约

文档持久化事件包含 eventId、documentId、generationId、durableSeq/snapshotRevision、发生时间与快照引用。租户和空间等路由信息由服务端事件信封补充；消费者不能仅凭事件内容跳过权限规则。事件可能重复/乱序，消费者据事件标识和版本去重并拒绝旧版本覆盖。

投影事件的语义载荷示例：

```json
{
  "type": "snapshot-ready",
  "eventId": "evt_01",
  "documentId": "doc_01",
  "generationId": "gen_01",
  "durableSeq": 48,
  "snapshotRevision": 12,
  "occurredAt": "2026-09-26T02:00:00Z",
  "snapshotRef": "internal://documents/doc_01/generations/gen_01/snapshots/12"
}
```

`snapshotRef` 是服务端内部引用，不是绕过授权的可公开下载地址。消费者按 `eventId` 去重，并以 `(generationId, durableSeq)` 拒绝旧投影覆盖新投影；相同序列但不同内容摘要属于完整性错误，应告警并停止该次投影。

AI 流只约定编辑器可消费的通用事件：`started`、`text-delta`、`proposal`、`completed`、`failed`，均带 requestId 与单调 seq。文本片段用于草稿展示，只有通过完整 Schema 校验的 proposal 才可变为编辑操作；具体 SSE 编码和重放由 app-server 定义，消费与取消由 ai-bridge 定义。

最小事件外壳为 `{ "type": string, "requestId": string, "seq": integer, "payload": object }`。`started` 建立任务与 attempt，`text-delta` 仅含预览文本，`proposal` 携带 DC-04 `OperationBatch` 及其目标摘要，`completed` 表示生成流正常结束，`failed` 携带安全错误码。成功流最多产生一个最终 proposal；增量 proposal 必须显式带递增 proposal 版本，并由客户端替换同任务的草稿，不能重复追加。事件终态（`completed`、`failed` 或宿主取消）后拒绝同一 requestId 的后续事件。

引用块的完整来源可携带可选扩展属性；普通编辑器遇到未知必需扩展时保留原始输入并报告不兼容。安全占位展示必须经过兼容渲染路径，不能让不认识该 Schema 的可写编辑器重写原内容。

## 7. 兼容与迁移

建立“Schema 版本 + 扩展版本集合”的兼容判断，客户端与服务端在打开可写协同会话前确认支持。新增字段不一定是兼容变更；Node/Mark 的结构变化必须评估旧客户端行为。Tiptap 对 Schema 严格，混用不兼容 Schema 可能导致内容被删除，因此版本不兼容时阻止可写接入。[官方协同 Schema 说明](https://tiptap.dev/docs/hocuspocus/guides/collaborative-editing)

共享 helper `checkDocumentCompatibility()` 对快照和可写会话使用相同规则。协同 session 请求声明客户端支持的 schemaVersion 和扩展版本；服务端只在判定 `writable: true` 时签发可写 ticket，并在 201 响应中显式返回 `{ readable: true, writable: true }`。不兼容请求返回 409，不签发凭据。重复扩展名在服务层输入校验中拒绝。只读兼容展示尚未开放，故不兼容客户端目前得到拒绝响应而非只读 session。

兼容判定按以下顺序执行：

1. `schemaVersion` 主版本不匹配时拒绝可写打开；只读查看必须走能保留未知内容的投影/渲染器。
2. 对每个 `required: true` 的扩展，客户端和服务端校验器都必须声明兼容该内容格式版本；任一缺失即拒绝写入。
3. 可选扩展缺失时，只有在其内容能被不丢失地保留并安全降级的情况下才允许写入；否则按必需扩展处理。
4. 迁移生成新快照，并返回原/目标版本、使用的迁移 ID、变更摘要和拒绝项。协同迁移同时生成新的 `generationId`，旧代次只读关闭。

npm 包版本、`schemaVersion`、扩展内容版本、协同协议版本分别维护。依赖同一格式的包发布需要在兼容矩阵中列出读取/写入范围；升级任一包都不自动迁移已保存文档。

`createContentMigrationExecutor()` 接收唯一 source-version 步骤表和目标 Schema validator。步骤只能向前、同一 source 不允许分叉；执行前克隆输入，按路径记录成功步骤，最终校验失败或迁移抛错时返回未修改的原件和安全错误报告。目标 Schema 版本必须由调用方显式匹配，防止错误地以另一版 validator 宣告可写。当前仓库只有 Schema v1，尚无历史版本迁移可以注册，因此没有实际旧文档升级样例。协同文档迁移的 DB 事务、版本快照、新 generation 创建/切换和旧代次写拒绝仍由 M2 服务端负责；不能在每个客户端首次打开时各自迁移。

需要覆盖旧版输入、新版读取、扩展缺失、迁移失败、空文档、嵌套边界、重复 ID 和恶意超深结构的规范样例。JSON 往返保持语义与必需属性；不得在序列化时悄悄丢弃未知数据。

## 8. 包交付与完成条件

产物提供 ESM、类型声明、明确 exports 与可使用的 Schema 产物。基础导入可在没有 React/Tiptap/Yjs 的独立消费项目运行。发布记录同时列出包版本与支持的内容 Schema，提供变更和迁移说明。

M1 完成 DC-01—06 的规范与最小消费例；M2 补齐代次、资产和锚点；M3 补齐创作/引用/事件。进入各阶段前，调用方必须能从此文档确定一份内容是否可读、可写、可迁移，以及拒绝时如何保留原件。
