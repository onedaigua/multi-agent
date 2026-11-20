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
- `-m`: members of one group, with active/parked status (`parked (auto|manual)`). Needs `groupId` unless you belong to exactly one group. Copy the full `recipientSessionId` for DMs. `-l` marks parked members too and counts only active ones (`members 3/8, 2 parked`).
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
- The new agent runs one short setup turn (loads the guide), then the bound module is announced in the same call: the leader posts the assignment as a real message (`mode=task`) and wakes the member with a steer interjection, so it sets the card to `doing`, replies and starts on its own — no manual DM needed.
- It joins as a member and becomes the task assignee; the tool result reports whether the assignment was delivered (`sent`) or failed with the reason (then reassign with `multi_agent_task -u` to retry).

### multi_agent_task
- `-l`: list tasks and edges (any member).
- `-c`: create. Needs `title` (1–80); `status` (`todo`|`doing`|`done`) defaults to `todo`, and `status="done"` also needs `completionNote` — the module brief (see below). Leader only.
- `-u`: edit. Needs `taskId`; pass `title`, `description`, `status`, `completionNote`, `assigneeSessionId` (empty string clears it) as needed. Leader only; a leader may assign a card to itself.
- Assigning a card (`-u assigneeSessionId`, or `-c … assigneeSessionId`) does three things in this order: it repairs the assignee status (a parked member, the leader included, is made active before anything is sent, so the wake-up cannot fail on "member is archived"), it posts the assignment as a real message from the leader in the group message list (`mode=task`, recipient = the assignee, `taskId` = the card), and it wakes the member with an agent-message interjection (`agent.steer` with `source.kind = "agent-message"`, so the conversation shows a collapsed context row instead of a message the user appears to have typed). A member spawned as a subagent is not addressable by `controller.prompt` ("owned by subagent routing"), so the wake-up falls back to `ctx.subagents.sendMessage(leaderAgent, memberId, …)`, which is the only channel into a subagent member; `controller.prompt` and a non-blocking DSH notification remain the last fallbacks for ordinary sessions. The member sets the card to `doing`, then replies to that message, so the leader can see the start without a second wake-up. The delivery is retried once and always ends as `sent` or `failed` with the reason — never left `delivering`; if it failed, assign the card again or message the member to retry.
- `-d`: delete. Needs `taskId`; its edges go too. Leader only.
- `-s`: set status. Needs `taskId` and `status`; allowed for the assignee or the leader. Marking a task `done` requires a non-empty `completionNote` (pass it with `-s` or `-u`): the module brief that tells another agent what the module does, where its entry points are and how to use it.
- A task that is `done` with a module brief is a permanent record: nobody can delete it (tool returns `TASK_LOCKED`), and every member can list it.
- `-x`: connect. Needs `from`, `to` (task ids); rejects cycles. Leader only.
- `-r`: delete an edge. Needs `edgeId`. Leader only.

