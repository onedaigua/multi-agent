# dsh-multi-agent 使用指南

> 本技能面向 AI 助手。只要准备调用任何 `multi_agent_*` 工具、管理 Agent 分组或任务板，就先按本指南确认自己的角色与权限，再操作。

## 1. 先确认自己是谁

调用 `multi_agent_groups`（无需参数）：

- 返回你的会话 ID、所有分组及其成员、组长，以及你在每个分组中的角色。
- 传 `{ "includeSessions": true }` 可列出当前工作区中还能加入分组的会话。
- 你同时属于多个分组时，除 `multi_agent_groups` / `multi_agent_create_group` 外，其余工具都要带 `groupId`；只有一个分组时可以省略。

## 2. 核心概念

- **分组（group）**：独立的协作单元，必须始终有且仅有一位组长。
- **成员（member）**：就是一个 DSH 会话（session）。同一个会话可以加入多个分组，在每个分组里的角色互相独立。
- **会话上限**：每组默认最多 8 个会话（含组长），用户可在管理页改成 2–32。满员时加入或创建都会返回 `GROUP_FULL`。
- **任务板**：每个分组一个独立任务空间。任务即卡片，有 `task_...` ID；连线是有向边，有 `edge_...` ID。任务与连线构成 a→b→c 的 DAG，允许并行分叉，不允许成环。
- **任务模块**：任务板上的卡片就是"工作包/模块"。创建成员会话前必须先建好任务模块，并把其中一个**未分配**模块绑定给新会话。
- **继承配置**：组长可在管理页设置「新会话继承」，默认 `inherit`（模型与推理等级跟随组长），也可 `custom` 指定模型与推理等级。
- **完全权限**：组长为 `danger-full-access` 时，新建的成员会话会自动设为完全权限。
- **上下文**：新建会话没有任何历史对话，只带系统提示与工具。派活时要把目标、约束、验收标准写完整，不能假设它知道之前聊过什么。

## 3. 工具速查表

| 工具 | 谁可用 | 关键参数 | 作用 |
| --- | --- | --- | --- |
| `multi_agent_groups` | 所有人 | `includeSessions?` | 定位自己的会话 ID、所在分组、角色；列可加入的会话 |
| `multi_agent_members` | 组内成员 | `groupId?` | 成员列表、完整 sessionId、组长/成员身份；私聊前取目标 ID |
| `multi_agent_create_group` | 所有人 | `name`、`description?`、`color?` | 建组，创建者自动成为组长 |
| `multi_agent_join_group` | 所有人 | `groupId`、`role?`、`takeover?` | 加入分组；组长席位被占时需 `takeover: true` |
| `multi_agent_leave_group` | 组内成员 | `groupId?` | 退出分组；空组会自动清理，组长退出会顺位交接 |
| `multi_agent_manage_group` | 组长 | `groupId?`、`action`、`name?`、`description?`、`color?`、`sessionId?`、`role?`、`takeover?` | 改组信息、删组、加/移成员、调角色、扫描可加入会话 |
| `multi_agent_create_member` | 组长 | `name`、`taskId`、`groupId?` | 在组长工作区新建成员会话，绑定任务模块并自动入组 |
| `multi_agent_tasks` | 组内成员 | `groupId?` | 查看任务列表、状态、负责人、连线 ID、未分配模块 |
| `multi_agent_create_task` | 组长 | `groupId?`、`title`、`description?`、`status?`、`assigneeSessionId?` | 创建任务卡片 |
| `multi_agent_update_task` | 组长 | `taskId`、`title?`、`description?`、`status?`、`assigneeSessionId?` | 修改任务、派活/取消派活 |
| `multi_agent_delete_task` | 组长 | `taskId` | 删除任务，相关连线级联删除 |
| `multi_agent_set_task_status` | 负责人或组长 | `taskId`、`status` | 改任务完成状态：`todo` / `doing` / `done` |
| `multi_agent_connect_tasks` | 组长 | `from`、`to` | 连线 from→to；同组、不可自环、不可重复、不可成环 |
| `multi_agent_disconnect_tasks` | 组长 | `edgeId` | 删除一条连线 |
| `multi_agent_messages` | 组内成员 | `groupId?` | 查看消息队列与待回复消息 |
| `multi_agent_send_message` | 组内成员 | `content`、`groupId?`、`mode?`、`recipientSessionId?` | 广播（默认）或私聊，以插话方式送达 |
| `multi_agent_reply_message` | 有待回复消息者 | `content`、`messageId?`、`groupId?` | 回复消息；每条消息只能回复一次 |

