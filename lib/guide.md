# dsh-multi-agent 使用指南（AI 引导技能）

> 本技能面向 AI 助手。只要准备调用任何 `multi_agent_*` 工具、管理 Agent 分组、任务板或执行列表，就先按本指南确认自己的角色与权限，再操作。
>
> 工具已经按同源合并：共 6 个工具，用参数 `op="-x"` 区分具体操作。所有 `op` 都写成 `-l`、`-c` 这样的短横线形式。

## 1. 先确认自己是谁

调用 `multi_agent_groups`（默认 `op="-l"`）：

- 第一行是你的**完整会话 ID**（`session-...`），广播/私聊、任务归属、执行记录都靠它标识你。
- 列出所有分组、每个分组的组长与成员、你在每组中的角色。
- 你不是任何分组的成员时，先让组长把你加入，或自己用 `multi_agent_group op="-n"` 新建分组（创建者自动成为组长）。

你同时属于多个分组时，除 `multi_agent_groups` 与 `multi_agent_group op="-n"/"-j"` 外，其余操作都要带 `groupId`；只有一个分组时可以省略。

## 2. 核心概念

- **分组（group）**：一个协作单元，有且只有一个组长；组内成员共享任务空间、执行列表和消息队列。
- **任务（task）**：`task_...` 形式的卡片，属于某个分组，可标记 `todo` / `doing` / `done`，可指定负责人（`assigneeSessionId`），可用连线组成 `a → b → c` 的 DAG（允许并行分叉，禁止成环）。
- **任务归属**：组长把任务分配给成员后，成员才能用 `op="-s"` 改自己任务的完成状态。
- **执行列表（activity）**：组内共享的文件使用记录，记录谁在什么时间使用了/移动/复制了哪个文件、状态是使用中/仅查看/已修改。用于避免两人同时改同一个文件。
- **消息（message）**：组内广播或私聊，以 `steer` 插话直接送达对方对话；收到消息后必须回复。
- **成员会话**：组长可以在自己的当前工作区新建一个空白会话作为成员，新会话没有历史上下文。
- **Token 用量报表**：分组详情页展示组内每人的累计 token 用量、组内总量与占比；按用量从高到低排列，占比取整到 1%。

## 3. 工具速查表（6 个）

| 工具 | 谁能用 | 主要参数 | 作用 |
| --- | --- | --- | --- |
| `multi_agent_groups` | 所有人 | `op?`：`-l` 列表（默认）/ `-m` 成员 / `-c` 候选会话；`groupId?` | 定位会话 ID、分组、角色；查成员；扫描可加入的会话 |
| `multi_agent_group` | 所有人（管理操作仅组长） | `op`：`-n` 新建 / `-j` 加入 / `-x` 退出 / `-u` 修改 / `-d` 删除 / `-a` 加成员 / `-r` 移成员 / `-s` 调角色 / `-t` 候选；`groupId?`、`name?`、`description?`、`color?`、`role?`、`takeover?`、`sessionId?` | 分组的全部生命周期操作 |
| `multi_agent_create_member` | 组长 | `name`、`taskId`、`groupId?` | 在组长工作区新建成员会话，绑定任务模块并自动入组 |
| `multi_agent_task` | 组内成员（写操作仅组长，改状态限负责人/组长） | `op`：`-l` 列表 / `-c` 创建 / `-u` 修改 / `-d` 删除 / `-s` 改状态 / `-x` 连线 / `-r` 删连线；`groupId?`、`taskId?`、`title?`、`description?`、`status?`、`assigneeSessionId?`、`from?`、`to?`、`edgeId?` | 任务空间（含负责人归属与 DAG 连线） |
| `multi_agent_activity` | 组内成员（改/删限创建者或组长） | `op`：`-l` 查看 / `-c` 登记 / `-u` 修改 / `-d` 删除；`query?`、`activityId?`、`path?`、`state?`、`operation?`、`destination?`、`note?` | 执行列表与文件占用 |
| `multi_agent_message` | 组内成员 | `op`：`-l` 查看 / `-s` 发送 / `-r` 回复；`content?`、`groupId?`、`mode?`、`recipientSessionId?`、`messageId?` | 广播、私聊、回复 |

常用示例：

```jsonc
// 查看分组与角色
{ "op": "-l" }

// 查看成员（拿私聊 ID）
{ "op": "-m", "groupId": "grp_xxx" }

// 建组
{ "op": "-n", "name": "排序项目" }

// 建任务
{ "op": "-c", "title": "实现快速排序", "description": "含测试" }

// 把任务派给成员
{ "op": "-u", "taskId": "task_xxx", "assigneeSessionId": "session-xxx" }

// 成员改自己任务状态
{ "op": "-s", "taskId": "task_xxx", "status": "doing" }

// 连成 a → b → c
{ "op": "-x", "from": "task_a", "to": "task_b" }

// 登记占用
{ "op": "-c", "path": "/root/C/sort.js", "state": "using" }

// 查使用中
{ "op": "-l" }

// 广播
{ "op": "-s", "content": "任务开始，有问题直接回复我" }

// 回复唯一待回复消息
{ "op": "-r", "content": "已完成，测试 9/9 通过" }
```

