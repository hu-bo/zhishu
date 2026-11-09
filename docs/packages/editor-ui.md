# editor-ui 设计规划

2026-10-22 新增 `EditorReplacementReview`，也可通过 `EditorShell replacementReview` 安装在正文下方。建议内容采用主题强调色，旧内容置灰划线，每处建议提供 ✓ / ×，分别接受/拒绝该块；底部提供修改计数、上一处/下一处、全部拒绝与全部替换，批量操作仅处理剩余建议。底栏采用 4px 容器与 3px 工具条上下 padding，按钮最小高 28px。preview、stale、busy、disabled、error、onAcceptBlock/onRejectBlock 与批量动作回调由宿主提供；过期或禁用时不能提交，忙碌时防重复操作。组件不修改正文或请求接口。桌面、390px 手机和亮暗主题已截图检查，预览期间保持原编辑器及协同会话挂载。

代码块视图通过 `EditorProvider nodeViews.codeBlock` 可选安装 `EditorCodeBlockView`，提供暗色语言栏、复制反馈与节点级错误重试；视图外壳不进入文档 JSON，长代码只在代码块内横向滚动。core 通过 ProseMirror 装饰为 JavaScript/TypeScript、Python、SQL、Bash、JSON、Go 等语言着色；语言语法按实际代码块动态加载，未知语言保留纯文本。代码语言选择器继续复用文档节点的 `language` 属性，装饰和高亮缓存不写入正文。

历史版本预览也通过 `nodeViews.codeBlock` 使用相同视图；只读状态禁用语言编辑，保留代码复制和反馈。

状态：M1 基础组件已实现，M2 图片/PDF 上传和查找基础接入中。对应 `packages/editor-ui`；[返回文档地图](../README.md)。当前提供 `EditorShell`、键盘可操作的 `EditorToolbar`（含混合格式态和可选图片上传动作）、只读原因、基础 `EditorOutline`、可选 `EditorFindPanel`（计数、循环导航、定位）、宿主标题/头部/底部插槽、窄屏大纲折叠、可选 `EditorSelectionMenu`、`EditorSlashMenu`、`EditorBlockMenu`、`EditorLinkEditor`、`EditorCollaborationIndicator` 和 `EditorCollaborationParticipants`；代码块选中时显示可访问的语言选择器；图片读取通过宿主 `resolveAssetURL` 临时写入展示 DOM。样式通过 `@zhishu/editor-ui/styles.css` 显式引入且仅作用于包内类名。当前只在 Chromium 消费样例中验证了 390px 和 320px 视口；用户已在打开的编辑器中验收系统中文 IME，无漏字/乱序，候选框期间 Enter/方向键正常。Firefox、Safari 和完整浏览器/版本矩阵尚未验收，因此暂不承诺这些环境。Chromium 中已确认折叠大纲、菜单定位/键盘/焦点恢复、Block 单机操作、链接编辑和外链确认行为；协同查找已验跨 Block 大小写不敏感命中、结果计数、循环导航与锚点定位，拆分/合并和远端 Block 移动后的锚点也已验收。协同模式下结构改动必须走服务端结构命令，本地原生 drag-to-drop 当前不提交结构操作。

## 1. 产品职责

协同成员摘要使用临时 Presence 数据展示首字头像、在线人数和超出头像数；原生 `details/summary` 可用键盘展开完整名单并标出当前用户。协同状态默认只显示服务端保存摘要，展开后分别显示连接、正文同步、待持久化项和 durableSeq；“已连接”或“内容已同步”不会替代“已保存”。

提供完整且可替换的默认编辑界面，让接入方快速获得一致的工具栏、菜单、Block 操作和状态反馈。宿主可以只使用部分组件，也可以完全采用自定义界面。

本包不请求企业 API、不维护文档列表/空间路由、不存储权限和评论。协同、AI、附件与评论通过状态模型、动作回调和插槽接入，缺少能力时不要求安装对应运行时。