### multi_agent_activity (query only)
- `-l`: list records. Every record has a short numeric ID (compact 64-bit, encodes its creation time); writes show the latest round `+added/-removed`, and with more than one write also `· N writes · hash a→b` for the whole record.
- `query` extras for `-l`: `-a` all records, `-s <filename>`, `-m <sessionId>` (all records of one member), trailing number 1–200 (recent N). Without extras it lists entries currently in use; the UI tab always shows all records and expands the diff when a row is clicked.
- `-d`: show the append-only history of one record. Needs `id` from the list. It prints `Writes: N`, the record file hash (`File hash: <before> → <after>`, sha256 truncated to 12 hex — compare it with a copy before restoring anything) and one block per write (`— write k · time · +added/-removed · hash <before>→<after>`) with the captured lines. Each line carries the file line number when it is known: `- 12 <old line>` for a removed line and `+ 12 <new line>` for an added one (removed numbers are in the pre-write file, added numbers in the post-write file). Records captured before v0.8.10 only stored the text, so their numbers are blank — that is legacy data, not line 0.
- A diff is recorded only for `write`/`edit` tool calls made by a group member, on text files under 512 KB (binary or oversized files are skipped); at most 200 removed and 200 added lines are kept and the record is marked truncated when lines were dropped. Shell writes are not captured.
- One record per member per file, for the whole life of that member in the group; switching member or file starts a new record. Every write appends a round to the record instead of overwriting it, so the first big rewrite and every later edit stay visible. The last 50 rounds are kept (older rounds are dropped) and each round carries its own before/after hash. The list shows `+added/-removed` of the latest round plus the number of writes and the record hash; `-d` shows the full history.
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
- `-l`: list messages (leader sees the whole group; members only their own). Task assignments are messages too (`mode=task`, from the leader): they wait for a reply like any DM.
- `-s`: send. Needs `content` (≤4000 chars); defaults to broadcast. For a DM pass `mode="private"` and `recipientSessionId` (required; get it from `multi_agent_groups -m`). A DM to a parked member also needs `taskId` of one of their done tasks (`taskId` is a top-level tool parameter, separate from the text): the task reopens (`doing`, module brief cleared), the member is woken and returns; it must write a new module brief before it can be parked again.
- `-r`: reply. Needs `content`; `messageId` optional when exactly one reply is pending (otherwise the note lists the pending ids). A reply is evidence of reading, not a status change: set the card to `doing` yourself (`-s`) when the assignment asks for work. Every reply is also stored as its own message (`Reply to <messageId>`), so `-l` and the UI queue show the full audit chain, not only the nested `reply:` line. Replying when nothing is pending, or to a message you did not receive, returns a short note instead of an error: such states are information, not failures.
- Delivery wakes each recipient with an agent-message `steer` interjection — the transcript shows a collapsed "context injection" row (labelled agent-message) rather than a user bubble. Subagent members are woken through `ctx.subagents.sendMessage(senderAgent, memberId, …)` instead, because the session controller refuses sessions owned by subagent routing; `controller.prompt` and a non-blocking DSH notification are the last fallbacks; the sender returns immediately and does not wait, and one failed recipient never blocks the others. Task assignment also carries the card description and a "start now" instruction, and its delivery status is recorded per recipient (`delivered` / `delivery failed (<reason>)`).
- A DSH notice such as "failed before it finished" means that turn was interrupted (network, abort, provider error) and the session is still alive; send the member a message or assign a task to continue. It is not a plugin error and the member is not parked by it.
- A sender with pending replies must reply first; messages cannot cross groups; each delivery can be answered once.

## Workflow
1. Leader: create a group (`multi_agent_group -n`), then add existing sessions (`-a`) or spawn new ones (`create_member`).
2. Leader: split work into task modules first (`multi_agent_task -c title=... status=todo`); each spawned session must bind one unassigned task. `create_member` announces that module immediately and wakes the new member, so spawned members start working without a manual DM.
3. Leader: assign owners (`-u assigneeSessionId`) and connect dependencies (`-x from to`).
4. Member: list tasks (`-l`) and messages (`multi_agent_message -l`); claim the assignment message by setting the card to `doing` (`-s taskId status=doing`) and replying to it, then work only on assigned tasks, set `-s taskId status=done` with the module brief when done.
5. Shared files lock automatically: `read` (shared) / `write` (exclusive). Use `multi_agent_activity -l` to see holders, `-d id=...` for the full write history of a record: every write is appended (with before/after hash) instead of merged, so earlier rounds and the first big rewrite stay visible; just work normally.
6. Finished a task? Mark it `done` with a module brief (what it does, key files, how others use it). A reopened card forgets the old brief; write a new one. With no unfinished task left you are parked automatically and stop receiving broadcasts; the next assignment revives you, and a DM that names one of your done tasks reopens it and wakes you too.
7. Report results to the leader by DM (a non-blocking notification); the leader reports to the user.

Common params: `groupId` is optional when you belong to exactly one group; member operations take `sessionId`.

