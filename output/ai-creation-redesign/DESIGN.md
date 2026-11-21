# 知书「AI 创作」页面重设计方案

> 状态：设计稿（本阶段不改生产代码）。配套高保真原型：[prototype.html](./prototype.html)。
> 设计基线：2026-11-14 工作区源码（`features/assistant/` 统一助手已落地版本）、`docs/design-system.md`、`docs/apps/ai-assistant-and-public-qa.md`、AGENTS.md 约束。
> 视觉体系：HeroUI v3 + Tailwind v4 + `globals.css` oklch 主题变量；不引入新依赖。

---

## 0. 结论速览

| 议题 | 结论 |
| ---- | ---- |
| 顶部「问答/创作」切换 | **保留，但移入底部输入工具条右侧簇**（紧邻发送）。意图是"本轮消息如何被处理"的属性，语义上属于输入区；顶部只留会话身份与绑定状态 |
| 顶部「范围」chip | **移除**。由工具条左侧「来源范围」选择器取代（唯一入口，消除分散感） |
| 联网调研 checkbox | 改为 **icon + 文本 ToggleButton**（地球图标 +「联网搜索」），选中态 accent-soft 底 + accent 前景 |
| 内嵌「创建草稿」裸表单 | 改为 **「待确认草稿」动作卡片**嵌入消息流：工具条「创建草稿」按钮点击后在流内生成卡片，卡内确认保存位置与要求，确认后卡片自身流转状态 |
| 保存/写入类结果 | 统一 **ActionCard** 动作卡片：图标 + 标题 + 状态徽标 + 关键信息 + 主次按钮；状态严格映射服务端事实（受理 ≠ 持久化确认 ≠ 索引完成） |
| 提案审阅 | 卡片内 **逐条 accept/reject** + 计数徽标 + 全部接受/全部拒绝；应用后展示持久化确认与回执摘要 |
| 附件上传 | 工具条最左「+」菜单（图片/文件），输入框上方 **附件 chip 条**：上传中/就绪/失败三态、可删除、可重试（服务端契约依赖见 §6.5，排期第 3 阶段） |
| 消息视觉 | 助手头像 ✦ 徽片 + 无气泡正文 + 流式阶段 chip + hover 动作；用户气泡保留 accent wash，补发送状态行 |
| 空态 | 居中问候 + 2×2 建议卡（icon + 标题 + 提示语），替代纯文本按钮列表 |

---

## 1. 现状与问题（对应源码）

当前实现入口：`apps/app-web/src/features/assistant/`（本轮统一助手重构后的版本），基础件在 `packages/chat-ui/`。

| # | 现状 | 代码位置 | 问题 |
| - | ---- | -------- | ---- |
| 1 | 顶部 header 同时放「问答/创作」胶囊 tab、「范围：全部有权限资料」chip、「已绑定文档」灰字 | `assistant-chat.tsx` `header` 插槽、`scope-picker.tsx`（compact） | 会话级信息与每轮输入属性混在一行；范围 chip 是原生 radio/checkbox 弹层，视觉原始 |
| 2 | 「创建草稿…」按钮 + 展开裸表单（select + textarea + button）挂在消息流末尾 | `assistant-chat.tsx` `DraftPanel`/`DraftForm`（`afterMessages` 插槽） | 表单裸露、无状态表达；位置漂移在消息流底部而不是与动作结果绑定；保存空间下拉与顶部范围 chip 形成两处"范围感"控件 |
| 3 | 「联网调研」是原生 checkbox | `assistant-chat.tsx` `toolbarStart` 插槽（`writing-web` label） | 控件原始、选中态无视觉反馈；不可用态是纯文本 |
| 4 | 无附件能力 | `chat-ui` `Composer` 已有 `attachments`/`AttachmentView` 插槽但宿主未使用，且 `AttachmentView` 仅 `{id,label,status?}` | 无法上传图片/PDF/Word 等；类型缺状态机字段 |
| 5 | 提案审阅 = checkbox 列表 +「应用选中/拒绝提案」两个裸按钮 | `proposal-review.tsx`（chat-ui `ArtifactCard` 内） | 无逐条 accept/reject、无进度计数、应用结果（applied/partial/conflict/unknown）只有文本段落，没有卡片化状态与后续动作 |
| 6 | 图片任务/工具审批也是裸文本卡 | `image-artifacts.tsx`、`chat-ui/approval.tsx` | 与提案、草稿各说各话，缺统一动作卡片语言 |
| 7 | 消息气泡：助手 = 「✦ 知书助手」标签 + 纯段落；流式预览无阶段表达 | `chat-ui/message-list.tsx`、`assistant-chat.tsx` `buildMessages` | 层级弱；`PreviewFrame.stage`（scope/searching/reading/generating/validating）数据已有但未呈现 |
| 8 | 空态 = 一段文字 + 建议问题胶囊列表 + 又一个 ScopePicker | `assistant-chat.tsx` `emptyState` 插槽 | 引导性弱，且范围选择出现第三处 |

**核心诊断**：控件语义没有按"会话级 / 每轮输入级 / 动作结果级"分层，导致同类选择器出现三处、结果表达退回裸文本。本方案按这三层重新分配职责，并把所有"AI 做事的结果"统一为动作卡片语言。

---

## 2. 设计原则（含状态语义红线）

1. **三层职责分离**
   - 顶部 header = 会话身份与绑定事实（标题、已绑定文档、历史/新对话）。
   - 输入工具条 = 本轮输入的全部属性（附件、意图、来源范围、保存目标、联网、发送）。
   - 消息流 = 对话内容 + 动作卡片（一切"AI 产物 / 写入 / 回执"的权威呈现位）。
2. **状态即事实**（AGENTS.md / 主技术文档约束，设计红线）：
   - 只有真实持久化回执才能显示「已保存 / 已创建 / 已应用」。模型输出完成、预览出现、编辑器已连接都**不得**表现为已保存。
   - 三段式保存语义必须可区分：**① 已发送/已受理**（请求被服务端接受、Run 排队/执行）→ **② 服务端持久化确认**（create-draft 事务提交 / 结构操作 durable 回执）→ **③ 版本索引完成**（文档进入检索索引，事实来自服务端索引状态）。第③步无服务端事实时宁可显示"以文档页状态为准"，不做推测。
   - 结果未知（`unknown`/`interrupted`）单列状态：文案说明"按操作标识核对回执，不会重复写入/创建"，动作只有「刷新状态/核对」，**不提供盲目重试**。
   - 权限文案红线：范围选择器与保存位置选择器只陈述"服务端将按当前权限再次校验/计算"，绝不暗示前端列表即权限事实；无权空间的失败由服务端错误驱动卡片危险态。
