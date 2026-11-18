/**
 * dsh-multi-agent — host half.
 *
 * Owns the durable group catalog and the per-conversation membership records.
 * The browser talks to this file through a small same-origin JSON API mounted
 * under /multi-agent/api. Keeping the host half dependency-free means the
 * plugin can be installed with `dsh plugin add` without a build step.
 *
 * State v2 allows one conversation to belong to several groups. Memberships
 * are stored as records keyed by (groupId, sessionId), so joining group B
 * never disturbs a conversation's role in group A.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-multi-agent'

const API_PREFIX = '/multi-agent/api'
const DATA_DIR_NAME = '.dsh-multi-agent'
const DATA_FILE_NAME = 'state.json'
const MAX_BODY_BYTES = 256 * 1024
const MAX_GROUPS = 40
const MAX_MEMBERSHIPS = 4000
const MAX_MESSAGES = 2000
const MAX_NAME = 40
const MAX_DESCRIPTION = 240
const MAX_MESSAGE = 4000
const MAX_TASKS = 200
const MAX_TASK_TITLE = 80
const MAX_TASK_DESCRIPTION = 600
const MAX_TASK_NOTE = 600
const MAX_TASK_EDGES = 800
const MAX_TASK_COORD = 20000
const TASK_STATUSES = ['todo', 'doing', 'done']
const DEFAULT_MAX_SESSIONS = 8
const MIN_MAX_SESSIONS = 2
const MAX_MAX_SESSIONS = 32

const ROLE_LEADER = 'leader'
const ROLE_MEMBER = 'member'
const USER_VIEWER_ID = '__user__'
const USER_SENDER_NAME = 'User'

// Onboarding skill: every agent that can see the multi_agent_* tools should be
// able to load the full operating guide without the user pasting it. The body
// lives next to this module so it can be edited without touching code.
const GUIDE_SKILL_NAME = 'multi-agent-guide'
const GUIDE_PROMPT = 'This conversation exposes multi-agent group, task board, activity list and token usage tools (multi_agent_*). Before calling any multi_agent_* tool, creating groups or member sessions, editing tasks, checking file locks or sending group messages, load the multi-agent-guide skill with the skill tool and follow its role, permission and parameter rules; when unsure about your group or role, call multi_agent_groups first.'
let GUIDE_SKILL_CONTENT = ''
try {
  GUIDE_SKILL_CONTENT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'guide.md'), 'utf8')
} catch (error) {
  console.warn('[dsh-multi-agent] Failed to read guide skill content:', error)
}

// Diagnostics for the agent-facing surface. Kept tiny and only exposed through
// the same-origin local API; it makes an empty tool palette debuggable without
// attaching to the Electron process.
let toolRegistration = { state: 'idle', names: [], error: null }

class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

function isoNow() {
  return new Date().toISOString()
}

function emptyState() {
  return {
    version: 2,
    groups: [],
    memberships: [],
    messages: [],
    tasks: [],
    taskEdges: [],
    activities: [],
    updatedAt: isoNow(),
  }
}

function profileDirOf(ctx) {
  const profileContext = ctx.get?.('profileContext')
  if (profileContext && typeof profileContext.dir === 'string' && profileContext.dir.length > 0) {
    return profileContext.dir
  }
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const profile = process.env.DSH_PROFILE || 'desktop'
  return join(home, 'profiles', profile)
}

function statePathOf(profileDir) {
  return join(profileDir, DATA_DIR_NAME, DATA_FILE_NAME)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cleanText(value, max, field, required = false) {
  if (typeof value !== 'string') {
    if (required) throw new ApiError(400, 'INVALID_INPUT', `${field} must be a string`)
    return ''
  }
  const text = value.trim()
  if (required && text.length === 0) {
    throw new ApiError(400, 'INVALID_INPUT', `${field} must not be empty`)
  }
  if (text.length > max) {
    throw new ApiError(400, 'INVALID_INPUT', `${field} must not exceed ${max} characters`)
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new ApiError(400, 'INVALID_INPUT', `${field} contains invisible control characters`)
  }
  return text
}

function cleanMaxSessions(value) {
  const numeric = Number(value)
  if (!Number.isInteger(numeric) || numeric < MIN_MAX_SESSIONS || numeric > MAX_MAX_SESSIONS) {
    throw new ApiError(
      400,
      'INVALID_MAX_SESSIONS',
      `Max sessions must be an integer from ${MIN_MAX_SESSIONS} to ${MAX_MAX_SESSIONS}`,
    )
  }
  return numeric
}

function readMaxSessions(raw) {
  const numeric = Number(raw)
  return Number.isInteger(numeric) && numeric >= MIN_MAX_SESSIONS && numeric <= MAX_MAX_SESSIONS
    ? numeric
    : DEFAULT_MAX_SESSIONS
}

function cleanColor(value) {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new ApiError(400, 'INVALID_INPUT', 'Invalid group color format')
  }
  return value.toLowerCase()
}

const MAX_SPAWN_TITLE = 24

/**
 * Normalize the durable "new member session" inheritance setting of a group.
 * Missing or malformed values fall back to the safe default: follow the leader.
 * @param raw Stored spawn value from state.json.
 * @returns `{ mode: 'inherit' }` or a complete custom selection.
 */
function normalizeSpawn(raw) {
  if (!isPlainObject(raw) || raw.mode !== 'custom') return { mode: 'inherit' }
  const provider = typeof raw.provider === 'string' ? raw.provider.trim().slice(0, 120) : ''
  const model = typeof raw.model === 'string' ? raw.model.trim().slice(0, 200) : ''
  if (!provider || !model) return { mode: 'inherit' }
  const reasoningEffort = typeof raw.reasoningEffort === 'string' && raw.reasoningEffort.trim()
    ? raw.reasoningEffort.trim().slice(0, 80)
    : null
  return { mode: 'custom', provider, model, reasoningEffort }
}

/**
 * Validate a client-supplied spawn setting. Unlike `normalizeSpawn` this is
 * strict: an explicit save either becomes a complete custom selection or the
 * explicit inherit default.
 * @param value Request body value.
 * @returns Normalized spawn setting.
 */
function cleanSpawnInput(value) {
  if (!isPlainObject(value)) throw new ApiError(400, 'INVALID_INPUT', 'Invalid inheritance config format')
  if (value.mode === 'inherit') return { mode: 'inherit' }
  if (value.mode !== 'custom') {
    throw new ApiError(400, 'INVALID_INPUT', 'Inheritance mode must be inherit or custom')
  }
  const provider = cleanText(value.provider, 120, 'Model provider', true)
  const model = cleanText(value.model, 200, 'Model', true)
  const reasoningEffort = value.reasoningEffort === undefined || value.reasoningEffort === null
    ? null
    : cleanText(value.reasoningEffort, 80, 'Reasoning effort') || null
  return { mode: 'custom', provider, model, reasoningEffort }
}

function cleanGroupId(value) {
  if (typeof value !== 'string' || !/^grp_[A-Za-z0-9-]{4,64}$/.test(value)) {
    throw new ApiError(400, 'INVALID_GROUP', 'Group does not exist or is no longer valid')
  }
  return value
}

function isSafeSessionId(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    value !== '__proto__' &&
    value !== 'constructor' &&
    value !== 'prototype'
  )
}

function cleanSessionId(value) {
  if (!isSafeSessionId(value)) throw new ApiError(400, 'INVALID_SESSION', 'Invalid conversation ID')
  return value
}

function cleanRole(value) {
  if (value === ROLE_LEADER || value === ROLE_MEMBER) return value
  throw new ApiError(400, 'INVALID_ROLE', 'Role must be leader or member')
}

function cleanMessageId(value) {
  if (typeof value !== 'string' || !/^msg_[A-Za-z0-9-]{4,64}$/.test(value)) {
    throw new ApiError(400, 'INVALID_MESSAGE', 'Message does not exist or is no longer valid')
  }
  return value
}

function safeIso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : isoNow()
}

function normalizeMessages(rawMessages, groupIds) {
  const messages = []
  const seen = new Set()
  if (!Array.isArray(rawMessages)) return messages
  for (const candidate of rawMessages) {
    if (!isPlainObject(candidate)) continue
    const id = typeof candidate.id === 'string' ? candidate.id : ''
    const groupId = typeof candidate.groupId === 'string' ? candidate.groupId : ''
    const senderKind = candidate.senderKind === 'user' ? 'user' : 'agent'
    const senderSessionId = senderKind === 'user'
      ? null
      : (typeof candidate.senderSessionId === 'string' ? candidate.senderSessionId : '')
    const mode = candidate.mode === 'private' ? 'private' : candidate.mode === 'broadcast' ? 'broadcast' : ''
    if (!/^msg_[A-Za-z0-9-]{4,64}$/.test(id) || seen.has(id)) continue
    if (!groupIds.has(groupId) || !mode) continue
    if (senderKind === 'agent' && !isSafeSessionId(senderSessionId)) continue
    if (typeof candidate.content !== 'string') continue
    const content = candidate.content.trim()
    if (content.length === 0 || content.length > MAX_MESSAGE) continue
    const recipientSessionId = mode === 'private' && isSafeSessionId(candidate.recipientSessionId)
      ? candidate.recipientSessionId
      : null
    if (mode === 'private' && recipientSessionId === null) continue

    const deliveries = []
    const seenRecipients = new Set()
    if (Array.isArray(candidate.deliveries)) {
      for (const delivery of candidate.deliveries) {
        if (!isPlainObject(delivery)) continue
        if (!isSafeSessionId(delivery.sessionId) || seenRecipients.has(delivery.sessionId)) continue
        if (deliveries.length >= 200) break
        const status = delivery.status === 'sent' || delivery.status === 'failed' ? delivery.status : 'pending'
        let reply = null
        if (isPlainObject(delivery.reply) && typeof delivery.reply.content === 'string') {
          const replyContent = delivery.reply.content.trim()
          if (replyContent.length > 0 && replyContent.length <= MAX_MESSAGE) {
            reply = {
              content: replyContent,
              createdAt: safeIso(delivery.reply.createdAt),
              status: delivery.reply.status === 'sent' || delivery.reply.status === 'failed'
                ? delivery.reply.status
                : 'pending',
              deliveredAt: typeof delivery.reply.deliveredAt === 'string' ? delivery.reply.deliveredAt : null,
              error: typeof delivery.reply.error === 'string' ? delivery.reply.error.slice(0, 300) : null,
            }
          }
        }
        deliveries.push({
          sessionId: delivery.sessionId,
          status,
          deliveredAt: typeof delivery.deliveredAt === 'string' ? delivery.deliveredAt : null,
          error: typeof delivery.error === 'string' ? delivery.error.slice(0, 300) : null,
          reply,
        })
        seenRecipients.add(delivery.sessionId)
      }
    }

    messages.push({
      id,
      groupId,
      senderKind,
      senderSessionId,
      senderName: senderKind === 'user'
        ? (typeof candidate.senderName === 'string' && candidate.senderName.trim()
          ? candidate.senderName.trim().slice(0, 40)
          : USER_SENDER_NAME)
        : null,
      mode,
      recipientSessionId,
      content,
      createdAt: safeIso(candidate.createdAt),
      deliveries,
    })
    seen.add(id)
  }
  return messages.slice(-MAX_MESSAGES)
}

function clampTaskCoord(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(MAX_TASK_COORD, Math.max(0, Math.round(number)))
}

function normalizeTasks(rawTasks, groupIds, groupMembers) {
  const tasks = []
  const seen = new Set()
  if (!Array.isArray(rawTasks)) return tasks
  for (const candidate of rawTasks) {
    if (!isPlainObject(candidate)) continue
    const id = typeof candidate.id === 'string' ? candidate.id : ''
    if (!/^task_[A-Za-z0-9-]{4,64}$/.test(id) || seen.has(id)) continue
    const groupId = typeof candidate.groupId === 'string' ? candidate.groupId : ''
    if (!groupIds.has(groupId)) continue
    const members = groupMembers.get(groupId) || new Set()
    const assigneeSessionId = typeof candidate.assigneeSessionId === 'string'
      && members.has(candidate.assigneeSessionId)
      ? candidate.assigneeSessionId
      : null
    const title = typeof candidate.title === 'string' ? candidate.title.trim() : ''
    if (title.length === 0 || title.length > MAX_TASK_TITLE) continue
    const status = TASK_STATUSES.includes(candidate.status) ? candidate.status : 'todo'
    const createdAt = typeof candidate.createdAt === 'string' ? candidate.createdAt : isoNow()
    const completionNote = typeof candidate.completionNote === 'string'
      ? candidate.completionNote.slice(0, MAX_TASK_NOTE)
      : ''
    tasks.push({
      id,
      groupId,
      assigneeSessionId,
      title,
      description: typeof candidate.description === 'string'
        ? candidate.description.slice(0, MAX_TASK_DESCRIPTION)
        : '',
      status,
      completionNote,
      completedAt: typeof candidate.completedAt === 'string' ? candidate.completedAt : '',
      handedOverAt: typeof candidate.handedOverAt === 'string' ? candidate.handedOverAt : '',
      handedOverBy: typeof candidate.handedOverBy === 'string' ? candidate.handedOverBy : '',
      x: clampTaskCoord(candidate.x, 80),
      y: clampTaskCoord(candidate.y, 80),
      createdAt,
      updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : createdAt,
    })
    seen.add(id)
    if (tasks.length >= MAX_TASKS) break
  }
  return tasks
}

function normalizeTaskEdges(rawEdges, tasks) {
  const groupOf = new Map(tasks.map((task) => [task.id, task.groupId]))
  const edges = []
  const seen = new Set()
  if (!Array.isArray(rawEdges)) return edges
  for (const candidate of rawEdges) {
    if (!isPlainObject(candidate)) continue
    const id = typeof candidate.id === 'string' ? candidate.id : ''
    const from = typeof candidate.from === 'string' ? candidate.from : ''
    const to = typeof candidate.to === 'string' ? candidate.to : ''
    if (!/^edge_[A-Za-z0-9-]{4,64}$/.test(id) || seen.has(id)) continue
    const groupId = groupOf.get(from)
    if (!groupId || groupOf.get(to) !== groupId || from === to) continue
    const pair = `${from}\u0000${to}`
    if (seen.has(pair)) continue
    edges.push({
      id,
      groupId,
      from,
      to,
      createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : isoNow(),
    })
    seen.add(id)
    seen.add(pair)
    if (edges.length >= MAX_TASK_EDGES) break
  }
  return edges
}

function cleanTaskId(value) {
  if (typeof value !== 'string' || !/^task_[A-Za-z0-9-]{4,64}$/.test(value)) {
    throw new ApiError(400, 'INVALID_TASK', 'Task does not exist or is no longer valid')
  }
  return value
}

function cleanTaskEdgeId(value) {
  if (typeof value !== 'string' || !/^edge_[A-Za-z0-9-]{4,64}$/.test(value)) {
    throw new ApiError(400, 'INVALID_TASK_EDGE', 'Edge does not exist or is no longer valid')
  }
  return value
}

function normalizeState(raw) {
  if (!isPlainObject(raw)) return emptyState()
  let groups = []
  const seenIds = new Set()
  const seenNames = new Set()
  if (Array.isArray(raw.groups)) {
    for (const candidate of raw.groups) {
      if (!isPlainObject(candidate)) continue
      const id = typeof candidate.id === 'string' ? candidate.id : ''
      const groupName = typeof candidate.name === 'string' ? candidate.name.trim() : ''
      if (!/^grp_[A-Za-z0-9-]{4,64}$/.test(id) || seenIds.has(id)) continue
      if (groupName.length === 0 || groupName.length > MAX_NAME) continue
      const folded = groupName.toLowerCase()
      if (seenNames.has(folded)) continue
      const description = typeof candidate.description === 'string' ? candidate.description.slice(0, MAX_DESCRIPTION) : ''
      const color = typeof candidate.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(candidate.color)
        ? candidate.color.toLowerCase()
        : '#5b6cf9'
      const createdAt = typeof candidate.createdAt === 'string' ? candidate.createdAt : isoNow()
      const updatedAt = typeof candidate.updatedAt === 'string' ? candidate.updatedAt : createdAt
      groups.push({
        id,
        name: groupName,
        description,
        color,
        spawn: normalizeSpawn(candidate.spawn),
        maxSessions: readMaxSessions(candidate.maxSessions),
        createdAt,
        updatedAt,
      })
      seenIds.add(id)
      seenNames.add(folded)
    }
  }

  const memberships = []
  const seenPairs = new Set()
  const addMembership = (groupId, sessionId, role, joinedAt, updatedAt, extra = {}) => {
    if (!seenIds.has(groupId) || !isSafeSessionId(sessionId)) return
    if (role !== ROLE_LEADER && role !== ROLE_MEMBER) return
    if (memberships.length >= MAX_MEMBERSHIPS) return
    const pair = `${groupId}\u0000${sessionId}`
    if (seenPairs.has(pair)) return
    seenPairs.add(pair)
    memberships.push({
      groupId,
      sessionId,
      role,
      archivedAt: typeof extra.archivedAt === 'string' ? extra.archivedAt : '',
      handoverAt: typeof extra.handoverAt === 'string' ? extra.handoverAt : '',
      handoverBy: typeof extra.handoverBy === 'string' ? extra.handoverBy : '',
      joinedAt: typeof joinedAt === 'string' ? joinedAt : isoNow(),
      updatedAt: typeof updatedAt === 'string' ? updatedAt : isoNow(),
    })
  }

  if (Array.isArray(raw.memberships)) {
    for (const candidate of raw.memberships) {
      if (!isPlainObject(candidate)) continue
      addMembership(
        candidate.groupId,
        candidate.sessionId,
        candidate.role,
        candidate.joinedAt,
        candidate.updatedAt,
        candidate,
      )
    }
  }

  // v1 stored one assignment per session in an object map. Convert it to the
  // v2 records so existing installs keep their group and role.
  if (isPlainObject(raw.assignments)) {
    for (const [sessionId, value] of Object.entries(raw.assignments)) {
      if (!isPlainObject(value)) continue
      addMembership(value.groupId, sessionId, value.role, value.joinedAt, value.updatedAt)
    }
  }

  // One leader per group is an invariant of the role model. Keep the first
  // repaired record and demote later duplicates instead of dropping members.
  // A group that still has members but no leader is repaired by promoting its
  // earliest member. Empty groups are not valid groups: they are dropped.
  for (const group of groups) {
    const members = memberships
      .filter((membership) => membership.groupId === group.id)
      .sort((left, right) => String(left.joinedAt).localeCompare(String(right.joinedAt)))
    const leaders = members.filter((membership) => membership.role === ROLE_LEADER)
    for (const extra of leaders.slice(1)) {
      extra.role = ROLE_MEMBER
      extra.updatedAt = isoNow()
    }
    if (leaders.length === 0 && members.length > 0) {
      members[0].role = ROLE_LEADER
      members[0].updatedAt = isoNow()
    }
  }
  const memberGroupIds = new Set(memberships.map((membership) => membership.groupId))
  groups = groups.filter((group) => memberGroupIds.has(group.id))
  const liveGroupIds = new Set(groups.map((group) => group.id))
  const groupMembers = new Map()
  for (const membership of memberships) {
    if (!groupMembers.has(membership.groupId)) groupMembers.set(membership.groupId, new Set())
    groupMembers.get(membership.groupId).add(membership.sessionId)
  }
  const tasks = normalizeTasks(raw.tasks, liveGroupIds, groupMembers)
  const taskEdges = normalizeTaskEdges(raw.taskEdges, tasks)
  const activities = normalizeActivities(raw.activities, liveGroupIds, groupMembers)

  return {
    version: 2,
    groups,
    memberships,
    messages: normalizeMessages(raw.messages, liveGroupIds),
    tasks,
    taskEdges,
    activities,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : isoNow(),
  }
}

