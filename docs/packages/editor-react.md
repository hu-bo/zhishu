# editor-react 设计规划

状态：M1 基础实现中，M2 React NodeView 已完成基础能力。对应 `packages/editor-react`；[返回文档地图](../README.md)。依赖 [editor-core](editor-core.md) 与 React，复用内容合约。

## 1. 产品职责

让 React 业务用稳定组件与 Hooks 接入编辑器，管理实例生命周期、选区订阅、NodeView 和宿主服务。一个页面可包含多个独立实例，也可在独立路由展示完整文档。

本包不强制依赖 editor-ui、editor-collaboration、editor-ai-bridge、TanStack Router/Query 或企业身份 SDK。协同与 AI 由宿主创建适配器注入；默认工具栏来自 editor-ui。

## 2. 功能清单

| 编号  | 能力               | 细节                                                             | 阶段                  |
| ----- | ------------------ | ---------------------------------------------------------------- | --------------------- |
| ER-01 | 实例生命周期       | 创建、挂载、销毁、容器切换、初始化失败和重试                     | M1                    |
| ER-02 | React 组件与 Hooks | Provider、编辑区域、实例访问、按 selector 订阅状态               | M1                    |
| ER-03 | 内容初始化         | initialContent、外部加载、文档标识/版本变化、避免 props 回流覆盖 | M1                    |
| ER-04 | 多实例与事件       | 独立上下文、焦点、键盘、回调更新、事务来源                       | M1                    |
| ER-05 | 宿主服务           | 上传/资产解析、打开链接、业务反馈、协同会话与锚点适配            | M1 基础；M2 资产/协同 |
| ER-06 | 只读与能力变更     | 即时更新可编辑性、菜单能力与焦点，保留复制/浏览                  | M1                    |
| ER-07 | React NodeView     | 自定义块视图、选中/拖拽、受控属性更新、异常隔离                  | M2                    |
| ER-08 | SSR 与资源释放     | 延迟创建 DOM 编辑器、渲染一致占位、StrictMode 清理               | M1                    |
| ER-09 | 可访问集成         | 编辑区域名称、错误关联、外部面板打开后的焦点恢复                 | M1 起持续             |

## 3. 拟定公共接口

| API                  | 作用                                | 关键约束                                       |
| -------------------- | ----------------------------------- | ---------------------------------------------- |
| `EditorProvider`     | 提供实例、状态与宿主适配器          | 每个实例独立；使用稳定配置，不因普通重渲染重建 |
| `EditorSurface`      | 承载编辑 DOM 与节点视图             | 提供 aria 名称、只读状态与 loading/error 插槽  |
| `useEditorInstance`  | 读取实例句柄                        | 初始化前返回明确未就绪状态，不能返回伪实例     |
| `useEditorSelector`  | 订阅所需状态与 equality 策略        | 工具栏不因无关内容变化全量重渲染               |
| `useEditorEvents`    | 订阅事务、选区与错误事件            | 返回清理逻辑，使用最新回调，不重复注册         |
| `EditorHostServices` | 上传、资产 URL 解析、外部导航等服务 | 显式传参；外链先同步确认，不在包内读取 token   |

当前公开 API 为 `EditorProvider`、`EditorSurface`、`useEditorInstance`、`useEditorCollaborationStatus`、`useEditorCollaborationPresences`、`useEditorSelector` 与 `useEditorEvents`。`EditorProvider` 以 `instanceKey + documentId + generationId` 标识实例生命周期；`loading` 可以暂缓创建编辑器，异步内容加载完成后再初始化。普通 prop 重渲染不会回灌全文；切换文档或代次会创建新实例。`editable` 与只读原因可以单独即时变化。协同 status 保留 connection、sync、persistence、durableSeq、pendingUpdateCount 和安全错误码为独立字段，不将 WebSocket 已连接/已同步折算为正文已保存。参与者列表按 Awareness clientId 提供临时显示名/颜色及不透明相对选区，不作为认证身份。外链调用 `confirmExternalLink` 后才交给 `openExternalLink`；未提供确认器时拒绝打开，不调用阻塞式浏览器确认框。宿主服务声明带 `AbortSignal` 的上传请求、可选 `cancelUpload(file)` 清理保留的失败上传会话，以及 `assetId` URL 解析器。失败上传的重试由宿主复用幂等键和会话处理，文件及会话所有权仍归宿主。Editor UI 只把短时授权 URL 注入图片 DOM 的 `src`；URL 不写回 Editor JSON/Yjs。宿主还可接收错误并处理反馈请求。

