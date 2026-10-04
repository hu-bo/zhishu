# 编辑器与系统样式体验优化 TODO

更新日期：2026-10-04。

目标：以最新版 `syncscribe` 的知识库布局和编辑器体验为参考，统一知书工作台、文档页和编辑器，并逐步接通工作区、目录树与知识库搜索。缺失的通用能力先落到 `packages/editor-core`、`packages/editor-react`、`packages/editor-ui`，应用层负责身份、文档、权限、保存、协同、附件、分享与版本等业务接入。长期产品与设计约定见 `AGENTS.md`。

本清单基于当前工作区源码梳理，包含尚未提交的实现。复选框只在对应验收有证据后勾选；逐项实现记录、构建结果和视觉截图保存在清单条目与 `output/playwright/`。源码中存在组件不等于交互和视觉已经验收通过。实际工程目录为 `apps/app-web`、`apps/app-server` 和 `packages/*`；`AGENTS.md` 已同步当前工程结构。

## 1. 参考方向与当前差距

### 视觉方向

- 参考 `syncscribe` 的 Slate 浅灰工作区、白色正文面板、Indigo 强调色、细边框、轻阴影、紧凑图标工具栏和深色选区浮层；系统页面沿用同一组语义颜色。
- 保留知书产品名称与中文文案。采用左侧知识库导航、中间编辑/阅读画布、右侧大纲与元信息的三栏布局；正文优先保证阅读宽度、中文行高、标题层级和段落留白，业务操作集中在紧凑页头与按需展开的面板。
- 编辑器外观通过包级样式与公开配置复用；应用通过主题变量和插槽组合页面。
- 参考中的预设用户、房间、双屏协同测试、测试按钮与协议宣传标签属于演示内容，留在参考项目或消费示例中。任务完成礼花作为可关闭的交互增强，遵循减少动画偏好，且只响应本地完成动作。

### 新版布局基线与能力边界

| 区域 | 新版参考源码中的布局                                                                                                     | 知书落地要求                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 整体 | `App.tsx` 为全高 flex 布局，外层限制溢出，内部以 `min-w-0` / `min-h-0` 分配空间                                          | 明确主画布、导航与右栏的滚动容器，移动端适配动态视口与软键盘                               |
| 左侧 | `KnowledgeSidebar` 展开 `w-72`（约 288px），收起 `w-14`（约 56px）；工作区切换、搜索、新建、收藏、分类目录、底部用户入口 | 工作区与递归文档树接入真实模型；中小屏改为抽屉，操作支持键盘和触屏                         |
| 中间 | `DocumentHeader` 页头；浅灰画布 `p-3 md:p-6`；编辑器容器 `max-w-5xl`，正文 `max-w-4xl`；底部 `StatsFooter`               | 参考外层约 1024px、正文约 896px 的上限，正文随两侧栏剩余空间缩放；编辑/阅读共用内容实例    |
| 右侧 | `TableOfContents` 约 288px，包含 H1/H2/H3 大纲、状态、作者、更新时间、标签和相关文档                                     | 大纲由编辑器包提供，业务元信息由应用注入；宽度不足时收起或抽屉展示，避免左右各出现一套大纲 |
| 搜索 | `GlobalSearchModal` 顶部居中、约 672px 最大宽度、结果区域滚动、底部键盘提示                                              | 用现有 Dialog 体系提供完整焦点行为，接入真实搜索与权限                                     |

参考源码当前的目录按 `category` 分组，虽然类型有 `parentId`，尚未形成递归树或拖拽持久化；搜索过滤标题、分类、标签和描述，尚未搜索正文；大纲高亮由点击设置，定位按标题文本匹配，尚未跟踪阅读位置；LocalStorage 保存文档元信息，正文通过 Yjs/WebSocket 管理，尚不能据此认定完整离线恢复已实现。以下任务将这些作为待补能力，不将参考界面上的入口视为业务完成证据。

### 参考文件与落点

| 参考源码                                                                                   | 提取内容                                             | 主要落点                                                                     |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| `syncscribe/src/index.css`、`src/components/EditorPane.tsx`                                | 编辑区布局、正文排版、任务列表、空白提示             | `packages/editor-ui/styles.css`、`editor-shell.tsx`；提示行为在 core/react   |
| `syncscribe/src/components/TopToolbar.tsx`                                                 | 工具分组、分隔线、图标尺寸、选中与禁用反馈           | `packages/editor-ui/src/editor-toolbar.tsx`                                  |
| `syncscribe/src/components/BubbleMenuFloating.tsx`                                         | 深色浮动工具条、格式与链接入口                       | `packages/editor-ui/src/editor-selection-menu.tsx`、`editor-link-editor.tsx` |
| `syncscribe/src/components/SlashCommandPalette.tsx`                                        | 命令分组、图标、说明、搜索和键盘提示                 | `packages/editor-ui/src/editor-slash-menu.tsx`                               |
| `syncscribe/src/components/KnowledgeSidebar.tsx`                                           | 工作区切换、折叠导航、收藏与目录层级                 | app-web 导航与知识库业务                                                     |
| `syncscribe/src/components/DocumentHeader.tsx`                                             | 面包屑、标题/Emoji、编辑阅读切换、在线成员、分享导出 | app-web 文档页；通用成员展示在 editor-ui                                     |
| `syncscribe/src/components/TableOfContents.tsx`                                            | 右侧大纲、标签、作者、更新时间与相关文档             | editor-ui 大纲；app-web 业务元信息                                           |
| `syncscribe/src/components/GlobalSearchModal.tsx`                                          | 全局命令搜索、结果样式、键盘提示                     | app-web 搜索与 Dialog；服务端权限及检索                                      |
| `syncscribe/src/components/StatsFooter.tsx`                                                | 字数、字符数、预计阅读时间、状态栏                   | core 统计、react 订阅、ui 展示；保存状态由宿主注入                           |
| `syncscribe/src/extensions/CustomCodeBlock.tsx`                                            | 代码块标题栏、语言选择、复制反馈                     | core 现有代码节点、react NodeView 适配、ui 节点外观                          |
| `syncscribe/src/extensions/{Callout,StatusBadge,DividerWithLabel,CollaboratorMention}.tsx` | 提示块、状态标签、带标签分隔线、提及外观             | P2 通用扩展；提及的数据与权限由应用提供                                      |

### 已有基础

| 当前实现                                                                                                                 | 本轮处理方向                                                                        |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `EditorShell` 已有标题、页头、页脚、工具栏插槽，以及大纲、查找、块菜单、斜杠菜单、选区菜单、链接编辑                     | 完善组合方式、外观和响应式行为，复用现有组件                                        |
| 已有任务清单、表格、图片/PDF、代码语言选择和图片属性编辑                                                                 | 补齐节点样式、操作入口与反馈，核对两种文档模式的接入差异                            |
| 已有普通快照编辑、协同编辑、版本、分享 ACL、导入导出与离开前草稿处理                                                     | 调整布局和操作流程，保持现有保存与授权语义                                          |
| `editor-ui/styles.css` 先定义基础规则，后追加大量同名覆盖；同时存在 `--zhishu-ui-*`、`--zhishu-editor-*` 和硬编码绿/白色 | 收敛为明确的公共主题变量和组件状态规则                                              |
| app-web 为绿色主题；全局有 dark variant，但缺少完整暗色变量与页面适配                                                    | 统一系统与编辑器主题，并在 P1 完成暗色主题                                          |
| 文档页在正文前依次展示导入导出、标题卡片、技术状态卡片、分享面板                                                         | 将正文提前，业务信息按任务收纳                                                      |
| 默认工具栏和选区菜单主要覆盖粗体、斜体、删除线、行内代码；斜杠菜单已有分组和关键词过滤                                   | 增加常用格式入口、菜单信息层级和完整能力状态                                        |
| 文档契约当前最高为 Schema v3；内联格式契约没有下划线/高亮，段落与标题没有对齐属性                                        | 先补内容契约与 core 完整链路，再开放 UI；不能只依据底层 Tiptap 命令是否存在判断支持 |

## 2. 分层约束

| 层                                                 | 应承担的职责                                                              | 接入约束                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `packages/editor-core`                             | 内容模型适配、扩展、命令、格式状态查询、能力判断、统计、占位行为和转换    | 保持框架无关；新增能力有公开 API、只读语义和内容往返规则         |
| `packages/editor-react`                            | Provider 生命周期、selector/event 订阅、宿主服务接口、React NodeView 适配 | 每种状态只有一个来源；主题、面板和页头变化不重建编辑器           |
| `packages/editor-ui`                               | 编辑器排版、主题变量、Shell、工具栏、菜单、浮层、节点视图和状态展示       | 包内样式自包含并隔离；通过 props、messages、插槽与变量供宿主定制 |
| `apps/app-web`                                     | 系统外壳、文档页面、身份/权限、API、上传、保存、分享、版本、导入导出      | 使用包的公开入口组合业务；通用命令和节点能力缺失时先回补包       |
| `packages/document-contracts`                      | 持久化节点/Mark/属性、校验、版本兼容与迁移                                | 新格式与 core 同步设计；按影响更新转换、快照和操作契约           |
| `packages/editor-collaboration`、`apps/app-server` | 协同适配、结构操作、权限与持久化                                          | 新内容类型需要时补支持；继续使用现有结构操作通道和 durable ack   |