async function readState(file) {
  try {
    const text = await readFile(file, 'utf8')
    return normalizeState(JSON.parse(text))
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyState()
    console.warn(`[dsh-multi-agent] Failed to read ${file}; falling back to an empty group:${error?.message ?? error}`)
    return emptyState()
  }
}

async function writeState(file, state) {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  const body = `${JSON.stringify(state, null, 2)}\n`
  await writeFile(temp, body, { encoding: 'utf8', mode: 0o600 })
  try {
    await rename(temp, file)
  } catch {
    // Windows cannot always replace an existing file with rename(). The file
    // is small and this path is already serialized by the mutation queue.
    await unlink(file).catch(() => {})
    await rename(temp, file)
  }
}

function writeStateSync(file, state) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  const body = `${JSON.stringify(state, null, 2)}\n`
  writeFileSync(temp, body, { encoding: 'utf8', mode: 0o600 })
  try {
    renameSync(temp, file)
  } catch {
    try {
      unlinkSync(file)
    } catch {
      // missing file is fine
    }
    renameSync(temp, file)
  }
}

function publicState(state) {
  return {
    version: state.version,
    groups: state.groups,
    memberships: state.memberships,
    tasks: state.tasks,
    taskEdges: state.taskEdges,
    activities: state.activities,
    updatedAt: state.updatedAt,
  }
}

function findMembership(state, groupId, sessionId) {
  return state.memberships.find(
    (membership) => membership.groupId === groupId && membership.sessionId === sessionId,
  )
}

function leaderOf(state, groupId) {
  const leader = state.memberships.find(
    (membership) => membership.groupId === groupId && membership.role === ROLE_LEADER,
  )
  return leader?.sessionId ?? null
}

function requireGroup(state, groupId) {
  const group = state.groups.find((candidate) => candidate.id === groupId)
  if (!group) throw new ApiError(404, 'GROUP_NOT_FOUND', 'Group not found')
  return group
}

function resolveGroupId(state, agentId, groupId, role = null) {
  const memberships = state.memberships.filter(
    (membership) => membership.sessionId === agentId && (!role || membership.role === role),
  )
  if (groupId) {
    const membership = memberships.find((candidate) => candidate.groupId === groupId)
    if (!membership) throw new ApiError(403, 'NOT_IN_GROUP', 'You are not in this group')
    return groupId
  }
  if (memberships.length === 1) return memberships[0].groupId
  if (memberships.length === 0) {
    throw new ApiError(403, 'NOT_IN_GROUP', role === ROLE_LEADER ? 'You are not leading any group' : 'You have not joined any group yet')
  }
  const options = memberships.map((membership) => {
    const group = state.groups.find((candidate) => candidate.id === membership.groupId)
    return `${group?.name ?? 'Unknown group'} [${membership.groupId}]`
  }).join(', ')
  throw new ApiError(400, 'NEED_GROUP_ID', `You are in multiple groups; specify groupId:${options}`)
}

function ensureUniqueName(state, groupName, exceptId) {
  const folded = groupName.toLowerCase()
  if (state.groups.some((group) => group.id !== exceptId && group.name.toLowerCase() === folded)) {
    throw new ApiError(409, 'NAME_TAKEN', 'A group with this name already exists; pick another name')
  }
}

function actionCreateGroup(state, body) {
  if (state.groups.length >= MAX_GROUPS) {
    throw new ApiError(409, 'GROUP_LIMIT', `You can create at most ${MAX_GROUPS} groups`)
  }
  const groupName = cleanText(body.name, MAX_NAME, 'Group name', true)
  ensureUniqueName(state, groupName)
  if (state.memberships.length >= MAX_MEMBERSHIPS) {
    throw new ApiError(409, 'MEMBERSHIP_LIMIT', 'Too many member records; clean up some groups first')
  }
  if (!body.leaderSessionId) {
    throw new ApiError(400, 'LEADER_REQUIRED', 'Creating a group requires an initial leader')
  }
  const leaderSessionId = cleanSessionId(body.leaderSessionId)
  const group = {
    id: `grp_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    name: groupName,
    description: cleanText(body.description ?? '', MAX_DESCRIPTION, 'Group description'),
    color: cleanColor(body.color ?? '#5b6cf9'),
    spawn: normalizeSpawn(body.spawn),
    maxSessions: cleanMaxSessions(body.maxSessions ?? DEFAULT_MAX_SESSIONS),
    createdAt: isoNow(),
    updatedAt: isoNow(),
  }
  state.groups.push(group)
  state.memberships.push({
    groupId: group.id,
    sessionId: leaderSessionId,
    role: ROLE_LEADER,
    joinedAt: isoNow(),
    updatedAt: isoNow(),
  })
  state.updatedAt = isoNow()
  return group
}

function actionUpdateGroup(state, body) {
  const groupId = cleanGroupId(body.groupId)
  const group = requireGroup(state, groupId)
  if (body.name !== undefined) {
    const groupName = cleanText(body.name, MAX_NAME, 'Group name', true)
    ensureUniqueName(state, groupName, groupId)
    group.name = groupName
  }
  if (body.description !== undefined) {
    group.description = cleanText(body.description, MAX_DESCRIPTION, 'Group description')
  }
  if (body.color !== undefined) group.color = cleanColor(body.color)
  if (body.spawn !== undefined) group.spawn = cleanSpawnInput(body.spawn)
  if (body.maxSessions !== undefined) {
    const next = cleanMaxSessions(body.maxSessions)
    const currentCount = state.memberships.filter((membership) => membership.groupId === groupId).length
    if (next < currentCount) {
      throw new ApiError(
        409,
        'MAX_SESSIONS_TOO_SMALL',
        `This group already has ${currentCount} sessions; max sessions cannot be lower than that`,
      )
    }
    group.maxSessions = next
  }
  group.updatedAt = isoNow()
  state.updatedAt = isoNow()
  return group
}

function cleanAssignee(state, groupId, value) {
  if (value === null || value === undefined || value === '') return null
  const sessionId = cleanSessionId(value)
  const membership = findMembership(state, groupId, sessionId)
  if (!membership) throw new ApiError(400, 'ASSIGNEE_NOT_MEMBER', 'Tasks can only be assigned to members of this group')
  return sessionId
}

function clearOrphanAssignees(state) {
  for (const task of state.tasks) {
    if (task.assigneeSessionId && !findMembership(state, task.groupId, task.assigneeSessionId)) {
      task.assigneeSessionId = null
      task.updatedAt = isoNow()
    }
  }
}

function assertGroupLeader(state, groupId, agentId) {
  if (typeof agentId !== 'string' || agentId.length === 0) return
  const membership = findMembership(state, groupId, agentId)
  if (!membership) throw new ApiError(403, 'NOT_IN_GROUP', 'The current conversation is not in this group')
  if (membership.role !== ROLE_LEADER) {
    throw new ApiError(403, 'NOT_LEADER', 'Only this group leader can edit tasks or edges')
  }
}

function requireTask(state, taskId) {
  const task = state.tasks.find((candidate) => candidate.id === taskId)
  if (!task) throw new ApiError(404, 'TASK_NOT_FOUND', 'Task does not exist or has been deleted')
  return task
}

function cleanTaskStatus(value) {
  return TASK_STATUSES.includes(value) ? value : null
}

function actionCreateTask(state, body) {
  if (state.tasks.length >= MAX_TASKS) {
    throw new ApiError(409, 'TASK_LIMIT', `You can create at most ${MAX_TASKS} tasks`)
  }
  const groupId = cleanGroupId(body.groupId)
  requireGroup(state, groupId)
  assertGroupLeader(state, groupId, body.leaderSessionId)
  const status = cleanTaskStatus(body.status)
  if (!status) throw new ApiError(400, 'INVALID_STATUS', 'Task status must be todo, doing or done')
  const completionNote = cleanText(body.completionNote ?? '', MAX_TASK_NOTE, 'Completion note')
  if (status === 'done' && !completionNote) {
    throw new ApiError(400, 'NOTE_REQUIRED', 'A task created as done needs a completion note (completionNote)')
  }
  const task = {
    id: `task_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    groupId,
    assigneeSessionId: cleanAssignee(state, groupId, body.assigneeSessionId),
    title: cleanText(body.title, MAX_TASK_TITLE, 'Task title', true),
    description: cleanText(body.description ?? '', MAX_TASK_DESCRIPTION, 'Task description'),
    status,
    completionNote,
    completedAt: status === 'done' ? isoNow() : '',
    x: clampTaskCoord(body.x, 80),
    y: clampTaskCoord(body.y, 80),
    createdAt: isoNow(),
    updatedAt: isoNow(),
  }
  state.tasks.push(task)
  state.updatedAt = isoNow()
  return task
}

function actionUpdateTask(state, body) {
  const task = requireTask(state, cleanTaskId(body.taskId))
  assertGroupLeader(state, task.groupId, body.leaderSessionId)
  if (body.title !== undefined) {
    task.title = cleanText(body.title, MAX_TASK_TITLE, 'Task title', true)
  }
  if (body.description !== undefined) {
    task.description = cleanText(body.description, MAX_TASK_DESCRIPTION, 'Task description')
  }
  if (body.status !== undefined) {
    const status = cleanTaskStatus(body.status)
    if (!status) throw new ApiError(400, 'INVALID_STATUS', 'Task status must be todo, doing or done')
    if (status === 'done' && !task.completionNote && cleanText(body.completionNote ?? '', MAX_TASK_NOTE, 'Completion note') === '') {
      throw new ApiError(400, 'NOTE_REQUIRED', 'A task marked done needs a completion note (completionNote)')
    }
    if (status === 'done' && task.status !== 'done') task.completedAt = isoNow()
    if (status !== 'done') task.completedAt = ''
    task.status = status
  }
  if (body.completionNote !== undefined) {
    task.completionNote = cleanText(body.completionNote ?? '', MAX_TASK_NOTE, 'Completion note')
  }
  if (body.assigneeSessionId !== undefined) {
    task.assigneeSessionId = cleanAssignee(state, task.groupId, body.assigneeSessionId)
  }
  if (body.x !== undefined) task.x = clampTaskCoord(body.x, task.x)
  if (body.y !== undefined) task.y = clampTaskCoord(body.y, task.y)
  task.updatedAt = isoNow()
  state.updatedAt = isoNow()
  return task
}

function actionSetTaskStatus(state, body) {
  const task = requireTask(state, cleanTaskId(body.taskId))
  const status = cleanTaskStatus(body.status)
  if (!status) throw new ApiError(400, 'INVALID_STATUS', 'Task status must be todo, doing or done')
  const actorId = typeof body.actorSessionId === 'string' ? body.actorSessionId : ''
  if (actorId) {
    const membership = findMembership(state, task.groupId, actorId)
    if (!membership) throw new ApiError(403, 'NOT_IN_GROUP', 'The current conversation is not in this group')
    const isLeader = membership.role === ROLE_LEADER
    const isAssignee = task.assigneeSessionId === actorId
    if (!isLeader && !isAssignee) {
      throw new ApiError(403, 'NOT_ASSIGNEE', 'Only the assignee or the leader can change task status')
    }
  }
  if (body.completionNote !== undefined) {
    task.completionNote = cleanText(body.completionNote ?? '', MAX_TASK_NOTE, 'Completion note')
  }
  if (status === 'done' && !task.completionNote) {
    throw new ApiError(400, 'NOTE_REQUIRED', 'A task marked done needs a completion note (completionNote)')
  }
  if (status === 'done' && task.status !== 'done') task.completedAt = isoNow()
  if (status !== 'done') task.completedAt = ''
  task.status = status
  task.updatedAt = isoNow()
  state.updatedAt = isoNow()
  return task
}

function actionDeleteTask(state, body) {
  const taskId = cleanTaskId(body.taskId)
  const task = requireTask(state, taskId)
  assertGroupLeader(state, task.groupId, body.leaderSessionId)
  if (task.status === 'done' && task.completionNote) {
    throw new ApiError(409, 'TASK_LOCKED', 'Completed tasks with a completion note are kept as records and cannot be deleted')
  }
  state.tasks = state.tasks.filter((candidate) => candidate.id !== taskId)
  state.taskEdges = state.taskEdges.filter((edge) => edge.from !== taskId && edge.to !== taskId)
  state.updatedAt = isoNow()
  return { id: task.id }
}

function taskPathExists(state, start, goal) {
  const next = new Map()
  for (const edge of state.taskEdges) {
    if (!next.has(edge.from)) next.set(edge.from, [])
    next.get(edge.from).push(edge.to)
  }
  const seen = new Set([start])
  const stack = [start]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const target of next.get(current) || []) {
      if (target === goal) return true
      if (seen.has(target)) continue
      seen.add(target)
      stack.push(target)
    }
  }
  return false
}

