# dsh-multi-agent v0.8.25 — 工具用法与运行逻辑

本文按代码现状（v0.8.25）整理：插件提供哪些工具、每个操作的权限与副作用、状态如何流转、失败如何结算。

## 1. 身份、权限与作用域

- **身份**：每次工具调用取 `exec.agent.id` 作为当前会话 ID；UI 端以 `__user__` 作为人类用户身份。
- **分组解析**：显式传 `groupId`；省略时按"当前会话只属于一个组"自动取，否则报 `NEED_GROUP_ID`。
- **角色**：`leader` / `member`，成员记录在 `memberships`（含 `role`、`archivedAt`、`archivedBy`）。
- **权限函数**：`requireLeaderOf`（组长专属操作）、`requireGroupMember`（必须在本组）、`requireAssigneeOrLeader`（任务状态）。
- **工具可见性**：
  - `always`：`multi_agent_groups`、`multi_agent_group`
  - `whenMember`：`multi_agent_task`、`multi_agent_activity`、`multi_agent_message`
  - `whenLeader`：`multi_agent_create_member`、`multi_agent_usage`
- **状态文件**：`<profile>/.dsh-multi-agent/state.json`，顶层 `{version, updatedAt, groups, memberships, tasks, taskEdges, messages, activities}`。
- **规模上限**：组 40、成员记录 4000、消息 2000、任务 200、任务边 800、活动记录 500、单组会话上限默认 8（用户可在管理页 2–32 调整）、消息正文 4000 字、任务标题 80 / 描述 600 / 模块简报 600。

## 2. 成员生命周期（parked / revive）

归档不是 DSH 会话归档，而是成员状态 `archivedAt`（`archivedBy = auto | manual`）。会话本身继续存在，可以被唤醒。

| 触发 | 结果 |
|---|---|
| 新建组（`-n`） | 创建者成为 leader，不自动归档 |
| 加入组（`-j`）/ 被加入（`-a`） | 成为 member；若没有任何未完成任务 → 立即自动归档（`auto`） |
| 分配任务（`task -c/-u` 带 `assigneeSessionId`） | **先修复状态**：已归档且有未完成任务 → 清 `archivedAt`、写 state、尝试 `unarchiveSession`（leader 同样适用）；然后写分配消息并插话唤醒 |
| 任务完成（`-s status=done`）/ 删除任务 / 取消指派 | 重算：该成员未完成任务数为 0 → 自动归档（`auto`） |
| 私聊唤醒（`message -s mode=private` 且收件人已归档） | 必须带 `taskId`（该成员一个 `done` 任务）；任务回到 `doing`、清空 `completionNote`、成员回归，消息照常投递 |
| 组长手动归档 | 仅 UI「管理」页可操作（`archiveMember`）；组长永不被自动归档 |
| 已归档组长被分配任务 | 显式分配视为召回：先恢复活跃，再投递 |
| 撤回手动归档 | UI 上已归档组长行有「取消归档」（同一 `archiveMember` 接口的切换语义） |

归档成员的约束：**收不到广播**；不计入成员上限与"活跃成员"计数；`groups -m` / 管理页显示 `parked (auto|manual)`；私聊必须带可重开的 `taskId`。

## 3. 任务板

- 状态机：`todo → doing → done`（只允许这三个值，非法值 `INVALID_STATUS`）。
- 标记 `done` **必须**有非空 `completionNote`（模块简报：模块做什么、关键文件/入口、他人如何调用/扩展、已知限制）；缺失报 `NOTE_REQUIRED`，错误信息带实际字数。
- `done` 且带简报的任务是永久记录：删除报 `TASK_LOCKED`。
- 指派：`assigneeSessionId` 必须是本组成员（`ASSIGNEE_NOT_MEMBER`）；每个任务模块只能绑定一个会话（`TASK_ALREADY_ASSIGNED`）。
- 依赖边：`-x from to` 建边，禁止自环（`TASK_SELF_LOOP`）、重复（`TASK_EDGE_EXISTS`）、成环（`TASK_CYCLE`）。
- 权限：`-l`/`-s` 成员可用（`-s` 仅限 assignee 或 leader）；`-c/-u/-d/-x/-r` 组长专属。

