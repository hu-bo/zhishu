# ai-plugins 设计规划

状态：2026-10-24 已创建 writing/research/image 子入口，应用已接 DSH 写作与知识来源工具，以及可配置的真实图片 HTTP adapter 和私有资源任务。真实收费 provider 未实调；当前图片只支持单张 PNG 和授权预览。见 [实施记录](ai-chat-implementation.md)。

**原设计时状态（已由上方实施更新覆盖）**：2026-10-22 新增方案，尚未创建 `packages/ai-plugins`。拟定包名 `@zhishu/ai-plugins`。[总方案](ai-chat-architecture.md)；执行宿主见 [dsh-agent](dsh-agent.md)，文档产物见 [ai-contracts](ai-contracts.md)，检索见 [rag](rag.md)。[返回文档地图](../README.md)。

## 1. 目标与边界

在协作 AI 写作链路的同一官方 DSH Agent Loop 上提供文章写作、调研和图片创建能力。插件使用 Cordis 作用域、DSH 工具/Prompt/Session 扩展；业务执行身份、权限、资料、存储与写入通过宿主能力接入。

首期一个 package、三个独立子入口。插件不创建自己的 Agent 循环、不启动 HTTP/Worker、不直接访问知书数据库，不要求 UI 安装 Node.js 运行时。写作基础对话不启用这些插件时仍可运行。

2026-10-24 边界明确：research 是写作过程中的调研辅助，RAG Chat 继续使用独立 LangChain 问答链路。插件可复用获授权的 rag 检索/来源端口，但不接管 RAG 的会话、问答 API 或恢复；两个前端业务组件只共用 chat-ui 基础组件。

## 2. 包入口与依赖

| 入口                           | 内容                                      | 主要依赖                                           |
| ------------------------------ | ----------------------------------------- | -------------------------------------------------- |
| `@zhishu/ai-plugins/contracts` | 三类配置/产物 JSON Schema、类型、fallback | chat-contracts；文档/证据结构引用 ai-contracts     |
| `@zhishu/ai-plugins/writing`   | 写作 Prompt/工具、结构输出校验与提案编译  | Cordis/DSH peer、ai-contracts、document-contracts  |
| `@zhishu/ai-plugins/research`  | 搜索、阅读、证据登记、报告输出工具        | Cordis/DSH peer、ai-contracts、宿主 research ports |
| `@zhishu/ai-plugins/image`     | 图片任务、provider/job 协调与产物登记     | Cordis/DSH peer、宿主 image/storage ports          |

root 只提供轻量清单/类型，不静态 import 三个插件。纯契约入口不重导出 Node 插件。即使 npm 安装阶段需要完整声明依赖，浏览器导入链也必须保持纯净；包内按入口运行边界检查。

注册使用上游公开 plugin/tool/prompt/session 接口；本包只补产品配置、端口和产物契约，不另设可执行脚本格式、动态远程插件加载器或重复生命周期管理器。

## 3. 插件共同契约

| 编号  | 能力         | 约束                                               |
| ----- | ------------ | -------------------------------------------------- |
| AP-01 | Manifest     | 稳定 id、版本、配置版本、能力与产物类型            |
| AP-02 | 作用域安装   | 会话/Agent 装配前明确启用列表；释放随 Cordis scope |
| AP-03 | 参数校验     | 有界 JSON；Schema 与派生类型单一来源               |
| AP-04 | 外部能力调用 | 显式 scope、AbortSignal、timeout、预算与幂等       |
| AP-05 | 进度与结果   | 阶段/工具结果、版本化产物、可读降级                |
| AP-06 | 恢复         | 保存必要 JSON 事实；不保存闭包/SDK client/临时 URL |

Manifest 属于宿主选择和兼容信息，不替代 Cordis 插件定义。工具只通过 DSH tool registry 注册；文章、研究和图片工具返回经过验证的结果。工具名、模型输出文本和前端可执行动作不能直接互相推断。

产物统一包含 artifactId、pluginId/pluginVersion、kind/schemaVersion、runId、summary、payload 和资源引用。payload 在提交前校验；产物状态区分 generating、ready、failed、unavailable，不把客户端卡片已经显示当成产物已保存。

插件私有状态使用官方受支持的 Session 插件记录/投影接口，登记记录类型和版本，在恢复前装配对应解释器。原始数据、权限与费用记录由宿主保存，插件记录只保留恢复所需的有界引用与决策事实。

## 4. writing：文章写作

### 4.1 范围与输入

