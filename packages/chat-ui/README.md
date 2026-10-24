# @zhishu/chat-ui

React 19 受控 Chat 展示组件。业务 API、身份、会话、草稿持久化与执行引擎由宿主拥有。

```tsx
import { Chat, Composer } from "@zhishu/chat-ui";
import "@zhishu/chat-ui/styles.css";
<Chat
  messages={messages}
  composer={<Composer value={text} onValueChange={setText} onSubmit={submit} />}
/>;
```

公开组件：Chat、MessageList、MessageParts、Composer、AttachmentList、ChatStatus、ApprovalCard、ArtifactCard。视图类型为 MessageView / MessagePart / AttachmentView。MessageParts 支持文本、代码、允许协议的图片、工具、错误和宿主插件内容。组件不执行 HTML 或猜测未知插件动作。Composer 处理 Enter / Shift+Enter / IME；提交、停止和错误结果由受控 Props 表达。MessageList 支持手动回到底部、历史加载与保持阅读位置。

子入口：./composer、./message-list、./approval、./styles.css。CSS 已构建且有作用域，不依赖宿主 Tailwind 扫描，无 body reset。主题变量为 --chat-surface、--chat-foreground、--chat-muted、--chat-border、--chat-accent、--chat-radius、--chat-content-width、--chat-danger；可映射应用亮暗主题。

`pnpm --filter @zhishu/chat-consumer-example dev` 可运行两个独立受控实例，纯 fixture 不调用业务 API。实际应用的 WritingChat、RagChat 各自维护状态。包 private、未发布；许可记录见 UPSTREAM.md。