## Ordering (avoid errors before they happen)
1. Create the task modules first (`multi_agent_task -c`), then spawn or add members: `create_member` binds one free task, and a member with no open task is parked immediately.
2. A broadcast only reaches active members. Assign a task before broadcasting (otherwise `NO_RECIPIENTS` says everyone else is parked); the assignment itself wakes the member.
3. Assignment messages and broadcasts are unread messages: answer them (`multi_agent_message -r`) before sending anything else, or `PENDING_REPLY` blocks the send. Do not broadcast to a member who still owes a reply.
4. Member order: set the card to `doing` first, then `done` with a module brief. Reopening a done card (done → doing) clears the old brief, so the next `done` needs a new one; a leader completing a card does not answer the assignment for the member.
5. A done card with a brief is a record: it cannot be deleted (`TASK_LOCKED`) and reassigning it wakes nobody (no assignment message is sent). Reopen it first if the work must be redone.
6. Unassigning the last open task parks that member. Assign the next task before unassigning if it must keep receiving messages.
7. Transfer leadership with `-s sessionId role=leader` before leaving; a leader cannot remove or demote itself.
8. Link edges between tasks that already exist and keep the flow acyclic (`TASK_CYCLE`).

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
- `FILE_IN_USE` (409): file locked; `PENDING_REPLY` (409): reply first; `NO_RECIPIENTS` (409): no active member to reach.
- `NEED_RECIPIENT` / `NEED_MESSAGE_ID` (400): private DM or reply needs an id.
- `ALREADY_REPLIED` / `NOT_RECIPIENT` (409/403); `NO_PENDING_REPLY` (404): the reply tool answers these three with a plain note instead of an error, since they are states, not failures.
- `NOT_ASSIGNEE` (403): that task belongs to another member; `SELF_PRIVATE` (400): cannot DM yourself.
- `INVALID_*` (400); `*_NOT_FOUND` (404); `SESSION_SERVICE` (503): session service unavailable.
- Member lifecycle: `NOTE_REQUIRED` (done without a module brief) / `TASK_LOCKED` (done record cannot be deleted) / `TASK_CONTEXT_REQUIRED` (DM to a parked member without `taskId`) (400).
- Reopen errors: `TASK_NOT_FOUND` (404, `taskId` is not in the group) / `TASK_NOT_REOPENABLE` (409, the task is not this member's or is not done).

## User settings (UI)
- Group page lists group cards; open one to switch tabs: Manage, Group tasks, Messages, Usage, Activity.
- Manage lists active members and, below them, **parked members** (archive date plus `auto`/`manual`). Parked members get no broadcasts and are not counted; assign a task, or private-message one with one of its done tasks, to revive it. Active rows carry `设为组长`/`Set as leader` and `移除`/`Remove`; the leader row also has a manual `归档`/`Archive`, and an archived leader shows `取消归档`/`Unarchive`.

- A done task shows its module brief (label `Module brief`) instead of a one-line completion note.
- The page adapts to phone widths (v0.8.11): cards stack in one column, the tab bar wraps instead of overflowing, the detail header and the message header switch to two rows, and the activity history keeps its line-number gutter; expanding a row lists every write round with its time, line counts and before/after file hash. Width comes from the host frame, so it follows the pane, not a media query.
- Max sessions per group (2–32, default 8).
- Spawn model/reasoning: inherit leader (default) or a fixed model.
- Token usage: the `multi_agent_usage` tool (leader) returns the same numbers as the Usage tab; server cache 15 s, `refresh=true` forces a recount.
- Messages tab: a parked recipient is shown with `· parked`; picking one enables the `Reopen task` list of its done tasks. Task assignments appear as `Task assignment` rows (from the leader, with the card id), replies as separate `Reply to <messageId>` rows, and the composer shows the parked-member hint above the text box.

## HTTP API (debugging)
Base `/multi-agent/api`, same-origin only, requires header `x-dsh-multi-agent: 1`.
`GET /state`, `/tools`, `/models`, `/messages?groupId=&sessionId=`, `/usage?groupId=&refresh=1`; `POST /action`.
State file: `<profile>/.dsh-multi-agent/state.json` (mode 0600).
