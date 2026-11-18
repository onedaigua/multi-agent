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
import { readFileSync } from 'node:fs'
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
const MAX_TASK_EDGES = 800
const MAX_TASK_COORD = 20000
const TASK_STATUSES = ['todo', 'doing', 'done']
const DEFAULT_MAX_SESSIONS = 8
const MIN_MAX_SESSIONS = 2
const MAX_MAX_SESSIONS = 32

const ROLE_LEADER = 'leader'
const ROLE_MEMBER = 'member'
const USER_VIEWER_ID = '__user__'
const USER_SENDER_NAME = '用户'

// Onboarding skill: every agent that can see the multi_agent_* tools should be
// able to load the full operating guide without the user pasting it. The body
// lives next to this module so it can be edited without touching code.
const GUIDE_SKILL_NAME = 'multi-agent-guide'
const GUIDE_PROMPT = 'This conversation exposes multi-agent group, task board, activity list and token usage tools (multi_agent_*). Before calling any multi_agent_* tool, creating groups or member sessions, editing tasks, registering file usage or sending group messages, load the multi-agent-guide skill with the skill tool and follow its role, permission and parameter rules; when unsure about your group or role, call multi_agent_groups first.'
let GUIDE_SKILL_CONTENT = ''
try {
  GUIDE_SKILL_CONTENT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'guide.md'), 'utf8')
} catch (error) {
  console.warn('[dsh-multi-agent] 引导技能内容读取失败：', error)
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
    if (required) throw new ApiError(400, 'INVALID_INPUT', `${field} 必须是文本`)
    return ''
  }
  const text = value.trim()
  if (required && text.length === 0) {
    throw new ApiError(400, 'INVALID_INPUT', `${field} 不能为空`)
  }
  if (text.length > max) {
    throw new ApiError(400, 'INVALID_INPUT', `${field} 不能超过 ${max} 个字符`)
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new ApiError(400, 'INVALID_INPUT', `${field} 含有不可见控制字符`)
  }
  return text
}

