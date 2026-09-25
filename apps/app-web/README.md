# Workflow Web

Nova Workflow 的前端应用：工作流列表、分页、详情、新建、编辑和删除。调用已有后端的工作流基础信息 API。

## Structure

```text
apps/workflow-web/
  src/
    main.tsx
    app/                       # shell、providers、router、QueryClient、route feedback
    routes/                    # TanStack file routes
      __root.tsx
      index.tsx
      workflows/
        index.tsx
        new.tsx
        $workflowId.tsx
    routeTree.gen.ts           # 自动生成，不手改
    api/
      generated/               # Orval client 与 models，不手改
      api-error.ts
      transport.ts
    features/workflows/
      workflow-list.page.tsx
      workflow-detail.page.tsx
      workflow-create.page.tsx
      workflow-form.tsx
      workflow-form.schema.ts
      workflow-search.schema.ts
      workflow.queries.ts
    components/ui/             # shadcn Base UI button/input/textarea/dialog
    lib/cn.ts
    styles/globals.css
    vite-env.d.ts
  scripts/api-check.ts
  components.json
  orval.config.ts
  tsr.config.json
  vite.config.ts
  tsconfig*.json
  eslint.config.mjs
  .env.example
  index.html
  package.json
```

UI 暂无跨组件客户端状态，不创建空 Zustand store；远程数据只存入 TanStack Query。表单草稿由 React Hook Form 管理，编辑表单打开时初始化，后台刷新不会覆盖未保存输入。

## Development

在仓库根目录运行（Node.js 24、pnpm 9.15.9）：

```powershell
pnpm install
pnpm dev:web
```

打开 [Workflow Web](http://127.0.0.1:5173)。开发默认将 `/api` 代理到 `http://127.0.0.1:3000`。前端可以独立启动；后端不可用时展示错误与重试状态，不返回虚构数据。

完整联调请按根目录 README 配置 PostgreSQL 并执行 migration，然后使用 `pnpm dev` 同时启动前后端。当前页面管理基础信息；AST 编辑与工作流执行属于后续功能。

可选复制本目录 `.env.example` 为 `.env`。`API_PROXY_TARGET` 只影响 Vite dev/preview 代理；`VITE_API_BASE_URL` 是浏览器公开配置，默认空字符串用于同源 `/api`，不要加入 secret。跨域 API 需要后端额外配置 CORS；当前默认同源。

## API Contract

Orval 直接读取 `../workflow-server/openapi.json`，避免复制 contract。前端类型、请求、Query options、mutation hooks 全部自动生成。

从仓库根目录执行：

```powershell
pnpm api:generate
pnpm api:check
```

`api:generate` 先导出实际后端 routes，再生成前端代码，无需数据库。`api:check` 比较重新生成前后的所有文件，覆盖内容修改、新增与删除，发生漂移返回非零并保留新结果；即使仓库还没初始化 Git 也能使用。

请求通过统一 fetch transport 传递 AbortSignal，处理 JSON、204、网络错误与后端 error envelope。错误转换为安全中文提示；slug 冲突显示在对应表单字段。写操作不自动重试。删除使用 Base UI 确认弹窗。

## Validation and Build

在仓库根目录运行：

```powershell
pnpm --filter @nova-workflow/workflow-web lint
pnpm --filter @nova-workflow/workflow-web format:check
pnpm --filter @nova-workflow/workflow-web typecheck
pnpm --filter @nova-workflow/workflow-web build
pnpm --filter @nova-workflow/workflow-web preview
```

typecheck/build 会先生成 API client 与 route tree。`format` 可统一格式化人工维护文件；自动生成文件不手动格式化。构建产物为本目录 `dist/`，preview 默认在 `http://127.0.0.1:4173`，仅用于本地预览。

生产部署将 `/api/*` 反向代理到 workflow-server；静态站点对其他不存在的资源路径回退到 `index.html`，确保 `/workflows/:id` 可直接访问与刷新。Vite 开发代理不会被打包进生产文件。

## Scaffold Verification

已通过安装与 lockfile 校验、API generation/check、lint、format check、typecheck 和生产构建。使用 Playwright 检查了后端不可用提示，以及列表、新建、编辑、删除、必填校验、slug 冲突、分页 URL 刷新恢复、390px 窄屏、弹窗 Tab/Escape 与焦点返回。

CRUD 浏览器检查使用仅限该测试会话的网络拦截 fixture，未写入真实数据库，也不包含在应用构建中。真实 PostgreSQL 联调仍需启动数据库和后端后执行。截图与本地验证材料位于仓库 `output/playwright/`，已忽略版本管理。

## UI Sources

组件由 shadcn CLI 4.21.0 的 `base-nova` registry 生成，使用 `@base-ui/react`；项目统一改为导入本地 `@/lib/cn`。视觉 token 集中在 `styles/globals.css`。

参考：[shadcn CLI](https://ui.shadcn.com/docs/cli)、[TanStack Router Vite](https://tanstack.com/router/latest/docs/installation/with-vite)、[Orval Custom Client](https://orval.dev/docs/guides/custom-client/)。