### 视觉规格与对照样本

下面区分参考源码观察值与知书的落地选择。参考值来自 `syncscribe/src/App.tsx`、`src/index.css`、`KnowledgeSidebar.tsx`、`DocumentHeader.tsx` 和 `TableOfContents.tsx`；表中的知书值是目标规格，不表示当前所有组件已经达到该规格。

| 项目             | syncscribe 参考                       | 知书首版选择                                           |
| ---------------- | ------------------------------------- | ------------------------------------------------------ |
| 工作区背景       | Slate 100；暗色 Slate 950             | Slate 50/100 层次，暗色 Slate 950                      |
| 面板与正文       | 白色；暗色 Slate 900                  | 白色正文面板，暗色 Slate 900                           |
| 主文字与辅助文字 | Slate 900/100 与 Slate 600/300        | 正文 Slate 900/100，辅助 Slate 600/400                 |
| 品牌与选中态     | Indigo 500/600，低透明度 Indigo 底色  | Indigo 600 为主色，焦点和轻提示用 Indigo 低透明度底色  |
| 字号与行高       | 界面约 12–14px；正文使用舒适行距      | 界面 14px；正文 16px、行高 1.75                        |
| 内容宽度         | 外层 `max-w-5xl`，正文 `max-w-4xl`    | 外层上限约 1024px，正文上限约 896px；可由宿主覆盖      |
| 导航与大纲       | 左栏展开 288px、收起 56px；右栏 288px | 桌面起点采用同样宽度，中小屏改抽屉                     |
| 控件与图标       | 紧凑图标工具栏，图标约 14–16px        | 图标 16px；触屏按钮至少 44×44px                        |
| 边界、圆角与阴影 | Slate 200/800 细边界；浮层更强阴影    | 边界 Slate 200/800；面板圆角 10–14px；浮层使用语义阴影 |

稳定对照内容位于 `examples/editor-consumer/src/visual-review-content.ts`，并由消费样例首页加载。内容固定包含长中文标题、长段落、列表、任务项、TypeScript 代码、表格、引用、图片和 PDF 附件；在排版、主题与节点样式改动时复用同一份 JSON。附件使用明确的演示 asset ID，只检查占位、约束和选中外观，不代表有效存储资源。

检查顺序：先看 1440px 和 1280px 桌面正文宽度与左右栏关系，再看 768px 和 390px 窄屏换行与横向溢出；随后检查标题、中文段落、任务完成态、长代码、宽表格和图片占位。正式视觉验收截图保存在 `output/playwright/`；该目录存在截图后才记录截图验收结果。

默认工具栏只在宿主提供 `requestUpload` 时显示图片/PDF 附件按钮，可上传 PNG/JPEG/WebP/PDF 并通过 OperationBatch 插入对应 Block；宿主的 `resolveAssetURL` 只为当前 DOM 请求短时访问地址，PDF 链接只在 DOM 中设置且绕过普通外链拦截。上传期间显示忙碌状态并可取消；取消会 abort 当前请求并调用可选 `cancelUpload(file)` 清理宿主预留资源，取消成功不插入正文。失败会保留可重试文件，并提供可访问的重试和取消操作。宿主未提供资源解析器、解析失败或浏览器图片尚未加载时，图片与 PDF 保留包级占位并显示状态；选中节点有统一边框反馈。表格在窄屏保持局部横向滚动，选中单元格使用主题强调色，编辑态列边界可拖动调整宽度。选中图片时 `EditorShell` 显示图片属性面板，可编辑替代文本和可选宽高，保存只更新图片属性、不更换 assetId。尺寸必须为 1–32768 的整数，清空尺寸会恢复自动布局。上传中的进度比例仍未实现。错误通过可访问状态文本及宿主错误回调呈现。PDF 协同插入已获 durableSeq 3；无身份访问返回 401，授权 URL 从本机 MinIO 读取成功并与源文件 SHA-256 一致。生产存储故障恢复仍待验收。

