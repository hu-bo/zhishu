# 知书

知书是在线文档编辑与团队知识库。工作台支持文档协同、空间与目录、搜索、版本和分享。正文通过 Yjs/Hocuspocus 同步，收到服务端持久化回执后显示已保存。当前内容格式见 [文档内容契约](docs/packages/document-contracts.md#当前格式schema-v7)。

## 本地启动

需要 Node.js 24 LTS、pnpm 9.15.4，以及用于本地 PostgreSQL 的 Docker Compose。以下命令从仓库根目录运行。已有 PostgreSQL 时，可直接使用自己的开发库。

先安装依赖并启动 PostgreSQL。首次配置时，将服务端的 `.env.example` 复制为同目录的 `.env`。示例文件已对齐浏览器、API 和协同端口。

```powershell
pnpm install --frozen-lockfile
pnpm compose:up
Copy-Item apps/app-server/.env.example apps/app-server/.env
$env:DATABASE_URL = 'postgresql://postgres@127.0.0.1:5432/app'
pnpm --filter '@zhishu/app-server^...' build
pnpm --dir apps/app-server db:migrate
pnpm --dir apps/app-server dev
```

另开终端启动前端。打开 `http://127.0.0.1:8002`，开发服务器会用默认 mock 用户自动登录。

```powershell
pnpm --dir apps/app-web dev
```

| 入口              | 本地地址                                    |
| ----------------- | ------------------------------------------- |
| 工作台            | `http://127.0.0.1:8002`                     |
| API 与 Swagger UI | `http://127.0.0.1:9010` 与 `/documentation` |
| HTTP 探针         | `/health/live`、`/health/ready`             |
| 协同 WebSocket    | `ws://127.0.0.1:9011`                       |

修改 API 端口时同步修改前端的 `API_PROXY_TARGET`。修改协同端口或前端访问来源时，同步检查 `COLLABORATION_PUBLIC_URL` 和 `COLLABORATION_ALLOWED_ORIGINS`。生产配置、附件和排错见 [服务端运行手册](apps/app-server/README.md)。

## AI 助手

工作台 `/ai` 用同一助手会话完成问答、调研和创作。用户明确创建草稿后，会话与文档绑定并展开编辑器。资料问答依赖 Embedding 与 Qdrant，联网研究和图片生成各有独立配置。见 [助手与对外问答](docs/apps/ai-assistant-and-public-qa.md#当前入口) 和 [知识索引](docs/packages/rag.md#启用知识索引)。

## 仓库导航

- `apps/app-web` 是 React 工作台与公开页面。见 [前端开发指南](apps/app-web/README.md)。
- `apps/app-server` 是 Fastify API、协同服务、PostgreSQL schema 与 migrations。见 [服务端运行手册](apps/app-server/README.md)。
- `packages` 包含内容契约、编辑器、Chat、AI 与检索库。按职责进入 [文档地图](docs/README.md)。
- `examples` 是包的独立消费与集成验证入口。见 [消费示例](examples/README.md)。
