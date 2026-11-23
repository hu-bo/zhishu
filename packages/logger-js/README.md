# @zhishu/logger-js

基于 [pino](https://github.com/pinojs/pino) 的轻量日志封装：

- 开发环境：使用 `pino-pretty`，彩色可读输出到 stdout
- 生产环境：stdout 输出结构化 JSON，同时使用内置的滚动文件 transport 把同样的 JSON 行写入 `LOG_DIR`；两处 JSON 的 `level` 输出文本（`"INFO"`/`"ERROR"`），不是数字
- 测试环境：stdout 输出 JSON（同样文本 level）；可注入 destination 捕获日志
- `level` 为 `silent` 时直接返回裸 Pino 实例，不创建 transport worker（如离线 OpenAPI 导出）

> 配置在创建 logger 时读取；可通过 options 显式覆盖环境、级别和目录。

## 安装

> 说明：当前包在 `package.json` 中标记为 `private: true`，用于本仓库（pnpm workspace）内部引用。

在 monorepo（pnpm workspace）中，在“使用方”应用/包里添加依赖（将 `<consumer>` 替换为你的包名或路径，例如 `apps/app-server`）：

```bash
pnpm --filter <consumer> add @zhishu/logger-js@workspace:*
```

运行时依赖说明：本包内部会按环境加载如下 transport target：

- 开发环境：`pino-pretty`
- 生产环境：本包自带的 `rotating-file-transport`（基于 `rotating-file-stream`），单 target 同时镜像 stdout 与滚动文件；pino 的多目标 `transport.targets` 管道不允许自定义 level formatter，因此不走双 target

这些 transport 及其 peer dependencies 已声明在本包中，使用方无需重复添加。开发前先构建本包。

## 使用

```ts
import { createLogger } from "@zhishu/logger-js";

const logger = createLogger("app-server");

logger.info("service started");
logger.warn({ path: "/health" }, "slow request");
logger.error(new Error("boom"), "unexpected error");

// 子模块 logger（scope）
const apiLogger = logger.child({ scope: "collaboration" });
apiLogger.info({ documentId }, "session opened");
```

知书接入位置：`apps/app-server` 在 `buildApp` 中创建 `app-server` logger 并作为 Fastify 的 `loggerInstance`，请求日志、协同模块（`scope=collaboration`）与启动日志共享同一实例。

### 字段约定

- `service`：创建 logger 时传入的服务名（必填）
- `level`：JSON 输出为文本级别（`"INFO"`、`"ERROR"` 等）；开发环境由 `pino-pretty` 自行渲染
- `scope`：通过 `logger.child({ scope })` 创建的模块/子系统名；也可绑定 runId 等结构化字段
- `env`：`NODE_ENV`
- `time`：Pino 标准 `isoTime`（ISO 8601 UTC）；需要其他时间格式时通过 `timestamp` 选项覆盖

## 环境变量

- `NODE_ENV`：环境（默认 `development`）
- `LOG_LEVEL`：日志级别（默认 `info`；`silent` 不创建 transport）
- `LOG_DIR`：生产环境日志目录（默认 `logs`）

示例：

```bash
export NODE_ENV=production
export LOG_LEVEL=info
export LOG_DIR=/var/log/zhishu
```

## 生产环境日志文件

生产环境使用按天滚动，每行一条 JSON：

- 文件名由 transport 生成，前缀为服务名，以 `.log` 结尾
- 按 `1d` 或单文件 `20M` 滚动
- 保留天数：`30`（按文件 mtime 清理）
- 自动创建目录；进程退出时由 Pino transport 刷新并关闭
- 目录不可用（悬空符号链接、路径被文件占用、挂载只读或已失效）时不中断启动：transport 打一条 `[logger-js] cannot use log directory ...` 到 stderr，日志改为只输出 stdout，修好 `LOG_DIR` 后滚动文件自动恢复

## 开发

在仓库根目录：

```bash
pnpm --filter @zhishu/logger-js build
pnpm --filter @zhishu/logger-js lint
pnpm --filter @zhishu/logger-js test
```

## API

### `createLogger(service: string, options?: LoggerOptions, destination?: DestinationStream)`

- `service`：服务名（必填；为空会抛错）
- options：Pino `LoggerOptions` 加 `environment`、`directory`，支持 level、base、timestamp、redact、serializers
- destination：提供时直接写入该 stream，跳过默认 transport，便于测试或同步输出 stderr
- 返回原生 Pino logger，保留 `child(bindings, options)` 等方法和实例行为，可作为 Fastify 的 `loggerInstance`
- Fastify 场景下建议把返回值标注为 `FastifyBaseLogger`，避免实例泛型收窄为完整 Pino 类型