## 4. 场景 A：组长组建团队并交付

### 4.1 建组

```
multi_agent_group  op="-n"  name="排序项目"
```

创建者自动成为组长。分组名唯一（大小写不敏感），最多 40 组。

### 4.2 先拆任务树（分组块）

用 `multi_agent_task op="-c"` 逐块建卡，例如「定义接口」「实现算法」「编写测试」「集成验证」；再用 `op="-x"` 连成流程：

```
multi_agent_task op="-x" from="task_接口" to="task_算法"
multi_agent_task op="-x" from="task_算法" to="task_测试"
```

规则：同组、不能自环、不能重复、不能成环；允许一个任务连多个下游（并行）。

### 4.3 建成员会话（必须先有未分配任务模块）

1. 用 `multi_agent_task op="-l"` 确认「未分配任务模块」数量 > 0。
2. 每个新会话必须绑定一个未分配任务：

```
multi_agent_create_member
  name="排序成员"                 // 2–24 字
  taskId="task_实现算法"          // 未分配的任务模块
```

新会话默认成员身份、无历史上下文；模型/推理等级默认继承组长（或分组「新会话继承」配置）；组长是 `danger-full-access` 时新会话也是完全权限。分组有最大会话数（默认 8，只有用户能在管理页调整）。

- 分组满员 → 409 `GROUP_FULL`；没有未分配模块 → 409 `NO_TASK_MODULE`；模块已被绑定 → 409 `TASK_ALREADY_ASSIGNED`。
- 任务模块确实多到超过上限：让组员用 `multi_agent_group op="-n"` 另建新组并担任新组组长，再在新组里分块下发。

### 4.4 下发任务

```
multi_agent_message op="-s" content="请实现三路快排并附测试，完成后回复我"
```

- 私聊：`{ "op": "-s", "mode": "private", "recipientSessionId": "session-xxx", "content": "..." }`，目标 ID 用 `multi_agent_groups op="-m"` 查。
- 不能发给自己，不能跨组。
- 如果你自己有未回复消息，发送会被拒绝（`PENDING_REPLY`），先 `multi_agent_message op="-r"`。

### 4.5 跟踪与验收

- `multi_agent_task op="-l"` 查看状态、负责人与连线。
- 组长用 `op="-u"` 改说明、状态、负责人（`assigneeSessionId: ""` 取消归属）。
- 负责人或组长用 `op="-s"` 标记 `doing` / `done`。
- 成员完成后用 `multi_agent_message op="-r"` 或 `op="-s"` 汇报；组长整理成果后交付用户。

### 4.6 收尾

- 删任务：`multi_agent_task op="-d" taskId="..."`（相关连线级联删除）。
- 删连线：`multi_agent_task op="-r" edgeId="..."`。
- 删分组：`multi_agent_group op="-d"`（成员、消息、任务一并清理）。

## 5. 场景 B：成员接到任务

1. `multi_agent_groups` 确认自己在哪个组、什么角色；`multi_agent_task op="-l"` 找到自己负责的 `taskId`。
2. 用 `multi_agent_task op="-s"` 把任务改为 `doing`。
3. 干活；过程中的问题/进展用 `multi_agent_message op="-s"` 汇报。
4. 完成后 `op="-s"` 改为 `done`，再用 `multi_agent_message op="-r"` 给组长发完成说明（改动了哪些文件、如何验证）。

## 6. 场景 C：消息与待回复

- 每次收到消息都会产生一条待回复记录；`multi_agent_message op="-l"` 可查看（组长能看到全组广播和私聊，成员只能看到与自己相关的）。
- 每条消息只能回复一次；`op="-r"` 只填 `content` 时自动回复唯一待回复消息，多条时用 `messageId` 指定。
- 待回复期间不能发新消息，先回复。

## 7. 场景 D：执行列表与文件占用

### 7.1 修改共享文件前

1. `multi_agent_activity op="-l"` 查看目标文件是否有人正在使用（默认只看使用中）。
2. 用 `op="-c"` 传 `{ "path": "...", "state": "using" }` 登记占用；若同一文件已被其他成员占用会返回 409 `FILE_IN_USE`，消息里带有使用者的 sessionId 和时间。
3. 只是查看用 `state: "viewing"`（不会被拒绝，但结果会提示占用者）。
4. 改完用 `op="-u"` 把状态改为 `modified`，或 `op="-d"` 释放记录。

### 7.2 移动或复制

```
{ "op": "-c", "path": "/root/C/a.js", "operation": "move", "destination": "/root/C/src" }
```