协同状态由 `EditorProvider` 投影，`EditorShell` 默认在头部展示 `EditorCollaborationIndicator`，也可用 `collaborationIndicator={false}` 隐藏，或单独挂载该组件。连接、内容同步和持久化分别显示；已连接或已同步不会被当作已保存，待保存数、失败状态和服务端 durableSeq 单独呈现。它只展示状态，不创建 Provider，也不提供失败更新的重试/导出动作；宿主仍需接入协同会话及恢复流程。

`EditorShell` 默认显示 `EditorProvider` 收到的最多五个 Awareness 参与者名字和颜色标记；可通过 `collaborationParticipants={false}` 隐藏。clientId 只区分本地协同会话，不代表登录用户；名字与颜色由签名会话票据绑定到可信主体，服务端覆盖客户端自报展示字段。Hocuspocus session 在 `EditorProvider` 创建编辑器时自动安装相对选区光标装饰扩展，撤权/过期时撤下本地 presence。

## 2. 组件与功能地图

| 编号  | 组件/功能                       | 必须考虑的交互                                                  | 阶段                    |
| ----- | ------------------------------- | --------------------------------------------------------------- | ----------------------- |
| UI-01 | `EditorShell` / `EditorToolbar` | 标题区域插槽、基础格式、选中/混合状态、只读、禁用原因、窄屏折叠 | M1                      |
| UI-02 | 选区浮动菜单                    | 文本选区、代码/链接等特殊内容、滚动定位、失焦与 IME 暂停        | M1                      |
| UI-03 | Slash/插入菜单                  | 搜索、分组、键盘移动、空结果、Esc、能力过滤、触屏入口           | M1                      |
| UI-04 | Block 手柄/菜单                 | 选择、复制、删除、类型转换、上下移动、拖拽落点与不可用反馈      | M1；协同移动依赖 D-03   |
| UI-05 | 链接编辑器                      | 新建/修改/移除、URL 校验、显示文本、打开链接的确认式操作        | M1                      |
| UI-06 | 历史/定位工具                   | 撤销/重做状态、大纲、文内查找、命中定位和返回编辑位置           | M1 基础；M2 完整        |
| UI-07 | 图片/附件面板                   | 选择/粘贴、上传进度、取消、重试、替代文本、尺寸、失效预览       | M2                      |
| UI-08 | 表格工具                        | 行列操作、表头、合并拆分、选择状态、边界禁用、窄屏滚动          | M2                      |
| UI-09 | 协同展示                        | 头像/在线列表、光标样式、跟随入口、连接/保存状态、只读原因      | M2；跟随视图可后续交付  |
| UI-10 | AI 交互插槽                     | 动作菜单、指令输入、流式草稿、差异预览、接受/拒绝/取消/冲突     | M3                      |
| UI-11 | 评论与引用插槽                  | 锚点装饰、未读/已解决、来源卡片、缺失来源状态、面板焦点         | M3，数据由 app-web 管理 |
| UI-12 | 主题与可访问性                  | 明暗主题、国际化、键盘、屏幕阅读、触屏、减少动画                | M1 起持续               |

工具栏只展示当前扩展支持的操作，命令是否可执行来自 `canExecute`，而不是各组件重新实现一套编辑规则。隐藏、禁用、解释原因分别依据产品场景决定。

## 3. 公共配置与宿主插槽

