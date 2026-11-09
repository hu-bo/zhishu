# @zhishu/ai-plugins

官方 DSH Agent 作用域内的 writing / research / image 能力；没有自建模型循环、HTTP 服务或数据库连接。

- `./writing`：installWriting、AuthoringOutputSchema、compileProposal、validateInput、hashContent、WritingInput 和编译器错误。沿用 ai-contracts/document-contracts 的引用、Block ID、目标、Hash 和提案校验。
- `./writing/compiler`、`./errors`：纯编译、Hash 与错误入口，供 RAG 和历史兼容调用方消费，不装配 DSH 工具。`WritingExecutionPolicy` 只定义写作所需预算、授权复核与 research 可用性，不接收 LangChain 模型或 checkpointer。
- `./research`：installResearch 与 ResearchPorts，使用宿主授权的 search/read/register/reserve；来源内容作为资料，不能作为指令。
- `./image`：installImage 与 ImagePorts；真实 provider、预算、任务状态和私有资源存储由宿主注入。未配置 provider 时返回 unavailable，不注册创建工具。未知外部结果不盲目重发；图片保存后才记录 ready 资源引用。
- `./contracts`：浏览器安全的能力清单、ImageJob/ImageAsset Schema 和纯验证；root 只导出能力清单，不静态加载三个服务端插件。

在 `createDshRuntime({ setup(scope) { ... } })` 中调用对应 install 函数。工具返回值通过官方 Tools Schema 校验；writing 将产物写入官方 Session 插件记录，宿主在对应 turn flush 和业务提交之后确认耐久性。save 回调不是正文写入授权，正文必须经用户确认和应用协同事务。

编译器旧导入由 ai-runtime 重导出兼容，RAG 问答仍使用 LangChain。实际宿主 adapter 见 app-server/writing-chat；图片 adapter 使用显式配置的 Images API 和私有对象存储，只支持单张 1024×1024 PNG。真实收费调用未自动测试。独立消费/打包验证与已验收范围见 docs/packages/ai-chat-implementation.md。

包 private、未发布；MIT 上游来源与项目许可边界见 UPSTREAM.md。
