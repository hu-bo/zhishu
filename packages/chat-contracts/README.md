# @zhishu/chat-contracts

浏览器/Node 通用数据包：TypeBox Schema 与派生类型为同一来源，不依赖 React、DSH、LangChain 或文档编辑器。

```js
import { isSubmitChatMessage, isChatFrame, applyChatEvent } from "@zhishu/chat-contracts";
const valid = isSubmitChatMessage({ clientMessageId: "m1", idempotencyKey: "k1", text: "你好" });
```

导出 SubmitChatMessageSchema、RunSchema、MessageSchema、ApprovalSchema、ApprovalDecisionSchema、ChatSnapshotSchema、ChatEventSchema、ChatLiveFrameSchema、ChatFrameSchema、纯验证与 applyChatEvent。持久化事件首期采用完整 snapshot + 十进制 sequence；实时 assistant.delta 没有 durable cursor，含运行实例、attempt 和流索引。缺口须重新取授权快照，完整快照替换临时预览。Run 完成与正文 durable ack 无关。

RAG 可以只映射展示数据，无须实现这些写作执行命令。未知执行字段拒绝；未来细粒度事件需要显式协议升级。使用独立示例 examples/chat-consumer，包测试 `pnpm build && pnpm test`。本包 private、未发布；许可记录见 UPSTREAM.md。
