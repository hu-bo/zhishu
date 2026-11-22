# dsh-agent：DSH 原生接入设计

状态：2026-11-13 新目标，尚未在主工程恢复此 package。当前有效接入位于 ai-writing/runtime，下一轮迁入本包。完整产品设计及验收以 [主技术文档](../apps/ai-assistant-and-public-qa.md) 为准。

## 职责

本包封装官方 Cordis/DSH 的 Agent、Session、Loop、工具审批、原生日志持久化、取消及恢复接入。问答、research 和写作使用同一执行内核，不按产品意图区分引擎。

只处理原生执行事实，不持有产品 ChatRecord，不拥有消息/Run/产物的第二份可写快照、业务 SQL、用户权限或产品任务队列。会话/Run 标识与租约通过宿主边界关联，SDK 原生状态不替代应用授权。

## 接入边界

- 模型及持久化适配由服务端装配，凭据留在服务端；浏览器不加载本包。
- 原生 Session、日志 flush、所有权丢失、审批及取消保持真实语义，不用超时 Promise 表示执行已经结束。
- 可恢复原生完成事实交给宿主校验后补交；有未知外部副作用时先核对，不自动重放。
- 主工程的 ai_sessions 存官方当前格式，客户端不可直接读取；本包不直接依赖业务数据库。
- SDK 装配和生命周期只保留一份，ai-runtime 不再建立第二个模型 Loop。
- 公开入口按实际消费需要设计，不把全部 SDK API 批量重导出为包装层。
- 预览帧向宿主转发公开过程事实：text 与 thinking 各为连续 delta 流，工具参数以 tool-args 通道透传、工具生命周期（running/completed/failed）由原生会话事件补发；本包不理解知书工具语义，怎么呈现由 ai-runtime 与宿主决定（见 [ai-runtime](ai-runtime.md)）。

## 代码迁移

优先从当前主工程的 ai-writing/runtime 迁移有效实现，剥离 WritingRunContext、WritingProposalPayload 和应用数据库的强耦合，将实际业务动作留在 runtime/插件或宿主。不得仅重命名目录而保留写作专属产品协议。

参考归档中的同名包只提供 SDK 接入背景；不恢复 ChatStore/ChatLease/ChatRecord 的旧产品快照协议、旧 DshChatSession 产品生命周期或兼容 exports。使用新包名下的当前接口，不为旧消费者保留别名。

## 验证

独立消费不需要知书数据库、路由或权限系统，确定性模型验证原生投递、工具执行、取消、审批、恢复及释放。应用级跨用户、fencing、outbox、正文持久化由服务端验证，不能把 SDK flush 当作产品消息或正文已提交。
