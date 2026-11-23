# @zhishu/rag

知书快照、Markdown、HTML、CSV 到 LangChain 切片、Qdrant 索引和授权 EvidenceBundle 的适配包。支持表格按行切分，以及通过调用方的任意对象存储上传文档图片并替换为 URL。SQL、索引租约/发布、任务重试、实际成员关系和文档写入由应用负责。

```ts
import { initializeCollection, writeDocumentIndex, createKnowledgeRetriever } from "@zhishu/rag";

// 显式部署初始化执行；请求路径不自动创建 collection。
await initializeCollection(client, indexOptions);

// 应用在事务内领取 buildingIndexVersion 后，事务外调用。
const summary = await writeDocumentIndex({
  client,
  embeddings,
  options: indexOptions,
  snapshot,
  tenantId,
  workspaceId,
  indexVersion,
  metadataRevision: "1",
  aclRevision: "1",
  readAclKeys: ["space:space_1"],
  signal,
});
// 按租约、正文/策略目标、summary 和已同步 payload 复核后才能发布。

const retriever = createKnowledgeRetriever({
  client,
  embeddings,
  index: indexOptions,
  resolveScope, // 主库解析 tenant、workspace/document 范围和当前稳定授权键
  authorizeCandidates, // 批量核对当前权限和 activeIndexVersion/正文版本/配置
  verifyEvidence, // 交付前核对权限、版本、原文与定位
});
const evidence = await retriever.retrieve({ query, scope, contextTokenBudget: 4_000, signal });
```

`IndexOptions` 包含 collectionName、embeddingFingerprint、dimensions、metric="cosine"、normalizerVersion、chunkerVersion、targetTokens、maxTokens 和 overlapTokens。建议从 500/800/80 起测；默认以 UTF-8 字节计数作为保守 token 上界。可注入 countTokens；更改 tokenizer 必须更新 chunkerVersion，Embedding 模型/配置更改必须更新 embeddingFingerprint。配置指纹不包含函数或日志回调。应用使用同一锁定配置创建、写入和检索。

`prepareDocumentChunks(source, indexOptions, parsing?)` 支持原有 DocumentSnapshot，以及 `{ format: "markdown" | "html" | "csv", sourceId, content, title? }`。使用真实 RecursiveCharacterTextSplitter，不跨可寻址 Block/Section 拼接。列表只遍历一次；表格以完整表格为一个可定位 Block/Section，优先按行分块并提供表头上下文，长行在预算内继续切分。原生 rowspan/colspan 展开为规范化行列，合并单元格值保留在对应行。Markdown GFM 和 HTML 表格通过成熟 AST 解析。

CSV 使用 csv-parse，支持 UTF-8 BOM、引号内逗号/换行、转义引号、重复表头和空文件；不执行公式。可传 `delimiter`，以及 `hasHeader: false` 自动生成列名。多行单元格在规范化表格中以 `⏎` 表示。CSV 的 Markdown/HTML 图片标记也进入相同图片处理流程。

需要规范化全文或稳定原文读取时使用 `prepareDocument`：

```ts
import { prepareDocument } from "@zhishu/rag";

const prepared = await prepareDocument(
  { format: "html", sourceId: "doc_import", content: html },
  indexOptions,
  {
    signal,
    imageStorage: {
      // assetId、外部 URL、相对路径均由宿主授权并读取；包不自动请求网络或本地文件。
      readImage: async ({ sourceId, assetId, reference, signal }) => {
        return authorizedImageReader({ sourceId, assetId, reference, signal });
        // => { bytes: Uint8Array, mediaType?: string }
      },
      // 在此使用阿里云 OSS、S3、COS、七牛、MinIO 或任意平台 SDK。
      uploadImage: async ({ sourceId, bytes, mediaType, fileName, sha256, signal }) => {
        const object = await yourStorageUpload({
          sourceId,
          bytes,
          mediaType,
          fileName,
          sha256,
          signal,
        });
        return { url: object.stableUrl };
      },
    },
  },
);
// prepared.text：图片已经替换为 URL 的规范化全文。
// prepared.blocks：id、locatorKind、text，供 readSource 按原区间读取。
// prepared.chunks：EvidenceItem[]，图片链接不会在 chunk 中被截断。
// prepared.images：已上传图片的 SHA-256、URL、媒体类型和大小。
```