| 配置                                      | 用途                         | 约束                                              |
| ----------------------------------------- | ---------------------------- | ------------------------------------------------- |
| `locale / messages`                       | 文案、快捷键提示、状态文本   | 包内有默认文案；宿主可完整替换，不硬编码企业名称  |
| `theme / className / style tokens`        | 外观与密度                   | 不改变内容 Schema，不覆盖宿主全局样式             |
| `contentMaxWidth / compact`               | 配置正文宽度与紧凑布局       | 宽度接受 CSS 长度或像素数；默认正文最大宽度 896px |
| `outlinePlacement`                        | 将内置大纲放在正文起始或末尾 | 默认 `start` 维持兼容；应用文档页使用 `end`       |
| `--zhishu-ui-outline-width`               | 调整内置大纲栏宽度           | 默认 220px；桌面应用主题映射为 288px              |
| `stickyToolbar / toolbarOffset`           | 固定工具栏及其顶部偏移       | 偏移使用 CSS 长度；由宿主滚动容器提供滚动上下文   |
| `editingControls`                         | 隐藏编辑工具和写入浮层       | 阅读模式保留正文、查找、大纲、统计及业务插槽      |
| `toolbarItems / insertItems`              | 按能力组合菜单               | actionId 与 core 命令关联，稳定键盘顺序           |
| `collaborationStatus / participants`      | 在场与保存显示               | 读取 CO 的状态投影；不创建 Provider               |
| `aiPanel / commentsPanel / sourcePreview` | 业务与能力插槽               | 只接收所需上下文和回调，不持有业务数据所有权      |
| `onActionError / onRequestUpload`         | 宿主处理反馈与服务           | 异步过程支持取消并在当前文档校验目标              |

### 主题变量

宿主使用 `--zhishu-ui-*` 变量调整单个 `EditorShell`，在该实例的 `className` 上设置变量，或用 `.zhishu-ui-theme` 包裹独立组合的组件。变量从最近的主题容器继承，所以同一页面的实例可以使用不同主题。

| 变量                                                                                          | 影响范围                                          |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `--zhishu-ui-surface`、`--zhishu-ui-canvas`                                                   | 面板、正文画布与正文纸面                          |
| `--zhishu-ui-text`、`--zhishu-ui-muted`                                                       | 正文、标题、说明和次级状态文字                    |
| `--zhishu-ui-border`、`--zhishu-ui-border-subtle`                                             | 控件边界、分隔线与正文横线                        |
| `--zhishu-ui-accent`、`--zhishu-ui-accent-soft`、`--zhishu-ui-hover`、`--zhishu-ui-focus`     | 强调、选中、悬停与焦点状态                        |
| `--zhishu-ui-danger`、`--zhishu-ui-success`、`--zhishu-ui-warning`                            | 错误、成功和待处理状态                            |
| `--zhishu-ui-shadow`、`--zhishu-ui-floating-shadow`、`--zhishu-ui-radius`                     | 面板、浮层的层级与圆角                            |
| `--zhishu-ui-radius-compact`、`--zhishu-ui-radius-control`、`--zhishu-ui-radius-floating`     | 紧凑控件、常规控件和浮层圆角；默认 7px、9px、11px |
| `--zhishu-ui-selection-surface`、`--zhishu-ui-selection-text`、`--zhishu-ui-selection-border` | 选区浮动菜单                                      |
| `--zhishu-ui-control-height`、`--zhishu-ui-outline-width`                                     | 触屏目标和大纲宽度                                |
| `--zhishu-ui-content-max-width`、`--zhishu-ui-toolbar-offset`                                 | 正文最大宽度和吸顶工具栏偏移                      |

默认外观复用仓库已有 React/Base UI 体系的交互经验；打包输出可按需引入的作用域 CSS 和语义 token。消费方无需扫描包源码生成 Tailwind 样式；不注入全局 reset、字体下载或远端 CDN。

消费示例的“视觉验收样本”使用默认亮色，“会议记录”在同一页面为第二个实例覆写暗色变量，用于检查包级组件和宿主工具栏的主题隔离。