实施顺序：确认契约与能力缺口 → core → react → ui → 消费示例 → 应用业务接入。纯视觉任务可直接从 ui 开始。应用主题在宿主显式映射 `--zhishu-ui-*`，包保持独立默认值；通用样式不依赖 app-web 的 Tailwind 编译、私有类名或路由。

增加持久化格式时同步处理 JSON/HTML 导入导出、历史内容、Schema/扩展兼容和协同会话。需要数据库迁移时新增 migration，遵循既有显式迁移流程；OpenAPI 与前端生成客户端从源契约生成。

## 3. P0：统一视觉基础与主编辑流程

P0 完成标准：工作台与编辑器视觉统一，进入文档即可看见正文并开始编辑，现有功能在普通、协同和只读场景中都能正常使用。

- [x] **P0-01 建立视觉规格与对照样本。** 提取参考项目的颜色、字号、行高、间距、圆角、阴影、图标尺寸和菜单状态，记录到维护文档。以 14px 界面文字、16px 正文、约 1.7–1.8 正文行高、约 800–900px 正文最大宽度作为首版调整起点，最终以真实中文内容检查结果为准。
  - 落点：`docs/packages/editor-ui.md`、`docs/apps/app-web.md`、`examples/editor-consumer`。
  - 验收：同一份长标题、中文正文、列表、代码、表格和附件样本用于对照；设计规格明确哪些是参考值、哪些是本项目选择。
  - 实施记录：规格分别列出 syncscribe 参考值与知书选择；消费示例加载固定样本 `examples/editor-consumer/src/visual-review-content.ts`，覆盖长中文标题、正文、列表、任务、代码、表格、引用和图片占位。`pnpm --filter @zhishu/editor-consumer-example typecheck` 通过。Chromium 已查看 1440/1280/768/390px 样本，768/390px 无页面级横向溢出，窄屏大纲长标题使用省略号；截图位于 `output/playwright/editor-consumer-sample-{1440,1280,768,390}.png`。附件使用演示 asset ID，不能作为存储链路验收。

- [x] **P0-02 收敛编辑器主题变量和样式覆盖。** 合并 `styles.css` 中重复的 Shell、工具栏、大纲、正文和菜单规则；补充背景层级、弱化文字、hover/active/disabled、焦点、成功/警告/失败、阴影及尺寸变量。把现有颜色与圆角覆盖接入同一套公开变量，应用统一映射为参考方向。
  - 落点：`packages/editor-ui/styles.css`、`apps/app-web/src/styles/globals.css`。
  - 验收：两个编辑器实例可分别使用不同主题；覆盖公开变量即可改变全部内置组件；编辑器样式不影响宿主表单和正文以外的元素。
  - 完成验收：继续合并协同状态、页头/标题、工具栏、查找输入、链接按钮、正文容器和大纲的重复基础/紧凑规则；删除重复的斜杠菜单焦点规则，并合并重复的移动端与粗指针媒体块。断点现为唯一的 720px、420px、粗指针和减少动画规则，剩余重复选择器均为基础样式与紧凑/响应式覆盖。画布、正文纸面、边框、状态色、控件状态和紧凑/常规/浮层圆角现使用包级语义变量；CSS 使用的 `--zhishu-ui-*` 名称全部有文档定义且无孤立项。消费样例外层卡片半径改为读取公开变量；Chromium 临时覆盖颜色、画布、正文、边框、阴影、常规/紧凑/控制/浮层圆角时，Shell、正文、工具栏、PDF 和链接 Dialog 均读取到对应值，第二个实例保持原暗色不受影响。最终截图显示画布与正文纸面层级，390px 下页面宽度为 390px。截图：`output/playwright/editor-consumer-theme-final-{light,dark}-1440.png`、`output/playwright/editor-consumer-theme-final-390.png`，旧样式对照见 `output/playwright/editor-consumer-css-{before-1440,after-1440,after-390}.png`。editor-ui、消费样例和 app-web 构建通过；app-web 有现存 Orval circular dependency 与大 chunk 警告，消费样例 chunk 超过 500KB 提示。静态检查确认包样式没有未限定到 `.zhishu-*` 的宿主表单/正文选择器。

- [x] **P0-03 优化 EditorShell 布局与正文排版。** 明确页头、工具栏、正文、大纲和页脚的排列与滚动责任；支持宿主配置正文宽度、紧凑布局和固定工具栏所需的偏移。大纲支持放到右侧或通过公开组件独立组合，统计栏可在画布下方组合，避免应用为三栏布局侵入包内 DOM。整理标题、段落、链接、引用、行内代码、列表、分隔线、选区与只读内容样式。
  - 落点：`packages/editor-ui/src/editor-shell.tsx`、`packages/editor-ui/styles.css`。
  - 验收：长文档滚动时常用操作可达；固定栏不遮挡选区或标题定位；普通、协同和历史预览的正文排版一致；正文不会因大纲展开被压成过窄一列。
  - 布局验收：`EditorShell` 已公开 `contentMaxWidth`、`compact`、`stickyToolbar`、`toolbarOffset` 和 `outlinePlacement`，应用普通/协同编辑器及独立消费样例把大纲放在正文右侧；桌面大纲设为 288px、正文上限设为 896px。Chromium 将首个样例工具栏临时设为 48px 偏移并滚动，实测吸顶时 `getBoundingClientRect().top` 为 48px，页面和编辑器滚动后恢复；截图为 `output/playwright/editor-consumer-toolbar-offset-1440.png`。1440px/390px 样例中窄屏无横向溢出，旧布局截图为 `output/playwright/editor-consumer-layout-{1440,390}.png`。
  - 完成验收：core 的 `calculateDocumentStatistics` 明确以词段计词、以非空白 Unicode 字素计字符；代码参与计数，附件不计，预计阅读默认按 300 词段/分钟向上取整，locale 与速度可配置。React store 仅对 `docChanged` 安排 160ms 防抖重算，选择移动复用原结果；切换/卸载时清理计时器。`EditorStatsFooter` 与快捷键帮助可独立组合，Shell 提供 `statisticsFooter` 并保留宿主 `footerSlot`；普通、协同与历史预览均使用同一包级 footer，应用保存摘要继续归应用提供。历史正文改用独立只读 EditorProvider 和相同 Shell，可切换 Block 差异视图，不接入当前协同会话。Chromium 在 390px 样例实测新增“中文mixed English123 😀”后词数 +3、字符数 +18，快捷键帮助用 Space 开关后焦点仍在 summary，页面宽度保持 390px；空文档 API 返回三个统计值均为 0。历史版本使用本地 API mock：当前编辑器 `contenteditable=true`，预览 `contenteditable=false`/`aria-readonly=true`，没有格式写入按钮。截图：`output/playwright/editor-stats-footer-mobile-390.png`、`output/playwright/zhishu-history-document-preview-mock-1280x900.png`。editor-core/react/ui、消费样例与 app-web 构建通过；真实 API 不可用，历史版本数据由浏览器 mock 提供。保留消费样例约 1 MB 与文档页约 825 KB chunk 警告及 Orval 路由生成循环依赖警告。

- [x] **P0-04 完善现有工具栏的层级与反馈。** 按撤销重做、格式、插入与辅助工具分组，统一图标、分隔线和按钮状态；为现有操作提供中文名称、禁用原因与快捷键提示。窄屏采用按组收纳或更多菜单；查找以明确入口按需展开。
  - 落点：`editor-toolbar.tsx`、`editor-icon.tsx`、`editor-find-panel.tsx`、`editor-link-editor.tsx`。
  - 验收：格式三态与编辑器选区一致；键盘可在组内移动、离开工具栏；上传忙碌/重试/取消状态不会挤坏布局。P1 新命令在能力完成后接入。
  - 完成验收：工具栏按格式、编辑历史、附件和恢复分组；格式状态、快捷键、禁用原因与 roving focus 可用。查找可独立展开、聚焦、循环导航、Escape 关闭并恢复焦点。上传中显示忙碌状态并禁用重复上传，新增按钮可中止 AbortSignal 上传并请求宿主清理；失败显示错误和重试/取消，取消中的文件未写入正文，后续重试成功可插入节点。消费样例本地上传服务模拟了失败、取消及成功路径；Chromium 390×844 实测页面宽 390px、工具栏宽 338px、附件按钮宽 68px、恢复按钮宽 116px，失败/忙碌状态未挤出布局。截图：`output/playwright/zhishu-document-find-toggle-1280x720.png`、`editor-consumer-find-open-390.png`、`editor-consumer-upload-busy-390.png`、`editor-consumer-upload-failed-390.png`。editor-ui、消费样例和 app-web 构建通过；上传进度百分比仍未实现。保留 Orval 循环依赖与约 821 KB 文档页 chunk 警告。

