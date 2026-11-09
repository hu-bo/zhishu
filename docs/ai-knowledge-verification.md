# AI 写作与知识问答验收（2026-10-30）

完整真实文本流程已通过：`qwen3.8-flash` 生成文章并采纳落库 → `qwen3.7-text-embedding-flash` 自动生成 1024 维向量 → Qdrant 持久化和检索 → 真实模型回答指定文档或空间中的问题，并给出逐字原文引用。独立向量密钥更新后，`https://maas.qianwenaiapi.com/compatible-mode/v1/embeddings` 实测返回 HTTP 200。

## 本轮修复

- 写作服务使用 Cordis `provide` 注册凭据上下文，声明配置的 reasoning effort，并将 adaptive thinking 传给 Anthropic 兼容适配器；原实现分别在初始化和首次模型请求前失败。
- DSH 保留供应商的稳定错误码；不向产品界面暴露原始供应商错误正文。
- 新增 `document_indexes`、租约领取、当前正文/元数据条件发布、失败退避重试、旧构建清理和删除 tombstone。索引从已追上 durable head 的正文投影生成，不竞争正文 outbox 消费者。
- `AI_EMBEDDING_*` 配置经 `OpenAIEmbeddings` 调用真实接口，以 float 格式验证向量数量和维度，使用 Qdrant 存储及召回。
- grounded 问答可选择文档、当前空间或全部可访问资料。查询键来自服务端当前文档 `read`/`ai` 授权，候选和最终证据再次复核版本及权限。普通 ACL 变更不重建向量。
- 前端显示就绪/处理中/失败状态，支持范围切换、追问、展开逐字引用和打开来源文档；各范围的草稿与历史独立缓存。
- 浏览器检查发现拒绝非法协同 Origin 会触发 Hocuspocus 4.7 HTTP upgrade listener 未处理异常并退出进程，已改为 HTTP 403 和官方空 rejection 拦截方式。

## 实际验证范围

最终执行 `pnpm --dir apps/app-server smoke:ai-knowledge`，报告模式为 `real-models-postgres-qdrant`，结果为 `passed`。没有注入确定性模型或向量，所有写作、文档分块 Embedding、query Embedding 和答案生成都使用真实服务。

| 验收项               | 实测证据                                                                         |
| -------------------- | -------------------------------------------------------------------------------- |
| 写作与持久化         | 生成 15 个正文块；采纳后 durableSeq=1；重复采纳不重复写入                        |
| 自动向量索引         | 1024 维；Qdrant 共 16 个 points，包含 15 块目标正文与 1 块其他空间的相似对照资料 |
| 指定文档问答         | 正确回答 ZK-7429、17%、43 小时，附 3 条逐字引用；10,466 ms                       |
| 空间问答与后半段召回 | 正确回答“松塔蓝鲸”和“林澈”，附 2 条引用；7,945 ms                                |
| 范围隔离             | 其他可读空间的相似资料已完成索引，目标空间回答仍排除“紫电玉兔”和 99 小时         |
| 多轮追问             | 沿空间问答历史正确回答 43 小时；5,563 ms                                         |
| 无依据识别           | “火星上市年份”返回 insufficient-evidence，无编造年份；5,283 ms                   |
| 权限隔离             | 无权限身份无法召回正文或读取他人问答；单篇授权后可问答，撤权后历史读取被拒绝     |
| 正文变更与重建       | 修改口令后自动发布新索引版本；回答为“银杏海豚”，排除旧口令；6,355 ms             |
| 删除与旧索引排除     | 删除后空间问答返回 insufficient-evidence，未继续使用旧向量正文                   |

以上耗时是本次单样本观测，包含检索和生成，不代表 P95 或容量结论。真实供应商测试没有人为注入故障；Embedding 401 可见性、失败后恢复、ACL 变更不调用 Embedding 的计数断言由下面的确定性协议测试补充验证。

前一次 `--writing-only` 测试也已通过真实写作和直接正文问答；最终验收进一步覆盖了真实向量检索，不再仅依赖直接上下文。

确定性 provider + 真实 PostgreSQL/Qdrant 验收覆盖：自动索引、文档/空间范围、后半段事实、原文引用、多轮追问、无依据回答、其他身份隔离、单篇分享与撤权、ACL 更新不重建向量、Embedding 401 失败状态、旧索引拒用、正文变更自动重建、服务恢复后重试，以及删除后立即排除旧片段。这些结果证明数据链路，不能代替真实 Embedding 的语义召回质量验收。

