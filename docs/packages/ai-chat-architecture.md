# AI Chat 架构索引

状态：2026-11-13。完整目标和实施约束统一收敛到 [主技术文档](../apps/ai-assistant-and-public-qa.md)，实施交接见 [实现 Prompt](../apps/ai-assistant-implementation-prompt.md)。本页不再维护另一套接口或迁移路线。

当前 ai-qa/ai-writing 双流程、共享产品表及 0042–0045 已实施。下一轮以当前源码为基线，建立 dsh-agent 原生接入、ai-runtime 统一助手编排、ai-plugins 能力组合；问答、research 和写作使用同一 Agent 与产品会话。参考目录用于比较职责，不整包回滚。

独立创作先展示完整 Chat，用户决定并成功创建草稿后，才进入左编辑器、右侧同一 Chat。空间范围与问答/创作选择保留，意图切换不另开会话；正文和已保存状态继续由协同及 durable ack 决定。

包责任分别见 [dsh-agent](dsh-agent.md)、[ai-runtime](ai-runtime.md)、[ai-plugins](ai-plugins.md)。纯合约、chat-ui、rag、授权、产品存储和索引沿当前真实能力复用，禁止旧运行图、ChatRecord 快照、兼容别名或双协议回归。

历史实施和验收记录见 [AI Chat 实施记录](ai-chat-implementation.md)。其中带日期的旧 API、双流程和兼容说明用于审计历史，不指导新实现，也不能当作新方案已经通过验证的证据。
