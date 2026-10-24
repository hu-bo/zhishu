# @zhishu/dsh-agent

Node.js 进程内写作对话执行器，直接装配官方 Cordis / DSH 0.2.1-rc.2。Node 支持范围为 ^22.19.0 或 >=24；本次验收使用 Node 24.14.0。

公开导出 `createDshRuntime`、`DshChatSession`、`DshRuntimeError` 及 RuntimeOptions / ChatStore / ChatLease / ChatRecord 类型。createSession 和 restoreSession 分别创建/恢复官方 AgentHandle；Session 提供 submit、snapshot、observe、cancel、resume、decide、pluginRecords、dispose。submit 返回受理 Run，终态由输入对应的原生 turn、Session flush 和产品 outbox 提交决定。observe 的 AbortSignal 仅取消该订阅。

```js
import { createDshRuntime } from "@zhishu/dsh-agent";
// store implements the exported ChatStore; configure installs an official
// SessionPersistence implementation and an official LlmAdapter/provider.
const runtime = await createDshRuntime({
  store,
  persistence: "required",
  agentOptions: { provider: "writing", model: configuredModel },
  configure,
});
const session = await runtime.createSession(serverGeneratedSessionId);
const run = await session.submit({
  clientMessageId: "message-1",
  idempotencyKey: "send-1",
  text: "一起构思文章",
});
// Explicitly cancel generation, or dispose only this owned session.
await session.cancel(run.id);
await session.dispose();
await runtime.dispose();
```

宿主负责身份/ACL、模型凭据、数据库与事务、HTTP/SSE、业务提案和资源访问。required 模式拒绝缺少原生 provider 的装配；ephemeral 必须显式声明，不能宣称生产耐久性。provider 必须同时接线 session/event 和 session/flush；仅实现 create/open 方法不够。产品 commit 必须原子保存 ChatRecord 与 ChatEvent，并由 lease/fence 保证单写者。

采用官方 SessionProjectionRegistry 增量投影，不使用废弃的同步历史扫描。包含工具事实的中断不自动重放；SIDE_EFFECT_REVIEW_REQUIRED 需要宿主核对外部副作用。关闭为协作式 drain，provider/tool 必须遵守取消；不能将超时 Promise 当成执行已停止。

可直接运行 `pnpm --filter @zhishu/dsh-consumer-example start`；独立示例只消费构建入口和显式官方依赖，不安装 Fastify。测试命令为本包 `pnpm build && pnpm test && pnpm check:boundaries`。示例使用真实 Loop 与确定性模型，不调用收费服务。应用 PostgreSQL/HTTP/恢复验收见 docs/packages/ai-chat-implementation.md。

本包仍为 private，未发布 registry。来源、MIT 依赖与项目许可证边界见 UPSTREAM.md。
