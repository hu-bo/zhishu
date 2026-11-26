# 知书文档地图

以下入口面向当前仓库。跑起来见 [本地启动](../README.md#本地启动)，部署与排错见 [服务端运行手册](../apps/app-server/README.md)。应用和包的设计页保留阶段目标，接口与支持范围以它们链接的源码、生成契约和验证记录为准。

## 开发和运行

| 要找什么                                  | 入口                                           |
| ----------------------------------------- | ---------------------------------------------- |
| 本地开发、前端路由、API 客户端生成        | [工作台开发指南](../apps/app-web/README.md)    |
| 配置、SSO、附件、部署、健康检查和测试命令 | [服务端运行手册](../apps/app-server/README.md) |
| 受支持的 HTTP 路由和请求响应              | [OpenAPI](../apps/app-server/openapi.json)     |
| 独立接入编辑器、Chat、助手或协同          | [消费示例](../examples/README.md)              |
| 框架约束、模块依赖和验证约定              | [仓库协作指南](../AGENTS.md)                   |

## 工作台、权限与协同

| 主题                                   | 入口                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| 应用结构与交互设计                     | [app-web](apps/app-web.md)、[界面设计规范](design-system.md)                               |
| 后端模块、数据和文档生命周期           | [app-server](apps/app-server.md)                                                           |
| 角色、继承、分享、移动与撤权           | [授权实现](authorization.md)                                                               |
| 内容 Schema、Block ID、版本和迁移      | [document-contracts](packages/document-contracts.md)                                       |
| 命令、扩展、导入导出                   | [editor-core](packages/editor-core.md)                                                     |
| React 生命周期、宿主服务和 UI          | [editor-react](packages/editor-react.md)、[editor-ui](packages/editor-ui.md)               |
| WebSocket 会话、持久化回执、恢复与容量 | [editor-collaboration](packages/editor-collaboration.md)                                   |
| 平台身份 SDK 与日志库                  | [Casdoor SDK](../packages/casdoor/README.md)、[logger-js](../packages/logger-js/README.md) |

## AI 助手与知识检索

| 主题                                    | 入口                                                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 工作台助手、公开问答、会话、草稿和写入  | [统一助手](apps/ai-assistant-and-public-qa.md#当前入口)                                                                |
| 运行时与插件扩展                        | [dsh-agent](packages/dsh-agent.md)、[ai-runtime](packages/ai-runtime.md)、[ai-plugins](packages/ai-plugins.md)         |
| 资料索引、Embedding、Qdrant 与授权复核  | [知识索引](packages/rag.md)、[rag 包消费](../packages/rag/README.md)                                                   |
| 通用 Chat 协议、受控 UI、知书证据与提案 | [chat-contracts](packages/chat-contracts.md)、[chat-ui](packages/chat-ui.md)、[ai-contracts](packages/ai-contracts.md) |

应用组合通用包与业务授权。编辑器内容契约由 `document-contracts` 维护，协同持久化由应用服务端确认。统一助手由服务端通过 DSH 执行，RAG 提供检索和可信证据，Chat UI 消费宿主提供的状态与动作。

## 历史设计与验收记录

- 权限模型的审查、迁移背景和阶段验证。见 [统一 ACL 设计记录](permission-audit-and-design.md)。
- 旧问答、写作双流程及当时的验收。见 [AI Chat 实施记录](packages/ai-chat-implementation.md) 和 [知识问答验收](ai-knowledge-verification.md)。
- 统一助手迁移交接与原拟编辑器桥接包。见 [实施 Prompt](apps/ai-assistant-implementation-prompt.md) 和 [editor-ai-bridge 提案](packages/editor-ai-bridge.md)。

早期 M1–M3 交付矩阵和 D-01–D-07 决策可通过 Git 追溯。整理前的版本可用 `git show d73eb22:docs/README.md` 查看。

## 文档维护

修改可观察行为、默认配置、授权或兼容范围时，同步更新负责该事实的现行页面。HTTP 字段从 Zod 定义生成，内容格式以契约包为准，命令以各 workspace 的 `package.json` 为准。历史记录保留当时的版本、环境及验证范围，并链接现行入口。