`EditorShell` 支持 `contentMaxWidth`、`compact`、`stickyToolbar`、`toolbarOffset` 与 `outlinePlacement` 布局配置。大纲可排在编辑面起始或末尾；`--zhishu-ui-outline-width` 可由主题调整，应用实例将正文宽度设为 896px、桌面大纲宽度设为 288px，样式仍由包级 CSS 提供。固定工具栏依赖宿主滚动容器，存在固定顶栏时通过 `toolbarOffset` 留出空间。独立组合 `EditorOutline` 等依赖主题变量的包级组件时，用 `.zhishu-ui-theme` 包裹其内容；大纲滚动高亮从所属编辑器的稳定 Block 位置读取标题节点，并监听最近的可滚动祖先，不按标题文本或全局 DOM 查询定位。`statisticsFooter` 可在 `footerSlot` 前组合包级字数/字符数/预计阅读时间和快捷键帮助；React 统计只随正文变更刷新，宿主仍通过 `footerSlot` 提供保存动作。历史版本预览使用独立只读 `EditorProvider` 与同一 `EditorShell` 排版，不连接当前协同会话。

宿主可即时切换 `editingControls` 与 Provider 的 `editable` 状态来实现编辑/阅读模式。隐藏编辑工具不会卸载或重建 Provider，保留查找、大纲、统计和业务分享/导出插槽；服务端只读权限仍由宿主单独约束，不能因为显示编辑工具而恢复写权限。

默认组件按壳、命令区和编辑面组织；业务区通过插槽组合，不把产品导航塞入编辑器：

```text
EditorShell
├── EditorHeaderSlot
├── EditorToolbar
│   ├── FormattingActions
│   └── ExtensionActionGroups
├── EditorSurface
├── SelectionMenu
├── SlashMenu
├── BlockMenu
└── StatusRegion
```

工具栏、Slash 菜单和 Block 菜单共用同一 Action 描述并在触发时重新询问 core：

```ts
interface EditorAction {
  id: string;
  label: MessageKey;
  group: string;
  isVisible(context: EditorUiContext): boolean;
  canRun(context: EditorUiContext): { enabled: boolean; reason?: MessageKey };
  run(context: EditorUiContext, signal: AbortSignal): Promise<void> | void;
}
```

扩展注册动作时需提供稳定 ID、本地化名称、键盘顺序与可访问说明。UI 可缓存显示状态，但执行前必须用最新 editor selection/readonly 能力重验，防止菜单打开后选区已变化。异步动作捕获 Anchor，不保留裸 ProseMirror 数值位置。

默认工具栏包含段落/标题选择、下划线、高亮颜色、对齐、列表、清除格式、历史与附件操作；按钮从 editor-react selector 读取格式和列表状态，并展示禁用原因。格式下拉先保存当前文本范围，再恢复该范围执行命令。启用 Slash 菜单时，工具栏另提供“插入块和命令”入口。方向键循环移动工具焦点，Tab 离开工具栏。`EditorShell` 的 `find` 入口默认折叠查找面板，按钮控制 `aria-expanded`，打开后聚焦搜索框，Escape 关闭并将焦点还给入口；查找词在收起期间保留。

`.zhishu-ui-surface .ProseMirror .is-empty` 通过语义文字颜色呈现 core Placeholder 的 `data-placeholder`。占位只作输入引导，正文和统计不会把提示文字计入内容。

斜杠菜单按文本、列表和其他内容分组，选项提供图标与简要说明；方向键更新 `aria-activedescendant` 并将选项滚入可视区域，菜单底部保留键盘提示。工具栏可直接请求打开同一菜单，并传入当前选择范围；不会伪造全局键盘事件或插入 `/`，选择动作前会重获该编辑范围。只读或协同结构能力暂不可用时，菜单选项显示禁用原因，键盘执行也会向宿主报告原因。菜单支持 Escape、鼠标和触屏关闭/选择，表格插入会说明需要空段落。Block 菜单将复制/删除、类型转换和位置调整分组；删除动作使用危险色，协同状态仍由结构操作能力决定是否可用。

## 4. 交互规则

