# editor-core 设计规划

状态：M1/M2 部分实现。对应 `packages/editor-core`；[返回文档地图](../README.md)。内容规范引用 [document-contracts](document-contracts.md)，本文维护编辑行为。当前写入 Schema v4，显式支持读取 v1–v4 历史内容；HTML/纯文本转换须报告无法保留的内容。

## 1. 产品职责与依赖

提供以 Tiptap/ProseMirror 为基础的无界面编辑引擎，让宿主通过稳定命令编辑结构化内容。core 依赖 document-contracts 与编辑引擎，不依赖 React、Yjs、网络、知识库和模型服务。

“无界面”不代表所有代码都可在服务端实例化。根入口提供浏览器编辑器能力；`/schema` 单独提供无 DOM 的 Schema 构建、内容验证与投影辅助，供服务端协同适配器使用；该入口不导入 EditorView、React NodeView 或浏览器全局对象。

### D-04 扩展授权与兼容决策

M1 使用 Tiptap OSS `StarterKit` 与 `UniqueID`，peer 范围为 `^3.30.3`，当前锁定并验收的版本为 `3.31.3`。StarterKit 提供本期的段落、标题、引用、列表、代码块、分隔线及基础 Mark；UniqueID 将 `blockId` 绑定到这些可寻址 Block。两者属于 Tiptap MIT 开源编辑器范围，不依赖云服务或运行时凭据；私有部署和离线编辑不要求外部服务。链接禁用自动打开，仅接受 HTTP(S)/mailto，点击交给宿主处理。M1 不引入 Pro 扩展、Yjs/协同或表格/图片包。