function actionCreateTaskEdge(state, body) {
  const from = cleanTaskId(body.from)
  const to = cleanTaskId(body.to)
  const fromTask = requireTask(state, from)
  const toTask = requireTask(state, to)
  if (fromTask.groupId !== toTask.groupId) {
    throw new ApiError(400, 'TASK_GROUP_MISMATCH', 'The two task cards belong to different groups and cannot be linked')
  }
  assertGroupLeader(state, fromTask.groupId, body.leaderSessionId)
  if (from === to) throw new ApiError(400, 'TASK_SELF_LOOP', 'A task cannot be linked to itself')
  if (state.taskEdges.some((edge) => edge.from === from && edge.to === to)) {
    throw new ApiError(409, 'TASK_EDGE_EXISTS', 'An edge already exists between these two tasks')
  }
  if (state.taskEdges.length >= MAX_TASK_EDGES) {
    throw new ApiError(409, 'TASK_EDGE_LIMIT', `You can create at most ${MAX_TASK_EDGES} edges`)
  }
  if (taskPathExists(state, to, from)) {
    throw new ApiError(409, 'TASK_CYCLE', 'This edge would create a cycle; the task flow must be a directed acyclic graph')
  }
  const edge = {
    id: `edge_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    groupId: fromTask.groupId,
    from,
    to,
    createdAt: isoNow(),
  }
  state.taskEdges.push(edge)
  state.updatedAt = isoNow()
  return edge
}

function actionDeleteTaskEdge(state, body) {
  const edgeId = cleanTaskEdgeId(body.edgeId)
  const edge = state.taskEdges.find((candidate) => candidate.id === edgeId)
  if (!edge) throw new ApiError(404, 'TASK_EDGE_NOT_FOUND', 'Edge does not exist or has been deleted')
  assertGroupLeader(state, edge.groupId, body.leaderSessionId)
  state.taskEdges = state.taskEdges.filter((candidate) => candidate.id !== edgeId)
  state.updatedAt = isoNow()
  return { id: edge.id }
}

// ---- Activity list: workspace file usage shared within a group ----
// Every file that a member opens can be registered here, so the leader (and
// the other members) see who is using which file instead of guessing from the
// filesystem. Members and the leader can create entries; only the creator or
// the leader can change or delete one. A file already marked `using` by
// somebody else is reported as a conflict instead of silently double-booked.

const MAX_ACTIVITIES = 500
const MAX_ACTIVITY_PATH = 512
const MAX_ACTIVITY_NOTE = 240
const MAX_ACTIVITY_DESTINATION = 512
const ACTIVITY_STATES = ['read', 'write']
const ACTIVITY_OPS = ['open', 'move', 'copy']
const ACTIVITY_STATE_LABELS = { read: 'read-only', write: 'read/write' }
const LEGACY_ACTIVITY_STATES = { using: 'write', viewing: 'read', modified: 'read' }
const ACTIVITY_OP_LABELS = { open: 'open', move: 'move', copy: 'copy' }

const FILE_LOCK_STATES = ['read', 'write']
const ACTIVITY_READ_TTL_MS = 3 * 60 * 1000
const ACTIVITY_WRITE_TTL_MS = 15 * 60 * 1000

// Compact 64-bit activity IDs. Layout (most significant first):
//   7 bits year (2000-2127), 4 bits month (1-12), 5 bits day (1-31),
//   5 bits hour (0-23), 6 bits minute (0-59), 6 bits second (0-59),
//   31 bits per-second counter. The decimal string is the ID, so the
//   creation time can always be derived with compactIdTimeOf().
const COMPACT_ID_YEAR_BASE = 2000
const COMPACT_ID_COUNTER_MASK = (1n << 31n) - 1n
let compactIdCounter = BigInt(Math.floor(Math.random() * 0x7fffffff))

function compactIdOf(date = new Date()) {
  compactIdCounter = (compactIdCounter + 1n) & COMPACT_ID_COUNTER_MASK
  let value = BigInt((date.getFullYear() - COMPACT_ID_YEAR_BASE) & 0x7f)
  value = (value << 4n) | BigInt((date.getMonth() + 1) & 0x0f)
  value = (value << 5n) | BigInt(date.getDate() & 0x1f)
  value = (value << 5n) | BigInt(date.getHours() & 0x1f)
  value = (value << 6n) | BigInt(date.getMinutes() & 0x3f)
  value = (value << 6n) | BigInt(date.getSeconds() & 0x3f)
  value = (value << 31n) | compactIdCounter
  return value.toString()
}

function compactIdTimeOf(id) {
  let value = 0n
  try {
    value = BigInt(String(id))
  } catch {
    return null
  }
  const counter = Number(value & COMPACT_ID_COUNTER_MASK)
  let rest = value >> 31n
  const second = Number(rest & 0x3fn); rest >>= 6n
  const minute = Number(rest & 0x3fn); rest >>= 6n
  const hour = Number(rest & 0x1fn); rest >>= 5n
  const day = Number(rest & 0x1fn); rest >>= 5n
  const month = Number(rest & 0x0fn); rest >>= 4n
  const year = Number(rest & 0x7fn)
  return { year: COMPACT_ID_YEAR_BASE + year, month, day, hour, minute, second, counter }
}

// Write diffs are captured by comparing the file before the fs tool runs with
// the file right after it finishes. Binary or oversized files are skipped.
const MAX_DIFF_BYTES = 512 * 1024
const MAX_DIFF_LINES = 200
const pendingActivityCaptures = new Map()

function readTextIfSmall(filePath) {
  let buffer
  try {
    buffer = readFileSync(filePath)
  } catch {
    return null
  }
  if (!buffer || buffer.length > MAX_DIFF_BYTES) return null
  const text = buffer.toString('utf8')
  return text.includes('\u0000') ? null : text
}

function lineDiffOf(before, after) {
  const left = String(before ?? '').split('\n')
  const right = String(after ?? '').split('\n')
  // Trim the unchanged head and tail first; usually the diff is tiny.
  let head = 0
  while (head < left.length && head < right.length && left[head] === right[head]) head += 1
  let tailLeft = left.length - 1
  let tailRight = right.length - 1
  while (tailLeft >= head && tailRight >= head && left[tailLeft] === right[tailRight]) {
    tailLeft -= 1
    tailRight -= 1
  }
  const a = left.slice(head, tailLeft + 1)
  const b = right.slice(head, tailRight + 1)
  let removed = []
  let added = []
  if (a.length === 0) {
    added = b
  } else if (b.length === 0) {
    removed = a
  } else if (a.length * b.length > 4_000_000) {
    // Too large for a quadratic table: report the replaced block.
    removed = a
    added = b
  } else {
    // Classic LCS table; backtracks to the concrete added/removed lines.
    const width = b.length + 1
    const table = new Uint32Array((a.length + 1) * width)
    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) {
        table[i * width + j] = a[i] === b[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        i += 1
        j += 1
      } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
        removed.push(a[i])
        i += 1
      } else {
        added.push(b[j])
        j += 1
      }
    }
    for (; i < a.length; i += 1) removed.push(a[i])
    for (; j < b.length; j += 1) added.push(b[j])
  }
  return {
    added: added.slice(0, MAX_DIFF_LINES),
    removed: removed.slice(0, MAX_DIFF_LINES),
    addedCount: added.length,
    removedCount: removed.length,
    truncated: added.length > MAX_DIFF_LINES || removed.length > MAX_DIFF_LINES,
  }
}

function normalizeActivityDiff(raw) {
  if (!isPlainObject(raw)) return null
  const added = Array.isArray(raw.added) ? raw.added.filter((line) => typeof line === 'string').slice(0, MAX_DIFF_LINES) : []
  const removed = Array.isArray(raw.removed) ? raw.removed.filter((line) => typeof line === 'string').slice(0, MAX_DIFF_LINES) : []
  if (added.length === 0 && removed.length === 0) return null
  return {
    added,
    removed,
    addedCount: Number.isFinite(raw.addedCount) ? raw.addedCount : added.length,
    removedCount: Number.isFinite(raw.removedCount) ? raw.removedCount : removed.length,
    truncated: raw.truncated === true,
  }
}

function isFreshActivity(activity) {
  const releasedAt = Date.parse(activity?.expiresAt || '')
  if (Number.isFinite(releasedAt) && releasedAt <= Date.now()) return false
  const at = Date.parse(activity?.updatedAt)
  if (!Number.isFinite(at)) return false
  const ttl = activity?.state === 'write' ? ACTIVITY_WRITE_TTL_MS : ACTIVITY_READ_TTL_MS
  return Date.now() - at <= ttl
}

function cleanActivityId(value) {
  if (typeof value !== 'string' || !/^(act_[A-Za-z0-9-]{4,64}|\d{1,20})$/.test(value)) {
    throw new ApiError(400, 'INVALID_ACTIVITY', 'Invalid activity ID format')
  }
  return value
}

function cleanActivityPath(value) {
  const text = cleanText(value, MAX_ACTIVITY_PATH, 'File path', true)
  const normalized = text.replaceAll('\\', '/').replace(/\/{2,}/g, '/')
  if (normalized === '/' || normalized === './' || normalized.length === 0) {
    throw new ApiError(400, 'INVALID_PATH', 'Invalid file path format')
  }
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
}

function activityNameOf(filePath) {
  const index = filePath.lastIndexOf('/')
  return index === -1 ? filePath : filePath.slice(index + 1) || filePath
}

function cleanActivityOp(value) {
  if (value === undefined || value === null || value === '') return 'open'
  if (!ACTIVITY_OPS.includes(value)) {
    throw new ApiError(400, 'INVALID_ACTIVITY_OP', 'Operation must be open, move or copy')
  }
  return value
}

function cleanActivityState(value) {
  if (value === undefined || value === null || value === '') return 'read'
  if (!ACTIVITY_STATES.includes(value)) {
    throw new ApiError(400, 'INVALID_ACTIVITY_STATE', 'State must be read (read-only) or write (read/write)')
  }
  return value
}

function cleanActivityNote(value) {
  return cleanText(value ?? '', MAX_ACTIVITY_NOTE, 'Note')
}

function cleanActivityDestination(value) {
  return cleanText(value ?? '', MAX_ACTIVITY_DESTINATION, 'Destination directory')
}

function formatActivityTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const pad = (numeric) => String(numeric).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function normalizeActivities(rawActivities, liveGroupIds, groupMembers) {
  const activities = []
  const seen = new Set()
  if (!Array.isArray(rawActivities)) return activities
  for (const candidate of rawActivities) {
    if (!isPlainObject(candidate)) continue
    const id = typeof candidate.id === 'string' ? candidate.id : ''
    if (!/^(act_[A-Za-z0-9-]{4,64}|\d{1,20})$/.test(id) || seen.has(id)) continue
    const groupId = typeof candidate.groupId === 'string' ? candidate.groupId : ''
    if (!liveGroupIds.has(groupId)) continue
    const sessionId = typeof candidate.sessionId === 'string' ? candidate.sessionId : ''
    if (!isSafeSessionId(sessionId)) continue
    const members = groupMembers.get(groupId)
    if (members && !members.has(sessionId)) continue
    const path = typeof candidate.path === 'string' ? candidate.path.slice(0, MAX_ACTIVITY_PATH) : ''
    if (path.length === 0) continue
    const op = ACTIVITY_OPS.includes(candidate.op) ? candidate.op : 'open'
    const activityState = ACTIVITY_STATES.includes(candidate.state)
      ? candidate.state
      : (LEGACY_ACTIVITY_STATES[candidate.state] ?? 'read')
    const createdAt = typeof candidate.createdAt === 'string' ? candidate.createdAt : isoNow()
    activities.push({
      id,
      groupId,
      sessionId,
      op,
      state: activityState,
      path,
      name: typeof candidate.name === 'string' && candidate.name.length > 0
        ? candidate.name
        : activityNameOf(path),
      destination: typeof candidate.destination === 'string'
        ? candidate.destination.slice(0, MAX_ACTIVITY_DESTINATION)
        : '',
      note: typeof candidate.note === 'string' ? candidate.note.slice(0, MAX_ACTIVITY_NOTE) : '',
      source: candidate.source === 'auto' ? 'auto' : 'manual',
      expiresAt: typeof candidate.expiresAt === 'string' ? candidate.expiresAt : '',
      lockCallId: typeof candidate.lockCallId === 'string' ? candidate.lockCallId : '',
      diff: normalizeActivityDiff(candidate.diff),
      createdAt,
      updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : createdAt,
    })
    seen.add(id)
    if (activities.length >= MAX_ACTIVITIES) break
  }
  return activities
}

function requireActivity(state, activityId) {
  const activity = state.activities.find((candidate) => candidate.id === activityId)
  if (!activity) throw new ApiError(404, 'ACTIVITY_NOT_FOUND', 'Activity does not exist or has been deleted')
  return activity
}

/**
 * Locks held by other members on the same file. Multiple `read` locks may
 * coexist; a `write` lock excludes every other lock. A `read` request only
 * conflicts with a `write` lock, a `write` request conflicts with any lock.
 */
function lockConflictsOf(state, groupId, filePath, activityState, exceptId = null, exceptSessionId = null) {
  const locks = state.activities.filter((activity) =>
    activity.groupId === groupId
    && activity.path === filePath
    && isFreshActivity(activity)
    && FILE_LOCK_STATES.includes(activity.state)
    && activity.id !== exceptId
    && activity.sessionId !== exceptSessionId,
  )
  if (activityState === 'read') return locks.filter((activity) => activity.state === 'write')
  return locks
}

function activityStateLabel(value) {
  return ACTIVITY_STATE_LABELS[value] ?? value
}

function activityConflictMessage(conflicts) {
  const detail = conflicts
    .slice(0, 3)
    .map((activity) => `${activity.sessionId} (${activityStateLabel(activity.state)}, ${formatActivityTime(activity.updatedAt)})`)
    .join(', ')
  return `File is in use:${detail}`
    + `${conflicts.length > 3 ? ` and ${conflicts.length} more records` : ''}.`
    + 'Read-only can be shared; read/write is exclusive. Wait for the other side to release it, or delete the record first.'
}

function canEditActivity(state, activity, actorId) {
  if (activity.sessionId === actorId) return true
  const membership = findMembership(state, activity.groupId, actorId)
  return membership?.role === ROLE_LEADER
}

function actionCreateActivity(state, body) {
  const sessionId = cleanSessionId(body.sessionId)
  const groupId = resolveGroupId(state, sessionId, body.groupId)
  requireGroup(state, groupId)
  if (!findMembership(state, groupId, sessionId)) {
    throw new ApiError(403, 'NOT_IN_GROUP', 'You are not in this group')
  }
  if (state.activities.length >= MAX_ACTIVITIES) {
    throw new ApiError(409, 'ACTIVITY_LIMIT', `Keep at most ${MAX_ACTIVITIES} activity records`)
  }
  const path = cleanActivityPath(body.path)
  const op = cleanActivityOp(body.op)
  const activityState = cleanActivityState(body.state)
  const destination = cleanActivityDestination(body.destination)
  const note = cleanActivityNote(body.note)
  if ((op === 'move' || op === 'copy') && destination.length === 0) {
    throw new ApiError(400, 'DESTINATION_REQUIRED', 'Move or copy requires a destination directory')
  }
  const existing = state.activities.find((activity) =>
    activity.groupId === groupId
    && activity.sessionId === sessionId
    && activity.path === path,
  )
  const conflicts = lockConflictsOf(state, groupId, path, activityState, existing?.id ?? null, sessionId)
  if (conflicts.length > 0) {
    throw new ApiError(409, 'FILE_IN_USE', activityConflictMessage(conflicts), { conflicts })
  }
  if (existing) {
    existing.state = activityState
    existing.op = op
    existing.destination = destination
    if (note.length > 0) existing.note = note
    existing.name = activityNameOf(path)
    existing.updatedAt = isoNow()
    state.updatedAt = existing.updatedAt
    return { activity: existing, reused: true, conflicts: [] }
  }
  const now = isoNow()
  const activity = {
    id: `act_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    groupId,
    sessionId,
    op,
    state: activityState,
    path,
    name: activityNameOf(path),
    destination,
    note,
    source: 'manual',
    createdAt: now,
    updatedAt: now,
  }
  state.activities.push(activity)
  state.updatedAt = now
  return { activity, reused: false, conflicts }
}

function actionUpdateActivity(state, body) {
  const actorId = cleanSessionId(body.sessionId)
  const activity = requireActivity(state, cleanActivityId(body.activityId))
  if (!canEditActivity(state, activity, actorId)) {
    throw new ApiError(403, 'NOT_ACTIVITY_OWNER', 'Only the creator or the leader can edit this activity')
  }
  if (body.path !== undefined) {
    activity.path = cleanActivityPath(body.path)
    activity.name = activityNameOf(activity.path)
  }
  if (body.op !== undefined) activity.op = cleanActivityOp(body.op)
  if (body.state !== undefined) activity.state = cleanActivityState(body.state)
  if (body.destination !== undefined) activity.destination = cleanActivityDestination(body.destination)
  if (body.note !== undefined) activity.note = cleanActivityNote(body.note)
  if ((activity.op === 'move' || activity.op === 'copy') && activity.destination.length === 0) {
    throw new ApiError(400, 'DESTINATION_REQUIRED', 'Move or copy requires a destination directory')
  }
  const conflicts = lockConflictsOf(state, activity.groupId, activity.path, activity.state, activity.id, null)
  if (conflicts.length > 0) {
    throw new ApiError(409, 'FILE_IN_USE', activityConflictMessage(conflicts), { conflicts })
  }
  activity.updatedAt = isoNow()
  state.updatedAt = activity.updatedAt
  return { activity, conflicts: [] }
}

function actionDeleteActivity(state, body) {
  const actorId = cleanSessionId(body.sessionId)
  const activity = requireActivity(state, cleanActivityId(body.activityId))
  if (!canEditActivity(state, activity, actorId)) {
    throw new ApiError(403, 'NOT_ACTIVITY_OWNER', 'Only the creator or the leader can delete this activity')
  }
  state.activities = state.activities.filter((candidate) => candidate.id !== activity.id)
  state.updatedAt = isoNow()
  return { id: activity.id, path: activity.path }
}

/**
 * Auto-record entries written by the host observer when a member opens or
 * edits a file. One entry per (group, session, path) is kept so a session
 * reading the same file repeatedly does not flood the list.
 */
