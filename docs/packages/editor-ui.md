# editor-ui 设计规划

状态：M1 基础组件已实现，M2 图片上传和查找基础接入中。对应 `packages/editor-ui`；[返回文档地图](../README.md)。当前提供 `EditorShell`、键盘可操作的 `EditorToolbar`（含混合格式态和可选图片上传动作）、只读原因、基础 `EditorOutline`、可选 `EditorFindPanel`（计数、循环导航、定位）、宿主标题/头部/底部插槽、窄屏大纲折叠、可选 `EditorSelectionMenu`、`EditorSlashMenu`、`EditorBlockMenu`、`EditorLinkEditor`、`EditorCollaborationIndicator` 和 `EditorCollaborationParticipants`；图片读取通过宿主 `resolveAssetURL` 临时写入展示 DOM。样式通过 `@zhishu/editor-ui/styles.css` 显式引入且仅作用于包内类名。当前只在 Chromium 消费样例中验证了 390px 和 320px 视口；Firefox、Safari 和真实系统 IME 尚未验收，因此暂不承诺这些环境。Chromium 中已确认折叠大纲、菜单定位/键盘/焦点恢复、Block 单机操作、链接编辑和外链确认行为；本轮查找验收覆盖了跨 Mark 命中、定位、大小写不敏感和循环，不含锚点返回原编辑位置。

## 1. 产品职责

提供完整且可替换的默认编辑界面，让接入方快速获得一致的工具栏、菜单、Block 操作和状态反馈。宿主可以只使用部分组件，也可以完全采用自定义界面。

本包不请求企业 API、不维护文档列表/空间路由、不存储权限和评论。协同、AI、附件与评论通过状态模型、动作回调和插槽接入，缺少能力时不要求安装对应运行时。

默认工具栏只在宿主提供 `requestUpload` 时显示图片按钮，可上传 PNG/JPEG/WebP 并通过 OperationBatch 插入图片 Block；宿主的 `resolveAssetURL` 只为当前 DOM 请求短时访问地址。上传按钮目前没有替代文本编辑、进度比例、取消按钮、尺寸编辑或图片重试面板；错误通过可访问状态文本及宿主错误回调呈现。PDF 附件仍未接入编辑器。

协同状态由 `EditorProvider` 投影，`EditorShell` 默认在头部展示 `EditorCollaborationIndicator`，也可用 `collaborationIndicator={false}` 隐藏，或单独挂载该组件。连接、内容同步和持久化分别显示；已连接或已同步不会被当作已保存，待保存数、失败状态和服务端 durableSeq 单独呈现。它只展示状态，不创建 Provider，也不提供失败更新的重试/导出动作；宿主仍需接入协同会话及恢复流程。

`EditorShell` 默认显示 `EditorProvider` 收到的最多五个 Awareness 参与者名字和颜色标记；可通过 `collaborationParticipants={false}` 隐藏。参与者名字是不可信文本，clientId 只区分本地协同会话，不代表登录用户。`editor-collaboration` 的 `./tiptap` 可选入口已有相对选区光标装饰扩展，但当前 `EditorProvider` 未自动安装；默认壳层仍只展示参与者列表。

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

| 配置                                      | 用途                       | 约束                                             |
| ----------------------------------------- | -------------------------- | ------------------------------------------------ |
| `locale / messages`                       | 文案、快捷键提示、状态文本 | 包内有默认文案；宿主可完整替换，不硬编码企业名称 |
| `theme / className / style tokens`        | 外观与密度                 | 不改变内容 Schema，不覆盖宿主全局样式            |
| `toolbarItems / insertItems`              | 按能力组合菜单             | actionId 与 core 命令关联，稳定键盘顺序          |
| `collaborationStatus / participants`      | 在场与保存显示             | 读取 CO 的状态投影；不创建 Provider              |
| `aiPanel / commentsPanel / sourcePreview` | 业务与能力插槽             | 只接收所需上下文和回调，不持有业务数据所有权     |
| `onActionError / onRequestUpload`         | 宿主处理反馈与服务         | 异步过程支持取消并在当前文档校验目标             |

默认外观复用仓库已有 React/Base UI 体系的交互经验；打包输出可按需引入的作用域 CSS 和语义 token。消费方无需扫描包源码生成 Tailwind 样式；不注入全局 reset、字体下载或远端 CDN。

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

## 4. 交互规则

- 工具栏操作保留原选区；对话框打开时缓存有效锚点，关闭后仅在原文档/目标仍有效时恢复焦点。
- 菜单打开后焦点可通过方向键、Tab 与 Esc 操作；关闭回到触发器。拖拽操作同时提供“上移/下移”等键盘和触屏替代。
- 浮动菜单不遮挡当前选区；滚动容器、缩放、窗口边缘和输入法候选窗口均有处理规则。表格选区使用对应上下文菜单。
- 只读保留查看、复制、查找与允许的评论/导出入口；显示只读原因。客户端禁用不替代服务端授权。
- 删除整块、关闭未保存草稿等行为按可恢复性提供确认或撤销；普通字符删除不额外弹窗。
- AI 生成默认在预览区展示，接受与取消按钮有明确状态；冲突提示展示原目标已变化，并允许复制或重新选择目标。

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