- 工具栏操作保留原选区；对话框打开时缓存有效锚点，关闭后仅在原文档/目标仍有效时恢复焦点。
- 菜单打开后焦点可通过方向键、Tab 与 Esc 操作；关闭回到触发器。查找面板也由明确按钮展开，Escape 关闭并恢复焦点。拖拽操作同时提供“上移/下移”等键盘和触屏替代。
- 浮动菜单不遮挡当前选区；滚动容器、缩放、窗口边缘和输入法候选窗口均有处理规则。表格选区使用对应上下文菜单。
- 只读保留查看、复制、查找与允许的评论/导出入口；显示只读原因。客户端禁用不替代服务端授权。
- 删除整块、关闭未保存草稿等行为按可恢复性提供确认或撤销；普通字符删除不额外弹窗。
- AI 生成默认在预览区展示，接受与取消按钮有明确状态；冲突提示展示原目标已变化，并允许复制或重新选择目标。

`defaultEditorNodeViews` 组合代码块、提示块、带标签分隔线和状态标签视图。提示块提供五主题切换、解包和删除；状态标签支持五状态切换；分隔线标签原位输入、Enter 保存、Escape 取消，并保护组合输入。阅读/只读状态隐藏编辑动作。Slash 菜单可插入三种新节点，选区菜单可将稳定块目标转换为提示块；结构操作失败提供同批次重试反馈。

在线成员展示最多五个首字头像与溢出数量，详情来自真实 presence 并标识自身；Escape 和点击外部关闭详情并恢复触发器焦点。协同状态摘要与连接、内容同步、服务端保存详情分别表达，收到 durable ack 才显示已保存；持久化失败保留失败文字及草稿。

## 5. 状态文案与恢复动作

| 状态              | 展示要求                                      | 可执行动作                           |
| ----------------- | --------------------------------------------- | ------------------------------------ |
| 加载中            | 稳定占位，不展示可编辑假内容                  | 超时后重试                           |
| 空文档            | 光标入口与插入引导，不能混同加载失败          | 输入/插入/选择模板                   |
| 保存中            | 表达待持久化，不因 WebSocket 连通提前变为成功 | 等待、查看连接状态                   |
| 已保存            | 仅在获得覆盖本地修改的持久化回执后显示        | 可查看版本时间                       |
| 离线且有修改      | 明确当前修改的保存位置及关闭风险              | 重连、导出副本                       |
| 保存失败          | 保留编辑内容，错误靠近状态区域                | 重试、导出、联系管理员入口由宿主提供 |
| 无权限/版本不兼容 | 保留安全可显示的内容或占位，停止写入          | 登录、申请权限、刷新到支持版本       |
| 附件失效/AI 失败  | 仅影响对应块或任务，保留正文                  | 刷新附件授权、重试任务、保留草稿     |

状态提示避免每个按键播报；为屏幕阅读器提供节流后的语义通知。错误不仅用颜色表达，同时有文字与动作。

## 6. 响应式与无障碍

桌面使用可配置顶部工具栏与浮动菜单；窄屏将次要动作收入可访问的菜单，支持触控入口，不依赖 hover。正文、表格和代码块分别处理横向溢出，避免整个页面被撑宽。

`EditorShell` 通过 `selectionMenu` 显式开启浮动选区格式菜单；该菜单不抢走编辑器焦点，支持方向键、Escape 和可替换文案。按钮覆盖粗体、斜体、删除线、下划线、多色高亮、清除格式和可选的共享链接编辑器；菜单在真实组合输入开始时隐藏，在组合结束后依据当前选区重新定位。