- [x] **P0-05 优化浮动菜单与斜杠菜单外观。** 选区菜单参考深色浮层；斜杠菜单在现有分组和关键词过滤上增加图标、说明、清晰选中态、空结果和键盘提示；块菜单统一分组、危险操作与手柄反馈。
  - 落点：`editor-selection-menu.tsx`、`editor-slash-menu.tsx`、`editor-block-menu.tsx`、`editor-link-editor.tsx`。
  - 验收：窗口边缘、嵌套滚动、侧栏和对话框中的定位正确，浮层不被 Shell 裁切；操作后恢复正确选区；输入法组合期间不抢占按键，Escape 可关闭。
  - 完成验收：斜杠菜单提供图标、说明、选中态、无结果和键盘提示，Block 菜单提供具名分组、删除危险色和手柄反馈。Chromium 消费样例验证中文关键词过滤、方向键选择，以及 390×844 下右侧边界菜单保持在视口内；人为在 500px 高嵌套滚动区打开斜杠菜单后，滚动 120px 菜单跟随锚点移动 120px。选区工具栏与 Block 菜单在窄屏保持完整，Block 菜单底部距视口 8px，浮层显示在 Shell 正文上方。链接编辑浮层 390px 下完整位于视口内；新增 Escape 关闭处理，组合输入期间 Escape 不关闭，正常 Escape 关闭后焦点回到编辑器。截图：`output/playwright/editor-consumer-slash-menu-{1440,390}.png`、`output/playwright/editor-consumer-selection-menu-edge-390.png`、`editor-consumer-block-menu-mobile-390.png`、`editor-consumer-block-menu-1440.png`。`@zhishu/editor-ui` 与消费样例生产构建通过；app-web 构建已通过，存在既有 Orval 循环依赖及约 820 KB 文档页 chunk 警告。

- [x] **P0-06 完善已有内容节点的样式。** 任务清单增加清楚的勾选/完成/只读状态与嵌套层级；表格补齐表头、边框、选中单元格和局部横向滚动；图片与 PDF 展示统一占位、选中态、尺寸约束及加载失败状态。
  - 落点：`packages/editor-ui/styles.css`、`editor-image-alt-editor.tsx`、`editor-shell.tsx`；通用资源加载状态需要时补到 editor-react。
  - 验收：按当前实际 DOM 编写样式，任务节点的 `div[data-type="taskItem"]` 与参考的 `li` 不混用；独立消费只引入包样式就能正确显示表格和附件；宽表格、长文件名和大图不撑宽页面。
  - 完成验收：任务项样式使用实际 `div[data-type="taskItem"]` DOM，覆盖勾选色、只读禁用光标、完成划线和递归层级；表格用 `tableWrapper` 局部滚动，修正 Tiptap 内联 `min-width` 导致 CSS 最小宽度无效的问题，并补表头、边框和选中单元格反馈。`EditorShell` 为图片/PDF 记录 loading/failed/unavailable/ready 状态；图片加载成功前显示占位，并等待真实 `load` 事件；失败与无解析器状态有可访问描述，PDF/图片选中边框一致。消费样例加入长文件名 PDF、2400px 图片和模拟 resolver 拒绝。Chromium 验证 390px 页面宽度为 390px，表格容器宽 266px、内部宽 576px 且局部滚动，PDF 右边界为 328px；大图在 390px 和 1440px 下分别缩至 264px/758px。只读任务 checkbox 禁用、完成文本划线；嵌套列表缩进；拖选表格单元格、图片与 PDF 均显示选中态。截图：`output/playwright/p0-06-consumer-{390,1440}.png`、`p0-06-consumer-dark-{390,1440}.png`。editor-ui、消费样例和 app-web 构建通过。

- [x] **P0-07 统一系统外壳与基础控件。** 按新版三栏工作区调整侧边导航、页头、内容底色、按钮、输入框和 Dialog；桌面左栏提供约 288px 展开/56px 收起形态，右栏按剩余空间展开，窄屏提供可关闭的导航/详情抽屉。参考文档页 12/24px 外边距，正文采用独立滚动，工具栏与状态栏保持可达。
  - 落点：`apps/app-web/src/app/app-shell.tsx`、`src/components/ui/*`、`src/styles/globals.css`。
  - 验收：工作台、编辑页、弹窗和导航使用同一组主题变量；保留主内容跳转入口、清晰焦点与登录/退出反馈；导航收起不改变正文内容和选区。
  - 完成验收：全局 Slate/Indigo 语义变量覆盖工作台、文档页与基础控件；亮/暗/系统切换及 288px/56px 桌面导航可用，导航和真实协作文档详情在窄屏以 Dialog 抽屉打开。Chromium 检查了工作台浅/暗色、导航与详情抽屉，Escape 关闭详情后焦点回到触发器；1280×720 文档页两种主题无横向溢出。认证以本地模拟接口验收登录成功、退出成功、服务端退出失败时清除本地会话并显示反馈，未改变真实登录状态。当前真实文档服务不可用，无法用该会话验证服务端内容加载；工作台错误态仍保持可读。截图：`output/playwright/zhishu-workbench-final-light-1440.png`、`zhishu-workbench-dark-1440.png`、`zhishu-workbench-mobile-drawer-dark-390.png`、`zhishu-document-details-drawer-390.png`、`zhishu-document-header-dark-status-1280x720.png`。`pnpm --filter @react-fastify-template/app-web build` 通过；保留既有 Orval 循环依赖及约 820 KB 文档页 chunk 警告。

- [x] **P0-08 重组文档页头并提前正文。** 参考 `DocumentHeader` 将面包屑、标题、文档模式、保存摘要、在线成员和业务操作收拢到页头；分享、版本、导入导出通过按钮打开面板或菜单。将 generation、Schema、durableSeq 等技术字段移入可展开的详情区域；Emoji、彩色标签和多级路径在对应业务能力完成后接入。
  - 落点：`apps/app-web/src/routes/documents/$documentId.tsx`、两个 `-document-*-editor.tsx` 及相关业务面板。
  - 验收：1440×900 与 1280×720 桌面首屏可见正文并可直接定位编辑；标题修改、保存失败和权限反馈清楚；页头中文输入的 Enter 不误触发提交；打开业务面板不会重建编辑器或丢失草稿。
  - 完成验收：标题、模式、更新时间、业务入口集中在紧凑页头，技术字段折叠，分享/版本/导入导出使用独立 Dialog。Chromium 在 1440×900 与 1280×720 查看首屏，页面宽度与视口一致，正文可见；1280×720 时编辑器顶端 y=410、宽 634px。通过本地 API 模拟验证标题输入法组合 Enter 不发送 PATCH、并发冲突显示“文档已在其他位置更新…”且保留输入、重试成功清除错误；只读快照显示明确状态并禁用格式/链接操作、隐藏正文保存按钮。修改正文形成未保存草稿后打开版本 Dialog，编辑器 DOM 和草稿文本保持一致、未触发保存请求；Escape 关闭后焦点回到“版本”触发器。真实 API 当前不可用，故这些交互使用本地响应模拟。截图：`output/playwright/zhishu-document-header-mock-dirty-1280x720.png`、`zhishu-document-header-mock-readonly-1440x900.png`、`zhishu-document-header-final-1280x720.png`、`zhishu-document-share-1280x720.png`。app-web 构建通过；保留 Orval 路由生成循环依赖及约 820 KB 文档页 chunk 警告。

- [x] **P0-09 统一工作台列表体验。** 整理最近/我的/全部/收藏/归档/回收站导航，统一搜索、排序、新建、分页与列表行样式；弱化修订序号等技术信息，突出文档名称、更新时间、模式与收藏状态。
  - 落点：`apps/app-web/src/routes/documents/index.tsx`。
  - 验收：筛选继续由 URL 管理；长标题可读且可查看完整内容；动作在键盘与触屏下可发现；搜索无结果、首次空态、回收站空态分别提供适合的说明与入口。
  - 完成验收：文档视图、查询词、排序方向和分页继续同步在 URL；Chromium 用本地 API 响应验证标题搜索、排序、下一页偏移和升序切换。长标题行以省略号适配窄屏并通过 `title` 提供完整文本；列表副标题突出普通快照/实时协同、收藏态与更新时间，不再展示快照修订号或 durable 序号；管理操作具备可读名称，移动端操作按钮实测 44×44px。无结果、首次最近文档空态、回收站空态、归档空态分别展示对应文案，只有首次空态提供创建入口。390px 下页面宽度为 390px。截图：`output/playwright/zhishu-document-list-mobile-390.png`、`zhishu-document-list-empty-390.png`。`pnpm --filter @react-fastify-template/app-web build` 通过；仍有既有 Orval 循环依赖及约 820 KB 文档页 chunk 警告。

- [x] **P0-10 统一业务状态与确认交互。** 为加载、空态、失败重试、只读和保存失败统一组件与文案。把永久删除、撤销权限、版本恢复、导入导出损失确认、放弃正文修改的 `window.confirm` 替换为应用现有 Dialog 体系。
  - 落点：`apps/app-web/src/app/route-feedback.tsx`、`src/components/ui/dialog.tsx`、文档列表与各业务面板。
  - 验收：确认弹窗显示对象、影响、主次操作和进行中状态；失败保留输入，关闭后焦点返回触发器；刷新/关闭浏览器时的原生离开提示继续按浏览器机制工作。
  - 完成验收：共用 `ConfirmDialog` 已替换 app-web 的永久删除、撤销 ACL、恢复历史版本、导入/导出格式损失和普通快照放弃修改后重载确认；全目录静态检索未发现原生 `window.confirm`。版本恢复用本地接口模拟 409：弹窗说明恢复目标和影响，错误留在弹窗内且确认按钮恢复可用；取消后焦点返回恢复触发器，再按 Escape 关闭外层版本面板并回到“版本”入口。确认交互中的 busy/禁用状态由共用组件管理。`pnpm --filter @react-fastify-template/app-web build` 通过；真实服务不可用，业务请求使用本地响应模拟。保留既有 Orval 循环依赖及约 820 KB 文档页 chunk 警告。

