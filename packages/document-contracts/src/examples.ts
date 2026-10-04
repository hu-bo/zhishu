import type { DocumentContent } from "./schema.js";
import { validateDocumentContent } from "./validation.js";

export type KnowledgePreset = { id: string; title: string; icon: string; content: DocumentContent };

/** Portable fixtures for independent consumers and explicit, idempotent initialization. */
export function createKnowledgePresets(): KnowledgePreset[] {
  let sequence = 0;
  const block = (type: string, content?: unknown[], attrs: Record<string, unknown> = {}) => ({
    type,
    attrs: { blockId: `block_preset_${++sequence}`, ...attrs },
    ...(content ? { content } : {}),
  });
  const text = (value: string) => ({ type: "text", text: value });
  const p = (value: string) => block("paragraph", [text(value)]);
  const h = (value: string, level = 2) => block("heading", [text(value)], { level });
  const quote = (value: string) => block("blockquote", [p(value)]);
  const callout = (value: string, theme: string) => block("callout", [p(value)], { theme });
  const list = (...items: string[]) =>
    block(
      "bulletList",
      items.map((item) => block("listItem", [p(item)])),
    );
  const tasks = (...items: string[]) =>
    block(
      "taskList",
      items.map((item) => block("taskItem", [text(item)], { checked: false })),
    );
  const code = (value: string, language: string) => block("codeBlock", [text(value)], { language });
  const table = (rows: string[][]) =>
    block(
      "table",
      rows.map((row, index) => ({
        type: "tableRow",
        content: row.map((cell) => ({
          type: index === 0 ? "tableHeader" : "tableCell",
          content: [p(cell)],
        })),
      })),
    );
  const preset = (id: string, title: string, icon: string, content: unknown[]): KnowledgePreset => {
    const validated = validateDocumentContent({ type: "doc", content });
    if (!validated.success)
      throw new Error(
        `Invalid knowledge preset ${id}: ${validated.issues.map((issue) => issue.message).join("; ")}`,
      );
    return { id, title, icon, content: validated.data };
  };
  return [
    preset("product-v1", "知书产品规范：让团队知识持续生长", "📘", [
      h("产品愿景与适用场景", 1),
      p(
        "知书帮助团队把分散的信息整理为可持续维护的知识。一次会议的结论、一段接口说明、一个上线决策，都应该能被找到、理解和复用。主要使用者是产品、研发与运营团队；核心场景是共同写作、查阅方案和维护团队规范。",
      ),
      quote(
        "先让用户顺利完成一次写作与阅读，再增加复杂的管理能力。知识库的价值来自可靠内容，而不是页面上功能入口的数量。",
      ),
      h("核心用户旅程"),
      list(
        "创建工作区并为内容建立目录：先从项目或主题划分，层级尽量控制在三到五层。",
        "新建普通文档，明确标题与标签；需要多人同时编辑时，显式启用协同。",
        "写作过程中通过工具栏、斜杠菜单和选区菜单组织正文；阅读时保留查找与大纲。",
        "保存并重开确认内容；分享时检查接收者身份和权限，文档链接本身不授予访问权限。",
      ),
      h("信息层级与交互原则"),
      p(
        "桌面界面由知识库导航、正文画布和大纲组成。正文应优先获得可用宽度，页面顶部只保留常用操作；版本、分享和元信息按需展开。移动端将侧栏转换为抽屉，长表格和代码在局部滚动。界面采用可读中文、清楚的动作名称和可恢复的错误反馈。",
      ),
      table([
        ["场景", "用户可见反馈", "完成标准"],
        ["普通文档保存", "正在保存 / 已保存 / 保存失败", "服务端返回新正文修订，重开恢复"],
        ["实时协同", "连接、同步与持久化分别展示", "收到服务端 durable ack 后显示已保存"],
        ["只读访问", "隐藏写入动作，保留查找、大纲和复制", "不能通过快捷键或菜单修改内容"],
      ]),
      h("内容与权限契约"),
      callout("分享链接不等于授权。发布前核对接收者身份、访问范围和导出权限。", "warning"),
      p(
        "正文以稳定 blockId 标识内容块，附件保存 assetId 与合法展示元数据，不保存短时 URL。文档图标、标签、父子关系和工作区归属由业务服务管理，与正文修订分离。查看、编辑、分享和导出分别校验服务端权限；切换阅读模式是个人偏好，不能提升访问权限。",
      ),
      code(
        '{\n  "goal": "让知识可找到、可理解、可维护",\n  "owner": "产品团队",\n  "reviewCadence": "每个发布周期",\n  "successSignals": ["保存可靠", "检索命中", "阅读流畅"]\n}',
        "json",
      ),
      h("发布前验收"),
      block("paragraph", [
        text("发布状态："),
        { type: "statusTag", attrs: { status: "in-review" } },
      ]),
      tasks(
        "覆盖创建、编辑、保存、刷新重开与版本恢复。",
        "检查 320px 至 1440px、亮暗主题、长标题和重复标题。",
        "验证中文输入法、键盘焦点、只读与权限变化。",
        "确认失败可重试、取消不插入未完成资源、未确认草稿可导出。",
      ),
      h("持续维护"),
      block("horizontalRule", undefined, { label: "从发布转向持续维护" }),
      p(
        "每篇规范应有清楚的责任人和适用范围。业务变化后先更新具体示例，再核对验收标准。过时内容归档并提供替代链接；避免让读者在多个相互冲突的文档之间猜测。定期根据检索无结果、反馈和故障记录调整目录与说明。",
      ),
    ]),
    preset("architecture-v1", "系统架构：编辑器、业务与持久化边界", "🏗️", [
      h("架构目标", 1),
      p(
        "知书采用 pnpm workspace，应用与通用编辑器分层。编辑器负责内容操作与呈现，应用负责身份、目录、权限、保存和资源。可靠性依赖清楚的状态来源、数据库约束以及可追踪的持久化结果，而不是前端显示一次成功提示。",
      ),
      h("模块职责"),
      table([
        ["模块", "职责", "禁止承担的职责"],
        ["editor-core", "扩展、命令、转换、能力与统计", "路由、身份与业务保存"],
        ["editor-react", "生命周期、订阅与宿主服务", "绕过 controller 修改结构"],
        ["editor-ui", "排版、工具与节点交互", "依赖应用私有 CSS"],
        ["app-server", "权限、文档、版本与持久化", "把 Fastify 对象传入业务规则"],
      ]),
      h("普通文档数据流"),
      p(
        "读取正文时服务端返回 snapshotRevision。用户修改保留在本地编辑器，显式保存携带 expectedSnapshotRevision；数据库在事务内检查基础修订，成功后推进修订。冲突时保留草稿并提示重新加载或导出，不能自动覆盖新版本。元信息使用独立 metadataRevision，改标签不会替换正文。",
      ),
      code(
        "const result = await putDocumentContent(documentId, {\n  expectedSnapshotRevision: baseRevision,\n  content: controller.getContent(),\n});\n// Only advance the saved revision after the server confirms.\nbaseRevision = result.snapshotRevision;",
        "typescript",
      ),
      h("协同文档数据流"),
      callout("连接、内容同步、服务端持久化分别确认。收到保存回执后再显示已保存。", "info"),
      p(
        "协同会话绑定身份、文档和 generation。文本更新通过既有协同适配传输，结构操作通过受控通道提交；服务端负责校验、排序和 durable ack。网络已连接、Yjs 已同步与数据库已持久化是三个不同事实。恢复历史会产生新的 generation，并撤销旧会话，避免旧客户端继续写入。",
      ),
      quote(
        "服务端是共享内容的权威来源；本地缓存是恢复工具，不能成为绕过权限和修订检查的写入通道。",
      ),
      h("附件与外部服务"),
      p(
        "业务数据库保存附件身份、归属、大小、类型、校验值和状态，MinIO 保存二进制对象。创建上传意图与完成确认均校验文档权限，READY 状态在实际对象检查后设置。下载使用短期签名，重新获取链接可以恢复失效资源；访问密钥只进入服务端环境配置。",
      ),
      list(
        "数据库连接和查询设置超时，关闭应用时释放池、worker 与协同服务。",
        "OpenAPI 离线导出不连接数据库，从 route contract 生成前端客户端。",
        "migration 顺序执行，已发布文件不回写；变更通过新的前向迁移修正。",
      ),
      h("架构变更检查清单"),
      tasks(
        "新增节点同步更新契约、校验、转换和版本兼容。",
        "沿 UI → API → service → repository → response 核对一次完整操作。",
        "验证事务并发、权限隔离、修订冲突及失败后的输入保留。",
        "运行工程检查并记录真实验收范围，未验证项继续保持待办。",
      ),
    ]),
    preset("team-v1", "团队协作指南：从讨论到可复用知识", "🤝", [
      h("团队共识", 1),
      callout("先给出结论、责任人与下一步，让知识成为团队可以继续行动的依据。", "tip"),
      p(
        "知识文档是团队协作的一部分。讨论可以即时发生，结论需要留下依据、责任人和下一步。读者应能在没有参加原始会议的情况下理解内容，并知道何时需要再次确认。我们优先维护少量准确文档，避免大量缺少上下文的记录。",
      ),
      h("文档写作约定"),
      list(
        "标题描述具体问题或结果，例如“支付回调重试规范”，避免“新方案”“讨论记录”等泛化名称。",
        "开头写清目的、适用范围和当前结论；正文按背景、方案、取舍、验收和后续行动组织。",
        "术语首次出现时解释，示例展示真实输入与输出；代码标注语言，表格只用于可比较的信息。",
        "引用其它知识时链接到稳定文档，保留访问条件；不要将密钥、用户隐私或短期附件链接写进正文。",
      ),
      h("评审与责任"),
      table([
        ["角色", "责任", "评审关注点"],
        ["作者", "组织内容并处理反馈", "结论清楚、证据充分、示例可运行"],
        ["评审者", "核对事实、风险与边界", "权限、异常、兼容与验收"],
        ["维护者", "跟随业务变化更新规范", "版本、替代说明与归档时机"],
      ]),
      p(
        "普通文档适合独立整理与阶段性交付，协同文档适合多人实时写作。开始大幅修改前创建命名版本，并写明评审目标。版本恢复会影响当前正文，执行前确认未保存草稿与其他在线成员。分享只授予实际需要的动作，阅读者无需写入权限。",
      ),
      h("会议结论模板"),
      code(
        "议题：\n背景与约束：\n已确认结论：\n仍需验证的问题：\n行动项 / 责任人 / 截止日期：\n相关文档：\n下次复核条件：",
        "plaintext",
      ),
      h("异步协作节奏"),
      p(
        "作者在正文中给出明确的评审问题，评审者集中反馈可执行的建议。遇到意见冲突时记录比较维度和决策依据，不用反复改写结论替代讨论。重要决策保留被否决方案的关键约束，帮助未来团队理解当时的取舍。",
      ),
      quote("一次好的交接，不是把所有文件发送出去，而是让接手者知道当前状态、可信来源和下一步。"),
      h("发布与交接"),
      tasks(
        "完成正文与标题校对，确认图表、代码和附件可读。",
        "检查分享对象与导出范围，必要时提供公开信息的单独副本。",
        "创建命名版本并记录本次结论和维护责任。",
        "将待办转交明确责任人；过期内容归档并链接到更新规范。",
      ),
      h("每月知识维护"),
      p(
        "维护者每月检查常用文档的更新时间、失效链接和未解决任务。根据检索无结果补充同义词和标题，合并重复主题，拆分过长且责任边界不同的文档。删除单个目录页面前确认子页去向，保留仍有用的知识。团队成员可以通过搜索、收藏和最近访问建立自己的阅读入口。",
      ),
    ]),
  ];
}