3. **一个业务事实一个控件**：来源范围只在工具条选择器；保存位置只在「保存到」选择器（待确认卡片内显示的是它的值 + 卡内「更改」跳回该选择器，不复制第二份下拉数据源——卡片内允许就地改值，但写回同一状态）。
4. **紧凑输入条，卡片化结果**（吸收 YouMind 质感）：工具条单行 32px 控件、图标 + 短文本；一切展开信息进 Popover；一切结果进卡片。
5. **表驱动实现预留**：所有多态组件（徽标、卡片、chip、阶段）在实施时用 `satisfies Record<状态, 配置>` 单表定义文案/图标/色调，杜绝嵌套三元（AGENTS.md 代码要求）。本文档每个组件都给出该状态表。
6. **公开访客模式收敛**：`mode="public"` 隐藏意图段、保存到、创建草稿、联网、附件（服务端本就不开放），仅保留只读范围提示 + 发送。设计的所有新控件都挂 `mode === 'internal'` 与 capabilities 判断，延续现有边界。

---

## 3. 信息架构与布局

### 3.1 职责重分配

```
┌ 顶部 header（48px，会话级）────────────────────────────────────────┐
│ [✦] AI 创作 · {会话标题}          [已绑定：文档名 ↗]?  [历史] [新对话] │
└──────────────────────────────────────────────────────────────────┘
┌ 消息流（会话内容 + 动作卡片）──────────────────────────────────────┐
│  空态 / 用户气泡 / 助手回答(引用·阶段·hover动作) / ActionCard 序列   │
└──────────────────────────────────────────────────────────────────┘
┌ 状态行 ChatStatus（12px，一行制）──────────────────────────────────┐
┌ 输入卡 Composer（每轮输入级）──────────────────────────────────────┐
│  [附件 chip 条]?                                                    │
│  textarea                                                           │
│  [+][来源范围 ▾][保存到 ▾(创作)]      [问答|创作][联网搜索][创建草稿]?[↑] │
└──────────────────────────────────────────────────────────────────┘
```

### 3.2 Chat-first 全页线框（未绑定目标文档）