## 4. 消息模型

消息 `mode` 有四种：`broadcast`、`private`、`task`（分配）、`reply`（回复副本）。

### 4.1 发送（`-s`）

1. 校验内容（≤4000）与模式；`private` 需要 `recipientSessionId`（不能发给自己，`SELF_PRIVATE`）。
2. **回复门槛**：发送者若还有未回复的消息，报 `PENDING_REPLY`（"N messages are still waiting for a reply; reply first"）——先清空队列再发言。
3. 收件人 = 组内**活跃**成员（广播排除自己）；私聊指向归档成员时走"带 `taskId` 重开"路径：
   - 无 `taskId` → `TASK_CONTEXT_REQUIRED`
   - 任务不在组内 → `TASK_NOT_FOUND`
   - 不是他的任务或不是 `done` → `TASK_NOT_REOPENABLE`
   - 通过 → 任务 `status=doing`、`completionNote=''`、`reopenedAt` 记录，成员回归，消息记 `reopenedTaskId`
4. 落库后立即投递（见 4.3），并把每个收件人的投递结果写回 `deliveries`。

### 4.2 读取（`-l`）

- 组长看到整组；成员只看到"与自己有关"的：发给自己的、自己发的、以及回复副本（`recipientSessionId` 命中）。
- 未回复的消息标记 `pending a reply`；回复副本显示 `reply to [msg_x]`；分配消息显示 `(task assignment task_x)`。

### 4.3 投递与结算

每条 delivery 的状态只有三种：`pending`（刚创建）、`sent`、`failed`（带 `error`）。

- 普通消息：优先 `agent.steer`（source.kind `agent-message`，列表中渲染为折叠的「上下文注入」行）→ 目标不在主 agents 注册表时改用 `ctx.subagents.sendMessage(senderAgent, targetId, …)`（subagent 成员只能走这条通道，`controller.prompt` 会报 "owned by subagent routing"）→ 再失败 `controller.prompt(mode='steer')` → 最后 `notifyAgent`；成功 `markDelivered(sent)`，失败 `markDelivered(failed, error)`。
- **任务分配消息**（v0.8.25）：
  1. 先判 assignee：不在组 / 仍归档且无未完成任务 → 直接判投递非法并写 `failed`（附原因），不推送；
  2. 以 `agent.steer` 的 agent-message 注入为主通道（idle 会话也会起一轮，且不会显示成用户自己发的消息），`controller.prompt` 兜底，最多尝试 2 次；第二次前先补一次 `unarchiveSession`；
  3. 仍失败则退回非阻塞通知，再失败写 `failed`；
  4. 结果回传给工具：成功 → `Assignment message msg_… was delivered.`（召回时加 `and the parked member is active again.`）；失败 → `WARNING: … delivery failed (…); the member was not woken. Reassign the card or send a message to retry.`
- 兜底：`mode=task` 的 delivery 若超过 10 分钟仍是 `pending`，下次读取时归一为 `failed`（"delivery was never confirmed; reassign the card to retry"），不会永远显示"投递中"。

### 4.4 回复（`-r`）

- 需要 `content`；`messageId` 在只有一个待回复消息时可省略。
- 回复写入 `delivery.reply`，并**额外存一条独立消息**（`mode=reply`、`replyTo`、`recipientSessionId`=原发送者），审计链完整。
- 回复本身不改变任务状态：它是"已读回执"，任务状态由成员用 `-s` 自己改。
- 三种"没得回"的情况返回提示文本而非报错：无待回复 / 不是收件人 / 已回复过。

## 5. 执行列表（activity）