- [x] **P0-11 将大纲组合到右侧文档栏。** 复用 core 的大纲与定位能力、react 的订阅和 ui 的 `EditorOutline`，补齐默认 H1/H2/H3、当前阅读小节、长标题、省略提示、空态和收起行为；应用组合作者、更新时间等真实元信息，业务面板共享右栏空间。
  - 落点：`packages/editor-ui/src/editor-outline.tsx`、`editor-shell.tsx`、editor-react 的订阅接口、app-web 文档侧栏。
  - 验收：使用稳定 blockId，不按标题文本或全局 DOM 定位；重复标题、中文标题、远端编辑和多实例均定位正确；滚动高亮来自当前正文滚动容器；中小屏抽屉关闭可恢复焦点。
  - 完成验收：普通/协同编辑器与样例的 `EditorOutline` 已移至正文右侧，应用映射 288px 桌面宽度；应用详情栏可收起，窄屏从编辑器页头打开 Dialog 抽屉，Escape 关闭后恢复触发器焦点。面板显示真实模式、创建/更新时间和 `canManage`；作者、标签、相关文档不在当前 API 中。索引订阅按当前 editor 实例及稳定 Block ID 更新标题与阅读位置。Chromium 在 app-web 的历史只读预览中确认两个同名 H2（独立 Block ID）点击第二项后，只高亮第二项；桌面目标位于正文滚动面阅读线下 38px，390px 窄屏下位于滚动面起点下 16px。预览正文独立滚动，大纲保持可见。空态、长标题截断与 title 提示、收起状态也已核对。截图：`output/playwright/zhishu-outline-duplicate-heading-mock-1280x900.png`、`output/playwright/zhishu-outline-duplicate-heading-mock-mobile-390x844.png`。应用构建通过；业务数据由本地响应模拟。

## 4. P1：补齐通用编辑能力并打通业务

P1 完成标准：参考中的常用编辑动作具有完整的命令、状态、UI 与保存链路；应用消费同一套能力，不为两种文档模式复制编辑器实现。

### editor-core 与内容契约

- [ ] **CORE-01 补齐下划线、高亮和段落/标题对齐。** 逐项审计底层扩展、公开命令、能力判断与当前契约的差异；补齐启用、取消、清除格式和混合选区语义，定义高亮颜色与合法对齐值。
  - 落点：`packages/editor-core/src/{editor,extensions,conversions}.ts`、`packages/document-contracts/src/*`。
  - 验收：Schema 校验、JSON 保存重开、HTML 往返、复制粘贴、普通/协同撤销重做、历史版本读取与兼容提示覆盖新增格式；服务端支持后才展示可执行入口。
  - 当前验收记录（2026-10-01，尚未覆盖全部门槛）：Schema v4 约束、v3 拒绝新格式、Mock PUT 保存 payload、Chromium 下 underline/highlight/alignment 清除、HTML 往返、复制粘贴保留 Mark，以及普通撤销/重做已通过；浏览器接口使用模拟 API，截图 `output/playwright/zhishu-formatting-toolbar-1280x900.png`。协同撤销重做、真实历史版本读取及跨浏览器剪贴板仍待验。

- [ ] **CORE-02 统一常用块命令与能力查询。** 将工具栏、斜杠菜单和块菜单需要的段落、标题、列表、引用、任务项、代码块、分隔线等动作补齐为公开能力；统一可执行判断、当前块状态与失败原因，复用已有结构操作实现。
  - 落点：`packages/editor-core/src/editor.ts`；需要时同步操作契约与协同适配。
  - 验收：同一动作从不同菜单执行结果一致；只读、表格内选区、嵌套列表、无效目标和协同冲突都有明确行为；协同结构修改继续走受控通道。
  - 当前进度（2026-10-01，验收未完成）：core 已公开段落、标题、列表、引用、代码块和分隔线命令，并统一返回写入/块结构能力；Slash 菜单的工具栏入口调用 controller 命令，查询式 Slash 在执行前检查块结构能力。Chromium 已验标题、无序列表命令；只读能力返回拒绝。表格/嵌套目标与协同结构冲突仍待验。

- [ ] **CORE-03 提供可配置的空白提示与快捷键。** 增加空文档/空段落的占位能力、中文斜杠引导及配置入口；梳理已有快捷键，补充支持的格式动作与输入法保护。
  - 落点：`packages/editor-core/src/extensions.ts`、`editor.ts`，通过 editor-react 传入配置，editor-ui 提供提示样式。
  - 验收：占位文字不进入 JSON、统计、协同更新与导出；只读时按配置展示；中文输入法确认和普通斜杠输入不被误处理。
  - 当前验收记录（2026-10-01，尚未覆盖全部门槛）：Provider options 暴露空文档/空段落/只读显示配置；Chromium 已验占位不进入 JSON、统计和 HTML、只读配置可见、`Ctrl+Shift+H` 在组合态被忽略而普通快捷键生效。消费样例中空段落输入 `/` 能打开命令菜单；键入 `https://example.com/a/b` 保留斜杠且不误开菜单。真实中文输入法和协同无占位更新仍待设备/协同验收。

- [x] **CORE-04 提供文档统计 API。** 提供字数/词数、字符数与预计阅读时间所需的数据；定义中文、英文、空格、换行、emoji、代码和附件的计数口径。预计阅读时间明确为估算，参数可配置。
  - 落点：`packages/editor-core/src` 的统计能力及公开导出。
  - 验收：空文档为零，中英混排统计可解释；避免直接照搬参考的空格分词算法；选区移动不触发全文统计，长文档内容更新采用缓存或合理调度。
  - 完成验收：`packages/editor-core/src/statistics.ts` 导出纯统计 API：`Intl.Segmenter('zh-Hans')` 对中文按词段、中英文混合按可识别词计数；字符按非空白字素计数，空格/换行不计，组合 emoji 按一个字符，代码块参与、无文本附件排除；默认阅读估算为 300 词段/分钟，可配置 locale 和速度。React 消费 ProseMirror `textBetween`，正文修改以 160ms 防抖重算；390px Chromium 输入混排文本后词数 +3、字符数 +18，空文档返回全零。core/react 构建通过。

### editor-react 状态与视图适配

- [x] **REACT-01 补齐新增能力的订阅状态。** 扩展当前格式、块类型、对齐、统计与能力结果的 selector；复用已有 store 与事件来源，避免界面各自监听并扫描正文。
  - 落点：`packages/editor-react/src/{store,use-editor-selector,use-editor-events,context,index}.ts`。
  - 验收：选区切换、远端更新、只读切换与撤销重做后 UI 一致；组件只订阅所需投影；两实例互不影响，卸载后释放监听。
  - 当前验收记录（2026-10-01，尚未覆盖全部门槛）：Store 新增混合格式、高亮颜色、文本块/对齐、列表类型、表格尺寸和能力投影，包构建通过；Chromium 消费样例的两个 editor 实例显示独立块/格式状态，切换第二个只读后其任务勾选禁用、首个实例保持可编辑，恢复后各自状态不串扰。协同结构安全门消费样例的“模拟远端事务”新建段落成功，说明远端事务到达 controller 并更新视图；Provider 清理代码逐项释放 store/controller/presence/collaboration 订阅及统计定时器。卸载后监听无残留仍待专项仪器化验证。

  - 2026-10-03 完成专项验收：修复 selector 切换字段/equality、但 store 无新事务时返回旧值的问题。公开包 `/lifecycle` 消费示例真实内存 Yjs 双端验证远端下划线状态、撤销/重做和统计更新；只读/主题及双实例互不影响。30 次选区移动保持统计对象、统计组件和宿主渲染次数不变，正文序列化 0 次。StrictMode 下连续 12 轮双实例挂载/卸载，24 个已创建 controller 全销毁，controller/store 监听、MutationObserver、协同订阅均归零，卸载后无延迟统计回调。证据 output/qa/lifecycle-browser.log；内存 Yjs 测试不代表服务端持久化。

- [x] **REACT-02 完善节点视图与宿主服务边界。** 复用 `createSafeReactNodeViewRenderer` 接入代码块等交互视图；整理资源读取、上传反馈、外链处理等宿主接口，使包内组件只依赖公开服务。
  - 落点：`packages/editor-react/src/react-node-view.tsx`、`context.ts`、`editor-provider.tsx`。
  - 验收：单个 NodeView 出错可局部重试；只读时仍可复制和查看；切换文档取消旧请求，异步结果不会插入新文档或失效位置；主题切换不销毁实例。
  - 当前验收记录（2026-10-01，尚未覆盖全部门槛）：Provider 增加 codeBlock React NodeView 入口并通过安全 renderer 接入；Chromium 消费样例已验证代码只读时仍可复制、状态反馈出现，保存 JSON 保留 `codeBlock`/语言属性且不包含 NodeView 外壳。core/react/ui/示例构建通过；错误隔离重试与切换文档取消仍待专项验收。

  - 2026-10-03 完成专项验收：NodeView 人为渲染错误只影响本块，显式重试恢复且 JSON 不变，第二实例仍可编辑；结合此前只读代码复制验收补齐门槛。上传捕获开始时的根块锚点；取消后宿主忽略 AbortSignal 返回、删除锚点、切换文档均不会错误插入。切换时调用原文档宿主取消服务，拒绝把旧错误写到新视图；资源节点删除或卸载立即取消读取。主题/默认 UI 切换保持同一控制器。使用本地模拟宿主验证边界，未连接 MinIO。证据 output/qa/lifecycle-browser.log。