function actionRecordAutoActivity(state, body) {
  const sessionId = cleanSessionId(body.sessionId)
  const path = cleanActivityPath(body.path)
  const op = cleanActivityOp(body.op)
  const activityState = cleanActivityState(body.state)
  const memberships = state.memberships.filter((membership) => membership.sessionId === sessionId)
  if (memberships.length === 0) return { recorded: 0 }
  let recorded = 0
  let blocked = 0
  for (const membership of memberships) {
    const groupId = membership.groupId
    const existing = state.activities.find((activity) =>
      activity.groupId === groupId
      && activity.sessionId === sessionId
      && activity.path === path,
    )
    const conflicts = lockConflictsOf(state, groupId, path, activityState, existing?.id ?? null, sessionId)
    if (conflicts.length > 0) {
      blocked += 1
      continue
    }
    if (existing) {
      existing.state = activityState
      existing.op = op
      existing.name = activityNameOf(path)
      existing.updatedAt = isoNow()
      recorded += 1
      continue
    }
    if (state.activities.length >= MAX_ACTIVITIES) break
    const now = isoNow()
    state.activities.push({
      id: `act_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      groupId,
      sessionId,
      op,
      state: activityState,
      path,
      name: activityNameOf(path),
      destination: '',
      note: '',
      source: 'auto',
      createdAt: now,
      updatedAt: now,
    })
    recorded += 1
  }
  if (recorded > 0) state.updatedAt = isoNow()
  return { recorded, blocked }
}

const FILE_TOOL_LOCKS = new Map([
  ['read', 'read'],
  ['write', 'write'],
  ['edit', 'write'],
])

function normalizeActivityFilePath(rawPath, cwd) {
  const text = rawPath.trim().replaceAll('\\', '/')
  if (!cwd) return text
  try {
    return resolve(cwd, text).replaceAll('\\', '/')
  } catch {
    return text
  }
}

function readStateSync(profileDir) {
  try {
    const raw = JSON.parse(readFileSync(statePathOf(profileDir), 'utf8'))
    return normalizeState(raw)
  } catch {
    return null
  }
}

/**
 * Monotonic tool guard: the fs tools may only touch a file when the member's
 * execution-list locks permit it. Multiple `read` locks coexist; a `write`
 * lock excludes everyone else. The caller's own record never blocks an
 * upgrade (read -> write). A denied call is never executed, so a member can
 * not use a file whose lock could not be created.
 */
const pendingActivityLocks = new Map()

function recordActivityLockSync(state, groupId, sessionId, filePath, wanted, callId) {
  const now = isoNow()
  const name = activityNameOf(filePath)
  let activity = state.activities.find(
    (candidate) =>
      candidate.groupId === groupId
      && candidate.sessionId === sessionId
      && candidate.path === filePath
      && candidate.source === 'auto',
  )
  if (!activity) {
    while (state.activities.length >= MAX_ACTIVITIES) state.activities.shift()
    activity = {
      id: compactIdOf(),
      groupId,
      sessionId,
      op: 'open',
      state: wanted,
      path: filePath,
      name,
      destination: '',
      note: '',
      source: 'auto',
      expiresAt: '',
      lockCallId: callId,
      createdAt: now,
      updatedAt: now,
    }
    state.activities.push(activity)
    return activity
  }
  // Each fs call requests exactly one lock mode. Reusing an older record must
  // not keep a previous exclusive write flag alive, otherwise a later plain
  // read would keep blocking every other member until the TTL expires.
  activity.state = wanted
  activity.name = name
  activity.op = 'open'
  activity.expiresAt = ''
  activity.lockCallId = callId
  activity.updatedAt = now
  return activity
}

/**
 * Monotonic tool guard: the fs tools may only touch a file when the member's
 * execution-list locks permit it. Multiple `read` locks coexist; a `write`
 * lock excludes everyone else. The caller's own record never blocks an
 * upgrade (read -> write). Every allowed call records its own read/write
 * activity before the tool runs, so the list is always up to date; when the
 * record cannot be written the call is refused.
 */
function fileActivityGuard(profileDir) {
  return (exec) => {
    const wanted = FILE_TOOL_LOCKS.get(exec?.name)
    if (!wanted) return undefined
    const args = exec.arguments
    const rawPath = args && typeof args === 'object'
      ? (args.file_path ?? args.path ?? args.filePath)
      : undefined
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0) return undefined
    const sessionId = typeof exec.agent?.id === 'string' ? exec.agent.id : ''
    if (!sessionId) return undefined
    const state = readStateSync(profileDir)
    if (!state) return undefined
    const memberships = state.memberships.filter((membership) => membership.sessionId === sessionId)
    if (memberships.length === 0) return undefined
    const cwd = exec.agent?.session?.header?.cwd
    const filePath = normalizeActivityFilePath(rawPath, typeof cwd === 'string' ? cwd : undefined)
    const locks = []
    for (const membership of memberships) {
      const conflicts = lockConflictsOf(state, membership.groupId, filePath, wanted, null, sessionId)
      if (conflicts.length > 0) {
        const detail = conflicts
          .slice(0, 3)
          .map((activity) => `${activity.sessionId} (${activityStateLabel(activity.state)}, ${formatActivityTime(activity.updatedAt)})`)
          .join(', ')
        return `Activity lock conflict: file ${filePath} is in use by ${detail}. Read-only can be shared; read/write is exclusive. Wait for the other side to release it, or release it / switch it to read-only before using this file.`
      }
      const activity = recordActivityLockSync(state, membership.groupId, sessionId, filePath, wanted, exec.callId)
      locks.push({ groupId: membership.groupId, activityId: activity.id })
    }
    try {
      state.updatedAt = isoNow()
      writeStateSync(statePathOf(profileDir), state)
    } catch (error) {
      return `Activity lock could not be recorded (${error?.message ?? error}); the file operation was not executed.`
    }
    if (locks.length > 0 && typeof exec.callId === 'string') pendingActivityLocks.set(exec.callId, locks)
    if (wanted === 'write' && locks.length > 0 && typeof exec.callId === 'string') {
      try {
        pendingActivityCaptures.set(exec.callId, {
          filePath,
          before: readTextIfSmall(filePath),
          entries: locks.slice(),
        })
      } catch {
        // Diff capture is best-effort; the lock itself already succeeded.
      }
    }
    return undefined
  }
}

/**
 * Compare the file after a write/edit finished with the snapshot taken by the
 * guard, then attach the added/removed lines to the activity records of the
 * call. Runs on tools/result, before the lock is released.
 */
function captureActivityDiff(profileDir, exec, result) {
  if (typeof exec?.callId !== 'string') return
  const capture = pendingActivityCaptures.get(exec.callId)
  if (!capture) return
  pendingActivityCaptures.delete(exec.callId)
  if (result?.isError || result?.error) return
  if (!['write', 'edit'].includes(exec.name)) return
  const after = readTextIfSmall(capture.filePath)
  if (after === null) return
  const before = typeof capture.before === 'string' ? capture.before : ''
  const diff = lineDiffOf(before, after)
  if (diff.addedCount === 0 && diff.removedCount === 0) return
  try {
    const state = readStateSync(profileDir)
    if (!state) return
    const now = isoNow()
    let changed = false
    for (const entry of capture.entries) {
      const activity = state.activities.find((candidate) => candidate.id === entry.activityId)
      if (!activity) continue
      activity.diff = diff
      activity.updatedAt = now
      changed = true
    }
    if (changed) {
      state.updatedAt = now
      writeStateSync(statePathOf(profileDir), state)
    }
  } catch (error) {
    console.warn('[dsh-multi-agent] Failed to record write diff:', error?.message ?? error)
  }
}

function releaseActivityLocks(profileDir, callId) {
  if (typeof callId !== 'string') return
  const entries = pendingActivityLocks.get(callId)
  if (!entries || entries.length === 0) return
  pendingActivityLocks.delete(callId)
  try {
    const state = readStateSync(profileDir)
    if (!state) return
    const now = isoNow()
    let changed = false
    for (const entry of entries) {
      const activity = state.activities.find((candidate) => candidate.id === entry.activityId)
      if (activity && activity.lockCallId === callId) {
        activity.expiresAt = now
        changed = true
      }
    }
    if (changed) {
      state.updatedAt = now
      writeStateSync(statePathOf(profileDir), state)
    }
  } catch (error) {
    console.warn('[dsh-multi-agent] Failed to release activity lock:', error?.message ?? error)
  }
}

function activityQueryOf(query) {
  const raw = typeof query === 'string' ? query.trim() : ''
  const result = { all: false, file: '', member: '', limit: 0 }
  if (!raw) return result
  const tokens = raw.split(/\s+/)
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '-a') {
      result.all = true
      continue
    }
    if (token === '-s') {
      const value = tokens[index + 1] ?? ''
      if (value.length === 0) throw new ApiError(400, 'INVALID_QUERY', '-s requires a file name')
      result.file = value
      index += 1
      continue
    }
    if (token === '-m') {
      const value = tokens[index + 1] ?? ''
      if (value.length === 0) throw new ApiError(400, 'INVALID_QUERY', '-m requires a member session ID')
      if (!isSafeSessionId(value)) throw new ApiError(400, 'INVALID_QUERY', 'Invalid member session ID')
      result.member = value
      index += 1
      continue
    }
    if (token.startsWith('session-')) {
      if (!isSafeSessionId(token)) throw new ApiError(400, 'INVALID_QUERY', 'Invalid member session ID')
      if (result.member.length > 0 && result.member !== token) {
        throw new ApiError(400, 'INVALID_QUERY', 'Only one member session ID can be filtered at a time')
      }
      result.member = token
      continue
    }
    if (/^\d+$/.test(token)) {
      if (result.limit > 0) throw new ApiError(400, 'INVALID_QUERY', 'The record count can only be given once')
      const limit = Number(token)
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new ApiError(400, 'INVALID_QUERY', 'The record count must be between 1 and 200')
      }
      result.limit = limit
      continue
    }
    throw new ApiError(400, 'INVALID_QUERY', 'Query supports only -a, -s <file name>, -m <member ID> and a trailing record count')
  }
  return result
}

function activitiesText(state, groupId, agentId, query) {
  const group = requireGroup(state, groupId)
  const filters = activityQueryOf(query)
  let list = state.activities.filter((activity) => activity.groupId === groupId)
  if (filters.member.length > 0) {
    list = list.filter((activity) => activity.sessionId === filters.member)
  }
  if (filters.file.length > 0) {
    const needle = filters.file.toLowerCase()
    list = list.filter((activity) =>
      activity.name.toLowerCase().includes(needle) || activity.path.toLowerCase().includes(needle),
    )
  }
  if (!filters.all && filters.member.length === 0) {
    list = list.filter((activity) => FILE_LOCK_STATES.includes(activity.state) && isFreshActivity(activity))
  }
  list.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
  const total = list.length
  const limit = filters.limit > 0 ? filters.limit : 80
  const shown = list.slice(0, limit)
  const lines = [`Activity list · group "${group.name}" [${group.id}] · ${total} records`]
  lines.push(' (by default only files in use are listed: read-only is shared, read/write is exclusive; query takes -a for all, -s <file name> to filter, -m <member ID> for all records of that member, and a trailing number for the latest N records; these can be combined)')
  if (total === 0) {
    lines.push(
      filters.member.length > 0
        ? `Member ${filters.member} has no activity in this group yet.`
        : filters.all
          ? 'No activity records yet.'
          : (filters.file.length > 0 ? 'No matching files are in use.' : 'No files are in use right now.'),
    )
    return lines.join('\n')
  }
  for (const activity of shown) {
    const opText = ACTIVITY_OP_LABELS[activity.op] ?? activity.op
    const stateText = ACTIVITY_STATE_LABELS[activity.state] ?? activity.state
    const destination = activity.destination ? ` → ${activity.destination}` : ''
    const diffText = activity.diff
      ? ` · +${activity.diff.addedCount}/-${activity.diff.removedCount}`
      : ''
    lines.push(
      `- [${activity.id}] [${stateText}] member ${activity.sessionId}`
      + ` · ${opText} ${activity.path}${destination}`
      + ` · ${formatActivityTime(activity.updatedAt)}`
      + ` · source ${activity.source === 'auto' ? 'auto' : 'manual'}`
      + diffText,
    )
    if (activity.note) lines.push(`  Note: ${activity.note}`)
  }
  if (total > shown.length) lines.push(`... ${total - shown.length} more records omitted (pass a trailing number to show more)`)
  return lines.join('\n')
}

function activityDiffText(activity) {
  const stateText = ACTIVITY_STATE_LABELS[activity.state] ?? activity.state
  const lines = [
    `Activity ${activity.id} · ${activity.name} · ${stateText} · member ${activity.sessionId} · ${formatActivityTime(activity.updatedAt)}`,
    `Path: ${activity.path}`,
  ]
  if (!activity.diff) {
    lines.push('No captured line change for this record (read-only, failed or oversized call, or an older record).')
    return lines.join('\n')
  }
  const diff = activity.diff
  lines.push(`Added ${diff.addedCount} line(s), removed ${diff.removedCount} line(s)${diff.truncated ? ' (truncated)' : ''}:`)
  for (const line of diff.removed) lines.push(`- ${line}`)
  for (const line of diff.added) lines.push(`+ ${line}`)
  return lines.join('\n')
}

function catalogModelOf(catalog, provider, model) {
  for (const providerGroup of Array.isArray(catalog?.groups) ? catalog.groups : []) {
    if (providerGroup?.id !== provider) continue
    const models = Array.isArray(providerGroup.models) ? providerGroup.models : []
    const found = models.find((item) => item?.id === model)
    if (found) return found
  }
  return null
}

async function resolveLiveAgent(controller, sessionId) {
  const found = await controller.agents.resolveAgent(sessionId)
  if (found && typeof found === 'object' && found.error) throw found.error
  const agent = found && typeof found === 'object' && found.agent ? found.agent : found
  if (!agent || !agent.session) {
    throw new ApiError(404, 'SESSION_NOT_FOUND', 'Conversation not found; it may have been closed or deleted')
  }
  return agent
}

function currentSelectionOf(controller, agent) {
  try {
    const fromModel = typeof agent?.model?.current === 'function' ? agent.model.current() : null
    if (fromModel && typeof fromModel.provider === 'string' && typeof fromModel.model === 'string') {
      return {
        provider: fromModel.provider,
        model: fromModel.model,
        ...(typeof fromModel.reasoningEffort === 'string' && fromModel.reasoningEffort
          ? { reasoningEffort: fromModel.reasoningEffort }
          : {}),
      }
    }
  } catch {
    // Fall through to the controller-provided selection reader.
  }
  try {
    const current = controller.agents?.selectionFor?.(agent)?.current
    if (current && typeof current.provider === 'string' && typeof current.model === 'string') {
      return {
        provider: current.provider,
        model: current.model,
        ...(typeof current.reasoningEffort === 'string' && current.reasoningEffort
          ? { reasoningEffort: current.reasoningEffort }
          : {}),
      }
    }
  } catch {
    // Fall through to the logged request header.
  }
  const config = agent.session?.requestHeader?.()?.config
  if (config && typeof config.provider === 'string' && typeof config.model === 'string') {
    return {
      provider: config.provider,
      model: config.model,
      ...(typeof config.reasoningEffort === 'string' && config.reasoningEffort
        ? { reasoningEffort: config.reasoningEffort }
        : {}),
    }
  }
  return null
}

/**
 * Resolve the model + reasoning selection for a newly spawned member session.
 * `custom` reads the durable group setting and checks it against the live model
 * catalog; the default `inherit` follows the leader's current selection.
 * @param controller Session controller service.
 * @param group Target group.
 * @param leaderAgent Live leader Agent.
 * @returns Selection to install for the new session, or null to keep defaults.
 */
async function spawnSelectionFor(controller, group, leaderAgent) {
  if (group?.spawn?.mode === 'custom') {
    let catalog = null
    try {
      catalog = await controller.modelCatalog()
    } catch {
      catalog = null
    }
    const modelInfo = catalogModelOf(catalog, group.spawn.provider, group.spawn.model)
    if (!modelInfo) {
      throw new ApiError(
        409,
        'SPAWN_MODEL_UNAVAILABLE',
        `Group "${group.name}" is using a model that is currently unavailable; the leader must pick new session inheritance settings on the management page`,
      )
    }
    const efforts = Array.isArray(modelInfo.reasoning?.efforts) ? modelInfo.reasoning.efforts : []
    const reasoningEffort = group.spawn.reasoningEffort
      && efforts.some((item) => item.id === group.spawn.reasoningEffort)
      ? group.spawn.reasoningEffort
      : (typeof modelInfo.reasoning?.defaultEffort === 'string' ? modelInfo.reasoning.defaultEffort : null)
    return {
      provider: group.spawn.provider,
      model: group.spawn.model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    }
  }
  return currentSelectionOf(controller, leaderAgent)
}

function leaderWorkspaceOf(ctx, leaderSessionId) {
  const registry = ctx?.get?.('workspaceRegistry')
  try {
    const list = registry?.list?.() ?? []
    return list.find((item) => Array.isArray(item?.sessionIds) && item.sessionIds.includes(leaderSessionId))
  } catch {
    return undefined
  }
}

/**
 * Mirror the leader's full-access permission on a freshly created session.
 * Only the named `danger-full-access` preset is copied so a more restrictive
 * leader policy never gets widened by this feature.
 * @returns Whether the preset was applied.
 */
function applyFullAccessIfNeeded(ctx, leaderAgent, newAgent) {
  const presets = ctx?.get?.('permissionPresets')
  if (!presets || typeof presets.set !== 'function') return false
  try {
    const preset = typeof presets.current === 'function'
      ? presets.current(leaderAgent.session)
      : presets.permissionState(leaderAgent.session)?.preset
    if (preset !== 'danger-full-access') return false
    presets.set(newAgent.session, 'danger-full-access')
    return true
  } catch {
    return false
  }
}

/**
 * Turn a human title into a valid subagent name (lowercase letters, digits and
 * hyphens, at most 32 characters). The group suffix keeps names unique across
 * groups of the same leader.
 */
function subagentNameOf(title, groupId) {
  const base = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 18)
  const suffix = String(groupId ?? '').replace(/[^a-z0-9]+/gi, '').slice(-4).toLowerCase()
  return `${base || 'member'}-${suffix || 'group'}`.slice(0, 32)
}

/**
 * First-turn instruction for a spawned member. The member starts idle after
 * this bootstrap turn; work arrives later through group notifications.
 */
function memberBootstrapPrompt(title, group) {
  return [
    `[dsh-multi-agent] You are "${title}", a member of group "${group.name}" (${group.id}).`,
    'This is a setup message only: do not start any work yet.',
    'Load the multi-agent-guide skill, then reply with one short line confirming you are ready.',
    'Task modules and group messages will arrive later; when they do, follow the guide.',
  ].join('\n')
}

/**
 * Create a member as a DSH subagent of the leader. Returns the child session
 * id, or null when the runtime cannot spawn subagents (caller falls back to a
 * plain session).
 */
async function tryCreateMemberSubagent(ctx, leaderAgent, title, group, selection, workspace) {
  const subagents = ctx?.get?.('subagents')
  if (!subagents || typeof subagents.startActivation !== 'function' || typeof subagents.getProvider !== 'function') {
    return null
  }
  let provider = null
  try {
    provider = subagents.getProvider('spawn')
  } catch {
    provider = null
  }
  if (!provider) return null
  const agentOptions = { provider: selection.provider, model: selection.model }
  if (selection.reasoningEffort) agentOptions.reasoningEffort = selection.reasoningEffort
  const receipt = await subagents.startActivation({
    provider: 'spawn',
    label: title,
    name: subagentNameOf(title, group.id),
    parent: leaderAgent,
    prompt: [{ type: 'text', text: memberBootstrapPrompt(title, group) }],
    ...(workspace?.path ? { cwd: workspace.path } : {}),
    agentOptions,
    delivery: 'parent',
    signal: new AbortController().signal,
  })
  return receipt?.childId ?? null
}

/**
 * Deliver a group notification through DSH's own agent channel. A live
 * recipient receives it without the sender blocking; when the recipient is
 * not part of the sender's subagent tree, callers fall back to a prompt.
 *
 * @returns `'subagent'`, `'injected'`, or null when neither channel exists.
 */
async function notifyAgent(ctx, senderAgent, sessionId, text) {
  const subagents = ctx?.get?.('subagents')
  if (subagents && senderAgent && typeof subagents.sendMessage === 'function') {
    try {
      await subagents.sendMessage(
        senderAgent,
        sessionId,
        [{ type: 'text', text }],
        { signal: new AbortController().signal },
      )
      return 'subagent'
    } catch {
      // Not in the same subagent tree: try a direct non-waking injection.
    }
  }
  const agents = ctx?.get?.('agents')
  const target = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
  // Injection is the non-waking channel, but an idle agent would not consume
  // it until its next turn; fall through to the prompt fallback instead.
  if (target && typeof target.inject === 'function' && target.status !== 'idle') {
    try {
      target.inject({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      })
      return 'injected'
    } catch {
      // Fall through to the prompt fallback.
    }
  }
  return null
}

/**
 * Create a blank member session in the leader's workspace. The new session
 * starts with no conversation history; only model/reasoning and (when the
 * leader is fully privileged) the permission preset are inherited.
 * @param ctx Host plugin context.
 * @param state Normalized plugin state (mutated in place).
 * @param body Request body (`groupId`, `leaderSessionId`, `name`).
 * @returns Public creation result for the API and the tool output.
 */
function applyModelSelection(controller, agent, selection) {
  if (!selection) return true
  if (typeof agent?.model?.select === 'function') {
    agent.model.select(selection)
    return true
  }
  if (typeof controller?.agents?.selectForNextRequest === 'function') {
    controller.agents.selectForNextRequest(agent, selection)
    return true
  }
  return false
}

async function actionCreateMemberSession(ctx, state, body) {
  const groupId = cleanGroupId(body.groupId)
  const group = requireGroup(state, groupId)
  const leaderSessionId = cleanSessionId(body.leaderSessionId)
  const membership = findMembership(state, groupId, leaderSessionId)
  if (!membership || membership.role !== ROLE_LEADER) {
    throw new ApiError(403, 'NOT_LEADER', 'Only this group leader can create member sessions')
  }
  const title = cleanText(body.name, MAX_SPAWN_TITLE, 'Session name', true)
  if (state.memberships.length >= MAX_MEMBERSHIPS) {
    throw new ApiError(409, 'MEMBERSHIP_LIMIT', 'Too many member records; clean up some groups first')
  }
  const maxSessions = group.maxSessions ?? DEFAULT_MAX_SESSIONS
  const memberCount = state.memberships.filter((membership) => membership.groupId === groupId).length
  if (memberCount >= maxSessions) {
    throw new ApiError(409, 'GROUP_FULL', `Group "${group.name}" holds at most ${maxSessions} sessions`)
  }
  const unassignedTasks = state.tasks.filter(
    (candidate) => candidate.groupId === groupId && !candidate.assigneeSessionId,
  )
  if (unassignedTasks.length === 0) {
    throw new ApiError(
      409,
      'NO_TASK_MODULE',
      'First create a task tree for this group on the tasks page and split it into task modules (leave at least one unassigned module), then create member sessions',
    )
  }
  if (!body.taskId) {
    throw new ApiError(400, 'TASK_REQUIRED', 'Creating a member session requires a task module; pass taskId')
  }
  const taskId = cleanTaskId(body.taskId)
  const task = requireTask(state, taskId)
  if (task.groupId !== groupId) {
    throw new ApiError(400, 'TASK_GROUP_MISMATCH', 'Can only bind a task module from this group')
  }
  if (task.assigneeSessionId) {
    throw new ApiError(409, 'TASK_ALREADY_ASSIGNED', 'This task module already has an assignee; pick an unassigned module')
  }
  const controller = ctx?.get?.('sessionController')
  if (!controller || typeof controller.create !== 'function' || typeof controller.agents?.resolveAgent !== 'function') {
    throw new ApiError(503, 'SESSION_SERVICE', 'Session service is temporarily unavailable; cannot create a new session')
  }

  const leaderAgent = await resolveLiveAgent(controller, leaderSessionId)
  const selection = await spawnSelectionFor(controller, group, leaderAgent)
  const workspace = leaderWorkspaceOf(ctx, leaderSessionId)
  const request = workspace && (workspace.workspaceId ?? workspace.id)
    ? { workspaceId: workspace.workspaceId ?? workspace.id }
    : { cwd: leaderAgent.session?.header?.cwd ?? process.cwd() }
  let sessionId = null
  let createdVia = 'session'
  try {
    sessionId = await tryCreateMemberSubagent(ctx, leaderAgent, title, group, selection, workspace)
    if (sessionId) createdVia = 'subagent'
  } catch {
    sessionId = null
  }
  let newAgent = null
  if (sessionId) {
    const agents = ctx?.get?.('agents')
    newAgent = typeof agents?.get === 'function' ? agents.get(sessionId) ?? null : null
  } else {
    const created = await controller.create(request)
    sessionId = cleanSessionId(created?.sessionId)
    newAgent = await resolveLiveAgent(controller, sessionId)
    // A pending model/selection event makes the very first turn of the new
    // session use exactly the inherited or configured model.
    if (selection && !applyModelSelection(controller, newAgent, selection)) {
      throw new ApiError(503, 'SESSION_SERVICE', 'Session service is temporarily unavailable; cannot apply the model selection')
    }
  }
  const fullAccess = newAgent ? applyFullAccessIfNeeded(ctx, leaderAgent, newAgent) : false
  try {
    await controller.rename({ sessionId, title })
  } catch {
    // A freshly spawned subagent may not expose a renameable session yet.
  }

  state.memberships.push({
    groupId,
    sessionId,
    role: ROLE_MEMBER,
    joinedAt: isoNow(),
    updatedAt: isoNow(),
  })
  task.assigneeSessionId = sessionId
  task.updatedAt = isoNow()
  state.updatedAt = isoNow()
  return {
    sessionId,
    title,
    groupId,
    taskId,
    taskTitle: task.title,
    workspacePath: workspace?.path ?? null,
    selection,
    fullAccess,
    via: createdVia,
  }
}

function actionDeleteGroup(state, body) {
  const groupId = cleanGroupId(body.groupId)
  requireGroup(state, groupId)
  state.groups = state.groups.filter((group) => group.id !== groupId)
  state.memberships = state.memberships.filter((membership) => membership.groupId !== groupId)
  state.messages = state.messages.filter((message) => message.groupId !== groupId)
  const removedTasks = new Set(
    state.tasks.filter((task) => task.groupId === groupId).map((task) => task.id),
  )
  state.tasks = state.tasks.filter((task) => task.groupId !== groupId)
  state.taskEdges = state.taskEdges.filter(
    (edge) => edge.groupId !== groupId && !removedTasks.has(edge.from) && !removedTasks.has(edge.to),
  )
  state.activities = state.activities.filter((activity) => activity.groupId !== groupId)
  state.updatedAt = isoNow()
  return null
}

function actionAssign(state, body) {
  const sessionId = cleanSessionId(body.sessionId)
  // Kept for compatibility with the first client: a null group means "leave
  // every group". New callers use the explicit `leave` action instead.
  if (body.groupId === null || body.groupId === undefined || body.groupId === '') {
    state.memberships = state.memberships.filter((membership) => membership.sessionId !== sessionId)
    state.updatedAt = isoNow()
    return null
  }

  const groupId = cleanGroupId(body.groupId)
  const group = requireGroup(state, groupId)
  const role = cleanRole(body.role ?? ROLE_MEMBER)
  const current = findMembership(state, groupId, sessionId)
  const currentLeaderId = leaderOf(state, groupId)
  if (!current) {
    const maxSessions = group.maxSessions ?? DEFAULT_MAX_SESSIONS
    const currentCount = state.memberships.filter((membership) => membership.groupId === groupId).length
    if (currentCount >= maxSessions) {
      throw new ApiError(409, 'GROUP_FULL', `This group holds at most ${maxSessions} sessions`)
    }
  }

  if (current && current.role === ROLE_LEADER && role === ROLE_MEMBER) {
    throw new ApiError(
      409,
      'LEADER_REQUIRED',
      'A group must keep a leader; first make another member the leader (takeover), then adjust the current leader',
    )
  }

  if (role === ROLE_LEADER && currentLeaderId && currentLeaderId !== sessionId && body.takeover !== true) {
    throw new ApiError(409, 'LEADER_EXISTS', 'This group already has a leader; you must take over the leader role to join', {
      leaderSessionId: currentLeaderId,
    })
  }

  if (role === ROLE_LEADER && currentLeaderId && currentLeaderId !== sessionId) {
    const previousLeader = findMembership(state, groupId, currentLeaderId)
    if (previousLeader) {
      previousLeader.role = ROLE_MEMBER
      previousLeader.updatedAt = isoNow()
    }
  }

  if (current) {
    current.role = role
    current.updatedAt = isoNow()
  } else {
    if (state.memberships.length >= MAX_MEMBERSHIPS) {
      throw new ApiError(409, 'MEMBERSHIP_LIMIT', 'Too many member records; clean up some groups first')
    }
    state.memberships.push({
      groupId,
      sessionId,
      role,
      joinedAt: isoNow(),
      updatedAt: isoNow(),
    })
  }
  state.updatedAt = isoNow()
  return findMembership(state, groupId, sessionId)
}

function repairGroupAfterDeparture(state, groupId) {
  const group = state.groups.find((candidate) => candidate.id === groupId)
  if (!group) return false
  const members = state.memberships
    .filter((membership) => membership.groupId === groupId)
    .sort((left, right) => String(left.joinedAt).localeCompare(String(right.joinedAt)))
  if (members.length === 0) {
    state.groups = state.groups.filter((candidate) => candidate.id !== groupId)
    state.messages = state.messages.filter((message) => message.groupId !== groupId)
    const removedTasks = new Set(
      state.tasks.filter((task) => task.groupId === groupId).map((task) => task.id),
    )
    state.tasks = state.tasks.filter((task) => task.groupId !== groupId)
    state.taskEdges = state.taskEdges.filter(
      (edge) => edge.groupId !== groupId && !removedTasks.has(edge.from) && !removedTasks.has(edge.to),
    )
    return true
  }
  if (!members.some((membership) => membership.role === ROLE_LEADER)) {
    members[0].role = ROLE_LEADER
    members[0].updatedAt = isoNow()
  }
  return false
}

function actionLeave(state, body) {
  const sessionId = cleanSessionId(body.sessionId)
  if (body.groupId !== undefined && body.groupId !== null && body.groupId !== '') {
    const groupId = cleanGroupId(body.groupId)
    requireGroup(state, groupId)
    const before = state.memberships.length
    state.memberships = state.memberships.filter(
      (membership) => !(membership.groupId === groupId && membership.sessionId === sessionId),
    )
    const groupDeleted = repairGroupAfterDeparture(state, groupId)
    clearOrphanAssignees(state)
    state.updatedAt = isoNow()
    return { removed: before - state.memberships.length, groupDeleted }
  }
  const before = state.memberships.length
  const affected = [...new Set(
    state.memberships
      .filter((membership) => membership.sessionId === sessionId)
      .map((membership) => membership.groupId),
  )]
  state.memberships = state.memberships.filter((membership) => membership.sessionId !== sessionId)
  let deleted = 0
  for (const groupId of affected) {
    if (repairGroupAfterDeparture(state, groupId)) deleted += 1
  }
  clearOrphanAssignees(state)
  state.updatedAt = isoNow()
  return { removed: before - state.memberships.length, groupsDeleted: deleted }
}

function pendingReplyCount(state, groupId, sessionId) {
  return state.messages.filter(
    (message) =>
      message.groupId === groupId &&
      message.deliveries.some(
        (delivery) => delivery.sessionId === sessionId && delivery.status !== 'failed' && !delivery.reply,
      ),
  ).length
}

// ---- Member lifecycle: handover, archive, restore ----
// A member whose work is finished but who has no next task is parked by
// archiving the conversation, then restored once a new task exists. The
// leader can hand over a member (marking the member's claimed tasks), but
// cannot archive the member directly: archiving is the member's own action.

function memberTasksOf(state, groupId, sessionId) {
  return state.tasks.filter(
    (task) => task.groupId === groupId && task.assigneeSessionId === sessionId,
  )
}

function pendingHandoverTasks(state, groupId, sessionId) {
  return memberTasksOf(state, groupId, sessionId).filter(
    (task) => !(task.status === 'done' && task.completionNote) && !task.handedOverAt,
  )
}

async function archiveMemberSession(ctx, sessionId) {
  let registry = null
  try {
    registry = ctx?.get?.('workspaceRegistry') ?? null
  } catch {
    registry = null
  }
  if (!registry || typeof registry.archiveSession !== 'function') {
    return 'The workspace registry is unavailable; the member is marked archived in the plugin only'
  }
  try {
    await registry.archiveSession(sessionId, { stopActivity: true })
    return ''
  } catch (error) {
    return `DSH could not archive the conversation: ${error?.message ?? error}`
  }
}

async function restoreMemberSession(ctx, sessionId) {
  let registry = null
  try {
    registry = ctx?.get?.('workspaceRegistry') ?? null
  } catch {
    registry = null
  }
  if (!registry || typeof registry.unarchiveSession !== 'function') return
  try {
    await registry.unarchiveSession(sessionId)
  } catch (error) {
    console.warn('[dsh-multi-agent] Failed to unarchive member session:', error?.message ?? error)
  }
}

async function actionHandoverMember(ctx, state, body) {
  const leaderId = cleanSessionId(body.leaderSessionId)
  const groupId = resolveGroupId(state, leaderId, body.groupId, ROLE_LEADER)
  requireLeaderOf(state, groupId, leaderId)
  const sessionId = cleanSessionId(body.sessionId)
  if (sessionId === leaderId) {
    throw new ApiError(400, 'CANNOT_HANDOVER_LEADER', 'The leader cannot hand over its own conversation; assign the task instead')
  }
  const membership = requireGroupMember(state, groupId, sessionId)
  if (membership.role === ROLE_LEADER) {
    throw new ApiError(400, 'CANNOT_HANDOVER_LEADER', 'Handover targets a member, not the leader')
  }
  if (membership.archivedAt) {
    throw new ApiError(409, 'ALREADY_ARCHIVED', 'This member is already archived; restore it first')
  }
  const now = isoNow()
  membership.handoverAt = now
  membership.handoverBy = leaderId
  membership.updatedAt = now
  const tasks = memberTasksOf(state, groupId, sessionId)
  for (const task of tasks) {
    if (!task.handedOverAt) {
      task.handedOverAt = now
      task.handedOverBy = leaderId
      task.updatedAt = now
    }
  }
  state.updatedAt = now
  return { sessionId, groupId, handedOverTasks: tasks.map((task) => task.id), handedOverAt: now }
}

async function actionArchiveMember(ctx, state, body) {
  const sessionId = cleanSessionId(body.sessionId ?? body.actorSessionId)
  const groupId = resolveGroupId(state, sessionId, body.groupId)
  const membership = requireGroupMember(state, groupId, sessionId)
  if (membership.role === ROLE_LEADER) {
    throw new ApiError(409, 'CANNOT_ARCHIVE_LEADER', 'The leader cannot archive its own conversation; transfer leadership or keep it active')
  }
  if (membership.archivedAt) {
    return { sessionId, groupId, archivedAt: membership.archivedAt, alreadyArchived: true }
  }
  const pending = pendingHandoverTasks(state, groupId, sessionId)
  if (pending.length > 0) {
    throw new ApiError(
      409,
      'HANDOVER_REQUIRED',
      `Finish these tasks with a completion note (or wait for the leader to hand over) before archiving: ${pending.map((task) => `${task.id} "${task.title}"`).join(', ')}`,
      { taskIds: pending.map((task) => task.id) },
    )
  }
  const now = isoNow()
  const warning = await archiveMemberSession(ctx, sessionId)
  membership.archivedAt = now
  membership.updatedAt = now
  for (const activity of state.activities) {
    if (activity.groupId === groupId && activity.sessionId === sessionId && !activity.expiresAt) {
      activity.expiresAt = now
      activity.updatedAt = now
    }
  }
  state.updatedAt = now
  const result = { sessionId, groupId, archivedAt: now }
  if (warning) result.warning = warning
  return result
}

async function actionRestoreMember(ctx, state, body) {
  const leaderId = cleanSessionId(body.leaderSessionId)
  const groupId = resolveGroupId(state, leaderId, body.groupId, ROLE_LEADER)
  requireLeaderOf(state, groupId, leaderId)
  const sessionId = cleanSessionId(body.sessionId)
  const membership = requireGroupMember(state, groupId, sessionId)
  if (!membership.archivedAt) {
    throw new ApiError(409, 'NOT_ARCHIVED', 'This member is not archived')
  }
  const task = requireTask(state, cleanTaskId(body.taskId))
  if (task.groupId !== groupId) {
    throw new ApiError(400, 'TASK_GROUP_MISMATCH', 'The task and the member must belong to the same group')
  }
  if (task.status === 'done' && task.completionNote) {
    throw new ApiError(409, 'TASK_LOCKED', 'That task is already completed and kept as a record; assign an unfinished task')
  }
  if (task.assigneeSessionId && task.assigneeSessionId !== sessionId) {
    throw new ApiError(409, 'TASK_ALREADY_ASSIGNED', 'That task is assigned to somebody else')
  }
  const now = isoNow()
  await restoreMemberSession(ctx, sessionId)
  task.assigneeSessionId = sessionId
  task.handedOverAt = ''
  task.handedOverBy = ''
  task.updatedAt = now
  membership.archivedAt = ''
  membership.handoverAt = ''
  membership.handoverBy = ''
  membership.updatedAt = now
  state.updatedAt = now
  return { sessionId, groupId, taskId: task.id, restoredAt: now }
}

function requireGroupMember(state, groupId, sessionId) {
  const membership = findMembership(state, groupId, sessionId)
  if (!membership) throw new ApiError(403, 'NOT_IN_GROUP', 'The current conversation is not in this group')
  return membership
}

function actionSendMessage(state, body) {
  const groupId = cleanGroupId(body.groupId)
  requireGroup(state, groupId)
  const senderKind = body.senderKind === 'user' ? 'user' : 'agent'
  const senderSessionId = senderKind === 'user' ? null : cleanSessionId(body.senderSessionId)
  if (senderKind === 'agent') requireGroupMember(state, groupId, senderSessionId)
  const content = cleanText(body.content, MAX_MESSAGE, 'Message content', true)
  if (body.mode !== 'broadcast' && body.mode !== 'private') {
    throw new ApiError(400, 'INVALID_MODE', 'Message type must be broadcast or private')
  }

  const pending = senderKind === 'user' ? 0 : pendingReplyCount(state, groupId, senderSessionId)
  if (pending > 0) {
    throw new ApiError(409, 'PENDING_REPLY', `${pending} messages are still waiting for a reply; reply first, then send`, {
      pendingCount: pending,
    })
  }

  const groupMembers = state.memberships.filter(
    (membership) => membership.groupId === groupId
      && (senderKind === 'user' || membership.sessionId !== senderSessionId),
  )
  let recipientSessionId = null
  let recipients
  if (body.mode === 'private') {
    recipientSessionId = cleanSessionId(body.recipientSessionId)
    if (senderKind === 'agent' && recipientSessionId === senderSessionId) {
      throw new ApiError(400, 'SELF_PRIVATE', 'Cannot send a private message to yourself')
    }
    if (!findMembership(state, groupId, recipientSessionId)) {
      throw new ApiError(400, 'NOT_IN_GROUP', 'The private message recipient is not in this group')
    }
    recipients = [recipientSessionId]
  } else {
    recipients = groupMembers.map((membership) => membership.sessionId)
  }
  if (recipients.length === 0) {
    throw new ApiError(409, 'NO_RECIPIENTS', 'This group has no other members who can receive messages')
  }

  const message = {
    id: `msg_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    groupId,
    senderKind,
    senderSessionId,
    senderName: senderKind === 'user' ? USER_SENDER_NAME : null,
    mode: body.mode,
    recipientSessionId,
    content,
    createdAt: isoNow(),
    deliveries: recipients.map((sessionId) => ({
      sessionId,
      status: 'pending',
      deliveredAt: null,
      error: null,
      reply: null,
    })),
  }
  state.messages.push(message)
  if (state.messages.length > MAX_MESSAGES) {
    state.messages.splice(0, state.messages.length - MAX_MESSAGES)
  }
  state.updatedAt = isoNow()
  return message
}

function actionReplyMessage(state, body) {
  const groupId = cleanGroupId(body.groupId)
  requireGroup(state, groupId)
  const messageId = cleanMessageId(body.messageId)
  const sessionId = cleanSessionId(body.sessionId)
  const content = cleanText(body.content, MAX_MESSAGE, 'Reply content', true)
  const message = state.messages.find((candidate) => candidate.id === messageId && candidate.groupId === groupId)
  if (!message) throw new ApiError(404, 'MESSAGE_NOT_FOUND', 'Message does not exist or is no longer valid')
  const delivery = message.deliveries.find((candidate) => candidate.sessionId === sessionId)
  if (!delivery) throw new ApiError(403, 'NOT_RECIPIENT', 'Only members who received the message can reply')
  if (delivery.reply) throw new ApiError(409, 'ALREADY_REPLIED', 'This message has already been replied to')
  delivery.reply = {
    content,
    createdAt: isoNow(),
    status: 'pending',
    deliveredAt: null,
    error: null,
  }
  state.updatedAt = isoNow()
  return {
    messageId: message.id,
    senderKind: message.senderKind,
    senderSessionId: message.senderSessionId,
    recipientSessionId: sessionId,
    content,
    reply: delivery.reply,
  }
}

/**
 * Deliver a recorded reply back to the original sender as a `steer`
 * interjection. The queue row is the durable receipt; this function is what
 * makes the reply an actual conversational message rather than a comment.
 *
 * @param ctx Host plugin context carrying the DSH session controller.
 * @param state Normalized plugin state (mutated in place).
 * @param body Reply identity (`groupId`, `messageId`, `sessionId`).
 * @param result Reply returned by `actionReplyMessage`.
 * @returns Delivery outcome recorded on the reply.
 */
async function deliverReply(ctx, state, body, result) {
  const groupId = cleanGroupId(body.groupId)
  const group = requireGroup(state, groupId)
  const messageId = cleanMessageId(body.messageId)
  const sessionId = cleanSessionId(body.sessionId)
  const message = state.messages.find((candidate) => candidate.id === messageId && candidate.groupId === groupId)
  if (!message) throw new ApiError(404, 'MESSAGE_NOT_FOUND', 'Message does not exist or is no longer valid')
  const delivery = message.deliveries.find((candidate) => candidate.sessionId === sessionId)
  if (!delivery || !delivery.reply) throw new ApiError(404, 'REPLY_NOT_FOUND', 'Reply not found')
  if (delivery.reply.status === 'sent') {
    return {
      messageId,
      sessionId,
      senderKind: message.senderKind,
      senderSessionId: message.senderSessionId,
      ...(message.senderKind === 'user'
        ? { deliveredTo: USER_VIEWER_ID, replyToUser: true }
        : {}),
      delivered: true,
      status: 'sent',
      deliveredAt: delivery.reply.deliveredAt,
    }
  }

  // The human user has no conversation to steer. Replies to user-sent messages
  // are delivered to the console queue and marked sent immediately; they are
  // visible to the user under the "__user__" viewer.
  if (message.senderKind === 'user') {
    delivery.reply.status = 'sent'
    delivery.reply.deliveredAt = isoNow()
    delivery.reply.error = null
    state.updatedAt = isoNow()
    return {
      messageId,
      sessionId,
      senderKind: 'user',
      senderSessionId: null,
      deliveredTo: USER_VIEWER_ID,
      replyToUser: true,
      delivered: true,
      status: 'sent',
      deliveredAt: delivery.reply.deliveredAt,
      error: null,
    }
  }

  const replierName = typeof body.replierName === 'string' && body.replierName.trim()
    ? body.replierName.trim().slice(0, 120)
    : sessionId
  const text = [
    `[Agent group reply | ${group.name}]`,
    `${replierName} replied to your message: ${delivery.reply.content}`,
    `Original message ID: ${messageId}`,
  ].join('\n')

  delivery.reply.status = 'pending'
  delivery.reply.error = null
  const channel = await notifyAgent(ctx, body.senderAgent ?? null, message.senderSessionId, text)
  if (channel) {
    delivery.reply.status = 'sent'
    delivery.reply.deliveredAt = isoNow()
    delivery.reply.error = null
    state.updatedAt = isoNow()
    return {
      messageId,
      sessionId,
      senderKind: message.senderKind,
      senderSessionId: message.senderSessionId,
      delivered: true,
      status: 'sent',
      deliveredAt: delivery.reply.deliveredAt,
      error: null,
      channel,
    }
  }
  try {
    const controller = ctx?.get?.('sessionController')
    if (!controller || typeof controller.prompt !== 'function') {
      throw new Error('sessionController service is unavailable')
    }
    const abort = new AbortController()
    await controller.prompt({
      sessionId: message.senderSessionId,
      content: [{ type: 'text', text }],
      mode: 'steer',
      // The prompt source records this id. Omitting it leaves `source.rpcId`
      // present-but-undefined, which the Session log rejects as non-JSON.
      requestId: randomUUID(),
    }, abort.signal)
    delivery.reply.status = 'sent'
    delivery.reply.deliveredAt = isoNow()
    delivery.reply.error = null
  } catch (error) {
    delivery.reply.status = 'failed'
    delivery.reply.deliveredAt = null
    const detail = error && typeof error === 'object' && error.details && typeof error.details === 'object'
      ? error.details.reason || error.details.code || ''
      : ''
    const message = error instanceof Error ? error.message : String(error)
    delivery.reply.error = (detail ? `${message}: ${detail}` : message).slice(0, 300)
  }
  state.updatedAt = isoNow()
  return {
    messageId,
    sessionId,
    senderKind: message.senderKind,
    senderSessionId: message.senderSessionId,
    delivered: delivery.reply.status === 'sent',
    status: delivery.reply.status,
    deliveredAt: delivery.reply.deliveredAt,
    error: delivery.reply.error,
  }
}

function actionMarkDelivered(state, body) {
  const messageId = cleanMessageId(body.messageId)
  const sessionId = cleanSessionId(body.sessionId)
  const message = state.messages.find((candidate) => candidate.id === messageId)
  if (!message) throw new ApiError(404, 'MESSAGE_NOT_FOUND', 'Message does not exist or is no longer valid')
  const delivery = message.deliveries.find((candidate) => candidate.sessionId === sessionId)
  if (!delivery) throw new ApiError(404, 'DELIVERY_NOT_FOUND', 'Delivery record not found')
  const status = body.ok === false ? 'failed' : 'sent'
  const error = typeof body.error === 'string' ? body.error.slice(0, 300) : null
  if (body.reply === true) {
    if (!delivery.reply) throw new ApiError(404, 'REPLY_NOT_FOUND', 'Reply not found')
    delivery.reply.status = status
    delivery.reply.deliveredAt = status === 'sent' ? isoNow() : null
    delivery.reply.error = error
  } else {
    delivery.status = status
    delivery.deliveredAt = status === 'sent' ? isoNow() : null
    delivery.error = error
  }
  state.updatedAt = isoNow()
  return { messageId, sessionId, status }
}

function messagesForViewer(state, groupId, sessionId) {
  requireGroup(state, groupId)
  const isUserViewer = sessionId === USER_VIEWER_ID
  const membership = isUserViewer ? null : requireGroupMember(state, groupId, sessionId)
  const isLeader = isUserViewer || membership.role === ROLE_LEADER
  const messages = state.messages.filter(
    (message) =>
      message.groupId === groupId &&
      (isUserViewer || isLeader ||
        message.senderSessionId === sessionId ||
        message.deliveries.some((delivery) => delivery.sessionId === sessionId)),
  )
  return {
    viewerKind: isUserViewer ? 'user' : 'agent',
    role: isUserViewer ? 'user' : membership.role,
    isLeader,
    messages: messages.slice(-500),
  }
}

async function handleAction(profileDir, body, ctx) {
  if (!isPlainObject(body) || typeof body.action !== 'string') {
    throw new ApiError(400, 'INVALID_ACTION', 'Request is missing action')
  }
  const file = statePathOf(profileDir)
  const task = writeQueues.get(file) ?? Promise.resolve()
  const run = task.then(async () => {
    const state = await readState(file)
    let result = null
    switch (body.action) {
      case 'createGroup':
        result = actionCreateGroup(state, body)
        break
      case 'updateGroup':
        result = actionUpdateGroup(state, body)
        break
      case 'createTask':
        result = actionCreateTask(state, body)
        break
      case 'updateTask':
        result = actionUpdateTask(state, body)
        break
      case 'setTaskStatus':
        result = actionSetTaskStatus(state, body)
        break
      case 'deleteTask':
        result = actionDeleteTask(state, body)
        break
      case 'createTaskEdge':
        result = actionCreateTaskEdge(state, body)
        break
      case 'deleteTaskEdge':
        result = actionDeleteTaskEdge(state, body)
        break
      case 'createActivity':
        result = actionCreateActivity(state, body)
        break
      case 'updateActivity':
        result = actionUpdateActivity(state, body)
        break
      case 'deleteActivity':
        result = actionDeleteActivity(state, body)
        break
      case 'createMemberSession':
        result = await actionCreateMemberSession(ctx, state, body)
        break
      case 'handoverMember':
        result = await actionHandoverMember(ctx, state, body)
        break
      case 'archiveMember':
        result = await actionArchiveMember(ctx, state, body)
        break
      case 'restoreMember':
        result = await actionRestoreMember(ctx, state, body)
        break
      case 'deleteGroup':
        actionDeleteGroup(state, body)
        break
      case 'assign':
        result = actionAssign(state, body)
        break
      case 'leave':
        result = actionLeave(state, body)
        break
      case 'sendMessage':
        result = actionSendMessage(state, body)
        break
      case 'replyMessage':
        result = actionReplyMessage(state, body)
        result = {
          ...result,
          delivery: await deliverReply(ctx, state, body, result),
        }
        break
      case 'deliverReply':
        result = await deliverReply(ctx, state, body)
        break
      case 'markDelivered':
        result = actionMarkDelivered(state, body)
        break
      default:
        throw new ApiError(400, 'INVALID_ACTION', `Unsupported action: ${body.action}`)
    }
    await writeState(file, state)
    return { state: publicState(state), result }
  })
  writeQueues.set(file, run.catch(() => {}))
  return run
}

const writeQueues = new Map()

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.end(body)
}

function checkOrigin(req, webServer) {
  const origin = req.headers.origin
  if (origin === undefined) return
  let expected
  try {
    expected = webServer.getOrigin()
  } catch {
    expected = undefined
  }
  if (expected && origin !== expected) {
    throw new ApiError(403, 'CROSS_ORIGIN', 'Group data can only be accessed from the current DSH page')
  }
  if (!expected && origin !== 'null') {
    throw new ApiError(403, 'CROSS_ORIGIN', 'Group data can only be accessed from the current DSH page')
  }
}

async function readJsonBody(req) {
  const contentType = String(req.headers['content-type'] ?? '')
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new ApiError(415, 'INVALID_CONTENT_TYPE', 'Request body must be JSON')
  }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      throw new ApiError(413, 'BODY_TOO_LARGE', 'Request body is too large')
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'Request JSON could not be parsed')
  }
}