- 记录由 fs 守卫自动产生：任何人用标准 `read/write/edit` 工具碰文件都会登记一条 `read-only` / `read-write` 记录，**不需要手工登记**。
- **每个成员 × 每个文件只有一条记录**，生命周期内持续追加：每次 `write/edit` 追加一轮 round，保留最近 50 轮。
- 每轮 round 含：`at`、`beforeHash`、`afterHash`（sha256 前 12 位）、`added`/`removed` 行、`addedCount`/`removedCount`、`truncated`。
- 记录级字段：`diff`（最新轮）、`diffAt`、`diffCount`、`beforeHash`（首轮前）、`afterHash`（末轮后）。
- 写锁：同一文件同一时间只允许一个成员写，冲突报 `FILE_IN_USE`（附冲突方列表）。
- `-l` 查询语法：空 = 使用中的记录；`-a` 全部；`-s <文件名>`；`-m <成员 sessionId>`；末尾数字 = 最近 N 条（1–200），可组合。
- `-d <id>` 输出：`Writes: N`、`File hash: a → b (sha256, first 12 hex; compare a copy before restoring)`、逐轮 `— write k · 时间 · +a/-r · hash a→b` 与增删行。
- 恢复文件前先比对哈希：`a` 是这条记录最早写入前的内容，`b` 是最新写入后；不一致说明其中一方被外部改动。

## 6. Token 用量

- `multi_agent_usage -l`：按成员输出 provider 上报的 `uncachedInput / cacheRead / output / total` 与占比，另给组总量；`refresh=true` 跳过 15 秒缓存。
- 数据来源与 UI「用量」页一致：活跃会话读内存投影快照，冷会话回放会话日志，因此包含插件安装前的历史。
- 组长专属。

## 7. 七个工具速查

| 工具 | op | 关键参数 | 权限 | 主要副作用 |
|---|---|---|---|---|
| `multi_agent_groups` | `-l`（默认）/ `-m` / `-c` | `groupId` | 所有成员 | 只读；`-m` 显示 active/parked 与 `recipientSessionId` |
| `multi_agent_group` | `-n/-j/-x/-u/-d/-a/-r/-s/-t` | `name`、`groupId`、`sessionId`、`role`、`takeover` | 所有成员；`-u/-d/-a/-r/-s` 组长 | 建组/入组/退组/改名/删组/增删成员/改角色/扫描候选；入组即可能归档 |
| `multi_agent_create_member` | 无 | `name`(2–24)、`taskId`(必填，未分配模块)、`groupId` | 组长 | 创建子代理会话并绑定任务模块，同一调用内发出分配消息（mode=task）并用 steer 插话唤醒新成员，入组后按有无未完成任务决定是否归档 |
| `multi_agent_task` | `-l/-c/-u/-d/-s/-x/-r` | `taskId`、`title`、`description`、`status`、`completionNote`、`assigneeSessionId`、`from/to`、`edgeId` | 成员可 `-l/-s`；组长可全部（组长可把卡片指派给自己） | 建/改/删任务、改状态、建删依赖边；分配会召回归档成员并写分配消息+插话唤醒 |
| `multi_agent_activity` | `-l/-d` | `id`、`query` | 成员 | 只读；`-d` 展示追加式写入历史与哈希链 |
| `multi_agent_usage` | `-l` | `groupId`、`refresh` | 组长 | 只读；按成员与组汇总 token |
| `multi_agent_message` | `-l/-s/-r` | `content`、`mode`、`recipientSessionId`、`messageId`、`taskId` | 成员 | 发广播/私聊、回复入库、归档成员带 taskId 重开任务并唤醒；投递结果写回 deliveries |

## 8. 一次完整链路（运行时序）

1. 组长 `group -n` 建组 → leader。
2. 组长 `task -c` 切分任务模块（可先不指派）→ `task -x` 连依赖。
3. 组长 `create_member`（绑定未分配模块）→ 新会话加入并自动收到分配消息与插话唤醒，组员按规则就位，无需再补 DM。
4. 组长 `task -u assigneeSessionId` 分配：
   - 修状态（归档→活跃，必要时 unarchive）→ 写 `mode=task` 分配消息（deliveries 初始 pending）→ `steer` 插话唤醒 → 结算 `sent`/`failed`。
5. 组员 `message -l` 看到分配 → `task -s status=doing` → `message -r` 回复（独立存档）。
6. 组员 `read/write/edit` 干活：执行列表自动建记录、加锁、每写追加一轮并记前后哈希。
7. 组员 `task -s status=done completionNote=…` → 触发归档重算：未完成任务归零则自动归档。
8. 组长 `activity -l` / `-d` 审计；`usage -l` 看用量；`groups -m` 看谁活跃/归档。

