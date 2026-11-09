# 知书架构重构 agent

`architecture_slimmer.toml` 定义项目级 `architecture_slimmer`，以手写代码和概念净减少为验收条件。优先删除、合并、统一已有实现，最后才考虑模块拆分。模型和权限继承当前会话。

在打开本项目的 Codex 对话中调用：

> 请使用 architecture_slimmer agent 继续瘦身知书。优先删除重复流程与多余层，手写生产代码及包含测试/脚本的手写代码总量都须净减少，完成实现与 pnpm check，分别报告各类代码的真实增删。

也可以收窄本轮范围：

> 请使用 architecture_slimmer agent，只处理目录移动中的重复逻辑，保持授权、事务与协同撤权语义，完成实现和验证。

配置以项目根目录的 `AGENTS.md` 为约束。新项目允许大胆删除旧内部实现并一次迁移调用方；保留产品能力、内容契约和用户数据。搬文件不计作删除，生成物减量单独记账，新增测试不得掩盖整体代码增长。

文件位置和字段参照 [OpenAI 官方自定义 agent 文档](https://learn.chatgpt.com/docs/agent-configuration/subagents#custom-agents)。