// ---------------------------------------------------------------------------
// Token usage report: sums the provider-reported token usage projection of
// every member session in one group. Live sessions answer from the projection
// snapshot; cold sessions are replayed through the session query service, so
// the report also covers history recorded before the plugin was installed.
// ---------------------------------------------------------------------------

const USAGE_CACHE_TTL_MS = 15_000
const usageReportCache = new Map()

function normalizeTokenUsage(value) {
  const count = (key) => (typeof value?.[key] === 'number' && Number.isFinite(value[key])
    ? Math.max(0, Math.floor(value[key]))
    : 0)
  const uncachedInput = count('uncachedInputTokens')
  const output = count('outputTokens')
  const cacheRead = count('cacheReadTokens')
  const cacheWrite = count('cacheWriteTokens')
  return {
    uncachedInput,
    output,
    cacheRead,
    cacheWrite,
    total: uncachedInput + output + cacheRead + cacheWrite,
  }
}

/**
 * Read the durable provider-reported usage of one session. Live sessions use
 * the in-memory projection snapshot; everything else replays the persisted log
 * through `sessionQuery`, which is why the report also covers old messages.
 */
async function readSessionTokenUsage(ctx, sessionId) {
  try {
    const session = ctx?.get?.('sessions')?.get?.(sessionId)
    if (session) {
      const snapshot = ctx?.get?.('sessionProjections')?.snapshot?.(session)
      if (snapshot?.values?.tokenUsage) return normalizeTokenUsage(snapshot.values.tokenUsage)
    }
  } catch {
    // A live projection failure falls through to the durable log read.
  }
  let observation
  try {
    const query = ctx?.get?.('sessionQuery')
    if (!query || typeof query.observeSession !== 'function') return null
    observation = await query.observeSession(sessionId)
    const usage = observation?.projections?.values?.tokenUsage
    return usage ? normalizeTokenUsage(usage) : null
  } catch {
    return null
  } finally {
    try {
      observation?.[Symbol.dispose]?.()
    } catch {
      // Disposal is best effort.
    }
  }
}