`EditorShell` 通过 `slashMenu` 显式开启 Slash 插入菜单，可使用 `slashCapabilities` 按宿主已启用的扩展过滤段落、标题、列表、引用、代码块和分隔线，并用 `slashMenuMessages` 替换菜单文案。在行内光标处输入 `/` 后可继续输入中文或英文关键字，也可从工具栏直接打开；工具栏入口保留原选区，不插入命令字符。菜单按内容类型分组，方向键移动活动项、Enter 执行、Escape 关闭，鼠标/触屏可以直接选择。菜单通过 `aria-controls`、`aria-expanded` 和 `aria-activedescendant` 保持编辑器焦点并报告活动项；无匹配项时显示状态文案。选项高度至少 44px，菜单在视口边缘夹取并在下方空间不足时移到光标上方。组合输入期间菜单关闭，不拦截输入法按键。任务清单 capability 开启后可把段落转为 `taskItem`；焦点在任务项中时可插入递归 `taskList`。协同模式会先提交服务端结构操作，等本地结构 revision 同步后，再按 Block ID 删除 `/` 命令文字；遇到 stale revision 会用服务端返回 revision 重试一次。Chromium 已验工具栏打开时保持文本位置、未添加 `/`，并可执行标题与列表命令；协同 Slash 命令另有持久化序号验收。

`EditorShell` 通过 `blockMenu` 开启当前焦点 Block 的手柄，也可在自定义界面中单独挂载 `EditorBlockMenu`。手柄只在编辑器激活后出现；选择列表项内部文字时，菜单以所属列表项为操作目标。菜单支持复制、删除、转换为段落/二级标题/代码块，以及在同一父级内上移和下移；不适用于当前 Block 或位置边界的动作会禁用。菜单使用按钮触屏入口、方向键/Home/End、Enter/Space 和 Escape，关闭时恢复手柄焦点，操作完成后恢复编辑器焦点。手柄和菜单随滚动重定位并夹在视口内；删除依靠普通撤销恢复，目前不提供删除确认或拖放排序。协同会话处于 connected/current 且可写、并提供 `submitStructureOperation` 时，菜单通过 core 准备 OperationBatch 并交由服务端应用；其他状态禁用结构动作。隔离环境已验服务端双向投影；Chromium Tiptap/React 消费样例已验复制、删除、类型转换、上下移操作及 durable ack。

`EditorShell` 默认包含 `EditorTableToolbar`，光标进入表格后显示当前行列数及上下文菜单；可用 `tableToolbar={false}` 隐藏，或通过 `tableToolbarMessages` 替换文案。菜单按 `EditorController.canRunTableCommand()` 禁用当前选区不支持的命令，覆盖插入/删除行列、切换表头、合并和拆分；只读状态、单格合并及合约尺寸上限会禁用对应动作。操作成功后播报结果并更新尺寸摘要，失败时保留选区并提供重试提示。菜单为原生 disclosure，键盘可展开，触屏目标至少 44px。消费样例已验证表格内出现菜单、3×3 扩为 4×3/4×4、只读时禁用结构操作，单格合并不可用；协同持久化、重开导出、320px 局部横向滚动以及协同合并/拆分/表头切换已通过验收，截图见 `output/playwright/zhishu-table-toolbar-1280x900.png`。

`EditorShell` 通过 `linkEditor` 开启链接按钮，也可单独挂载 `EditorLinkEditor`。选中文本可设为链接；光标位于现有链接时会展开整个链接范围，允许修改地址、显示文本或移除链接。地址仅接受带主机名的 HTTP(S) 和基本格式正确的 mailto，拒绝相对 URL、凭据 URL、脚本协议和空白字符。编辑时文档内容若已变化会拒绝应用旧选区。`EditorProvider` 在调用 `openExternalLink` 前同步询问宿主 `confirmExternalLink`；没有宿主确认器时拒绝打开，不调用阻塞式浏览器确认框。宿主未提供打开链接能力时点击不会导航；异步打开失败交给 `reportError`。消费样例中已验收非法地址拒绝、显示文本替换、地址编辑、移除链接以及取消/接受外链确认。

协同状态变为 `denied` 时，`EditorShell` 显示至少 44px 高的“重试连接”按钮，并调用当前会话的 `retry()` 重新连接；服务端仍拒绝时会继续保持只读。

