# 知书服务端

Fastify 提供 HTTP API，Hocuspocus 另开 WebSocket 监听。PostgreSQL 保存文档代次、Yjs 更新、授权关系和业务数据。模块入口在 [app.ts](src/app.ts)，进程启动与关闭在 [server.ts](src/server.ts)。本地联调见 [快速开始](../../README.md#本地启动)，业务边界见 [服务端设计](../../docs/apps/app-server.md)。

## 配置

服务端读取本目录的 `.env`，进程中已有的环境变量优先。通过 `pnpm --dir apps/app-server` 运行 Drizzle 命令时，在终端显式提供 `DATABASE_URL`，并确认它与服务端连接的是同一个目标库。完整运行时配置见 [config.ts](src/config.ts)，本地示例见 [.env.example](.env.example)。

| 配置                                                                          | 用途                                                                                             |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `NODE_ENV`、`DATABASE_URL`                                                    | 运行环境与 PostgreSQL 连接。上线前备份，显式执行 migration                                       |
| `AUTH_MODE`                                                                   | 本地开发用 `mock`，生产用 `external`                                                             |
| `AUTH_SERVICE_URL`、`AUTH_SERVICE_TOKEN_TRANSPORT`、`AUTH_SERVICE_TIMEOUT_MS` | external 模式使用平台 Auth Service 复核 Bearer token。传递方式默认 `query`，超时默认 5 秒        |
| `HOST`、`PORT`                                                                | HTTP API 监听地址，默认 `0.0.0.0:9010`                                                           |
| `COLLABORATION_HOST`、`COLLABORATION_PORT`                                    | WebSocket 监听地址，默认 `0.0.0.0:9011`                                                          |
| `COLLABORATION_PUBLIC_URL`、`COLLABORATION_ALLOWED_ORIGINS`                   | 浏览器收到的 WebSocket 地址、允许握手的页面 origin 列表。生产使用 `wss://` 与显式的非回环 origin |
| `COLLABORATION_TOKEN_SECRET`、`QA_VISITOR_COOKIE_SECRET`                      | 分别签发协同凭据和公开问答访客凭据。生产配置独立随机密钥，每个至少 32 字符                       |
| `APP_PUBLIC_URL`                                                              | 生成正文来源链接使用的应用地址。生产填写浏览器访问的站点地址                                     |
| `LOG_LEVEL`、`LOG_DIR`                                                        | 日志级别与目录。生产为日志目录准备写权限                                                         |

### 登录

mock 模式用 `POST /api/auth/mock/login` 签发进程内的 8 小时 token，`GET /api/auth/me` 查询身份，`POST /api/auth/logout` 撤销当前 token。重启后重新登录。生产装配内置 Auth Service 适配器。前端通过平台 SDK 完成授权码交换与刷新，服务端通过 Auth Service 的 `/api/me` 验证身份，使用 Casdoor 的组织作为租户隔离域。需为 `zhishu` 应用登记前端 origin 与 `/callback` 回调。文档权限由 [授权规则](../../docs/authorization.md) 决定。

### 附件对象存储

生产必须设置 `ASSET_STORAGE_ENDPOINT`、`ASSET_STORAGE_ACCESS_KEY_ID` 和 `ASSET_STORAGE_SECRET_ACCESS_KEY`，并准备 `ASSET_STORAGE_BUCKET` 指定的私有 S3 兼容桶，默认桶名为 `zhishu-private-assets`。开发可省略存储配置，附件功能会报告不可用。独立本地存储可用 `pnpm compose:up:storage` 启动 [Garage](../../deploy/compose.yaml)。本地 Garage 的桶与开发凭据由 Compose 定义。

- 浏览器通过预签名 URL 直传。设置浏览器可达的 `ASSET_STORAGE_PUBLIC_ENDPOINT`，并在桶 CORS 放行前端 origin、`PUT`、`Content-Type` 和 `x-amz-meta-sha256`。HTTPS 页面使用 HTTPS 存储地址。
- `ASSET_STORAGE_REGION` 可省略，由客户端查询桶区域。显式设置时必须匹配桶所在区域。出现 `AuthorizationHeaderMalformed` 时检查区域和签名地址。
- `ASSET_ACCESS_URL_TTL_SECONDS` 默认 60 秒。设为 0 会签发无有效期的未签名地址，读取依赖桶允许匿名访问。私有桶使用正数。

## 构建和上线

以下命令从仓库根目录运行。先准备对应环境的后端配置和前端公开配置，在迁移进程中提供目标库的 `DATABASE_URL`。

```powershell
pnpm --filter '@zhishu/app-server...' --filter '@zhishu/app-web...' build
node apps/app-server/dist/src/scripts/startup-probe.js
pnpm --dir apps/app-server db:migrate
pnpm --dir apps/app-server start
```

启动探针检查环境变量和应用装配。正常启动检查数据库并取得协同 owner 锁。同一数据库只允许一个协同 owner，切换版本时先停止旧 owner，按需执行迁移，再启动新服务。部署时保留 workspace 依赖、锁文件和构建产物。服务入口为 `dist/src/server.js`。

- 静态服务托管 `apps/app-web/dist`，将 `/api/*` 转发至 HTTP 服务，为前端页面配置 SPA 回退。SSE 路径关闭代理缓冲并保留流式响应。
- 将 `COLLABORATION_PUBLIC_URL` 转发至 WebSocket 端口，转发升级请求并保留浏览器 Origin。新建文档后用两个会话检查实时同步和已保存状态。
- `/health/live` 检查 HTTP 服务，`/health/ready` 查询数据库和投影队列计数。配置 `METRICS_BEARER_TOKEN` 后，使用该 token 读取 `/metrics`。Swagger UI 可通过 `SWAGGER_UI_ENABLED` 关闭。

| 现象                     | 先检查                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| Vite 代理报连接失败      | API 是否启动、`PORT` 与 `API_PROXY_TARGET` 是否一致                                           |
| 能打开工作台，正文连不上 | 协同端口、对外 WS/WSS 地址、升级代理和允许的浏览器 origin                                     |
| 切换版本时协同启动失败   | 上一个 owner 是否已释放 PostgreSQL 协同锁                                                     |
| 上传报告预检失败         | 存储 public endpoint、HTTPS 和桶 CORS                                                         |
| 登录回调失败             | 前端认证模式、Auth Service 可达性、回调登记和 CORS                                            |
| 资料问答提示索引不可用   | Embedding 配置、Qdrant 集合和索引状态。见 [知识索引排错](../../docs/packages/rag.md#索引排错) |

## 开发与验证

修改 Drizzle schema 后用 `pnpm --dir apps/app-server db:generate` 生成迁移。修改 API 的 Zod route schema 后，按前端指南重导契约并生成客户端。见 [API 与路由生成](../app-web/README.md#api-与路由生成)。

| 场景                         | 在仓库根目录运行                                                                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 模块边界、离线 OpenAPI       | `pnpm --dir apps/app-server test:architecture`                                                                                                                         |
| 授权、空间与身份             | `pnpm --dir apps/app-server test:authorization`。真实 PostgreSQL 入口见 [授权验收](../../docs/authorization.md#迁移与验收)                                             |
| 文档持久化                   | `pnpm --dir apps/app-server test:documents`                                                                                                                            |
| AI 契约、运行时与界面模型    | `pnpm test:ai`，执行前构建相关包                                                                                                                                       |
| 统一助手 HTTP/SSE 与真实协同 | `pnpm --dir apps/app-server smoke:ai`。显式设置 `DATABASE_URL` 指向单独创建的 `zhishu_ai_test_*` 可丢弃库。脚本会执行 migration 并写入测试数据，模型和检索使用 fixture |
| 工作区、目录和文档业务       | `pnpm --dir apps/app-server smoke:knowledge`。先迁移可丢弃库，通过进程环境设置 `DATABASE_URL`，库名含 `qa`、`test` 或 `smoke`                                          |

根目录 `pnpm smoke` 仍包含旧助手路由断言。统一助手使用上表的 `smoke:ai` 验证。其他脚本入口见 [package.json](package.json)。数据库和存储 smoke 使用专用环境，运行前核对脚本的环境变量和清理范围。