/**
 * Build the per-group token report: one row per membership, sorted by usage
 * (descending) with a whole-percent share of the group total.
 */
async function buildTokenUsageReport(ctx, state, groupId) {
  const group = requireGroup(state, groupId)
  const memberships = state.memberships.filter((membership) => membership.groupId === groupId)
  const rows = await Promise.all(memberships.map(async (membership) => {
    const usage = await readSessionTokenUsage(ctx, membership.sessionId)
    return {
      sessionId: membership.sessionId,
      role: membership.role,
      available: usage !== null,
      ...(usage ?? { uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
    }
  }))
  const total = rows.reduce((sum, row) => sum + row.total, 0)
  for (const row of rows) {
    row.percent = total > 0 ? Math.round((row.total / total) * 100) : 0
  }
  rows.sort((left, right) => right.total - left.total || left.sessionId.localeCompare(right.sessionId))
  return {
    groupId,
    groupName: group.name,
    total,
    members: rows,
    generatedAt: isoNow(),
  }
}

function createHandler(ctx, profileDir, hostContext) {
  return async function handler(req, res) {
    try {
      const webServer = ctx.webServer
      checkOrigin(req, webServer)
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname.replace(/\/+$/, '')
      if (req.method === 'OPTIONS') {
        res.statusCode = 204
        res.setHeader('Allow', 'GET, POST, OPTIONS')
        res.end()
        return
      }
      if (req.method === 'GET' && (path === `${API_PREFIX}/state` || path === API_PREFIX)) {
        const state = await readState(statePathOf(profileDir))
        sendJson(res, 200, { ok: true, state: publicState(state) })
        return
      }
      if (req.method === 'GET' && path === `${API_PREFIX}/tools`) {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const definitions = buildTools(profileDir, hostContext)
        const gates = sessionId
          ? await Promise.all(definitions.map(async (definition) => ({
            name: definition.name,
            visible: await definition.when({ agent: { id: sessionId }, modelSelection: null, signal: new AbortController().signal }),
          })))
          : []
        sendJson(res, 200, {
          ok: true,
          registration: toolRegistration,
          definitions: definitions.map((definition) => definition.name),
          gates,
        })
        return
      }
      if (req.method === 'GET' && path === `${API_PREFIX}/models`) {
        const controller = hostContext?.get?.('sessionController')
        if (!controller || typeof controller.modelCatalog !== 'function') {
          throw new ApiError(503, 'SESSION_SERVICE', 'Cannot read the model list right now')
        }
        const catalog = await controller.modelCatalog()
        sendJson(res, 200, { ok: true, catalog })
        return
      }
      if (req.method === 'GET' && path === `${API_PREFIX}/usage`) {
        const groupId = cleanGroupId(url.searchParams.get('groupId'))
        const refresh = url.searchParams.get('refresh') === '1'
        const cached = usageReportCache.get(groupId)
        if (!refresh && cached && Date.now() - cached.at < USAGE_CACHE_TTL_MS) {
          sendJson(res, 200, { ok: true, report: cached.report })
          return
        }
        const state = await readState(statePathOf(profileDir))
        const report = await buildTokenUsageReport(hostContext, state, groupId)
        usageReportCache.set(groupId, { at: Date.now(), report })
        sendJson(res, 200, { ok: true, report })
        return
      }
      if (req.method === 'GET' && path === `${API_PREFIX}/messages`) {
        const groupId = cleanGroupId(url.searchParams.get('groupId'))
        const rawViewerId = url.searchParams.get('sessionId')
        const sessionId = rawViewerId === USER_VIEWER_ID ? USER_VIEWER_ID : cleanSessionId(rawViewerId)
        const state = await readState(statePathOf(profileDir))
        const group = requireGroup(state, groupId)
        const view = messagesForViewer(state, groupId, sessionId)
        sendJson(res, 200, {
          ok: true,
          group: { id: group.id, name: group.name, color: group.color },
          viewerKind: view.viewerKind,
          role: view.role,
          isLeader: view.isLeader,
          messages: view.messages,
        })
        return
      }
      if (req.method === 'POST' && (path === `${API_PREFIX}/action` || path === API_PREFIX)) {
        if (req.headers['x-dsh-multi-agent'] !== '1') {
          throw new ApiError(403, 'BAD_REQUEST_HEADER', 'Missing plugin request header')
        }
        const body = await readJsonBody(req)
        const { state, result } = await handleAction(profileDir, body, hostContext)
        sendJson(res, 200, { ok: true, state, result })
        return
      }
      throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found')
    } catch (error) {
      if (error instanceof ApiError) {
        sendJson(res, error.status, {
          ok: false,
          error: { code: error.code, message: error.message, ...error.extra },
        })
        return
      }
      console.error('[dsh-multi-agent] Request failed:', error)
      sendJson(res, 500, {
        ok: false,
        error: { code: 'INTERNAL', message: 'Group service is temporarily unavailable; try again later' },
      })
    }
  }
}

const TOOL_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: {
      text: { type: 'string', description: 'Result summary for the model to read.' },
    },
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

function shortSession(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return 'Unknown conversation'
  return sessionId.length > 22 ? `${sessionId.slice(0, 14)}…${sessionId.slice(-4)}` : sessionId
}

function timeText(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value ?? '')
  return date.toLocaleString('zh-CN', { hour12: false })
}

function toolFailure(error) {
  if (error instanceof ApiError) {
    const leader = error.extra?.leaderSessionId
    const suffix = leader ? ` (current leader: ${leader}; use takeover to take over)` : ''
    return new Error(`${error.message}${suffix}`)
  }
  return error instanceof Error ? error : new Error(String(error))
}

function agentIdOf(exec) {
  const id = exec?.agent?.id
  return typeof id === 'string' && id.length > 0 ? id : ''
}

function requireAgentId(exec) {
  const id = agentIdOf(exec)
  if (!id) throw new Error('This tool can only be called by an agent inside a conversation')
  return id
}

function findAgentMembership(state, groupId, agentId) {
  return state.memberships.find(
    (membership) => membership.groupId === groupId && membership.sessionId === agentId,
  )
}

function requireLeaderOf(state, groupId, agentId) {
  const membership = findAgentMembership(state, groupId, agentId)
  if (!membership) throw new Error('The current conversation is not in this group and cannot manage it')
  if (membership.role !== ROLE_LEADER) throw new Error('Only this group leader can perform this operation')
  return membership
}

function memberLines(state, groupId, agentId) {
  const group = requireGroup(state, groupId)
  const members = state.memberships.filter((membership) => membership.groupId === groupId)
  const mine = members.find((membership) => membership.sessionId === agentId)
  const lines = [
    `Group "${group.name}" [${group.id}]`,
    `Your session ID: ${agentId}`,
    `Your role in this group: ${mine ? (mine.role === ROLE_LEADER ? 'leader' : 'member') : 'not joined'}`,
    `Members (${members.length}; for private messages copy the full recipientSessionId):`,
  ]
  for (const membership of members) {
    lines.push(
      `- ${membership.sessionId} · ${membership.role === ROLE_LEADER ? 'leader' : 'member'}`
      + `${membership.sessionId === agentId ? ' (you)' : ''}`,
    )
  }
  return lines.join('\n')
}

function groupsText(state, agentId) {
  if (state.groups.length === 0) {
    return `Your session ID: ${agentId}\nThere are no agent groups yet.`
  }
  const lines = [`Your session ID: ${agentId}`, `${state.groups.length} groups:`]
  for (const group of state.groups) {
    const members = state.memberships.filter((membership) => membership.groupId === group.id)
    const mine = members.find((membership) => membership.sessionId === agentId)
    const leader = members.find((membership) => membership.role === ROLE_LEADER)
    const memberText = members.length === 0
      ? 'no members'
      : members.map((membership) =>
        `${membership.sessionId}(${membership.role === ROLE_LEADER ? 'leader' : 'member'})`,
      ).join(', ')
    lines.push(
      `- ${group.name} [${group.id}] my role: ${mine ? (mine.role === ROLE_LEADER ? 'leader' : 'member') : 'not joined'};`
      + `leader: ${leader ? leader.sessionId : 'vacant'} (members ${members.length}/${group.maxSessions ?? DEFAULT_MAX_SESSIONS}); members: ${memberText}`,
    )
  }
  return lines.join('\n')
}

/**
 * List sessions that can be added, preferring the leader's current workspace.
 * The client does the same filtering from its workspace projection; this host
 * path gives tool-only agents the same candidates without a browser round trip.
 */
async function candidateSessions(ctx, profileDir, agentId, groupId) {
  const controller = ctx?.get?.('sessionController')
  if (!controller || typeof controller.list !== 'function') return []
  const abort = new AbortController()
  let summaries = []
  try {
    const value = await controller.list({}, abort.signal)
    summaries = Array.isArray(value?.items) ? value.items : []
  } catch {
    return []
  }

  const workspaceRegistry = ctx?.get?.('workspaceRegistry')
  let workspace
  try {
    const list = workspaceRegistry?.list?.() ?? []
    workspace = list.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(agentId))
  } catch {
    workspace = undefined
  }
  const allowed = workspace && Array.isArray(workspace.sessionIds)
    ? new Set(workspace.sessionIds.map(String))
    : null
  const members = new Set(
    (await readState(statePathOf(profileDir))).memberships
      .filter((membership) => membership.groupId === groupId)
      .map((membership) => membership.sessionId),
  )

  return summaries
    .filter((item) => item && !item.blank && item.origin !== 'subagent')
    .filter((item) => item.sessionId !== agentId && !members.has(item.sessionId))
    .filter((item) => allowed === null || allowed.has(String(item.sessionId)))
    .slice(0, 80)
    .map((item) => ({
      sessionId: String(item.sessionId),
      cwd: typeof item.cwd === 'string' ? item.cwd : '',
      running: item.running === true,
      updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
    }))
}

function candidatesText(items, workspacePath) {
  if (items.length === 0) {
    return `No sessions can be added in the current workspace${workspacePath ? ` (${workspacePath})` : ''}; first create or open a conversation in that workspace.`
  }
  const lines = [
    `Sessions that can be added in the current workspace${workspacePath ? ` (${workspacePath})` : ''} (${items.length}):`,
    ...items.map((item) => `- ${item.sessionId}${item.running ? ' [running]' : ''}${item.cwd ? ` · ${item.cwd}` : ''}`),
  ]
  return lines.join('\n')
}