## 4. 场景 A：组长组建团队并交付

### 4.1 建组

```
multi_agent_create_group
{ "name": "排序项目", "description": "实现并验证排序模块" }
```

创建者自动成为组长，并得到分组 ID（`grp_...`）。

### 4.2 先拆任务树（分组块）

用 `multi_agent_create_task` 逐块建卡，例如：

```
{ "groupId": "grp_xxx", "title": "接口设计", "description": "定义输入输出与错误码", "status": "todo" }
```

再用 `multi_agent_connect_tasks` 连成流程：

```
{ "from": "task_aaa", "to": "task_bbb" }
```

可以串成 a→b→c，也可以并行分叉（一个任务连向多个后续任务）。规则：两张卡必须同组、不能自环、不能重复、不能成环。

### 4.3 建成员会话（必须先有未分配任务模块）

1. 用 `multi_agent_tasks` 查看任务与"未分配模块"数量。
2. 每个新会话绑定一个未分配模块：

```
multi_agent_create_member
{ "name": "排序成员", "taskId": "task_bbb", "groupId": "grp_xxx" }
```

约束：

- 每个分组最多 `maxSessions` 个会话（含组长，默认 8）。
- 一个任务模块只能绑定一个会话，不能重复绑定。
- 名字 2–24 字，由你决定，简洁明确。
- 新会话没有历史上下文；模型/推理等级默认继承组长，或按管理页配置。
- 组长本人不领取任务；可分配模块数约为「会话上限 - 1」。
- 如果任务模块确实多到超过上限：让组员用 `multi_agent_create_group` 另建新组并担任新组组长，再在新组里分块下发。

### 4.4 下发任务

```
multi_agent_send_message
{ "groupId": "grp_xxx", "content": "任务 task_bbb：实现排序模块。输入... 输出... 验收标准... 完成后把结果 reply 给我。" }
```

- 默认广播给组内除自己外的所有人；私聊用 `{"mode":"private","recipientSessionId":"session-..."}`。
- 私聊目标 ID 从 `multi_agent_members` 获取；不能发给自己，不能跨组。
- 如果你自己有未回复消息，发送会被拒绝（`PENDING_REPLY`），先 `multi_agent_reply_message`。

### 4.5 跟踪与验收

- `multi_agent_tasks` 查看状态、负责人与连线。
- 组长用 `multi_agent_update_task` 改说明、状态、负责人（传空字符串取消归属）。
- 负责人或组长用 `multi_agent_set_task_status` 标记 `doing` / `done`。
- 成员完成后通过 `multi_agent_reply_message` 或 `multi_agent_send_message` 汇报；组长需要把成果交付给用户时，直接在对话里整理文件与说明。

### 4.6 收尾

- 删除任务：`multi_agent_delete_task`（连线级联删除）。
- 删除连线：`multi_agent_disconnect_tasks`。
- 删除分组：`multi_agent_manage_group` 传 `{"action":"delete"}`（成员与消息一并清理）。

## 5. 场景 B：成员接到任务

1. `multi_agent_groups` 确认自己在哪个组、什么角色；`multi_agent_tasks` 找到自己负责的 `taskId`。
2. 用 `multi_agent_set_task_status` 把任务改为 `doing`。
3. 完成任务；过程中的问题/进展用 `multi_agent_send_message` 汇报。
4. 完成后 `set_task_status` 改为 `done`，再用 `multi_agent_reply_message` 给组长发完成说明（改动了哪些文件、如何验证）。
5. 有未回复消息时先回复，不能直接发新消息。

## 6. 场景 C：消息与待回复

- 每次收到消息都会产生一条待回复记录；`multi_agent_messages` 可查看。
- 每条消息只能回复一次；`multi_agent_reply_message` 只填 `content` 时自动回复唯一待回复消息，多条时用 `messageId` 指定。
- 回复以插话形式立即送达原发送者；对用户消息的回复会进入用户消息队列。
- 组长能看到全组广播和私聊；成员只能看到自己发送或收到的消息。

## 7. 组长管理分组

`multi_agent_manage_group` 的 `action`：