`operation` 取 `open`（默认）/ `move` / `copy`；move/copy 必须给 `destination`，缺失返回 400 `DESTINATION_REQUIRED`。

### 7.3 自动登记与筛选

- 组员的 `read` 工具操作会自动登记为「仅查看」，`write`/`edit` 自动登记为「已修改」，同一会话对同一文件只保留一条自动记录；手动登记（`using`）不会被自动记录覆盖。
- 自动登记只覆盖标准文件工具；其他工具需要手动登记。
- `op="-l"` 默认只返回「使用中」；`query` 传 `-a` 看全部，传 `-s 文件名` 按文件名匹配（路径可不同），可组合成 `-a -s sort.js`。

## 8. 组长管理分组

`multi_agent_group` 的管理操作：

- `-u`：改名称/说明/颜色。
- `-d`：删除分组。
- `-a` / `-s`：添加成员 / 调整角色（`role: "leader"` 且已有组长时需 `takeover: true`）。
- `-r`：移出成员；不能移除自己（用 `-x` 退出）。
- `-t`：扫描当前工作区可加入的会话。

组长不能直接把自己降为成员，也不能移除自己；组长退出后由最早加入的成员自动接任，空组自动删除。

## 9. 常见错误码

| 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `NOT_LEADER` | 你不是该组组长 | 找组长操作，或自己建组 |
| `NOT_IN_GROUP` | 你不在该分组 | 先 `multi_agent_group op="-j"` |
| `GROUP_NOT_FOUND` | 分组不存在 | 用 `multi_agent_groups` 重新确认 |
| `NO_TASK_MODULE` | 没有未分配任务模块 | 先 `multi_agent_task op="-c"` 建模块 |
| `TASK_REQUIRED` | 创建成员会话缺 `taskId` | 补 `taskId` |
| `TASK_ALREADY_ASSIGNED` | 任务模块已被绑定 | 换一个未分配模块 |
| `TASK_GROUP_MISMATCH` | 跨组操作任务/连线 | 同组任务才能连线或绑定 |
| `TASK_CYCLE` | 连线会形成环 | 换个方向或目标 |
| `GROUP_FULL` | 分组达到最大会话数 | 删成员或在管理页调大上限 |
| `PENDING_REPLY` | 你有未回复消息 | 先 `multi_agent_message op="-r"` |
| `NEED_RECIPIENT` | 私聊缺目标 | 用 `multi_agent_groups op="-m"` 取 sessionId |
| `MESSAGE_NOT_FOUND` | 消息不存在或已失效 | 重新 `multi_agent_message op="-l"` |
| `FILE_IN_USE` | 文件被其他成员占用 | 等对方完成，或改用 `viewing` 登记 |
| `NOT_ACTIVITY_OWNER` | 不是记录创建者/组长 | 让创建者或组长修改/删除 |
| `ACTIVITY_NOT_FOUND` | 执行记录不存在 | 用 `multi_agent_activity op="-l" query="-a"` 重新获取 ID |
| `DESTINATION_REQUIRED` | move/copy 缺目标目录 | 补 `destination` |
| `INVALID_QUERY` | 执行列表筛选参数不合法 | 用 `-a`、`-s 文件名` 或留空 |

## 10. 配置项（由用户在界面上修改）

- 最大会话数：管理弹窗「最大会话数」，默认 8，范围 2–32，不能小于当前成员数。
- 新会话继承：默认继承组长；也可指定固定模型与推理等级（模型列表来自当前可用模型）。
- Token 用量：分组详情页的「Token 用量」区块；服务端缓存 15 秒，点「刷新」可强制重算。

## 11. HTTP API（人类调试用）

- `GET /multi-agent/api/state` — 分组、成员、任务、连线、执行记录（消息不公开）
- `GET /multi-agent/api/tools` — 工具注册状态
- `GET /multi-agent/api/models` — 可选模型目录
- `GET /multi-agent/api/usage?groupId=<分组>&refresh=1` — Token 用量报表（`total` 为组内总量，成员按用量降序，`percent` 为整数占比）
- `GET /multi-agent/api/messages?groupId=&sessionId=` — 指定身份可见的消息
- `POST /multi-agent/api/action` — 变更操作，要求同源 + 请求头 `x-dsh-multi-agent: 1` + JSON

状态文件：`<profile>/.dsh-multi-agent/state.json`（权限 600，原子写）。

## 12. 协作最佳实践

1. 动手前先 `multi_agent_groups` 确认角色，避免越权。
2. 修改共享文件前先查执行列表并登记占用；改完改成 `modified` 或删除记录。
3. 派活时把任务拆到可独立完成、可验证的粒度，并绑定负责人。
4. 消息要带上下文和验收标准；收到消息先回复，再继续干活。
5. 任务状态及时更新，让组长不用靠猜。