支持起草、续写、摘要、段落改写、翻译和整篇改写，沿用现有 ai-contracts 的意图、目标、DocumentSnapshot、内容 Hash 与结构修订。服务端提供可信目标与资料快照；模型不指定最终 documentId、generationId、blockId 或 operationId。

目标版本、文档所属空间和写入权限由应用解析。知书当前只允许本人个人空间的 AI 正文写入；团队文档可按权限作为讨论资料。插件保持可独立消费，不硬编码知书空间角色。

### 4.2 执行与产物

1. 宿主验证目标、内容能力、资料范围与预算，并固定本轮版本。
2. 插件贡献写作规则与结构输出工具，Agent Loop 调用模型；生成期间只产生草稿和进度。
3. 编译器把结构输出转换为现有 AuthoringProposal，验证节点、目标范围、Block 身份和引用。
4. 持久化产物后发布 `artifact.committed`，payload 使用原 AuthoringProposal 契约。
5. 宿主 renderer 展示草稿、差异与接受动作，正文应用交给现有文档 service/协同通道。

`packages/ai-runtime/src/proposal-compiler.ts` 的可复用纯逻辑迁入 writing 内部；继续复用 ai-contracts 的校验与 replacement-review，不复制现有文档操作规则。原编译器用例随迁移保留。

### 4.3 应用与恢复

默认由用户主动接受，逐段/整篇均复核当前权限、generation、durableSeq、structureRevision 与前置 Hash。operationId 与审阅 decisionId 保持业务幂等；正文成功以协同 durable ack 为准。旧设计中的自动写入不作为新插件默认能力。

模型生成完成、工具获准或页面回读都不自动写正文。生成与正文应用分开记录；文档发生冲突、撤权、移入不支持空间、正在中文输入或有未确认修改时保留可访问草稿，提供重新生成/复制等有效操作。恢复可继续生成，不重放已接受的正文操作。

### 4.4 验收

覆盖短/长文、重复标题、Block ID 保留、增长/缩短提案、错误节点、错误目标、无效引用、重复接受、部分接受、整篇冲突、权限变化、协同保存重开和历史回读。旧编译器测试通过后再验证真实 DSH 结构化输出，避免只替换 SDK 名称。

## 5. research：调研

### 5.1 范围与输入

输入为研究问题、已授权来源范围、可用检索能力和本轮预算。支持先检索、再阅读、识别证据缺口并形成报告；过程运行在同一 DSH 工具循环中。首期单个研究 Agent，不默认加载子 Agent、编码工具或宿主文件系统。

研究范围区分已选资料、知识库和显式启用的网页来源。没有网页 provider 时仅显示实际可用范围；本地关键词匹配不能标记为向量检索或互联网研究。

### 5.2 端口与工具

| 宿主端口 | 责任                                           | 可对应的工具             |
| -------- | ---------------------------------------------- | ------------------------ |
| search   | 按可信 scope 检索候选，返回来源 ID、摘要与版本 | search_sources           |
| read     | 当前授权/版本复核后读取指定片段                | read_source              |
| evidence | 登记来源位置、证据 ID 与必要快照               | 由插件调用的受控登记能力 |
| report   | 校验并保存最终报告                             | submit_research_report   |

以上工具名为本包拟定，不是 DSH 内置工具。通过官方 tools 服务注册；搜索结果和正文均为非可信数据，不作为系统指令。读取数量、总字节、模型/检索次数、耗时与费用有共享上限，嵌套调用不另开无限预算。

`@zhishu/rag` 由应用适配 search/read。向量化、索引构建、Qdrant ACL 与文档发布留在原 RAG/应用边界。网页抓取与文档解析服务也由宿主注入，使用实际来源定位，不能伪造页码、URL 或逐字引用。

### 5.3 报告与展示

研究产物包括研究问题、范围/限制、报告正文、证据引用、来源版本与不足说明。引用复用 ai-contracts 的 SourceCitation；来源 ID、定位和 quote 在最终提交前校验，并检查当前访问权限。

UI 展示“检索资料、阅读来源、整理报告”等阶段、工具摘要、来源列表与最终报告，不展示模型私有推理。证据不足返回明确的不足结果和已完成范围；搜索失败不能伪装成没有相关内容。

报告转文章由宿主建立写作目标并生成/接受提案；研究插件不直接创建工作区或向文档追加正文。

### 5.4 恢复与验收

证据清单、已读范围、来源版本与工具执行记录可从持久化 Session/宿主记录恢复。恢复重新核对来源权限和预算；已读来源版本变化使原证据失效或明确转为历史证据，不静默把不同版本拼接成同一引用。

