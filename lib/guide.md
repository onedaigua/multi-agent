# dsh-multi-agent — Agent Guide

Concise operational guide. Load this skill before calling any `multi_agent_*` tool.

## Roles
- Every group has exactly one leader; all other sessions are members.
- A session can join several groups with a different role in each.
- The server re-checks permissions on every write; tool visibility is only a hint.
- Unsure about your group or role? Call `multi_agent_groups` first.
- Leader-only: group edit/delete, member add/remove/role, task create/edit/delete/link, `create_member`, `multi_agent_usage`. Members list groups/tasks/activity, work their own cards, and send/reply to messages.

## Tools (7; most select the operation with `op="-x"`)

### multi_agent_groups
- `-l` (default): list all groups, your role, leaders and members. The first line is your own session ID (`Your session ID: …`), which other members need for DMs and task assignment.
- `-m`: members of one group. Needs `groupId` unless you belong to exactly one group. Copy the full `recipientSessionId` for DMs.
- `-c`: scan the current workspace for sessions that can join a group.

### multi_agent_group
- `-n`: create a group; you become leader. `name` is required; optional: `description`, `color`.
- `-j`: join. Needs `groupId`; optional `role` (`leader`|`member`). With `role="leader"` and an existing leader you must pass `takeover=true` (the old leader becomes a member).
- `-x`: leave. Omit `groupId` to leave every group.
- `-u`: edit `name`/`description`/`color`. Leader only.
- `-d`: delete the group. Leader only.
- `-a`: add a member. Needs `groupId` (or single-group fallback), `sessionId`; optional `role`.
- `-r`: remove a member. Needs `sessionId`. Leader only; you cannot remove yourself — use `-x` to leave.
- `-s`: change a role. Needs `sessionId` and `role`. Leader only.
- `-t`: list sessions in the current workspace that can still join.

### multi_agent_create_member (leader)
Create a fresh agent in the leader's workspace and bind it to one unassigned task. The agent is spawned as a DSH subagent of the leader when the runtime supports it; otherwise a plain session is created.
- `name` (required, 2–24 chars), `taskId` (required), `groupId` (optional when you lead one group).
- Requires a free task module and a free member slot (`maxSessions`).
- No history is inherited; model/reasoning come from the group spawn config (default: inherit leader).
- The new agent runs one short setup turn (loads the guide), then stays idle.
- It joins as a member and becomes the task assignee.

### multi_agent_task
- `-l`: list tasks and edges (any member).
- `-c`: create. Needs `title` (1–80); `status` (`todo`|`doing`|`done`) defaults to `todo`, and `status="done"` also needs `completionNote` — the module brief (see below). Leader only.
- `-u`: edit. Needs `taskId`; pass `title`, `description`, `status`, `completionNote`, `assigneeSessionId` (empty string clears it) as needed. Leader only; a leader may assign a card to itself.
- Assigning a card (`-u assigneeSessionId`, or `-c … assigneeSessionId`) pushes a notification to the assignee with the title, id, the description and an explicit "start now" instruction, so no separate wake-up is needed. The same call revives a parked member.
- `-d`: delete. Needs `taskId`; its edges go too. Leader only.
- `-s`: set status. Needs `taskId` and `status`; allowed for the assignee or the leader. Marking a task `done` requires a non-empty `completionNote` (pass it with `-s` or `-u`): the module brief that tells another agent what the module does, where its entry points are and how to use it.
- A task that is `done` with a module brief is a permanent record: nobody can delete it (tool returns `TASK_LOCKED`), and every member can list it.
- `-x`: connect. Needs `from`, `to` (task ids); rejects cycles. Leader only.
- `-r`: delete an edge. Needs `edgeId`. Leader only.

