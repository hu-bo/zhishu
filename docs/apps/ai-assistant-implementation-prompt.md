# 插件化助手实现 Prompt

将下面内容交给能读取仓库、修改代码和运行命令的 Agent。技术规格只有主文档一份，本文件不重复字段定义。

```text
在 E:/Project/my-project/zhishu 实施统一 DSH 插件化助手及独立创作工作台。

先完整阅读：
- AGENTS.md 及适用的局部约束。
- docs/README.md。
- docs/apps/ai-assistant-and-public-qa.md，尤其第 1、3、5、6、7、12、13、14 节。
- docs/authorization.md 及涉及的文档/协同公开接口。

本任务是实际实现，不是继续写方案。主文档描述的是下一轮目标，现有 ai-qa/ai-writing 和 0042–0045 已实施，不能当作尚未建好的规划，也不能删除历史 migration 重新开始。

一、先审计现状

执行 git status --short，保留已有修改和用户提供的 zhishu-master 目录。通过 rg/AST 检查调用方、合约、表、构建脚本和测试，再迁移有效代码。扫描主工程时排除 node_modules、dist、生成物、output、submodule 和参考归档。

参考目录仅为：
zhishu-master/zhishu-master/packages/{dsh-agent,ai-runtime,ai-plugins}
它提供职责背景，不是整包覆盖来源。禁止恢复其中 LangGraph、Deep Agents、PostgresSaver、legacy-authoring、旧 ChatRecord 产品快照和旧 wire format。

用户已明确覆盖此前“问答和写作分别运行”的目标：全部任务使用一个 DSH Agent，research、writing、rag 问答等作为插件组合；产品会话可以连续问答、调研、写作。其他授权、协同、内容契约、格式与技术栈约束继续遵守。

二、按实际责任迁移三个包

- dsh-agent：官方 SDK 原生执行/Session/Loop/审批/恢复接入，不拥有产品会话快照、业务数据库或第二个产品队列。
- ai-runtime：组合一个 DSH 执行和实际允许的插件，统一输入、输出与校验，不再造模型循环或 SQL 层。
- ai-plugins：scope、rag、research、writing、image 的指令资源、工具和编译能力，不分别启动 Agent。

保留 rag 的索引/Embedding/Qdrant/可信检索、纯合约、chat-ui 和编辑器。根应用继续拥有真实授权、产品存储、幂等、用量和 outbox。迁走有效能力及消费方后删除 ai-qa/ai-writing 和其独立生成路径，不留兼容 re-export、路由别名、包空壳或重复定时器。

需要改变现有架构测试对三个旧包名的黑名单，改为验证它们的新职责与禁止的旧协议。不能靠删除/屏蔽检查过关，也不能保留过时黑名单把合法新架构判错。

三、先 Chat，用户决定后创建草稿

独立 /ai 页初始为完整 Chat，保留问答/创作意图选择、全部有权资料/多空间/文档范围、联网开关和引用。意图切换不换会话、不换 transport、不清历史。research 的结果先留在对话，不自动创建草稿。

用户点击“创建草稿”后，由同一会话受理 create-draft Run，验证目标空间、全部实际来源、权限/分发、contextRevision 和租约。模型调用在事务外，文档初始化及 targetDocumentId 绑定按主文档在同一数据库事务提交，复用现有文档导入、协同初始化和幂等能力。

只有持久化绑定成功，才在原页面展开左侧 DocumentCollaborationEditor、右侧原 Chat。不要提前创建空文档，不以本地 draftText 表示创建成功，不跳走到文档页，不创建新写作 Chat。窄屏切换文档/对话时保留协同 Provider 和未确认更新。

草稿是普通文档的工作阶段，不建 drafts 表或第二套正文。创建后的正文只走现有协同与 durable ack；后续 AI 改动产生可审阅提案。来源范围和保存空间分开，不能回退到任意首个团队空间。重复点击、响应丢失、取消或异常均核对原 Run/operationId，不重复建文档。

四、数据与权限

复用当前 37 张业务表，本轮不新增表。按主文档删除 purpose 分叉并重建必要的用户/会话复合外键，writing_sessions/image_jobs 重命名为 ai_sessions/ai_image_jobs。仅追加向前 migration，不改 0042–0045。

旧完成记录按原 conversationId 保留，不能猜测合并两个独立会话。旧未完成任务明确中断；新重试只使用当前 runtime。现有跨用途交接的必要审计导出后退出新运行路径。

插件能力由服务端当前身份、站点、配置和目标计算，客户端选择只是允许集合的子集。公开站点只开放批准资料的 scope/rag，不提供草稿、正文修改、联网或图片。范围或授权变化后推进 contextRevision 并重建允许的原生上下文，不能只隐藏前端消息。

保留一份证据/Citation 校验。平台和 Tavily 来源都必须可追溯；Run 记录实际交给模型的全部来源依赖，不能只根据显示出来的引用处理撤权。来源链接随正文采纳、保存重开和导出保留。

TAVILY_API_KEY 只从服务端环境注入，不复制实际密钥进代码、文档、前端或日志。没有真实密钥不阻止其他实现，用明确 fixture 覆盖失败和禁用状态，不声称真实联网已验证。

五、实施与验证

按“调用链/迁移清单 → 包与合约 → 数据和统一服务 → 插件 → 草稿事务 → 前端 → 旧路径退役”推进，阶段间自动继续，不停在计划或每步询问是否继续。常规实现细节按最小完整方案解决，不新增通用插件平台或第三套状态。

同步修改根 scripts、依赖/lockfile、公开 exports、examples、模型注入、OpenAPI 和生成客户端。先检查生成路径已有修改，再从源 Schema 更新：
pnpm --dir apps/app-server openapi:export
pnpm --filter @zhishu/app-web api:generate
文件路由用仓库 routes:generate，不手改生成物，离线 OpenAPI 不连接数据库。

按实际 package.json 执行构建/类型/相关测试、test:architecture、test:authorization、test:documents、pnpm test:ai 和 pnpm check:ai-packages。覆盖主文档第 14 节的跨插件流程、公开边界、创建幂等、原子绑定、撤权、恢复、双栏/移动端及来源保留。

数据库/Qdrant/对象存储/WebSocket/付费服务使用专用测试环境，不执行业务库迁移或生产部署。fixture 与真实集成结果分开报告；缺少外部环境继续完成可独立验证的实现。

最后检查：没有双 Agent/双模型生成路径，没有两份业务快照，没有旧包转发/旧路由别名/purpose 解析，没有草稿影子正文，没有归档源码依赖。正常文档历史、当前 SDK 原生恢复和已发布 SQL migration 不能当成冗余删除。

六、交付

总结实际实现入口、三个包的责任、表和数据迁移、旧代码/依赖/路由删除清单、最终 ER 图，以及真实通过/失败/未验证项目。更新主文档的实施状态，不能仅修改文档来宣称功能完成。

生产旧路径仍存在、用户草稿流程未闭环或没有持久化回执时，都不能标记完成。不要提交、推送或部署，除非用户另有明确授权。现在开始实施。
```