## 9. 错误码分组

- **权限**：`NOT_IN_GROUP`(403/400)、`NOT_LEADER`(403)、`NOT_RECIPIENT`(403)、`NOT_ASSIGNEE`(403)、`CROSS_ORIGIN`(403)、`NOT_ACTIVITY_OWNER`(403)。
- **任务**：`TASK_REQUIRED`、`INVALID_TASK`、`INVALID_STATUS`、`NOTE_REQUIRED`、`INVALID_QUERY`、`TASK_NOT_FOUND`、`TASK_GROUP_MISMATCH`、`TASK_ALREADY_ASSIGNED`、`TASK_LOCKED`、`TASK_LIMIT`、`TASK_EDGE_LIMIT`、`TASK_EDGE_EXISTS`、`TASK_EDGE_NOT_FOUND`、`TASK_CYCLE`、`TASK_SELF_LOOP`、`INVALID_TASK_EDGE`。
- **消息**：`PENDING_REPLY`、`NO_RECIPIENTS`、`SELF_PRIVATE`、`NEED_RECIPIENT`、`INVALID_MODE`、`INVALID_MESSAGE`、`MESSAGE_NOT_FOUND`、`REPLY_NOT_FOUND`、`ALREADY_REPLIED`、`TASK_CONTEXT_REQUIRED`(400)、`TASK_NOT_FOUND`(404)、`TASK_NOT_REOPENABLE`(409)。
- **成员/分组**：`GROUP_NOT_FOUND`、`GROUP_FULL`、`GROUP_LIMIT`、`NAME_TAKEN`、`LEADER_EXISTS`、`LEADER_REQUIRED`、`INVALID_ROLE`、`INVALID_SESSION`、`MEMBERSHIP_LIMIT`、`SESSION_NOT_FOUND`、`SESSION_SERVICE`(503)、`ASSIGNEE_NOT_MEMBER`、`NO_TASK_MODULE`。
- **执行列表**：`ACTIVITY_NOT_FOUND`、`ACTIVITY_LIMIT`、`INVALID_ACTIVITY`、`INVALID_ACTIVITY_OP`、`INVALID_ACTIVITY_STATE`、`FILE_IN_USE`、`INVALID_PATH`、`DELIVERY_NOT_FOUND`。
- **请求**：`INVALID_ACTION`、`INVALID_INPUT`、`INVALID_JSON`、`INVALID_CONTENT_TYPE`(415)、`BODY_TOO_LARGE`(413)、`BAD_REQUEST_HEADER`、`NOT_FOUND`。

## 10. 服务端接口与 UI

- HTTP 前缀 `/multi-agent/api`，写请求带 `x-dsh-multi-agent: 1` 头，动作统一走 `POST /action`。
- `GET /state`（整组快照）、`GET /tools`、`GET /models`、`GET /usage`、`GET /messages`。
- UI 页签：分组（组/任务/消息/用量/执行/管理）、任务画布、消息队列（`· parked` 收件人、`Reopen task` 下拉、回复独立成行）、执行列表（展开逐轮历史与哈希）、管理页（活跃成员、归档成员 `auto/manual`、组长「归档 / 取消归档」）。

## 11. 设计取舍（为什么这样）

- 归档用插件状态而非 DSH 会话归档：分配任务即可原地唤醒，不需要 unarchive 往返，也不会因宿主归档导致 prompt 被拒。
- 分配必须"先修状态再投递"：否则会出现"成员已归档 → 投递被拒 → 显示投递中"的假死。
- `agent.steer`（agent-message 注入）优先于非阻塞通知：通知只保证"消息送达"，steer 才保证"这一轮真的开始"；用 agent-message 来源还让群消息在对话里显示为折叠的上下文注入行。
- 执行列表按成员+文件记录、追加轮次：恢复文件需要"这一轮之前是什么样"，覆盖式 diff 拿不到中间态，哈希链让外部修改可被发现。
- 回复独立入库：`reply` 嵌套字段无法被 `-l` 检索，审计链会断在消息层。