### editor-ui 通用交互

- [x] **UI-01 接入完整格式工具与命令入口。** 使用 CORE-01/02、REACT-01 提供标题/正文选择、下划线、高亮、对齐、列表及清除格式；选区菜单共享格式与链接编辑能力。斜杠菜单支持工具栏主动打开和插入位置保留。
  - 落点：`editor-toolbar.tsx`、`editor-selection-menu.tsx`、`editor-slash-menu.tsx`、`editor-link-editor.tsx`。
  - 验收：所有入口共享能力判断与格式状态；支持鼠标、键盘和触屏；主动打开菜单不依赖全局伪造键盘事件；能力不可用时给出明确反馈。
  - 当前验收记录（2026-10-01，尚未覆盖全部门槛）：工具栏提供格式、标题/正文、对齐、列表与主动插入菜单；Chromium 已验鼠标打开、Escape 关闭、方向键/Enter 选择标题、列表转换及位置不变，弹层截图 `output/playwright/zhishu-toolbar-command-menu-1280x900.png`。协同模式下工具栏菜单逐项启用可提交的表格/任务结构操作，其余外层结构命令显示禁用原因；一次性协同文档中 `/table` 输入、选取表格并收到服务端确认也通过。普通编辑态原交互正常。触屏仍待验。

  - 2026-10-03 补齐触屏入口验收：Edge 390×844、hasTouch/isMobile、coarse pointer 下实际 tap 下划线/高亮、多色选择、清除格式、主动插入菜单转二级标题均成功；主动菜单不写入 `/`，只读禁用格式动作。正文与页面宽均为 390px，可用工具栏按钮至少 44×44px。结合此前鼠标/键盘验收完成本项；物理设备与跨浏览器输入法仍归 CHECK-04。日志 output/qa/consumer-touch-browser.log，截图 output/playwright/zhishu-touch-editor-390x844.png。

- [x] **UI-02 改进代码块节点体验。** 在现有 `codeBlock` 上增加暗色代码容器、语言标题栏、语法高亮、复制按钮、成功/失败反馈和选中态；语言切换沿用已有属性。按需加载 TypeScript、Python、SQL、Bash、JSON、Go 等语言，未知语言保留纯文本回退。
  - 落点：`editor-code-language-selector.tsx`、新增包内代码块视图、`packages/editor-ui/styles.css`；复用 REACT-02。
  - 验收：普通、协同和历史只读代码块均能复制；语言与内容保存后恢复；宽代码局部滚动；保留已有节点类型和 blockId，NodeView 外壳不进入持久化正文。
  - 完成验收（2026-10-01）：`EditorCodeBlockView` 提供暗色语言栏、只读可用的复制按钮、成功/失败播报和选中样式；core 以只读 ProseMirror 装饰着色，JavaScript/TypeScript、Python、SQL、Bash、JSON、Go 等语言模块按文档需要动态加载，未知或加载失败时回退纯文本。Chromium 消费样例确认 TypeScript 关键字有语义颜色且初次只请求 TypeScript chunk；切换为 Python 后加载 Python chunk并重新着色。320px 下输入 160 字符长 token 后代码区 clientWidth 为 194、scrollWidth 为 1954，整页仍为 320px；截图 `output/playwright/zhishu-code-block-highlight-typescript-1280x900.png`、`output/playwright/zhishu-code-block-highlight-long-320x740.png`。应用级协同文档通过结构操作转换代码块，写入 TypeScript、收到 durableSeq 5 确认，刷新后语言和正文恢复；编辑/阅读只读状态与历史命名版本预览都能复制并播报“代码已复制”。服务端 JSON 导出仍为 `zhishu.document`，保留 codeBlock、blockId、language 和正文文本，不包含 NodeView DOM。历史版本 Provider 已接入相同的 `EditorCodeBlockView`。core/UI/消费者构建和 app-web 类型检查通过，控制台无错误；临时文档已彻底删除，导出文件已清理。

- [x] **UI-03 完善表格插入与上下文操作。** 提供表格插入、行列增删、表头切换、合并/拆分、列宽拖拽等受支持动作与位置反馈；先逐项核对 core/契约支持，不支持的动作先补能力。
  - 落点：editor-core 公开表格命令、editor-react 选区状态、editor-ui 表格操作组件。
  - 验收：单元格选择清楚，菜单不遮住当前内容；非法合并、尺寸上限和只读都有反馈；协同操作、保存重开与导出保留合法表格结构。
  - 当前进度（2026-10-01，未完成）：core 提供行列增删、表头切换、合并/拆分命令及 100 行/20 列上限；React store 投影当前表格尺寸和能力；Shell 默认挂载上下文操作菜单。Chromium 消费示例已验菜单出现、行列增删、只读禁用、单格合并禁用；合法合并将 9 格减为 8 格，拆分恢复 9 格；表头切换将 3 个表头单元格切为 0 个并可恢复。达到 100 行/20 列时新增按钮分别禁用并提供上限说明。320px 下工具栏完整位于视口内（x=26～177），576px 表格通过 196px 容器横向滚动，页面宽度保持 320px；截图 `output/playwright/zhishu-table-toolbar-320x740.png` 及 `output/playwright/zhishu-table-toolbar-1280x900.png`。应用级协同文档中从工具栏插入 3×3 表格、增行列后服务端序号升至 5，连接/同步/持久化均确认；刷新重开仍为 4×4；JSON 导出保留四行、四列、表格节点及 blockId。临时文档与下载已清理。协同模式下表格结构命令中的合并/拆分与表头切换尚未验收，因此本项保持未勾选。
  - 2026-10-03 完成验收：Edge 真实协同页 3×3 表格表头切换 0→3→0→3、多单元格选择、合并 9→8 格、拆分恢复 9 格；durable ack 后刷新仍为 9 格/3 表头。消费示例此前已验证尺寸上限、单格非法合并与只读反馈；结合本轮协同重开补齐门槛。证据 output/qa/table-presence-browser.log。
  - 2026-10-04 列宽拖拽补齐：启用 Tiptap 列调整插件，8px 拖动命中区、96px 单格最小宽度；Edge 消费样例将首列从 249px 拖至 329px，保存 JSON 后 `colwidth: [329]` 可恢复且版面宽度一致。只读态不显示拖动柄且尝试拖动不会改宽。390px 视口下表格容器 266px、内容 576px 横向滚动，页面没有横向溢出。截图：`output/playwright/zhishu-table-column-resize-1280.png`、`output/playwright/zhishu-table-column-resize-390.png`。core 构建、editor-ui 类型检查和 app-web 类型检查通过；本次尝试应用级快照保存时 API 端口 3000 已拒绝连接，因此新列宽只验了编辑器消费样例本地 JSON 保存/恢复，未把它记为服务端协同 ack 验收。

- [x] **UI-04 增加通用页脚与快捷键帮助。** 提供字数/字符数/阅读时间展示、命令提示与帮助入口，允许宿主通过插槽加入保存动作；组件可独立放置在知识库画布底部；与大纲、查找形成一致的展开和关闭体验。
  - 落点：`editor-shell.tsx`、新增统计/帮助组件及包导出；依赖 CORE-04、REACT-01。
  - 验收：页脚不会因数字更新跳动；按平台展示 Ctrl/Cmd；菜单、查找和大纲关闭后可回到编辑；统计与业务保存状态分别取自各自 owner。
  - 完成验收：新增公开 `EditorStatsFooter`，可独立挂载或由 `EditorShell statisticsFooter` 组合；快捷键原生 details disclosure 支持键盘开合，当前 Chromium 显示 Ctrl；390px 下 footer 宽 336px、页面宽 390px。统计数字使用等宽数字和预留宽度；宿主保存状态仍通过 `footerSlot` 组合，统计来自 editor-react store。历史页只读预览使用相同 footer。消费样例与 app-web 生产构建通过；截图见 P0-03。