/**
 * Deliver one outgoing queue message to every recipient as a `steer`
 * interjection, then persist each delivery outcome. The queue row is written
 * before this runs, so a failed delivery is retryable rather than lost.
 */
async function deliverMessage(ctx, profileDir, group, message, senderAgent = null) {
  const controller = ctx?.get?.('sessionController')
  const sender = message.senderKind === 'user'
    ? USER_SENDER_NAME
    : shortSession(message.senderSessionId)
  const outcomes = []
  for (const delivery of message.deliveries) {
    const text = [
      `[Group message | ${group.name}]`,
      `${sender} sent you a message:`,
      '',
      message.content,
      '',
      `Message ID: ${message.id}`,
      'You must reply after receiving it: call the multi_agent_message tool (op="-r") and pass content to reply.',
    ].join('\n')
    const channel = senderAgent ? await notifyAgent(ctx, senderAgent, delivery.sessionId, text) : null
    if (channel) {
      await handleAction(profileDir, {
        action: 'markDelivered',
        messageId: message.id,
        sessionId: delivery.sessionId,
        ok: true,
      }, ctx)
      outcomes.push({ sessionId: delivery.sessionId, ok: true, channel })
      continue
    }
    if (!controller || typeof controller.prompt !== 'function') {
      throw new Error('sessionController service is unavailable')
    }
    const abort = new AbortController()
    try {
      await controller.prompt({
        sessionId: delivery.sessionId,
        content: [{ type: 'text', text }],
        mode: 'steer',
        requestId: randomUUID(),
      }, abort.signal)
      await handleAction(profileDir, {
        action: 'markDelivered',
        messageId: message.id,
        sessionId: delivery.sessionId,
        ok: true,
      }, ctx)
      outcomes.push({ sessionId: delivery.sessionId, ok: true })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      await handleAction(profileDir, {
        action: 'markDelivered',
        messageId: message.id,
        sessionId: delivery.sessionId,
        ok: false,
        error: detail,
      }, ctx).catch(() => {})
      outcomes.push({ sessionId: delivery.sessionId, ok: false, error: detail })
    }
  }
  return outcomes
}

function deliveryText(outcomes) {
  return outcomes.map((outcome) =>
    `${outcome.sessionId}: ${outcome.ok ? (outcome.channel === 'subagent' ? 'delivered as a DSH agent notification (non-blocking)' : outcome.channel === 'injected' ? 'delivered as a non-blocking notification' : 'delivered') : `delivery failed (${outcome.error})`}`,
  ).join('; ')
}

function messagesText(state, groupId, agentId) {
  const group = requireGroup(state, groupId)
  const view = messagesForViewer(state, groupId, agentId)
  if (view.messages.length === 0) {
    return `Your session ID: ${agentId}\nGroup "${group.name}" [${group.id}] has no messages yet.`
      + ` You are ${view.isLeader ? 'the leader and can view all broadcasts and private messages' : 'a member and can only view messages related to you'}.`
  }
  const lines = [
    `Your session ID: ${agentId}`,
    `Group "${group.name}" [${group.id}] message queue (you are ${view.isLeader ? 'the leader and can view all broadcasts and private messages' : 'a member and only messages related to you are shown'}):`,
  ]
  for (const message of view.messages.slice(-50)) {
    const recipient = message.mode === 'private'
      ? message.recipientSessionId
      : `${message.deliveries.length} members`
    const sender = message.senderKind === 'user'
      ? `${USER_SENDER_NAME} (console)`
      : message.senderSessionId
    lines.push(
      `- [${message.id}] ${timeText(message.createdAt)} ${sender} → ${recipient}: ${message.content}`,
    )
    for (const delivery of message.deliveries) {
      const replyState = delivery.reply
        ? delivery.reply.status === 'sent'
          ? (message.senderKind === 'user' ? 'replied to the user' : 'delivered as a DSH agent notification')
          : delivery.reply.status === 'failed'
            ? 'reply delivery failed'
            : 'reply delivering'
        : 'pending a reply'
      lines.push(
        `  · ${delivery.sessionId}: ${delivery.status === 'sent' ? 'delivered' : delivery.status === 'failed' ? 'delivery failed' : 'delivering'}`
        + `${delivery.reply ? `; reply: ${delivery.reply.content} (${replyState})` : '; pending a reply'}`,
      )
    }
  }
  return lines.join('\n')
}

function taskStatusLabel(status) {
  if (status === 'doing') return 'in progress'
  if (status === 'done') return 'done'
  return 'todo'
}

function tasksText(state, groupId, agentId) {
  const group = requireGroup(state, groupId)
  const tasks = state.tasks.filter((task) => task.groupId === groupId)
  const edges = state.taskEdges.filter((edge) => edge.groupId === groupId)
  const isLeader = state.memberships.some(
    (membership) =>
      membership.groupId === groupId
      && membership.sessionId === agentId
      && membership.role === ROLE_LEADER,
  )
  const memberCount = state.memberships.filter((membership) => membership.groupId === groupId).length
  const maxSessions = group.maxSessions ?? DEFAULT_MAX_SESSIONS
  const unassignedCount = tasks.filter((task) => !task.assigneeSessionId).length
  const header = `Your session ID: ${agentId}\nGroup "${group.name}" [${group.id}] task space (${tasks.length} tasks; members ${memberCount}/${maxSessions}, ${unassignedCount} unassigned task modules). You are ${isLeader ? 'the leader and can create, edit and delete tasks and edges' : 'a member; tasks are read-only and only the leader can edit tasks and edges'}.`
  if (tasks.length === 0) {
    return `${header}\nThis group has no tasks yet.${isLeader ? ' Use multi_agent_task op="-c" to create the first task card.' : ' Wait for the leader to create tasks, then view them with multi_agent_task op="-l".'}`
  }
  const lines = [header, 'Tasks:']
  for (const task of tasks) {
    const assignee = task.assigneeSessionId
      ? `assignee ${task.assigneeSessionId}${task.assigneeSessionId === agentId ? ' (you)' : ''}`
      : 'unassigned'
    lines.push(`- [${task.id}] ${task.title} (${taskStatusLabel(task.status)}, ${assignee})`)
    if (task.description) lines.push(`    Description: ${task.description}`)
  }
  lines.push(edges.length === 0 ? 'Edges: none' : 'Edges:')
  for (const edge of edges) {
    const from = tasks.find((task) => task.id === edge.from)
    const to = tasks.find((task) => task.id === edge.to)
    lines.push(`- [${edge.id}] ${from?.title ?? edge.from} → ${to?.title ?? edge.to}`)
  }
  lines.push(
    `Tip: task IDs can be handed to members to reference;${isLeader ? ' use multi_agent_task op="-u"/"-d" to edit/delete tasks and op="-x"/"-r" for edges.' : ' contact the leader when a change is needed.'}`,
  )
  return lines.join('\n')
}

/** Normalize an authored parameter map to an object-rooted JSON Schema. */
function objectRootedParameters(parameters) {
  if (parameters && parameters.type === 'object' && parameters.properties) return parameters
  return { type: 'object', properties: parameters ?? {} }
}