### multi_agent_activity (query only)
- `-l`: list records. Every record has a short numeric ID (compact 64-bit, encodes its creation time) and writes show `+added/-removed` line counts.
- `query` extras for `-l`: `-a` all records, `-s <filename>`, `-m <sessionId>` (all records of one member), trailing number 1–200 (recent N). Without extras it lists entries currently in use; the UI tab always shows all records and expands the diff when a row is clicked.
- `-d`: show the added/removed lines captured for one write. Needs `id` from the list. Each line carries the file line number when it is known: `- 12 <old line>` for a removed line and `+ 12 <new line>` for an added one (removed numbers are in the pre-write file, added numbers in the post-write file). Records captured before v0.8.10 only stored the text, so their numbers are blank — that is legacy data, not line 0.
- A diff is recorded only for `write`/`edit` tool calls made by a group member, on text files under 512 KB (binary or oversized files are skipped); at most 200 removed and 200 added lines are kept and the record is marked truncated when lines were dropped. Shell writes are not captured.
- Repeated writes to one file merge into the same record only when they are within 5 seconds of each other (line counts add up). A later write starts a new record, so earlier rounds and the big first rewrite stay visible in history instead of being overwritten.
- The standard fs tools (`read`/`write`/`edit`) record locks automatically and enforce them; never register or edit entries by hand.
- `read` locks are shared, `write` locks are exclusive. A conflicting fs call is denied with `FILE_IN_USE` until the holder releases it (or the 3/15-minute TTL expires). Locks are released when the fs call finishes.
- `bash` and other shell commands are **not** covered by the guard.

### Member lifecycle (no tool, no handover)
- The old lifecycle operations are gone: there is no `multi_agent_member` tool and no handover/self-archive/restore op. A member is **parked** (archived status) while it has no unfinished task, and active while it has one:
  - Marking the last task `done` (with its module brief) parks the member automatically. A task cannot be marked `done` without the brief.
  - Assigning a task (`-u assigneeSessionId`, or `-c … assigneeSessionId`) revives a parked member and wakes it with a task notification.
  - A private message also revives a parked member when it names a `taskId` of one of their done tasks: that task goes back to `doing` with its module brief cleared, the member comes back and receives the message. Use this when a delivery was poor and needs rework instead of a new task.
  - Joining a group without an unfinished task parks the session immediately, so a new member waits for an assignment instead of chatting.
  - The leader is never parked automatically; the user can archive the leader by hand from the Manage tab and undo it with the same button (`Unarchive`).
- Parked members receive no broadcasts. A DM to one needs `taskId` (a done task assigned to them); without it the send fails with `TASK_CONTEXT_REQUIRED`, with a task that is not theirs or not done it fails with `TASK_NOT_REOPENABLE`. They do not count toward the session limit (the member counter shows active members only).
- The Manage tab lists active members and, below them, parked members with `auto`/`manual` and the archive date. There is no Restore button: assign a task and the member comes back. The archived leader row carries `Unarchive`, the only way back for a manual archive.
- Leaders who take work themselves claim their card with `multi_agent_task -u` (`assigneeSessionId` = their own session); completed work is kept as a record.

### multi_agent_usage
- `-l`: token usage report for one group. Leader only (members do not get this tool). Needs `groupId` only when you lead several groups. One row per member (leader or member, input / cache read / output), plus the group total and each share; `refresh=true` bypasses the 15s cache.
- Values are the provider-reported tokens of each session, the same numbers as the Usage tab; sessions that have not reported usage yet are shown as "no usage reported yet".

### multi_agent_message
- `-l`: list messages (leader sees the whole group; members only their own).
- `-s`: send. Needs `content` (≤4000 chars); defaults to broadcast. For a DM pass `mode="private"` and `recipientSessionId` (required; get it from `multi_agent_groups -m`). A DM to a parked member also needs `taskId` of one of their done tasks (`taskId` is a top-level tool parameter, separate from the text): the task reopens (`doing`, module brief cleared), the member is woken and returns; it must write a new module brief before it can be parked again.
- `-r`: reply. Needs `content`; `messageId` optional when exactly one reply is pending (otherwise the error lists candidates). Every reply is also stored as its own message (`Reply to <messageId>`), so `-l` and the UI queue show the full audit chain, not only the nested `reply:` line.
- Delivery is a non-blocking DSH agent notification: the sender returns immediately and does not wait. Assigning a task sends the same kind of notification with the task description and a "start now" instruction; the member does not need a separate request.
- A DSH notice such as "failed before it finished" means that turn was interrupted (network, abort, provider error) and the session is still alive; send the member a message or assign a task to continue. It is not a plugin error and the member is not parked by it.
- A sender with pending replies must reply first; messages cannot cross groups; each delivery can be answered once.