`EditorStoreSnapshot` 从同一控制器事务投影选区范围、混合格式、块类型与对齐、列表状态、表格尺寸、高亮颜色、写入/块/表格结构能力和统计。selection、undo/redo、远端文档事务、编辑权限变化都会刷新对应投影；正文统计单独防抖。`EditorListState` 分别为 bullet 与 ordered 列表提供 `boolean | "mixed"` 状态，无需各个 UI 组件再次扫描全文或注册自己的 ProseMirror 监听。表格尺寸只在光标位于表格时提供，用于上下文操作工具栏更新摘要。

`useEditorSelector(selector, isEqual)` 同时跟踪投影来源与 selector/equality；切换订阅字段时即使没有新编辑事务也会重新计算，等价值继续复用引用。选择组合对象时提供 equality，避免把每次新建的对象视为状态变化。

`EditorProvider options` 接受 core 的 `placeholder` 配置，例如 `options={{ placeholder: { emptyDocument: "开始写作", emptyParagraph: "继续写作", showInReadOnly: true } }}`。占位文案由 editor-core 的 decorations 管理；编辑器文档和 store 统计只读取真实内容。

Provider 可通过 `nodeViews={{ codeBlock: { component: EditorCodeBlockView } }}` 为代码块安装 React NodeView；React 适配器自动用 `createSafeReactNodeViewRenderer` 隔离渲染错误。配置在实例创建时生效，节点重试只重新挂载视图，不替换文档节点；只读时节点内容仍可查看，复制动作仍可用。代码块默认序列化、blockId 与语言属性仍由 core 的标准 codeBlock 节点管理。

M2 协同生命周期入口已增加：传 `options.collaborative: true` 与宿主拥有的 `collaboration` 会话后，Provider 先等待 `waitUntilSynced()` 再创建 Editor，不接收本地 `content`；read-only、拒绝或关闭状态会即时将 Editor 设为不可编辑。React context 暴露当前 session，支持 `submitStructureOperation` 的会话可供 Block 菜单发送经 core 生成的 OperationBatch。会话实现可通过 `createEditorExtensions()` 提供协同扩展；Hocuspocus session 默认返回正文绑定与 Presence 光标扩展，Provider 在创建编辑器时自动安装。宿主仍负责销毁外部 session；构建包消费样例 `/collaboration` 已真实运行正文输入及复制、删除、段落/标题/代码块转换、上下移菜单动作，均获服务端 durable ack。更广泛的协同生命周期和集成验收仍待完成。

原计划的最小接入形状采用互斥模式，具体配置对象仍待收敛，但类型约束与内容 owner 不变。

最小接入形状采用互斥模式，具体 prop 名称在实现前可微调，但类型约束与内容 owner 不变：

```ts
type EditorConfig =
  | {
      mode: "standalone";
      initialContent: DocumentContent;
      onChange?: (content: DocumentContent) => void;
    }
  | { mode: "collaborative"; session: CollaborationSession; initialContent?: never }
  | { mode: "snapshot"; snapshot: DocumentSnapshot; editable: false };
```

```tsx
<EditorProvider
  config={{ mode: "standalone", initialContent }}
  extensions={extensions}
  host={hostServices}
>
  <EditorSurface ariaLabel="项目说明" />
  <SaveIndicator state={useEditorSelector((state) => state.localChangeState)} />
</EditorProvider>
```

示例中的 `SaveIndicator` 由宿主实现；它订阅投影状态并调用宿主保存流程，不把快照回灌为受控 `value`。加载、保存和权限 API 不由此包请求。

## 4. 内容与会话模式

