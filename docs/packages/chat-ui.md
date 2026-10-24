# chat-ui 设计规划

状态：2026-10-24 已实现受控 Chat、消息/内容块、Composer、附件、滚动、状态、审批/产物与独立 CSS，并由 WritingChat、RagChat 共用。实际导出见 [包 README](../../packages/chat-ui/README.md)，目标清单中的其他细分组件不自动视为完成。验收见 [实施记录](ai-chat-implementation.md)。

**原设计时状态（已由上方实施更新覆盖）**：2026-10-24 更新方案，尚未创建 `packages/chat-ui`。拟定包名 `@zhishu/chat-ui`，为 RAG Chat 与协作 AI 写作 Chat 共用的前端基础组件包。[总方案](ai-chat-architecture.md)聚焦写作 AI；协议见 [chat-contracts](chat-contracts.md)，两个业务封装见 [app-web](../apps/app-web.md#ai-chat-业务组件库)。[返回文档地图](../README.md)。

## 1. 目标与边界

提供可独立安装的 React Chat 基础组件，供 LangChain RAG 问答、协作 AI 写作、编辑器侧栏、研究工作台和图片创作页组合。组件接收视图、能力和回调，负责展示、输入、焦点、滚动与可访问交互，不绑定后端执行器。

包不请求业务 API、不存储服务端会话、不建立 DSH Agent、不管理租户或资料权限。发送/恢复/审批提交、HTTP/SSE、草稿缓存和消息事件归并由 web 应用层的业务组件库管理；本包只消费视图与用户意图回调。知书业务基于组件封装，不继承具体业务页面。`nova-dsh/chat-ui` 作为交互参考；当前包按本文接口重新设计，不复制 Nova 的业务类型与依赖。

RagChat 和 WritingChat 在 web 应用层分别封装。它们可复用 MessageList、MessageParts、Composer、附件展示、ChatStatus、主题和插槽；引用来源、文档审阅、工具审批和产物动作按业务能力组合，RAG 不为使用基础组件而启用 DSH 审批或恢复接口。

## 2. 功能与组件清单

| 编号  | 组件/能力                                          | 输入与输出                               |
| ----- | -------------------------------------------------- | ---------------------------------------- |
| CU-01 | Chat、ChatHeader、ChatEmptyState                   | 可组合布局、标题、空态及 slots           |
| CU-02 | MessageList、Message、MessageParts                 | 消息投影、流状态、分页、滚动位置         |
| CU-03 | TextPart、CodePart、ImagePart、ToolPart、ErrorPart | 有类型的内容展示和资源回调               |
| CU-04 | Composer、ComposerToolbar                          | 受控文本、提交、停止、禁用/忙碌          |
| CU-05 | AttachmentList、AttachmentItem                     | 文件/资料引用标签、上传状态、移除/重试   |
| CU-06 | ApprovalCard                                       | 安全的动作摘要、单次允许、拒绝与决定状态 |
| CU-07 | ArtifactCard、PluginPart                           | 版本化产物、renderer 扩展和业务动作槽    |
| CU-08 | ChatStatus、ConnectionIndicator                    | 生成、断线、恢复、持久化、错误反馈       |

优先实现可组合的小组件，再提供常用 Chat 布局组合。完整 Chat 不是必须入口；使用者可以只安装消息展示和 Composer。

## 3. 公开入口与依赖

| 入口                           | 内容                     | 依赖边界                       |
| ------------------------------ | ------------------------ | ------------------------------ |
| `@zhishu/chat-ui`              | 常用组件与视图类型       | React peer；不导出服务端功能   |
| `@zhishu/chat-ui/message-list` | 消息与滚动组件           | 不导入输入框与完整页面         |
| `@zhishu/chat-ui/composer`     | 输入框、工具栏、附件展示 | 不包含上传 provider            |
| `@zhishu/chat-ui/approval`     | 审批展示                 | 不安装 DSH runtime             |
| `@zhishu/chat-ui/styles.css`   | 已构建的有作用域样式     | 宿主不必扫描本包 Tailwind 源码 |

React 使用与当前工程兼容的 19 系列 peer；交互原语采用 Base UI，样式构建沿用 Tailwind v4。语法高亮、Markdown 等依赖按实际功能选择并限制在相应入口，重型预览按需加载。包内只用相对路径和公开依赖，无 `@/` 应用别名。

视图模型由宿主从协议投影，不把网络事件原样交给组件；独立消费者也可直接构建受控数据，无需配套控制器包。可使用 chat-contracts 的纯 JSON/引用类型；不由 UI 定义第二套服务端状态机。UI 不依赖 ai-contracts 或 document-contracts，写作和研究卡片由宿主 renderer 消费插件契约。

## 4. 拟定组件接口

以下是本包拟定接口，表示组件责任；实现时完整 Props 由真实类型和消费示例收敛。

```tsx
<Chat
  messages={view.messages}
  status={view.status}
  renderers={renderers}
  messageActions={renderMessageActions}
  emptyState={<Welcome />}
  composer={
    <Composer
      value={draft.text}
      onValueChange={setText}
      attachments={draft.attachments}
      onRemoveAttachment={removeAttachment}
      onSubmit={submit}
      onStop={stop}
      toolbarStart={<SourcePickerTrigger />}
      headerContent={<SelectedSources />}
    />
  }
/>
```

`Welcome`、资料控件、动作回调和 view/draft 均由宿主提供。Props 应包含适合组件的 className、aria 属性、受控状态、必要 ref 和文案覆盖接口。回调只收集用户意图，不在组件内部吞掉失败或宣称生成已经完成。

### 4.1 Composer

文本、资料与上传队列分别受控。临时高度、焦点、菜单展开等展示状态可以留在组件内。上传成功后提交的是资源引用，组件不把本地 File 直接发到聊天接口。

提交回调返回 accepted/rejected 或等价明确结果，等待的是“受理”，不是整个生成完成。文本和附件仍由宿主控制：宿主只清除已受理的那份草稿，期间新输入保留，失败时保留原文本、附件和焦点；Composer 根据受控状态反馈提交进度。生成中是否允许准备下一条消息由 capabilities 决定。

Enter 提交、Shift+Enter 换行；组合输入期间不拦截 Enter、方向键、Escape 或快捷键。发送、停止和附件操作分别有 accessible name。停止中禁用重复停止，直到服务端确认或明确报告失败。

### 4.2 消息与滚动

稳定 messageId、partId 和 attemptId 区分消息与流预览，不使用数组位置作为消息身份。列表支持加载更早记录、未读提示、跟随底部与返回底部操作。用户向上阅读后暂停自动跟随；插入历史保持视觉锚点；字体/图片加载和输入框增高不拉走阅读位置。

首期以 memo、流更新合并和分页控制长历史成本，不立即引入所有内容类型的虚拟列表。性能验收失败后再选支持可变高度/代码/图片的虚拟化方案。消息区域和输入框有明确滚动责任，侧栏宽度下工具卡片与长代码不撑破布局。

## 5. 两类 Chat 的适配方式

两条业务链路各自将后端结果投影为相同的组件视图；基础组件不解释原生 Session、LangChain 内部消息或引擎回调。

| 业务封装    | 服务端链路                         | 业务适配                                            | 共用组件                                                                    |
| ----------- | ---------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------- |
| WritingChat | 进程内 dsh-agent / 官方 Agent Loop | 写作快照与产品事件、工具/审批、提案与产物           | MessageList、Composer、ToolPart、ApprovalCard、ArtifactCard 等按能力组合    |
| RagChat     | LangChain RAG                      | 问答结果、真实流状态、来源/引用、检索范围与请求状态 | 同一 MessageList、Composer、TextPart、ChatStatus；引用详情使用业务 renderer |

WritingChat 将 assistant 临时 frame 归并为预览，持久化完整消息替换预览，审批和产物由服务器安全投影；RagChat 按实际问答 API 处理预览、确认和引用。RAG 没有提供的审批、resume 或持久化 cursor 不在 UI 中模拟。

共同视图只保留展示所需身份、内容和状态；两个 transport 不必采用同一 wire 协议。chat-contracts 的可复用纯类型可按需使用，但共用 UI 不要求 RAG 改造成 DSH Session/Run。

Agent idle 不代表写作成功，SSE 已连接也不代表内容已保存。两条业务都不展示模型私有推理、系统 Prompt 或 provider 内部参数；研究过程显示阶段、来源和工具结果。

## 6. 插槽与业务扩展

前端只发布本基础组件包，RagChat 与 WritingChat 分别在应用内封装。通用滚动、焦点、输入法、交互状态和主题属于包内；知书对话状态、鉴权请求、资料选择、审批提交及插件动作属于 web 应用层。业务组件通过公开 Props/插槽封装，不能让包反向依赖应用。

| 插槽                      | 通用职责                           | 知书使用                     |
| ------------------------- | ---------------------------------- | ---------------------------- |
| toolbarStart / toolbarEnd | 输入区操作                         | 添加资料、模式与能力选择     |
| headerContent             | 输入区上方内容                     | 选定文档/资料、写入目标      |
| messageActions            | 消息底部动作                       | 用于写作、引用定位、重新生成 |
| renderers                 | 按 kind/schemaVersion 渲染插件载荷 | 写作提案、研究来源、生成图片 |
| sidebar / details         | 可选辅助区域                       | 研究来源、文章目标与产物列表 |
| emptyState / errorContent | 起始与异常展示                     | 知书中文引导与恢复入口       |

资料选择器自身留在应用，其搜索、权限、目录和已选版本不进入包。通用 AttachmentItem 可显示资料引用、文件或图片；若需要来源专属 UI，由 renderer 接管。写作差异和逐段接受使用文档契约与编辑器能力，不将代码 diff 卡片直接当作文档审阅。

renderer 按稳定内容类型和版本注册，不依靠工具中文名、文本匹配或未知对象强转。未知类型显示 fallback；动作能力由服务端和宿主提供，缺失时不展示不可执行按钮。

## 7. 主题、键盘与可访问性

- 样式限定在 `.zhishu-chat` 或组件自己的命名空间，公开 surface、foreground、muted、border、accent、danger、radius、content-width 等 CSS 变量。默认主题支持 light/dark，宿主可映射现有知书 token。
- 无全局 body reset、字体替换或通用 button 样式污染。portal 浮层能继承对应主题和变量，多实例可独立配色。
- 默认文案为中文，同时提供 messages 文案对象，英文宿主不必修改源码。
- 窄屏输入区适配动态视口、安全区和软键盘；审批、长工具输出与附件列表保持可操作。
- 消息更新不会每个 token 播报；使用节流的状态通知，审批卡片有明确标题和焦点入口。动作失败就近可见，关闭弹层恢复焦点。
- 多实例快捷键按焦点和弹层作用域工作，不在 window 上无条件绑定 Escape。支持 reduced-motion、键盘可见焦点与触屏动作发现。
- Markdown、代码和 URL 只呈现安全内容；外链使用允许协议，HTML 默认不直接执行。私有图片 URL 由宿主解析，过期可请求刷新。

## 8. 异常与验收

必须覆盖空态、只读、禁用、输入法、上传中/失败、无效资料、提交失败、流中断、停止失败、审批过期、产物不可访问和未知插件版本。缓存和网络错误通过受控 Props 展示，组件不自行重发请求。

交付顺序：P1 完成文本/代码、Composer、消息动作、附件槽、主题和独立 demo；P2 接工具/审批/连接与持久化状态；P3—P5 用业务 renderer 验证三类插件，无需让 UI root 增加插件运行时依赖。

独立消费者从打包产物导入组件与 CSS，分别用 RAG 答案/引用和写作工具/提案 fixtures 验证同一套 base 组件；两个业务封装再各自验证真实接口、状态与恢复。检查桌面/移动端、亮暗主题、多实例、长消息、长历史、键盘与输入法。测试覆盖交互行为与语义，视觉验收保留实际浏览器证据；通过 fixture 展示不等于通过 DSH 集成验收。