- [x] **UI-05 优化在线成员与保存状态展示。** 在线成员采用紧凑头像/首字、溢出数量与成员详情；状态支持摘要与详情，默认突出“正在保存 / 已保存 / 保存失败 / 只读”。清楚保留连接、同步与持久化三类含义。
  - 落点：`editor-collaboration-participants.tsx`、`editor-collaboration-indicator.tsx`、`editor-shell.tsx`；光标适配需要时同步 editor-collaboration。
  - 验收：成员来自真实 presence，人数和自身标识正确；多名成员不挤压正文；断网或 pending 时不会仅因 connected/synced 显示“已保存”；颜色以外还有文字状态。
  - 当前进度（2026-10-01，未完成）：Presence 展示改为首字头像、五人后显示溢出数及原生 details 成员清单；协同保存摘要与连接/同步/持久化详情分开，默认状态不以 connected/synced 表示已保存。Chromium 真实文档验收确认当前用户详情、“已保存”摘要及“已连接 / 内容已同步 / 服务端已保存”详情；协同 `/table` 输入期间状态变为“正在保存（4 项）”，durable ack 后恢复“已保存”，截图 `output/playwright/zhishu-collaboration-status-1280x900.png`；发现并修复成员面板左溢出。多人溢出、键盘完整操作与保存失败状态仍待验。
  - 2026-10-03 完成验收：6 个真实同文档会话显示 5 个首字头像/+1，详情列出 6 人且仅一个自身标识；Enter 展开、Escape 关闭恢复焦点、外部点击关闭通过。隔离数据库注入保存失败，UI 明确显示“保存失败”并保留未确认草稿；移除故障、重新授权重放后 durable ack 才恢复“已保存”，刷新保留正文。连接、同步、保存详情各自表达；日志 offline-collab-{fail,recover}.log，截图 zhishu-collaboration-persistence-failed.png。

- [ ] **UI-06 完成亮色/暗色与触屏适配。** 补齐暗色语义变量、深色浮层、代码与表格状态、协作者标签、高亮文本和资源占位；应用提供亮色/暗色/跟随系统设置并保存偏好。细指针可用紧凑控件，粗指针操作目标至少 44×44px。
  - 落点：`packages/editor-ui/styles.css`、app-web 全局主题与设置入口。
  - 验收：320/375/768/1280/1440px 宽度下无整页横向溢出；浮层与抽屉适应可视区域；键盘焦点可见，禁用态仍可理解，支持减少动画偏好；切换主题后内容和会话保持连续。
  - 当前进度（2026-10-01，未完成）：应用已有跟随系统/亮色/暗色选择并保存 `zhishu.theme`，编辑器用主题变量映射；Chromium 暗色工作台截图见 `output/playwright/zhishu-app-dark-1280x900.png` 与 `zhishu-app-dark-390x844.png`，在 320/375/390/768/1280/1440px 下 document/body scrollWidth 均等于视口宽度。暗色编辑器代码/表格与抽屉、对比度和粗指针目标矩阵仍待验；后续页面检索遇到文档接口 502。
  - 2026-10-02 补充验收：Edge 亮/暗主题在 320/375/768/1280/1440 下 document/body 宽度均等于视口；截图 zhishu-knowledge-{light,dark}-{375,1440}.png。修复桌面工具栏侵入右侧大纲，按容器可用宽度换行；375/320 粗指针真实 context 中全部工具栏/查找/链接按钮至少 44×44，整页不溢出，截图 zhishu-knowledge-coarse-375.png。完整色彩对比度与跨浏览器输入法矩阵仍待检查。

### 应用业务打通

- [x] **APP-01 统一普通与协同编辑页的组合。** 复用同一套 Shell、工具条、统计、大纲和面板，应用只负责模式对应的加载、权限、会话、保存与失败恢复。按真实重复提取业务组件，路由负责组装。
  - 落点：`-document-standard-editor.tsx`、`-document-collaboration-editor.tsx`、`$documentId.tsx`。
  - 验收：普通模式保持显式保存与 snapshotRevision 冲突处理；协同模式依据 durable ack 显示保存结果；未确认修改离开提示与草稿导出正常；打开普通文档不会自动切换模式。
  - 完成验收：新增 `-document-editor-shell.tsx`，普通快照与协同编辑共用详情栏、EditorShell、工具栏、统计、大纲与查找组合；editor-ui 构建和 app-web 类型检查通过。Chromium 普通快照实际输入、显式保存至修订 2、刷新重开、切换阅读/编辑且仍保持普通模式；导航未保存正文时弹出确认，导出的 `zhishu.document` JSON 含本地草稿内容。协同文档已验 durable ack 摘要、连接/同步/持久化详情及模式切换不新建会话。普通快照冲突反馈与输入保留已在 P0-08 的 API 模拟中核验。手工 QA 文档与临时导出文件已清理。

- [ ] **APP-02 完整接通附件与资源状态。** 核对两种模式的宿主服务配置，当前普通编辑页未像协同页一样注入上传/资源解析服务；按服务端能力补接或明确禁用原因。完善上传、失败重试、取消、资源读取失败及短时授权失效后的恢复反馈。
  - 落点：两个文档编辑页、附件业务服务、editor-react 宿主服务和 editor-ui 上传/资源组件。
  - 验收：普通/协同分别完成“选择文件 → 上传确认 → 有效位置插入 → 保存 → 重开可读”；目标消失或取消不插入内容；只保存 assetId 与合法元数据，临时授权 URL 不进入正文。
  - 当前进度（2026-10-01，未完成）：新增共用文档级附件宿主服务并注入普通与协同 Provider，保留 transient/503 会话以便复用幂等键重试，取消/卸载清理未完成会话；app-web 类型检查通过。Chromium 普通快照选取图片后看到可重试/取消反馈，正文没有插入未完成资源；上传会话接口返回 503，代码显示对象存储未配置时会拒绝创建会话。新增可选单节点 Garage Compose 服务、持久卷、健康检查和开发环境变量示例；待启动服务并对普通/协同模式完成实存储上传、保存重开和短时 URL 恢复验收。
  - 2026-10-02 配置调整：按用户要求仅配置 MinIO HTTP/80，不连接、不测试 minio.8and1.cn。示例与本地 .env 已设置 endpoint、关闭自动建桶和启动连接检查；未提供实际密钥，开发环境未填凭据时禁用附件服务。上传/资源恢复的实存储验收延期，本项保留未勾选。

- [x] **APP-03 优化分享、版本与传输面板。** 桌面使用侧栏或 Dialog，窄屏使用抽屉；展示真实 ACL、版本列表和导入导出结果。分享链接明确访问条件，主体目录缺失时如实使用现有主体 ID 授权入口。为导出标明“服务端已保存内容”，格式损失在继续前展示。
  - 落点：`-document-share-panel.tsx`、`-document-versions-panel.tsx`、`-document-transfer-actions.tsx`。
  - 验收：复制链接有结果反馈且不代表公开授权；版本预览使用独立只读实例；恢复前确认影响并处理新修订/代次；面板关闭保留当前草稿和焦点；接口错误就近提供恢复动作。
  - 当前进度（2026-10-01，未完成）：Chromium 实际打开分享权限面板，展示真实 ACL 空态、授权主体范围说明与未开放权限说明；打开版本列表并查看独立只读正文预览。新增复制文档链接按钮，明确链接本身不会授予访问权限，Chromium 点击后收到复制成功状态。分享、版本与传输共用响应式面板：320px 贴底全宽且页面无横向溢出，1280px 为居中 Dialog。协同表格 JSON 导出已保留完整结构；面板焦点回归、版本恢复冲突和其它格式损失确认仍待验。
  - 2026-10-03 完成验收：分享、版本、传输三个真实面板 Escape 关闭后均回到原触发器，正文实例连续；此前 320/1280 响应式和 ACL/独立只读历史预览已验。真实服务端 smoke 覆盖修订冲突、普通历史恢复、升级及恢复新代次且旧历史不变；HTML/JSON/Markdown 下载及格式损失确认/取消通过。日志 cache-denial-panels-browser.log、knowledge-smoke.log、extensions-roundtrip-browser.log；附件仍遵守 APP-02 的实存储延期。

- [x] **APP-04 接入编辑/阅读模式与文档元信息。** 通过包级配置切换编辑工具、菜单和节点可编辑状态，应用保留查找、大纲及有权限的导出/分享；接入 Emoji、彩色标签等元信息时同步后端契约、存储与修订控制。作者、更新时间和相关文档均使用真实数据。
  - 落点：editor-ui Shell 配置、editor-react 可编辑状态、app-web 文档页头/右栏、app-server documents 模块。
  - 验收：阅读模式不改变文档模式或内容，不重建协同会话；用户返回编辑模式不能越过服务端只读限制；元信息修改保存后刷新可恢复，冲突不覆盖用户输入。
  - 当前进度（2026-10-01，未完成）：文档页新增按文档保存的编辑/阅读视图偏好，普通与协同 Provider 通过即时 `editable` 切换；Shell 可隐藏编辑工具同时保留查找、大纲和业务分享/导出，协同 Provider 不因切换重建。Chromium 实际协同页验证阅读模式隐藏格式工具、保留查找/状态，返回编辑恢复工具且切换前后没有新协同会话请求；截图 `output/playwright/zhishu-document-reading-mode-dark-1280x900.png`。editor-ui 构建和 app-web 类型检查通过。开发 API 在热更新期间曾短暂 502/401，重新登录后完成该验收；Emoji/标签等持久化元信息尚未接入。
  - 2026-10-02 完成验收：迁移 0023、Zod/OpenAPI/Orval 与 PATCH metadataRevision 接通单个 Emoji、12 个去重彩色标签及真实 createdBy。隔离 PostgreSQL smoke 覆盖非法图标、重复标签、修订冲突、保存重开、历史恢复后元信息保留。Edge 浏览器真实保存图标/紫色标签、刷新重新登录后恢复；阅读模式隐藏格式工具但保留查找，切换和元信息保存均保持同一正文 DOM。详情栏已移除过时的接口缺失说明；相关文档尚无业务关系，因此没有展示虚构数据。