```text
┌──────────────────────────────────────────────────────────────────────┐
│ ✦ AI 创作 · 新对话                                    [🕘] [＋新对话] │
├──────────────────────────────────────────────────────────────────────┤
│                        （消息区，居中 ≤ 760px）                        │
│                                                                      │
│   帮我调研知识库信息架构的最佳实践，并准备一篇文章大纲。      ┌──────┐ │
│   └ 已发送                                                  │ 你   │ │
│                                                             └──────┘ │
│   [✦] 知书助手                                                        │
│   检索资料 · 3 个空间 → 生成中 → 校验引用        ← 流式阶段 chip 行     │
│   信息架构最佳实践可归纳为四点¹ ……                                      │
│   ▸ 来源 4 条（可展开）              [复制] [重新生成]  ← hover 动作    │
│                                                                      │
│   ╭─ ActionCard：提案审阅 ──────────── [待确认] ─────────╮            │
│   │ ✎ 对《信息架构规范》的修改提案        已接受 1 · 共 3   │            │
│   │ [1/3 ‹ ›]  逐条 ✓接受 / ✕拒绝 行                      │            │
│   │ [应用提案（2 项）]  [全部拒绝]                          │            │
│   ╰──────────────────────────────────────────────────────╯            │
│                                                                      │
│   ╭─ ActionCard：创建草稿 ──────────── [待确认] ─────────╮            │
│   │ 📄 创建草稿：知识库信息架构最佳实践                    │            │
│   │ 保存到  [个人空间（仅你可见） ▾]                       │            │
│   │ 草稿要求 「……可编辑，默认取最近一轮你的输入…」           │            │
│   │ [确认创建]  [编辑要求]  [取消]                          │            │
│   ╰──────────────────────────────────────────────────────╯            │
├──────────────────────────────────────────────────────────────────────┤
│ 提案与草稿需经你确认后写入                                             │
│ ╭──────────────────────────────────────────────────────────────────╮ │
│ │ [📎调研资料.pdf ✓][🖼架构图.png 65%↑][⚠表格.xlsx 失败↻]  ← chip 条 │ │
│ │ 提出一个问题，或输入写作要求……                                      │ │
│ │ [＋][🗂 来源：全部有权限资料 ▾][📁 保存到：个人空间 ▾]              │ │
│ │                    [💬 问答|✎ 创作][🌐 联网搜索][✎ 创建草稿][ ↑ ]  │ │
│ ╰──────────────────────────────────────────────────────────────────╯ │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.3 双栏工作台线框（目标已绑定，桌面）

```text
┌────────────────────────────────────────┬──────────────────────────────┐
│  DocumentCollaborationEditor（不变）    │ ✦ AI 创作 · {会话标题}        │
│                                        │ [已绑定：{文档名} ↗]          │
│  正文中的提案目标块高亮/滚动定位         ├──────────────────────────────┤
│  （由卡片 [定位] 动作触发，见 §4.4）     │  同一会话消息流 + 动作卡片     │
│                                        │  ……                          │
│                                        ├──────────────────────────────┤
│                                        │ 状态行                       │
│                                        │ ╭──────────────────────────╮ │
│                                        │ │ textarea                 │ │
│                                        │ │ [＋][来源▾]  [问答|创作]  │ │
│                                        │ │ [🌐联网]          [ ↑ ]  │ │
│                                        │ ╰──────────────────────────╯ │
└────────────────────────────────────────┴──────────────────────────────┘
```

绑定后工具条变化：「保存到」「创建草稿」隐藏（已有目标，写入走提案）；「来源范围」出现「当前文档」快捷项；header 出现可点击的绑定 chip（点击 = 窄屏切到文档视图 / 桌面滚动定位标题）。

### 3.4 窄容器收起规则（container query，不用视口断点）

Chat 面板在双栏下仅 360–420px。对 `.assistant-chat-pane` / composer 容器启用 `container-type: inline-size`：

| 容器宽度 | 工具条形态 |
| -------- | ---------- |
| ≥ 560px | 全形态：所有控件 icon + 文本 |
| 420–559px | 「联网搜索」「创建草稿」收起为 icon-only（Tooltip 保留全文）；范围/保存到值文本 `max-width: 10ch` 截断 |
| < 420px | 意图段收起为单个 icon 按钮（当前意图图标，点击弹 Dropdown 选择）；范围/保存到值文本 `max-width: 6ch`；工具条允许 `flex-wrap` 换两行，发送钮恒定右下 |
| 触控设备 | 所有可点目标 ≥ 44px（chip 删除钮扩大热区，视觉仍 20px） |

---

## 4. 组件规格

通用 token（`globals.css`，亮/暗均已有定义）：
`--surface`、`--surface-secondary`、`--surface-hover`、`--foreground`、`--muted`、`--border`、`--accent`、`--accent-soft`、`--accent-soft-foreground`、`--success(-soft)`、`--warning(-soft)`、`--danger(-soft)`、`--overlay-shadow`、`--surface-shadow`。圆角：控件 10px（`--radius-lg`）、卡片 16px（`--radius-xl`≈14px，卡片用 16px 固定值与现有 composer 一致）、菜单 12px。控件高：工具条 32px、卡片按钮 32px（HeroUI `size="sm"` 36px 亦可，统一取 32 以保紧凑）、发送 34px。

徽标（badge）色调总表——所有卡片/chip 共用：

| tone | 背景 | 前景 | 用途 |
| ---- | ---- | ---- | ---- |
| neutral | `--surface-secondary` | `--muted` | 已拒绝、已取消、纯信息 |
| info | `--accent-soft` | `--accent-soft-foreground` | 待确认、进行中（非风险） |
| success | `--success-soft` | `--success-soft-foreground` | 持久化确认类：已创建/已应用/已保存 |
| warning | `--warning-soft` | `--warning-soft-foreground` | 结果未知、部分应用、索引未就绪 |
| danger | `--danger-soft` | `--danger-soft-foreground` | 失败、冲突 |

暗色主题下同名 token 自动切换（`--*-soft` 已按 `.dark` 定义），无需单独设计暗色值；本文各表只标注 tone。

### 4.1 输入工具条（Composer toolbar）

结构（复用 `chat-ui Composer` 的 `toolbarStart` / `toolbarEnd` 插槽，宿主组合）：

```
toolbarStart: [＋添加] [│] [来源范围 ▾] [保存到 ▾]*        * 仅 internal 且创作意图且未绑定
toolbarEnd:   [问答|创作]*  [🌐 联网搜索]*  [✎ 创建草稿]*  [↑ 发送 / ■ 停止]
```

#### 4.1.1 ＋ 添加附件按钮

- 触发器：32×32 icon-only ghost 按钮，`+` 16px；`aria-label="添加附件"`；Tooltip「上传图片或文件」。
- 点击弹 Dropdown（`components/ui/menu.tsx` 的 Menu 封装，`placement="top start"`，宽 240px）：

```
┌ 添加 ────────────────────────────┐
│ 🖼 上传图片                       │   描述行：PNG / JPG / GIF / WebP
│ 📄 上传文件                       │   描述行：PDF / Word / Excel / Markdown / TXT
│ ─────────────────────────────── │
│ 🗂 从知识库引用…        （禁用）   │   描述行：后续版本支持
└──────────────────────────────────┘
```

- 菜单项 = 图标(16) + 名称(13px) + 次行描述(11px muted)，符合"图标、名称和状态横向排列"的菜单规范；点击触发隐藏 `<input type="file" accept=… multiple>`。
- 大小/类型限制以服务端 capabilities 为准（展示值来自 `GET /api/ai/capabilities` 的附件限制字段，缺省文案不写具体 MB 数，避免前端伪造约束）。
- 状态表：

| 状态 | 视觉 |
| ---- | ---- |
| 默认 | ghost，`--muted` 图标 |
| hover | `--surface-hover` 底，`--foreground` 图标 |
| 菜单展开 | `--accent-soft` 底 + `aria-expanded=true` |
| 禁用（public 模式 / 上传进行中数量达上限 / capabilities 未开放） | opacity .5，Tooltip 说明原因 |
| 聚焦 | `focus-visible` 2px accent ring（沿用全局） |

#### 4.1.2 意图分段（问答 | 创作）

- 形态：胶囊 segment，高 32px，两段各 `icon + 2字`（💬 问答 / ✎ 创作），容器 `--surface-secondary` 底 + 1px `--border`，选中段 `--surface` 底 + 细阴影 + `--foreground` 文本（借鉴 `--segment` token），未选中 `--muted`。
- 行为：仅改 `intentHint` 与界面呈现，不换会话（延续现有语义）。切到「创作」：显示「保存到」选择器与「创建草稿」按钮（未绑定时）、placeholder 换写作文案；切回「问答」：隐藏两者，**保留**已选保存目标值（回到创作时不丢）。
- 键盘：`role="radiogroup"`，←/→ 切换，Space/Enter 确认；IME 组合期间不响应 textarea 之外的按键抢占（分段不在输入框内，天然无冲突）。
- 状态表：

| 状态 | 选中段 | 未选中段 |
| ---- | ------ | -------- |
| 默认 | surface 底 + foreground + 阴影 | 透明底 + muted |
| hover | — | surface-hover 底 |
| 键盘聚焦 | focus ring | focus ring |
| 禁用（public） | 整个分段不渲染 | — |

#### 4.1.3 来源范围选择器（ScopePicker 重设计）

- 触发器：ghost 按钮高 32px，`icon(16) + 值文本(13px, max-w 截断) + chevron-down(14)`。图标语义：`all`=书库/双菱形，`workspaces`=文件夹，`documents`=文件。值文本示例：「全部有权限资料」「3 个空间」「文档：信息架构规范」。非默认值（非 all）时图标着 `--accent` 色提示"已收窄"。
- 弹层：Popover（HeroUI `Popover`，`placement="top start"`，宽 320px，圆角 12px，`--overlay-shadow`），内容：

```
┌ 检索范围 ────────────────────────────────┐
│ ✓ 🗂 全部有权限资料                        │  单选，checkmark 指示
│    按当前权限由服务端实时计算               │  11px muted 描述
│   📄 仅当前文档《信息架构规范》             │  仅有 documentLabel 时出现
│   📁 指定空间（最多 8 个）          3/8 ▸  │  点击展开空间 checkbox 列表
│      ☑ 产品团队空间        [团队]          │  kind 徽标：个人/团队
│      ☑ 设计知识库          [团队]          │  列表 max-height 12rem 内滚动
│      ☐ 个人空间            [个人]          │
│   🔍 指定文章…                    （二期） │  打开文档搜索多选（≤64 篇）
│ ─────────────────────────────────────── │
│ ⓘ 最终检索集合由服务端按当前授权计算；      │  11px muted footer
│   变更范围将停止进行中的旧任务并推进上下文。 │
└──────────────────────────────────────────┘
```

- 选择即生效（现有 `changeScope` → `updateContext`，乐观更新 + 失败回滚并 toast 错误）；弹层不因选择自动关闭（多选场景），Esc / 点外部关闭。
- 空态：`workspaces` 查询未返回时列表区显示 Skeleton 3 行；无可见空间时「指定空间」项禁用 + 描述「没有你可访问的空间」。
- 状态表（触发器）：

| 状态 | 视觉 |
| ---- | ---- |
| 默认 | ghost + muted 图标/文本 |
| hover | surface-hover 底 |
| 展开 | accent-soft 底，chevron 旋转 180° |
| 已收窄（非 all） | 图标 accent 色 |
| 更新中（updateContext in-flight） | 值文本旁 12px Spinner，触发器禁用 |
| 更新失败 | 值回滚 + 状态行错误文案（不在触发器上常驻错误色） |
| 禁用（public 模式） | 渲染为静态只读 chip「范围：站点批准资料」，不可点 |

#### 4.1.4 保存到选择器（新增，创作意图专属）

- 触发器：与来源范围同规格，图标=文件夹+下箭头（保存语义），文本「保存到：个人空间」。未选择且无个人空间时文本「选择保存位置…」+ warning 色 chevron，提醒必须显式选择。
- 弹层内容：

```
┌ 保存位置 ────────────────────────────────┐
│ ✓ 📁 个人空间                             │
│    个人空间 · 仅你可见                     │  可见规则描述（服务端字段）
│   📁 产品团队空间                         │
│    团队空间 · 全体成员可见                 │
│   📁 设计知识库                           │
│    团队空间 · 全体成员可见                 │
│ ─────────────────────────────────────── │
│ ⓘ 草稿将创建为所选空间中的一篇真实文档；    │
│   创建时服务端将再次校验你的写入权限。      │
└──────────────────────────────────────────┘
```

- 单选，选中即关闭 Popover。默认值：有权的个人空间（延续现有 DraftForm 行为，且**始终可见地显示在触发器上**，满足"不猜测保存位置"——用户任何时刻都能看到当前目标）。无个人空间时不预选。
- 列表来源 `listKnowledgeWorkspaces()`（服务端已按身份返回）；描述行展示空间可见规则文案。
- 状态表：同 4.1.3（无"更新中"态；增加「未选择」warning 提示态）。

#### 4.1.5 联网搜索 toggle（替换 checkbox）

- 形态：HeroUI 风格 ToggleButton，高 32px，`🌐 icon(16) + 「联网搜索」(13px)`，圆角 10px。
- 状态表：

| 状态 | 视觉 | aria |
| ---- | ---- | ---- |
| 默认（关） | ghost：透明底 + 1px `--border`，muted 图标/文本 | `aria-pressed="false"` |
| hover | `--surface-hover` 底 | — |
| 选中（开） | `--accent-soft` 底 + 1px `color-mix(accent 30%, border)` + `--accent-soft-foreground` 文本，图标换填充地球 | `aria-pressed="true"` |
| 选中 + hover | `--accent-soft-hover` 底 | — |
| 禁用（capabilities.webSearchAvailable=false） | opacity .5 + 不可点；Tooltip「联网调研未在服务端配置，暂不可用」；**不展示内部配置键名** | `aria-disabled` |
| 聚焦 | focus-visible accent ring | — |

- public 模式不渲染。发送时若已开启但 capability 变为不可用，沿用现有前置校验，错误进状态行。

#### 4.1.6 创建草稿按钮（创作意图 + 未绑定 + internal）

- 形态：secondary 小按钮，高 32px，`✎ icon + 「创建草稿」`。位置：toolbarEnd 最右、发送钮左侧（主次分明：发送=发消息，创建草稿=显式命令）。
- 点击行为：**不弹表单**。立即在消息流末尾插入一张「待确认草稿」ActionCard（§4.3.2 状态 `local-draft`），并平滑滚动到该卡片、聚焦卡片内「确认创建」。工具条上的「保存到」当前值作为卡片默认保存位置；卡片内「更改」按钮 = 聚焦/打开工具条「保存到」选择器（同一状态源）。
- 状态表：

| 状态 | 视觉/行为 |
| ---- | -------- |
| 默认 | secondary |
| hover | secondary-hover |
| 禁用：存在活跃 Run | opacity .5 + Tooltip「当前任务完成后可创建」 |
| 禁用：未选保存位置且无个人空间 | Tooltip「请先选择保存位置」 |
| 禁用：capabilities 未启用 writing | 不渲染 |
| 已存在待确认卡片 | 点击改为滚动定位到该卡片（不重复插入） |

#### 4.1.7 发送 / 停止

- 维持 chat-ui 现有 34px 圆角方钮（radius 11px）：发送=accent 底 + 上箭头；停止=同尺寸 + 方形停止符。升级点：
  - 发送禁用态从 opacity .5 改为 `--surface-secondary` 底 + `--muted` 图标（更轻、不与选中态混淆）。
  - submitting（本地已发出、未回执）时发送钮内显示 12px Spinner。
  - 停止钮在 `cancelRequested` 后显示 Spinner + 禁用（现有 stopping 语义）。
- 键盘：Enter 发送 / Shift+Enter 换行 / IME 组合中 Enter 不发送（chat-ui 已实现，保持不变）。

### 4.2 附件 chip（AttachmentChip，chat-ui 展示 + 宿主上传状态机）

位置：Composer 内 textarea 上方（现有 `attachments` 插槽位），横向 flex-wrap，间距 6px，条区最多两行高度后内部滚动。

形态：
- 文件 chip：高 32px，圆角 10px，1px `--border`，`类型图标(16, 按扩展名着色) + 文件名(12px, max-w 18ch 截断) + 状态区 + 删除×(20px 热区 28px)`。
- 图片 chip：56×56 缩略图（object-fit cover，圆角 10px），右下角状态角标，hover 浮现 × 与放大预览（预览用现有 dialog 封装，二期可裁）。

状态表（`AttachmentView.status` 扩展为状态机）：

| status | 视觉 | 交互 |
| ------ | ---- | ---- |
| `uploading` | 文件类型图标 + 名称 + 12px ProgressCircle/百分比文本；chip 底边 2px accent 进度条；图片 chip 缩略图蒙层 40% + 中央 Spinner | × 可取消（abort 上传） |
| `ready` | 名称 + 尺寸文本(11px muted) + 右上 12px ✓ success 色（图片 chip 无角标，缩略图即证） | × 删除；发送后 chip 移入消息气泡内展示（只读） |
| `failed` | 1px `--danger` 边 + `--danger-soft` 底 + ⚠ 图标 + 失败原因 Tooltip（类型不允许/超限/网络） | [↻ 重试] + [×] 两钮 |
| `rejected`（校验不通过，可选并入 failed） | 同 failed，原因固定为服务端校验文案 | 仅 [×] |

发送门控：存在 `uploading` 附件时发送钮禁用 + Tooltip「附件上传中」；`failed` 附件不随消息发送（发送时自动剔除并在状态行提示，或要求用户处理——取"剔除 + 提示"，减少阻塞）。

### 4.3 ActionCard 动作卡片（新展示原语）

#### 4.3.1 结构（chat-ui 新增 `ActionCard` 展示组件）

```
╭──────────────────────────────────────────────────────╮
│ [icon tile 36] 标题(14 semibold)   [状态徽标]  时间(11) │  header
│                 副标题/目标(12 muted)                   │
│ ─────────────────────────────────────────────────── │
│ 关键信息区：键值行 / 摘要 / 步骤轨 / 列表（12–13px）      │  body(可选)
│ ─────────────────────────────────────────────────── │
│ 脚注(11 muted, 可选)              [次按钮] [主按钮]     │  footer
╰──────────────────────────────────────────────────────╯
```

- 容器：宽=消息内容宽（`--chat-content-width`），圆角 16px，1px `--border`，`--surface` 底，`--surface-shadow`，内边距 14px 16px。
- icon tile：36×36 圆角 10，`tone-soft` 底 + tone 前景色图标（tone 随状态徽标，见各卡状态表）。
- 徽标：高 20px 圆角 999 胶囊，11px 文本，可带前置 6px 状态点/Spinner。
- 按钮：HeroUI Button `size="sm"`；主按钮每卡至多 1 个；危险动作（全部拒绝）用 ghost/danger-soft，不与主按钮同权重。
- 布局：卡片在消息流中靠左对齐、与助手消息同栅格（不是居中浮层），出现/状态切换用 200ms opacity+translateY 过渡（尊重 `prefers-reduced-motion`）。

#### 4.3.2 创建草稿卡（DraftActionCard）

状态表——事实来源映射是设计核心：

| state | 触发事实（来源） | 徽标(tone) | 标题/关键信息 | 主按钮 | 次按钮 | 脚注 |
| ----- | ---------------- | ---------- | ------------- | ------ | ------ | ---- |
| `local-draft` | 用户点击「创建草稿」，尚未提交（本地 UI 态，可随 chat-draft 缓存恢复） | 待确认 (info) | 「创建草稿：{要求首行或'未命名草稿'}」；键值行：保存到 {空间名+可见规则}（卡内 [更改]）、草稿要求（折叠 3 行，可 [编辑要求] 展开 textarea） | 确认创建 | 编辑要求 / 取消 | 草稿将创建为所选空间中的真实文档；来源范围与保存位置分别校验 |
| `submitting` | createDraft 请求 in-flight | 受理中 (info, Spinner) | 同上（只读） | 禁用 | — | — |
| `creating` | 服务端受理：create-draft Run `queued/running`（宿主以 202 返回的 runId 关联） | 创建中 (info, Spinner) | 步骤轨：①已受理 ●—②生成草稿 ○—③初始化并绑定文档 ○（②③由 run 阶段/事件推进，粒度不足时合并为"进行中"） | 取消任务（cancelRun） | — | 模型输出完成不等于文档已创建 |
| `created` | `conversation.updated` 携带 `targetDocumentId`（服务端持久化确认，唯一判据） | 已创建 (success) | 标题=文档真实标题；键值行：保存位置、创建时间；步骤轨 ①●②●③索引状态（见下） | 打开文档（滚动/聚焦编辑器，窄屏切文档视图） | 继续对话 | 正文保存状态以编辑器内回执为准；检索索引完成前该文档暂不参与资料检索（③有服务端事实才显示"已可检索"，否则显示"索引状态见文档页"） |
| `failed` | Run `failed` 且为本次 create-draft（宿主本地关联；刷新后无法关联时降级为通用失败条，见下） | 创建失败 (danger) | 错误摘要（服务端 message）；已生成材料（要求/草稿 artifact）保留可复制 | 重试（retryRun，先核对提示） | 复制草稿要求 | 重试前系统会核对已有结果，不会重复创建文档 |
| `unknown` | Run `interrupted` / 提交后响应丢失 | 结果未知 (warning) | 「系统正在按操作标识核对回执」 | 刷新状态（refetch snapshot） | — | 核对完成前请勿重复创建；如已创建将直接显示文档 |

刷新恢复策略（诚实性约束）：`RunSchema` 当前不含 `command` 字段，刷新后前端无法从快照判断某个进行中 Run 是否为 create-draft。设计约定：
- 本地 `pendingCreate{runId, workspaceId, instruction}` 写入现有 chat-draft IndexedDB 记录，刷新后能恢复则恢复对应卡片；
- 不能恢复时，进行中 Run 只显示状态行「任务执行中…」，**不伪造**创建中卡片；`targetDocumentId` 出现后 `created` 卡永远可从快照派生（artifact kind=draft + conversation 绑定事实），不依赖本地记录。
- 契约增强建议（二期，可选）：`RunSchema` 增加 `command?: 'chat' | 'create-draft' | …` 提示字段（服务端受理时已知），使卡片完全由快照派生。改动走 TypeBox schema → openapi:export → orval 流程。

#### 4.3.3 保存/写入回执表达（三段式）

「已创建」与「已应用」卡片内的步骤轨统一为三节点（横向 12px 文本 + 6px 节点点）：

```
① 已受理 ──── ② 已持久化 ──── ③ 索引就绪
   ●              ●               ○ 进行中 / ● 完成 / — 不适用