组件字符串支持替换：`EditorShell` 提供 `toolbarMessages`、`shellMessages`、`imageAltEditorMessages`、大纲文案及各菜单的 message props；`EditorSurface` 可替换加载、错误和重试文案。主题变量按实例继承，宿主可以在单个 shell 上覆盖 `--zhishu-ui-surface`、`--zhishu-ui-canvas`、`--zhishu-ui-text`、`--zhishu-ui-muted`、`--zhishu-ui-border`、`--zhishu-ui-border-subtle`、`--zhishu-ui-accent`、`--zhishu-ui-accent-soft`、`--zhishu-ui-hover`、`--zhishu-ui-focus`、`--zhishu-ui-danger`、`--zhishu-ui-success`、`--zhishu-ui-warning`、`--zhishu-ui-shadow`、`--zhishu-ui-floating-shadow`、`--zhishu-ui-radius`、`--zhishu-ui-radius-compact`、`--zhishu-ui-radius-control`、`--zhishu-ui-radius-floating` 和 `--zhishu-ui-control-height`。选区菜单另有稳定深色的 `--zhishu-ui-selection-*` 变量。包提供 Slate/Indigo 默认值，但不监听系统主题；app-web 管理亮色、暗色和跟随系统，并将其映射给编辑器。细指针使用紧凑控件，粗指针下控件至少 44px；减少动画时停止非必要过渡和旋转。当前变量覆盖后的色彩对比度尚未重新测量，屏幕阅读器兼容性和 Firefox/Safari 输入法仍需矩阵验收。

明确控件可读名称、焦点可见、表单标签、错误关联、色彩对比与减少动画。快捷键依据系统呈现 Ctrl/Cmd，不能覆盖输入法常用组合。自定义 NodeView 和插槽由宿主承担相同的可访问性要求。

主要交互统一使用 roving tab stop：工具栏方向键在同组动作间移动，Tab 离开工具栏；菜单用方向键移动、Enter/Space 执行、Escape 关闭并返回触发器。文本格式状态支持未选中/全选/混合三态；屏幕阅读器文案同步表达状态与禁用原因。组合输入期间不抢占 Enter、方向键和快捷键。

`EditorShell taskCelebration` 默认 false。启用时消费 core 的本地任务完成事件，播放 700ms 的少量粒子，事件按当前 Shell 隔离；关闭、卸载与减少动画偏好变化会清理监听和残留 DOM。应用持久化个人开关，UI 不自行管理业务偏好或远端状态。启用 linkEditor 且当前可编辑选区非空时，Shell 处理 Ctrl/Cmd+K 打开共享链接编辑器；输入法组合中不处理，空选区可交由宿主全局搜索。

## 7. 交付与验收

M1 提供可组合的最小编辑页和无默认 UI 的对照消费示例；M2 覆盖图片/表格/协同状态；M3 覆盖 AI 与评论插槽。每个组件文档列出默认、空、忙碌、只读、禁用、错误和窄屏状态。

验收通过真实键盘、输入法、触屏尺寸和长内容场景；视觉快照只辅助发现回归。多个编辑器同时出现、宿主采用不同主题、嵌入弹窗/侧栏时，样式和焦点仍需隔离。

## @ 成员菜单（2026-10-31）

`EditorShell` 在可编辑且宿主提供 searchMembers 时挂载 `EditorMentionMenu`，亦可单独消费。正文输入 @ 后可按姓名/邮箱搜索、方向键选择、Enter 插入、Escape 关闭；邮箱字面量、代码块和中文组合输入不触发抢键。查询防抖并在光标/输入变化和卸载时取消，迟到结果不覆盖新查询。菜单以独立 portal 避免正文滚动裁切，继承当前实例的主题色并限制到视口；支持加载、无结果和失败重试。提及显示身份色与首字头像，阅读/导出仍显示成员名称。