验收包括多轮搜索/阅读真实闭环、中文报告、重复来源、冲突证据、无证据、引用无效、撤权、工具失败、预算耗尽、中断恢复及报告转文档。真实检索质量与费用独立评估，确定性测试只验证控制与约束。

## 6. image：图片创建

### 6.1 输入与 provider

输入包括提示词、允许的尺寸/比例、数量、可选参考图片引用和 provider 能力参数。模型提出参数后仍需校验，前端能力只展示 provider 支持的选项。图片 provider 独立于文本 LLM，可由 OpenAI-compatible 或其他真实接口实现，但本方案不预选供应商。

拟定 provider 端口提供 `create`、必要的 `getJob` 和可选 `cancel`；同步结果与异步 job 使用判别联合。声明真实的取消、幂等、状态查询、参考图片与尺寸能力，不能统一返回一个无语义的 unknown 对象。

### 6.2 执行与存储

1. 校验参数、参考图片当前权限、数量和本轮成本范围；宿主在外部请求前预留预算。
2. 以稳定的本次创建幂等键调用 provider，记录 jobId/请求结果；超时首先查询原 job，避免盲目再计费。
3. 将合法图片结果写入宿主私有对象存储，验证 MIME、大小、尺寸与关联身份。结果暂未持久化时保持 generating/待保存状态。
4. 产物保存 assetId、尺寸、格式、生成参数、来源/模型信息和必要 provider job 引用，不把短效签名 URL 当持久化地址。
5. 业务通过授权 resolver 获取预览/下载 URL，失效后刷新；插入正文由受控附件与文档命令完成。

原始 provider 凭据、长 base64 和任意远程 URL 不写入聊天日志。图片二进制经 storage port 保存，消息只携带引用。用例需要下载 provider 结果时由已配置 adapter 验证允许来源、超时和大小，不提供任意 URL 抓取工具。

### 6.3 取消、重试与授权

用户明确提交的数量和预算可以作为当前创建的授权范围；插件不重复询问同一授权。参数扩大或额外成本超出该范围时由宿主重新获取用户决定，DSH 单次审批只覆盖被询问动作。

provider 支持取消则传播取消并查询终态；不支持时停止后续消费并记录外部任务仍可能完成，展示实际能力，不能返回“已撤销费用”。网络超时且状态未知时保留 job 引用，优先查询/人工恢复，禁止使用新请求 ID 无界重试。

同一生成结果重复回调或 worker 重启只登记一个产物；存储失败允许重试落盘，不重新生成图片。部分成功明确显示每张状态与实际数量。资源不可访问时隐藏/拒绝访问，不返回原始 provider URL 绕过存储授权。

### 6.4 验收

覆盖真实 provider 创建、私有存储、授权预览/下载、刷新重开、参考图权限、非法参数、部分成功、超时结果未知、幂等重试、取消能力差异、存储失败恢复和图片插入文档。没有配置 provider 的示例显示未配置能力，不展示伪造成功结果。

## 7. 前端插件展示约定

应用按 artifact kind/schemaVersion 注册 renderer。writing 使用文档提案与编辑器审阅；research 使用报告与来源面板；image 使用图片组与产物动作。组件继续组合 chat-ui，不能让 chat-ui root 导入本包的服务端插件。

资源访问、下载、写入、分享均为业务回调。renderer 仅接收校验后的载荷、资源 resolver 和当前动作能力，不接收 provider client 或模型密钥。缺失插件、未知版本或旧产物失去权限时使用可理解的降级状态。

## 8. 版本、交付与独立消费

插件版本、配置 Schema 版本和产物 Schema 版本分别记录。已有会话恢复装配兼容插件；不兼容时返回明确升级/历史只读策略，不让新插件重解释旧工具副作用。外部 action/job 幂等键跨恢复保持稳定。

交付依次为 P3 writing、P4 research、P5 image。每类有纯逻辑测试、官方 DSH 装配测试和应用纵向验收；真实 provider 作为显式配置的集成验收，不在普通单元测试中自动产生费用。

独立例子只安装构建包和明确 peer，通过内存/文件测试宿主运行需要的插件，不依赖知书工作区或数据库。消费 writing 不启用 image provider，消费纯产物契约不加载 Cordis。达到这些条件后，再依据实际使用决定是否分别发布 `ai-plugin-writing`、`ai-plugin-research`、`ai-plugin-image`。