```

- ① = Run 受理（请求 202 / run 存在）。
- ② = 服务端持久化确认（create-draft：事务提交 + 绑定事件；提案：结构操作 durable 回执 `receipt`）。**徽标"已创建/已应用/已保存"只允许在②达成后出现。**
- ③ = 版本索引完成。数据源必须是服务端索引事实（文档 `document_indexes` 投影或快照扩展）；一期若无该事实，③渲染为中性文案「索引状态见文档页」，不猜测、不转圈假装进行中。
- 用户消息的"已发送"仅是消息级状态（气泡下 11px 灰字：发送中/已发送/发送失败·点击重试），与文档保存无关，文案不得混用"已保存"。

#### 4.3.4 图片任务卡（ImageArtifacts 重设计）

| state（现有 ImageJob） | 徽标(tone) | 内容 | 动作 |
| ---------------------- | ---------- | ---- | ---- |
| `pending` | 保存中 (info, Spinner) | 「正在保存到私有资源库…」 | 刷新 |
| `ready` | 已生成 (success) | 缩略图（点击放大）+ 尺寸 | 插入文档?（二期，走提案）/ 下载 |
| `failed` | 生成失败 (danger) | 错误码 | 重试（新 Run，不自动重试计费） |
| `unknown` | 结果未知 (warning) | 「外部生成结果尚未确认；系统不会自动重试计费」 | 手动查询（refresh） |

#### 4.3.5 工具审批卡（ApprovalCard restyle）

沿用 chat-ui `ApprovalCard` 语义（pending/allowed/rejected/cancelled/expired/unavailable 表已在组件内），视觉升级为 ActionCard 同构：icon tile=盾牌，pending 徽标 (warning)「等待你确认」，主按钮「允许这一次」/ 次按钮「拒绝」。状态文案表保持组件内现有 Record 写法（已符合表驱动）。

### 4.4 提案审阅卡（ProposalReviewCard）

替换 `proposal-review.tsx` 的 checkbox 列表，形态吸收 YouMind「1 of 3 / Reject all / Accept all」审阅条，但落在消息流卡片内（编辑器内悬浮条列为二期，见 §7）。

```
╭─ ✎ 修改提案 ·《信息架构规范》 ────────── [待确认] ─────╮
│ 摘要：将第三章改写为面向管理层的简洁版本（3 处变更）      │
│ ⓘ 含 2 条资料引用，采纳时将写入句段链接与文末参考资料     │
│ ─────────────────────────────────────────────────── │
│  ‹ 1 / 3 ›              [✓ 接受本条] [✕ 拒绝本条]      │  审阅条（当前条聚焦）
│ ┌ 当前变更 ────────────────────────────────────────┐ │
│ │ [替换] 标题 L2 · 三、信息架构原则                    │ │  kind 徽标：新增=success
│ │ 新的段落文本预览（2 行截断，点击展开全文）             │ │  替换=warning 删除=danger
│ └──────────────────────────────────────────────────┘ │
│  变更清单（折叠可展开）：                                │
│  ✓ [新增] 段落 · 背景说明            [✓][✕]           │  每行独立 accept/reject
│  ● [替换] 标题 L2 · 三、信息架构原则  [✓][✕]  ← 当前    │
│  ○ [删除] 段落 · 旧版结论             [✓][✕]           │
│ ─────────────────────────────────────────────────── │
│ 已接受 1 · 已拒绝 0 · 未决定 2      [全部拒绝] [应用提案(1)] │
╰──────────────────────────────────────────────────────╯
```

- 逐条行三态：`undecided`（空心 ○，默认）/ `accepted`（✓ success 色，行左侧 2px success 竖条）/ `rejected`（✕ danger 色 + 文本删除线 + 行降透明度）。行尾双 icon 按钮（24px，热区 32px）直接切换；初始全部 undecided（改变现状"默认全选"——接受应是显式决定；提供「全部接受」快捷钮补效率）。
- 审阅条：`‹ n / m ›` 导航当前聚焦变更（键盘 ←/→），主区域展示该条全文；「接受本条/拒绝本条」等价行内按钮。
- 底部汇总 + 双动作：
  - 「全部拒绝」= ghost danger 文本钮 → `action:'reject'`（整体拒绝）。
  - 「应用提案（n）」= primary，n=accepted 数，n=0 时禁用；提交 `action:'accept', blockIds:[...accepted]` → 与现有 `reviewAiProposal` API 完全兼容（部分接受天然得到 `partial`）。
  - 「全部接受」= 次按钮，把所有 undecided 置 accepted（不直接提交，保持一次显式应用）。
- 提交后卡片状态表（`applicationState` → 展示，全部来自服务端事件/快照）：

| applicationState | 徽标(tone) | 关键信息 | 动作 |
| ---------------- | ---------- | -------- | ---- |
| `pending`（未提交） | 待确认 (info) | 计数汇总 | 如上 |
| 提交 in-flight | 应用中 (info, Spinner) | — | 全禁用 |
| `applied` | 已应用 · 持久化确认 (success) | 步骤轨 ①●②●（回执 `receipt` 到达才显示②）+「正文已写入并通过协同持久化确认」 | 打开文档 / 定位变更（滚动到首个 accepted blockId） |
| `partial` | 部分应用 (warning) | 已应用 n 项、未应用 m 项（清单内标注） | 对剩余项重新发起（新提案）/ 打开文档 |
| `rejected` | 已拒绝 (neutral) | — | 无（终态，卡片折叠为单行） |
| `conflict` | 冲突 (danger) | 「文档已更新导致条件冲突，请基于最新正文重新生成提案」 | 重新生成（聚焦输入框 + 预填指令） |
| `unknown` | 结果未知 (warning) | 「按操作标识核对回执中，不会重复写入」 | 刷新状态 |

- 并发/过期：`reviewRevision` 不匹配时服务端拒绝 → 卡片进入 danger 提示「提案已过期，请刷新后重新审阅」+ 刷新按钮；不做本地静默合并。
- 双栏模式：卡片 [定位] 动作通过宿主回调让编辑器滚动到对应 `blockId`（复用现有 blockId 定位规则；一期可先只做"打开文档"）。

### 4.5 消息流视觉升级

- **助手消息**：
  - 头像：24×24 圆角 8 `--accent-soft` 底 + `✦` accent 色，仅连续助手消息的第一条显示；名称「知书助手」12px semibold 与头像同行。
  - 正文：无气泡，14px/1.75 `--foreground`，最大宽 `--chat-content-width`（760px / 面板宽）。
  - 流式阶段 chip 行：`PreviewFrame.stage` 映射（表驱动）：`scope`→「确认资料范围」`searching`→「检索资料」`reading`→「阅读来源」`generating`→「生成中」`validating`→「校验输出」；渲染为 11px 胶囊（info tone）+ 前置 Spinner，已完成阶段淡出，仅保留当前阶段；首 token 前显示 2 行 Skeleton。预览文本下恒定 11px 注「预览内容，以最终提交结果为准」。
  - 引用：句段右上标 `¹²` accent 色（现有 CitationText），文末「▸ 来源 n 条」折叠列表（现有 CitationList restyle：每行 favicon/类型图标 + 标题 + 空间/站点名 + 摘录展开）。
  - hover 动作行：11px ghost icon 按钮 [复制] [重新生成]（仅最后一条 completed 助手消息；「重新生成」= 明确新输入，重发上一条用户消息文案，非隐式重放）。
- **用户消息**：右对齐气泡，`--accent-soft` wash（现有 `--chat-wash`），圆角 16/16/4/16，13.5px；气泡下 11px 状态行：`发送中…`（pending）/ `已发送`（committedAt 到达，2s 后淡出）/ `发送失败 · 点击重试`（danger 色，点击重发，复用 idempotencyKey）。已发送附件以只读 mini chip 呈现在气泡内。
- **消息间距**：24px → 20px；同角色连续消息 12px 并省略头像。

### 4.6 空态

```
                     [✦ 48px tile]
              问答开始，创作收尾。
   同一个对话里查资料、做调研、写文章；创建草稿永远由你确认。

   ┌ 📚 总结要点 ─────────┐ ┌ 🔍 调研一个主题 ──────┐
   │ 把《信息架构规范》浓缩 │ │ 检索内外资料并给出     │
   │ 成 5 条执行要点        │ │ 带引用的调研结论       │
   └─────────────────────┘ └─────────────────────┘
   ┌ ✎ 起草一篇文章 ──────┐ ┌ 🗂 范围与权限 ────────┐
   │ 基于所选资料生成草稿， │ │ 当前范围：全部有权限资 │
   │ 保存到指定空间         │ │ 料（服务端实时计算）    │
   └─────────────────────┘ └─────────────────────┘
