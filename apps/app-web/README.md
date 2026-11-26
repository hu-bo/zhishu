# 知书工作台

React 19、Vite、TanStack Router/Query 和 HeroUI v3 组成工作台。知识库、文档页、AI 助手以及公开分享和问答页面都在此应用。完整联调见 [本地启动](../../README.md#本地启动)，页面和交互边界见 [前端设计](../../docs/apps/app-web.md)。

## 开发

从仓库根目录执行 `pnpm --dir apps/app-web dev`，打开 `http://127.0.0.1:8002`。Vite 开发模式对编辑器和 Chat 等工作区包使用源码别名，修改这些包可直接热更新。Casdoor SDK 仍使用包构建产物，本地启动的服务端依赖构建步骤会一并生成。

可复制 [.env.example](.env.example) 到本目录的 `.env` 调整配置。

| 配置                | 行为                                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `API_PROXY_TARGET`  | Vite dev/preview 的 `/api` 代理目标，默认 `http://127.0.0.1:9010`                                                 |
| `VITE_API_BASE_URL` | 浏览器使用的 API 基础地址。留空时同源访问                                                                         |
| `VITE_AUTH_MODE`    | 留空时开发服务器选择 mock 登录，生产构建选择 Casdoor。联调真实 SSO 可设为 `casdoor`，生产留空或显式设为 `casdoor` |

前缀 `VITE_` 的变量会进入浏览器代码，仅放公开配置。生产同源代理和 WebSocket 配置见 [服务端运行手册](../app-server/README.md#构建和上线)。

| 路由                                   | 入口                       |
| -------------------------------------- | -------------------------- |
| `/spaces`、`/spaces/:workspaceId`      | 空间列表、目录和知识库     |
| `/spaces/:workspaceId/doc/:documentId` | 文档编辑、阅读和协同       |
| `/documents`、`/documents/:documentId` | 文档列表和按文档 ID 定位   |
| `/ai`、`/qa-sites`                     | 助手工作台与问答站点管理   |
| `/share/:shareId`、`/ask/:slug`        | 公开分享与访客问答         |
| `/callback`                            | Casdoor 扫码或授权后的回调 |

## API 与路由生成

服务端 Zod route schema 是 REST 契约来源。Orval 直接读取 [OpenAPI](../app-server/openapi.json)，生成 `src/api/generated/` 中的客户端和类型。TanStack Router 从 `src/routes/` 生成 `src/routeTree.gen.ts`。

```powershell
pnpm --dir apps/app-server openapi:export
pnpm --dir apps/app-web api:generate
pnpm --dir apps/app-web routes:generate
```

OpenAPI 导出使用已构建的工作区依赖，可离线执行。生成前检查工作区改动。虽然 `api:check` 会在检测到漂移时返回非零，它也会写出新的客户端。请求传输与错误转换分别维护在 `src/api/transport.ts` 和 `src/api/api-error.ts`。

## 检查与构建

```powershell
pnpm --filter @zhishu/app-web lint
pnpm --filter @zhishu/app-web test:chat
pnpm --filter @zhishu/app-web typecheck
pnpm --filter '@zhishu/app-web...' build
pnpm --dir apps/app-web preview
```

`typecheck` 与 `build` 会重新生成 API 客户端和路由树。构建输出到 `dist/`，preview 监听 `http://127.0.0.1:4173`。如需用 preview 验证本地协同，将该 origin 加入服务端的 `COLLABORATION_ALLOWED_ORIGINS`，并使用与构建认证模式匹配的服务端。
