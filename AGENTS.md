# 知书仓库协作指南

知书面向在线文档编辑与团队知识库管理，追求现代极简、适合持续写作与阅读的生产级体验。吸收 Notion、Linear、Slite 的信息层级与交互质感，保留知书名称与中文产品文案。

## 工作方式

- 开工先看 `git status --short` 和适用的 `AGENTS.md`。保留已有改动，只编辑任务涉及的文件；交付前检查自己的 diff。
- 用 `rg` / `rg --files` 定位入口、现有实现、调用方和测试。先查对应 workspace，按需扩到依赖方；默认跳过 `node_modules/`、`dist/`、生成代码、构建产物、`output/` 和 `submodule/`。
- 批量重构先用语法树或结构化规则圈定候选，再逐处确认语义。独立读取和搜索可以并行，修改、生成和验证按依赖顺序进行。
- 遇到局部缺陷，从正常入口追到负责该行为的模块，在源头修复。修改公共行为前核对调用方、已有数据、兼容要求和失败路径。
- 设计文档从 [文档地图](docs/README.md) 进入，按任务读取对应 app/package 文档。区分设计目标与已实现能力，完成情况以当前源码、实际链路和验证结果为准。

## 代码要求

- 选择能完整解决问题的最小改动，沿用现有类型、函数、组件和模块边界。只有存在实际复用或清晰职责时，才提取 helper、公共模块或抽象层。
- 禁止新增嵌套三元。简单二选一可用三元；同一状态对应的文案、图标和样式放在同一张表，用 `satisfies Record<状态类型, 配置类型>` 检查覆盖。带优先级的分支用 guard clause、`if` 或 `switch`，保留判断顺序和兜底行为。
- 每份业务事实保留一个来源。从现有数据派生值，避免重复状态、平行类型和只转发参数的包装。命名写清业务含义，注释只解释约束或原因。
- 输入在边界校验，内部使用明确类型和错误处理。禁止用 `any`、随意断言或关闭 lint 绕过类型问题；错误响应和日志不得泄露密钥、token 或内部敏感数据。
- 工程使用 pnpm workspace。前端沿用 React、TypeScript、Vite、Tailwind CSS、TanStack Router/Query、HeroUI v3 和 Orval；后端沿用 Fastify、Zod、Drizzle/PostgreSQL，不因局部任务替换技术栈。
- 保持 diff 聚焦。依赖升级、全仓格式化、无关重命名和顺手清理单独处理。

## 从哪里找

| 改动                           | 入口与约束                                                                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 产品页面、文档、知识库与路由   | `apps/app-web/src/features/`、`apps/app-web/src/routes/`；应用外壳在 `src/app/`                                                                                                                              |
| 应用控件、主题与布局           | `apps/app-web/src/components/`、`apps/app-web/src/styles/`；见 [界面设计规范](docs/design-system.md)                                                                                                         |
| 编辑命令、扩展、转换与能力判断 | `packages/editor-core/`；React 生命周期、订阅、宿主服务与 NodeView 适配在 `packages/editor-react/`；通用布局与交互在 `packages/editor-ui/`                                                                   |
| 内容契约、校验与版本兼容       | `packages/document-contracts/`；新增节点、Mark 或持久化属性从这里核对                                                                                                                                        |
| 协同、保存回执与离线恢复       | `packages/editor-collaboration/`、`apps/app-server/src/modules/collaboration/`、`apps/app-web/src/features/offline/`                                                                                         |
| API、业务与持久化              | `apps/app-server/src/modules/`；数据库定义与 migration 在 `apps/app-server/database/`                                                                                                                        |
| 身份、权限、空间与目录         | 服务端 `identity/`、`authorization/`、`workspaces/`、`catalogs/`、`knowledge/` 等模块；见 [授权规则](docs/authorization.md)                                                                                  |
| Chat 展示、协议与 AI 写作      | `packages/chat-ui/`、`packages/chat-contracts/`、`packages/ai-contracts/`、`packages/dsh-agent/`、`packages/ai-plugins/`；应用接入在前端 `components/writing-chat/`、`features/ai/` 与服务端 `writing-chat/` |
| RAG 与现有 AI 运行时           | `packages/rag/`、`packages/ai-runtime/` 与服务端 `rag/`、`ai/`；从实际调用方追踪，不混用写作和问答链路                                                                                                       |
| 独立消费、部署与维护脚本       | `examples/`、`deploy/compose.yaml`、`apps/app-server/src/scripts/`；根目录 `scripts/` 负责跨包检查                                                                                                           |