Schema-only 入口用 Tiptap `getSchema()` 创建 ProseMirror Schema，不创建 EditorView 或读取 DOM；导入、导出、服务端结构校验可在 Node.js 执行。`normalizeTiptapDocumentJSON()` 复制并归一化 Y-Tiptap JSON 的空 Mark `attrs: {}` 和代码块 `language: null`，编辑器快照与服务端候选文档校验共用该 helper。M1 锁定的 Tiptap OSS 包使用 MIT 许可，不依赖云服务或运行时凭据；将依赖缓存到部署构建环境后，产物可私有部署并在运行时离线使用。Tiptap 官方 OSS 范围、StarterKit、UniqueID 和对应包清单可查：[OSS 范围](https://tiptap.dev/open-source-to-platform)、[StarterKit](https://tiptap.dev/docs/editor/extensions/functionality/starterkit)、[UniqueID](https://tiptap.dev/docs/editor/extensions/functionality/uniqueid)、[UniqueID MIT manifest](https://github.com/ueberdosis/tiptap/blob/main/packages/extension-unique-id/package.json)。UniqueID 的单机 ID 维护不等于协同冲突语义证明；D-03 服务端投影与命令已通过原型验收，core/React 提交桥已在真实 Tiptap/React 页面验证正文输入及复制、删除、段落/标题/代码块转换、上下移菜单动作的持久化回执。

| 能力                    | 候选实现与授权                                                                           | 私有部署/离线                                                              | 合约与服务端投影结论                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 基础编辑与稳定 ID       | 当前 StarterKit、UniqueID；Tiptap OSS，MIT                                               | 浏览器包本地运行；无 SaaS 或凭据依赖                                       | 已接入 Schema v1；服务端使用共享 contracts 校验，而不是信任客户端编辑器 Schema                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 协同                    | `@tiptap/extension-collaboration`、`@tiptap/y-tiptap`、Yjs、Hocuspocus；上游包清单为 MIT | 当前采用自托管 Hocuspocus，部署自身服务即可；客户端运行时连本项目 Provider | 服务端已将共享 XML 正文与 D-03 Block/顺序规范投影双向同步，并通过隔离 PostgreSQL/WebSocket smoke；`examples/editor-consumer` 的真实 Tiptap/React 页面已验正文输入和完整 Block 菜单结构动作，均获得 durable ack。正文和结构命令提交后崩溃恢复 smoke 已通过。历史重复 ID 可用显式单文档维护命令退休旧代次并在新代次重建正文投影；本地 PostgreSQL smoke 已验。更广的集成验收仍待完成。参考[扩展包清单](https://github.com/ueberdosis/tiptap/blob/main/packages/extension-collaboration/package.json)、[y-tiptap MIT 清单](https://github.com/ueberdosis/y-tiptap/blob/main/package.json)、[Hocuspocus MIT 清单](https://github.com/ueberdosis/hocuspocus/blob/main/packages/server/package.json)。 |
| 表格                    | 锁定 `@tiptap/extension-table@3.31.3`；上游包为 MIT                                      | 客户端包本地运行，不依赖云服务                                             | Schema v3 保存稳定 table Block、行/单元格、段落及列宽；服务端校验 1–100 行、1–20 列的矩形网格及受限合并跨度。编辑态支持拖动改宽，宽度随正文保存、协同和重开；窄屏仍在表格容器内滚动。HTML 保留表格/合并/对齐/列宽，纯文本按制表符降级。参考[3.31.3 官方包清单](https://github.com/ueberdosis/tiptap/blob/v3.31.3/packages/extension-table/package.json)、[表格能力](https://tiptap.dev/docs/editor/extensions/nodes/table)。                                                                                                                                                                                                                                                                    |
| 图片                    | `@tiptap/extension-image` OSS 包清单为 MIT                                               | 节点渲染不要求云服务；上传和读取由本地宿主实现                             | 上游 Image 使用 `src` 等呈现属性，并不提供资产上传、ACL 或服务端授权。产品内容只保存 `assetId`、alt、尺寸等稳定元数据；取得 DC-07 和本地资产端口前不得将普通 `src` 节点写入文档。参考[官方包清单](https://github.com/ueberdosis/tiptap/blob/main/packages/extension-image/package.json)、[图片转换说明](https://tiptap.dev/docs/conversion/content-types/structures-and-media/images)。                                                                                                                                                                                                                                                                                                         |
| 嵌入/引用               | 仅接受项目自有的 allow-list 数据 Node；不把任意 HTML/iframe 当内容                       | Node 与视图均可本地运行；资源解析经宿主本地接口                            | 服务器验证 `providerKey`、opaque `resourceRef` 和 fallback 内容；宿主按当前权限解析，禁止持久化任意 iframe、签名 URL 或绕过授权的来源正文。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Tiptap Pro / 云托管服务 | 暂不采用；Pro 受商业许可与私有 registry/订阅规则约束                                     | 需要单独采购、凭据和部署评估                                               | 不作为 package、Schema 或运行时前置依赖。新增前须重新核对准确产品、许可和离线部署条款；参考[Tiptap Pro 许可](https://tiptap.dev/pro-license)、[Pro 扩展指南](https://tiptap.dev/docs/guides/pro-extensions)。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

扩展授权审计在上游包清单与当前项目锁定版本间逐版本复核；引入或升级依赖时须保存依赖清单/SBOM 和许可文本。图片现在使用项目自有 Tiptap Block 和 DC Schema 保存同文档 assetId，不保存 src；服务器端授权和持久化引用已接入。上传必须由宿主完成。任务清单以稳定 `taskItem` Block 保存文本和完成状态；Slash 菜单支持将段落转为任务项，以及将任务项包装为可递归嵌套的 `taskList`。勾选更新与正文同属普通协同属性更新，不改变 Block 结构。嵌套 JSON、HTML 和纯文本降级已在消费样例覆盖；协同消费样例已验证 taskItem/taskList 命令取得持久化回执。表格由 Schema v3 的 table Block 保存，Slash 菜单在空段落中插入 3×3 含标题行表格；单元格限段落内容，支持 Tiptap 行列键盘编辑与有界合并。表内行列变化不改外层 Block 顺序，协同模式仍经正常 durable ack。任何扩展都须以同一版本的客户端 Tiptap Schema、document-contracts JSON Schema、服务端校验/投影和迁移样例完成兼容验收后才能进入持久化扩展集。

图片 Block 与 PDF 附件均为原子节点，可按服务端结构操作插入并参与稳定 Block ID 校验、JSON 往返和协同投影；正文只保存 assetId 与展示属性，不保存访问 URL。HTML/纯文本导出分别降级为替代文本或文件名并报告损失。图片尺寸编辑由 UI 属性面板提供；EditorShell 的代码语言选择器支持常见语言、纯文本和保留未知语言值，语言属性经 JSON 与基础 HTML 往返保留。Slash 菜单可将段落转换为带复选框的 `taskItem`，并创建可递归嵌套的 `taskList`；JSON 保留树结构和完成状态，HTML 保留嵌套/勾选，纯文本按层级缩进并报告结构损失；真实协同消费样例已验收任务项与嵌套清单的 durable ack。表格已加入 Schema v3、Tiptap Schema、服务端矩形网格校验、HTML/纯文本转换和窄屏包装；Chromium 消费样例已插入协同 3×3 表格、编辑首格、Tab 自动扩行并获 durable ack；服务端返回 4×3/12 个单元格，独立 HTML 往返验证合并表头与对齐。PDF 协同插入已获 durableSeq 3；无身份访问为 401，授权 URL 从本机 MinIO 读回 603 字节且 SHA-256 与源文件相同。生产对象存储与故障恢复仍未配置/验收。

实现入口：`packages/editor-core/src/extensions.ts`、`src/schema.ts`、`src/editor.ts`、`src/index-plugin.ts`。当前公共 API 提供编辑器创建/挂载/销毁、Schema-only 校验、JSON 快照、原子 OperationBatch、按 ID 的插入/删除/移动/复制/拆分/合并/类型转换/列表缩进、只读能力判断、Block 查询/定位及大纲订阅。复制会深层生成新 ID；文本拆分/合并覆盖段落、标题和代码块；类型转换覆盖段落、标题和代码块；列表项缩进使用 StarterKit 的单机列表语义。带 DOM 创建只执行一次挂载；`mount()` 会卸载旧 View，在新容器恢复内容、无障碍属性和输入来源监听。事务来源区分显式宿主命令/OperationBatch、普通键入、组合输入、粘贴、剪切、历史操作和选区变化；浏览器 `beforeinput` 来源只在对应内容事务消费，销毁时清理监听与短时定时器。Chromium 消费样例已验证 StrictMode 下双实例挂载、直接挂载 API 跨容器切换后保持内容/无障碍名称/输入来源、自定义段落 NodeView 保持编辑内容与 Block ID、中文文本输入、Enter/Backspace 拆分合并及空文档恢复、HTML 粘贴不执行脚本且丢弃 `javascript:` 链接、普通 URL 输入自动识别为链接、工具栏选区保留、连续键入由一次撤销回滚、初始内容不进入撤销历史、只读写入拦截，以及按 ID 执行复制/嵌套复制/拆分/合并/移动/类型转换/缩进/删除且最终 ID 唯一；跨浏览器剪贴板矩阵和性能验收仍待完成。
实现入口：`packages/editor-core/src/extensions.ts`、`src/schema.ts`、`src/editor.ts`、`src/index-plugin.ts`。当前公共 API 提供编辑器创建/挂载/销毁、Schema-only 校验、JSON 快照、原子 OperationBatch、按 ID 的插入/删除/移动/复制/拆分/合并/类型转换/列表缩进、只读能力判断、Block 查询/定位及大纲订阅。文字格式命令提供下划线切换、高亮颜色设置/取消、段落与标题对齐及清除格式；合法值来自 document-contracts，保存快照采用 Tiptap Mark attrs 结构。v4 HTML 映射使用 `<u>`、受限的 `data-highlight-color` 和 `data-text-align`；Chromium 已验证格式保存及 HTML 导出/导入往返。复制会深层生成新 ID；文本拆分/合并覆盖段落、标题和代码块；类型转换覆盖段落、标题和代码块；列表项缩进使用 StarterKit 的单机列表语义。带 DOM 创建只执行一次挂载；`mount()` 会卸载旧 View，在新容器恢复内容、无障碍属性和输入来源监听。事务来源区分显式宿主命令/OperationBatch、普通键入、组合输入、粘贴、剪切、历史操作和选区变化；浏览器 `beforeinput` 来源只在对应内容事务消费，销毁时清理监听与短时定时器。Chromium 消费样例已验证 StrictMode 下双实例挂载、直接挂载 API 跨容器切换后保持内容/无障碍名称/输入来源、自定义段落 NodeView 保持编辑内容与 Block ID、中文文本输入、Enter/Backspace 拆分合并及空文档恢复、HTML 粘贴不执行脚本且丢弃 `javascript:` 链接、普通 URL 输入自动识别为链接、工具栏选区保留、连续键入由一次撤销回滚、初始内容不进入撤销历史、只读写入拦截，以及按 ID 执行复制/嵌套复制/拆分/合并/移动/类型转换/缩进/删除且最终 ID 唯一；跨浏览器剪贴板矩阵和性能验收仍待完成。

常用块 API 包含段落、标题、有序/无序列表、引用、代码块和分隔线命令。写入与块结构命令分别通过 `canExecute("write")`、`canExecute("block-structure")` 返回只读/协同限制；编辑器工具栏使用 controller 命令，Slash 查询式菜单在校验和清除命令触发文字后执行对应 Tiptap transaction，工具栏主动菜单则复用 controller 命令。

表格上下文 API 提供 `getTableDimensions()`、`canRunTableCommand()` 和 `runTableCommand()`，覆盖行列增删、表头切换与合并/拆分。命令要求选区位于表格内并通过 Tiptap 当前选区能力校验；行数最多 100，列数最多 20，与 document-contracts 限制一致。表格命令通过普通事务进入撤销栈；协同编辑中由当前共享正文适配器接收事务，Block 结构安全门不用于单元格级修改。

`CreateEditorOptions.placeholder` 与 `createEditorSchema()` 的同名配置接受 `emptyDocument`、`emptyParagraph` 和 `showInReadOnly`；默认中文提示引导输入 `/`，传 `false` 可完全关闭。Placeholder 使用 ProseMirror decoration 和 DOM 属性，不会进入快照、统计、HTML/纯文本导出或协同内容。默认 StarterKit 快捷键保留，另支持 `Mod-Shift-H` 切换黄色高亮；快捷键插件会跳过 `KeyboardEvent.isComposing`、`view.composing` 和 IME keyCode 229。

`CreateEditorOptions.collaborative: true` 为协同模式关闭 StarterKit 本地 `UndoRedo`，让 collaboration extension 管理协同历史；禁止同时传入本地 `content`，共享内容必须先由同步后的 Y.Doc 提供。默认同步结构命令仍被 guard 禁止；`prepareStructureAction()` 可生成并校验 OperationBatch，但不修改本地文档，宿主只应把 batch 交给当前 generation 的服务端结构会话。React Block 菜单仅在连接/同步当前且会话可写时走这条提交路径。宿主需在连接已同步后创建编辑器，并将 Tiptap Collaboration extension 绑定到同一 Y.Doc；参考 [Tiptap Collaboration 配置](https://tiptap.dev/docs/editor/extensions/functionality/collaboration) 与 [UniqueID 同步后挂载要求](https://tiptap.dev/docs/editor/extensions/functionality/uniqueid)。

2026-09-27 增补的 Playwright 跨引擎 smoke 在同一消费样例上记录到 Chromium/Chrome 153.0.0.0、系统 Edge 153.0.0.0、Firefox 156.0 与 Playwright WebKit 26.6。四者均加载页面且无浏览器 console error；Firefox、WebKit、Edge 的可编辑区域接受键入，Firefox 的按 ID 拆分按钮可用。Chromium 另验证 D-03 安全门拒绝 Enter 拆分且保留文本编辑。用户在打开的编辑器中确认系统中文输入法输入、提交无漏字/乱序，候选框期间 Enter/方向键正常。WebKit 是 Windows 上的 Playwright WebKit 构建，不等价于实际 macOS Safari；剪贴板跨浏览器矩阵和当前及上一稳定版本完整矩阵仍待完成。

剪贴板往返 smoke 在 Chrome 153、Edge 153、Firefox 156 上通过：将含中文文本放入浏览器剪贴板，用键盘粘贴到第一个编辑器，再选中复制并粘贴到第二个编辑器，文本一致。Windows Playwright CLI WebKit 26.4 中，系统剪贴板粘贴到第一个编辑器成功；Ctrl+C 触发了编辑器 copy event，事件的 `text/plain` 与完整所选文档一致，但 CLI 没有把该 payload 写入 Windows 系统剪贴板，因此无法完成原生复制→粘贴往返。将已观测的 copy payload 通过系统剪贴板桥接后粘贴到第二个编辑器，文本一致；这项桥接检查不视为原生往返通过。实际 macOS Safari、上一稳定版本及完整剪贴板矩阵仍待补齐。

## 2. 功能清单

| 编号  | 能力             | 产品细节                                                                                | 阶段             |
| ----- | ---------------- | --------------------------------------------------------------------------------------- | ---------------- |
| EC-01 | 基础内容         | 段落、标题、粗体/斜体/删除线、行内代码、引用、有序/无序列表、分隔线、换行、代码块、链接 | M1               |
| EC-02 | 文本输入         | 中文 IME、键盘、选区、跨块删除、空块、粘贴纯文本/HTML、链接输入规则                     | M1               |
| EC-03 | Block 操作       | 按 ID 插入/删除/复制/拆分/合并/移动、缩进、类型转换、多块批量操作                       | M1；协同移动 M2  |
| EC-04 | 历史与事务       | 普通撤销/重做、逻辑操作分组、变更来源、可替换历史适配                                   | M1               |
| EC-05 | 导入导出         | JSON 为无损主格式；HTML/纯文本按能力声明转换、导入报告、内容净化                        | M1               |
| EC-06 | 可选内容扩展     | 图片、附件、任务列表、表格、代码语言选择；属性与序列化稳定                              | M2               |
| EC-07 | 只读与能力判断   | 查看、选择/复制、命令可执行性、禁用原因、权限改变后的立即只读                           | M1               |
| EC-08 | 导航与定位       | 当前选区、Block 查找、定位/滚动、文档大纲、文内查找、锚点映射                           | M1 基础；M2 完整 |
| EC-09 | 业务扩展接入     | 嵌入块、引用块、评论装饰、AI 提案命令、节点操作限制                                     | M3               |
| EC-10 | 长文档与扩展治理 | 局部计算、增量变更摘要、扩展冲突诊断、内容和事务上限                                    | M1 起持续        |

EC-08 当前提供跨 Block 查找和命中定位。`findText()` 将文本 Block 按文档顺序用换行符连接、保留 Mark 分段和硬换行，并按大小写折叠检索；命中偏移映射回文档位置，可跨 Block 选中并滚动到视口。协同锚点的文档/代次/目标校验已接入查找导航；Anchor 保存可选块内偏移，远端结构命令重建正文后仍可在 Block 移动、拆分和合并中恢复原范围。评论、AI 等异步业务调用闭环仍在 M2/M3 跟踪。
| EC-11 | 高级内容 | 数学公式、图表、媒体、受控外部嵌入和更完整格式转换 | M4，逐项明确支持范围 |

## 3. Node/Mark 与扩展目录

| 类别                | 行为要求                                                     | 与宿主的边界                                       |
| ------------------- | ------------------------------------------------------------ | -------------------------------------------------- |
| 段落/标题/引用/列表 | Enter/Backspace、缩进、类型转换保持预期选区；列表编号稳定    | 标题样式和目录界面交给 ui                          |
| 代码块              | 粘贴保留换行/空格，Tab 行为可配置，语言仅是内容属性          | 高亮实现按需加载，不调用远程服务                   |
| 链接                | 协议白名单、显示文本与 URL 分开、编辑态点击行为可配置        | 路由跳转与外链策略由宿主提供                       |
| 图片/附件           | 插入稳定 assetId，替代文本、尺寸、对齐、不可用占位           | 上传与授权 URL 解析由宿主提供                      |
| 表格                | 行列增删、单元格选择、合并拆分、表头、键盘导航、越界粘贴反馈 | 大表限制可配置，首期不模拟电子表格公式             |
| 引用/嵌入块         | 序列化来源标识、只读展示、缺失来源状态                       | 解析服务、权限检查和具体 React 视图由扩展/宿主实现 |

M2 表格使用 MIT 许可的 `@tiptap/extension-table@3.31.3`。Schema v3 将表格作为稳定 Block，单元格仅包含段落；限制为 100 行、20 列及矩形网格，并验证合并跨度和单元格宽度。`/table` 在空段落插入 3×3 表格并提供表头；表内文本、Tab 导航和行列结构命令由 Tiptap 扩展处理，列分隔线可拖动调整宽度，最小列宽为 96px。宽度写入 `colwidth` 并随单元格正文事务保存；窄屏只在表格容器内横向滚动。默认跨度值会在 JSON/Yjs 投影比较时规范化，避免同一内容因 ProseMirror 省略默认属性而误报结构冲突。HTML 往返保留表格、合并单元格、对齐和列宽；纯文本使用制表符分隔并返回降级报告。Chromium 消费样例已验 `/table` 协同插入、单元格输入、Tab 导航及 durable ack；最后一个单元格按 Tab 新增行后，服务端 JSON 返回 Schema v3、4 行、12 个单元格和持久化末格文本。浏览器 DOM 转换验收通过合并表头/对齐的 HTML 往返。2026-10-04 消费样例浏览器验证首列从 249px 拖至 329px，JSON 保存/重载恢复同宽，浏览器只读态阻止拖动；真实协同列宽 durable ack、Safari 和设备触屏仍未覆盖。

每个扩展需声明内容格式版本、依赖、Node/Mark、命令、快捷键、可寻址节点、剪贴板转换及纯 Schema 部分。重复节点名和冲突快捷键在创建时报告。扩展初始化不读取企业全局 store；自定义 UI、状态和远端能力经明确接口传入。

扩展注册表是会话内固定的有序清单。一个扩展至少声明唯一 `name`、`contentVersion`、依赖扩展、Node/Mark 名称、纯 Schema 构造器与可选的浏览器插件/命令。依赖拓扑先校验再构建；循环依赖、缺少必需依赖和节点名冲突均在编辑器挂载前失败。

```ts
interface EditorExtension {
  name: string;
  contentVersion: string;
  dependencies?: readonly string[];
  nodeNames: readonly string[];
  markNames?: readonly string[];
  createSchemaParts(): SchemaParts;
  createRuntime?(context: ExtensionContext): ExtensionRuntime;
}
```

`createSchemaParts()` 不接收 DOM、React、凭据或业务 store，因而可从 `/schema` 构建服务端验证 Schema。React NodeView 与浏览器插件只在 `createRuntime` 提供，不能成为服务端读取和投影内容的前置条件。

M3 的业务内容使用可选扩展声明，基础扩展不注册这些 Node。结构化 AI 结果需要不可拆分的业务语义时，可以通过 `ai-block` 容器节点承载；普通生成文本仍映射为段落、标题、列表等基础节点，不用 `ai-block` 包装全文。示例内容结构如下：

```json
{
  "type": "ai-block",
  "attrs": {
    "blockId": "block_ai_01",
    "kind": "generated-summary",
    "formatVersion": 1
  },
  "content": [
    {
      "type": "paragraph",
      "attrs": { "blockId": "block_ai_02" },
      "content": [{ "type": "text", "text": "生成后经用户确认的摘要。" }]
    }
  ]
}
```

同一可选扩展可以声明 `embed-block`，只保存 `blockId`、允许的 `providerKey`、不透明 `resourceRef` 和可读 fallback 文本；宿主解析真实资源并授权。`rag-citation` 作为可选 inline atom，保存 `citationId` 与 DC `SourceReference`（来源文档、版本和 Block 标识）。这几种 Node 均不保存任意 iframe HTML、签名 URL 或未经授权的来源正文。React NodeView 通过宿主回调解析预览和访问状态，服务端纯 Schema 仍可验证/投影该节点。AI 运行状态和流式 token 属于任务草稿，不写入正文；接受后写入普通内容，可选引用节点保留来源标识。

## 4. 公共 API 语义

| 拟定入口                            | 入参/结果                              | 保证                                                         |
| ----------------------------------- | -------------------------------------- | ------------------------------------------------------------ |
| `createEditor`                      | 元素、初始内容、扩展集、能力与历史适配 | 明确所有权；初始化失败不保留监听器                           |
| `getSnapshot`                       | 返回符合合约的当前内容快照             | 只代表当前本地内容，不宣称已保存                             |
| `applyOperations`                   | OperationBatch → 成功或结构化冲突      | 先解析 ID/锚点与验证全批次，再单个逻辑事务应用               |
| Block 命令                          | Block ID → OperationBatch 或命令结果   | 复制重建嵌套 ID；拆分/合并限制为文本块；类型转换限制为文本块 |
| `canExecute`                        | 命令与上下文 → 可执行性/原因           | UI 可使用同一规则展示禁用状态                                |
| `subscribe`                         | 按变更类型订阅，返回取消函数           | 区分内容、选区、能力和生命周期，携带 origin                  |
| `setEditable` / `focus` / `destroy` | 显式生命周期控制                       | 只读状态阻止本地写命令；销毁可重复调用                       |
| `/schema`                           | 创建固定扩展集的纯 Schema 与转换辅助   | Node.js 导入不要求 DOM，不创建可交互编辑器                   |

`CreateEditorOptions.placeholder` 可设置空文档与空段落提示、只读时是否显示提示，也可设为 `false` 关闭；提示由 DOM 属性呈现，不进入 JSON、统计、转换或协同内容。`codeBlockHighlighting` 默认为启用，使用只读 ProseMirror 装饰着色，并根据文档内实际代码语言动态导入 Highlight.js 语法模块；装饰不改写正文，未支持或加载失败的语言以原始文本显示。

命令的持久目标采用 blockId 或锚点，执行瞬间再解析为 ProseMirror 位置。允许 UI 内部使用即时数值位置，但异步上传、AI 和协同回调不得长期持有旧位置后直接写入。

`calculateDocumentStatistics(content, options)` 计算 `wordCount`、`characterCount` 和 `readingTimeMinutes`。默认使用 `Intl.Segmenter('zh-Hans')` 按可识别词段计中英文词数；字符数是排除空格和换行后的 Unicode 字素数，emoji 组合按一个字符计。代码块正文参与统计，图片/PDF 等无文本资源不计入。阅读时间是估算值，默认按每分钟 300 个词段向上取整；宿主可设置 `locale` 与正数 `wordsPerMinute`。无 Segmenter 环境下使用 Unicode 词项回退算法。

`EditorController` 的 `duplicateBlock`、`splitBlock`、`mergeBlocks`、`moveBlock`、`deleteBlock` 和 `changeBlockType` 返回 DC `ApplyOperationResult`，默认 origin 为 `user`，可传入稳定 `operationId`。`splitBlock(id, textOffset)` 的 offset 按 JavaScript UTF-16 文本偏移计算；`mergeBlocks(firstId, secondId)` 要求两块直接相邻且类型相同。两者仅处理 paragraph、heading 和 codeBlock。`changeBlockType` 在 paragraph、heading、codeBlock 间转换，并在转代码块时移除行内 Mark。`indentListItem`/`outdentListItem` 使用单机列表命令，针对指定 listItem ID 定位并执行；协同语义仍未定义。

基础 Block 命令的可观察结果如下：

| 命令           | 目标参数                                                    | 成功结果                               | 冲突/失败                                     |
| -------------- | ----------------------------------------------------------- | -------------------------------------- | --------------------------------------------- |
| `insertBlock`  | 父 Block 或文档根、`beforeBlockId`/`afterBlockId`、合法内容 | 返回新建 Block ID 和 `operationId`     | 锚点消失、节点类型不允许或内容超限时整笔拒绝  |
| `replaceBlock` | `blockId`、预期摘要、合法替换内容                           | 保留目标 ID，单一事务替换内容          | 摘要不符返回 `stale-target`，不得改写邻接节点 |
| `deleteBlock`  | `blockId`、可选预期摘要                                     | 返回删除的 ID 列表，子树按规则一起删除 | 缺目标或前置条件不符返回冲突，不部分删除      |
| `moveBlock`    | `blockId`、目标父级、相对锚点                               | ID 不变，文档结构单次提交              | 禁止移入自身子树；协同不支持时返回能力错误    |

所有命令先通过同一 `canExecute` 规则，再在单个 ProseMirror transaction 内应用。错误结构引用 DC-05；实现可以使用专用 TypeScript 联合类型承载错误，但 UI 不解析错误字符串。`subscribe` 事件在事务提交后发送，远端同步和初始化不会进入本地用户撤销历史。当前编辑器使用 StarterKit 的历史插件：连续键入按默认相邻时间窗口合并历史项，显式 `undo`/`redo` 事件分别标为对应来源；自定义历史 Provider 与协同撤销仍属后续阶段。

## 5. 数据流与事务

输入/命令 → 解析目标 → 校验只读、Schema 与前置条件 → 构造事务 → 维护 ID/选区 → 应用 → 发布变更摘要。摘要包含受影响 Block ID、origin、operationId 和内容是否改变；全文快照按需要生成，不在每次选区变化时全量序列化。

origin 至少区分用户输入、粘贴、宿主命令、远端同步、AI 接受、内容初始化和迁移。初始化不进入用户撤销栈；协同时只启用一个历史实现，具体规则见 CO-05。

普通模式可以显式替换整个文档，但需要新的内容标识/版本和撤销策略。协同模式禁止使用普通整文替换 API 重新灌入 JSON；恢复版本通过服务端新代次流程执行。

## 6. Block 身份、移动与导入

遵守 DC-02 的复制、拆分、合并规则，嵌套复制必须重新生成所有可寻址子节点 ID。移动要校验不能进入自己的子树、不能破坏列表/表格结构，成功后保留逻辑对象身份。

M2 结构命令原型已实现：Hocuspocus stateless `structure-operation` 携带 `operationId`、OperationBatch 和 `baseStructureRevision`；单 owner 按文档串行处理，基于当前 revision 原子验证整批操作并先提交 Yjs 更新，再应用/广播。相同 operationId/请求哈希重放返回 duplicate；同一旧 revision 的竞争命令只有先提交者成功，其余收到可恢复冲突，不按客户端时钟覆盖。移动保留 ID；删除后的 ID 在该 generation 内 tombstone 且不可复用；拆分用左侧 `replace-block` 保留原 ID、插入右侧新 ID；合并保留左侧 ID、删除并 tombstone 右侧 ID。内容树存为按 Block 和父子顺序拆分的服务端 Yjs 投影，移动不重写 Block 内容；操作日志最多 10,000 条、tombstone 最多 100,000 个，单次生成的 Yjs 更新仍受 1 MiB 帧上限约束。

`examples/collaboration-consumer/src/structure-smoke.ts` 已在隔离 PostgreSQL/WebSocket 上实测两个客户端同修订移动冲突、幂等重放、拆分/合并身份、删除后拒绝 ID 复用、900 KB Block 移动、正文/maps 双向投影、重连恢复和拒绝客户端直接修改服务端投影。`examples/editor-consumer` 的 `/collaboration` 页面使用公开包连接真实 Hocuspocus session，已验正文输入以及 Block 菜单复制、删除、段落/标题/代码块转换、上下移，每项均获得 durable ack。`post-commit-crash-smoke.ts` 还验证正文与结构命令提交后退出，在新进程加载时恢复，原 update 得到确认，相同 operationId 返回 duplicate。core 安全门允许只给既有块补齐合法且唯一的 `blockId`，同时继续拒绝本地 Block 增删、排序及类型变化；`maintenance:repair-block-ids` 提供显式单文档的历史重复 ID 修复，专项 PostgreSQL smoke 已验旧代次退休、新代次重建与内容保留。更广的集成验收仍待完成，因此当前结果仍不代表完整协同编辑器闭环已经开放。

core 提供 `collaborationStructure: { mode: "disabled", isRemoteTransaction }` 安全门：本地会拒绝任何改变 Block 类型、顺序、父级、数量或 ID 的事务，仍允许纯文本/Mark 编辑；远端事务由宿主按协同适配器元数据识别后通过。Chromium 消费样例已验证本地移动 API 返回 `collaboration-structure-disabled`、Enter 拆分不改变 Block 结构、文本输入继续工作、菜单结构动作禁用，且带模拟 adapter meta 的远端结构事务可通过。该本地门仍需由集成端设置，普通 Tiptap/Yjs Provider 不会自动启用。

导入先解析到隔离内容，再执行限制/净化/Schema 校验，返回支持、降级和拒绝项。未知节点不能在编辑器加载后静默消失；可保留原件并提示需要扩展。Word/PDF/复杂 Markdown 导入列为 M4 独立能力，只有提供格式覆盖说明后才对外展示支持。

M1 的 `@zhishu/editor-core/conversions` 提供 JSON、基础 HTML 和纯文本转换。JSON 使用 document-contracts v1 校验/规范化，`exportDocumentJson` 与 `importDocumentJson` 保持受支持内容无损。HTML 转换按当前注册的 ProseMirror Schema 解析；支持段落、标题、引用、列表、代码、基础行内格式和安全的 `http`/`https`/`mailto` 链接。脚本、样式、嵌入式活动内容和事件属性会被移除，危险链接会被剥除；图片只保留替代文本。HTML 导入总是重新生成 Block ID。转换结果包含 `supported`、`degraded`、`rejected`；即使移除了不安全片段，成功的部分内容仍可返回，宿主应在应用导入前展示报告。纯文本按换行映射段落；导出会以文本前缀表达列表，标题/代码/引用/行内标记/链接 URL 会报告降级。HTML 转换需要浏览器 DOM，JSON 和纯文本 API 可在 Node.js 使用。

`exportDocumentMarkdown(content)` 基于已校验 AST 输出 CommonMark/GFM，支持嵌套列表/引用、任务、代码围栏、基础表格与文字 Mark；下划线、高亮、对齐、合并单元格和私有附件通过降级报告表达。特殊字符转义、动态代码围栏避免正文误解析。它无需浏览器 DOM。`exportStandaloneDocumentHtml(content, schema, title)` 在安全 HTML 片段外提供独立页面、转义标题、禁止脚本的 CSP 与阅读/打印样式；私有附件仍只呈现名称，首行全部为表头的表格转为 thead 以便打印分页重复。

任务 NodeView 仅在可信本地 checkbox 事件由未完成变为完成且事务实际接受后发送 `EDITOR_TASK_COMPLETED_EVENT`；初始化、远端同步、普通命令、撤销/重做与历史恢复均不发送。事件只供包级 UI 动效消费，不成为持久化属性。

### Schema v5 内容命令

`wrapSelectionInCallout(theme)` 将相邻选中块包入提示块并保留子块 ID；`getSelectedBlockIds()` 提供稳定目标。`insertStatusTag(status)` 写入行内内容；`updateStatusTag(position, expectedStatus, status)` 核对原状态，避免浮层回调改写已变化的标签。

`prepareStructureAction()` 支持 wrap-callout、set-callout-theme、unwrap-callout、set-divider-label 和 make-divider。前四项使用 blockId；make-divider 校验原段落文字。普通模式应用整批操作，协同模式通过受控结构通道提交。删除最后一个根块时在同批次插入合法空段落；解包提示块保留子块 ID。纯 Schema 提供安全 HTML，React NodeView 为可选入口。HTML 导入先规范化 Tiptap 默认属性再校验并重建 ID，避免 `textAlign: null` 等视图默认值破坏内容校验。

普通结构操作批次具有独立撤销边界，连续转换/删除分别撤销；协同外层结构由服务端受控通道确认，不进入本地撤销栈，正文与行内属性继续由 Yjs 的本地历史处理。

`prepareStructureAction({ type: "insert-image" | "insert-pdf-attachment", ..., afterBlockId? })` 可固定异步上传开始时的末尾根块。省略时沿用追加到当前文档末尾；提供时要求锚点仍为根块，否则整批拒绝，不回退到其他位置。

## 7. 关键交互与失败语义

- IME 组合输入期间不执行破坏选区的自动替换、菜单接管或 AI 应用；组合完成后再检查目标。
- 粘贴超限、危险 URL、失效附件等提供可定位错误；部分降级须在提交导入前说明，不静默截断正文。
- 批量命令中某个目标已删除时默认整批冲突；用户明确选择后才生成新的批次，避免只执行一半。
- 快捷键与宿主冲突时允许覆盖并返回处理结果；多个编辑器实例只响应当前焦点实例。
- NodeView 异常隔离到该节点并提供可恢复占位；不能把已验证内容替换成空节点写回。

## 8. 性能、发布与验收

Block 索引依据 ProseMirror StepMap 移除并重建受影响范围，heading ID 单独维护；大纲更新只解析标题索引，不遍历所有 Block 或序列化全文。位置映射历史最多保留 128 个文档事务，超过后重建索引。活动编辑事务限制为不超过 256 个 Step，ProseMirror 结构大小不超过 2 Mi 单位、文档节点不超过 20,000；超限事务被拒绝并经 `onLimitExceeded`/宿主 `reportError` 回报。DC 快照与 OperationBatch 仍执行严格 JSON 字节、深度、节点及操作数校验。扩展注册时会展开 StarterKit 子扩展并在挂载前拒绝重复名称，错误列出冲突扩展。暂不承诺对 contenteditable 进行任意虚拟滚动；长文档 P95 输入/绘制验收仍待固定数据集验证。

发布时声明兼容的 Tiptap/ProseMirror peer 范围，将相关运行时保持为兼容的一套依赖；不捆绑 React、Yjs、UI 样式或业务 SDK。提供最小原生 DOM 消费示例、纯 Schema Node.js 消费示例和自定义扩展示例。

完成条件：M1 的 DC/EC 合约可往返、中文编辑与撤销正常、只读不触发本地写入；M2 的图片/表格和协同交互有明确异常恢复；M3 的引用与 AI 不修改基础编辑语义。输入法、粘贴、选区与复杂表格需真实浏览器验证，纯函数结果不能替代编辑体验验证。