| 模式     | 内容 owner                     | 初始化与更新规则                                                 |
| -------- | ------------------------------ | ---------------------------------------------------------------- |
| 普通编辑 | core 当前实例；持久化由宿主    | 初次使用 initialContent；宿主只在明确切换文档/版本时调用替换操作 |
| 协同编辑 | collaboration 管理的当前 Y.Doc | 注入会话适配器；不得同时设置每次渲染都会回写的 JSON value        |
| 快照预览 | 指定 DocumentSnapshot          | 只读、固定版本，不连接当前文档的可写协同会话                     |

配置使用可区分的模式字段，类型层面阻止“协同文档 + 受控全文 value”的组合。`onChange` 用于通知宿主，不要求宿主将全文再作为 value 回传。

切换 documentId 或 generationId 时，先处理未持久化内容，再取消旧异步任务、解绑监听器并释放 owned 资源，然后初始化新实例。只更新工具栏文案、头像、回调或主题时不得重建编辑器。扩展集变化需要显式重建和兼容判断，不能视为普通 props 更新。实现通过 `loading` 延迟初次创建，通过生命周期标识切换文档；需注意普通 `options.content` 变化不会覆盖当前实例。

## 5. 资源所有权

创建实例的一方负责销毁。Provider 内部创建的 editor/订阅属于本包；外部注入的协同会话、上传服务或共享客户端由宿主拥有，包卸载只解绑自己的订阅。需要包托管时使用明确的 owned 配置，禁止根据对象形状猜测所有权。

| 资源                                          | 默认 owner           | 卸载时的动作                                             |
| --------------------------------------------- | -------------------- | -------------------------------------------------------- |
| core editor 实例、React 订阅、NodeView root   | `EditorProvider`     | 销毁实例并解除全部包内监听                               |
| 外部 `CollaborationSession`、Provider、Y.Doc  | 宿主                 | 本包只解绑 editor；宿主按显式 close/dispose 决定是否销毁 |
| `AbortController`、临时上传请求、局部 UI 插件 | 发起该任务的包内实例 | 取消请求、丢弃过期回调                                   |
| 文件上传服务、资产解析服务、共享网络客户端    | 宿主                 | 保持宿主定义的共享生命周期                               |

React StrictMode 的重复挂载不能导致重复连接、重复上传、重复初始化正文或多次注册快捷键。卸载要取消自身任务、释放 NodeView 和观察器；异步回调返回时验证实例/文档仍匹配。

