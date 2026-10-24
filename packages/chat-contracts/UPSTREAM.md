# 来源与许可证记录

本包由知书仓库独立实现，不依赖 Nova 仓库，不复制其他应用的 agent/harness 实现。

DeepSeek Harness 官方来源：https://github.com/deepseek-ai/deepseek-harness 。官方 DSH 包锁定 0.2.1-rc.2，Cordis 锁定 4.0.5；发布 manifest 的 license 为 MIT。只从公开 package exports 消费服务、类型和扩展点；安装包内的 LICENSE/版权通知保持原样，未将本项目代码重新许可为 MIT。

其他声明依赖按各自 package manifest 保留许可：React（MIT）、TypeBox（MIT）、Zod（MIT）；workspace 内容契约沿用仓库许可状态。具体依赖闭包和版本以 pnpm-lock.yaml 为准。

本仓库尚未声明对外项目许可证。本包保留 private 和 UNLICENSED，不发布 registry；技术上的独立安装验收不代表授予新的再分发许可。