function buildTools(profileDir, ctx) {
  const stateOf = () => readState(statePathOf(profileDir))
  const always = () => true
  const whenMember = async ({ agent }) => {
    const agentId = agent?.id
    if (!agentId) return false
    try {
      const state = await stateOf()
      return state.memberships.some((membership) => membership.sessionId === agentId)
    } catch {
      return false
    }
  }
  const whenLeader = async ({ agent }) => {
    const agentId = agent?.id
    if (!agentId) return false
    try {
      const state = await stateOf()
      return state.memberships.some(
        (membership) => membership.sessionId === agentId && membership.role === ROLE_LEADER,
      )
    } catch {
      return false
    }
  }
  const whenTaskParticipant = async ({ agent }) => {
    const agentId = agent?.id
    if (!agentId) return false
    try {
      const state = await stateOf()
      return state.memberships.some(
        (membership) => membership.sessionId === agentId && membership.role === ROLE_LEADER,
      ) || state.tasks.some((task) => task.assigneeSessionId === agentId)
    } catch {
      return false
    }
  }
  const whenPendingReply = async ({ agent }) => {
    const agentId = agent?.id
    if (!agentId) return false
    try {
      const state = await stateOf()
      return state.memberships.some((membership) =>
        pendingReplyCount(state, membership.groupId, agentId) > 0,
      )
    } catch {
      return false
    }
  }

  const opOf = (value, fallback = '') => {
    if (typeof value !== 'string') return fallback
    const text = value.trim().toLowerCase()
    if (!text) return fallback
    return text.startsWith('-') ? text.slice(1) : text
  }

  const definitions = [
    {
      name: 'multi_agent_groups',
      description:
        'View group info (unified entry point). op="-l" (default) lists your session ID, all groups, your role in each, the leader and the members;'
        + ' op="-m" shows the members of one group (needs groupId unless you are in one group; copy recipientSessionId before a private message);'
        + ' op="-c" scans the current workspace for sessions that can join a group.',
      parameters: {
        op: {
          type: 'string',
          enum: ['-l', '-m', '-c'],
          description: 'Operation: -l list (default) / -m members / -c candidate sessions.',
        },
        groupId: { type: 'string', description: 'Group ID for op="-m"; optional when you are in only one group.' },
        includeSessions: {
          type: 'boolean',
          description: 'Legacy parameter: when true, appends sessions from the current workspace that can join a group.',
        },
      },
      when: always,
      output: TOOL_OUTPUT,
      execute: async (args, exec) => {
        const agentId = requireAgentId(exec)
        try {
          const state = await stateOf()
          const op = opOf(args?.op, 'l')
          if (op === 'm') {
            const groupId = resolveGroupId(state, agentId, args?.groupId)
            return { text: memberLines(state, groupId, agentId) }
          }
          if (op === 'c') {
            const candidates = await candidateSessions(ctx, profileDir, agentId, args?.groupId ?? '')
            return { text: candidatesText(candidates, '') }
          }
          if (op !== 'l') throw new Error('multi_agent_groups supports op="-l" (list), "-m" (members), "-c" (candidate sessions)')
          let text = groupsText(state, agentId)
          if (args?.includeSessions === true) {
            const candidates = await candidateSessions(ctx, profileDir, agentId, '')
            text += `\n\n${candidatesText(candidates, '')}`
          }
          return { text }
        } catch (error) {
          throw toolFailure(error)
        }
      },
    },
    {
      name: 'multi_agent_group',
      description:
        'Unified group operations. op: -n create (name required; the creator becomes leader) / -j join (groupId; role=leader with an existing leader needs takeover) / '
        + '-x leave (omit groupId to leave all) / -u edit name, description, color / -d delete / -a add member (sessionId) / -r remove member (sessionId) / '
        + '-s change role (sessionId + role) / -t scan sessions that can join. -u/-d/-a/-r/-s require leader permission.',
      parameters: {
        op: {
          type: 'string',
          enum: ['-n', '-j', '-x', '-u', '-d', '-a', '-r', '-s', '-t'],
          description: 'Operation flag, required.',
        },
        groupId: {
          type: 'string',
          description: 'Group ID. -u/-d/-a/-r/-s can omit it when managing one group. -x omits it to leave all groups.',
        },
        name: { type: 'string', description: '-n/-u: group name, up to 40 characters.' },
        description: { type: 'string', description: '-n/-u: group description, up to 240 characters.' },
        color: { type: 'string', description: '-n/-u: six-digit hex color, e.g. #5b6cf9.' },
        role: { type: 'string', enum: [ROLE_LEADER, ROLE_MEMBER], description: '-j/-a/-s: role, defaults to member.' },
        takeover: { type: 'boolean', description: '-j/-s: whether to take over when the target is a leader and a leader already exists.' },
        sessionId: { type: 'string', description: '-a/-r/-s: full sessionId of the target session.' },
        action: {
          type: 'string',
          description: 'Action names of the legacy multi_agent_manage_group (update/delete/add_member/remove_member/set_role/list_candidates).',
        },
      },
      when: always,
      output: TOOL_OUTPUT,
      execute: async (args, exec) => {
        const agentId = requireAgentId(exec)
        try {
          const state = await stateOf()
          const legacy = {
            create: 'n',
            join: 'j',
            leave: 'x',
            update: 'u',
            delete: 'd',
            add_member: 'a',
            remove_member: 'r',
            set_role: 's',
            list_candidates: 't',
          }
          const op = opOf(args?.op, legacy[String(args?.action ?? '').toLowerCase()] ?? '')
          if (!op) {
            throw new Error('Specify the operation with op: -n create / -j join / -x leave / -u edit / -d delete / -a add member / -r remove member / -s change role / -t candidate sessions')
          }
          if (op === 'n') {
            const result = await handleAction(profileDir, {
              action: 'createGroup',
              name: args?.name,
              description: args?.description,
              color: args?.color,
              leaderSessionId: agentId,
            }, ctx)
            const group = result.result
            return { text: `Created group "${group.name}" [${group.id}]; you are now the leader.` }
          }
          if (op === 't') {
            const candidates = await candidateSessions(ctx, profileDir, agentId, args?.groupId ?? '')
            return { text: candidatesText(candidates, '') }
          }
          if (op === 'j' || op === 'x') {
            if (op === 'j') {
              if (typeof args?.groupId !== 'string' || args.groupId.trim() === '') {
                throw new Error('Joining a group requires groupId')
              }
              const result = await handleAction(profileDir, {
                action: 'assign',
                groupId: args.groupId,
                sessionId: agentId,
                role: args?.role ?? ROLE_MEMBER,
                takeover: args?.takeover === true,
              }, ctx)
              const group = result.state.groups.find((item) => item.id === args.groupId)
              return { text: `Joined group "${group?.name ?? args.groupId}" as ${result.result?.role === ROLE_LEADER ? 'leader' : 'member'}.` }
            }
            const result = await handleAction(profileDir, {
              action: 'leave',
              groupId: args?.groupId,
              sessionId: agentId,
            }, ctx)
            return { text: `Left ${result.result?.removed ?? 0} groups.` }
          }

          const groupId = resolveGroupId(state, agentId, args?.groupId, ROLE_LEADER)
          requireLeaderOf(state, groupId, agentId)
          const group = requireGroup(state, groupId)
          if (op === 'u') {
            await handleAction(profileDir, {
              action: 'updateGroup',
              groupId,
              name: args?.name,
              description: args?.description,
              color: args?.color,
            }, ctx)
            return { text: `Updated group "${group.name}".` }
          }
          if (op === 'd') {
            await handleAction(profileDir, { action: 'deleteGroup', groupId }, ctx)
            return { text: `Deleted group "${group.name}" along with its membership and message records.` }
          }
          if (op === 'a' || op === 's') {
            if (typeof args?.sessionId !== 'string' || args.sessionId.trim() === '') {
              throw new Error('Provide the sessionId to add or adjust')
            }
            const result = await handleAction(profileDir, {
              action: 'assign',
              groupId,
              sessionId: args.sessionId,
              role: args?.role ?? ROLE_MEMBER,
              takeover: args?.takeover === true,
            }, ctx)
            return {
              text: `Updated ${args.sessionId} in group "${group.name}" (${op === 'a' ? 'added' : 'adjusted'}), role: ${result.result?.role === ROLE_LEADER ? 'leader' : 'member'}.`,
            }
          }
          if (op === 'r') {
            if (typeof args?.sessionId !== 'string' || args.sessionId.trim() === '') {
              throw new Error('Provide the sessionId to remove')
            }
            if (args.sessionId === agentId) throw new Error('Cannot remove yourself; use op="-x" to leave the group')
            await handleAction(profileDir, {
              action: 'leave',
              groupId,
              sessionId: args.sessionId,
            }, ctx)
            return { text: `Removed ${args.sessionId} from group "${group.name}".` }
          }
          throw new Error('Unknown group operation')
        } catch (error) {
          throw toolFailure(error)
        }
      },
    },
    {
      name: 'multi_agent_create_member',
      description:
        'Leader only: creates a brand-new member agent in the current workspace of the leader. When DSH subagents are available it is spawned as a subagent of the leader (otherwise a plain session is created). The new agent has no conversation history and joins this group as a member.'
        + ' Before use, the group must already have unassigned task modules (task tree split); bind one of them with taskId,'
        + ' and that task assignee becomes the new session, so no session is left without a module. Each task module can bind only one session;'
        + ' groups have a max session limit (default 8, adjustable only by the user on the management page). The new member claims the bound task; the leader can claim its own cards separately with multi_agent_task op="-u".'
        + ' You pick the name (2–24 characters). The agent runs one short setup turn, then stays idle. Model and reasoning effort inherit from the leader by default, or come from the group "New session inheritance" settings;'
        + ' when the leader has full access, the new session also gets full access.',
      parameters: {
        name: { type: 'string', required: true, description: 'New session name, 2–24 characters, short and clear.' },
        taskId: { type: 'string', required: true, description: 'ID of the unassigned task module to bind (from multi_agent_task op="-l").' },
        groupId: { type: 'string', description: 'Group ID; optional when the leader manages only one group.' },
      },
      when: whenLeader,
      output: TOOL_OUTPUT,
      execute: async (args, exec) => {
        const agentId = requireAgentId(exec)
        try {
          const state = await stateOf()
          const groupId = resolveGroupId(state, agentId, args?.groupId, ROLE_LEADER)
          const result = await handleAction(profileDir, {
            action: 'createMemberSession',
            groupId,
            leaderSessionId: agentId,
            name: args?.name,
            taskId: args?.taskId,
          }, ctx)
          const created = result.result
          const group = result.state.groups.find((item) => item.id === groupId)
          const selection = created.selection
            ? `${created.selection.provider} / ${created.selection.model}`
              + `${created.selection.reasoningEffort ? ` (reasoning effort ${created.selection.reasoningEffort})` : ''}`
            : 'session default model'
          return {
            text: [
              `Created member session "${created.title}" [${created.sessionId}] and joined group "${group?.name ?? groupId}" as a member.`,
              `Task module: ${created.taskTitle ?? created.taskId} (${created.taskId})`,
              `Workspace: ${created.workspacePath ?? 'the current workspace of the leader'}`,
              `Model: ${selection}`,
              `Permission: ${created.fullAccess ? 'full access (follows the leader)' : 'session default permission'}`,
              'The new session has no conversation history.',
            ].join('\n'),
          }
        } catch (error) {
          throw toolFailure(error)
        }
      },
    },
    {
      name: 'multi_agent_member',
      description:
        'Member lifecycle. op: -h hand over (leader only; marks the member\'s claimed tasks as handed over, so the member can archive itself) / '
        + '-z archive yourself (members only; the leader cannot archive itself. Every claimed task must be done with a completion note, or handed over by the leader; then the conversation is archived and parked) / '
        + '-g restore an archived member (leader only; requires an unfinished task not assigned to somebody else; the task is assigned to the member). '
        + 'Archiving is always the member\'s own action; the leader cannot archive another conversation directly.',
      parameters: {
        op: {
          type: 'string',
          enum: ['-h', '-z', '-g'],
          description: 'Operation flag, required (-h handover / -z archive self / -g restore).',
        },
        sessionId: { type: 'string', description: '-h and -g: the member session ID. Optional for -z (yourself).' },
        taskId: { type: 'string', description: '-g: unfinished task to assign before restoring.' },
        groupId: { type: 'string', description: 'Group ID; optional when you are in only one group.' },
      },
      when: whenMember,
      output: TOOL_OUTPUT,
      execute: async (args, exec) => {
        const agentId = requireAgentId(exec)
        const op = opOf(args?.op)
        if (!op) throw new Error('Specify the operation with op: -h handover / -z archive yourself / -g restore')
        try {
          const state = await stateOf()
          const groupId = resolveGroupId(state, agentId, args?.groupId)
          let result
          if (op === 'h') {
            if (!args?.sessionId) throw new Error('Handover needs the member sessionId')
            result = await handleAction(profileDir, {
              action: 'handoverMember',
              groupId,
              leaderSessionId: agentId,
              sessionId: args.sessionId,
            }, ctx)
          } else if (op === 'z') {
            result = await handleAction(profileDir, {
              action: 'archiveMember',
              groupId,
              sessionId: agentId,
            }, ctx)
          } else if (op === 'g') {
            if (!args?.sessionId || !args?.taskId) throw new Error('Restore needs sessionId and taskId')
            result = await handleAction(profileDir, {
              action: 'restoreMember',
              groupId,
              leaderSessionId: agentId,
              sessionId: args.sessionId,
              taskId: args.taskId,
            }, ctx)
          } else {
            throw new Error('Unsupported member operation')
          }
          const value = result.result
          if (op === 'h') {
            return {
              text: [
                `Handed over member ${value.sessionId} in group ${value.groupId}.`,
                value.handedOverTasks.length > 0
                  ? `Marked handed over on task(s): ${value.handedOverTasks.join(', ')}`
                  : 'No claimed tasks needed a handover mark.',
                'The member can now use multi_agent_member op="-z" to archive itself.',
              ].join('\n'),
            }
          }
          if (op === 'z') {
            return {
              text: [
                `Archived session ${value.sessionId} in group ${value.groupId} at ${value.archivedAt}.${value.alreadyArchived ? ' (already archived)' : ''}`,
                value.warning ? `Warning: ${value.warning}` : 'The conversation is parked until the leader restores it with a task.',
              ].join('\n'),
            }
          }
          return {
            text: `Restored member ${value.sessionId} in group ${value.groupId} and assigned task ${value.taskId}.`,
          }
        } catch (error) {
          throw toolFailure(error)
        }
      },
    },
    {
      name: 'multi_agent_task',
      description:
        'Unified task space. op: -l view tasks and edges (members) / -c create (title required; status defaults to todo, and done needs a completion note) / -u edit (taskId; title, description, status, completionNote, assigneeSessionId) / '
        + '-d delete (taskId) / -s change status (taskId + status) / -x link (from, to) / -r delete edge (edgeId). '
        + '-c/-u/-d/-x/-r are leader only; -s is for the assignee or the leader. Marking a task done requires completionNote (unless it already has one); a done task with a note is a permanent record that cannot be deleted (TASK_LOCKED). The leader may assign a card to itself. Edges cannot form a cycle.',
      parameters: {
        op: {
          type: 'string',
          enum: ['-l', '-c', '-u', '-d', '-s', '-x', '-r'],
          description: 'Operation flag, required.',
        },
        groupId: { type: 'string', description: 'Group ID; for -l/-c it can be omitted when managing one group.' },
        taskId: { type: 'string', description: '-u/-d/-s: task ID, e.g. task_ab12cd34ef56.' },
        title: { type: 'string', description: '-c/-u: task title, 1–80 characters.' },
        description: { type: 'string', description: '-c/-u: task description, up to 600 characters.' },
        completionNote: { type: 'string', description: '-c/-u/-s: completion note, up to 600 characters; required when the task is done.' },
        status: { type: 'string', enum: TASK_STATUSES, description: '-c/-u/-s: todo / doing / done.' },
        assigneeSessionId: {
          type: 'string',
          description: '-c/-u: assignee session ID (must be a member of this group); pass an empty string with -u to unassign.',
        },
        from: { type: 'string', description: '-x: source task ID.' },
        to: { type: 'string', description: '-x: target task ID.' },
        edgeId: { type: 'string', description: '-r: edge ID, e.g. edge_ab12cd34ef56.' },
      },
      when: whenMember,
      output: TOOL_OUTPUT,
      execute: async (args, exec) => {
        const agentId = requireAgentId(exec)
        try {
          const state = await stateOf()
          const op = opOf(args?.op)
          if (!op) throw new Error('Specify the operation with op: -l list / -c create / -u edit / -d delete / -s change status / -x link / -r delete edge')

          if (op === 'l') {
            const groupId = resolveGroupId(state, agentId, args?.groupId)
            return { text: tasksText(state, groupId, agentId) }
          }

          if (op === 'c') {
            const groupId = resolveGroupId(state, agentId, args?.groupId, ROLE_LEADER)
            requireLeaderOf(state, groupId, agentId)
            const result = await handleAction(profileDir, {
              action: 'createTask',
              groupId,
              leaderSessionId: agentId,
              title: args?.title,
              description: args?.description,
              status: args?.status ?? 'todo',
              completionNote: args?.completionNote,
              assigneeSessionId: args?.assigneeSessionId,
            }, ctx)
            const task = result.result
            return { text: `Created task "${task.title}" [${task.id}] (${taskStatusLabel(task.status)}). The task ID is ${task.id}; members can reference it.` }
          }

          if (op === 'u') {
            const task = requireTask(state, args?.taskId)
            requireLeaderOf(state, task.groupId, agentId)
            const result = await handleAction(profileDir, {
              action: 'updateTask',
              leaderSessionId: agentId,
              taskId: task.id,
              title: args?.title,
              description: args?.description,
              status: args?.status,
              completionNote: args?.completionNote,
              assigneeSessionId: args?.assigneeSessionId,
            }, ctx)
            const updated = result.result
            return { text: `Updated task "${updated.title}" [${updated.id}], current status: ${taskStatusLabel(updated.status)}.` }
          }

          if (op === 'd') {
            const task = requireTask(state, args?.taskId)
            requireLeaderOf(state, task.groupId, agentId)
            const result = await handleAction(profileDir, {
              action: 'deleteTask',
              leaderSessionId: agentId,
              taskId: task.id,
            }, ctx)
            return { text: `Deleted task "${task.title}" [${result.result.id}]; related edges were deleted as well.` }
          }

          if (op === 's') {
            const result = await handleAction(profileDir, {
              action: 'setTaskStatus',
              actorSessionId: agentId,
              taskId: args?.taskId,
              status: args?.status,
              completionNote: args?.completionNote,
            }, ctx)
            const task = result.result
            return { text: `Marked task "${task.title}" [${task.id}] as ${taskStatusLabel(task.status)}.` }
          }

          if (op === 'x') {
            const fromTask = requireTask(state, args?.from)
            const toTask = requireTask(state, args?.to)
            requireLeaderOf(state, fromTask.groupId, agentId)
            const result = await handleAction(profileDir, {
              action: 'createTaskEdge',
              leaderSessionId: agentId,
              from: fromTask.id,
              to: toTask.id,
            }, ctx)
            return { text: `Linked "${fromTask.title}" → "${toTask.title}"; edge ID: ${result.result.id}.` }
          }

          if (op === 'r') {
            const edge = state.taskEdges.find((candidate) => candidate.id === args?.edgeId)
            if (!edge) throw new Error('Edge does not exist or has been deleted')
            requireLeaderOf(state, edge.groupId, agentId)
            const result = await handleAction(profileDir, {
              action: 'deleteTaskEdge',
              leaderSessionId: agentId,
              edgeId: edge.id,
            }, ctx)
            return { text: `Deleted edge [${result.result.id}].` }
          }

          throw new Error('Unknown task operation')
        } catch (error) {
          throw toolFailure(error)
        }
      },
    },
    {
      name: 'multi_agent_activity',
      description:
        'Unified activity list (query only). The standard fs tools (read/write/edit) create and refresh read-only / read-write records and enforce the locks, so agents never register entries by hand. '
        + 'op: -l view (each record carries its short numeric ID; query supports "-a" all, "-s <file name>" match, "-m <member session ID>", and a trailing number for the latest N records; combinable) / '
        + '-d show the added/removed lines captured for one write (needs id).',
      parameters: {
        op: {
          type: 'string',
          enum: ['-l', '-d'],
          description: 'Operation flag, required (-l view / -d write diff for one activity ID).',
        },
        id: { type: 'string', description: '-d: numeric activity ID from the list.' },
        groupId: { type: 'string', description: 'Group ID; optional when you are in only one group.' },
        query: { type: 'string', description: '-l: empty = only entries in use (read-only / read-write); "-a" = all; "-s <file name>" = match by file name; "-m <member session ID>" = all records of that member (a bare session-… also works); trailing number = latest N records (1–200); combinable.' },
      },
      when: whenMember,
      output: TOOL_OUTPUT,
      execute: async (args, exec) => {
        const agentId = requireAgentId(exec)
        const op = opOf(args?.op)
        if (!op) throw new Error('Specify the operation with op: -l view / -d show write diff')
        try {
          const state = await stateOf()
          if (op === 'd') {
            const activity = requireActivity(state, cleanActivityId(args?.id))
            if (!findMembership(state, activity.groupId, agentId)) {
              throw new ApiError(403, 'NOT_IN_GROUP', 'You are not a member of the group that owns this activity')
            }
            return { text: activityDiffText(activity) }
          }
          if (op !== 'l') throw new Error('Unsupported activity operation')
          const groupId = resolveGroupId(state, agentId, args?.groupId)
          return { text: activitiesText(state, groupId, agentId, args?.query) }
        } catch (error) {
          throw toolFailure(error)
        }
      },
    },
    {
      name: 'multi_agent_message',
      description:
        'Unified in-group messages. op: -l view the message queue (the leader sees the whole group, members see only what concerns them) / '
        + '-s send (content required; broadcast by default; for a private message pass mode="private" and recipientSessionId) / '
        + '-r reply (content required; messageId optional when exactly one reply is pending). '
        + 'Delivery is a non-blocking DSH agent notification. Senders who have pending replies must reply first; messages cannot cross groups.',
      parameters: {
        op: {
          type: 'string',
          enum: ['-l', '-s', '-r'],
          description: 'Operation flag, required (-l view / -s send / -r reply).',
        },
        groupId: { type: 'string', description: 'Group ID; optional when you are in only one group.' },
        content: { type: 'string', description: '-s/-r: message content, up to 4000 characters.' },
        mode: { type: 'string', enum: ['broadcast', 'private'], description: '-s: defaults to broadcast.' },
        recipientSessionId: { type: 'string', description: '-s: full sessionId of the private message recipient (use multi_agent_groups op="-m" to look it up).' },
        messageId: { type: 'string', description: '-r: ID of the message to reply to; optional when only one reply is pending.' },
      },
      when: whenMember,
      output: TOOL_OUTPUT,
      execute: async (args, exec) => {
        const agentId = requireAgentId(exec)
        const op = opOf(args?.op)
        if (!op) throw new Error('Specify the operation with op: -l view / -s send / -r reply')
        try {
          if (op === 'l') {
            const state = await stateOf()
            const groupId = resolveGroupId(state, agentId, args?.groupId)
            return { text: messagesText(state, groupId, agentId) }
          }
          if (op === 's') {
            const state = await stateOf()
            const groupId = resolveGroupId(state, agentId, args?.groupId)
            const mode = args?.mode === 'private' ? 'private' : 'broadcast'
            let recipientSessionId = args?.recipientSessionId
            if (mode === 'private' && !recipientSessionId) {
              const others = state.memberships.filter(
                (membership) => membership.groupId === groupId && membership.sessionId !== agentId,
              )
              if (others.length === 1) recipientSessionId = others[0].sessionId
              else throw new ApiError(400, 'NEED_RECIPIENT', 'A private message needs recipientSessionId; get the member ID with multi_agent_groups op="-m" first')
            }
            const result = await handleAction(profileDir, {
              action: 'sendMessage',
              groupId,
              senderSessionId: agentId,
              mode,
              content: args?.content,
              recipientSessionId,
            }, ctx)
            const message = result.result
            const group = requireGroup(state, groupId)
            const outcomes = await deliverMessage(ctx, profileDir, group, message, exec.agent)
            return {
              text: `Your session ID: ${agentId}\nSent a ${message.mode === 'broadcast' ? 'broadcast' : 'private'} message [${message.id}]. ${deliveryText(outcomes)}`,
            }
          }
          if (op === 'r') {
            const state = await stateOf()
            let messageId = args?.messageId
            let groupId = args?.groupId
            if (messageId) {
              const message = state.messages.find((candidate) => candidate.id === messageId)
              if (!message) throw new ApiError(404, 'MESSAGE_NOT_FOUND', 'Message does not exist or is no longer valid')
              groupId = groupId ? resolveGroupId(state, agentId, groupId) : message.groupId
              const delivery = message.deliveries.find((candidate) => candidate.sessionId === agentId)
              if (!delivery) throw new ApiError(403, 'NOT_RECIPIENT', 'You are not a recipient of this message')
              if (delivery.reply) throw new ApiError(409, 'ALREADY_REPLIED', 'You have already replied to this message')
            } else {
              const scopedGroupId = groupId ? resolveGroupId(state, agentId, groupId) : null
              const pending = state.messages.filter((message) =>
                (!scopedGroupId || message.groupId === scopedGroupId)
                && message.deliveries.some((delivery) => delivery.sessionId === agentId && !delivery.reply),
              )
              if (pending.length === 0) throw new ApiError(404, 'NO_PENDING_REPLY', 'You have no messages pending a reply')
              if (pending.length > 1) {
                throw new ApiError(
                  400,
                  'NEED_MESSAGE_ID',
                  `You have ${pending.length} messages pending a reply; pick one with messageId: ${pending.map((message) => message.id).join(', ')}`,
                )
              }
              messageId = pending[0].id
              groupId = pending[0].groupId
            }
            const result = await handleAction(profileDir, {
              action: 'replyMessage',
              groupId,
              messageId,
              sessionId: agentId,
              content: args?.content,
              senderAgent: exec.agent,
            }, ctx)
            const delivery = result.result?.delivery
            if (delivery?.senderKind === 'user') {
              return {
                text: delivery?.delivered
                  ? `Your session ID: ${agentId}\nReplied to user message ${messageId}; the reply was recorded in the message queue of the user.`
                  : `The reply to the user message was recorded but writing to the queue failed: ${delivery?.error ?? 'unknown error'}. Use multi_agent_message op="-l" to check the queue status.`,
              }
            }
            return {
              text: delivery?.delivered
                ? `Your session ID: ${agentId}\nReplied to message ${messageId}; the reply was delivered to ${delivery.senderSessionId} as a DSH agent notification.`
                : `The reply was recorded but delivery to the original sender failed: ${delivery?.error ?? 'unknown error'}. Use multi_agent_message op="-l" to check the queue status.`,
            }
          }
          throw new Error('Unknown message operation')
        } catch (error) {
          throw toolFailure(error)
        }
      },
    },
  ]
  return definitions.map((tool) => ({
    ...tool,
    parameters: objectRootedParameters(tool.parameters),
  }))
}

export function apply(ctx) {
  // Resolve the profile directory from the outer context: the scoped context
  // handed to inject() only carries the services named in the dependency list.
  const profileDir = profileDirOf(ctx)
  const hostContext = ctx
  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(() => {
      const dispose = hostCtx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: createHandler(hostCtx, profileDir, hostContext),
      })
      console.info(`[dsh-multi-agent] Group API mounted at:${API_PREFIX}`)
      return () => {
        dispose()
      }
    }, 'dsh-multi-agent: group API')
  })

  // Agent-facing surface. `when` reads the durable membership table at step
  // preparation time, so a member never sees leader-only tools and a session
  // without pending mail never sees the reply tool. Every execute path checks
  // the same permission again because a group can change between steps.
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => {
      let disposers = []
      try {
        const definitions = buildTools(profileDir, hostContext)
        disposers = definitions.map((tool) => {
          const { when, ...definition } = tool
          // Tool parameters are authored as a property map; providers that
          // validate JSON Schema strictly require an object-rooted schema
          // (otherwise a parameter literally named "description" collides
          // with the schema annotation and is rejected).
          return toolCtx.tools.register({ ...definition, parameters: objectRootedParameters(definition.parameters) }, { when })
        })
        toolRegistration = { state: 'registered', names: definitions.map((tool) => tool.name), error: null }
        console.info(`[dsh-multi-agent] Agent tools registered:${toolRegistration.names.join(', ')}`)
      } catch (error) {
        toolRegistration = { state: 'failed', names: [], error: String(error?.stack ?? error) }
        console.error('[dsh-multi-agent] Failed to register agent tools:', error)
      }
      return () => {
        for (const dispose of disposers) dispose()
        toolRegistration = { state: 'disposed', names: [], error: null }
        console.info('[dsh-multi-agent] Agent tools unregistered')
      }
    }, 'dsh-multi-agent: agent tools')
    toolCtx.effect(
      () => toolCtx.tools.guard(fileActivityGuard(profileDir)),
      'dsh-multi-agent: file activity guard',
    )
    toolCtx.effect(() => {
      const dispose = toolCtx.on('tools/result', (exec, result) => {
        captureActivityDiff(profileDir, exec, result)
        releaseActivityLocks(profileDir, exec?.callId)
      }, { global: true })
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    }, 'dsh-multi-agent: activity lock release')
  })

  // Onboarding surface 1/2: a runtime skill so any agent can load the full
  // usage guide through the standard `skill` tool.
  ctx.inject(['skills'], (skillCtx) => {
    skillCtx.effect(() => {
      if (!GUIDE_SKILL_CONTENT) {
        console.warn('[dsh-multi-agent] Guide skill not registered: content is empty')
        return () => {}
      }
      return skillCtx.skills.register({
        name: GUIDE_SKILL_NAME,
        description: 'Usage guide for dsh-multi-agent: groups, leader/member permissions, member session spawning, task board with assignment and DAG edges, activity list (file usage), broadcast/private messages, token usage report, error codes and workflows. Load before calling any multi_agent_* tool or managing groups, tasks, activities or messages.',
        whenToUse: 'When the user mentions agent groups, leaders/members, task cards, task edges, assigning work to members, spawning member sessions, activity list/file occupancy, token usage, or before calling any multi_agent_* tool.',
        source: 'runtime',
        content: GUIDE_SKILL_CONTENT,
      })
    }, 'dsh-multi-agent: guide skill')
    console.info(`[dsh-multi-agent] Guide skill registered:${GUIDE_SKILL_NAME}`)
  })

  // Onboarding surface 2/2: a one-paragraph policy line so the guide is
  // referenced automatically even before the model inspects the skill catalog.
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(() => promptCtx.systemPrompt.section({
      name: 'multi-agent:guide-reference',
      order: promptCtx.systemPrompt.getSectionOrder('TEAM_POLICY'),
      text: GUIDE_PROMPT,
    }), 'dsh-multi-agent: guide reference')
  })
}
