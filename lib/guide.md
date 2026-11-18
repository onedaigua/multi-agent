# dsh-multi-agent — Agent Guide

Concise operational guide. Load this skill before calling any `multi_agent_*` tool.

## Roles
- Every group has exactly one leader; all other sessions are members.
- A session can join several groups with a different role in each.
- The server re-checks permissions on every write; tool visibility is only a hint.
- Unsure about your group or role? Call `multi_agent_groups` first.

## Tools (6, select the operation with `op="-x"`)
- `multi_agent_groups` — `-l` list groups, your roles, leaders and members; `-m` members of one group (copy `recipientSessionId` for DMs); `-c` sessions in this workspace that can join.
- `multi_agent_group` — `-n` create (you become leader); `-j` join (`groupId`, `role`, `takeover`); `-x` leave (omit `groupId` to leave all); `-u` update name/description/color; `-d` delete; `-a` add member; `-r` remove member; `-s` set role; `-t` list candidates. `-u/-d/-a/-r/-s` require leader.
- `multi_agent_create_member` (leader) — create a fresh session in the leader's workspace and bind it to one unassigned task. Params: `name` (2–24 chars, required), `taskId` (required), `groupId` (optional). No history is inherited; model/reasoning follow the group spawn config (default: inherit leader). Respects the max-sessions limit.
- `multi_agent_task` — `-l` list tasks and edges; `-c` create; `-u` update (assign `assigneeSessionId`; empty string clears it); `-d` delete (also removes its edges); `-s` set status (`todo|doing|done`; assignee or leader only); `-x` connect (`from`,`to`); `-r` delete edge (`edgeId`). `-c/-u/-d/-x/-r` require leader. Edges form a DAG: cycles are rejected.
- `multi_agent_activity` — `-l` list (default: active locks; `query`: `-a` all, `-s name`, `-m <sessionId>`, trailing number 1–200); `-c` create (`path`, `state`: `read`|`write`, `operation`, optional `destination`/`note`); `-u` update; `-d` delete. Members may view/create; only the creator or leader may update/delete. Locking: many `read` allowed, one `write` at a time; a conflicting registration is rejected with 409 `FILE_IN_USE`, and the fs tool call itself is denied until the lock can be taken.
- `multi_agent_message` — `-l` list; `-s` send (broadcast by default; `mode="private"` + `recipientSessionId` for a DM); `-r` reply. Reply to pending messages before sending new ones.

## Workflow
1. Leader: create a group (`-n`), then add existing sessions (`-a`) or spawn new ones (`create_member`).
2. Leader: split the work into task modules (`multi_agent_task -c`) before spawning; each spawned session must bind one unassigned task.
3. Leader: assign owners (`-u assigneeSessionId`) and connect dependencies (`-x`).
4. Member: read tasks (`-l`); work only on tasks assigned to you; set `-s done` when finished; reply to messages.
5. Shared files are locked automatically: `read` (shared) or `write` (exclusive). Conflicting `read`/`write`/`edit` calls are denied; use `-l` to see holders and delete your record when done. For moves/copies use `operation="move|copy"` + `destination`.
6. Report results to the leader by DM; the leader reports to the user.

Common params: `groupId` is optional when you belong to exactly one group; member operations take `sessionId`.

## Limits
- Tasks: 200; edges: 800; title 1–80 chars; description ≤600; ids look like `task_…`, `edge_…`.
- Groups: 40; memberships: 4000; name ≤40 chars; description ≤240; max sessions per group 2–32 (default 8, user-adjustable).
- Messages: 4000 chars; 2000 kept; no cross-group sends.
- A leader cannot demote or remove itself; use `-x` to leave. If the leader leaves, the earliest member is promoted; empty groups are deleted.
- Everyone can see all groups and member session ids.

## Common errors
`NOT_LEADER` / `NOT_IN_GROUP` (403) — wrong role; `GROUP_FULL` (409) — max sessions; `TASK_REQUIRED` / `NO_TASK_MODULE` / `TASK_ALREADY_ASSIGNED` (409) — spawn needs one free task; `TASK_CYCLE` / `TASK_EDGE_EXISTS` (409); `FILE_IN_USE` / `PENDING_REPLY` / `ACTIVITY_LIMIT` (409); `INVALID_*` (400); `*_NOT_FOUND` (404).

## User settings (UI)
- Max sessions per group (2–32, default 8).
- Spawn model/reasoning: inherit leader (default) or a fixed model.
- Token usage (UI only, no tool): group detail shows per-member totals, group total and integer share; server cache 15 s, refresh forces a recount.

## HTTP API (debugging)
Base `/multi-agent/api`, same-origin only, requires header `x-dsh-multi-agent: 1`.
`GET /state`, `/tools`, `/models`, `/messages?groupId=&sessionId=`, `/usage?groupId=&refresh=1`; `POST /action`.
State file: `<profile>/.dsh-multi-agent/state.json` (mode 0600).