### 知识库业务能力

- [x] **KB-01 接入工作区和递归文档树。** 定义工作区、文档父子关系、顺序、权限和移动契约；应用提供展开/收起、新建子页、重命名、删除及拖拽落点提示。实现真实祖先面包屑与工作区切换，保留收藏/最近/全部/回收站入口。
  - 落点：app-server 对应领域模块和数据库迁移、OpenAPI、app-web 导航与文档 feature；不进入 editor-core。
  - 验收：支持多级嵌套及键盘可替代的移动操作；防止移入自身/后代；跨工作区移动校验权限；删除/恢复的子树语义明确；刷新保留顺序，空工作区和失效路径可恢复。
  - 2026-10-02 完成验收：迁移 0024 建立租户工作区、父子关系、排序、默认工作区回填；生成工作区/tree/location API。目录提供递归展开、子页创建、原位重命名、回收站、原生拖拽落点及移动 Dialog。树按 ACL 过滤并将隐藏父页的可见子页安全放到根目录；64 层上限、循环/修订/跨租户/跨工作区子树所有权由服务端校验。隔离库 smoke 覆盖以上边界、顺序和删除父页后子页保留；Edge 真实新建子页、Enter 重命名、移动 Dialog 与原生拖拽均写入 API，真实祖先面包屑随移动更新。

- [x] **KB-02 接入 Cmd/Ctrl+K 全局搜索。** 参考搜索弹窗的信息层级，实现标题与正文检索、匹配片段、路径、键盘选择和跳转；先以真实可用的检索范围交付，正文模糊检索需要时补服务端索引。
  - 落点：app-server 搜索/文档模块、app-web 全局命令入口与 Dialog、Orval 生成接口。
  - 验收：结果只包含当前身份可访问的文档；新输入取消旧请求；方向键/Enter/Escape、中文输入法和焦点回归正常；加载/空态/失败可恢复，跳转后重新校验权限；与编辑器链接快捷键按焦点作用域协调。
  - 2026-10-02 完成验收：真实 PostgreSQL 标题与快照正文检索，协同读取当前 generation 投影；按权限、租户和工作区过滤，支持字面 %/_、片段与可见祖先路径。smoke 证实读者可搜授权子页且不会泄露隐藏祖先，其他身份/租户无结果。Ctrl/Cmd+K Dialog 支持防抖/取消、标记关键词、全工作区、方向键/Enter/Escape 和焦点回归；Edge 正文 durable 搜索、键盘跳转及选中文本 Ctrl+K 打开链接面板通过。组合态保护已实现，真实中文输入法设备矩阵仍在 CHECK-04 中保留。

- [x] **KB-03 提供 3 篇完整预设知识文档。** 准备产品规范、系统架构、团队协作指南等高质量中文示例，包含标题层级、任务、代码、表格和适用的扩展块；提供开发示例与显式业务初始化入口。
  - 落点：`examples/editor-consumer`、应用模板/初始化业务；复用合法文档契约。
  - 验收：预设内容可真实编辑、保存、导出；初始化不会重复创建或覆盖已有文档；新用户自主创建内容后不会因刷新重新播种；扩展未就绪时采用当前支持的内容。
  - 2026-10-02 完成验收：document-contracts/examples 提供三篇产品规范、系统架构、团队协作中文文档，独立消费示例与显式业务初始化复用。预设含合法标题、任务、代码、表格；初始化事务按身份/工作区记永久安装标记，不覆盖用户正文、重复创建或复活已删除样例。隔离库 smoke 对三篇均完成 GET/PUT/JSON 导出并验证重复/删除后初始化；修复 JSONB 键顺序造成的内容哈希不一致，复用保存的规范化哈希。Edge 真实编辑任务并显式保存，下载 Markdown、独立 HTML、JSON 成功。

## 5. P2：扩展能力与离线增强

以下为后续增强项，不作为 P0/P1 视觉与主流程完成的前置条件。每项开始前先确定内容契约、兼容规则和具体用户用途。

- [x] **EXT-01 提示块、状态标签与带标签分隔线。** 参考 Callout、StatusBadge、DividerWithLabel，在 core 定义节点、属性、命令与序列化，react 提供交互适配，ui 提供主题、编辑入口与只读外观。Callout 包含 info/tip/warning/success/danger 五主题及选区转换，状态标签覆盖待办/进行中/评审中/已完成/阻塞，分隔线标签支持原位编辑。状态标签先表达文档内文本状态；需要绑定业务状态时由应用明确接入。
  - 验收：插入、编辑、删除、撤销重做、普通/协同保存、旧客户端兼容和格式转换都有定义；禁止只实现能显示却不能持久化的视图。
  - 2026-10-03 完成验收：Schema v5 注册五主题 callout、五状态 statusTag、80 字标签分隔线，迁移 0025 只应用隔离 QA 库；旧 v4 可写会话拒绝、新 v5 接入成功，普通升级与历史保留原代次格式。真实普通/协同保存重开、历史、HTML 往返、Markdown 损失提示、搜索状态/标签、只读展示通过。Slash 转提示块、删除最后根块后补合法段落并重开、普通独立撤销/重做通过；双端受控包裹/切主题/解包保留子 blockId。状态标签固定外观，混合选区格式作用文字，普通/协同行内撤销重做均保存重开；协同外层结构不进入本地撤销栈。日志 content-node-delete-browser.log、marked-status-browser.log、recovery-structure-smoke.log。

- [ ] **EXT-02 成员提及。** core 定义稳定提及内容，react 提供可取消的候选查询接口，ui 提供 `@` 搜索、键盘选择、身份色/头像药丸与职位提示；应用与服务端负责可见成员、访问权限与通知。若成员服务尚未具备，保持为后续任务。
  - 验收：候选来自真实可访问成员；无结果、请求失败、成员失效有反馈；展示名称与稳定身份分开；不会把参考中的预设成员当成业务数据。
  - 2026-10-03 前置核对：仓库仍未提供真实可见成员目录/通知服务。按本项约定保持后续任务，不使用参考预设成员模拟业务提及。

- [x] **EXT-03 打印与 Markdown 导出。** UI 提供仅正文的打印布局，应用提供入口与导出范围说明；Markdown 转换由 core 提供并报告无法保留的内容，复用现有导出业务权限。
  - 验收：打印隐藏导航、工具栏与操作浮层，长代码/表格有合理分页；Markdown 处理嵌套内容和特殊字符，转换损失明确展示；不直接复制参考项目基于正则替换 HTML 的转换逻辑。
  - 2026-10-02 完成验收：core AST 转换输出 CommonMark/GFM，支持嵌套列表、任务、代码动态围栏、表格与特殊字符，并报告下划线/高亮/对齐/合并单元格/私有附件损失；独立 HTML 含转义标题、安全 CSP 与打印 CSS。应用复用服务端导出权限，只导出已保存正文。Edge 下载三种格式，实际下划线文档先显示 Markdown 格式损失确认，取消不下载；打印窗口不包含导航/工具栏，表格使用 thead、代码打印自动换行。打印调用由 QA stub 接管以避免系统对话框，截图 output/playwright/zhishu-knowledge-print.png；未验证真实打印机。

- [x] **EXT-04 任务完成微动效。** 在包内提供可配置的勾选过渡和完成礼花，应用决定是否启用；状态呼吸点与浮层淡入遵循相同的减少动画约定。
  - 验收：只在本地用户由未完成改为完成时触发；加载、撤销重做、远端同步和恢复文档不会反复播放；可关闭、可清理，动效不阻塞输入和保存。
  - 2026-10-02 完成验收：core 只在可信本地任务 checkbox 从未完成到完成且事务被接受后发出完成事件，Shell 可选择消费，应用开关默认关闭并保存个人偏好。Edge MutationObserver 记录本地勾选仅一次粒子；撤销/重做不新增、禁用不新增，减少动画时抑制并清理。事件按 Shell 隔离，关闭/卸载释放监听和 700ms 定时器，不写入文档内容。

- [x] **DATA-01 离线缓存与恢复。** 应用缓存授权范围内的目录、文档元信息和正文，LocalStorage 保存界面偏好，IndexedDB 保存正文/草稿和待同步数据。协同缓存接入现有协同适配，普通草稿携带基础修订号；恢复后与服务端校验并处理权限、修订或 generation 变化。
  - 落点：app-web 缓存与恢复业务、需要时补充 editor-collaboration 的持久化适配；editor-react 提供必要状态，editor-ui 展示反馈。
  - 验收：刷新可恢复缓存目录与正文，断网时明确展示可用范围和未确认修改；重连不会静默覆盖较新服务端内容；按身份/工作区/文档/版本隔离，登出及权限失效后按策略清理；存储满、升级失败可提示并导出草稿。
  - 2026-10-03 完成验收：生产 Service Worker 缓存公共页面资源，IndexedDB 按 API/租户/身份/工作区/文档/格式/代次隔离授权读取、普通基础修订草稿和协同未确认原生更新，不保存凭据。Edge 已验普通断网刷新恢复目录/正文/草稿→重新登录→显式保存→重开；较新服务端修订拒绝覆盖，冲突导出有效知书 JSON。协同数据库保存失败→缓存更新→离线只读刷新→重新授权重放→durable ack→重开，以及 generation 变化保留导出而不重放通过。登出清理缓存且离线不可再读；服务端 404 不回退缓存，并移除受影响目录/正文、保留未确认草稿。模拟 QuotaExceededError 和真实 IndexedDB 版本错误均提示并可导出内存草稿；缺失静态资源导致 worker 安装失败会提示且不启用不完整缓存。日志 offline-{standard-browser,conflict-browser,collab-recover,collab-conflict,storage-failure,shell-failure}.log、cache-denial-panels-browser.log。