表中的服务端模块路径均相对于 `apps/app-server/src/modules/`，前端路径均相对于 `apps/app-web/src/`。

## 架构与数据边界

- 编辑器缺失的通用能力先补到对应 package，再由应用打通业务。包不依赖 `apps/*`、应用路由、全局 store 或业务数据库；跨包通过 `package.json` 的公开 exports 消费，不深引其他包的私有 `src`。
- 应用负责工作区、文档树、身份、权限、搜索、持久化、附件、分享与版本，通过公开 API、主题变量和插槽组合编辑器。协同适配保持独立，不内置知书的用户系统或权限策略。
- 后端 feature 在模块内组装 repository 与 service；route 负责协议与校验，service 编排业务和事务，SQL 留在 repository 或已有持久化层。业务层不依赖 Fastify，跨模块优先走公开入口，domain-error 由根错误处理器映射。
- 权限以服务端当前授权为准，不能用前端按钮、Awareness、缓存成员关系或模型输入代替判权。涉及授权和正文并发写入时，遵守现有事务锁顺序、事务内复核与撤权机制，详见 [授权规则](docs/authorization.md)。
- 新节点、Mark 或持久化属性同步核对内容契约、运行时校验、转换、Schema 版本与历史兼容；按需补齐服务端投影和协同支持。覆盖保存重开、历史读取、导入导出，不能只增加 React NodeView。
- `blockId` 是内容定位的稳定身份。大纲、评论、引用和结构操作复用现有定位规则，适配重复标题、多实例与并发修改，不以标题文本或数组下标替代持久化身份。

## 协同与持久化

- 服务端是共享文档、目录、权限与版本的权威来源。正文统一使用协同会话、结构操作通道与 durable ack，不增加显式保存或 JSON 全文自动保存来覆盖协同正文；JSON 快照是指定 generation/持久化序列的派生数据。
- 连接成功、内容同步、服务端持久化确认、业务版本与索引完成分别表达。只有真实持久化回执才能表示已保存，字数、字符数和预计阅读时间从编辑器内容派生，并支持中文与中英混排。
- 正文、协同快照与未确认更新优先存 IndexedDB，LocalStorage 仅存界面偏好和轻量元信息。缓存按身份、工作区、文档和内容版本隔离，遵守 `offlineCacheAllowed`；重新联网后先校验身份、权限、generation 和服务端修订，再恢复待同步内容。
- 版本恢复、权限撤销和不兼容内容必须阻止旧会话或旧离线更新写回。冲突与结果未知时保留未确认草稿，提供可理解的恢复、重试或导出入口。
- 导出沿用知书 JSON 文档包及内容契约，兼顾 Markdown、独立 HTML 和浏览器打印/PDF；开放原始 Tiptap JSON 时提供明确转换。说明导出范围、附件限制和格式损失，打印只呈现正文并处理代码、表格与分页。
- 预设文档放在开发示例或显式初始化流程，保留 3 篇产品规范/架构知识库内容；初始化应幂等，不覆盖已有或正在协同的内容。演示用户和双屏测试入口留在示例中。

## 产品与编辑器交互

- 桌面以知识库导航、正文、大纲/元信息三栏为基础，保持紧凑页头、固定工具栏和底部状态。明确滚动责任，优先保证正文宽度；窄屏按可用空间收起侧栏并使用抽屉，详情按需展开。
- 目录关系与排序由应用/服务端维护，与正文块排序分开；导航保留工作区切换、搜索、收藏、最近、所有文档和回收站，目录操作覆盖展开、新建子页、原位重命名、删除与拖拽反馈。面包屑使用有权访问的真实祖先，页头保留图标、标题、彩色标签与有权限的收藏、分享、导出动作。
- 全局搜索使用 Cmd/Ctrl+K，覆盖有权限文档的标题与正文，处理方向键、Enter、Escape、空态和失败；与编辑器链接快捷键协调作用域。大纲展示 H1/H2/H3，支持定位、阅读高亮与收起。
- 阅读模式隐藏编辑动作，保留查找、大纲、复制与有权限的分享/导出。用户选择阅读模式与服务端只读权限分别管理，布局和模式变化保持正文、草稿与协同会话连续。
- 固定工具栏、`/` 分类命令与选区浮动菜单共享能力判断、格式状态和键盘语义，覆盖文本格式、高亮、链接、对齐与 Callout 转换。通用提示块、状态标签、代码块、带标签分隔线、成员提及和任务清单沿用已有扩展与内容契约；成员候选由应用提供，通知和权限由服务端处理，内联状态与业务工作流通过明确接口关联。
- 交互覆盖只读、禁用、忙碌、失败重试和取消；浮层适配视口边缘，关闭后恢复焦点/选区。中文输入法组合期间不抢占 Enter、方向键或快捷键；亮暗主题、键盘焦点与移动端触控都应可用。

