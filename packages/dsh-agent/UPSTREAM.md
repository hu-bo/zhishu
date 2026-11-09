# Upstream implementation references

This package is being designed against the public APIs of DeepSeek Harness.
The runtime, public API, official incremental projection, lifecycle tests, and application adapters are now implemented (2026-10-24). The design is based on official
kernel sources, without copying other applications' agent implementations.

The implementation references read on 2026-10-23 are in the official
[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) repository:

- `packages/core/agent/src/index.ts`: registry creation, restoration, and AgentHandle ownership.
- `packages/core/agent/src/runtime-types.ts`: delivery, cancellation, and assistant stream events.
- `packages/core/agent-loop/src/index.ts` and `src/agent.ts`: prerequisite services and the official execution loop.
- `packages/core/session/src/index.ts`: append-only Session facts and flush semantics.
- `packages/core/tools/src/index.ts`: native tools and scoped policies.
- `packages/session/session-persistence/src/index.ts`: provider-owned persistence and write handles.
- `packages/session/session-checkpoint-policy/src/index.ts`: durability barriers before model/tool dispatch.
- `packages/interaction/user-approval/src/index.ts`: one-shot permission outcomes and request lifetime.
- `packages/test-support/agent-loop-testkit/src/index.ts`: the official prerequisite service composition.
- `packages/llm/llm/src/index.ts`: provider adapters and model dispatch.

The supplied upstream source snapshot identifies itself as `0.2.1-rc.2`. Runtime dependencies
are pinned to that published DSH release and Cordis `4.0.5`; implementation and tests consume
the published package exports, not local source paths. DeepSeek Harness dependencies declare
MIT licensing; their copyright notices and license obligations remain with those dependencies.
This file records provenance and does not assign a new license to the enclosing project.

2026-10-30 published-package audit: `dsh-agent-loop@0.2.1-rc.2` increments its native
assistant frame `revision` on every start/chunk/end, while `attemptId` identifies the model
attempt. The adapter keeps one product revision per native attempt and assigns a dense
public-text index after filtering reasoning and other private chunks. Native positions
are not forwarded as if they were product text-stream positions. The incremental projection
also folds public `agent/inbox/spliced` facts to correlate claimed input whose pre-step
was blocked before a `user/message` could be appended.

# 来源与许可证记录

本包由知书仓库独立实现，不依赖 Nova 仓库，不复制其他应用的 agent/harness 实现。

DeepSeek Harness 官方来源：https://github.com/deepseek-ai/deepseek-harness 。官方 DSH 包锁定 0.2.1-rc.2，Cordis 锁定 4.0.5；发布 manifest 的 license 为 MIT。只从公开 package exports 消费服务、类型和扩展点；安装包内的 LICENSE/版权通知保持原样，未将本项目代码重新许可为 MIT。

其他声明依赖按各自 package manifest 保留许可：React（MIT）、TypeBox（MIT）、Zod（MIT）；workspace 内容契约沿用仓库许可状态。具体依赖闭包和版本以 pnpm-lock.yaml 为准。

本仓库尚未声明对外项目许可证。本包保留 private 和 UNLICENSED，不发布 registry；技术上的独立安装验收不代表授予新的再分发许可。
