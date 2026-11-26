# 消费示例

从仓库根目录运行。环境准备见 [本地启动](../README.md#本地启动)。

| 示例   | 入口                                                                                                                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 编辑器 | `pnpm --filter @zhishu/editor-consumer-example dev`。打开 `http://127.0.0.1:5180`，首页有主题和 NodeView 示例，`/lifecycle` 有多实例与生命周期示例，`/bare.html` 用宿主按钮组合公开编辑器命令    |
| Chat   | 独立消费 `chat-contracts` 和 `chat-ui`。见 [运行步骤](chat-consumer/README.md)                                                                                                                   |
| 助手   | `pnpm --filter '@zhishu/assistant-consumer-example^...' build` 后执行 `pnpm --filter @zhishu/assistant-consumer-example start`。使用确定性模型和宿主端口演示统一助手                             |
| 协同   | 设置 `API_URL` 指向专用 QA 后端，例如 `http://127.0.0.1:9010`，运行 `pnpm --filter @zhishu/collaboration-consumer-example smoke`。其他脚本见 [package.json](collaboration-consumer/package.json) |

## WebSocket 联调

编辑器示例的 `/collaboration` 用 mock 身份连接真实 API 与 WebSocket。先按快速开始启动独立的开发后端。在启动编辑器示例的终端将 `API_PROXY_TARGET` 设置为后端 HTTP 地址，例如 `http://127.0.0.1:9010`。协同 origin 加入 `http://127.0.0.1:5180`。

性能脚本要求专用 QA 后端、`PERFORMANCE_QA=true` 和环回 `API_URL`（默认 `http://127.0.0.1:3100`）。先构建依赖，再运行 `pnpm --filter @zhishu/collaboration-consumer-example smoke:performance`。脚本以 20 个真实协同连接编辑约 1 MB/1000 块文档，模拟 WebSocket 双向各 50ms 延迟，分别检查远端更新到达与持久化回执。设置 `PERFORMANCE_POSITION_MATRIX=true` 会增加开头、中间及末尾的位置组合。该脚本测量协议和保存链路的延迟，浏览器绘制需另行验证。
