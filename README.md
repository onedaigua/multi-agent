# dsh-multi-agent

An external plugin that gives DeepSeek Harness agent groups and team collaboration.

This version ships **Agent Groups**, **group messages**, **per-group task spaces**, **an execution list (file locks)**, **token usage reports**, and a permission-aware tool surface for agents.

## Features

- The whole panel follows the DSH language setting: switch DSH to Chinese and every label, dialog and tab switches to Chinese; agent-facing tool descriptions, errors and docs stay English.
- A new **Agent Groups** page in the left sidebar: it starts with a grid of group cards; click a card to open that group's detail page.
- Create, edit and delete groups; each group has a name, description, color and search.
- The group detail page is organized into tabs: **Manage**, **Group tasks**, **Messages**, **Usage**, **Activity**. Tasks no longer have a separate sidebar entry.
- The Manage tab lists members, their roles (leader / member) and join time.
- A group must be created with a first leader; every group always keeps exactly one leader.
- The **Manage** tab can add members in bulk, remove members, promote to leader or demote to member, and configure new-session inheritance and the maximum session count.
- Adding members scans sessions in the current workspace, with search and multi-select; switch workspace scope when several workspaces exist.
- Roles can be changed inside a group: promote to leader, remove from group. The current leader can only hand over through takeover, never be demoted directly.
- The group entry in the conversation header shows every group this conversation belongs to, its role in each, the group's members, and can create a group on the spot.
- Rename the current conversation from the group entry; group pages and member lists update immediately.
- One conversation can join several groups with independent roles. Example: member of the product group and leader of the quality group at the same time.
- When joining a group you can pick member or leader; taking over an existing leader requires confirmation, and the previous leader becomes a member.
- Group messages support **broadcast** (everyone) and **private** (one member); both are delivered to the target conversation as `steer` interjections.
- The message console sends as the **user** by default, instead of borrowing an internal agent identity; leader and member viewpoints are available under "view as" for inspecting the queue.
- A member who received a message must reply before sending new messages; replies to agent messages are interjected back to the sender, replies to the user are recorded in the user's console queue.
- The message queue records sender, audience, content, send time, per-member delivery state and replies.
- Leaders can read all broadcasts and private messages in their group; ordinary members only see messages they sent or received.
- User messages have no session ID; member replies are recorded in the user console queue for the user to read.
- Messages cannot cross groups, and private recipients must be members of the same group.
- Group and message data live under the current DSH profile and survive restarts.
- **Archived members** appear at the bottom of the Manage tab; the leader restores them with `multi_agent_member op="-g"` and an unfinished task. A done task shows its **module brief** (what the module does, key files, how to use it). Completed tasks with a module brief are permanent records and cannot be deleted.
- **Activity** tab: the standard fs tools (`read`/`write`/`edit`) record their `read`/`write` lock automatically before they run. Many `read` locks are allowed, `write` is exclusive, conflicting calls are denied. Locks are released as soon as the fs call finishes, and expire after 3 idle read / 15 idle write minutes as a fallback. The tab shows all records by default; every record has a short numeric ID, and clicking a write record expands the exact added/removed lines.
- **Usage** tab: shows the group total and each member's accumulated token usage, sorted from highest to lowest with a share rounded to 1%; can be refreshed manually.

## AI onboarding skill

The plugin registers a runtime skill **multi-agent-guide** so any agent that installs this plugin learns how to use groups, member sessions and the task board:

- Skill content: `lib/guide.md`, covering leader/member permissions, the merged tools (operations selected with `op`), recommended workflows, common error codes, settings and the HTTP API.
- Automatic reference: the plugin also registers a system prompt section that tells agents to load the skill before calling any `multi_agent_*` tool; even without loading it, the skill catalog shows its purpose and trigger.
- Manual trigger: ask the agent to "load the multi-agent-guide skill"; no extra setup is needed after installation.
- Updating: edit `lib/guide.md` and restart DSH so every agent sees the new version.

## Roles and permissions

| Rule | Details |
| --- | --- |
| Independent roles | One conversation can hold different roles in different groups |
| Unique leader | Every group has exactly one leader, never zero |
| Unlimited members | A group can have many members |
| Leader takeover | After confirming takeover, the previous leader becomes a member; the current leader cannot be demoted directly |
| View members | Every conversation can view groups and member lists |
| Manage members | Change roles or remove members from the Agent Groups page or the group dialog |
| Message sender | The console sends broadcasts/private messages as the user by default; switch to the leader or member viewpoint to inspect |
| Message queue | Leaders read all broadcasts and private messages; members only read messages related to themselves |
| Reply required | Members who received a message must reply before sending new messages |
| Reply to user | User messages have no session ID; member replies appear in the user console queue |

## Usage

1. Open **Agent Groups** in the left sidebar and click **New group**.
2. Fill in name, description and color; the new group appears as a card in the list.
3. Open any conversation and click the group entry in the header.
4. Pick a group and join as **member** or **leader**. If a leader exists you can confirm takeover; you can also create a new group here.
5. Reopen the entry to see all groups of the current conversation, your roles and members; you can also leave a group.
6. Open a group's **Manage** tab to scan workspace sessions and add members, or change and remove existing members.
7. Use **Messages** (in the group detail or in the conversation entry) to send a broadcast or private message; it is delivered as an interjection.
8. A member who received a message replies from the queue; sending new messages is blocked until the reply is done.
9. Use the pencil icon next to the conversation title to rename the current conversation.

## Installation

Install this directory through the DSH plugin manager. A local link install in a profile looks like this:

```json
{
  "dependencies": {
    "dsh-multi-agent": "link:/path/to/dsh-multi-agent"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-multi-agent"]
    }
  }
}
```

The bundled `cordis.patch.yml` inserts the host plugin:

```yaml
- insert:
    - id: multi-agent
      name: dsh-multi-agent
```

HMR applies bundle installs immediately; if a manually edited profile was not picked up, restart the DSH desktop app.

## Agent tools

The plugin exposes group and message capabilities as agent tools. Whether a tool appears in an agent's tool list is decided live by its current group role and pending replies; permissions are checked again at execution time even if visibility is bypassed.

| Tool | Who can use it | Purpose |
| --- | --- | --- |
| `multi_agent_groups` | All agents | `op`: `-l` list (default) / `-m` members / `-c` candidate sessions. Shows your session ID, groups, roles, leader and members |
| `multi_agent_group` | All agents (management operations require leader) | `op`: `-n` create (`name` required) / `-j` join (leader role with an existing leader needs `takeover`) / `-x` leave (omit `groupId` for all) / `-u` update / `-d` delete / `-a` add member (`sessionId`) / `-r` remove member (`sessionId`) / `-s` set role (`sessionId` + `role`) / `-t` candidates. Single entry point for the group lifecycle |
| `multi_agent_create_member` | Leader only | Creates a fresh member agent in the leader's current workspace (a DSH subagent when available, else a plain session); must bind one unassigned task (`taskId`); inherits model/reasoning by default, mirrors full access when the leader has it, no history; limited by the max session count |
| `multi_agent_task` | Group members (writes require leader; status requires assignee or leader; done needs a module brief `completionNote`) | `op`: `-l` list / `-c` create (`title` required; `status` optional, default `todo`; `done` needs the module brief `completionNote`) / `-u` update and assign (`taskId`; `completionNote`; empty `assigneeSessionId` clears) / `-d` delete (`taskId`; blocked with `TASK_LOCKED` once done with a note) / `-s` set status (`taskId` + `status` + `completionNote` for done) / `-x` connect (`from`, `to`) / `-r` delete edge (`edgeId`). Task space with assignees and a DAG of edges |
| `multi_agent_activity` | Group members | `op`: `-l` list only (`query` supports `-a`, `-s name`, `-m memberId`, trailing number for recent N). File locks are created and refreshed automatically by the fs tools |
| `multi_agent_member` | Group members (handover/restore are leader-only; archive is self-only) | `op`: `-h` hand over a member (`sessionId`, leader) / `-z` archive yourself (members only; all claimed tasks must be done with notes or handed over) / `-g` restore an archived member with an unfinished task (`sessionId` + `taskId`, leader). Archived conversations are parked in DSH and shown as an archived list |
| `multi_agent_message` | Group members | `op`: `-l` queue / `-s` send (`content` required; broadcast or private) / `-r` reply (`content` required; `messageId` optional when one reply is pending). Delivered as non-blocking DSH agent notifications |

**Quick recipes**

- Broadcast: `multi_agent_message({ "op": "-s", "content": "..." })`. Omit `groupId` when you belong to exactly one group.
- Private: first get the full session ID with `multi_agent_groups({ "op": "-m" })`, then `multi_agent_message({ "op": "-s", "mode": "private", "recipientSessionId": "session-...", "content": "..." })`.
- Reply: `multi_agent_message({ "op": "-r", "content": "..." })`. Omit `messageId` when exactly one message awaits a reply.
- Your full session ID: the first line of `multi_agent_groups`.
- Tasks and status: `multi_agent_task({ "op": "-l" })` to list; leaders use `op="-c"` to create (e.g. `{ "op": "-c", "title": "Build parser", "status": "todo" }`), `op="-u"` to assign (a leader may assign to itself), `op="-x"` to connect; assignees use `op="-s"` to update status, and `"status": "done"` requires `"completionNote": "..."` (the module brief: what it does, entry points, how to use it). A done task with a brief cannot be deleted.
- File locks: `multi_agent_activity({ "op": "-l" })` lists active locks with short numeric IDs; `read`/`write`/`edit` tool calls create and enforce the locks automatically (read shared, write exclusive, released when the call finishes, with 3/15-minute idle fallbacks). Writes capture a line diff; `multi_agent_activity({ "op": "-d", "id": "<activity id>" })` returns the added/removed lines with line numbers, and the Activity tab expands it on click.
- Member history: `multi_agent_activity({ "op": "-l", "query": "-m session-xxx 5" })` returns that member's five most recent records.

Broadcast and private messages never cross groups, and private recipients must be members of the same group.

## HTTP API

The plugin serves a same-origin JSON API:

- `GET /multi-agent/api/state` — read groups and memberships
- `POST /multi-agent/api/action` — apply changes, requires the `x-dsh-multi-agent: 1` header
- `GET /multi-agent/api/messages?groupId=&sessionId=` — read the queue visible to a given identity

Supported actions: `createGroup`, `updateGroup`, `deleteGroup`, `assign`, `leave`, `sendMessage`, `replyMessage`, `markDelivered`.

State file: `<profile>/.dsh-multi-agent/state.json`, schema version 2, with migration for the first single-group layout. Group messages are kept in an internal `messages` array that is not exposed by `/state`.

## Development

No build step. The browser side is a single-file lazy-CJS bundle that only depends on the host-provided React / ReactDOM.

```powershell
# host API unit tests
node test-multi-agent-host.mjs

# client SSR / rendering tests (requires react, react-dom)
node test-multi-agent-client.mjs
```

Test scripts live in the workspace root and are not shipped with the plugin package.
