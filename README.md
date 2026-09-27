# React Fastify Template

Fastify + Zod + Drizzle/PostgreSQL 后端模板，使用 pnpm workspace。目前尚未包含 React 前端。

## Structure

```text
apps/app-server/
  src/                  # app、server、plugins、modules、OpenAPI exporter
  database/             # client、schema、Drizzle config、migrations
deploy/compose.yaml     # 本地 PostgreSQL
```

## Getting Started

需要 Node.js 20+、pnpm 9 和 Docker。复制根目录 `.env.example` 为 `.env`；server 与 Drizzle 自动读取同一文件，已有环境变量优先。

```sh
pnpm install
pnpm compose:up
pnpm db:migrate
pnpm dev
```

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

## Database

本地 Compose 的 trust authentication 仅绑定 localhost。
指定指向临时数据库的 `DATABASE_URL` 后，可运行 `pnpm db:migrate` 和 `pnpm smoke`，
统一验证 health、OpenAPI、CRUD、tenant 隔离、文档 ACL、输入校验和错误响应；smoke 创建并清理自己的 project 和 document。

`pnpm db:generate` 使用 apps/app-server/database/drizzle.config.ts，输出到 database/migrations。
`pnpm db:migrate` 使用相同配置执行 migration。

## OpenAPI

```sh
pnpm openapi:export
pnpm openapi:export ../web/openapi.json
```

默认输出 apps/app-server/openapi.json；相对参数基于 server package root。
源码和编译后的 exporter 使用同一路径规则。导出不依赖 .env 或数据库连接，供前端 Orval 使用。