## 6. 实施顺序与验收记录

| 阶段            | 依赖顺序                                               | 可交付结果                                                          |
| --------------- | ------------------------------------------------------ | ------------------------------------------------------------------- |
| A：视觉基线     | P0-01 → P0-02 → P0-03～06                              | 包级主题、排版、菜单与现有节点体验可独立消费                        |
| B：系统与编辑页 | 阶段 A → P0-07～11                                     | 三栏布局、右侧大纲、文档页头与工作台外观统一                        |
| C：通用能力     | CORE-01～04 → REACT-01～02 → UI-01～06                 | 常用格式、节点交互、统计、状态与主题形成完整能力                    |
| D：编辑业务接入 | 阶段 C → APP-01～04                                    | 普通/协同、阅读模式、元信息、附件、分享与版本闭环                   |
| E：知识库业务   | KB-01 的工作区与目录契约 → KB-02；KB-03 复用已支持内容 | 真实目录树、面包屑、权限内搜索与预设知识文档；可与阶段 C/D 独立推进 |
| F：后续增强     | 对应契约和业务前置就绪 → EXT-01～04、DATA-01           | 通用扩展节点、提及、输出格式、完成动效与离线恢复                    |

每个功能包先在 `examples/editor-consumer` 验证，再接入应用。每项勾选完成时记录对应实现位置、验证结果和仍有条件限制的行为；文档中既有的“已验收”描述需与当前实现重新核对。

- [x] **CHECK-01 包独立性。** 默认主题、自定义主题、多实例和无默认 UI 的消费方式都可用；包没有反向依赖应用代码；宿主不需要复制编辑器内部 CSS 或命令实现。
  - 2026-10-03 完成验收：`examples/editor-consumer` 公开 exports 消费默认/自定义暗色主题与双实例；独立 `bare.html` 入口只消费 editor-react/core，由宿主按钮调用公开加粗命令，无 editor-ui/应用模块/编辑器 CSS 请求，浏览器成功执行。Vite 多入口构建同时输出 main/bare，无源码 alias；packages 源码未发现 app-web/app-server 反向引用。日志 output/qa/lifecycle-browser.log、consumer-touch-browser.log，截图 output/playwright/zhishu-bare-consumer-390x844.png。
- [ ] **CHECK-02 编辑与持久化。** 中文输入、快捷键、混合格式、复制粘贴、撤销重做、任务清单、表格、代码、图片/PDF覆盖普通/协同/只读；新增格式保存重开和导入导出符合约定。
  - 2026-10-03 补充：新增 v5 节点普通/协同、只读、历史和 JSON/HTML/Markdown 已验；状态标签混合文字格式及两种模式撤销/重做通过。图片/PDF 的实存储和真实中文输入法仍按用户 MinIO 免测要求及 CHECK-04 保留。
- [ ] **CHECK-03 业务与异常。** 创建 → 编辑 → 保存 → 重开 → 分享 → 版本预览/恢复完整可操作；覆盖保存冲突、断网重连、权限变化、上传失败/取消、资源失效与离开草稿处理。知识库能力完成后验证切换工作区 → 新建/移动子页 → 面包屑回退 → 搜索正文 → 阅读跳转；离线能力完成后验证刷新恢复与重连冲突。
  - 2026-10-03 补充：已验协同真实数据库失败、离线刷新、durable 重放、代次冲突和普通重连修订冲突；登出、404 缓存清理与草稿导出通过。附件 URL 失效/实际上传验收按用户要求延期。
- [ ] **CHECK-04 视觉与可访问性。** 在目标宽度、亮暗主题、长标题、长文档、空内容下留存同一份样本截图；覆盖左右栏展开/收起、移动端抽屉、编辑/阅读模式与搜索弹窗；检查重复标题定位、键盘顺序、焦点回归、可读名称、文本对比度、触控尺寸和输入法；截图存放 `output/playwright/`。
- [ ] **CHECK-05 性能与生命周期。** 长文档输入和选区移动不引起全页重复渲染；统计按内容变化更新；展开面板与切换主题不重建编辑器；卸载释放监听、观察器与请求。沿用 `docs/README.md` 的性能目标并记录测量环境。
  - 2026-10-03 补充：协同检查点复用正文投影，状态变化不反复序列化；草稿本机保存提示延迟至空闲更新。结构操作生命周期标识丢弃旧回调，worker 升级阻塞请求最终关闭数据库连接。尚未完成文档地图要求的固定长文档 P95/20 人/100ms 网络基线测量，本项不勾选。
  - 2026-10-03 长文档抽样：Windows、i7-13650HX（14 核/20 线程）、32GB、Edge 154；1000 块/1,061,806 字节，35 次输入的 beforeinput→第二帧 P95 40.5ms、最大 41.7ms；HTTP 模拟 100ms 网络延迟时显式保存 364ms，保存保持同一编辑器，刷新恢复全部 1000 块及 ID/正文。证据 output/qa/long-document-performance.log。该环境高于文档地图参考配置，20 人协作/远端可见和卸载仪器化仍待固定基线，本项保留未勾选。
  - 2026-10-03 生命周期补充：已完成上列 REACT-01 的渲染/序列化与 12 轮双实例卸载仪器化；订阅、观察器与请求无残留，统计定时器未在卸载后继续发布。20 人/100ms WebSocket 延迟及文档地图参考硬件基线仍待验，本项继续保留未勾选。
  - 2026-10-03 协作传输基线：新增可复现 `examples/collaboration-consumer` smoke:performance，隔离 PostgreSQL、1000 块/1,032,806 字节、20 个真实会话轮流写入，TCP 代理对实际 WebSocket 双向各延迟 50ms。5 次预热后 35 次采样，优化前远端全部 19 个 Y.Doc 可见 P95 624.3ms，超出 500ms 目标；CPU 采样后移除规范内容比较中的反复全文序列化、结构投影的多余深拷贝/UTF-8 分配，并复用一次结构投影，优化后 P95 426.8ms、最大 431ms，durable ack P95 422.1ms、最大 425.2ms。35 次更新都取得真实 PostgreSQL 回执；同一认证身份的 20 个会话，不代表 20 个不同用户，也未测远端浏览器绘制。客户端/服务端同机、Windows/i7-13650HX/32GB/PostgreSQL 15 Docker，参考硬件与跨机 UI 基线继续待验。日志 output/qa/collaboration-performance.log，前后失败记录与 CPU profile 保留在 output/qa。
  - 2026-10-03 扩展位置矩阵仍失败：上述通过样本编辑首段。新增 `PERFORMANCE_POSITION_MATRIX=true` 轮流编辑第 0/500/999 块，35 次采样远端 Y.Doc P95 857.9ms、最大 980.5ms，durable ack P95 834.1ms（仍在 2s 内）；首段样本的成功不能推广为整篇文档已达标。继续定位同机 20 客户端压力下的延迟波动，并补固定参考环境/远端绘制验收。失败记录 output/qa/collaboration-performance-position-matrix.log；性能项不勾选。
- [x] **CHECK-06 工程与文档。** 实现完成后按仓库约定执行 `pnpm format`、`pnpm check`，按实际改动统一补充并运行必要的关键流程验证；同步 `docs/packages/editor-{core,react,ui}.md`、`docs/apps/app-web.md` 与相关契约/协同文档，更新已过时的 API、主题和控件尺寸说明。验收命令与结果在实施时记录，本次清单生成不代表这些检查已经通过。
  - 2026-10-02 验收记录：本轮功能已通过 pnpm format、pnpm check（格式/lint/类型/所有包与示例构建/离线 OpenAPI/Orval 漂移）、隔离库 smoke:knowledge、协同双客户端 smoke 与结构操作 smoke。版本 smoke 已同步 mode 参数契约。README、应用、core/UI/内容契约文档更新。本轮后续修复仍会再次执行必要工程检查；全 TODO 的其他未完成项保持未勾选。
  - 2026-10-03 本轮工程验收：pnpm format、pnpm check 全部通过（格式/lint/类型/所有包及示例 build/离线 OpenAPI/Orval 漂移），隔离 PostgreSQL smoke:knowledge 与双客户端结构回归再次通过。同步 README、core/react/UI、内容契约、协同及两份应用文档。数据库迁移只在独立 QA 库执行，未改项目数据库，也未连接 MinIO；其他功能/真实设备门槛依其条目保持待验。日志 output/qa/final-check.log、knowledge-smoke.log、recovery-structure-smoke.log。
  - 2026-10-03 续作验收：新增生命周期/独立无 UI 消费入口、触屏操作和协作性能 smoke；相应边界与性能修复通过浏览器综合验收、隔离库知识 smoke（含表格默认值/JSON 键序等价）及双端结构/重连回归。完整 pnpm format/check 记录见 output/qa/lifecycle-final-check.log；本轮仍未连接 MinIO。