## AI 与 Chat 边界

- `chat-ui` 提供受控展示和输入，宿主负责网络、身份、会话与业务动作。WritingChat 和 RAG Chat 各自维护状态与协议，共用基础组件，不共用可变业务状态。
- 协作 AI 写作使用服务端进程内的 DSH Session/Agent 与 HTTP/SSE；RAG 问答保留 LangChain 路线。浏览器不加载服务端执行内核、模型 SDK 或密钥，不能因迁移写作而删除 RAG 仍使用的依赖。
- AI 产物、接受写入与持久化完成分别确认；正式正文写入复用现有授权、提案校验、结构操作和 durable ack。检索范围由服务端构造，候选与证据交付复核当前权限和版本，不能把向量索引 ACL 当作授权事实。

## 生成、配置与验证

- 通过源定义更新生成物：服务端 Zod route schema → `apps/app-server/openapi.json` → Orval 客户端 `apps/app-web/src/api/generated/`；文件路由生成 `apps/app-web/src/routeTree.gen.ts`。不要直接手改生成文件。
- 修改 API 后按顺序执行 `pnpm --dir apps/app-server openapi:export` 与 `pnpm --filter @zhishu/app-web api:generate`；路由使用 `pnpm --filter @zhishu/app-web routes:generate`。OpenAPI 离线导出不得连接数据库。
- 生成前检查目标路径的已有改动。前端 `typecheck` / `build` 会生成 API 和路由，`api:check` 检出漂移时也会重写客户端，根目录 `pnpm check` 包含这些步骤。只检查现有前端源码可用 `pnpm --filter @zhishu/app-web exec tsc -p tsconfig.app.json --noEmit`，构建配置另用 `tsconfig.node.json`。
- 后端和 Drizzle 读取 `apps/app-server/.env`，前端公开配置放在 `apps/app-web/.env`，已有环境变量优先。密钥只留在服务端本机配置，不提交仓库；正常后端启动先检查数据库，`database` 与 `src` 一起编译，入口为 `dist/src/server.js`。
- `pnpm --dir apps/app-server db:generate` 生成 migration，`pnpm --dir apps/app-server db:migrate` 显式执行。已发布 migration 不回写，普通应用启动不自动迁移。
- 从改动的 app/package 开始验证，先跑相关测试与类型检查，再按影响扩大。包名和脚本以各自 `package.json` 为准；部分包只提供 `build`，测试或消费编译产物前先按依赖顺序构建。
- 服务端单文件测试用 `pnpm --filter @zhishu/app-server exec tsx --test <测试文件>`；包内 `.mjs` 测试用对应包的 `node --test`。行为变更优先补到现有测试，纯重构用已有测试或输入输出对照验证，不为低风险文案/样式调整增加镜像实现的测试。
- 涉及模块边界、权限、文档持久化时分别检查服务端 `test:architecture`、`test:authorization`、`test:documents`；AI/Chat/RAG 变更按范围运行 `pnpm test:ai` 与独立消费检查 `pnpm check:ai-packages`。数据库、WebSocket、对象存储或模型集成按对应脚本要求使用专用测试环境，先确认测试变量和清理范围，不将业务库当作测试库。
- 格式化使用 Prettier；根目录 `pnpm format` 会全仓写入，局部任务优先只格式化本次文件。`pnpm check` 覆盖格式、lint、架构、类型、build、OpenAPI 和客户端生成漂移，按改动范围执行。
- 涉及交互时检查桌面/移动端、亮暗主题、键盘焦点、输入法、长标题/长文档、重复标题、空态与异常恢复；修改公共包时验证相关 `examples/*` 的独立消费。收尾运行 `git diff --check`，总结实际通过、失败或跳过的检查。