- `update`：改名称/说明/颜色。
- `delete`：删除分组。
- `add_member` / `set_role`：把指定 `sessionId` 加入或调整角色；设组长时可用 `takeover: true` 接管。
- `remove_member`：移出成员；不能移除自己（用 `multi_agent_leave_group` 退出）。
- `list_candidates`：扫描当前工作区可加入的会话。

组长退出或被移出后，最早加入的成员自动升为组长；成员全部离开后分组自动删除。

## 8. 常见错误码

| 错误码 | 含义 | 处理方式 |
| --- | --- | --- |
| `NOT_LEADER` | 你不是该分组组长 | 换组长操作，或先设_role 调整角色 |
| `NOT_IN_GROUP` | 你不在该分组 | 先 `multi_agent_join_group` |
| `GROUP_FULL` | 会话数达到上限 | 让用户调大上限，或拆到新组 |
| `NO_TASK_MODULE` | 没有未分配任务模块 | 先 `multi_agent_create_task` 建模块 |
| `TASK_REQUIRED` | 创建成员会话缺 `taskId` | 传一个未分配任务 ID |
| `TASK_GROUP_MISMATCH` | 任务与分组不匹配 | 只能绑定本组任务 |
| `TASK_ALREADY_ASSIGNED` | 模块已绑定负责人 | 换未分配模块 |
| `TASK_CYCLE` | 连线会形成环 | 调整连线方向 |
| `TASK_EDGE_EXISTS` | 连线已存在 | 不必重复创建 |
| `TASK_SELF_LOOP` | 自环 | from 与 to 不能相同 |
| `PENDING_REPLY` | 你有未回复消息 | 先 `multi_agent_reply_message` |
| `NEED_RECIPIENT` | 私聊缺目标 | 从 `multi_agent_members` 取 sessionId |
| `ALREADY_REPLIED` | 这条消息已回复过 | 换一条消息回复 |
| `MESSAGE_NOT_FOUND` | 消息不存在或已失效 | 重新 `multi_agent_messages` |
| `NOT_RECIPIENT` | 你不是该消息收件人 | 无法回复 |
| `SPAWN_MODEL_UNAVAILABLE` | 分组继承配置的模型不可用 | 请组长在管理页重选继承配置 |
| `INVALID_MAX_SESSIONS` | 会话上限不是 2–32 | 传合法数字 |
| `MAX_SESSIONS_TOO_SMALL` | 新上限低于当前人数 | 先移出成员或调大上限 |

## 9. 配置项（由用户在界面上修改）

- **每组最大会话数**：2–32，默认 8，含组长；仅用户可调，Agent 没有对应工具。
- **新会话继承**：`inherit` 跟随组长模型与推理等级；`custom` 指定 `provider` / `model` / `reasoningEffort`，模型列表来自当前可用模型目录（`GET /multi-agent/api/models`）。
- **组名/说明/颜色**：组名唯一，最多 40 字；说明最多 240 字。
- **完全权限**：组长当前为 `danger-full-access` 时，新建成员会话自动继承该权限。

## 10. HTTP API（人类调试用）

- `GET /multi-agent/api/state`：全部状态。
- `GET /multi-agent/api/tools`：Agent 工具注册状态。
- `GET /multi-agent/api/models`：可用模型目录（供管理页选择继承配置）。
- `GET /multi-agent/api/messages?groupId=...`：分组消息。
- `POST /multi-agent/api/action`：需要请求头 `x-dsh-multi-agent: 1`，body 形如 `{ "action": "createTask", "groupId": "...", "title": "..." }`。

常用 action：`createGroup` / `updateGroup` / `deleteGroup` / `assign` / `leave` / `createMemberSession` / `createTask` / `updateTask` / `deleteTask` / `setTaskStatus` / `createTaskEdge` / `deleteTaskEdge` / `sendMessage` / `replyMessage` / `deliverReply` / `markDelivered`。

## 11. 协作最佳实践

- 先建任务树，再建会话：一个模块一个会话，职责清晰、便于验收。
- 任务说明写成自包含规格：目标、输入、输出、约束、验收标准、交付位置。
- 模块数量尽量对齐可用会话名额（上限 - 1，组长不领任务）。
- 用连线表达依赖，串行链和并行分叉都可以；保持 DAG，避免环。
- 派活消息里带上任务 ID（`task_...`），成员可直接引用。
- 完成任务及时改 `done` 并回复组长；有阻塞立即私聊组长。
- 组长只管理，不领取任务；需要更多并行度时，让组员自建子组并担任组长。