Tiptap React 接入需要处理浏览器渲染与 SSR 生命周期差异；本产品采用挂载后创建可编辑实例的默认策略，服务端只输出占位或经过净化的只读内容。Chromium 消费样例已验证 StrictMode 双实例、只读切换、Core 实例跨容器重挂后保留内容/无障碍名称，以及 Provider 初始化失败后修复输入并重试成功；SSR 框架 hydration 和外部面板焦点恢复仍待验收。[官方 React 接入说明](https://tiptap.dev/docs/editor/getting-started/install/react)

## 6. 宿主服务与扩展视图

- 上传服务接收文件、目标文档上下文、AbortSignal，返回稳定 assetId 与媒体信息；进度属于本地 UI，不写入正式正文。失败后若提供 `cancelUpload(file)`，UI 显示重试/取消操作；宿主负责在重试时复用上传会话，并在取消或卸载时释放会话。完成后再检查目标锚点，已删除目标不自动插到其他位置。
  - 工具栏捕获上传开始时的末尾根块 ID，完成后经 core 的 `afterBlockId` 验证原目标；删除/移走目标会拒绝插入。取消、只读或文档切换后忽略迟到结果；卸载调用上传所属原宿主的取消接口，避免清理新文档的会话。附件节点删除时取消尚未完成的 URL 解析。
- 资产解析服务按 assetId 获取授权 URL，可刷新过期地址。临时地址留在视图状态，不同步给所有协作者。
- 外部链接由宿主确认后通过回调交给业务路由；没有打开能力时不执行导航。来源引用通过回调交给业务路由，没有对应能力时提供可解释的禁用状态，不出现无效按钮。
- React NodeView 只更新其拥有的内容属性；选中、展开、上传进度等展示状态不写进共享文档。NodeView 错误不能影响其他块。
- `createSafeReactNodeViewRenderer` 包装 Tiptap React NodeView，在单个节点内捕获渲染错误，展示可访问的重试提示；重试恢复视图，不改写文档节点。报告错误的宿主回调即使自身抛错也不会越过节点边界。公开入口同时导出 `NodeViewWrapper`、`NodeViewContent`、`ReactNodeViewProps` 与 renderer options 类型。`EditorProvider.nodeViews.codeBlock` 是可选的 React 渲染入口；Provider 将它包进安全边界并交给 core 的 codeBlock 扩展。UI 的 `EditorCodeBlockView` 用 `NodeViewContent` 保留 ProseMirror 编辑区，在只读状态仍允许复制，异步复制状态只属于该 NodeView。
- 评论、AI、知识库侧栏通过插槽组合；本包的协同会话契约可捕获/解析 Anchor，查找面板已使用该接口恢复命中位置；本包不维护评论或 AI 业务数据。

`EditorProvider.nodeViews` 支持 codeBlock、callout、horizontalRule、statusTag，均通过安全 React renderer 隔离错误；行内节点错误占位使用 span，避免破坏段落 DOM。宿主可传入 editor-ui 的 `defaultEditorNodeViews` 或自定义视图，core 不依赖 React/UI。

`useEditorStructureAction()` 统一普通和协同结构操作的忙碌、错误及重试状态。先准备一次 OperationBatch 并记录基础结构修订；响应不确定时保留原 operationId 重试，明确冲突后重新选择目标生成新操作。控制器/文档切换后丢弃旧异步完成回调。

## 7. 状态与性能

实例状态为 `initializing / ready / failed / disposed`；连接、保存和 AI 状态保留各自的模型，不揉进一个 ready 布尔值。错误携带错误码、上下文和重试动作，由宿主决定提示位置。

编辑器内部维护正文与选区；React 只订阅所需投影。`EditorStoreSnapshot.statistics` 在正文变更后经 160ms 防抖更新字数、字符数与预计阅读时间；仅移动选区时复用上一统计值，不扫描全文。统计与格式状态由两个 editor instance 各自维护，卸载时清理延时任务并随 controller 订阅一起释放。避免重建 Provider 或重渲染所有 NodeView；其他大纲等派生信息按需要节流，交互命令即时响应。

## 8. 交付与验收

M1 有三个可运行的消费样例：`examples/editor-consumer` 从公开构建入口组合宿主 JSON 保存/恢复、同页双实例、自定义 ProseMirror 段落 NodeView、`EditorShell`、直接挂载容器切换和 Provider 错误恢复；`examples/schema-consumer` 在 Node.js 中消费纯 Schema 入口；`examples/contracts-consumer` 只依赖 `document-contracts`，在 Node.js 校验内容。消费样例还包含 React 图片 NodeView，Chromium 已验证选中态、带手柄的块拖放、替代文本写回 JSON、节点内错误提示和重试，另一个编辑器实例保持可用。拖放后 Tiptap UniqueID 会为移动节点生成新 blockId；锚点连续性仍待 core 层处理。三者均使用包名解析公开 `exports`，不配置源码别名。

React、React DOM 和相应 Tiptap React 运行时采用一致的 peer 兼容范围。基础导入不要求业务 Router、QueryClient、Zustand 或全局 CSS。进入发布前覆盖快速切换文档、卸载中的上传、StrictMode、只读切换、回调更新和 SSR 占位，确认不会误写旧文档或泄漏资源。

`examples/editor-consumer` 的 `/lifecycle` 入口提供双实例、动态 selector、主题/只读/文档切换、手动完成的本地上传和内存 Yjs 双端。2026-10-03 Edge 验证节点错误重试保持 JSON、取消/失效锚点/旧文档迟到上传不误插入，以及远端格式/撤销/统计投影。30 次选区移动没有序列化正文、重算统计或重渲染宿主页；12 轮 StrictMode 双实例卸载后 controller/store/session 监听与观察器归零、资源请求全部取消。该内存传输仅验证适配与订阅，服务端 durable 验收使用 `/collaboration` 与应用链路。

独立 `/bare.html` 入口不导入 editor-ui 或其 CSS，只通过 Provider/Surface 和宿主按钮消费公开 core 命令；Vite build 同时生成这两个独立入口。SSR hydration 与物理输入法/跨浏览器矩阵仍待验。