function cleanMaxSessions(value) {
  const numeric = Number(value)
  if (!Number.isInteger(numeric) || numeric < MIN_MAX_SESSIONS || numeric > MAX_MAX_SESSIONS) {
    throw new ApiError(
      400,
      'INVALID_MAX_SESSIONS',
      `最大会话数必须是 ${MIN_MAX_SESSIONS}–${MAX_MAX_SESSIONS} 的整数`,
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
    throw new ApiError(400, 'INVALID_INPUT', '分组颜色格式不正确')
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
  if (!isPlainObject(value)) throw new ApiError(400, 'INVALID_INPUT', '继承配置格式不正确')
  if (value.mode === 'inherit') return { mode: 'inherit' }
  if (value.mode !== 'custom') {
    throw new ApiError(400, 'INVALID_INPUT', '继承配置只能是 inherit 或 custom')
  }
  const provider = cleanText(value.provider, 120, '模型提供方', true)
  const model = cleanText(value.model, 200, '模型', true)
  const reasoningEffort = value.reasoningEffort === undefined || value.reasoningEffort === null
    ? null
    : cleanText(value.reasoningEffort, 80, '推理等级') || null
  return { mode: 'custom', provider, model, reasoningEffort }
}

function cleanGroupId(value) {
  if (typeof value !== 'string' || !/^grp_[A-Za-z0-9-]{4,64}$/.test(value)) {
    throw new ApiError(400, 'INVALID_GROUP', '分组不存在或已失效')
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
  if (!isSafeSessionId(value)) throw new ApiError(400, 'INVALID_SESSION', '对话标识不合法')
  return value
}

function cleanRole(value) {
  if (value === ROLE_LEADER || value === ROLE_MEMBER) return value
  throw new ApiError(400, 'INVALID_ROLE', '角色只能是组长或成员')
}

function cleanMessageId(value) {
  if (typeof value !== 'string' || !/^msg_[A-Za-z0-9-]{4,64}$/.test(value)) {
    throw new ApiError(400, 'INVALID_MESSAGE', '消息不存在或已失效')
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
    tasks.push({
      id,
      groupId,
      assigneeSessionId,
      title,
      description: typeof candidate.description === 'string'
        ? candidate.description.slice(0, MAX_TASK_DESCRIPTION)
        : '',
      status,
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
    throw new ApiError(400, 'INVALID_TASK', '任务不存在或已失效')
  }
  return value
}

function cleanTaskEdgeId(value) {
  if (typeof value !== 'string' || !/^edge_[A-Za-z0-9-]{4,64}$/.test(value)) {
    throw new ApiError(400, 'INVALID_TASK_EDGE', '连线不存在或已失效')
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
  const addMembership = (groupId, sessionId, role, joinedAt, updatedAt) => {
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
    console.warn(`[dsh-multi-agent] 无法读取 ${file}，已回退为空分组：${error?.message ?? error}`)
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
  if (!group) throw new ApiError(404, 'GROUP_NOT_FOUND', '分组不存在')
  return group
}

function resolveGroupId(state, agentId, groupId, role = null) {
  const memberships = state.memberships.filter(
    (membership) => membership.sessionId === agentId && (!role || membership.role === role),
  )
  if (groupId) {
    const membership = memberships.find((candidate) => candidate.groupId === groupId)
    if (!membership) throw new ApiError(403, 'NOT_IN_GROUP', '你不在这个分组中')
    return groupId
  }
  if (memberships.length === 1) return memberships[0].groupId
  if (memberships.length === 0) {
    throw new ApiError(403, 'NOT_IN_GROUP', role === ROLE_LEADER ? '你没有管理中的分组' : '你还没有加入任何分组')
  }
  const options = memberships.map((membership) => {
    const group = state.groups.find((candidate) => candidate.id === membership.groupId)
    return `${group?.name ?? '未知分组'} [${membership.groupId}]`
  }).join('、')
  throw new ApiError(400, 'NEED_GROUP_ID', `你加入了多个分组，请指定 groupId：${options}`)
}

function ensureUniqueName(state, groupName, exceptId) {
  const folded = groupName.toLowerCase()
  if (state.groups.some((group) => group.id !== exceptId && group.name.toLowerCase() === folded)) {
    throw new ApiError(409, 'NAME_TAKEN', '已有同名分组，请换一个名称')
  }
}

function actionCreateGroup(state, body) {
  if (state.groups.length >= MAX_GROUPS) {
    throw new ApiError(409, 'GROUP_LIMIT', `最多只能创建 ${MAX_GROUPS} 个分组`)
  }
  const groupName = cleanText(body.name, MAX_NAME, '分组名称', true)
  ensureUniqueName(state, groupName)
  if (state.memberships.length >= MAX_MEMBERSHIPS) {
    throw new ApiError(409, 'MEMBERSHIP_LIMIT', '成员记录过多，请先清理一些分组')
  }
  if (!body.leaderSessionId) {
    throw new ApiError(400, 'LEADER_REQUIRED', '创建分组必须指定首任组长')
  }
  const leaderSessionId = cleanSessionId(body.leaderSessionId)
  const group = {
    id: `grp_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    name: groupName,
    description: cleanText(body.description ?? '', MAX_DESCRIPTION, '分组说明'),
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
    const groupName = cleanText(body.name, MAX_NAME, '分组名称', true)
    ensureUniqueName(state, groupName, groupId)
    group.name = groupName
  }
  if (body.description !== undefined) {
    group.description = cleanText(body.description, MAX_DESCRIPTION, '分组说明')
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
        `当前已有 ${currentCount} 个会话，最大会话数不能低于这个数量`,
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
  if (!membership) throw new ApiError(400, 'ASSIGNEE_NOT_MEMBER', '只能把任务分配给这个分组的成员')
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
  if (!membership) throw new ApiError(403, 'NOT_IN_GROUP', '当前对话不在这个分组中')
  if (membership.role !== ROLE_LEADER) {
    throw new ApiError(403, 'NOT_LEADER', '只有这个分组的组长可以修改任务或连线')
  }
}

function requireTask(state, taskId) {
  const task = state.tasks.find((candidate) => candidate.id === taskId)
  if (!task) throw new ApiError(404, 'TASK_NOT_FOUND', '任务不存在或已被删除')
  return task
}

function cleanTaskStatus(value) {
  return TASK_STATUSES.includes(value) ? value : null
}

function actionCreateTask(state, body) {
  if (state.tasks.length >= MAX_TASKS) {
    throw new ApiError(409, 'TASK_LIMIT', `最多只能创建 ${MAX_TASKS} 个任务`)
  }
  const groupId = cleanGroupId(body.groupId)
  requireGroup(state, groupId)
  assertGroupLeader(state, groupId, body.leaderSessionId)
  const status = cleanTaskStatus(body.status)
  if (!status) throw new ApiError(400, 'INVALID_STATUS', '任务状态只能是 todo、doing 或 done')
  const task = {
    id: `task_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    groupId,
    assigneeSessionId: cleanAssignee(state, groupId, body.assigneeSessionId),
    title: cleanText(body.title, MAX_TASK_TITLE, '任务标题', true),
    description: cleanText(body.description ?? '', MAX_TASK_DESCRIPTION, '任务说明'),
    status,
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
    task.title = cleanText(body.title, MAX_TASK_TITLE, '任务标题', true)
  }
  if (body.description !== undefined) {
    task.description = cleanText(body.description, MAX_TASK_DESCRIPTION, '任务说明')
  }
  if (body.status !== undefined) {
    const status = cleanTaskStatus(body.status)
    if (!status) throw new ApiError(400, 'INVALID_STATUS', '任务状态只能是 todo、doing 或 done')
    task.status = status
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
  if (!status) throw new ApiError(400, 'INVALID_STATUS', '任务状态只能是 todo、doing 或 done')
  const actorId = typeof body.actorSessionId === 'string' ? body.actorSessionId : ''
  if (actorId) {
    const membership = findMembership(state, task.groupId, actorId)
    if (!membership) throw new ApiError(403, 'NOT_IN_GROUP', '当前对话不在这个分组中')
    const isLeader = membership.role === ROLE_LEADER
    const isAssignee = task.assigneeSessionId === actorId
    if (!isLeader && !isAssignee) {
      throw new ApiError(403, 'NOT_ASSIGNEE', '只有任务负责人或组长可以更改任务状态')
    }
  }
  task.status = status
  task.updatedAt = isoNow()
  state.updatedAt = isoNow()
  return task
}

function actionDeleteTask(state, body) {
  const taskId = cleanTaskId(body.taskId)
  const task = requireTask(state, taskId)
  assertGroupLeader(state, task.groupId, body.leaderSessionId)
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
    throw new ApiError(400, 'TASK_GROUP_MISMATCH', '两张任务卡属于不同分组，不能连线')
  }
  assertGroupLeader(state, fromTask.groupId, body.leaderSessionId)
  if (from === to) throw new ApiError(400, 'TASK_SELF_LOOP', '不能把任务连到自己')
  if (state.taskEdges.some((edge) => edge.from === from && edge.to === to)) {
    throw new ApiError(409, 'TASK_EDGE_EXISTS', '这两个任务之间已经有一条连线')
  }
  if (state.taskEdges.length >= MAX_TASK_EDGES) {
    throw new ApiError(409, 'TASK_EDGE_LIMIT', `最多只能创建 ${MAX_TASK_EDGES} 条连线`)
  }
  if (taskPathExists(state, to, from)) {
    throw new ApiError(409, 'TASK_CYCLE', '这条连线会形成环形依赖，任务流程必须是有向无环图')
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
  if (!edge) throw new ApiError(404, 'TASK_EDGE_NOT_FOUND', '连线不存在或已被删除')
  assertGroupLeader(state, edge.groupId, body.leaderSessionId)
  state.taskEdges = state.taskEdges.filter((candidate) => candidate.id !== edgeId)
  state.updatedAt = isoNow()
  return { id: edge.id }
}

// ---- 执行列表：组内共享的工作区文件使用记录 ----
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
const ACTIVITY_STATE_LABELS = { read: '只读', write: '读写' }
const LEGACY_ACTIVITY_STATES = { using: 'write', viewing: 'read', modified: 'read' }
const ACTIVITY_OP_LABELS = { open: '使用', move: '移动', copy: '复制' }
const AUTO_ACTIVITY_TOOLS = new Map([
  ['read', { op: 'open', state: 'read' }],
  ['write', { op: 'open', state: 'write' }],
  ['edit', { op: 'open', state: 'write' }],
])
const FILE_LOCK_STATES = ['read', 'write']

function cleanActivityId(value) {
  if (typeof value !== 'string' || !/^act_[A-Za-z0-9-]{4,64}$/.test(value)) {
    throw new ApiError(400, 'INVALID_ACTIVITY', '执行记录 ID 格式不正确')
  }
  return value
}

function cleanActivityPath(value) {
  const text = cleanText(value, MAX_ACTIVITY_PATH, '文件路径', true)
  const normalized = text.replaceAll('\\', '/').replace(/\/{2,}/g, '/')
  if (normalized === '/' || normalized === './' || normalized.length === 0) {
    throw new ApiError(400, 'INVALID_PATH', '文件路径格式不正确')
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
    throw new ApiError(400, 'INVALID_ACTIVITY_OP', '操作只能是 open（使用）、move（移动）或 copy（复制）')
  }
  return value
}

function cleanActivityState(value) {
  if (value === undefined || value === null || value === '') return 'read'
  if (!ACTIVITY_STATES.includes(value)) {
    throw new ApiError(400, 'INVALID_ACTIVITY_STATE', '状态只能是 read（只读）或 write（读写）')
  }
  return value
}

function cleanActivityNote(value) {
  return cleanText(value ?? '', MAX_ACTIVITY_NOTE, '备注')
}

function cleanActivityDestination(value) {
  return cleanText(value ?? '', MAX_ACTIVITY_DESTINATION, '目标目录')
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
    if (!/^act_[A-Za-z0-9-]{4,64}$/.test(id) || seen.has(id)) continue
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
  if (!activity) throw new ApiError(404, 'ACTIVITY_NOT_FOUND', '执行记录不存在或已被删除')
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
    .map((activity) => `${activity.sessionId}（${activityStateLabel(activity.state)}，${formatActivityTime(activity.updatedAt)}）`)
    .join('、')
  return `文件正在被占用：${detail}`
    + `${conflicts.length > 3 ? ` 等 ${conflicts.length} 条记录` : ''}。`
    + '只读可多人同时打开，读写必须独占；请等待对方释放或先删除记录。'
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
    throw new ApiError(403, 'NOT_IN_GROUP', '你不在这个分组中')
  }
  if (state.activities.length >= MAX_ACTIVITIES) {
    throw new ApiError(409, 'ACTIVITY_LIMIT', `最多保留 ${MAX_ACTIVITIES} 条执行记录`)
  }
  const path = cleanActivityPath(body.path)
  const op = cleanActivityOp(body.op)
  const activityState = cleanActivityState(body.state)
  const destination = cleanActivityDestination(body.destination)
  const note = cleanActivityNote(body.note)
  if ((op === 'move' || op === 'copy') && destination.length === 0) {
    throw new ApiError(400, 'DESTINATION_REQUIRED', '移动或复制需要提供目标目录')
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
    throw new ApiError(403, 'NOT_ACTIVITY_OWNER', '只有创建者或组长可以修改这条执行记录')
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
    throw new ApiError(400, 'DESTINATION_REQUIRED', '移动或复制需要提供目标目录')
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
    throw new ApiError(403, 'NOT_ACTIVITY_OWNER', '只有创建者或组长可以删除这条执行记录')
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
    for (const membership of memberships) {
      const conflicts = lockConflictsOf(state, membership.groupId, filePath, wanted, null, sessionId)
      if (conflicts.length > 0) {
        const detail = conflicts
          .slice(0, 3)
          .map((activity) => `${activity.sessionId}（${activityStateLabel(activity.state)}，${formatActivityTime(activity.updatedAt)}）`)
          .join('、')
        return `执行列表占用冲突：文件 ${filePath} 正被 ${detail} 占用。只读可多人同时打开，读写必须独占；请等待对方释放，或先释放/改为只读后再使用该文件。`
      }
    }
    return undefined
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
      if (value.length === 0) throw new ApiError(400, 'INVALID_QUERY', '-s 后面需要提供文件名')
      result.file = value
      index += 1
      continue
    }
    if (token === '-m') {
      const value = tokens[index + 1] ?? ''
      if (value.length === 0) throw new ApiError(400, 'INVALID_QUERY', '-m 后面需要提供组员会话 ID')
      if (!isSafeSessionId(value)) throw new ApiError(400, 'INVALID_QUERY', '组员会话 ID 不合法')
      result.member = value
      index += 1
      continue
    }
    if (token.startsWith('session-')) {
      if (!isSafeSessionId(token)) throw new ApiError(400, 'INVALID_QUERY', '组员会话 ID 不合法')
      if (result.member.length > 0 && result.member !== token) {
        throw new ApiError(400, 'INVALID_QUERY', '只能按一个组员会话 ID 筛选')
      }
      result.member = token
      continue
    }
    if (/^\d+$/.test(token)) {
      if (result.limit > 0) throw new ApiError(400, 'INVALID_QUERY', '条数只能指定一次')
      const limit = Number(token)
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new ApiError(400, 'INVALID_QUERY', '条数需在 1–200 之间')
      }
      result.limit = limit
      continue
    }
    throw new ApiError(400, 'INVALID_QUERY', '筛选参数只支持 -a、-s 文件名、-m 组员ID，以及末尾数字条数')
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
    list = list.filter((activity) => FILE_LOCK_STATES.includes(activity.state))
  }
  list.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
  const total = list.length
  const limit = filters.limit > 0 ? filters.limit : 80
  const shown = list.slice(0, limit)
  const lines = [`执行列表 · 分组「${group.name}」[${group.id}] · 共 ${total} 条`]
  lines.push('（默认只看占用中的文件：只读可多人共享、读写独占；query 传 -a 全部、-s 文件名 筛选、-m 组员ID 看该组员全部记录，末尾数字取最近 N 条，可组合）')
  if (total === 0) {
    lines.push(
      filters.member.length > 0
        ? `组员 ${filters.member} 在这个分组还没有执行记录。`
        : filters.all
          ? '还没有任何执行记录。'
          : (filters.file.length > 0 ? '没有匹配且被占用的文件。' : '当前没有文件被占用。'),
    )
    return lines.join('\n')
  }
  for (const activity of shown) {
    const opText = ACTIVITY_OP_LABELS[activity.op] ?? activity.op
    const stateText = ACTIVITY_STATE_LABELS[activity.state] ?? activity.state
    const destination = activity.destination ? ` → ${activity.destination}` : ''
    lines.push(
      `- [${activity.id}] [${stateText}] 成员 ${activity.sessionId}`
      + ` · ${opText} ${activity.path}${destination}`
      + ` · ${formatActivityTime(activity.updatedAt)}`
      + ` · 来源 ${activity.source === 'auto' ? '自动' : '手动'}`,
    )
    if (activity.note) lines.push(`  备注：${activity.note}`)
  }
  if (total > shown.length) lines.push(`…… 其余 ${total - shown.length} 条省略（用末尾数字指定条数）`)
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
    throw new ApiError(404, 'SESSION_NOT_FOUND', '找不到这个对话，它可能已被关闭或删除')
  }
  return agent
}

function currentSelectionOf(controller, agent) {
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
        `分组「${group.name}」设置的模型当前不可用，请组长在管理页重新选择新的会话继承配置`,
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
 * Create a blank member session in the leader's workspace. The new session
 * starts with no conversation history; only model/reasoning and (when the
 * leader is fully privileged) the permission preset are inherited.
 * @param ctx Host plugin context.
 * @param state Normalized plugin state (mutated in place).
 * @param body Request body (`groupId`, `leaderSessionId`, `name`).
 * @returns Public creation result for the API and the tool output.
 */
async function actionCreateMemberSession(ctx, state, body) {
  const groupId = cleanGroupId(body.groupId)
  const group = requireGroup(state, groupId)
  const leaderSessionId = cleanSessionId(body.leaderSessionId)
  const membership = findMembership(state, groupId, leaderSessionId)
  if (!membership || membership.role !== ROLE_LEADER) {
    throw new ApiError(403, 'NOT_LEADER', '只有这个分组的组长可以创建新成员会话')
  }
  const title = cleanText(body.name, MAX_SPAWN_TITLE, '会话名字', true)
  if (state.memberships.length >= MAX_MEMBERSHIPS) {
    throw new ApiError(409, 'MEMBERSHIP_LIMIT', '成员记录过多，请先清理一些分组')
  }
  const maxSessions = group.maxSessions ?? DEFAULT_MAX_SESSIONS
  const memberCount = state.memberships.filter((membership) => membership.groupId === groupId).length
  if (memberCount >= maxSessions) {
    throw new ApiError(409, 'GROUP_FULL', `分组「${group.name}」最多容纳 ${maxSessions} 个会话`)
  }
  const unassignedTasks = state.tasks.filter(
    (candidate) => candidate.groupId === groupId && !candidate.assigneeSessionId,
  )
  if (unassignedTasks.length === 0) {
    throw new ApiError(
      409,
      'NO_TASK_MODULE',
      '请先在任务页为这个分组创建任务树并拆成任务模块（至少留一个未分配模块），再创建成员会话',
    )
  }
  if (!body.taskId) {
    throw new ApiError(400, 'TASK_REQUIRED', '创建成员会话必须绑定一个任务模块，请传 taskId')
  }
  const taskId = cleanTaskId(body.taskId)
  const task = requireTask(state, taskId)
  if (task.groupId !== groupId) {
    throw new ApiError(400, 'TASK_GROUP_MISMATCH', '只能绑定这个分组里的任务模块')
  }
  if (task.assigneeSessionId) {
    throw new ApiError(409, 'TASK_ALREADY_ASSIGNED', '这个任务模块已经绑定了负责人，请换一个未分配的模块')
  }
  const controller = ctx?.get?.('sessionController')
  if (!controller || typeof controller.create !== 'function' || !controller.agents?.selectForNextRequest) {
    throw new ApiError(503, 'SESSION_SERVICE', '会话服务暂时不可用，无法创建新会话')
  }

  const leaderAgent = await resolveLiveAgent(controller, leaderSessionId)
  const selection = await spawnSelectionFor(controller, group, leaderAgent)
  const workspace = leaderWorkspaceOf(ctx, leaderSessionId)
  const request = workspace && (workspace.workspaceId ?? workspace.id)
    ? { workspaceId: workspace.workspaceId ?? workspace.id }
    : { cwd: leaderAgent.session?.header?.cwd ?? process.cwd() }
  const created = await controller.create(request)
  const sessionId = cleanSessionId(created?.sessionId)

  const newAgent = await resolveLiveAgent(controller, sessionId)
  // A pending model/selection event makes the very first turn of the new
  // session use exactly the inherited or configured model.
  if (selection) controller.agents.selectForNextRequest(newAgent, selection)
  const fullAccess = applyFullAccessIfNeeded(ctx, leaderAgent, newAgent)
  await controller.rename({ sessionId, title })

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
      throw new ApiError(409, 'GROUP_FULL', `这个分组最多容纳 ${maxSessions} 个会话`)
    }
  }

  if (current && current.role === ROLE_LEADER && role === ROLE_MEMBER) {
    throw new ApiError(
      409,
      'LEADER_REQUIRED',
      '分组必须保留组长；请先把另一位成员设为组长（可接管），再调整当前组长',
    )
  }

  if (role === ROLE_LEADER && currentLeaderId && currentLeaderId !== sessionId && body.takeover !== true) {
    throw new ApiError(409, 'LEADER_EXISTS', '该组已经有组长，需要接管组长后才能加入', {
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
      throw new ApiError(409, 'MEMBERSHIP_LIMIT', '成员记录过多，请先清理一些分组')
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

function requireGroupMember(state, groupId, sessionId) {
  const membership = findMembership(state, groupId, sessionId)
  if (!membership) throw new ApiError(403, 'NOT_IN_GROUP', '当前对话不在这个分组中')
  return membership
}

function actionSendMessage(state, body) {
  const groupId = cleanGroupId(body.groupId)
  requireGroup(state, groupId)
  const senderKind = body.senderKind === 'user' ? 'user' : 'agent'
  const senderSessionId = senderKind === 'user' ? null : cleanSessionId(body.senderSessionId)
  if (senderKind === 'agent') requireGroupMember(state, groupId, senderSessionId)
  const content = cleanText(body.content, MAX_MESSAGE, '消息内容', true)
  if (body.mode !== 'broadcast' && body.mode !== 'private') {
    throw new ApiError(400, 'INVALID_MODE', '消息类型只能是广播或私聊')
  }

  const pending = senderKind === 'user' ? 0 : pendingReplyCount(state, groupId, senderSessionId)
  if (pending > 0) {
    throw new ApiError(409, 'PENDING_REPLY', `还有 ${pending} 条消息待回复，请先回复再发送`, {
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
      throw new ApiError(400, 'SELF_PRIVATE', '不能给自己发送私聊消息')
    }
    if (!findMembership(state, groupId, recipientSessionId)) {
      throw new ApiError(400, 'NOT_IN_GROUP', '私聊对象不在这个分组中')
    }
    recipients = [recipientSessionId]
  } else {
    recipients = groupMembers.map((membership) => membership.sessionId)
  }
  if (recipients.length === 0) {
    throw new ApiError(409, 'NO_RECIPIENTS', '这个分组还没有其他成员可以接收消息')
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
  const content = cleanText(body.content, MAX_MESSAGE, '回复内容', true)
  const message = state.messages.find((candidate) => candidate.id === messageId && candidate.groupId === groupId)
  if (!message) throw new ApiError(404, 'MESSAGE_NOT_FOUND', '消息不存在或已失效')
  const delivery = message.deliveries.find((candidate) => candidate.sessionId === sessionId)
  if (!delivery) throw new ApiError(403, 'NOT_RECIPIENT', '只有收到消息的成员可以回复')
  if (delivery.reply) throw new ApiError(409, 'ALREADY_REPLIED', '已经回复过这条消息了')
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
  if (!message) throw new ApiError(404, 'MESSAGE_NOT_FOUND', '消息不存在或已失效')
  const delivery = message.deliveries.find((candidate) => candidate.sessionId === sessionId)
  if (!delivery || !delivery.reply) throw new ApiError(404, 'REPLY_NOT_FOUND', '没有找到这条回复')
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
    `【Agent 分组回复｜${group.name}】`,
    `${replierName} 回复了你的消息：${delivery.reply.content}`,
    `原消息编号：${messageId}`,
  ].join('\n')

  delivery.reply.status = 'pending'
  delivery.reply.error = null
  try {
    const controller = ctx?.get?.('sessionController')
    if (!controller || typeof controller.prompt !== 'function') {
      throw new Error('sessionController 服务不可用')
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
  if (!message) throw new ApiError(404, 'MESSAGE_NOT_FOUND', '消息不存在或已失效')
  const delivery = message.deliveries.find((candidate) => candidate.sessionId === sessionId)
  if (!delivery) throw new ApiError(404, 'DELIVERY_NOT_FOUND', '没有找到这次投递记录')
  const status = body.ok === false ? 'failed' : 'sent'
  const error = typeof body.error === 'string' ? body.error.slice(0, 300) : null
  if (body.reply === true) {
    if (!delivery.reply) throw new ApiError(404, 'REPLY_NOT_FOUND', '没有找到这条回复')
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
    throw new ApiError(400, 'INVALID_ACTION', '请求缺少 action')
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
      case 'recordAutoActivity':
        result = actionRecordAutoActivity(state, body)
        break
      case 'createMemberSession':
        result = await actionCreateMemberSession(ctx, state, body)
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
        throw new ApiError(400, 'INVALID_ACTION', `不支持的操作：${body.action}`)
    }
    if (body.action === 'recordAutoActivity' && result && result.recorded === 0) {
      // No group membership matched: keep the hot path (every fs tool call)
      // from rewriting the state file for nothing.
      return { state: publicState(state), result }
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
    throw new ApiError(403, 'CROSS_ORIGIN', '只允许从当前 DSH 页面访问分组数据')
  }
  if (!expected && origin !== 'null') {
    throw new ApiError(403, 'CROSS_ORIGIN', '只允许从当前 DSH 页面访问分组数据')
  }
}

async function readJsonBody(req) {
  const contentType = String(req.headers['content-type'] ?? '')
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new ApiError(415, 'INVALID_CONTENT_TYPE', '请求格式必须是 JSON')
  }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      throw new ApiError(413, 'BODY_TOO_LARGE', '请求内容过大')
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new ApiError(400, 'INVALID_JSON', '请求 JSON 无法解析')
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
          throw new ApiError(503, 'SESSION_SERVICE', '暂时无法读取模型列表')
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
          throw new ApiError(403, 'BAD_REQUEST_HEADER', '缺少插件请求标记')
        }
        const body = await readJsonBody(req)
        const { state, result } = await handleAction(profileDir, body, hostContext)
        sendJson(res, 200, { ok: true, state, result })
        return
      }
      throw new ApiError(404, 'NOT_FOUND', '接口不存在')
    } catch (error) {
      if (error instanceof ApiError) {
        sendJson(res, error.status, {
          ok: false,
          error: { code: error.code, message: error.message, ...error.extra },
        })
        return
      }
      console.error('[dsh-multi-agent] 请求处理失败：', error)
      sendJson(res, 500, {
        ok: false,
        error: { code: 'INTERNAL', message: '分组服务暂时不可用，请稍后重试' },
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
      text: { type: 'string', description: '给模型阅读的结果摘要。' },
    },
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

function shortSession(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return '未知对话'
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
    const suffix = leader ? `（当前组长：${leader}，可用 takeover 接管）` : ''
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
  if (!id) throw new Error('这个工具只能由某个对话中的 Agent 调用')
  return id
}

function findAgentMembership(state, groupId, agentId) {
  return state.memberships.find(
    (membership) => membership.groupId === groupId && membership.sessionId === agentId,
  )
}

function requireLeaderOf(state, groupId, agentId) {
  const membership = findAgentMembership(state, groupId, agentId)
  if (!membership) throw new Error('当前对话不在这个分组中，不能管理它')
  if (membership.role !== ROLE_LEADER) throw new Error('只有这个分组的组长可以执行该操作')
  return membership
}

function memberLines(state, groupId, agentId) {
  const group = requireGroup(state, groupId)
  const members = state.memberships.filter((membership) => membership.groupId === groupId)
  const mine = members.find((membership) => membership.sessionId === agentId)
  const lines = [
    `分组「${group.name}」[${group.id}]`,
    `你的会话 ID：${agentId}`,
    `你在本组的角色：${mine ? (mine.role === ROLE_LEADER ? '组长' : '成员') : '未加入'}`,
    `成员（${members.length} 个，私聊时 recipientSessionId 直接复制完整 ID）：`,
  ]
  for (const membership of members) {
    lines.push(
      `- ${membership.sessionId} · ${membership.role === ROLE_LEADER ? '组长' : '成员'}`
      + `${membership.sessionId === agentId ? '（你）' : ''}`,
    )
  }
  return lines.join('\n')
}

function groupsText(state, agentId) {
  if (state.groups.length === 0) {
    return `你的会话 ID：${agentId}\n当前还没有任何 Agent 分组。`
  }
  const lines = [`你的会话 ID：${agentId}`, `共 ${state.groups.length} 个分组：`]
  for (const group of state.groups) {
    const members = state.memberships.filter((membership) => membership.groupId === group.id)
    const mine = members.find((membership) => membership.sessionId === agentId)
    const leader = members.find((membership) => membership.role === ROLE_LEADER)
    const memberText = members.length === 0
      ? '暂无成员'
      : members.map((membership) =>
        `${membership.sessionId}(${membership.role === ROLE_LEADER ? '组长' : '成员'})`,
      ).join('、')
    lines.push(
      `- ${group.name} [${group.id}] 我的角色：${mine ? (mine.role === ROLE_LEADER ? '组长' : '成员') : '未加入'}；`
      + `组长：${leader ? leader.sessionId : '空缺'}（成员 ${members.length}/${group.maxSessions ?? DEFAULT_MAX_SESSIONS}）；成员：${memberText}`,
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
    return `当前工作区${workspacePath ? `（${workspacePath}）` : ''}没有可添加的会话；请先在工作区中创建或打开一个对话。`
  }
  const lines = [
    `当前工作区${workspacePath ? `（${workspacePath}）` : ''}可添加的会话（${items.length} 个）：`,
    ...items.map((item) => `- ${item.sessionId}${item.running ? ' [运行中]' : ''}${item.cwd ? ` · ${item.cwd}` : ''}`),
  ]
  return lines.join('\n')
}

/**
 * Deliver one outgoing queue message to every recipient as a `steer`
 * interjection, then persist each delivery outcome. The queue row is written
 * before this runs, so a failed delivery is retryable rather than lost.
 */
async function deliverMessage(ctx, profileDir, group, message) {
  const controller = ctx?.get?.('sessionController')
  if (!controller || typeof controller.prompt !== 'function') {
    throw new Error('sessionController 服务不可用')
  }
  const sender = message.senderKind === 'user'
    ? USER_SENDER_NAME
    : shortSession(message.senderSessionId)
  const outcomes = []
  for (const delivery of message.deliveries) {
    const text = [
      `【分组消息｜${group.name}】`,
      `${sender} 向你发送了一条消息：`,
      '',
      message.content,
      '',
      `消息编号：${message.id}`,
      '收到后必须回复：调用 multi_agent_message 工具（op="-r"），传 content 即可回复。',
    ].join('\n')
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
    `${outcome.sessionId}：${outcome.ok ? '已插话送达' : `投递失败（${outcome.error}）`}`,
  ).join('；')
}

function messagesText(state, groupId, agentId) {
  const group = requireGroup(state, groupId)
  const view = messagesForViewer(state, groupId, agentId)
  if (view.messages.length === 0) {
    return `你的会话 ID：${agentId}\n分组「${group.name}」[${group.id}] 暂时没有消息。`
      + `你是${view.isLeader ? '组长，可查看全组广播和私聊' : '成员，只能查看与自己相关的消息'}。`
  }
  const lines = [
    `你的会话 ID：${agentId}`,
    `分组「${group.name}」[${group.id}] 消息队列（你是${view.isLeader ? '组长，可查看全组广播和私聊' : '成员，仅显示与自己相关的消息'}）：`,
  ]
  for (const message of view.messages.slice(-50)) {
    const recipient = message.mode === 'private'
      ? message.recipientSessionId
      : `${message.deliveries.length} 位成员`
    const sender = message.senderKind === 'user'
      ? `${USER_SENDER_NAME}（控制台）`
      : message.senderSessionId
    lines.push(
      `- [${message.id}] ${timeText(message.createdAt)} ${sender} → ${recipient}：${message.content}`,
    )
    for (const delivery of message.deliveries) {
      const replyState = delivery.reply
        ? delivery.reply.status === 'sent'
          ? (message.senderKind === 'user' ? '已回复用户' : '已插话送达')
          : delivery.reply.status === 'failed'
            ? '回复送达失败'
            : '回复投递中'
        : '待回复'
      lines.push(
        `  · ${delivery.sessionId}：${delivery.status === 'sent' ? '已送达' : delivery.status === 'failed' ? '投递失败' : '投递中'}`
        + `${delivery.reply ? `；回复：${delivery.reply.content}（${replyState}）` : '；待回复'}`,
      )
    }
  }
  return lines.join('\n')
}

function taskStatusLabel(status) {
  if (status === 'doing') return '进行中'
  if (status === 'done') return '已完成'
  return '待开始'
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
  const header = `你的会话 ID：${agentId}\n分组「${group.name}」[${group.id}] 任务空间（共 ${tasks.length} 个任务；成员 ${memberCount}/${maxSessions}，未分配任务模块 ${unassignedCount} 个）。你是${isLeader ? '组长，可创建、修改、删除任务和连线' : '成员，任务只读；只有组长可修改任务和连线'}。`
  if (tasks.length === 0) {
    return `${header}\n这个分组还没有任务。${isLeader ? '可用 multi_agent_task op="-c" 创建第一张任务卡片。' : '等组长创建任务后再用 multi_agent_task op="-l" 查看。'}`
  }
  const lines = [header, '任务列表：']
  for (const task of tasks) {
    const assignee = task.assigneeSessionId
      ? `负责人 ${task.assigneeSessionId}${task.assigneeSessionId === agentId ? '（你）' : ''}`
      : '未分配'
    lines.push(`- [${task.id}] ${task.title}（${taskStatusLabel(task.status)}，${assignee}）`)
    if (task.description) lines.push(`    说明：${task.description}`)
  }
  lines.push(edges.length === 0 ? '连线：暂无' : '连线：')
  for (const edge of edges) {
    const from = tasks.find((task) => task.id === edge.from)
    const to = tasks.find((task) => task.id === edge.to)
    lines.push(`- [${edge.id}] ${from?.title ?? edge.from} → ${to?.title ?? edge.to}`)
  }
  lines.push(
    `提示：任务 ID 可直接交给组员引用；${isLeader ? '修改/删除任务用 multi_agent_task op="-u"/"-d"，连线用 op="-x"/"-r"。' : '需要变更时请联系组长。'}`,
  )
  return lines.join('\n')
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

  return [
    {
      name: 'multi_agent_groups',
      description:
        '查看分组信息（统一入口）。op="-l"（默认）列出你的会话 ID、所有分组、你在每组的角色、组长与成员；'
        + 'op="-m" 查看某个分组的成员（私聊前复制 recipientSessionId）；'
        + 'op="-c" 扫描当前工作区可加入分组的会话。',
      parameters: {
        op: {
          type: 'string',
          enum: ['-l', '-m', '-c'],
          description: '操作：-l 列表（默认）/ -m 成员 / -c 候选会话。',
        },
        groupId: { type: 'string', description: 'op="-m" 时的分组 ID；仅加入一个分组时可省略。' },
        includeSessions: {
          type: 'boolean',
          description: '兼容旧参数：为 true 时在列表后附带当前工作区可加入的会话。',
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
          if (op !== 'l') throw new Error('multi_agent_groups 支持 op="-l"（列表）、"-m"（成员）、"-c"（候选会话）')
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
        '分组操作统一入口。op：-n 新建（创建者为组长）/ -j 加入 / -x 退出 / -u 修改名称说明颜色 / -d 删除 / '
        + '-a 添加成员 / -r 移除成员 / -s 调整角色 / -t 扫描可加入的会话。'
        + '-u/-d/-a/-r/-s 需要组长权限；-x 不传 groupId 时退出全部。',
      parameters: {
        op: {
          type: 'string',
          enum: ['-n', '-j', '-x', '-u', '-d', '-a', '-r', '-s', '-t'],
          description: '操作标识，必须传。',
        },
        groupId: {
          type: 'string',
          description: '分组 ID。-u/-d/-a/-r/-s 仅管理一个分组时可省略。-x 省略时退出全部分组。',
        },
        name: { type: 'string', description: '-n/-u：分组名称，最多 40 字。' },
        description: { type: 'string', description: '-n/-u：分组说明，最多 240 字。' },
        color: { type: 'string', description: '-n/-u：六位十六进制颜色，例如 #5b6cf9。' },
        role: { type: 'string', enum: [ROLE_LEADER, ROLE_MEMBER], description: '-j/-a/-s：角色，默认 member。' },
        takeover: { type: 'boolean', description: '-j/-s：目标为组长且已有组长时是否接管。' },
        sessionId: { type: 'string', description: '-a/-r/-s：目标会话完整 sessionId。' },
        action: {
          type: 'string',
          description: '兼容旧版 multi_agent_manage_group 的动作名（update/delete/add_member/remove_member/set_role/list_candidates）。',
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
            throw new Error('请用 op 指定操作：-n 新建 / -j 加入 / -x 退出 / -u 修改 / -d 删除 / -a 添加成员 / -r 移除成员 / -s 调整角色 / -t 候选会话')
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
            return { text: `已创建分组「${group.name}」[${group.id}]，你已自动成为组长。` }
          }
          if (op === 't') {
            const candidates = await candidateSessions(ctx, profileDir, agentId, args?.groupId ?? '')
            return { text: candidatesText(candidates, '') }
          }
          if (op === 'j' || op === 'x') {
            if (op === 'j') {
              if (typeof args?.groupId !== 'string' || args.groupId.trim() === '') {
                throw new Error('加入分组需要 groupId')
              }
              const result = await handleAction(profileDir, {
                action: 'assign',
                groupId: args.groupId,
                sessionId: agentId,
                role: args?.role ?? ROLE_MEMBER,
                takeover: args?.takeover === true,
              }, ctx)
              const group = result.state.groups.find((item) => item.id === args.groupId)
              return { text: `已加入分组「${group?.name ?? args.groupId}」为${result.result?.role === ROLE_LEADER ? '组长' : '成员'}。` }
            }
            const result = await handleAction(profileDir, {
              action: 'leave',
              groupId: args?.groupId,
              sessionId: agentId,
            }, ctx)
            return { text: `已退出 ${result.result?.removed ?? 0} 个分组。` }
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
            return { text: `已更新分组「${group.name}」。` }
          }
          if (op === 'd') {
            await handleAction(profileDir, { action: 'deleteGroup', groupId }, ctx)
            return { text: `已删除分组「${group.name}」及其成员和消息记录。` }
          }
          if (op === 'a' || op === 's') {
            if (typeof args?.sessionId !== 'string' || args.sessionId.trim() === '') {
              throw new Error('请提供要添加或调整的 sessionId')
            }
            const result = await handleAction(profileDir, {
              action: 'assign',
              groupId,
              sessionId: args.sessionId,
              role: args?.role ?? ROLE_MEMBER,
              takeover: args?.takeover === true,
            }, ctx)
            return {
              text: `已把 ${args.sessionId} ${op === 'a' ? '加入' : '调整到'}分组「${group.name}」，角色为${result.result?.role === ROLE_LEADER ? '组长' : '成员'}。`,
            }
          }
          if (op === 'r') {
            if (typeof args?.sessionId !== 'string' || args.sessionId.trim() === '') {
              throw new Error('请提供要移除的 sessionId')
            }
            if (args.sessionId === agentId) throw new Error('不能移除自己；请用 op="-x" 退出分组')
            await handleAction(profileDir, {
              action: 'leave',
              groupId,
              sessionId: args.sessionId,
            }, ctx)
            return { text: `已从分组「${group.name}」移除 ${args.sessionId}。` }
          }
          throw new Error('未知的分组操作')
        } catch (error) {
          throw toolFailure(error)
        }
      },
    },
    {
      name: 'multi_agent_create_member',
      description:
        '仅组长可用：在组长当前工作区创建一个全新的成员会话。新会话没有历史上下文，默认以成员身份加入本分组。'
        + '使用前，分组里必须已经有未分配的任务模块（任务树分块）；必须用 taskId 绑定其中一个模块，'
        + '绑定后该任务负责人就是新会话，避免出现没有负责模块的会话。每个任务模块只能绑定一个会话；'
        + '分组有最大会话数限制（默认 8，仅用户可在管理页调整）。组长本人不领取任务。'
        + '名字由你决定（2–24 字）。模型和推理等级默认继承组长，也可由分组的「新会话继承」配置指定；'
        + '组长为完全权限时，新会话也为完全权限。',
      parameters: {
        name: { type: 'string', required: true, description: '新会话名字，2–24 字，简洁明确。' },
        taskId: { type: 'string', required: true, description: '要绑定的未分配任务模块 ID（来自 multi_agent_task op="-l"）。' },
        groupId: { type: 'string', description: '分组 ID；组长只管理一个分组时可省略。' },
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
              + `${created.selection.reasoningEffort ? `（推理等级 ${created.selection.reasoningEffort}）` : ''}`
            : '会话默认模型'
          return {
            text: [
              `已创建成员会话「${created.title}」[${created.sessionId}]，并加入分组「${group?.name ?? groupId}」作为成员。`,
              `负责模块：${created.taskTitle ?? created.taskId}（${created.taskId}）`,
              `工作区：${created.workspacePath ?? '组长当前工作区'}`,
              `模型：${selection}`,
              `权限：${created.fullAccess ? '完全权限（跟随组长）' : '使用会话默认权限'}`,
              '新会话没有任何历史上下文。',
            ].join('\n'),
          }
        } catch (error) {
          throw toolFailure(error)
        }
      },
    },
    {
      name: 'multi_agent_task',
      description:
        '任务空间统一入口。op：-l 查看任务与连线（成员）/ -c 创建 / -u 修改 / -d 删除 / -s 改完成状态 / '
        + '-x 连线 / -r 删除连线。-c/-u/-d/-x/-r 仅组长；-s 仅任务负责人或组长。'
        + '任务 ID 可直接发给组员引用；连线不能成环。',
      parameters: {
        op: {
          type: 'string',
          enum: ['-l', '-c', '-u', '-d', '-s', '-x', '-r'],
          description: '操作标识，必须传。',
        },
        groupId: { type: 'string', description: '分组 ID；-l/-c 时只管理一个分组可省略。' },
        taskId: { type: 'string', description: '-u/-d/-s：任务 ID，例如 task_ab12cd34ef56。' },
        title: { type: 'string', description: '-c/-u：任务标题，1–80 字。' },
        description: { type: 'string', description: '-c/-u：任务说明，最多 600 字。' },
        status: { type: 'string', enum: TASK_STATUSES, description: '-c/-u/-s：todo / doing / done。' },
        assigneeSessionId: {
          type: 'string',
          description: '-c/-u：负责人会话 ID（必须是本组成员）；-u 传空字符串表示取消归属。',
        },
        from: { type: 'string', description: '-x：起点任务 ID。' },
        to: { type: 'string', description: '-x：终点任务 ID。' },
        edgeId: { type: 'string', description: '-r：连线 ID，例如 edge_ab12cd34ef56。' },
      },
      when: whenMember,
      output: TOOL_OUTPUT,
      execute: async (args, exec) => {
        const agentId = requireAgentId(exec)
        try {
          const state = await stateOf()
          const op = opOf(args?.op)
          if (!op) throw new Error('请用 op 指定操作：-l 列表 / -c 创建 / -u 修改 / -d 删除 / -s 改状态 / -x 连线 / -r 删连线')

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
              assigneeSessionId: args?.assigneeSessionId,
            }, ctx)
            const task = result.result
            return { text: `已创建任务「${task.title}」[${task.id}]（${taskStatusLabel(task.status)}）。任务 ID 为 ${task.id}，可发给组员引用。` }
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
              assigneeSessionId: args?.assigneeSessionId,
            }, ctx)
            const updated = result.result
            return { text: `已更新任务「${updated.title}」[${updated.id}]，当前状态：${taskStatusLabel(updated.status)}。` }
          }

          if (op === 'd') {
            const task = requireTask(state, args?.taskId)
            requireLeaderOf(state, task.groupId, agentId)
            const result = await handleAction(profileDir, {
              action: 'deleteTask',
              leaderSessionId: agentId,
              taskId: task.id,
            }, ctx)
            return { text: `已删除任务「${task.title}」[${result.result.id}]，相关连线已一并删除。` }
          }

          if (op === 's') {
            const result = await handleAction(profileDir, {
              action: 'setTaskStatus',
              actorSessionId: agentId,
              taskId: args?.taskId,
              status: args?.status,
            }, ctx)
            const task = result.result
            return { text: `已把任务「${task.title}」[${task.id}] 更新为${taskStatusLabel(task.status)}。` }
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
            return { text: `已连线「${fromTask.title}」→「${toTask.title}」，连线 ID：${result.result.id}。` }
          }

          if (op === 'r') {
            const edge = state.taskEdges.find((candidate) => candidate.id === args?.edgeId)
            if (!edge) throw new Error('连线不存在或已被删除')
            requireLeaderOf(state, edge.groupId, agentId)
            const result = await handleAction(profileDir, {
              action: 'deleteTaskEdge',
              leaderSessionId: agentId,
              edgeId: edge.id,
            }, ctx)
            return { text: `已删除连线 [${result.result.id}]。` }
          }

          throw new Error('未知的任务操作')
        } catch (error) {
          throw toolFailure(error)
        }
      },
    },
    {
      name: 'multi_agent_activity',
      description:
        '执行列表统一入口。op：-l 查看（默认只看占用中：只读/读写；query 支持 "-a" 全部、"-s 文件名" 匹配、"-m 组员会话ID"、末尾数字取最近 N 条，可组合）/ '
        + '-c 登记 / -u 修改 / -d 删除。组内成员都可查看和登记；修改、删除仅创建者或组长。'
        + '占用规则：read（只读）可多人同时；write（读写）独占，创建时若文件已被他人只读/读写会返回 409 FILE_IN_USE；fs 工具在冲突时会直接拒绝执行；move/copy 需给 destination。',
      parameters: {
        op: {
          type: 'string',
          enum: ['-l', '-c', '-u', '-d'],
          description: '操作标识，必须传。',
        },
        groupId: { type: 'string', description: '分组 ID；只加入一个分组时可省略。' },
        query: { type: 'string', description: '-l：空=只看占用中（只读/读写）；"-a"=全部；"-s 文件名"=按文件名匹配；"-m 组员会话ID"=该组员全部记录（也可直接写 session-…）；末尾数字=最近 N 条（1–200）；可组合。' },
        activityId: { type: 'string', description: '-u/-d：执行记录 ID，例如 act_ab12cd34ef56。' },
        path: { type: 'string', description: '-c/-u：工作区文件路径，建议写绝对路径（相对路径按会话工作区解析）。' },
        state: { type: 'string', enum: ACTIVITY_STATES, description: '-c/-u：read（只读，可多人共享）/ write（读写，独占）。' },
        operation: {
          type: 'string',
          enum: ACTIVITY_OPS,
          description: '-c/-u：open（使用，默认）/ move / copy。',
        },
        destination: { type: 'string', description: '-c/-u：move/copy 的目标目录。' },
        note: { type: 'string', description: '-c/-u：可选备注，最多 240 字。' },
      },
      when: whenMember,
      output: TOOL_OUTPUT,
      execute: async (args, exec) => {
        const agentId = requireAgentId(exec)
        const op = opOf(args?.op)
        if (!op) throw new Error('请用 op 指定操作：-l 查看 / -c 登记 / -u 修改 / -d 删除')
        try {
          if (op === 'l') {
            const state = await stateOf()
            const groupId = resolveGroupId(state, agentId, args?.groupId)
            return { text: activitiesText(state, groupId, agentId, args?.query) }
          }
          if (op === 'c') {
            const known = await stateOf()
            const groupId = resolveGroupId(known, agentId, args?.groupId)
            const result = await handleAction(profileDir, {
              action: 'createActivity',
              sessionId: agentId,
              groupId,
              path: args?.path,
              state: args?.state,
              op: args?.operation,
              destination: args?.destination,
              note: args?.note,
            }, ctx)
            const activity = result.result.activity
            const conflicts = Array.isArray(result.result.conflicts) ? result.result.conflicts : []
            const destination = activity.destination ? ` → ${activity.destination}` : ''
            const lines = [
              `已登记执行记录 [${activity.id}]：${ACTIVITY_STATE_LABELS[activity.state] ?? activity.state}`
              + ` · ${ACTIVITY_OP_LABELS[activity.op] ?? activity.op} ${activity.path}${destination}`
              + ` · ${formatActivityTime(activity.updatedAt)}`,
            ]
            if (conflicts.length > 0) lines.push(`⚠️ ${activityConflictMessage(conflicts)}`)
            return { text: lines.join('\n') }
          }
          if (op === 'u') {
            const result = await handleAction(profileDir, {
              action: 'updateActivity',
              sessionId: agentId,
              activityId: args?.activityId,
              state: args?.state,
              op: args?.operation,
              path: args?.path,
              destination: args?.destination,
              note: args?.note,
            }, ctx)
            const activity = result.result.activity
            return {
              text: `已更新执行记录 [${activity.id}]：${ACTIVITY_STATE_LABELS[activity.state] ?? activity.state}`
                + ` · ${ACTIVITY_OP_LABELS[activity.op] ?? activity.op} ${activity.path}`
                + `${activity.destination ? ` → ${activity.destination}` : ''}`,
            }
          }
          if (op === 'd') {
            const known = await stateOf()
            const activity = known.activities.find((candidate) => candidate.id === args?.activityId)
            const result = await handleAction(profileDir, {
              action: 'deleteActivity',
              sessionId: agentId,
              activityId: args?.activityId,
            }, ctx)
            return { text: `已删除执行记录 [${result.result.id}]${activity ? `（${activity.path}）` : ''}。` }
          }
          throw new Error('未知的执行列表操作')
        } catch (error) {
          throw toolFailure(error)
        }
      },
    },
    {
      name: 'multi_agent_message',
      description:
        '组内消息统一入口。op：-l 查看消息队列（组长可看全组，成员只看与自己相关的）/ '
        + '-s 发送（默认广播，私聊填 mode="private" 和 recipientSessionId）/ -r 回复待回复消息。'
        + '发送者有待回复消息时必须先回复；不能跨组发送。',
      parameters: {
        op: {
          type: 'string',
          enum: ['-l', '-s', '-r'],
          description: '操作标识，必须传（-l 查看 / -s 发送 / -r 回复）。',
        },
        groupId: { type: 'string', description: '分组 ID；仅加入一个分组时可省略。' },
        content: { type: 'string', description: '-s/-r：消息内容，最多 4000 字。' },
        mode: { type: 'string', enum: ['broadcast', 'private'], description: '-s：默认 broadcast。' },
        recipientSessionId: { type: 'string', description: '-s：私聊目标成员完整 sessionId（可用 multi_agent_groups op="-m" 查看）。' },
        messageId: { type: 'string', description: '-r：要回复的消息 ID；只有一条待回复时可省略。' },
      },
      when: whenMember,
      output: TOOL_OUTPUT,
      execute: async (args, exec) => {
        const agentId = requireAgentId(exec)
        const op = opOf(args?.op)
        if (!op) throw new Error('请用 op 指定操作：-l 查看 / -s 发送 / -r 回复')
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
              else throw new ApiError(400, 'NEED_RECIPIENT', '私聊需要 recipientSessionId；请先用 multi_agent_groups op="-m" 获取成员 ID')
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
            const outcomes = await deliverMessage(ctx, profileDir, group, message)
            return {
              text: `你的会话 ID：${agentId}\n已发送${message.mode === 'broadcast' ? '广播' : '私聊'}消息 [${message.id}]。${deliveryText(outcomes)}`,
            }
          }
          if (op === 'r') {
            const state = await stateOf()
            let messageId = args?.messageId
            let groupId = args?.groupId
            if (messageId) {
              const message = state.messages.find((candidate) => candidate.id === messageId)
              if (!message) throw new ApiError(404, 'MESSAGE_NOT_FOUND', '消息不存在或已失效')
              groupId = groupId ? resolveGroupId(state, agentId, groupId) : message.groupId
              const delivery = message.deliveries.find((candidate) => candidate.sessionId === agentId)
              if (!delivery) throw new ApiError(403, 'NOT_RECIPIENT', '你不是这条消息的收件人')
              if (delivery.reply) throw new ApiError(409, 'ALREADY_REPLIED', '你已经回复过这条消息')
            } else {
              const scopedGroupId = groupId ? resolveGroupId(state, agentId, groupId) : null
              const pending = state.messages.filter((message) =>
                (!scopedGroupId || message.groupId === scopedGroupId)
                && message.deliveries.some((delivery) => delivery.sessionId === agentId && !delivery.reply),
              )
              if (pending.length === 0) throw new ApiError(404, 'NO_PENDING_REPLY', '你当前没有待回复消息')
              if (pending.length > 1) {
                throw new ApiError(
                  400,
                  'NEED_MESSAGE_ID',
                  `你有 ${pending.length} 条待回复消息，请用 messageId 指定：${pending.map((message) => message.id).join('、')}`,
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
            }, ctx)
            const delivery = result.result?.delivery
            if (delivery?.senderKind === 'user') {
              return {
                text: delivery?.delivered
                  ? `你的会话 ID：${agentId}\n已回复用户消息 ${messageId}；回复已记录到用户的消息队列。`
                  : `已记录对用户消息的回复，但写入队列失败：${delivery?.error ?? '未知错误'}。可用 multi_agent_message op="-l" 查看队列状态。`,
              }
            }
            return {
              text: delivery?.delivered
                ? `你的会话 ID：${agentId}\n已回复消息 ${messageId}，回复已插话送达 ${delivery.senderSessionId}。`
                : `已记录回复，但送达原发送者失败：${delivery?.error ?? '未知错误'}。可用 multi_agent_message op="-l" 查看队列状态。`,
            }
          }
          throw new Error('未知的消息操作')
        } catch (error) {
          throw toolFailure(error)
        }
      },
    },
  ]
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
      console.info(`[dsh-multi-agent] 分组 API 已挂载：${API_PREFIX}`)
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
          return toolCtx.tools.register(definition, { when })
        })
        toolRegistration = { state: 'registered', names: definitions.map((tool) => tool.name), error: null }
        console.info(`[dsh-multi-agent] Agent 工具已注册：${toolRegistration.names.join(', ')}`)
      } catch (error) {
        toolRegistration = { state: 'failed', names: [], error: String(error?.stack ?? error) }
        console.error('[dsh-multi-agent] Agent 工具注册失败：', error)
      }
      return () => {
        for (const dispose of disposers) dispose()
        toolRegistration = { state: 'disposed', names: [], error: null }
        console.info('[dsh-multi-agent] Agent 工具已卸载')
      }
    }, 'dsh-multi-agent: agent tools')
    toolCtx.effect(
      () => toolCtx.tools.guard(fileActivityGuard(profileDir)),
      'dsh-multi-agent: file activity guard',
    )
  })

  // Execution list: every file a member opens or edits through the standard
  // fs tools is recorded automatically, so the leader never has to poll the
  // filesystem to learn who is working on what.
  ctx.effect(() => {
    const dispose = ctx.on('session/event', (session, event) => {
      if (!event || event.type !== 'tool/call' || !session?.id) return
      const mapping = AUTO_ACTIVITY_TOOLS.get(event.name)
      if (!mapping) return
      let args
      try {
        args = JSON.parse(event.arguments || '{}')
      } catch {
        return
      }
      const rawPath = args?.path ?? args?.file_path ?? args?.filePath
      if (typeof rawPath !== 'string' || rawPath.trim().length === 0) return
      const cwd = session.header?.cwd
      const path = normalizeActivityFilePath(rawPath, typeof cwd === 'string' ? cwd : undefined)
      handleAction(profileDir, {
        action: 'recordAutoActivity',
        sessionId: session.id,
        path,
        op: mapping.op,
        state: mapping.state,
      }, ctx).catch((error) => {
        console.warn('[dsh-multi-agent] 自动记录执行列表失败：', error?.message ?? error)
      })
    }, { global: true })
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  }, 'dsh-multi-agent: activity observer')

  // Onboarding surface 1/2: a runtime skill so any agent can load the full
  // usage guide through the standard `skill` tool.
  ctx.inject(['skills'], (skillCtx) => {
    skillCtx.effect(() => {
      if (!GUIDE_SKILL_CONTENT) {
        console.warn('[dsh-multi-agent] 引导技能未注册：内容为空')
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
    console.info(`[dsh-multi-agent] 引导技能已注册：${GUIDE_SKILL_NAME}`)
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
