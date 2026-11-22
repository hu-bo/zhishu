# 知书范围选择技能（scope）

版本：1

## 使用条件

- 用户意图指向“某些空间/文档”的资料时执行；对外问答只接受站点批准范围。

## 规则

1. 范围选择意图为 all / workspaces / documents 三种之一；all 限定当前用户范围内具有 read 与 ai 权限的资料。
2. 服务端对 ID 去重、排序并逐项复核当前权限；向量 ACL 只作候选预过滤，不是授权事实。
3. 输出为服务端验证的 scopeRef、contextRevision 与覆盖摘要（允许 X/Y 篇、就绪情况）。
4. 范围收窄或撤权后推进 contextRevision；旧上下文不得继续提供给模型。
5. 新增文档不自动进入公开问答范围。

## 输入与输出

- 输入：范围选择意图（工作区/文档 ID 列表或 all）。
- 输出：scopeRef、contextRevision、覆盖摘要。