配置排查中的历史结果与最终成功结果：

| 地址                                                                        | 结果                                    |
| --------------------------------------------------------------------------- | --------------------------------------- |
| 已配置 Token Plan 主机的 `/compatible-mode/v1/embeddings`                   | HTTP 404                                |
| `token-plan.maas.qianwenaiapi.com/compatible-mode/v1/models`                | HTTP 200，列表无所配置的 Embedding 模型 |
| 同主机 `/compatible-mode/v1/embeddings`                                     | HTTP 404                                |
| 同主机原生 text-embedding 接口                                              | HTTP 404，`Model not exist`             |
| 百炼通用兼容 Embedding 地址 + 当前 Token Plan 密钥                          | HTTP 401，`invalid_api_key`             |
| 新配置 `maas.qianwenaiapi.com/compatible-mode/v1/embeddings` + 独立向量密钥 | HTTP 401，`invalid_api_key`             |
| 新配置同主机原生 text-embedding 接口 + 独立向量密钥                         | HTTP 401，`InvalidApiKey`               |
| 更新完整独立密钥后，`maas.qianwenaiapi.com/compatible-mode/v1/embeddings`   | HTTP 200，1024 维有限浮点向量           |

## 配置与运行

`.env` 中保留写作配置，额外设置：

```dotenv
AI_EMBEDDING_MODEL=qwen3.7-text-embedding-flash
AI_EMBEDDING_API_KEY=<有此模型调用权限的服务密钥>
AI_EMBEDDING_BASE_URL=https://maas.qianwenaiapi.com/compatible-mode/v1
AI_EMBEDDING_DIMENSIONS=1024
AI_EMBEDDING_BATCH_SIZE=10
QDRANT_URL=http://127.0.0.1:6333
QDRANT_COLLECTION=zhishu_documents
```

先执行 `pnpm compose:up:ai`、`pnpm --dir apps/app-server db:migrate`、`pnpm --dir apps/app-server ai:setup`，再启动服务。迁移和 collection 初始化均为显式操作，普通问答请求不会创建 collection。正文保存后自动排队向量化，无需显式保存或逐篇点击索引。

Qdrant 集合丢失后，重新初始化会将对应 SQL 发布指纹置为待重建；从备份恢复到旧集合时执行 `pnpm --dir apps/app-server ai:setup --rebuild`，显式重建全部文档索引。

阿里云的 [Embedding API 文档](https://help.aliyun.com/en/model-studio/text-embedding-synchronous-api) 说明兼容地址、可用维度与批大小；端点和密钥应属于实际支持该模型的服务。

独立验收脚本只操作显式提供的测试 PostgreSQL，在随机 `zhishu_ai_test_*` 数据库和随机 Qdrant collection 中运行，结束后删除测试数据，不连接项目 `DATABASE_URL`。

```powershell
$env:AI_TEST_ADMIN_DATABASE_URL='postgresql://postgres@127.0.0.1:5432/postgres'
$env:QDRANT_TEST_URL='http://127.0.0.1:6333'
pnpm --dir apps/app-server smoke:ai-knowledge                 # 真实写作 + Embedding + 问答，会消耗模型额度
pnpm --dir apps/app-server smoke:ai-knowledge --fixtures      # 确定性协议测试，仍使用真实 PostgreSQL/Qdrant
pnpm --dir apps/app-server smoke:ai-knowledge --writing-only  # 真实写作与直接正文问答，不声称通过向量验收
```

运行报告输出到 `output/qa/ai-knowledge-live.json`、`ai-knowledge-fixtures.json` 或 `ai-writing-live.json`。`--fixtures --serve` 在通过验收后保留临时服务供浏览器检查，Ctrl+C 清理数据。

本轮没有实施 space/user 继承权限迁移、大规模容量测试、混合检索/重排或图片 OCR；含私有图片的索引仍需要接入宿主图片存储适配器。通过结论适用于本次真实文本样本及上述流程，不扩大为任意语料的召回率或生产容量承诺。项目库没有执行迁移；本轮迁移、模型调用、协同和索引验收均使用隔离测试数据库与 collection，结束后已清理测试数据。
