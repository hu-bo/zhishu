# @zhishu/chat-contracts

浏览器/Node 通用数据包：TypeBox Schema 与派生类型为同一来源，不依赖 React、DSH、LangChain 或文档编辑器。

```js
import {
  isSubmitChatMessage,
  isChatFrame,
  applyChatEvent,
  applyChatSnapshot,
} from "@zhishu/chat-contracts";
const valid = isSubmitChatMessage({ clientMessageId: "m1", idempotencyKey: "k1", text: "你好" });
```

导出 SubmitChatMessageSchema、RunSchema、MessageSchema、ApprovalSchema、ApprovalDecisionSchema、ChatSnapshotSchema、ChatEventSchema、ChatLiveFrameSchema、ChatFrameSchema、纯验证与 applyChatEvent。持久化事件首期采用完整 snapshot + 十进制 sequence；实时 assistant.delta 没有 durable cursor，含运行实例、attempt 和流索引。缺口须重新取授权快照，完整快照替换临时预览。Run 完成与正文 durable ack 无关。

RAG 可以只映射展示数据，无须实现这些写作执行命令。未知执行字段拒绝；未来细粒度事件需要显式协议升级。使用独立示例 examples/chat-consumer，包测试 `pnpm build && pnpm test`。本包 private、未发布；许可记录见 UPSTREAM.md。

`applyChatSnapshot` 合并授权完整快照，允许跨越缺口，但拒绝相同 cursor 不同内容及已确认消息被移除/改写；较晚到达的旧 HTTP 快照不会回退 SSE 状态。`isApprovalDecision` 校验独立消费者提交的审批命令。Run 的可选 `cancelRequested` 表示已持久化取消意图，不等于 Agent 已经停止；终态仍由后续快照确认。

实时 `revision` 标识一次产品文本流，`index` 从 0 开始且只对公开 text delta 连续计数。它们不等于 SDK 原生位置；重连缺少前缀或中途断档时应隐藏不完整预览，等待权威完整消息。未确认预览不能当作保存结果。