```

- 建议卡 2×2（窄容器 1×4），圆角 12px、1px border、hover 抬升 + accent 图标；点击 = 预填输入框并聚焦（不直接发送，给用户改的机会；现有 `suggested` 字符串数组升级为 `{icon,title,hint,prompt}`，宿主传入，缺省仍兼容字符串）。
- 空态内**不再放 ScopePicker**（范围已收敛到工具条）。
- public 模式空态沿用 welcome + 建议问题（同一卡片形态，去掉创作/范围卡）。

### 4.7 顶部 header

- 高 48px，下边框 1px `--border`，内边距 0 16px。
- 左：`✦` 20px tile + 「AI 创作」14px semibold + `·` + 会话标题 12px muted（`conversation.title`，截断 20ch；无会话时「新对话」）。
- 右（icon 按钮组，28px）：
  - 绑定 chip（有 targetDocumentId 时）：`📄 已绑定：{文档标题} ↗`，11px，点击 = 定位/切换文档视图；target-unavailable 时 chip 变 danger-soft「目标文档不可用」+ Tooltip 说明（保留对话，不自动新建）。
  - [🕘 历史对话]：Popover 列出 `listConversations` 最近会话（标题 + 相对时间 + 状态点），点击切换 conversationId（保留当前草稿输入）。
  - [＋ 新对话]：清空本地会话绑定（新建走懒创建，沿用现有 ensureConversation）。
- 移除：意图 tab（→工具条）、范围 chip（→工具条）。

---

## 5. 交互细节通则

- **键盘**：所有 Popover/Dropdown 遵循 React Aria 模式（Trigger 上 Enter/Space/↓ 打开，Esc 关闭，关闭后焦点回触发器）；工具条 Tab 序 = DOM 序（+ → 范围 → 保存到 → 意图 → 联网 → 创建草稿 → 发送）；提案卡内 ←/→ 切换当前变更、A/J 快捷键接受、R/K 拒绝（卡片聚焦时，Tooltip 标注）；附件 chip 条可 Tab 进入，Delete 移除聚焦项。
- **IME**：textarea 组合期间 Enter/方向键不拦截（chat-ui 已实现 `compositionstart/end` + `keyCode 229` 双保险，保持）；工具条控件不在输入路径上，无组合冲突；卡片内「编辑要求」textarea 同样套用组合保护。
- **浮层定位**：一律 `placement="top start"/"top end"`（输入条在底部，弹层向上）；React Aria 自带视口翻转与碰撞处理；窄容器下 Popover `max-width: calc(100vw - 24px)`；弹层 z-index 沿用 `--overlay-shadow` 层级体系，不遮挡全局 Cmd+K。
- **焦点/选区恢复**：从卡片按钮返回输入框时恢复 draft 文本与光标（草稿本就在 state，不丢失）；双栏切换（文档/对话）不重建 Chat 与协同 Provider（现有约束，布局改动不得破坏）。
- **动效**：状态切换 150–200ms ease；卡片入场 opacity + translateY(4px)；Spinner 用 CSS 动画；全部尊重 `prefers-reduced-motion: reduce`（直接终态）。
- **滚动责任**：消息区独立滚动（现有 `zhishu-chat-messages`），新卡片插入沿用 `following` 自动跟随逻辑；用户上翻时出现「回到最新消息」（现有）；待确认草稿卡插入时若用户不在底部，则不强制滚动，改为状态行提示「有一张待确认的草稿卡片」。
- **亮暗主题**：全部颜色走 token，暗色零特判；徽标 soft 色在暗色下对比度已由 `--*-soft-foreground` 保证；原型页提供主题切换验证。
- **错误呈现分层**：字段级（chip 失败原因 Tooltip）→ 卡片级（卡片 danger 态 + 动作）→ 会话级（ChatStatus 状态行，role=alert）。同一错误只出现在最贴近动作的一层。

---

## 6. 与现有代码的映射

### 6.1 `packages/chat-ui`（通用展示能力下沉，保持无业务/无 HeroUI 依赖）

| 文件 | 改动 |
| ---- | ---- |
| `types.ts` | `AttachmentView` 扩展：`{ id, label, kind: 'image'\|'file', status: 'uploading'\|'ready'\|'failed', progress?: number(0-100), meta?: string(尺寸/大小), errorText?: string, thumbnailSrc?: string }`；新增 `ActionCardProps`、`CardTone = 'neutral'\|'info'\|'success'\|'warning'\|'danger'`、`StageKey` |
| `approval.tsx` | `ArtifactCard` 升级/新增 `ActionCard`：props `{ icon?: ReactNode, title, subtitle?, tone, badge?: {tone,text,spinner?}, time?, footer?: ReactNode, footnote?, children }`；内部 tone→class 用查表（对象 Record，不用三元链）。`ApprovalCard` 改用 ActionCard 外壳，状态文案 Record 保留 |
| `composer.tsx` | `AttachmentList` 升级为 chip 形态（缩略图/进度/失败重试钮，新增 `onRetryAttachment?(id)`）；发送钮禁用态/submitting Spinner class；其余插槽（toolbarStart/End、headerContent）不变 |
| `message-list.tsx` | 助手头像仅首条渲染（连续消息合并逻辑：比较相邻 message.role）；用户消息 `status` 行样式 class；`messageActions` 已有，宿主注入 hover 动作 |
| 新增 `stage.ts` 或并入 `index.tsx` | `StageIndicator`：`{ stage: StageKey }` → 文案/图标查表渲染（scope/searching/reading/generating/validating） |
| `styles.css` | 新增 `.zhishu-action-card`、`.zhishu-chip-*`、`.zhishu-stage`、proposal 行三态、暗色段沿用 `prefers-color-scheme` + 宿主变量；删除被替代的裸样式 |

边界说明：ActionCard/chip/StageIndicator 是纯展示（受控 props，无网络无业务状态），符合「chat-ui 提供受控展示和输入，宿主负责业务动作」；公开问答页复用同一批组件（mode=public 下宿主不传创作类卡片）。

### 6.2 `apps/app-web/src/features/assistant/`（宿主业务组合）

| 文件 | 改动 |
| ---- | ---- |
| `assistant-chat.tsx` | header 重构（标题/绑定 chip/历史/新对话）；toolbarStart/End 组合新控件；删除 `DraftPanel`/`DraftForm`，替换为 `CreateDraftButton` + `DraftActionCard` 流内卡片（`afterMessages` 改为把卡片按事实插入 `buildMessages` 序列——artifact/run/target 派生 + 本地 pendingCreate）；ChatStatus 文案表驱动化（现有嵌套三元 → `Record<状态,string>`）；空态升级；`intent` 状态与 placeholder 表 |
| `scope-picker.tsx` | 重写为 `ScopeMenu`：`components/ui/menu.tsx`（Dropdown）+ 单选/多选 section + 空间 kind 徽标 + footer 权限说明；触发器为 icon+值文本 ghost 按钮；label 计算的嵌套三元 → `Record<ScopeSelection['kind'], …>` 查表 |
| 新增 `save-to-picker.tsx` | 保存位置选择器（4.1.4），数据源 `listKnowledgeWorkspaces`，显示可见规则 |
| 新增 `composer-toolbar.tsx` | 组装 +菜单/意图段/联网 toggle/创建草稿按钮（HeroUI：`Button`、`ToggleButton`、`Menu` 封装、`Tooltip`）；容器查询 class 收敛 |
| 新增 `draft-action-card.tsx` | §4.3.2 状态机：`local-draft` 本地态（含指令编辑）+ 快照派生态；状态配置 `satisfies Record<DraftCardState, CardConfig>`；提交走现有 `createDraft`（幂等键/expectedContextRevision 沿用） |
| `proposal-review.tsx` | 重写为 ProposalReviewCard：行三态 Map<blockId,'accepted'\|'rejected'\|'undecided'>、`‹n/m›` 导航、全部接受/全部拒绝/应用选中(n)；提交映射 `reviewAiProposal({action:'accept', blockIds:accepted})` / `{action:'reject'}`；`applicationState` → 展示查表；`reviewRevision` 过期处理 |
| `image-artifacts.tsx` | 换 ActionCard 外壳，状态表驱动（pending/ready/failed/unknown 已有事实，直接映射） |
| 新增 `attachments.ts`（宿主状态机） | `useAttachmentUploads()`：File → uploading/ready/failed、重试、取消、随消息发送后清理；上传通道见 §6.5 |
| `creation-page.tsx` | 基本不变（布局派生逻辑保留）；新增窄容器 class 钩子与「打开文档」回调（滚动定位/移动视图切换） |

### 6.3 `apps/app-web/src/components/chat/chat.css`

- 删除/替换：`.scope-picker`、`.scope-panel`、`.assistant-draft*`、`.proposal-*`、`.writing-web`、`.assistant-intent`、`.assistant-header` 旧形态。
- 新增：`.assistant-toolbar-*`（含 container query 断点）、`.draft-card-*`、`.proposal-row[data-decision]`、空态建议卡网格。
- 保留：citation、workbench 布局（`.assistant-split` 等）。

### 6.4 复用的应用封装（不新增依赖）

`components/ui/button.tsx`（HeroUIButton 包装）、`components/ui/menu.tsx`（Dropdown 包装）、HeroUI `ToggleButton`/`Popover`/`Tooltip`/`Spinner`/`ProgressCircle`/`Chip`（可直接 import `@heroui/react`，已是依赖）、图标沿用仓库现有 icon 方案（如 `@gravity-ui/icons` 或内联 SVG，以现有 import 为准，不新增图标库）。

### 6.5 服务端 / 契约依赖（设计边界外，需排期确认）

| 依赖 | 影响 | 建议 |
| ---- | ---- | ---- |
| 附件上传通道（图片/文件 → 资产引用随消息提交） | §4.1.1/§4.2 完整能力 | 需要：assets 上传端点（或复用现有资产模块）+ `MessagePartSchema` 增加 attachment part（ai-contracts TypeBox → openapi:export → orval）+ research/writing 插件读取附件文本。**第 3 阶段实施**；此前 + 按钮与 chip 条可先以"接口未开放"禁用态上线骨架 |
| `RunSchema.command` 提示字段 | 刷新后创建中卡片可完全由快照派生 | 可选增强，第 2 阶段评估；未加之前用本地 pendingCreate + 降级策略（§4.3.2） |
| 索引状态投影（③ 索引就绪） | 三段式第③步的真实事实 | 一期文案降级为「索引状态见文档页」；后续由文档索引事实接入 |
| capabilities 暴露附件限制/可见规则文案 | + 菜单与保存到描述行 | `GET /api/ai/capabilities`、workspace DTO 增补展示字段 |

---

## 7. 分阶段实施建议

| 阶段 | 范围 | 特征 |
| ---- | ---- | ---- |
| **P1 视觉与布局重排**（纯前端，无契约改动） | chat-ui：ActionCard/chip/StageIndicator 原语 + styles；宿主：header 重构、工具条（+禁用骨架、意图段、ScopeMenu、联网 toggle、创建草稿按钮）、DraftActionCard（local-draft/creating/created/failed/unknown 全状态，走现有 API）、ProposalReviewCard 逐条审阅、空态、消息视觉、chat.css 清理 | 所有数据流用现有 `createDraft/reviewAiProposal/retryRun/cancelRun/updateContext`，可独立验收 |
| **P2 保存到与回执完善** | SaveToPicker（可见规则文案）、创建回执三段式步骤轨（含 receipt 展示）、历史对话 Popover、绑定 chip 定位、「结果未知」核对体验、（可选）RunSchema.command 契约增强 + 生成物更新 | 小幅契约/展示字段增补，走 openapi→orval 流程 |
| **P3 附件能力** | 服务端上传通道 + 消息契约 attachment part + 宿主上传状态机 + 插件读取附件；编辑器内提案悬浮审阅条（YouMind 式 1 of 3 浮条，与卡片共享 decision 状态） | 跨端改动，独立排期 |

每阶段验证：`pnpm --filter @zhishu/app-web exec tsc -p tsconfig.app.json --noEmit`、`pnpm test:ai`（chat-contracts/app-web test:chat）、涉及包边界时 `pnpm check:ai-packages`；交互走查清单见 §8。P3 契约改动后依次 `pnpm --dir apps/app-server openapi:export` → `pnpm --filter @zhishu/app-web api:generate`。

---

## 8. 验收清单（交互走查）

- [ ] 顶部无范围 chip / 意图 tab；范围、保存到、联网、意图、创建草稿全部在输入工具条，且各只有一个入口
- [ ] 范围选择：全部/当前文档/指定空间（≤8，kind 徽标，footer 权限说明）；变更失败回滚 + 状态行错误
- [ ] 保存到：可见规则描述、默认个人空间显式可见、无个人空间时"选择保存位置…"警示且创建草稿禁用
- [ ] 联网 toggle 四态（含 capabilities 不可用禁用 + Tooltip，不泄露内部配置键名）
- [ ] 创建草稿全状态：待确认（卡内编辑要求/更改保存位置）→ 受理中 → 创建中（可取消）→ 已创建（打开文档，双栏展开，会话不重建）/ 失败（重试先核对）/ 未知（只刷新不重建）；刷新页面后 created 卡仍可从快照派生
- [ ] 提案卡：逐条三态、‹n/m› 导航、全部接受/全部拒绝/应用选中、partial/conflict/unknown/applied 展示与持久化确认文案（②达成前不出现"已应用"）
- [ ] 消息：流式阶段 chip、预览注脚、引用折叠、hover 复制/重新生成、用户气泡发送状态（发送中/已发送/失败重试）
- [ ] 键盘全链路：Tab 序、Popover Esc/焦点回归、提案卡 ←/→/A/R、IME 组合期 Enter 不发送
- [ ] 窄容器（360–420px 双栏）：icon-only 收起、两行换行、触控 44px；双栏切换不丢输入/提案/协同状态
- [ ] 亮暗主题 token 化零特判；`prefers-reduced-motion` 生效
- [ ] public 模式：无意图/保存到/创建草稿/联网/附件，范围呈只读 chip，建议卡隐藏创作项
- [ ] 文案审查：任何"已保存/已创建/已应用"仅出现在服务端持久化确认后；权限相关文案均注明服务端校验

---

## 9. 明确不做（范围控制）

- 不新增会话左侧栏/多会话管理页（历史仅 Popover 轻量入口）。
- 不做模型选择器（服务端单一调度，无用户可选模型事实）。
- 不做麦克风语音输入（无对应服务端能力）。
- 不在浏览器端做任何权限判定；所有列表仅为"可申请项"，生效以服务端为准。
- 不引入新 UI 依赖；不改协同/持久化链路；不新增业务表。