## Workflow
1. Leader: create a group (`multi_agent_group -n`), then add existing sessions (`-a`) or spawn new ones (`create_member`).
2. Leader: split work into task modules first (`multi_agent_task -c title=... status=todo`); each spawned session must bind one unassigned task.
3. Leader: assign owners (`-u assigneeSessionId`) and connect dependencies (`-x from to`).
4. Member: list tasks (`-l`), work only on assigned tasks, set `-s taskId status=done` when done, reply to messages.
5. Shared files lock automatically: `read` (shared) / `write` (exclusive). Use `multi_agent_activity -l` to see holders, `-d id=...` for the exact lines a write added/removed; writes to the same file within 5 s share one diff record, later rounds get their own record; just work normally.
6. Finished a task? Mark it `done` with a module brief (what it does, key files, how others use it). With no unfinished task left you are parked automatically and stop receiving broadcasts; the next assignment revives you, and a DM that names one of your done tasks reopens it and wakes you too.
7. Report results to the leader by DM (a non-blocking notification); the leader reports to the user.

Common params: `groupId` is optional when you belong to exactly one group; member operations take `sessionId`.

## Limits
- Tasks: 200; edges: 800; task ids look like `task_…`, `edge_…`; title 1–80; description ≤600; module brief ≤600. A length error reports the actual character count.
- Groups: 40; memberships: 4000; name ≤40; description ≤240; max sessions per group 2–32 (default 8, user-adjustable).
- Messages: ≤4000 chars each; 2000 kept; no cross-group sends.
- A leader cannot demote or remove itself; use `-x` to leave. If the leader leaves, the earliest member is promoted; empty groups are deleted.
- Everyone can see all groups and their member session ids.

## Common errors
- `NOT_LEADER` / `NOT_IN_GROUP` (403): wrong role.
- `GROUP_FULL` (409): member limit reached.
- `TASK_REQUIRED` (400) / `NO_TASK_MODULE` / `TASK_ALREADY_ASSIGNED` (409): spawn needs one free task module.
- `INVALID_STATUS` (400): status must be todo/doing/done (task create needs it too).
- `TASK_CYCLE` / `TASK_EDGE_EXISTS` / `TASK_LIMIT` / `TASK_EDGE_LIMIT` (409).
- `FILE_IN_USE` (409): file locked; `PENDING_REPLY` (409): reply first.
- `NEED_RECIPIENT` / `NEED_MESSAGE_ID` (400): private DM or reply needs an id.
- `ALREADY_REPLIED` / `NOT_RECIPIENT` (409/403); `NO_PENDING_REPLY` (404): nothing left to answer.
- `NOT_ASSIGNEE` (403): that task belongs to another member; `SELF_PRIVATE` (400): cannot DM yourself.
- `INVALID_*` (400); `*_NOT_FOUND` (404); `SESSION_SERVICE` (503): session service unavailable.
- Member lifecycle: `NOTE_REQUIRED` (done without a module brief) / `TASK_LOCKED` (done record cannot be deleted) / `TASK_CONTEXT_REQUIRED` (DM to a parked member without `taskId`) (400).
- Reopen errors: `TASK_NOT_FOUND` (404, `taskId` is not in the group) / `TASK_NOT_REOPENABLE` (409, the task is not this member's or is not done).

## User settings (UI)
- Group page lists group cards; open one to switch tabs: Manage, Group tasks, Messages, Usage, Activity.
- Manage lists active members and, below them, **parked members** (archive date plus `auto`/`manual`). Parked members get no broadcasts and are not counted; assign a task, or private-message one with one of its done tasks, to revive it. Active rows carry `设为组长`/`Set as leader` and `移除`/`Remove`; the leader row also has a manual `归档`/`Archive`, and an archived leader shows `取消归档`/`Unarchive`.

- A done task shows its module brief (label `Module brief`) instead of a one-line completion note.
- The page adapts to phone widths (v0.8.11): cards stack in one column, the tab bar wraps instead of overflowing, the detail header and the message header switch to two rows, and the activity diff keeps its line-number gutter. Width comes from the host frame, so it follows the pane, not a media query.
- Max sessions per group (2–32, default 8).
- Spawn model/reasoning: inherit leader (default) or a fixed model.
- Token usage: the `multi_agent_usage` tool (leader) returns the same numbers as the Usage tab; server cache 15 s, `refresh=true` forces a recount.
- Messages tab: a parked recipient is shown with `· parked`; picking one enables the `Reopen task` list of its done tasks. Replies are separate rows (`Reply to <messageId>`) in the queue, and the composer shows the parked-member hint above the text box.

## HTTP API (debugging)
Base `/multi-agent/api`, same-origin only, requires header `x-dsh-multi-agent: 1`.
`GET /state`, `/tools`, `/models`, `/messages?groupId=&sessionId=`, `/usage?groupId=&refresh=1`; `POST /action`.
State file: `<profile>/.dsh-multi-agent/state.json` (mode 0600).
