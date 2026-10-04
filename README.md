# 知书

在线文档编辑与团队知识库，使用 pnpm workspace、React 19、Tiptap、Fastify、Zod 和 Drizzle/PostgreSQL。普通文档显式保存，协同文档依据服务端持久化回执确认保存。

当前内容格式为 Schema v5，支持五主题提示块、五状态标签和带标签分隔线。普通草稿与协同未确认更新保存到按身份隔离的 IndexedDB；生产页面可离线刷新，联网登录后校验权限和版本再恢复，冲突草稿保留导出。

## Structure

```text
apps/app-server/
  src/                  # app、server、plugins、modules、OpenAPI exporter
  database/             # client、schema、Drizzle config、migrations
apps/app-web/           # React 工作台、目录、搜索、权限与文档编辑
packages/editor-*/      # 可独立消费的编辑器能力、React 适配与 UI
packages/document-contracts/ # 内容契约与合法预设文档
examples/               # 编辑器与协同消费示例
deploy/compose.yaml     # 本地 PostgreSQL 与可选 S3 开发存储
```

## Getting Started

需要 Node.js 20+、pnpm 9 和 Docker。复制根目录 `.env.example` 为 `.env`；server 与 Drizzle 自动读取同一文件，已有环境变量优先。

```sh
pnpm install
pnpm compose:up
pnpm db:migrate
pnpm dev
```

附件存储已预设为 MinIO `http://minio.8and1.cn:80`（HTTP、80 端口）。在根目录 `.env` 填写 `ASSET_STORAGE_ACCESS_KEY_ID` 和 `ASSET_STORAGE_SECRET_ACCESS_KEY`；当前不提供或写入示例密钥。该地址暂不可用，`ASSET_STORAGE_CHECK_ON_STARTUP=false` 跳过启动存储检查，`ASSET_STORAGE_AUTO_CREATE_BUCKET=false` 禁止自动创建桶；须由存储管理员准备私有桶。未填密钥时开发环境仍可启动，附件接口返回可理解的不可用反馈。此次交付未连接或测试 MinIO。生产环境仍强制要求完整凭据配置。

需要独立本地存储时可使用可选 Garage 配置与 `pnpm compose:up:storage`；它只用于本地开发。

API 默认地址为 http://localhost:3000，liveness 为 `/health/live`，readiness 为 `/health/ready`，Swagger UI 为 `/documentation`。
正常启动先确认数据库可用；migration 单独执行。
`/api/projects/` 提供 list/create，`/api/projects/:id` 提供 get/patch/delete；文档 API 提供创建、授权元数据读取和 owner-managed ACL。list 支持 limit（默认 20，最大 100）。API 需要 Bearer token；mock 登录方式见下文。运行 `pnpm build && pnpm start` 启动 `apps/app-server/dist/src/server.js`。

## Mock Authentication

设置 `NODE_ENV=development`、`AUTH_MODE=mock` 后，`POST /api/auth/mock/login` 会为固定测试用户签发一个 8 小时的 Bearer token。使用该 token 调用 `GET /api/auth/me` 或 `/api/projects/`；`POST /api/auth/logout` 会立即撤销当前 token。通过 `MOCK_AUTH_TOKEN_TTL_SECONDS` 可将有效期设置为 60 到 86400 秒。

mock 会话保存在当前服务进程内，重启后需要重新登录。`NODE_ENV=production` 禁止使用 mock。宿主可设置 `AUTH_MODE=external` 并向 `buildApp` 注入 `PrincipalAuthenticator`；当前默认 `server.ts` 入口尚未接入具体 SSO provider，external 模式会拒绝启动，须由宿主完成身份适配后上线。

## Formatting and Checks

```sh
pnpm format
pnpm format:check
pnpm check
```

Prettier 统一人工代码与文档，跳过 lockfile、generated migration、OpenAPI 和 dist。check 包含格式、ESLint、类型、build 和离线 OpenAPI 导出，不需要数据库。

## Editor Examples

独立编辑器示例可运行 `pnpm --filter @zhishu/editor-consumer-example dev`，默认端口 5180。`/` 展示默认/自定义主题与节点视图，`/lifecycle` 验证订阅、双实例、局部重试和本地模拟宿主取消边界；`/bare.html` 完全不加载 editor-ui 或其 CSS，仅由宿主按钮组合公开命令。`/collaboration` 连接真实 API/WebSocket，需要运行对应 QA 后端。

## Database

本地 Compose 的 trust authentication 仅绑定 localhost。
指定指向临时数据库的 `DATABASE_URL` 后，可运行 `pnpm db:migrate` 和 `pnpm smoke`，
统一验证 health、OpenAPI、CRUD、tenant 隔离、文档 ACL、输入校验和错误响应；smoke 创建并清理自己的 project 和 document。

`pnpm smoke:knowledge` 要求数据库名包含 `qa`、`test` 或 `smoke`，覆盖工作区/目录移动与层级限制、ACL/租户隔离、图标标签修订、正文检索、历史恢复及预设幂等初始化。脚本创建并清理独立测试租户，显式禁用对象存储，不连接 MinIO。

`pnpm --filter @zhishu/collaboration-consumer-example smoke:performance` 需先构建依赖、启动隔离 QA 后端，并显式设置 `PERFORMANCE_QA=true` 与 loopback `API_URL`（默认 `http://127.0.0.1:3100`）。测试 1000 块/约 1 MB、20 个真实会话、WebSocket 双向各 50ms 延迟下的远端 Y.Doc 到达和持久化回执，超出 P95 500ms/2s 目标退出失败；自行清理测试文档和连接。它不测试 MinIO，也不代表浏览器绘制或 20 个不同身份的完整基线。

默认编辑首段；设置 `PERFORMANCE_POSITION_MATRIX=true` 增加文档开头、中间与末尾的位置矩阵。目前首段抽样已通过，扩展矩阵仍超出远端延迟目标，完整性能门槛保持待验。

`pnpm db:generate` 使用 apps/app-server/database/drizzle.config.ts，输出到 database/migrations。
`pnpm db:migrate` 使用相同配置执行 migration。

## OpenAPI

```sh
pnpm openapi:export
pnpm openapi:export ../web/openapi.json
```

默认输出 apps/app-server/openapi.json；相对参数基于 server package root。
源码和编译后的 exporter 使用同一路径规则。导出不依赖 .env 或数据库连接，供前端 Orval 使用。