`ImageStorage` 是公开 TypeScript 接口，不绑定存储 SDK、环境变量、bucket 或凭据。Base64 data URI 可直接提取；其余来源通过 readImage 获取。每次解析按内容 SHA-256 去重上传，检测实际图片类型并限制输入大小、单图/累计字节与图片数量。uploadImage 接收确定的 sha256/fileName，宿主可按租户和内容摘要实现幂等上传。失败或取消不返回成功解析结果；已经上传的对象由宿主记录和清理，包不删除用户对象。上传回调返回稳定的 HTTP(S) URL，也可以是宿主鉴权代理地址；短期签名 URL 不适合作为索引内的持久地址。

图片 URL 只替换解析后的 RAG 文本，原始 DocumentSnapshot 和持久化 assetId 不被修改。原生正文未配置 imageStorage 时沿用 alt 文字；带内嵌图片的导入文档缺少存储接口时明确返回 IMAGE_STORAGE_REQUIRED，不静默丢图。已有 HTTP(S) 图片可在未配置上传时保留原地址。该流程提取图片文件，不执行视觉理解/OCR；Word/PDF 二进制解析需要另行格式适配。

UTF-16 半开区间指向 `prepared.blocks` 的对应规范化文本。原生表格使用表格 blockId，外部文档使用 sectionId；不能再以旧的单元格文本解释新表格区间。内部解析版本已进入配置指纹，旧索引需要重建。上传清单参与派生 snapshotId，平台 URL/图片内容发生变化时必须生成新的索引版本。代码优先按行切分，`onExtractionIssue` 报告无文本/不支持的叶节点。超出安全整数范围的现有 DocumentSnapshot.durableSeq 明确拒绝。

`writeDocumentIndex` 也接受 `{ source, version: { generationId, durableSeq }, parsing, ... }`；外部来源版本由应用提供，durableSeq 是无损十进制字符串。`parsing.imageStorage` 的处理结果直接进入 Embedding 和 Qdrant，不会绕过租户/稳定授权键。返回结果包含 snapshotId 和 images，便于宿主关联规范化来源与上传清单。sourceId 必须由应用绑定到真实授权资源，不能让客户端通过上传文件声明权限。

Qdrant 1.17.1 实测通过。collection 使用 dense Cosine；显式初始化核对已有维度与距离并建立 payload 索引。payload.content 存原文，metadata 存嵌套 locator、版本、摘要和稳定 space/user/document 键，兼容 LangChain QdrantVectorStore 默认载荷。point ID 由 tenant/document/indexVersion/ordinal 确定。写入使用 insert_only，等待每批完成，验证向量数量/维度/有限数值，返回前复核实际 point 的不可变来源与 Embedding 输入摘要。

`updateIndexPolicy` 只向 metadata 子路径写 readAclKeys/aclRevision，以 tenant/document/indexVersion/previousRevision 精确匹配。新旧修订均为无损十进制字符串；旧更新不会覆盖已更新的修订。应用需要枚举并追赶中间修订、核对所有 point 的键/修订与数量后才提交已同步状态。普通成员增删不调用该函数或重新 Embedding，只改变 resolveScope 的查询键。新文档模式必须先由应用统一授权和安全回填，不能从 viewer 回退签发 space 键。

检索先取得 ID、分数和最小版本字段，首轮不读取正文、标题或 ACL 名单。应用批准候选后才批量读取精确 point ID；再次核对字段、摘要、来源与上下文预算后形成 EvidenceBundle。授权键按请求字节拆批、固定 tenant/范围，按 point ID 去重，同分候选通过排除已处理 ID 扩查。候选数、查询调用数与键数量均有硬上限；超限明确报错，空键不调用 Embedding/Qdrant，不降级为无 ACL 过滤。

Scope 和三个授权回调只能由应用在服务端构造。包不把 ACL payload 视为权限事实，不根据用户提交的 spaceId、JWT 旧成员声明或模型输入生成授权键。候选回调必须同时检查 activeIndexVersion、generationId、durableSeq、metadataRevision、配置、删除状态及当前读取权限；aclRevision 仅表示稳定键策略修订。

SDK 的 Embeddings 和 Qdrant 方法没有统一 AbortSignal 参数。应用需给客户端配置有限超时和 provider 的取消机制；包在每个调用边界检查 signal 并抑制取消后的结果，不能撤销已经发送的外部请求或费用。

运行 `pnpm test:ai`，设置 `QDRANT_TEST_URL` 启用真实实例集成。测试使用随机 collection 并在 finally 删除，覆盖与 LangChain QdrantVectorStore 的兼容读取、旧构建晚到、条件策略、租户过滤、旧候选扩查和授权后正文读取。语义模型使用确定性测试 Embeddings；这不代表 Recall@K、生产容量或 2,000 人负载已验收。document_indexes、租约 Worker、tombstone、备份恢复与 SQL 发布条件属于 [app-server 集成设计](../../docs/packages/rag.md)。