`EditorShell` 通过 `selectionMenu` 显式开启浮动选区格式菜单；该菜单不抢走编辑器焦点，支持方向键、Escape 和可替换文案。当前按钮覆盖粗体、斜体、删除线和行内代码；菜单在真实组合输入开始时隐藏，在组合结束后依据当前选区重新定位。

`EditorShell` 通过 `slashMenu` 显式开启 Slash 插入菜单，可使用 `slashCapabilities` 按宿主已启用的扩展过滤段落、标题、列表、引用、代码块和分隔线，并用 `slashMenuMessages` 替换菜单文案。在行内光标处输入 `/` 后可继续输入中文或英文关键字；菜单按内容类型分组，方向键移动活动项、Enter 执行、Escape 关闭，鼠标/触屏可以直接选择。菜单通过 `aria-controls`、`aria-expanded` 和 `aria-activedescendant` 保持编辑器焦点并报告活动项；无匹配项时显示状态文案。选项高度至少 44px，菜单在视口边缘夹取并在下方空间不足时移到光标上方。组合输入期间菜单关闭，不拦截输入法按键。

`EditorShell` 通过 `blockMenu` 开启当前焦点 Block 的手柄，也可在自定义界面中单独挂载 `EditorBlockMenu`。手柄只在编辑器激活后出现；选择列表项内部文字时，菜单以所属列表项为操作目标。菜单支持复制、删除、转换为段落/二级标题/代码块，以及在同一父级内上移和下移；不适用于当前 Block 或位置边界的动作会禁用。菜单使用按钮触屏入口、方向键/Home/End、Enter/Space 和 Escape，关闭时恢复手柄焦点，操作完成后恢复编辑器焦点。手柄和菜单随滚动重定位并夹在视口内；删除依靠普通撤销恢复，目前不提供删除确认或拖放排序。协同会话处于 connected/current 且可写、并提供 `submitStructureOperation` 时，菜单通过 core 准备 OperationBatch 并交由服务端应用；其他状态禁用结构动作。当前隔离环境已验服务端双向投影，完整 Tiptap/React 操作仍待运行验收。

`EditorShell` 通过 `linkEditor` 开启链接按钮，也可单独挂载 `EditorLinkEditor`。选中文本可设为链接；光标位于现有链接时会展开整个链接范围，允许修改地址、显示文本或移除链接。地址仅接受带主机名的 HTTP(S) 和基本格式正确的 mailto，拒绝相对 URL、凭据 URL、脚本协议和空白字符。编辑时文档内容若已变化会拒绝应用旧选区。`EditorProvider` 在调用 `openExternalLink` 前同步询问宿主 `confirmExternalLink`；没有自定义确认器时使用浏览器确认框。宿主未提供打开链接能力时点击不会导航；异步打开失败交给 `reportError`。消费样例中已验收非法地址拒绝、显示文本替换、地址编辑、移除链接以及取消/接受外链确认。

组件字符串支持替换：`EditorShell` 提供 `toolbarMessages`、`shellMessages`、大纲文案及各菜单的 message props；`EditorSurface` 可替换加载、错误和重试文案。主题由宿主在 shell 的 class 上覆盖 `--zhishu-ui-surface`、`--zhishu-ui-text`、`--zhishu-ui-border`、`--zhishu-ui-accent`、`--zhishu-ui-muted`、`--zhishu-ui-danger` 和 `--zhishu-ui-radius`，包不注入全局色板或自动暗色模式。当前交互按钮与表单控件至少 44px；所有内置键盘焦点都有可见轮廓，没有自定义动画。白色默认背景下，正文、辅助文字、危险色和强调色对比度分别为 15.17:1、4.79:1、7.33:1 和 4.68:1。屏幕阅读器兼容性、真实输入法以及不同宿主主题的实际对比度仍需辅助技术和色彩矩阵验收。

明确控件可读名称、焦点可见、表单标签、错误关联、色彩对比与减少动画。快捷键依据系统呈现 Ctrl/Cmd，不能覆盖输入法常用组合。自定义 NodeView 和插槽由宿主承担相同的可访问性要求。

主要交互统一使用 roving tab stop：工具栏方向键在同组动作间移动，Tab 离开工具栏；菜单用方向键移动、Enter/Space 执行、Escape 关闭并返回触发器。文本格式状态支持未选中/全选/混合三态；屏幕阅读器文案同步表达状态与禁用原因。组合输入期间不抢占 Enter、方向键和快捷键。

## 7. 交付与验收

M1 提供可组合的最小编辑页和无默认 UI 的对照消费示例；M2 覆盖图片/表格/协同状态；M3 覆盖 AI 与评论插槽。每个组件文档列出默认、空、忙碌、只读、禁用、错误和窄屏状态。

验收通过真实键盘、输入法、触屏尺寸和长内容场景；视觉快照只辅助发现回归。多个编辑器同时出现、宿主采用不同主题、嵌入弹窗/侧栏时，样式和焦点仍需隔离。
