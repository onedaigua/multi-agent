window.__ModuleLoader__.load({
  id: 'dsh-multi-agent',
  factory: (require) => {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const {
      Fragment,
      useEffect,
      useLayoutEffect,
      useMemo,
      useRef,
      useState,
      useSyncExternalStore,
    } = React

    const PACKAGE_NAME = 'dsh-multi-agent'
    const PANEL_ID = 'multi-agent'
    const TASKS_PANEL_ID = 'multi-agent-tasks'
    const API_BASE = '/multi-agent/api'
    const STYLE_ID = 'dsh-multi-agent-styles'
    const ROLE_LEADER = 'leader'
    const ROLE_MEMBER = 'member'
    const USER_VIEWER_ID = '__user__'
    const USER_SENDER_NAME = '用户'
    const COLORS = ['#5b6cf9', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#a855f7', '#ec4899', '#64748b']

    const module = { exports: {} }

    function cx(...values) {
      return values.filter(Boolean).join(' ')
    }

    function shortId(value) {
      if (!value) return '—'
      const text = String(value).replace(/^session[-_]?/i, '')
      if (text.length <= 12) return text
      return `${text.slice(0, 5)}…${text.slice(-4)}`
    }

    function formatDate(value) {
      if (!value) return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return '—'
      try {
        return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
      } catch {
        return date.toISOString().slice(0, 10)
      }
    }

    function formatDateTime(value) {
      if (!value) return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return '—'
      try {
        return date.toLocaleString('zh-CN', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      } catch {
        return date.toISOString().slice(0, 16).replace('T', ' ')
      }
    }

    function roleLabel(role) {
      return role === ROLE_LEADER ? '组长' : '成员'
    }

    function displayNameOf(byId, sessionId) {
      const summary = byId && byId[sessionId]
      const title = summary && typeof summary.displayTitle === 'string' ? summary.displayTitle.trim() : ''
      if (title && title !== sessionId) return title
      return `对话 ${shortId(sessionId)}`
    }

    const NOOP_HOOK = () => null

    function workspaceName(path) {
      if (!path) return '当前工作区'
      const parts = String(path).replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
      return parts[parts.length - 1] || String(path)
    }

    function workspaceSessions(byId, workspaces, workspaceId, preferredCwd) {
      if (!byId) return []
      const eligible = (summary) => Boolean(summary) && summary.origin !== 'subagent' && summary.blank !== true
      const all = Object.keys(byId).map((id) => byId[id]).filter(eligible)
      const workspace = (workspaces || []).find((item) => item && item.workspaceId === workspaceId)
      let scoped = all
      if (workspace && Array.isArray(workspace.sessionIds)) {
        const seen = new Set()
        const next = []
        for (const id of workspace.sessionIds) {
          if (seen.has(id)) continue
          seen.add(id)
          const summary = byId[id]
          if (eligible(summary)) next.push(summary)
        }
        scoped = next
      } else if (preferredCwd) {
        const matching = all.filter((summary) => summary.cwd === preferredCwd)
        if (matching.length > 0) scoped = matching
      }
      return scoped
        .slice()
        .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
    }

    const ICONS = {
      users: h(
        Fragment,
        null,
        h('path', { key: 'a', d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' }),
        h('circle', { key: 'b', cx: '9', cy: '7', r: '4' }),
        h('path', { key: 'c', d: 'M22 21v-2a4 4 0 0 0-3-3.87' }),
        h('path', { key: 'd', d: 'M16 3.13a4 4 0 0 1 0 7.75' }),
      ),
      user: h(
        Fragment,
        null,
        h('path', { key: 'a', d: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2' }),
        h('circle', { key: 'b', cx: '12', cy: '7', r: '4' }),
      ),
      plus: h('path', { d: 'M12 5v14M5 12h14' }),
      crown: h(
        Fragment,
        null,
        h('path', { key: 'a', d: 'M3 8l4.8 4L12 4l4.2 8L21 8l-1.6 11H4.6L3 8z' }),
        h('path', { key: 'b', d: 'M5 22h14' }),
      ),
      edit: h(
        Fragment,
        null,
        h('path', { key: 'a', d: 'M12 20h9' }),
        h('path', { key: 'b', d: 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z' }),
      ),
      trash: h('path', { d: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6' }),
      x: h('path', { d: 'M18 6 6 18M6 6l12 12' }),
      search: h(
        Fragment,
        null,
        h('circle', { key: 'a', cx: '11', cy: '11', r: '7' }),
        h('path', { key: 'b', d: 'm20 20-4-4' }),
      ),
      check: h('path', { d: 'M20 6 9 17l-5-5' }),
      chevron: h('path', { d: 'm7 10 5 5 5-5' }),
      chevronRight: h('path', { d: 'm9 18 6-6-6-6' }),
      info: h(
        Fragment,
        null,
        h('circle', { key: 'a', cx: '12', cy: '12', r: '9' }),
        h('path', { key: 'b', d: 'M12 11v5M12 8h.01' }),
      ),
      shield: h(
        Fragment,
        null,
        h('path', { key: 'a', d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' }),
        h('path', { key: 'b', d: 'm9 12 2 2 4-4' }),
      ),
      pencil: h(
        Fragment,
        null,
        h('path', { key: 'a', d: 'M12 20h9' }),
        h('path', { key: 'b', d: 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z' }),
      ),
      folder: h('path', { d: 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z' }),
      arrowLeft: h('path', { d: 'M19 12H5M12 19l-7-7 7-7' }),
      message: h('path', { d: 'M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }),
      send: h(
        Fragment,
        null,
        h('path', { key: 'a', d: 'm22 2-7 20-4-9-9-4Z' }),
        h('path', { key: 'b', d: 'M22 2 11 13' }),
      ),
      reply: h(
        Fragment,
        null,
        h('path', { key: 'a', d: 'M9 17 4 12l5-5' }),
        h('path', { key: 'b', d: 'M4 12h10a6 6 0 0 1 6 6v1' }),
      ),
      refresh: h(
        Fragment,
        null,
        h('path', { key: 'a', d: 'M21 12a9 9 0 1 1-3-6.7' }),
        h('path', { key: 'b', d: 'M21 3v6h-6' }),
      ),
      lock: h(
        Fragment,
        null,
        h('rect', { key: 'a', x: '4', y: '10', width: '16', height: '11', rx: '2' }),
        h('path', { key: 'b', d: 'M8 10V7a4 4 0 0 1 8 0v3' }),
      ),
      clock: h(
        Fragment,
        null,
        h('circle', { key: 'a', cx: '12', cy: '12', r: '9' }),
        h('path', { key: 'b', d: 'M12 7v5l3 2' }),
      ),
    }

    function Icon({ name, size = 18, className }) {
      return h(
        'svg',
        {
          className,
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        ICONS[name] || ICONS.users,
      )
    }

    function GroupGlyph({ size = 18, active = false }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: active ? 2 : 1.75,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('circle', { cx: '12', cy: '6.3', r: '3' }),
        h('circle', { cx: '5.8', cy: '17.6', r: '2.8' }),
        h('circle', { cx: '18.2', cy: '17.6', r: '2.8' }),
        h('path', { d: 'M10.2 9 7 14.9M13.8 9l3.2 5.9M8.6 17.6h6.8' }),
      )
    }

    function RoleBadge({ role, compact = false, muted = false }) {
      const leader = role === ROLE_LEADER
      return h(
        'span',
        {
          className: cx(
            'ma-role',
            leader ? 'ma-role-leader' : 'ma-role-member',
            compact && 'ma-role-compact',
            muted && 'ma-role-muted',
          ),
        },
        h(Icon, { name: leader ? 'crown' : 'user', size: compact ? 11 : 12 }),
        roleLabel(role),
      )
    }

    function Avatar({ name, color = '#5b6cf9', size = 36, muted = false }) {
      const initial = (name || '组').trim().slice(0, 1) || '组'
      return h(
        'span',
        {
          className: cx('ma-avatar', muted && 'is-muted'),
          style: {
            width: size,
            height: size,
            fontSize: Math.max(12, Math.round(size * 0.4)),
            background: `color-mix(in srgb, ${color} 18%, transparent)`,
            color,
            borderColor: `color-mix(in srgb, ${color} 28%, transparent)`,
          },
          'aria-hidden': 'true',
        },
        initial,
      )
    }

    function requestError(message, code, extra) {
      const error = new Error(message)
      error.code = code
      if (extra) {
        for (const key of Object.keys(extra)) {
          if (key !== 'message' && key !== 'code') error[key] = extra[key]
        }
      }
      return error
    }

    async function apiFetch(path, options = {}) {
      let response
      try {
        response = await fetch(`${API_BASE}${path}`, {
          ...options,
          credentials: 'same-origin',
          cache: 'no-store',
          headers: {
            Accept: 'application/json',
            ...(options.headers || {}),
          },
        })
      } catch {
        throw requestError('无法连接分组服务，请确认插件已加载完成', 'NETWORK')
      }
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || !payload || payload.ok === false) {
        const detail = payload && payload.error ? payload.error : null
        throw requestError(
          (detail && detail.message) || `分组服务返回了错误（${response.status}）`,
          detail && detail.code,
          detail,
        )
      }
      return payload
    }

    function normalizeState(state) {
      return {
        groups: state && Array.isArray(state.groups) ? state.groups : [],
        memberships: state && Array.isArray(state.memberships) ? state.memberships : [],
        tasks: state && Array.isArray(state.tasks) ? state.tasks : [],
        taskEdges: state && Array.isArray(state.taskEdges) ? state.taskEdges : [],
        activities: state && Array.isArray(state.activities) ? state.activities : [],
      }
    }

    function createStore() {
      let snapshot = {
        status: 'idle',
        groups: [],
        memberships: [],
        tasks: [],
        taskEdges: [],
        activities: [],
        error: null,
        busy: false,
      }
      const listeners = new Set()
      let loaded = false
      let inflight = null
      let mutationVersion = 0

      function getSnapshot() {
        return snapshot
      }

      function subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }

      function update(patch) {
        snapshot = { ...snapshot, ...patch }
        for (const listener of listeners) listener()
      }

      function load(force = false) {
        if (inflight) return inflight
        if (loaded && !force) return Promise.resolve(snapshot)
        update({ status: snapshot.groups.length > 0 ? 'ready' : 'loading', error: null })
        const startedAt = mutationVersion
        inflight = apiFetch('/state')
          .then((payload) => {
            if (mutationVersion !== startedAt) return snapshot
            loaded = true
            const state = normalizeState(payload.state)
            update({ status: 'ready', ...state, error: null })
            return snapshot
          })
          .catch((error) => {
            if (mutationVersion === startedAt) {
              update({ status: snapshot.groups.length > 0 ? 'ready' : 'error', error: error.message })
            }
            throw error
          })
          .finally(() => {
            inflight = null
          })
        return inflight
      }

      async function mutate(payload) {
        mutationVersion += 1
        update({ busy: true, error: null })
        try {
          const data = await apiFetch('/action', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-dsh-multi-agent': '1',
            },
            body: JSON.stringify(payload),
          })
          loaded = true
          update({ status: 'ready', ...normalizeState(data.state), error: null, busy: false })
          return data
        } catch (error) {
          update({ busy: false })
          throw error
        }
      }

      return { subscribe, getSnapshot, load, mutate }
    }

    function usePluginStore(store) {
      return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    }

    function groupMembers(state, groupId) {
      return (state.memberships || [])
        .filter((membership) => membership.groupId === groupId)
        .slice()
        .sort((left, right) => {
          if (left.role !== right.role) return left.role === ROLE_LEADER ? -1 : 1
          return String(left.joinedAt).localeCompare(String(right.joinedAt))
        })
    }

    function sessionMemberships(state, sessionId) {
      return (state.memberships || []).filter((membership) => membership.sessionId === sessionId)
    }

    function leaderOf(state, groupId) {
      const leader = (state.memberships || []).find(
        (membership) => membership.groupId === groupId && membership.role === ROLE_LEADER,
      )
      return leader ? leader.sessionId : null
    }

    function statsOf(state) {
      const sessions = new Set((state.memberships || []).map((membership) => membership.sessionId))
      return {
        groups: (state.groups || []).length,
        sessions: sessions.size,
        leaders: (state.memberships || []).filter((membership) => membership.role === ROLE_LEADER).length,
      }
    }

    function Modal({ title, description, onClose, children, footer, wide = false, stacked = false }) {
      const closeRef = useRef(onClose)
      closeRef.current = onClose
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopImmediatePropagation()
            closeRef.current()
          }
        }
        document.addEventListener('keydown', onKey, true)
        const previous = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        return () => {
          document.removeEventListener('keydown', onKey, true)
          document.body.style.overflow = previous
        }
      }, [])
      return ReactDOM.createPortal(
        h(
          'div',
          {
            className: cx('ma-overlay', stacked && 'is-stacked'),
            onMouseDown: (event) => {
              if (event.target === event.currentTarget) onClose()
            },
          },
          h(
            'div',
            {
              className: cx('ma-modal', wide && 'ma-modal-wide'),
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': title,
            },
            h(
              'div',
              { className: 'ma-modal-head' },
              h('div', null, h('h2', null, title), description ? h('p', null, description) : null),
              h(
                'button',
                { type: 'button', className: 'ma-icon-btn', 'aria-label': '关闭', onClick: onClose },
                h(Icon, { name: 'x', size: 18 }),
              ),
            ),
            h('div', { className: 'ma-modal-body' }, children),
            footer ? h('div', { className: 'ma-modal-foot' }, footer) : null,
          ),
        ),
        document.body,
      )
    }

    function GroupEditor({ group, onClose, onSave, leaderCandidates = [], defaultLeaderId = '' }) {
      const editing = Boolean(group)
      const [name, setName] = useState(group ? group.name : '')
      const [description, setDescription] = useState(group ? group.description || '' : '')
      const [color, setColor] = useState(group ? group.color : COLORS[0])
      const [leaderId, setLeaderId] = useState(() => {
        if (editing) return ''
        if (defaultLeaderId) return defaultLeaderId
        return leaderCandidates[0]?.id || ''
      })
      const [error, setError] = useState(null)
      const [saving, setSaving] = useState(false)
      const nameRef = useRef(null)

      useEffect(() => {
        if (nameRef.current) nameRef.current.focus()
      }, [])

      const fixedLeader = !editing && Boolean(defaultLeaderId)
      const canSave = name.trim().length > 0 && !saving && (editing || Boolean(leaderId))

      async function submit(event) {
        if (event) event.preventDefault()
        if (!canSave) return
        setError(null)
        setSaving(true)
        try {
          await onSave({
            name: name.trim(),
            description: description.trim(),
            color,
            ...(editing ? {} : { leaderSessionId: leaderId }),
          })
        } catch (caught) {
          setError(caught.message || '保存失败，请稍后重试')
        } finally {
          setSaving(false)
        }
      }

      return h(
        Modal,
        {
          title: editing ? '编辑分组' : '新建分组',
          description: editing
            ? '修改名称、说明或标识色。组长只能通过接管转移，不能直接取消。'
            : '创建时必须指定一位组长，分组不会出现组长空缺。',
          onClose,
          footer: h(
            Fragment,
            null,
            h('button', { type: 'button', className: 'ma-btn ma-btn-ghost', onClick: onClose }, '取消'),
            h(
              'button',
              {
                type: 'button',
                className: 'ma-btn ma-btn-primary',
                onClick: submit,
                disabled: !canSave,
              },
              saving ? '保存中…' : editing ? '保存修改' : '创建分组',
            ),
          ),
        },
        h(
          'form',
          { className: 'ma-form', onSubmit: submit },
          h(
            'label',
            { className: 'ma-field' },
            h('span', { className: 'ma-field-label' }, '分组名称', h('em', null, '必填')),
            h('input', {
              ref: nameRef,
              className: 'ma-input',
              value: name,
              maxLength: 40,
              placeholder: '例如：产品研发组',
              onChange: (event) => setName(event.target.value),
            }),
            h('span', { className: 'ma-field-hint' }, `${name.trim().length}/40`),
          ),
          h(
            'label',
            { className: 'ma-field' },
            h('span', { className: 'ma-field-label' }, '分组说明'),
            h('textarea', {
              className: 'ma-textarea',
              value: description,
              maxLength: 240,
              rows: 3,
              placeholder: '这个小组负责什么？写给之后加入的 Agent 看。',
              onChange: (event) => setDescription(event.target.value),
            }),
            h('span', { className: 'ma-field-hint' }, `${description.trim().length}/240`),
          ),
          !editing
            ? h(
                'label',
                { className: 'ma-field' },
                h('span', { className: 'ma-field-label' }, '首任组长', h('em', null, '必填')),
                fixedLeader
                  ? h(
                      'div',
                      { className: 'ma-leader-fixed' },
                      h(Icon, { name: 'crown', size: 14 }),
                      h('span', null, '当前对话将自动成为组长'),
                    )
                  : leaderCandidates.length > 0
                    ? h(
                        'select',
                        {
                          className: 'ma-select',
                          value: leaderId,
                          onChange: (event) => setLeaderId(event.target.value),
                        },
                        h('option', { value: '' }, '选择一位组长'),
                        leaderCandidates.map((candidate) =>
                          h('option', { key: candidate.id, value: candidate.id }, candidate.title),
                        ),
                      )
                    : h(
                        'div',
                        { className: 'ma-form-error', role: 'alert' },
                        h(Icon, { name: 'info', size: 14 }),
                        '当前工作区没有可用会话，请先在左侧创建或打开一个对话。',
                      ),
                h('span', { className: 'ma-field-hint' }, '每个分组必须且只能有一位组长；其他成员后续添加。'),
              )
            : null,
          h(
            'div',
            { className: 'ma-field' },
            h('span', { className: 'ma-field-label' }, '标识色'),
            h(
              'div',
              { className: 'ma-swatches' },
              COLORS.map((value) =>
                h(
                  'button',
                  {
                    key: value,
                    type: 'button',
                    className: cx('ma-swatch', color === value && 'is-selected'),
                    style: { background: value },
                    'aria-label': `选择颜色 ${value}`,
                    'aria-pressed': color === value,
                    onClick: () => setColor(value),
                  },
                  color === value ? h(Icon, { name: 'check', size: 14 }) : null,
                ),
              ),
            ),
          ),
          error
            ? h('div', { className: 'ma-form-error', role: 'alert' }, h(Icon, { name: 'info', size: 15 }), error)
            : null,
        ),
      )
    }

    function ConfirmDialog({ title, description, confirmLabel, tone, onClose, onConfirm, children }) {
      const [error, setError] = useState(null)
      const [working, setWorking] = useState(false)
      async function confirm() {
        setWorking(true)
        setError(null)
        try {
          await onConfirm()
        } catch (caught) {
          setError(caught.message || '操作失败，请稍后重试')
        } finally {
          setWorking(false)
        }
      }
      return h(
        Modal,
        {
          title,
          description,
          onClose,
          footer: h(
            Fragment,
            null,
            h('button', { type: 'button', className: 'ma-btn ma-btn-ghost', onClick: onClose }, '取消'),
            h(
              'button',
              {
                type: 'button',
                className: cx('ma-btn', tone === 'danger' ? 'ma-btn-danger' : 'ma-btn-primary'),
                onClick: confirm,
                disabled: working,
              },
              working ? '处理中…' : confirmLabel,
            ),
          ),
        },
        h(
          'div',
          { className: 'ma-confirm' },
          h(
            'div',
            { className: cx('ma-confirm-icon', tone === 'danger' && 'is-danger') },
            h(Icon, { name: tone === 'danger' ? 'trash' : 'crown', size: 21 }),
          ),
          children,
          error
            ? h('div', { className: 'ma-form-error', role: 'alert' }, h(Icon, { name: 'info', size: 15 }), error)
            : null,
        ),
      )
    }

    function MemberChip({ name, role, current }) {
      const leader = role === ROLE_LEADER
      return h(
        'span',
        {
          className: cx('ma-chip', leader && 'is-leader', current && 'is-current'),
          title: `${name} · ${roleLabel(role)}${current ? ' · 当前对话' : ''}`,
        },
        leader ? h(Icon, { name: 'crown', size: 11 }) : h('i', null),
        h('span', { className: 'ma-chip-name' }, name),
        current ? h('em', null, '当前') : null,
      )
    }

    function MemberChips({ state, groupId, sessionId, byId, compact = false }) {
      const members = groupMembers(state, groupId)
      if (members.length === 0) return h('span', { className: 'ma-muted' }, '暂无成员')
      const limit = compact ? 4 : 6
      return h(
        'div',
        { className: cx('ma-chips', compact && 'is-compact') },
        members.slice(0, limit).map((membership) =>
          h(MemberChip, {
            key: membership.sessionId,
            name: displayNameOf(byId, membership.sessionId),
            role: membership.role,
            current: membership.sessionId === sessionId,
          }),
        ),
        members.length > limit
          ? h('span', { className: 'ma-chip ma-chip-more', title: members.slice(limit).map((item) => displayNameOf(byId, item.sessionId)).join('、') }, `+${members.length - limit}`)
          : null,
      )
    }

    function StatItem({ icon, value, label, tone }) {
      return h(
        'div',
        { className: cx('ma-overview-stat', tone && `ma-tone-${tone}`) },
        h('span', { className: 'ma-overview-icon' }, h(Icon, { name: icon, size: 16 })),
        h('strong', null, value),
        h('span', null, label),
      )
    }

    function EmptyBlock({ icon = 'users', title, description, action }) {
      return h(
        'div',
        { className: 'ma-empty' },
        h('span', { className: 'ma-empty-icon' }, h(Icon, { name: icon, size: 24 })),
        h('strong', null, title),
        description ? h('p', null, description) : null,
        action || null,
      )
    }

    function GroupRow({ group, state, selected, byId, onClick }) {
      const members = groupMembers(state, group.id)
      const leaderId = leaderOf(state, group.id)
      return h(
        'button',
        {
          type: 'button',
          className: cx('ma-group-row', selected && 'is-selected'),
          style: { '--ma-c': group.color },
          onClick,
          'aria-current': selected ? 'true' : undefined,
        },
        h('span', { className: 'ma-group-dot' }),
        h(
          'span',
          { className: 'ma-group-row-copy' },
          h('strong', { title: group.name }, group.name),
          h(
            'span',
            null,
            `${members.length} 位成员`,
            leaderId ? ` · 组长 ${displayNameOf(byId, leaderId)}` : ' · 组长空缺',
          ),
        ),
        h(Icon, { name: 'chevronRight', size: 14, className: 'ma-group-row-arrow' }),
      )
    }

    const ACTIVITY_STATE_META = {
      using: { label: '使用中', tone: 'using' },
      viewing: { label: '仅查看', tone: 'viewing' },
      modified: { label: '已修改', tone: 'modified' },
    }
    const ACTIVITY_OP_LABEL = { open: '使用', move: '移动', copy: '复制' }

    function formatTokens(value) {
      const tokens = Number(value) || 0
      if (tokens < 1000) return String(tokens)
      if (tokens < 1000000) return `${(tokens / 1000).toFixed(tokens < 10000 ? 2 : 1)}K`
      return `${(tokens / 1000000).toFixed(2)}M`
    }

    function TokenUsageSection({ group, byId }) {
      const [report, setReport] = useState({ status: 'loading', data: null, error: null })
      const [tick, setTick] = useState(0)

      useEffect(() => {
        let alive = true
        setReport((current) => ({
          ...current,
          status: current.data ? 'refreshing' : 'loading',
          error: null,
        }))
        apiFetch(`/usage?groupId=${encodeURIComponent(group.id)}${tick > 0 ? '&refresh=1' : ''}`)
          .then((payload) => {
            if (!alive) return
            const data = payload?.report ?? null
            setReport({ status: data ? 'ready' : 'empty', data, error: null })
          })
          .catch((failure) => {
            if (!alive) return
            const message = failure && failure.message ? failure.message : ''
            setReport((current) => ({
              ...current,
              status: 'error',
              error: /（404）|404/.test(message)
                ? '插件服务尚未加载新版本，重启 DSH 后即可看到 Token 报表'
                : message || 'Token 报表加载失败',
            }))
          })
        return () => {
          alive = false
        }
      }, [group.id, tick])

      const rows = Array.isArray(report.data?.members) ? report.data.members : []
      const total = report.data?.total || 0

      return h(
        'section',
        { className: 'ma-usage', 'aria-label': 'Token 用量' },
        h(
          'div',
          { className: 'ma-usage-head' },
          h(
            'div',
            { className: 'ma-usage-title' },
            h(Icon, { name: 'users', size: 14 }),
            h('strong', null, 'Token 用量'),
            h('span', { className: 'ma-count-pill' }, `${rows.length} 位成员`),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'ma-btn ma-btn-ghost ma-btn-sm',
              disabled: report.status === 'loading' || report.status === 'refreshing',
              onClick: () => setTick((value) => value + 1),
            },
            h(Icon, { name: 'refresh', size: 13 }),
            report.status === 'refreshing' ? '刷新中…' : '刷新',
          ),
        ),
        h(
          'div',
          { className: 'ma-usage-total' },
          h('span', null, '组内共消耗'),
          h('strong', null, formatTokens(total)),
          h('em', null, 'tokens'),
        ),
        report.status === 'loading'
          ? h('p', { className: 'ma-usage-empty' }, '正在统计成员用量…')
          : null,
        report.status === 'error'
          ? h(
              'p',
              { className: 'ma-usage-empty is-error', role: 'alert' },
              report.error || 'Token 报表加载失败',
            )
          : null,
        report.status !== 'loading' && report.status !== 'error' && rows.length === 0
          ? h('p', { className: 'ma-usage-empty' }, '这个分组还没有成员，暂无用量。')
          : null,
        rows.length > 0
          ? h(
              'ul',
              { className: 'ma-usage-list' },
              rows.map((row) => {
                const percent = Number(row.percent) || 0
                return h(
                  'li',
                  { key: row.sessionId, className: 'ma-usage-row' },
                  h(
                    'span',
                    { className: 'ma-usage-person' },
                    h('strong', { title: displayNameOf(byId, row.sessionId) }, displayNameOf(byId, row.sessionId)),
                    h('small', { title: row.sessionId }, row.role === ROLE_LEADER ? '组长' : '成员'),
                  ),
                  h(
                    'span',
                    { className: 'ma-usage-bar', 'aria-hidden': 'true' },
                    h('i', { style: { width: `${Math.max(percent, row.total > 0 ? 2 : 0)}%` } }),
                  ),
                  h('span', { className: 'ma-usage-value' }, formatTokens(row.total)),
                  h('span', { className: 'ma-usage-percent' }, row.total > 0 && percent === 0 ? '<1%' : `${percent}%`),
                )
              }),
            )
          : null,
        h(
          'p',
          { className: 'ma-usage-hint' },
          '按 provider 实际回报的 tokens 累计（含缓存读取与输出）；占比按组内总量四舍五入到 1%。',
        ),
      )
    }

    function GroupDetail({ group, state, byId, busy, onEdit, onDelete, onRole, onRemove, onAddMembers, onManage, onMessages }) {
      const members = groupMembers(state, group.id)
      const leaderId = leaderOf(state, group.id)
      const [showAllActivities, setShowAllActivities] = useState(false)
      const groupActivities = Array.isArray(state.activities)
        ? state.activities.filter((activity) => activity.groupId === group.id)
        : []
      const usingActivities = groupActivities.filter((activity) => activity.state === 'using')
      const visibleActivities = (showAllActivities ? groupActivities : usingActivities)
        .slice()
        .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
        .slice(0, 30)
      return h(
        'div',
        { className: 'ma-detail', style: { '--ma-c': group.color } },
        h(
          'header',
          { className: 'ma-detail-head' },
          h(Avatar, { name: group.name, color: group.color, size: 44 }),
          h(
            'div',
            { className: 'ma-detail-copy' },
            h('h2', { title: group.name }, group.name),
            h(
              'p',
              { className: cx('ma-detail-desc', !group.description && 'is-empty') },
              group.description || '还没有填写分组说明。',
            ),
            h(
              'div',
              { className: 'ma-detail-meta' },
              h('span', null, h(Icon, { name: 'users', size: 13 }), `${members.length} 位成员`),
              h('span', null, h(Icon, { name: 'crown', size: 13 }), leaderId ? `组长 ${displayNameOf(byId, leaderId)}` : '组长空缺'),
              h('span', null, `更新于 ${formatDate(group.updatedAt)}`),
            ),
          ),
          h(
            'div',
            { className: 'ma-detail-tools' },
            h(
              'button',
              {
                type: 'button',
                className: 'ma-icon-btn',
                title: '编辑分组',
                'aria-label': `编辑 ${group.name}`,
                onClick: () => onEdit(group),
              },
              h(Icon, { name: 'edit', size: 16 }),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'ma-icon-btn ma-icon-danger',
                title: '删除分组',
                'aria-label': `删除 ${group.name}`,
                onClick: () => onDelete(group),
              },
              h(Icon, { name: 'trash', size: 16 }),
            ),
          ),
        ),
        leaderId
          ? null
          : h(
              'div',
              { className: 'ma-callout ma-callout-warn' },
              h(Icon, { name: 'crown', size: 16 }),
              h(
                'div',
                null,
                h('strong', null, '组长空缺'),
                h('p', null, '可在下方成员列表中直接设为组长，或进入成员对话后从顶部入口认领。'),
              ),
            ),
        h(
          'div',
          { className: 'ma-members-head' },
          h(
            'div',
            { className: 'ma-members-head-actions' },
            h('span', { className: 'ma-count-pill' }, `${members.length} 位`),
            onMessages && members.length > 0
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'ma-btn ma-btn-ghost ma-btn-sm',
                    onClick: () => onMessages(group),
                  },
                  h(Icon, { name: 'message', size: 14 }),
                  '消息',
                )
              : null,
            onManage
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'ma-btn ma-btn-ghost ma-btn-sm',
                    onClick: () => onManage(group),
                  },
                  h(Icon, { name: 'shield', size: 14 }),
                  '管理组',
                )
              : null,
            onAddMembers
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'ma-btn ma-btn-outline ma-btn-sm',
                    onClick: () => onAddMembers(group),
                  },
                  h(Icon, { name: 'plus', size: 14 }),
                  '添加成员',
                )
              : null,
          ),
        ),
        members.length === 0
          ? h(EmptyBlock, {
              icon: 'users',
              title: '还没有成员',
              description: '扫描当前工作区的对话添加成员，或打开对话在顶部选择加入分组。',
              action: onAddMembers
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'ma-btn ma-btn-primary ma-btn-sm',
                      onClick: () => onAddMembers(group),
                    },
                    h(Icon, { name: 'plus', size: 14 }),
                    '扫描会话并添加',
                  )
                : null,
            })
          : h(
              'div',
              { className: 'ma-member-table', role: 'table', 'aria-label': `${group.name} 成员` },
              h(
                'div',
                { className: 'ma-member-table-head', role: 'row' },
                h('span', { role: 'columnheader' }, '成员'),
                h('span', { role: 'columnheader' }, '权限'),
                h('span', { role: 'columnheader' }, '加入时间'),
                h('span', { role: 'columnheader' }, '操作'),
              ),
              members.map((membership) => {
                const name = displayNameOf(byId, membership.sessionId)
                const isLeader = membership.role === ROLE_LEADER
                return h(
                  'div',
                  { key: membership.sessionId, className: 'ma-member-row', role: 'row' },
                  h(
                    'span',
                    { className: 'ma-member-person', role: 'cell' },
                    h(
                      'span',
                      { className: 'ma-member-avatar', style: { color: group.color } },
                      h(Icon, { name: 'user', size: 15 }),
                    ),
                    h(
                      'span',
                      { className: 'ma-member-name' },
                      h('strong', { title: name }, name),
                      h('small', { title: membership.sessionId }, shortId(membership.sessionId)),
                    ),
                  ),
                  h('span', { role: 'cell' }, h(RoleBadge, { role: membership.role, compact: true })),
                  h('span', { className: 'ma-member-date', role: 'cell' }, formatDate(membership.joinedAt)),
                  h(
                    'span',
                    { className: 'ma-member-actions', role: 'cell' },
                    isLeader
                      ? membership.sessionId === leaderId
                        ? h(
                            'span',
                            { className: 'ma-leader-mark', title: '分组必须保留组长，可先把其他成员设为组长' },
                            h(Icon, { name: 'crown', size: 11 }),
                            '当前组长',
                          )
                        : h(
                            'button',
                            {
                              type: 'button',
                              className: 'ma-text-btn',
                              disabled: busy,
                              title: '转为本组普通成员',
                              onClick: () => onRole(membership, ROLE_MEMBER),
                            },
                            '转为成员',
                          )
                      : h(
                          'button',
                          {
                            type: 'button',
                            className: 'ma-text-btn ma-text-btn-accent',
                            disabled: busy,
                            title: leaderId ? '接管本组组长' : '设为组长',
                            onClick: () => onRole(membership, ROLE_LEADER),
                          },
                          '设为组长',
                        ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'ma-text-btn ma-text-btn-danger',
                        disabled: busy,
                        onClick: () => onRemove(membership),
                      },
                      '移出',
                    ),
                  ),
                )
              }),
            ),
        h(
          'section',
          { className: 'ma-activity', 'aria-label': '执行列表' },
          h(
            'div',
            { className: 'ma-activity-head' },
            h(
              'div',
              { className: 'ma-activity-title' },
              h(Icon, { name: 'folder', size: 14 }),
              h('strong', null, '执行列表'),
              h(
                'span',
                { className: 'ma-count-pill' },
                showAllActivities ? `${groupActivities.length} 条记录` : `${usingActivities.length} 使用中`,
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'ma-btn ma-btn-ghost ma-btn-sm',
                onClick: () => setShowAllActivities((current) => !current),
              },
              showAllActivities ? '只看使用中' : '显示全部',
            ),
          ),
          visibleActivities.length === 0
            ? h(
                'p',
                { className: 'ma-activity-empty' },
                showAllActivities
                  ? '还没有执行记录。成员打开或修改工作区文件后会自动出现在这里。'
                  : '当前没有成员正在使用文件。',
              )
            : h(
                'ul',
                { className: 'ma-activity-list' },
                visibleActivities.map((activity) => {
                  const meta = ACTIVITY_STATE_META[activity.state] || ACTIVITY_STATE_META.viewing
                  const destination = activity.destination ? ` → ${activity.destination}` : ''
                  return h(
                    'li',
                    { key: activity.id, className: 'ma-activity-row' },
                    h('span', { className: cx('ma-activity-state', `is-${meta.tone}`) }, meta.label),
                    h(
                      'span',
                      { className: 'ma-activity-main' },
                      h('strong', { title: activity.path }, activity.name || activity.path),
                      h(
                        'small',
                        { title: activity.path },
                        `${ACTIVITY_OP_LABEL[activity.op] || activity.op} · ${displayNameOf(byId, activity.sessionId)}${destination} · ${formatDateTime(activity.updatedAt)}`,
                      ),
                    ),
                  )
                }),
              ),
        ),
        h(TokenUsageSection, { group, byId }),
        h(
          'div',
          { className: 'ma-detail-foot' },
          h(Icon, { name: 'info', size: 14 }),
          h('span', null, '一个对话可以同时属于多个分组。这里的成员名称来自对话标题，改名会同步更新。'),
        ),
      )
    }

    function AddMembersDialog({ group, state, byId, workspaces = [], preferredCwd, store, onClose, onAdded }) {
      const existing = new Set(groupMembers(state, group.id).map((membership) => membership.sessionId))
      const [workspaceId, setWorkspaceId] = useState(() => {
        const list = Array.isArray(workspaces) ? workspaces : []
        if (list.length === 0) return ''
        if (preferredCwd) {
          const match = list.find((workspace) => workspace.path === preferredCwd)
          if (match) return match.workspaceId
        }
        const byMember = list.find(
          (workspace) => (workspace.sessionIds || []).some((id) => existing.has(id)),
        )
        return byMember ? byMember.workspaceId : list[0].workspaceId
      })
      const [query, setQuery] = useState('')
      const [selected, setSelected] = useState(() => new Set())
      const [role, setRole] = useState(ROLE_MEMBER)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const workspace = (workspaces || []).find((item) => item && item.workspaceId === workspaceId) || null
      const candidates = useMemo(
        () => workspaceSessions(byId, workspaces, workspaceId, preferredCwd),
        [byId, workspaces, workspaceId, preferredCwd],
      )
      const available = useMemo(
        () => candidates.filter((summary) => !existing.has(summary.id)),
        [candidates, state.memberships, group.id],
      )
      const selectedIds = Array.from(selected).filter((id) => available.some((summary) => summary.id === id))
      const search = query.trim().toLowerCase()
      const visible = available.filter((summary) => {
        if (!search) return true
        return `${displayNameOf(byId, summary.id)} ${summary.id}`.toLowerCase().includes(search)
      })
      const leaderId = leaderOf(state, group.id)
      const leaderName = leaderId ? displayNameOf(byId, leaderId) : ''
      const scopeTitle = workspace
        ? workspace.title || workspaceName(workspace.path)
        : preferredCwd
          ? workspaceName(preferredCwd)
          : '全部工作区'
      const canSubmit = selectedIds.length > 0 && !busy && !(role === ROLE_LEADER && selectedIds.length > 1)

      function toggle(id) {
        setSelected((current) => {
          const next = new Set(current)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
        setError(null)
      }

      async function submit() {
        if (!canSubmit) return
        setBusy(true)
        setError(null)
        try {
          for (const id of selectedIds) {
            await store.mutate({
              action: 'assign',
              groupId: group.id,
              sessionId: id,
              role,
              takeover: role === ROLE_LEADER && Boolean(leaderId),
            })
          }
          if (onAdded) onAdded(selectedIds.length, role)
          onClose()
        } catch (caught) {
          setError(caught.message || '添加成员失败，请稍后重试')
        } finally {
          setBusy(false)
        }
      }

      return h(
        Modal,
        {
          title: `添加成员 · ${group.name}`,
          description: '扫描当前工作区的会话，选择要加入这个分组的对话。',
          wide: true,
          stacked: true,
          onClose,
          footer: h(
            Fragment,
            null,
            h(
              'span',
              { className: 'ma-add-count' },
              selectedIds.length === 0 ? '尚未选择会话' : `已选择 ${selectedIds.length} 位`,
            ),
            h('button', { type: 'button', className: 'ma-btn ma-btn-ghost', onClick: onClose }, '取消'),
            h(
              'button',
              {
                type: 'button',
                className: 'ma-btn ma-btn-primary',
                disabled: !canSubmit,
                onClick: submit,
              },
              busy ? '添加中…' : '添加成员',
            ),
          ),
        },
        h(
          'div',
          { className: 'ma-add' },
          (workspaces || []).length > 1
            ? h(
                'label',
                { className: 'ma-add-scope' },
                h(Icon, { name: 'folder', size: 15 }),
                h('span', { className: 'ma-add-scope-label' }, '工作区'),
                h(
                  'select',
                  {
                    className: 'ma-select',
                    value: workspaceId,
                    onChange: (event) => {
                      setWorkspaceId(event.target.value)
                      setSelected(new Set())
                      setError(null)
                    },
                  },
                  workspaces.map((item) =>
                    h(
                      'option',
                      { key: item.workspaceId, value: item.workspaceId },
                      item.title || workspaceName(item.path),
                    ),
                  ),
                ),
                h('em', null, `${available.length} 个可选`),
              )
            : h(
                'div',
                { className: 'ma-add-scope' },
                h(Icon, { name: 'folder', size: 15 }),
                h('span', { className: 'ma-add-scope-label' }, '当前工作区'),
                h('strong', { title: workspace ? workspace.path : preferredCwd || '' }, scopeTitle),
                h('em', null, `${available.length} 个可选`),
              ),
          h(
            'label',
            { className: 'ma-search ma-add-search' },
            h(Icon, { name: 'search', size: 15 }),
            h('input', {
              value: query,
              placeholder: '搜索当前工作区的会话',
              'aria-label': '搜索会话',
              onChange: (event) => setQuery(event.target.value),
            }),
          ),
          h(
            'div',
            { className: 'ma-add-list', role: 'group', 'aria-label': '可添加的会话' },
            visible.length === 0
              ? h(
                  'div',
                  { className: 'ma-add-empty' },
                  h(Icon, { name: query ? 'search' : 'check', size: 20 }),
                  h('strong', null, query ? '没有匹配的会话' : '当前工作区没有可添加的会话'),
                  h(
                    'p',
                    null,
                    query
                      ? '换一个关键词试试，或切换工作区。'
                      : '这个工作区的会话可能都已加入分组，或还没有其他会话。',
                  ),
                )
              : visible.map((summary) =>
                  h(
                    'label',
                    {
                      key: summary.id,
                      className: cx('ma-add-option', selected.has(summary.id) && 'is-selected'),
                    },
                    h('input', {
                      type: 'checkbox',
                      checked: selected.has(summary.id),
                      onChange: () => toggle(summary.id),
                    }),
                    h(
                      'span',
                      { className: 'ma-add-person' },
                      h('strong', { title: displayNameOf(byId, summary.id) }, displayNameOf(byId, summary.id)),
                      h('small', { title: summary.id }, summary.cwd ? workspaceName(summary.cwd) : shortId(summary.id)),
                    ),
                    h(
                      'span',
                      { className: 'ma-add-check', 'aria-hidden': 'true' },
                      selected.has(summary.id) ? h(Icon, { name: 'check', size: 12 }) : null,
                    ),
                  ),
                ),
          ),
          h(
            'div',
            { className: 'ma-role-pick' },
            h('span', { className: 'ma-role-pick-label' }, '加入身份'),
            h(
              'button',
              {
                type: 'button',
                className: cx('ma-role-choice', role === ROLE_MEMBER && 'is-selected'),
                'aria-pressed': role === ROLE_MEMBER,
                onClick: () => setRole(ROLE_MEMBER),
              },
              h(Icon, { name: 'user', size: 14 }),
              '成员',
            ),
            h(
              'button',
              {
                type: 'button',
                className: cx('ma-role-choice', role === ROLE_LEADER && 'is-selected'),
                'aria-pressed': role === ROLE_LEADER,
                onClick: () => setRole(ROLE_LEADER),
              },
              h(Icon, { name: 'crown', size: 14 }),
              '组长',
            ),
            h(
              'span',
              { className: 'ma-role-pick-hint' },
              role === ROLE_LEADER ? '每次只能添加一位组长' : '可一次添加多位成员',
            ),
          ),
          role === ROLE_LEADER && leaderId
            ? h(
                'div',
                { className: 'ma-add-warn' },
                h(Icon, { name: 'crown', size: 14 }),
                h(
                  'span',
                  null,
                  `当前组长是 ${leaderName}，设为组长后对方会自动转为成员。`,
                ),
              )
            : null,
          role === ROLE_LEADER && selectedIds.length > 1
            ? h(
                'div',
                { className: 'ma-form-error', role: 'alert' },
                h(Icon, { name: 'info', size: 14 }),
                '一次只能添加一位组长，请减少选择或改为成员。',
              )
            : null,
          error
            ? h(
                'div',
                { className: 'ma-form-error', role: 'alert' },
                h(Icon, { name: 'info', size: 14 }),
                error,
              )
            : null,
        ),
      )
    }

    function SpawnConfigSection({ group, store, onNotice }) {
      const stored = group.spawn && group.spawn.mode === 'custom' ? group.spawn : null
      const [mode, setMode] = useState(stored ? 'custom' : 'inherit')
      const [provider, setProvider] = useState(stored?.provider || '')
      const [model, setModel] = useState(stored?.model || '')
      const [effort, setEffort] = useState(stored?.reasoningEffort || '')
      const [catalog, setCatalog] = useState({ status: 'loading', groups: [], error: null })
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState(null)

      useEffect(() => {
        let alive = true
        apiFetch('/models')
          .then((payload) => {
            if (!alive) return
            setCatalog({
              status: 'ready',
              groups: Array.isArray(payload?.catalog?.groups) ? payload.catalog.groups : [],
              error: null,
            })
          })
          .catch((failure) => {
            if (!alive) return
            setCatalog({ status: 'error', groups: [], error: failure.message || '模型列表加载失败' })
          })
        return () => {
          alive = false
        }
      }, [])

      const models = useMemo(() => {
        const list = []
        for (const providerGroup of catalog.groups) {
          const groupModels = Array.isArray(providerGroup.models) ? providerGroup.models : []
          for (const entry of groupModels) {
            list.push({
              key: `${providerGroup.id}\u0000${entry.id}`,
              provider: providerGroup.id,
              providerName: providerGroup.name || providerGroup.id,
              model: entry,
            })
          }
        }
        return list
      }, [catalog.groups])

      const selected = models.find((entry) => entry.provider === provider && entry.model.id === model) || null
      const efforts = Array.isArray(selected?.model?.reasoning?.efforts)
        ? selected.model.reasoning.efforts
        : []

      function switchMode(next) {
        setMode(next)
        setError(null)
        if (next === 'custom' && !selected && models.length > 0) {
          setProvider(models[0].provider)
          setModel(models[0].model.id)
          setEffort('')
        }
      }

      async function save() {
        if (saving) return
        if (mode === 'custom' && !selected) {
          setError('请先选择一个模型')
          return
        }
        setSaving(true)
        setError(null)
        try {
          await store.mutate({
            action: 'updateGroup',
            groupId: group.id,
            spawn: mode === 'custom'
              ? { mode: 'custom', provider, model, reasoningEffort: effort || null }
              : { mode: 'inherit' },
          })
          onNotice?.(mode === 'custom' ? '已保存：新会话使用指定模型' : '已保存：新会话继承组长设置')
        } catch (failure) {
          setError(failure.message || '保存失败，请稍后重试')
        } finally {
          setSaving(false)
        }
      }

      return h(
        'section',
        { className: 'ma-spawn' },
        h(
          'div',
          { className: 'ma-spawn-head' },
          h(Icon, { name: 'sparkles', size: 13 }),
          h('strong', null, '新会话继承'),
          h('span', { className: 'ma-spawn-badge' }, mode === 'custom' ? '自定义' : '继承组长'),
        ),
        h(
          'p',
          { className: 'ma-spawn-hint' },
          '组长用「创建成员会话」工具新建对话时使用的模型与推理等级；新会话不继承任何对话上下文。',
        ),
        h(
          'div',
          { className: 'ma-spawn-tabs', role: 'group' },
          h(
            'button',
            { type: 'button', className: cx(mode === 'inherit' && 'is-active'), onClick: () => switchMode('inherit') },
            '继承组长',
          ),
          h(
            'button',
            { type: 'button', className: cx(mode === 'custom' && 'is-active'), onClick: () => switchMode('custom') },
            '指定模型',
          ),
        ),
        mode === 'custom'
          ? h(
              'div',
              { className: 'ma-spawn-fields' },
              h(
                'label',
                { className: 'ma-field' },
                h('span', { className: 'ma-field-label' }, '模型'),
                h(
                  'select',
                  {
                    className: 'ma-select',
                    value: selected ? `${provider}\u0000${model}` : '',
                    disabled: catalog.status !== 'ready' || models.length === 0,
                    onChange: (event) => {
                      const [nextProvider, nextModel] = event.target.value.split('\u0000')
                      setProvider(nextProvider)
                      setModel(nextModel)
                      setEffort('')
                    },
                  },
                  catalog.status === 'loading' ? h('option', { value: '' }, '正在读取模型列表…') : null,
                  catalog.status === 'error' ? h('option', { value: '' }, '模型列表加载失败，请稍后重试') : null,
                  catalog.status === 'ready' && models.length === 0
                    ? h('option', { value: '' }, '当前没有可用模型')
                    : null,
                  catalog.groups.map((providerGroup) =>
                    h(
                      'optgroup',
                      { key: providerGroup.id, label: providerGroup.name || providerGroup.id },
                      (Array.isArray(providerGroup.models) ? providerGroup.models : []).map((entry) =>
                        h(
                          'option',
                          { key: entry.id, value: `${providerGroup.id}\u0000${entry.id}` },
                          entry.name || entry.id,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              efforts.length > 0
                ? h(
                    'label',
                    { className: 'ma-field' },
                    h('span', { className: 'ma-field-label' }, '推理等级'),
                    h(
                      'select',
                      {
                        className: 'ma-select',
                        value: effort,
                        onChange: (event) => setEffort(event.target.value),
                      },
                      h('option', { value: '' }, '默认'),
                      efforts.map((entry) =>
                        h('option', { key: entry.id, value: entry.id }, entry.name || entry.id),
                      ),
                    ),
                  )
                : h(
                    'p',
                    { className: 'ma-spawn-hint' },
                    selected ? '这个模型没有可调整的推理等级。' : '选择模型后可调整推理等级。',
                  ),
            )
          : h(
              'p',
              { className: 'ma-spawn-inline' },
              h(Icon, { name: 'crown', size: 12 }),
              '创建时读取组长当前的模型与推理等级。',
            ),
        error
          ? h('div', { className: 'ma-form-error', role: 'alert' }, h(Icon, { name: 'info', size: 13 }), error)
          : null,
        h(
          'div',
          { className: 'ma-spawn-foot' },
          h(
            'button',
            {
              type: 'button',
              className: 'ma-btn ma-btn-outline ma-btn-sm',
              disabled: saving,
              onClick: save,
            },
            saving ? '保存中…' : '保存继承配置',
          ),
        ),
      )
    }

    function SessionLimitSection({ group, memberCount = 0, store, onNotice }) {
      const [value, setValue] = useState(String(group.maxSessions ?? 8))
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState(null)
      const maxSessions = Number(group.maxSessions) || 8

      useEffect(() => {
        setValue(String(group.maxSessions ?? 8))
      }, [group.maxSessions])

      async function save() {
        if (saving) return
        const numeric = Number(value)
        if (!Number.isInteger(numeric) || numeric < 2 || numeric > 32) {
          setError('请输入 2–32 之间的整数')
          return
        }
        if (numeric < memberCount) {
          setError(`当前已有 ${memberCount} 个会话，不能小于这个数量`)
          return
        }
        setSaving(true)
        setError(null)
        try {
          await store.mutate({ action: 'updateGroup', groupId: group.id, maxSessions: numeric })
          onNotice?.(`最大会话数已调整为 ${numeric}`)
        } catch (caught) {
          setError(caught.message || '保存失败，请稍后重试')
        } finally {
          setSaving(false)
        }
      }

      return h(
        'div',
        { className: 'ma-capacity' },
        h(
          'div',
          { className: 'ma-capacity-head' },
          h('strong', null, '最大会话数'),
          h('span', { className: 'ma-count-pill' }, `${memberCount}/${maxSessions}`),
        ),
        h(
          'div',
          { className: 'ma-capacity-body' },
          h(
            'label',
            { className: 'ma-field' },
            h('span', { className: 'ma-field-label' }, '这个团队最多容纳的会话数（含组长）'),
            h('input', {
              className: 'ma-input',
              type: 'number',
              min: 2,
              max: 32,
              value,
              onChange: (event) => {
                setValue(event.target.value)
                setError(null)
              },
            }),
          ),
          h(
            'button',
            { type: 'button', className: 'ma-btn ma-btn-sm', disabled: saving || Number(value) === maxSessions, onClick: save },
            saving ? '保存中…' : '保存',
          ),
        ),
        h('span', { className: 'ma-field-hint' }, '只有你（用户）可以修改；组长创建成员会话、成员加入时都会受此上限约束。实际任务模块数量建议保持在“最大会话数 − 1”左右。'),
        error ? h('div', { className: 'ma-form-error' }, error) : null,
      )
    }

    function GroupManageDialog({ group, state, byId, workspaces = [], preferredCwd, store, onClose }) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)
      const [takeover, setTakeover] = useState(null)
      const [removeTarget, setRemoveTarget] = useState(null)
      const [addOpen, setAddOpen] = useState(false)
      const members = groupMembers(state, group.id)
      const leaderId = leaderOf(state, group.id)

      async function applyRole(member, role, takeOver = false) {
        if (busy) return
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          await store.mutate({
            action: 'assign',
            groupId: group.id,
            sessionId: member.sessionId,
            role,
            takeover: takeOver === true,
          })
          setTakeover(null)
          setNotice(
            role === ROLE_LEADER
              ? `已将 ${displayNameOf(byId, member.sessionId)} 设为组长`
              : `已将 ${displayNameOf(byId, member.sessionId)} 转为成员`,
          )
        } catch (caught) {
          setError(caught.message || '权限调整失败，请稍后重试')
        } finally {
          setBusy(false)
        }
      }

      function requestRole(member, role) {
        if (role === ROLE_LEADER && leaderId && leaderId !== member.sessionId) {
          setTakeover({ member, leaderId })
          setError(null)
          return
        }
        applyRole(member, role, false)
      }

      async function removeMember() {
        if (!removeTarget || busy) return
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          await store.mutate({
            action: 'leave',
            groupId: group.id,
            sessionId: removeTarget.sessionId,
          })
          setNotice(`已将 ${displayNameOf(byId, removeTarget.sessionId)} 移出分组`)
          setRemoveTarget(null)
        } catch (caught) {
          setError(caught.message || '移出成员失败，请稍后重试')
        } finally {
          setBusy(false)
        }
      }

      return h(
        Fragment,
        null,
        h(
          Modal,
          {
            title: `管理「${group.name}」`,
            description: '添加或移出成员，调整组长与成员权限。',
            wide: true,
            stacked: true,
            onClose,
            footer: h(
              Fragment,
              null,
              h(
                'button',
                { type: 'button', className: 'ma-btn ma-btn-ghost', onClick: onClose },
                '完成',
              ),
              h(
                'button',
                { type: 'button', className: 'ma-btn ma-btn-primary', onClick: () => setAddOpen(true) },
                h(Icon, { name: 'plus', size: 14 }),
                '添加成员',
              ),
            ),
          },
          h(
            'div',
            { className: 'ma-manage' },
            h(
              'div',
              { className: 'ma-manage-summary', style: { '--ma-c': group.color } },
              h(Avatar, { name: group.name, color: group.color, size: 40 }),
              h(
                'div',
                { className: 'ma-manage-summary-copy' },
                h('strong', { title: group.description || group.name }, group.description || '还没有填写分组说明。'),
                h(
                  'span',
                  null,
                  `${members.length}/${group.maxSessions ?? 8} 位成员 · ${leaderId ? `组长 ${displayNameOf(byId, leaderId)}` : '组长空缺'}`,
                ),
              ),
            ),
            h(SessionLimitSection, {
              group,
              memberCount: members.length,
              store,
              onNotice: (message) => {
                setNotice(message)
                setError(null)
              },
            }),
            h(SpawnConfigSection, {
              group,
              store,
              onNotice: (message) => {
                setNotice(message)
                setError(null)
              },
            }),
            h(
              'div',
              { className: 'ma-manage-head' },
              h('strong', null, '成员与权限'),
              h('span', { className: 'ma-count-pill' }, `${members.length} 位`),
            ),
            members.length === 0
              ? h(EmptyBlock, {
                  icon: 'users',
                  title: '还没有成员',
                  description: '扫描当前工作区的会话，选择要加入这个分组的对话。',
                  action: h(
                    'button',
                    {
                      type: 'button',
                      className: 'ma-btn ma-btn-primary ma-btn-sm',
                      onClick: () => setAddOpen(true),
                    },
                    h(Icon, { name: 'plus', size: 14 }),
                    '添加成员',
                  ),
                })
              : h(
                  'div',
                  { className: 'ma-manage-list' },
                  members.map((membership) => {
                    const name = displayNameOf(byId, membership.sessionId)
                    const isLeader = membership.role === ROLE_LEADER
                    return h(
                      'div',
                      { key: membership.sessionId, className: 'ma-manage-row' },
                      h(
                        'span',
                        { className: 'ma-member-avatar', style: { color: group.color } },
                        h(Icon, { name: 'user', size: 15 }),
                      ),
                      h(
                        'span',
                        { className: 'ma-manage-person' },
                        h('strong', { title: name }, name),
                        h('small', { title: membership.sessionId }, shortId(membership.sessionId)),
                      ),
                      h(RoleBadge, { role: membership.role, compact: true }),
                      h(
                        'span',
                        { className: 'ma-manage-actions' },
                        isLeader && membership.sessionId === leaderId
                          ? h(
                              'span',
                              { className: 'ma-leader-mark', title: '分组必须保留组长，可先把其他成员设为组长' },
                              h(Icon, { name: 'crown', size: 11 }),
                              '当前组长',
                            )
                          : h(
                              'button',
                              {
                                type: 'button',
                                className: cx('ma-text-btn', !isLeader && 'ma-text-btn-accent'),
                                disabled: busy,
                                onClick: () => requestRole(membership, isLeader ? ROLE_MEMBER : ROLE_LEADER),
                              },
                              isLeader ? '转为成员' : '设为组长',
                            ),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'ma-text-btn ma-text-btn-danger',
                            disabled: busy,
                            onClick: () => {
                              setRemoveTarget(membership)
                              setTakeover(null)
                              setError(null)
                            },
                          },
                          '移出',
                        ),
                      ),
                    )
                  }),
                ),
            takeover
              ? h(
                  'div',
                  { className: 'ma-manage-confirm' },
                  h(
                    'p',
                    null,
                    '将 ',
                    h('strong', null, displayNameOf(byId, takeover.member.sessionId)),
                    ' 设为组长，现任组长 ',
                    h('strong', null, displayNameOf(byId, takeover.leaderId)),
                    ' 会自动转为成员。',
                  ),
                  h(
                    'div',
                    { className: 'ma-manage-confirm-actions' },
                    h(
                      'button',
                      { type: 'button', className: 'ma-btn ma-btn-ghost ma-btn-sm', onClick: () => setTakeover(null) },
                      '取消',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'ma-btn ma-btn-primary ma-btn-sm',
                        disabled: busy,
                        onClick: () => applyRole(takeover.member, ROLE_LEADER, true),
                      },
                      '确认接管',
                    ),
                  ),
                )
              : null,
            removeTarget
              ? h(
                  'div',
                  { className: 'ma-manage-confirm is-danger' },
                  h(
                    'p',
                    null,
                    '将 ',
                    h('strong', null, displayNameOf(byId, removeTarget.sessionId)),
                    ' 移出这个分组？该对话在其他分组中的角色不受影响。',
                  ),
                  h(
                    'div',
                    { className: 'ma-manage-confirm-actions' },
                    h(
                      'button',
                      { type: 'button', className: 'ma-btn ma-btn-ghost ma-btn-sm', onClick: () => setRemoveTarget(null) },
                      '取消',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'ma-btn ma-btn-danger ma-btn-sm',
                        disabled: busy,
                        onClick: removeMember,
                      },
                      '确认移出',
                    ),
                  ),
                )
              : null,
            notice
              ? h(
                  'div',
                  { className: 'ma-inline-notice', role: 'status' },
                  h(Icon, { name: 'check', size: 14 }),
                  notice,
                )
              : null,
            error
              ? h(
                  'div',
                  { className: 'ma-form-error', role: 'alert' },
                  h(Icon, { name: 'info', size: 14 }),
                  error,
                )
              : null,
          ),
        ),
        addOpen
          ? h(AddMembersDialog, {
              group,
              state,
              byId,
              workspaces,
              preferredCwd,
              store,
              onClose: () => setAddOpen(false),
              onAdded: (count) => {
                setAddOpen(false)
                setNotice(`已添加 ${count} 位成员`)
              },
            })
          : null,
      )
    }

    function messageAudience(message, byId) {
      if (message.mode === 'private') {
        return `私聊给 ${displayNameOf(byId, message.recipientSessionId)}`
      }
      const count = Array.isArray(message.deliveries) ? message.deliveries.length : 0
      return count > 0 ? `广播给 ${count} 位成员` : '广播'
    }

    function deliveryText(delivery) {
      if (delivery.status === 'failed') return '投递失败'
      if (delivery.status === 'sent') return '已送达'
      return '投递中'
    }

    function messageForAgent(group, senderName, message) {
      return [
        `【分组消息｜${group.name}】`,
        `${senderName} 向你发送了一条消息：`,
        '',
        message.content,
        '',
        `消息编号：${message.id}`,
        '收到后必须回复：调用 multi_agent_message 工具（op="-r"），传 content 即可回复。',
      ].join('\n')
    }

    function replyForAgent(group, replierName, message, content) {
      return [
        `【分组回复｜${group.name}】`,
        `${replierName} 回复了你的消息：`,
        '',
        content,
        '',
        `原消息编号：${message.id}`,
      ].join('\n')
    }

    function GroupMessagesDialog({
      group,
      state,
      byId,
      viewerSessionId,
      canSwitchViewer = false,
      deliverInterjection,
      onClose,
    }) {
      const members = groupMembers(state, group.id)
      const initialViewer =
        viewerSessionId === USER_VIEWER_ID
          ? USER_VIEWER_ID
          : members.find((membership) => membership.sessionId === viewerSessionId)?.sessionId ||
            members[0]?.sessionId ||
            viewerSessionId
      const [viewerId, setViewerId] = useState(initialViewer)
      const isUser = viewerId === USER_VIEWER_ID
      const viewerName = isUser ? USER_SENDER_NAME : displayNameOf(byId, viewerId)
      const [queue, setQueue] = useState({ status: 'loading', messages: [], role: ROLE_MEMBER, isLeader: false, error: null })
      const [refreshTick, setRefreshTick] = useState(0)
      const [filter, setFilter] = useState('all')
      const [mode, setMode] = useState('broadcast')
      const [recipient, setRecipient] = useState('')
      const [content, setContent] = useState('')
      const [sending, setSending] = useState(false)
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)
      const [replyTarget, setReplyTarget] = useState(null)
      const [replyText, setReplyText] = useState('')
      const [replying, setReplying] = useState(false)
      const replyRef = useRef(null)

      const viewerMembership = isUser
        ? null
        : members.find((membership) => membership.sessionId === viewerId) || null
      const others = isUser
        ? members.slice()
        : members.filter((membership) => membership.sessionId !== viewerId)
      const activeRecipient = others.some((membership) => membership.sessionId === recipient)
        ? recipient
        : others[0]?.sessionId || ''

      useEffect(() => {
        let alive = true
        setQueue((current) => ({
          ...current,
          status: current.messages.length > 0 ? 'ready' : 'loading',
          error: null,
        }))
        apiFetch(
          `/messages?groupId=${encodeURIComponent(group.id)}&sessionId=${encodeURIComponent(viewerId)}`,
        )
          .then((payload) => {
            if (!alive) return
            setQueue({
              status: 'ready',
              messages: Array.isArray(payload.messages) ? payload.messages : [],
              role: payload.role === ROLE_LEADER ? ROLE_LEADER : ROLE_MEMBER,
              isLeader: payload.isLeader === true,
              error: null,
            })
          })
          .catch((requestFailure) => {
            if (!alive) return
            setQueue((current) => ({
              ...current,
              status: 'error',
              error: requestFailure.message || '消息队列加载失败',
            }))
          })
        return () => {
          alive = false
        }
      }, [group.id, viewerId, refreshTick])

      useEffect(() => {
        if (!replyTarget) return
        if (replyRef.current) replyRef.current.focus()
      }, [replyTarget])

      useEffect(() => {
        setRecipient((current) => (current && others.some((entry) => entry.sessionId === current) ? current : others[0]?.sessionId || ''))
        setReplyTarget(null)
        setReplyText('')
      }, [viewerId, group.id])

      const pendingMessages = useMemo(
        () =>
          isUser
            ? []
            : queue.messages.filter((message) => {
                const delivery = message.deliveries.find((entry) => entry.sessionId === viewerId)
                return delivery && !delivery.reply && delivery.status !== 'failed'
              }),
        [queue.messages, viewerId, isUser],
      )
      const sentMessages = useMemo(
        () =>
          isUser
            ? queue.messages.filter((message) => message.senderKind === 'user')
            : queue.messages.filter((message) => message.senderSessionId === viewerId),
        [queue.messages, viewerId, isUser],
      )
      const displayedMessages = useMemo(() => {
        if (filter === 'pending') return pendingMessages
        if (filter === 'mine') return sentMessages
        return queue.messages
      }, [filter, pendingMessages, queue.messages, sentMessages])
      const canSend =
        !sending &&
        queuedContent(content) &&
        (isUser || pendingMessages.length === 0) &&
        (mode === 'broadcast' ? others.length > 0 : Boolean(activeRecipient))

      function queuedContent(value) {
        return typeof value === 'string' && value.trim().length > 0
      }

      async function markDelivery(messageId, sessionId, ok, failMessage, isReply = false) {
        try {
          await apiFetch('/action', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-dsh-multi-agent': '1',
            },
            body: JSON.stringify({
              action: 'markDelivered',
              messageId,
              sessionId,
              ok,
              error: ok ? null : failMessage || '插话投递失败',
              reply: isReply === true,
            }),
          })
        } catch {
          // The queue row already records the reply; a failed status update can
          // be retried by reloading or sending another message.
        }
      }

      async function sendMessage() {
        if (!canSend) return
        setSending(true)
        setError(null)
        setNotice(null)
        try {
          const data = await apiFetch('/action', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-dsh-multi-agent': '1',
            },
            body: JSON.stringify({
              action: 'sendMessage',
              groupId: group.id,
              ...(isUser
                ? { senderKind: 'user', senderName: USER_SENDER_NAME }
                : { senderSessionId: viewerId }),
              mode,
              recipientSessionId: mode === 'private' ? activeRecipient : null,
              content: content.trim(),
            }),
          })
          const message = data.result
          if (!message) throw new Error('消息已记录，但没有返回投递信息')
          let sent = 0
          let failed = 0
          if (typeof deliverInterjection !== 'function') {
            failed = message.deliveries.length
          } else {
            for (const delivery of message.deliveries) {
              try {
                await deliverInterjection(
                  delivery.sessionId,
                  messageForAgent(group, isUser ? USER_SENDER_NAME : displayNameOf(byId, viewerId), message),
                )
                await markDelivery(message.id, delivery.sessionId, true, null)
                sent += 1
              } catch (deliveryFailure) {
                await markDelivery(message.id, delivery.sessionId, false, deliveryFailure.message)
                failed += 1
              }
            }
          }
          setContent('')
          setNotice(
            failed === 0
              ? `消息已插话发送给 ${sent} 位成员`
              : `已投递 ${sent} 位，${failed} 位投递失败；失败记录已保留在队列中`,
          )
          setRefreshTick((value) => value + 1)
        } catch (sendFailure) {
          setError(sendFailure.message || '发送失败，请稍后重试')
        } finally {
          setSending(false)
        }
      }

      async function submitReply(message) {
        const text = replyText.trim()
        if (!text || replying) return
        setReplying(true)
        setError(null)
        setNotice(null)
        try {
          const data = await apiFetch('/action', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-dsh-multi-agent': '1',
            },
            body: JSON.stringify({
              action: 'replyMessage',
              groupId: group.id,
              messageId: message.id,
              sessionId: viewerId,
              replierName: displayNameOf(byId, viewerId),
              content: text,
            }),
          })
          const delivery = data.result && data.result.delivery
          const delivered = Boolean(delivery && delivery.delivered)
          setReplyTarget(null)
          setReplyText('')
          setNotice(delivery && delivery.replyToUser
            ? '回复已记录并展示给用户'
            : delivered
              ? '回复已插话发送给原发送者'
              : `回复已记录，但插话投递失败${delivery && delivery.error ? `：${delivery.error}` : ''}`)
          setRefreshTick((value) => value + 1)
        } catch (replyFailure) {
          setError(replyFailure.message || '回复失败，请稍后重试')
        } finally {
          setReplying(false)
        }
      }

      return h(
        Modal,
        {
          title: `消息 · ${group.name}`,
          description: '组内广播与私聊都通过插话送达目标对话；收到消息的成员需要回复。',
          onClose,
          wide: true,
        },
        h(
          'div',
          { className: 'ma-msg-shell' },
          h(
            'div',
            { className: 'ma-msg-identity' },
            h(Avatar, { name: group.name, color: group.color, size: 38 }),
            h(
              'div',
              { className: 'ma-msg-identity-copy' },
              h(
                'span',
                null,
                isUser
                  ? '用户（我） · 控制台'
                  : viewerMembership
                    ? `${displayNameOf(byId, viewerId)} · ${roleLabel(viewerMembership.role)}`
                    : '当前对话已不在这个分组',
              ),
            ),
            canSwitchViewer
              ? h(
                  'label',
                  { className: 'ma-msg-viewer' },
                  h('span', null, '查看身份'),
                  h(
                    'select',
                    {
                      value: viewerId,
                      onChange: (event) => setViewerId(event.target.value),
                    },
                    h('option', { value: USER_VIEWER_ID }, '用户（我） · 控制台'),
                    members.map((membership) =>
                      h(
                        'option',
                        { key: membership.sessionId, value: membership.sessionId },
                        `${displayNameOf(byId, membership.sessionId)} · ${roleLabel(membership.role)}`,
                      ),
                    ),
                  ),
                )
              : null,
            h(
              'span',
              { className: cx('ma-msg-access', isUser && 'is-user', !isUser && queue.isLeader && 'is-leader') },
              h(Icon, { name: isUser || queue.isLeader ? 'lock' : 'user', size: 12 }),
              isUser ? '用户视图 · 全组消息' : queue.isLeader ? '组长视图 · 全组消息' : '成员视图 · 与我相关',
            ),
          ),
          h(
            'div',
            { className: 'ma-msg-stats' },
            h('span', null, h('strong', null, queue.messages.length), ' 条队列消息'),
            h('span', { className: pendingMessages.length > 0 ? 'is-warn' : undefined }, h('strong', null, pendingMessages.length), ' 条待我回复'),
            h('span', null, h('strong', null, sentMessages.length), ' 条我发出的'),
            h(
              'button',
              {
                type: 'button',
                className: 'ma-text-btn',
                onClick: () => setRefreshTick((value) => value + 1),
              },
              h(Icon, { name: 'refresh', size: 13 }),
              '刷新',
            ),
          ),
          h(
            'div',
            { className: 'ma-msg-compose' },
            h(
              'div',
              { className: 'ma-msg-compose-head' },
              h(
                'div',
                { className: 'ma-msg-compose-title' },
                h('strong', null, '插话发送'),
                h('span', null, `发送人：${isUser ? '用户（我）' : viewerName}`),
              ),
              h(
                'div',
                { className: 'ma-msg-mode' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: cx(mode === 'broadcast' && 'is-active'),
                    onClick: () => setMode('broadcast'),
                  },
                  '广播全员',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: cx(mode === 'private' && 'is-active'),
                    onClick: () => setMode('private'),
                  },
                  '私聊',
                ),
              ),
            ),
            mode === 'private'
              ? h(
                  'label',
                  { className: 'ma-msg-recipient' },
                  h('span', null, '发给'),
                  h(
                    'select',
                    { value: activeRecipient, onChange: (event) => setRecipient(event.target.value) },
                    others.length === 0
                      ? h('option', { value: '' }, '没有其他成员')
                      : others.map((membership) =>
                          h(
                            'option',
                            { key: membership.sessionId, value: membership.sessionId },
                            `${displayNameOf(byId, membership.sessionId)} · ${roleLabel(membership.role)}`,
                          ),
                        ),
                  ),
                )
              : h(
                  'p',
                  { className: 'ma-msg-audience-note' },
                  h(Icon, { name: 'users', size: 13 }),
                  others.length > 0
                    ? isUser
                      ? `将以「用户」身份插话发送给全部 ${others.length} 位成员`
                      : `将插话发送给另外 ${others.length} 位成员`
                    : '组内还没有其他成员',
                ),
            pendingMessages.length > 0
              ? h(
                  'div',
                  { className: 'ma-msg-block' },
                  h(Icon, { name: 'info', size: 14 }),
                  h(
                    'span',
                    null,
                    `你有 ${pendingMessages.length} 条消息待回复。先完成回复，才能继续发送新消息。`,
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'ma-text-btn', onClick: () => setFilter('pending') },
                    '去回复',
                  ),
                )
              : null,
            h('textarea', {
              className: 'ma-msg-input',
              value: content,
              maxLength: 4000,
              rows: 3,
              placeholder: mode === 'broadcast' ? '写一条广播消息，所有组内成员都会收到插话…' : '写一条私聊消息，只有选中的成员会收到插话…',
              onChange: (event) => setContent(event.target.value),
              onKeyDown: (event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                  event.preventDefault()
                  sendMessage()
                }
              },
            }),
            h(
              'div',
              { className: 'ma-msg-compose-foot' },
              h('span', null, `${content.length}/4000 · Ctrl+Enter 发送`),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ma-btn ma-btn-primary ma-btn-sm',
                  disabled: !canSend,
                  onClick: sendMessage,
                },
                h(Icon, { name: 'send', size: 14 }),
                sending ? '发送中…' : '插话发送',
              ),
            ),
          ),
          error
            ? h('div', { className: 'ma-form-error', role: 'alert' }, h(Icon, { name: 'info', size: 14 }), error)
            : null,
          notice
            ? h('div', { className: 'ma-inline-notice', role: 'status' }, h(Icon, { name: 'check', size: 14 }), notice)
            : null,
          h(
            'div',
            { className: 'ma-msg-queue-head' },
            h('strong', null, '消息队列'),
            h(
              'div',
              { className: 'ma-msg-filters' },
              h(
                'button',
                { type: 'button', className: cx(filter === 'all' && 'is-active'), onClick: () => setFilter('all') },
                `全部 ${queue.messages.length}`,
              ),
              h(
                'button',
                { type: 'button', className: cx(filter === 'pending' && 'is-active'), onClick: () => setFilter('pending') },
                `待我回复 ${pendingMessages.length}`,
              ),
              h(
                'button',
                { type: 'button', className: cx(filter === 'mine' && 'is-active'), onClick: () => setFilter('mine') },
                `我发出的 ${sentMessages.length}`,
              ),
            ),
          ),
          queue.status === 'loading'
            ? h('div', { className: 'ma-msg-empty' }, h('span', { className: 'ma-spinner' }), '正在读取消息队列…')
            : queue.status === 'error'
              ? h('div', { className: 'ma-msg-empty is-error' }, h(Icon, { name: 'info', size: 18 }), queue.error)
              : displayedMessages.length === 0
                ? h(
                    'div',
                    { className: 'ma-msg-empty' },
                    h(Icon, { name: 'message', size: 20 }),
                    filter === 'pending' ? '没有待回复消息。' : filter === 'mine' ? '你还没有发送过消息。' : '队列还是空的，发送第一条组内消息。',
                  )
                : h(
                    'div',
                    { className: 'ma-msg-list' },
                    displayedMessages.map((message) => {
                      const mine = isUser
                        ? message.senderKind === 'user'
                        : message.senderSessionId === viewerId
                      const myDelivery = isUser
                        ? null
                        : message.deliveries.find((delivery) => delivery.sessionId === viewerId)
                      const canReply = !isUser && Boolean(myDelivery) && !myDelivery.reply && myDelivery.status !== 'failed'
                      const replies = message.deliveries.filter((delivery) => delivery.reply).length
                      const senderName =
                        message.senderKind === 'user'
                          ? USER_SENDER_NAME
                          : displayNameOf(byId, message.senderSessionId)
                      return h(
                        'article',
                        { key: message.id, className: cx('ma-msg-card', mine && 'is-mine') },
                        h(
                          'header',
                          { className: 'ma-msg-card-head' },
                          h(Avatar, {
                            name: senderName,
                            color: group.color,
                            size: 28,
                            muted: !mine,
                          }),
                          h(
                            'div',
                            { className: 'ma-msg-card-who' },
                            h('strong', null, senderName),
                            h(
                              'span',
                              null,
                              `${messageAudience(message, byId)} · ${message.mode === 'broadcast' ? `${replies}/${message.deliveries.length} 已回复` : '私聊'}`,
                            ),
                          ),
                          h('time', { dateTime: message.createdAt }, formatDateTime(message.createdAt)),
                          mine ? h('span', { className: 'ma-msg-mine-tag' }, '我发出的') : null,
                        ),
                        h('p', { className: 'ma-msg-content' }, message.content),
                        h(
                          'div',
                          { className: 'ma-msg-deliveries' },
                          message.deliveries.map((delivery) =>
                            h(
                              'div',
                              {
                                key: delivery.sessionId,
                                className: cx('ma-msg-delivery', delivery.status === 'failed' && 'is-failed'),
                              },
                              h(
                                'div',
                                { className: 'ma-msg-delivery-top' },
                                h(Icon, { name: 'user', size: 11 }),
                                h('span', { className: 'ma-msg-target' }, displayNameOf(byId, delivery.sessionId)),
                                h(
                                  'span',
                                  { className: cx('ma-msg-status', delivery.status === 'failed' && 'is-failed') },
                                  deliveryText(delivery),
                                ),
                                delivery.reply
                                  ? h(
                                      'span',
                                      { className: 'ma-msg-status is-ok' },
                                      delivery.reply.status === 'failed' ? '回复投递失败' : '已回复',
                                    )
                                  : h(
                                      'span',
                                      { className: 'ma-msg-status is-pending' },
                                      delivery.status === 'failed' ? '无需回复' : '待回复',
                                    ),
                              ),
                              delivery.reply
                                ? h(
                                    'div',
                                    { className: 'ma-msg-reply' },
                                    h('p', null, delivery.reply.content),
                                    h(
                                      'span',
                                      null,
                                      `${formatDateTime(delivery.reply.createdAt)} · ${delivery.reply.status === 'failed' ? '回复投递失败' : delivery.reply.status === 'sent' ? (message.senderKind === 'user' ? '回复已送达用户' : '回复已插话送达') : '回复投递中'}`,
                                    ),
                                  )
                                : null,
                            ),
                          ),
                        ),
                        canReply
                          ? replyTarget === message.id
                            ? h(
                                'div',
                                { className: 'ma-msg-reply-box' },
                                h('textarea', {
                                  ref: replyRef,
                                  rows: 3,
                                  maxLength: 4000,
                                  value: replyText,
                                  placeholder: message.senderKind === 'user' ? '回复这条消息，回复会展示在用户的消息队列…' : '回复这条消息，回复会插话发送给原发送者…',
                                  onChange: (event) => setReplyText(event.target.value),
                                }),
                                h(
                                  'div',
                                  { className: 'ma-msg-reply-actions' },
                                  h(
                                    'span',
                                    null,
                                    pendingMessages.length > 0 ? '回复后即可解除发送限制' : '回复内容会进入消息队列',
                                  ),
                                  h(
                                    'button',
                                    { type: 'button', className: 'ma-btn ma-btn-ghost ma-btn-sm', onClick: () => setReplyTarget(null) },
                                    '取消',
                                  ),
                                  h(
                                    'button',
                                    {
                                      type: 'button',
                                      className: 'ma-btn ma-btn-primary ma-btn-sm',
                                      disabled: replying || !replyText.trim(),
                                      onClick: () => submitReply(message),
                                    },
                                    replying ? '回复中…' : '发送回复',
                                  ),
                                ),
                              )
                            : h(
                                'div',
                                { className: 'ma-msg-actions' },
                                h(
                                  'button',
                                  {
                                    type: 'button',
                                    className: 'ma-btn ma-btn-outline ma-btn-sm',
                                    onClick: () => {
                                      setReplyTarget(message.id)
                                      setReplyText('')
                                    },
                                  },
                                  h(Icon, { name: 'reply', size: 13 }),
                                  '回复',
                                ),
                              )
                          : null,
                      )
                    }),
                  ),
          h(
            'div',
            { className: 'ma-msg-foot' },
            h(Icon, { name: 'shield', size: 13 }),
            h(
              'span',
              null,
              isUser
                ? '你正以用户身份查看全组广播与私聊；成员回复会显示在这条消息的队列中。'
                : queue.isLeader
                  ? '组长可查看本组广播与私聊队列；成员只能查看与自己相关的消息。'
                  : '每个成员必须回复收到的消息；未回复时不能发送新消息。',
            ),
          ),
        ),
      )
    }

    function GroupPage(props) {
      const { store, deliverInterjection } = props
      const state = usePluginStore(store)
      const useSessions = typeof props.useSessions === 'function' ? props.useSessions : () => null
      const byId = useSessions((snapshot) => (snapshot && snapshot.byId) || null)
      const useWorkspaces = typeof props.useWorkspaces === 'function' ? props.useWorkspaces : NOOP_HOOK
      const workspaces = useWorkspaces((snapshot) => (snapshot && snapshot.items) || [])
      const leaderCandidates = useMemo(
        () =>
          workspaceSessions(byId, workspaces, '', null).map((summary) => ({
            id: summary.id,
            title: displayNameOf(byId, summary.id),
          })),
        [byId, workspaces],
      )
      const [query, setQuery] = useState('')
      const [selectedId, setSelectedId] = useState(null)
      const [editor, setEditor] = useState(null)
      const [addTarget, setAddTarget] = useState(null)
      const [manageTarget, setManageTarget] = useState(null)
      const [messagesTarget, setMessagesTarget] = useState(null)
      const [deleteTarget, setDeleteTarget] = useState(null)
      const [confirm, setConfirm] = useState(null)
      const [toast, setToast] = useState(null)
      const [acting, setActing] = useState(false)
      const stats = statsOf(state)

      useEffect(() => {
        store.load(true).catch(() => {})
      }, [store])

      useEffect(() => {
        if (!toast) return undefined
        const timer = setTimeout(() => setToast(null), 3000)
        return () => clearTimeout(timer)
      }, [toast])

      const groups = useMemo(() => {
        const search = query.trim().toLowerCase()
        return (state.groups || [])
          .slice()
          .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
          .filter((group) => {
            if (!search) return true
            return `${group.name} ${group.description || ''}`.toLowerCase().includes(search)
          })
      }, [state.groups, query])

      const activeGroup =
        groups.find((group) => group.id === selectedId) ||
        (state.groups || []).find((group) => group.id === selectedId) ||
        groups[0] ||
        null
      const messagesGroup =
        (messagesTarget && (state.groups || []).find((group) => group.id === messagesTarget)) || null
      const messagesViewerId = messagesGroup ? USER_VIEWER_ID : null

      function showToast(message, tone = 'success') {
        setToast({ message, tone })
      }

      async function saveGroup(values) {
        const editing = editor && editor.mode === 'edit'
        const data = await store.mutate(
          editing
            ? { action: 'updateGroup', groupId: editor.group.id, ...values }
            : { action: 'createGroup', ...values },
        )
        if (!editing && data.result && data.result.id) setSelectedId(data.result.id)
        setEditor(null)
        showToast(editing ? '分组已更新' : '分组已创建')
      }

      async function removeGroup() {
        if (!deleteTarget) return
        await store.mutate({ action: 'deleteGroup', groupId: deleteTarget.id })
        setDeleteTarget(null)
        showToast('分组已删除')
      }

      async function performRole(member, role, takeover) {
        if (!activeGroup) return
        setActing(true)
        try {
          await store.mutate({
            action: 'assign',
            groupId: activeGroup.id,
            sessionId: member.sessionId,
            role,
            takeover: takeover === true,
          })
          showToast(role === ROLE_LEADER ? '已设为组长' : '已转为成员')
        } finally {
          setActing(false)
        }
      }

      async function requestRole(member, role) {
        if (!activeGroup || acting) return
        if (role === ROLE_LEADER) {
          const leaderId = leaderOf(state, activeGroup.id)
          if (leaderId && leaderId !== member.sessionId) {
            setConfirm({ kind: 'takeover', member, leaderId })
            return
          }
        }
        try {
          await performRole(member, role, false)
        } catch (error) {
          showToast(error.message || '操作失败，请稍后重试', 'error')
        }
      }

      async function confirmTakeover() {
        if (!confirm) return
        await performRole(confirm.member, ROLE_LEADER, true)
        setConfirm(null)
      }

      async function removeMember(member) {
        if (!activeGroup) return
        setActing(true)
        try {
          await store.mutate({ action: 'leave', groupId: activeGroup.id, sessionId: member.sessionId })
          setConfirm(null)
          showToast('已移出分组')
        } finally {
          setActing(false)
        }
      }

      return h(
        'section',
        { className: 'ma-page' },
        h(
          'header',
          { className: 'ma-page-head' },
          h(
            'div',
            { className: 'ma-page-copy' },
            h('div', { className: 'ma-kicker' }, h('i', null), 'MULTI-AGENT'),
            h('h1', null, 'Agent 分组'),
            h('p', null, '按小组组织对话。每个对话可以同时加入多个小组，并在每个小组中拥有独立的组长或成员权限。'),
          ),
          h(
            'button',
            { type: 'button', className: 'ma-btn ma-btn-primary', onClick: () => setEditor({ mode: 'create' }) },
            h(Icon, { name: 'plus', size: 16 }),
            '新建分组',
          ),
        ),
        h(
          'div',
          { className: 'ma-overview' },
          h(StatItem, { icon: 'folder', value: stats.groups, label: '个分组' }),
          h(StatItem, { icon: 'user', value: stats.sessions, label: '个对话已加入', tone: 'sky' }),
          h(StatItem, { icon: 'crown', value: stats.leaders, label: '个组长席位', tone: 'amber' }),
          h(
            'div',
            { className: 'ma-overview-note' },
            h(Icon, { name: 'shield', size: 14 }),
            '每组 1 位组长，成员不限',
          ),
        ),
        state.error
          ? h(
              'div',
              { className: 'ma-alert', role: 'alert' },
              h(Icon, { name: 'info', size: 16 }),
              h('span', null, state.error),
              h(
                'button',
                { type: 'button', className: 'ma-alert-action', onClick: () => store.load(true).catch(() => {}) },
                '重试',
              ),
            )
          : null,
        state.status === 'loading' && state.groups.length === 0
          ? h(
              'div',
              { className: 'ma-workspace is-loading', 'aria-busy': 'true' },
              h(
                'aside',
                { className: 'ma-list-pane' },
                h('div', { className: 'ma-skeleton ma-skeleton-title' }),
                [0, 1, 2].map((key) => h('div', { key, className: 'ma-skeleton ma-skeleton-row' })),
              ),
              h(
                'div',
                { className: 'ma-detail-pane' },
                h('div', { className: 'ma-skeleton ma-skeleton-detail' }),
              ),
            )
          : h(
              'div',
              { className: 'ma-workspace' },
              h(
                'aside',
                { className: 'ma-list-pane', 'aria-label': '分组列表' },
                h(
                  'div',
                  { className: 'ma-list-head' },
                  h('strong', null, '全部分组'),
                  h('span', { className: 'ma-count-pill' }, stats.groups),
                ),
                h(
                  'label',
                  { className: 'ma-search' },
                  h(Icon, { name: 'search', size: 15 }),
                  h('input', {
                    value: query,
                    placeholder: '搜索分组',
                    'aria-label': '搜索分组',
                    onChange: (event) => setQuery(event.target.value),
                  }),
                  query
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'ma-search-clear',
                          'aria-label': '清空搜索',
                          onClick: () => setQuery(''),
                        },
                        h(Icon, { name: 'x', size: 12 }),
                      )
                    : null,
                ),
                groups.length === 0
                  ? h(
                      'div',
                      { className: 'ma-list-empty' },
                      h(Icon, { name: query ? 'search' : 'users', size: 22 }),
                      h('strong', null, query ? '没有匹配的分组' : '还没有分组'),
                      h(
                        'p',
                        null,
                        query
                          ? '换一个关键词试试。'
                          : '创建小组后，在任意对话顶部选择加入。',
                      ),
                      query
                        ? h(
                            'button',
                            { type: 'button', className: 'ma-btn ma-btn-outline ma-btn-sm', onClick: () => setQuery('') },
                            '清空搜索',
                          )
                        : h(
                            'button',
                            {
                              type: 'button',
                              className: 'ma-btn ma-btn-primary ma-btn-sm',
                              onClick: () => setEditor({ mode: 'create' }),
                            },
                            h(Icon, { name: 'plus', size: 14 }),
                            '创建分组',
                          ),
                    )
                  : h(
                      'div',
                      { className: 'ma-group-list' },
                      groups.map((group) =>
                        h(GroupRow, {
                          key: group.id,
                          group,
                          state,
                          selected: activeGroup && activeGroup.id === group.id,
                          byId,
                          onClick: () => setSelectedId(group.id),
                        }),
                      ),
                    ),
                h(
                  'div',
                  { className: 'ma-list-foot' },
                  h(Icon, { name: 'info', size: 13 }),
                  h('span', null, '选中分组查看成员与权限'),
                ),
              ),
              h(
                'div',
                { className: 'ma-detail-pane' },
                activeGroup
                  ? h(GroupDetail, {
                      group: activeGroup,
                      state,
                      byId,
                      busy: acting,
                      onEdit: (group) => setEditor({ mode: 'edit', group }),
                      onDelete: (group) => setDeleteTarget(group),
                      onRole: requestRole,
                      onRemove: (member) => setConfirm({ kind: 'remove', member }),
                      onAddMembers: (group) => {
                        setConfirm(null)
                        setAddTarget(group)
                      },
                      onManage: (group) => setManageTarget(group),
                      onMessages: (group) => setMessagesTarget(group.id),
                    })
                  : h(
                      'div',
                      { className: 'ma-detail-empty' },
                      h(
                        'div',
                        { className: 'ma-detail-empty-art' },
                        h(GroupGlyph, { size: 34 }),
                      ),
                      h('h2', null, state.groups.length === 0 ? '从第一个分组开始' : '选择一个分组'),
                      h(
                        'p',
                        null,
                        state.groups.length === 0
                          ? '给负责同一件事的 Agent 建一个小组，再在对话顶部认领组长或成员。'
                          : '在左侧列表中选择一个分组，查看成员、权限与角色。',
                      ),
                      state.groups.length === 0
                        ? h(
                            'button',
                            {
                              type: 'button',
                              className: 'ma-btn ma-btn-primary',
                              onClick: () => setEditor({ mode: 'create' }),
                            },
                            h(Icon, { name: 'plus', size: 16 }),
                            '创建第一个分组',
                          )
                        : null,
                    ),
              ),
            ),
        editor
          ? h(GroupEditor, {
              group: editor.mode === 'edit' ? editor.group : null,
              leaderCandidates,
              onClose: () => setEditor(null),
              onSave: saveGroup,
            })
          : null,
        addTarget
          ? h(AddMembersDialog, {
              group: addTarget,
              state,
              byId,
              workspaces: Array.isArray(workspaces) ? workspaces : [],
              store,
              onClose: () => setAddTarget(null),
              onAdded: (count, role) => {
                setAddTarget(null)
                showToast(`已添加 ${count} 位${role === ROLE_LEADER ? '组长' : '成员'}`)
              },
            })
          : null,
        manageTarget
          ? h(GroupManageDialog, {
              group: (state.groups || []).find((group) => group.id === manageTarget.id) || manageTarget,
              state,
              byId,
              workspaces: Array.isArray(workspaces) ? workspaces : [],
              store,
              onClose: () => setManageTarget(null),
            })
          : null,
        messagesGroup && messagesViewerId
          ? h(GroupMessagesDialog, {
              key: messagesGroup.id,
              group: messagesGroup,
              state,
              byId,
              viewerSessionId: messagesViewerId,
              canSwitchViewer: true,
              deliverInterjection,
              onClose: () => setMessagesTarget(null),
            })
          : null,
        deleteTarget
          ? h(
              ConfirmDialog,
              {
                title: '删除分组？',
                description: '这个操作不能撤销。',
                confirmLabel: '确认删除',
                tone: 'danger',
                onClose: () => setDeleteTarget(null),
                onConfirm: removeGroup,
              },
              h(
                'div',
                null,
                h('p', null, h('strong', null, deleteTarget.name), ' 及其成员关系将被移除。'),
                h('p', { className: 'ma-muted' }, '对话本身不会被删除，只是不再属于这个分组。'),
              ),
            )
          : null,
        confirm
          ? h(
              ConfirmDialog,
              {
                title: confirm.kind === 'takeover' ? '接管组长？' : '移出成员？',
                description:
                  confirm.kind === 'takeover'
                    ? '组长席位每组只有一位。'
                    : '移出后，对方可以重新加入。',
                confirmLabel: confirm.kind === 'takeover' ? '确认接管' : '移出成员',
                tone: confirm.kind === 'takeover' ? 'primary' : 'danger',
                onClose: () => setConfirm(null),
                onConfirm: () =>
                  confirm.kind === 'takeover' ? confirmTakeover() : removeMember(confirm.member),
              },
              h(
                'div',
                null,
                confirm.kind === 'takeover'
                  ? h(
                      Fragment,
                      null,
                      h(
                        'p',
                        null,
                        '将 ',
                        h('strong', null, displayNameOf(byId, confirm.member.sessionId)),
                        ' 设为组长，现任组长 ',
                        h('strong', null, displayNameOf(byId, confirm.leaderId)),
                        ' 会自动转为成员。',
                      ),
                      h('p', { className: 'ma-muted' }, '两个对话都仍保留在这个分组中。'),
                    )
                  : h(
                      Fragment,
                      null,
                      h(
                        'p',
                        null,
                        '将 ',
                        h('strong', null, displayNameOf(byId, confirm.member.sessionId)),
                        ' 移出 ',
                        h('strong', null, activeGroup ? activeGroup.name : '当前分组'),
                        '。',
                      ),
                      h('p', { className: 'ma-muted' }, '该对话在其他分组中的角色不受影响。'),
                    ),
              ),
            )
          : null,
        toast
          ? h(
              'div',
              { className: cx('ma-toast', toast.tone === 'error' && 'is-error'), role: 'status' },
              h(Icon, { name: toast.tone === 'error' ? 'info' : 'check', size: 15 }),
              toast.message,
            )
          : null,
      )
    }

    function HeaderAction(props) {
      const { store, sessionId, renameSession, deliverInterjection } = props
      const state = usePluginStore(store)
      const useSessions = typeof props.useSessions === 'function' ? props.useSessions : () => null
      const byId = useSessions((snapshot) => (snapshot && snapshot.byId) || null)
      const useWorkspaces = typeof props.useWorkspaces === 'function' ? props.useWorkspaces : NOOP_HOOK
      const workspaces = useWorkspaces((snapshot) => (snapshot && snapshot.items) || [])
      const [open, setOpen] = useState(false)
      const [position, setPosition] = useState(null)
      const [pending, setPending] = useState(null)
      const [takeover, setTakeover] = useState(null)
      const [actionError, setActionError] = useState(null)
      const [actionNotice, setActionNotice] = useState(null)
      const [renaming, setRenaming] = useState(false)
      const [draftName, setDraftName] = useState('')
      const [renameError, setRenameError] = useState(null)
      const [renameBusy, setRenameBusy] = useState(false)
      const [creatingGroup, setCreatingGroup] = useState(false)
      const [manageGroupId, setManageGroupId] = useState(null)
      const [messagesGroupId, setMessagesGroupId] = useState(null)
      const buttonRef = useRef(null)
      const panelRef = useRef(null)
      const renameRef = useRef(null)

      useEffect(() => {
        store.load(true).catch(() => {})
      }, [store])

      useEffect(() => {
        setOpen(false)
        setRenaming(false)
        setActionError(null)
        setActionNotice(null)
        setTakeover(null)
        setCreatingGroup(false)
        setManageGroupId(null)
        setMessagesGroupId(null)
      }, [sessionId])

      useEffect(() => {
        if (!actionNotice) return undefined
        const timer = setTimeout(() => setActionNotice(null), 2600)
        return () => clearTimeout(timer)
      }, [actionNotice])

      useEffect(() => {
        if (!renaming) return
        if (renameRef.current) {
          renameRef.current.focus()
          renameRef.current.select()
        }
      }, [renaming])

      const entries = useMemo(() => {
        const byGroup = new Map((state.groups || []).map((group) => [group.id, group]))
        return sessionMemberships(state, sessionId)
          .map((membership) => ({ membership, group: byGroup.get(membership.groupId) }))
          .filter((entry) => entry.group)
          .sort((left, right) => String(left.membership.joinedAt).localeCompare(String(right.membership.joinedAt)))
      }, [state.groups, state.memberships, sessionId])

      const enteredIds = useMemo(() => new Set(entries.map((entry) => entry.group.id)), [entries])
      const availableGroups = useMemo(
        () =>
          (state.groups || [])
            .filter((group) => !enteredIds.has(group.id))
            .slice()
            .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))),
        [state.groups, enteredIds],
      )
      const leaderCount = entries.filter((entry) => entry.membership.role === ROLE_LEADER).length
      const managedGroup = manageGroupId
        ? (state.groups || []).find((group) => group.id === manageGroupId) || null
        : null
      const messagesGroup = messagesGroupId
        ? (state.groups || []).find((group) => group.id === messagesGroupId) || null
        : null
      const displayTitle = displayNameOf(byId, sessionId)
      const triggerTitle = entries.length
        ? entries.map((entry) => `${entry.group.name}（${roleLabel(entry.membership.role)}）`).join(' · ')
        : '为这个对话选择分组'

      useLayoutEffect(() => {
        if (!open) {
          setPosition(null)
          return undefined
        }
        const place = () => {
          const anchor = buttonRef.current
          if (!anchor) return
          const rect = anchor.getBoundingClientRect()
          const margin = 10
          const width = Math.min(420, window.innerWidth - margin * 2)
          const height = panelRef.current ? panelRef.current.offsetHeight : 480
          let left = rect.right - width
          left = Math.min(Math.max(margin, left), window.innerWidth - width - margin)
          let top = rect.bottom + 8
          let maxHeight = Math.min(540, window.innerHeight - margin * 2)
          if (top + Math.min(height, maxHeight) > window.innerHeight - margin) {
            top = Math.max(margin, rect.top - Math.min(height, maxHeight) - 8)
            maxHeight = Math.min(maxHeight, rect.top - margin * 2)
          }
          if (maxHeight < 260) {
            top = margin
            maxHeight = window.innerHeight - margin * 2
          }
          setPosition({ left, top, width, maxHeight })
        }
        place()
        window.addEventListener('resize', place)
        window.addEventListener('scroll', place, true)
        return () => {
          window.removeEventListener('resize', place)
          window.removeEventListener('scroll', place, true)
        }
      }, [open, entries.length, availableGroups.length, renaming])

      useEffect(() => {
        if (!open) return undefined
        const onPointer = (event) => {
          if (panelRef.current && panelRef.current.contains(event.target)) return
          if (buttonRef.current && buttonRef.current.contains(event.target)) return
          setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            setOpen(false)
            if (buttonRef.current) buttonRef.current.focus()
          }
        }
        document.addEventListener('pointerdown', onPointer, true)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('pointerdown', onPointer, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [open])

      async function assign(group, role, takeOver = false) {
        if (pending) return
        setPending(`${group.id}:${role}`)
        setActionError(null)
        setActionNotice(null)
        setTakeover(null)
        try {
          await store.mutate({
            action: 'assign',
            sessionId,
            groupId: group.id,
            role,
            takeover: takeOver === true,
          })
          setActionNotice(role === ROLE_LEADER ? `已加入「${group.name}」并成为组长` : `已加入「${group.name}」`)
        } catch (error) {
          if (error.code === 'LEADER_EXISTS') {
            setTakeover({
              groupId: group.id,
              groupName: group.name,
              leaderSessionId: error.leaderSessionId,
            })
          } else {
            setActionError(error.message || '操作失败，请稍后重试')
          }
        } finally {
          setPending(null)
        }
      }

      async function leaveGroup(entry) {
        if (pending) return
        setPending(`leave:${entry.group.id}`)
        setActionError(null)
        setActionNotice(null)
        try {
          await store.mutate({ action: 'leave', sessionId, groupId: entry.group.id })
          setActionNotice(`已退出「${entry.group.name}」`)
        } catch (error) {
          setActionError(error.message || '退出分组失败')
        } finally {
          setPending(null)
        }
      }

      async function createGroup(values) {
        const data = await store.mutate({
          action: 'createGroup',
          ...values,
          leaderSessionId: sessionId,
        })
        const group = data.result
        if (!group) throw new Error('分组已创建，但没有返回分组信息')
        setActionNotice(`已创建「${group.name}」，当前对话成为组长`)
        setCreatingGroup(false)
        setOpen(false)
        setManageGroupId(group.id)
      }

      function startRename() {
        setDraftName(displayTitle)
        setRenameError(null)
        setRenaming(true)
        setActionError(null)
      }

      async function commitRename() {
        const value = draftName.trim()
        if (!value) {
          setRenameError('对话名称不能为空')
          return
        }
        if (value === displayTitle) {
          setRenaming(false)
          return
        }
        if (typeof renameSession !== 'function') {
          setRenameError('当前环境不支持重命名')
          return
        }
        setRenameBusy(true)
        setRenameError(null)
        try {
          await renameSession(sessionId, value)
          setRenaming(false)
          setActionNotice('对话名称已更新')
        } catch (error) {
          setRenameError(error.message || '重命名失败，请稍后重试')
        } finally {
          setRenameBusy(false)
        }
      }

      const panel =
        open &&
        ReactDOM.createPortal(
          h(
            'div',
            {
              ref: panelRef,
              className: 'ma-panel',
              role: 'dialog',
              'aria-label': '对话分组',
              style: position
                ? { left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight }
                : { left: 0, top: 0, width: 420, visibility: 'hidden' },
            },
            h(
              'div',
              { className: 'ma-panel-head' },
              h(
                'div',
                { className: 'ma-panel-head-copy' },
                h('div', { className: 'ma-panel-eyebrow' }, h('i', null), 'MULTI-AGENT'),
                h('h3', null, '对话分组'),
                h(
                  'div',
                  { className: 'ma-session-line' },
                  h('span', { className: 'ma-session-label' }, '当前对话'),
                  renaming
                    ? h(
                        'span',
                        { className: 'ma-rename-row' },
                        h('input', {
                          ref: renameRef,
                          className: 'ma-rename-input',
                          value: draftName,
                          maxLength: 80,
                          placeholder: '给这个对话取个名字',
                          onChange: (event) => {
                            setDraftName(event.target.value)
                            setRenameError(null)
                          },
                          onKeyDown: (event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              commitRename()
                            }
                            if (event.key === 'Escape') {
                              event.preventDefault()
                              setRenaming(false)
                            }
                          },
                        }),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'ma-rename-save',
                            disabled: renameBusy,
                            onClick: commitRename,
                          },
                          renameBusy ? '保存中' : '保存',
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'ma-rename-cancel',
                            disabled: renameBusy,
                            onClick: () => setRenaming(false),
                          },
                          '取消',
                        ),
                      )
                    : h(
                        'button',
                        {
                          type: 'button',
                          className: 'ma-session-name',
                          title: `${displayTitle} · 点击重命名`,
                          onClick: startRename,
                        },
                        h('span', null, displayTitle),
                        h(Icon, { name: 'pencil', size: 12 }),
                      ),
                ),
                renameError ? h('div', { className: 'ma-inline-error' }, renameError) : null,
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ma-icon-btn',
                  'aria-label': '关闭',
                  onClick: () => setOpen(false),
                },
                h(Icon, { name: 'x', size: 17 }),
              ),
            ),
            h(
              'div',
              { className: 'ma-panel-scroll' },
              h(
                'div',
                { className: 'ma-section-head' },
                h('span', null, '所属分组'),
                h(
                  'span',
                  { className: 'ma-section-tools' },
                  h('span', { className: 'ma-count-pill' }, entries.length),
                ),
              ),
              entries.length === 0
                ? h(
                    'div',
                    { className: 'ma-current ma-current-empty' },
                    h('div', { className: 'ma-current-top' }, h(Icon, { name: 'users', size: 15 }), h('strong', null, '尚未加入分组')),
                    h('p', null, '从下方选择一个小队，成为成员或组长。一个对话可以同时加入多个分组。'),
                  )
                : h(
                    'div',
                    { className: 'ma-memberships' },
                    entries.map((entry) =>
                      h(
                        'div',
                        {
                          key: entry.group.id,
                          className: 'ma-membership',
                          style: { '--ma-c': entry.group.color },
                        },
                        h(
                          'div',
                          { className: 'ma-membership-top' },
                          h('span', { className: 'ma-group-dot' }),
                          h('strong', { title: entry.group.name }, entry.group.name),
                          h(RoleBadge, { role: entry.membership.role, compact: true }),
                          h(
                            'span',
                            { className: 'ma-membership-tools' },
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'ma-link',
                                onClick: () => {
                                  setOpen(false)
                                  setMessagesGroupId(entry.group.id)
                                },
                              },
                              '消息',
                            ),
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'ma-link',
                                onClick: () => {
                                  setOpen(false)
                                  setManageGroupId(entry.group.id)
                                },
                              },
                              '管理',
                            ),
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'ma-link-danger',
                                disabled: Boolean(pending),
                                onClick: () => leaveGroup(entry),
                              },
                              pending === `leave:${entry.group.id}` ? '退出中…' : '退出',
                            ),
                          ),
                        ),
                        entry.group.description
                          ? h('p', { className: 'ma-membership-desc' }, entry.group.description)
                          : null,
                        h(
                          'div',
                          { className: 'ma-membership-members' },
                          h('span', { className: 'ma-membership-label' }, '成员'),
                          h(MemberChips, {
                            state,
                            groupId: entry.group.id,
                            sessionId,
                            byId,
                            compact: true,
                          }),
                        ),
                      ),
                    ),
                  ),
              actionNotice
                ? h('div', { className: 'ma-inline-notice', role: 'status' }, h(Icon, { name: 'check', size: 14 }), actionNotice)
                : null,
              h(
                'div',
                { className: 'ma-section-head ma-section-head-spaced' },
                h('span', null, '加入其它分组'),
                h('span', { className: 'ma-count-pill' }, availableGroups.length),
              ),
              availableGroups.length === 0
                ? h(
                    'div',
                    { className: 'ma-panel-empty ma-panel-empty-small' },
                    h(Icon, { name: entries.length ? 'check' : 'spark', size: 20 }),
                    h(
                      'p',
                      null,
                      state.groups.length === 0
                        ? '还没有分组，先创建一个小组。'
                        : entries.length
                          ? '这个对话已加入全部可用分组。'
                          : '所有分组都已包含这个对话。',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'ma-btn ma-btn-outline ma-btn-sm',
                        onClick: () => setCreatingGroup(true),
                      },
                      h(Icon, { name: 'plus', size: 14 }),
                      '创建分组',
                    ),
                  )
                : h(
                    'div',
                    { className: 'ma-choice-list' },
                    availableGroups.map((group) => {
                      const leaderId = leaderOf(state, group.id)
                      const members = groupMembers(state, group.id)
                      const isPendingMember = pending === `${group.id}:member`
                      const isPendingLeader = pending === `${group.id}:leader`
                      return h(
                        'div',
                        { key: group.id, className: 'ma-choice', style: { '--ma-c': group.color } },
                        h(
                          'div',
                          { className: 'ma-choice-main' },
                          h(
                            'div',
                            { className: 'ma-choice-title' },
                            h('span', { className: 'ma-group-dot' }),
                            h('strong', { title: group.name }, group.name),
                          ),
                          h(
                            'div',
                            { className: 'ma-choice-meta' },
                            leaderId
                              ? h(
                                  Fragment,
                                  null,
                                  h(Icon, { name: 'crown', size: 11 }),
                                  h('span', { title: displayNameOf(byId, leaderId) }, `组长 ${displayNameOf(byId, leaderId)}`),
                                )
                              : h(Fragment, null, h(Icon, { name: 'crown', size: 11 }), h('span', null, '组长空缺')),
                            h('i', null),
                            h('span', null, `${members.length} 位成员`),
                          ),
                        ),
                        h(
                          'div',
                          { className: 'ma-choice-actions' },
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'ma-role-btn',
                              disabled: Boolean(pending),
                              onClick: () => assign(group, ROLE_MEMBER),
                            },
                            isPendingMember ? '加入中…' : '成员',
                          ),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'ma-role-btn ma-role-btn-leader',
                              disabled: Boolean(pending),
                              onClick: () => assign(group, ROLE_LEADER),
                            },
                            isPendingLeader ? '认领中…' : '组长',
                          ),
                        ),
                        takeover && takeover.groupId === group.id
                          ? h(
                              'div',
                              { className: 'ma-takeover' },
                              h(
                                'span',
                                null,
                                `已有组长 ${displayNameOf(byId, takeover.leaderSessionId)}，接管后对方会转为成员。`,
                              ),
                              h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'ma-takeover-btn',
                                  disabled: Boolean(pending),
                                  onClick: () => assign(group, ROLE_LEADER, true),
                                },
                                '确认接管',
                              ),
                            )
                          : null,
                      )
                    }),
                  ),
              actionError
                ? h(
                    'div',
                    { className: 'ma-panel-error', role: 'alert' },
                    h(Icon, { name: 'info', size: 14 }),
                    actionError,
                  )
                : null,
            ),
            h(
              'div',
              { className: 'ma-panel-foot' },
              h(Icon, { name: 'shield', size: 14 }),
              h('span', null, '每个分组独立计算权限；一个对话可同时属于多个分组。'),
            ),
          ),
          document.body,
        )

      return h(
        Fragment,
        null,
        h(
          'button',
          {
            ref: buttonRef,
            type: 'button',
            className: cx('ma-trigger', open && 'is-open', entries.length === 0 && 'is-unassigned'),
            style: entries.length === 1 ? { '--ma-c': entries[0].group.color } : undefined,
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            title: triggerTitle,
            onClick: () => {
              setActionError(null)
              setActionNotice(null)
              setTakeover(null)
              setOpen((value) => !value)
            },
          },
          h('span', { className: 'ma-trigger-icon' }, h(Icon, { name: entries.length ? 'users' : 'plus', size: 15 })),
          entries.length === 0
            ? h('span', { className: 'ma-trigger-name' }, '加入分组')
            : entries.length === 1
              ? h(
                  Fragment,
                  null,
                  h('span', { className: 'ma-trigger-name' }, entries[0].group.name),
                  h(
                    'span',
                    { className: cx('ma-trigger-role', entries[0].membership.role === ROLE_LEADER && 'is-leader') },
                    roleLabel(entries[0].membership.role),
                  ),
                )
              : h(
                  Fragment,
                  null,
                  h('span', { className: 'ma-trigger-name' }, `${entries.length} 个分组`),
                  h(
                    'span',
                    { className: cx('ma-trigger-role', leaderCount > 0 && 'is-leader') },
                    leaderCount > 0 ? `${leaderCount} 组长` : '成员',
                  ),
                ),
          h(Icon, { name: 'chevron', size: 13, className: 'ma-trigger-chevron' }),
        ),
        panel,
        creatingGroup
          ? h(GroupEditor, {
              onClose: () => setCreatingGroup(false),
              onSave: createGroup,
              defaultLeaderId: sessionId,
            })
          : null,
        managedGroup
          ? h(GroupManageDialog, {
              group: managedGroup,
              state,
              byId,
              workspaces: Array.isArray(workspaces) ? workspaces : [],
              preferredCwd: byId && byId[sessionId] ? byId[sessionId].cwd : undefined,
              store,
              onClose: () => setManageGroupId(null),
            })
          : null,
        messagesGroup
          ? h(GroupMessagesDialog, {
              key: messagesGroup.id,
              group: messagesGroup,
              state,
              byId,
              viewerSessionId: USER_VIEWER_ID,
              canSwitchViewer: true,
              deliverInterjection,
              onClose: () => setMessagesGroupId(null),
            })
          : null,
      )
    }

    const TASK_CARD_W = 232
    const TASK_CARD_H = 112
    const TASK_STATUS = {
      todo: { label: '待开始', tone: 'todo' },
      doing: { label: '进行中', tone: 'doing' },
      done: { label: '已完成', tone: 'done' },
    }

    function taskStatusMeta(status) {
      return TASK_STATUS[status] || TASK_STATUS.todo
    }

    function TaskGlyph() {
      return h(
        'svg',
        {
          width: 20,
          height: 20,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('rect', { x: 3, y: 3, width: 7, height: 5, rx: 1.4 }),
        h('rect', { x: 14, y: 16, width: 7, height: 5, rx: 1.4 }),
        h('path', { d: 'M6.5 8v4.5h11V16' }),
      )
    }

    function shortSessionId(value) {
      if (typeof value !== 'string' || value.length === 0) return ''
      return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value
    }

    function TaskEditor({ task, members = [], onClose, onSave }) {
      const [title, setTitle] = useState(task ? task.title : '')
      const [description, setDescription] = useState(task ? task.description || '' : '')
      const [status, setStatus] = useState(task ? task.status : 'todo')
      const [assignee, setAssignee] = useState(task ? task.assigneeSessionId || '' : '')
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState(null)
      const titleRef = useRef(null)

      useEffect(() => {
        if (titleRef.current) titleRef.current.focus()
      }, [])

      const canSave = title.trim().length > 0 && !saving

      async function submit(event) {
        if (event) event.preventDefault()
        if (!canSave) return
        setSaving(true)
        setError(null)
        try {
          await onSave({
            title: title.trim(),
            description: description.trim(),
            status,
            assigneeSessionId: assignee,
          })
        } catch (caught) {
          setError(caught.message || '保存任务失败，请稍后重试')
          setSaving(false)
        }
      }

      return h(
        Modal,
        {
          title: task ? '编辑任务' : '新建任务',
          description: task
            ? '修改标题、说明、状态或负责人；已有的连线不会受影响。'
            : '任务会追加到列表末尾并从上往下排列；创建后点击卡片即可与其它任务连线。',
          onClose,
          footer: h(
            Fragment,
            null,
            h('span', { className: 'ma-task-foot-spacer' }),
            h('button', { type: 'button', className: 'ma-btn ma-btn-ghost', onClick: onClose }, '取消'),
            h(
              'button',
              { type: 'button', className: 'ma-btn ma-btn-primary', disabled: !canSave, onClick: submit },
              saving ? '保存中…' : task ? '保存修改' : '创建任务',
            ),
          ),
        },
        h(
          'form',
          { className: 'ma-form', onSubmit: submit },
          h(
            'label',
            { className: 'ma-field' },
            h('span', { className: 'ma-field-label' }, '任务标题', h('em', null, '必填')),
            h('input', {
              ref: titleRef,
              className: 'ma-input',
              value: title,
              maxLength: 80,
              placeholder: '例如：整理排序算法需求',
              onChange: (event) => setTitle(event.target.value),
            }),
            h('span', { className: 'ma-field-hint' }, `${title.trim().length}/80`),
          ),
          h(
            'label',
            { className: 'ma-field' },
            h('span', { className: 'ma-field-label' }, '任务说明'),
            h('textarea', {
              className: 'ma-textarea',
              value: description,
              maxLength: 600,
              rows: 4,
              placeholder: '写下任务的目标、输入输出或验收标准。',
              onChange: (event) => setDescription(event.target.value),
            }),
            h('span', { className: 'ma-field-hint' }, `${description.trim().length}/600`),
          ),
          h(
            'label',
            { className: 'ma-field' },
            h('span', { className: 'ma-field-label' }, '状态'),
            h(
              'select',
              {
                className: 'ma-select',
                value: status,
                onChange: (event) => setStatus(event.target.value),
              },
              h('option', { value: 'todo' }, '待开始'),
              h('option', { value: 'doing' }, '进行中'),
              h('option', { value: 'done' }, '已完成'),
            ),
          ),
          h(
            'label',
            { className: 'ma-field' },
            h('span', { className: 'ma-field-label' }, '负责人（归属）'),
            h(
              'select',
              {
                className: 'ma-select',
                value: assignee,
                onChange: (event) => setAssignee(event.target.value),
              },
              h('option', { value: '' }, '未分配'),
              members.map((member) =>
                h(
                  'option',
                  { key: member.sessionId, value: member.sessionId, title: member.sessionId },
                  `${shortSessionId(member.sessionId)}${member.role === 'leader' ? '（组长）' : ''}`,
                ),
              ),
            ),
            h('span', { className: 'ma-field-hint' }, '只有负责人或组长可以更改任务状态。'),
          ),
          error
            ? h('div', { className: 'ma-form-error', role: 'alert' }, h(Icon, { name: 'info', size: 15 }), error)
            : null,
        ),
      )
    }

    function orderTasks(tasks, edges) {
      const byId = new Map(tasks.map((task) => [task.id, task]))
      const indegree = new Map(tasks.map((task) => [task.id, 0]))
      const outgoing = new Map(tasks.map((task) => [task.id, []]))
      for (const edge of edges) {
        if (!byId.has(edge.from) || !byId.has(edge.to)) continue
        outgoing.get(edge.from).push(edge.to)
        indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1)
      }
      const compare = (a, b) =>
        (a.y - b.y) || String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id)
      const ready = tasks.filter((task) => (indegree.get(task.id) || 0) === 0).sort(compare)
      const ordered = []
      const seen = new Set()
      while (ready.length > 0) {
        const task = ready.shift()
        if (seen.has(task.id)) continue
        seen.add(task.id)
        ordered.push(task)
        for (const targetId of outgoing.get(task.id) || []) {
          const remaining = (indegree.get(targetId) || 0) - 1
          indegree.set(targetId, remaining)
          if (remaining !== 0) continue
          const target = byId.get(targetId)
          if (target) {
            ready.push(target)
            ready.sort(compare)
          }
        }
      }
      for (const task of tasks) {
        if (!seen.has(task.id)) ordered.push(task)
      }
      return ordered
    }

    function TaskBoard(props) {
      const { store } = props
      const state = usePluginStore(store)
      const [editor, setEditor] = useState(null)
      const [deleteTarget, setDeleteTarget] = useState(null)
      const [linkFrom, setLinkFrom] = useState(null)
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState(false)
      const [geometry, setGeometry] = useState({ width: 0, height: 0, ports: new Map() })
      const flowRef = useRef(null)
      const cardRefs = useRef(new Map())
      const groups = state.groups || []
      const [groupId, setGroupId] = useState('')
      const effectiveGroupId = groups.some((group) => group.id === groupId)
        ? groupId
        : (groups[0]?.id ?? '')
      const tasks = useMemo(
        () => (state.tasks || []).filter((task) => task.groupId === effectiveGroupId),
        [state.tasks, effectiveGroupId],
      )
      const edges = useMemo(
        () => (state.taskEdges || []).filter((edge) => edge.groupId === effectiveGroupId),
        [state.taskEdges, effectiveGroupId],
      )
      const ordered = useMemo(() => orderTasks(tasks, edges), [tasks, edges])
      const members = useMemo(
        () => (state.memberships || []).filter((membership) => membership.groupId === effectiveGroupId),
        [state.memberships, effectiveGroupId],
      )

      useEffect(() => {
        store.load(true).catch(() => {})
      }, [store])

      useEffect(() => {
        if (!notice) return undefined
        const timer = setTimeout(() => setNotice(null), 2800)
        return () => clearTimeout(timer)
      }, [notice])

      useEffect(() => {
        if (!linkFrom) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setLinkFrom(null)
        }
        document.addEventListener('keydown', onKey, true)
        return () => document.removeEventListener('keydown', onKey, true)
      }, [linkFrom])

      useLayoutEffect(() => {
        const flow = flowRef.current
        if (!flow) return undefined
        let frame = 0
        const measure = () => {
          const ports = new Map()
          for (const task of ordered) {
            const element = cardRefs.current.get(task.id)
            if (!element) continue
            ports.set(task.id, {
              x: element.offsetLeft + element.offsetWidth / 2,
              top: element.offsetTop,
              bottom: element.offsetTop + element.offsetHeight,
            })
          }
          setGeometry({ width: flow.clientWidth, height: flow.offsetHeight, ports })
        }
        const schedule = () => {
          cancelAnimationFrame(frame)
          frame = requestAnimationFrame(measure)
        }
        schedule()
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null
        if (observer) observer.observe(flow)
        window.addEventListener('resize', schedule)
        const timer = setTimeout(schedule, 180)
        return () => {
          cancelAnimationFrame(frame)
          if (observer) observer.disconnect()
          window.removeEventListener('resize', schedule)
          clearTimeout(timer)
        }
      }, [ordered])

      function showNotice(message, tone = 'ok') {
        setNotice({ message, tone })
      }

      async function removeEdge(edge) {
        if (busy) return
        setBusy(true)
        try {
          await store.mutate({ action: 'deleteTaskEdge', edgeId: edge.id })
          showNotice('连线已删除')
        } catch (caught) {
          showNotice(caught.message || '删除连线失败', 'error')
        } finally {
          setBusy(false)
        }
      }

      async function saveTask(values) {
        if (busy) return
        if (editor && editor.task) {
          setBusy(true)
          try {
            await store.mutate({ action: 'updateTask', taskId: editor.task.id, ...values })
            setEditor(null)
            showNotice('任务已保存')
          } finally {
            setBusy(false)
          }
          return
        }
        if (!effectiveGroupId) {
          showNotice('任务归属于分组，请先在「Agent 分组」中创建分组', 'error')
          return
        }
        setBusy(true)
        try {
          const position = tasks.reduce((max, task) => Math.max(max, task.y), 0)
          await store.mutate({
            action: 'createTask',
            groupId: effectiveGroupId,
            x: 0,
            y: position + 120,
            ...values,
          })
          setEditor(null)
          showNotice('任务已创建')
        } finally {
          setBusy(false)
        }
      }

      async function deleteTask(task) {
        await store.mutate({ action: 'deleteTask', taskId: task.id })
        setDeleteTarget(null)
        showNotice('任务已删除')
      }

      async function handleCardClick(task) {
        if (busy) return
        if (!linkFrom) {
          setLinkFrom(task.id)
          return
        }
        if (linkFrom === task.id) {
          setLinkFrom(null)
          return
        }
        setBusy(true)
        try {
          await store.mutate({ action: 'createTaskEdge', from: linkFrom, to: task.id })
          setLinkFrom(null)
          showNotice('已创建连线')
        } catch (caught) {
          showNotice(caught.message || '创建连线失败', 'error')
        } finally {
          setBusy(false)
        }
      }

      const linkedTask = linkFrom ? tasks.find((task) => task.id === linkFrom) : null
      const edgePaths = []
      if (geometry.width > 0) {
        const indexOf = new Map(ordered.map((task, index) => [task.id, index]))
        for (const [index, edge] of edges.entries()) {
          const from = geometry.ports.get(edge.from)
          const to = geometry.ports.get(edge.to)
          if (!from || !to) continue
          const fromIndex = indexOf.get(edge.from)
          const toIndex = indexOf.get(edge.to)
          const x1 = from.x
          const y1 = from.bottom + 6
          const x2 = to.x
          const y2 = to.top - 6
          let path
          if (toIndex === fromIndex + 1) {
            const bend = Math.max(16, Math.min(48, Math.abs(y2 - y1) / 2))
            path = `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`
          } else {
            const lane = Math.max(x1, geometry.width - 14 - (index % 4) * 4)
            path = `M ${x1} ${y1} C ${x1} ${y1 + 16}, ${lane} ${y1 + 18}, ${lane} ${y1 + 34} L ${lane} ${y2 - 30} C ${lane} ${y2 - 14}, ${x2} ${y2 - 12}, ${x2} ${y2}`
          }
          edgePaths.push(
            h(
              'g',
              { key: edge.id, className: 'ma-task-edge' },
              h('path', {
                className: 'ma-task-edge-hit',
                d: path,
                onClick: () => removeEdge(edge),
                'aria-label': '删除这条连线',
              }),
              h('path', { className: 'ma-task-edge-line', d: path, markerEnd: 'url(#ma-task-arrow)' }),
            ),
          )
        }
      }

      return h(
        'section',
        { className: 'ma-page ma-task-page' },
        h(
          'header',
          { className: 'ma-page-head' },
          h(
            'div',
            { className: 'ma-page-copy' },
            h('div', { className: 'ma-kicker' }, h('i', null), 'MULTI-AGENT'),
            h('h1', null, '任务'),
            h(
              'p',
              null,
              '任务从上往下排列：点击一张卡片，再点另一张即可连成 a → b → c。同一层的任务可以并行推进。',
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'ma-btn ma-btn-primary',
              disabled: groups.length === 0,
              onClick: () => {
                if (groups.length === 0) {
                  showNotice('任务归属于分组，请先在「Agent 分组」中创建分组', 'error')
                  return
                }
                setEditor({ task: null })
              },
            },
            h(Icon, { name: 'plus', size: 16 }),
            '新建任务',
          ),
        ),
        h(
          'div',
          { className: 'ma-task-toolbar' },
          h(
            'label',
            { className: 'ma-task-group' },
            h('span', null, '分组'),
            h(
              'select',
              {
                className: 'ma-select',
                value: effectiveGroupId,
                disabled: groups.length === 0,
                onChange: (event) => {
                  setGroupId(event.target.value)
                  setLinkFrom(null)
                },
              },
              groups.length === 0
                ? h('option', { value: '' }, '暂无分组')
                : groups.map((group) => h('option', { key: group.id, value: group.id }, group.name)),
            ),
          ),
          h(
            'span',
            { className: 'ma-task-counts' },
            h('span', { className: 'ma-count-pill' }, `${tasks.length} 个任务`),
            h('span', { className: 'ma-count-pill' }, `${edges.length} 条连线`),
          ),
          h(
            'span',
            { className: 'ma-task-hint' },
            linkedTask
              ? `已选中「${linkedTask.title}」，再点击另一张卡片完成连线（Esc 取消）`
              : '单击卡片选中后连线 · 双击编辑 · 点击连线删除',
          ),
          linkedTask
            ? h(
                'button',
                { type: 'button', className: 'ma-btn ma-btn-outline ma-btn-sm', onClick: () => setLinkFrom(null) },
                '取消连线',
              )
            : null,
        ),
        state.error
          ? h(
              'div',
              { className: 'ma-alert', role: 'alert' },
              h(Icon, { name: 'info', size: 16 }),
              h('span', null, state.error),
              h(
                'button',
                { type: 'button', className: 'ma-alert-action', onClick: () => store.load(true).catch(() => {}) },
                '重试',
              ),
            )
          : null,
        h(
          'div',
          { className: 'ma-task-canvas-scroll' },
          tasks.length === 0
            ? h(
                'div',
                { className: 'ma-task-empty' },
                h(TaskGlyph),
                h('strong', null, groups.length === 0 ? '还没有可用的分组' : '还没有任务卡片'),
                h(
                  'p',
                  null,
                  groups.length === 0
                    ? '任务归属于分组，请先在「Agent 分组」中创建一个分组，再回到这里添加任务。'
                    : '新建第一张卡片，再依次点击两张卡片创建连线，任务会从上往下自动排列。',
                ),
              )
            : h(
                'div',
                { className: 'ma-task-flow', ref: flowRef },
                h(
                  'svg',
                  {
                    className: 'ma-task-edges',
                    width: geometry.width || 1,
                    height: geometry.height || 1,
                    viewBox: `0 0 ${geometry.width || 1} ${geometry.height || 1}`,
                  },
                  h(
                    'defs',
                    null,
                    h(
                      'marker',
                      {
                        id: 'ma-task-arrow',
                        viewBox: '0 0 8 8',
                        refX: 6.4,
                        refY: 4,
                        markerWidth: 7,
                        markerHeight: 7,
                        orient: 'auto-start-reverse',
                      },
                      h('path', { d: 'M 0 0 L 8 4 L 0 8 z' }),
                    ),
                  ),
                  edgePaths,
                ),
                ordered.map((task) => {
                  const meta = taskStatusMeta(task.status)
                  return h(
                    'div',
                    {
                      key: task.id,
                      ref: (element) => {
                        if (element) cardRefs.current.set(task.id, element)
                        else cardRefs.current.delete(task.id)
                      },
                      className: cx('ma-task-card', linkFrom === task.id && 'is-linking'),
                      title: '单击选中后连线 · 双击编辑',
                      onClick: (event) => {
                        if (event.target instanceof Element && event.target.closest('button')) return
                        handleCardClick(task)
                      },
                      onDoubleClick: () => {
                        setLinkFrom(null)
                        setEditor({ task })
                      },
                    },
                    h(
                      'div',
                      { className: 'ma-task-card-head' },
                      h('span', { className: cx('ma-task-status', `is-${meta.tone}`) }, meta.label),
                      h(
                        'span',
                        { className: 'ma-task-card-actions' },
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'ma-task-mini',
                            title: '编辑任务',
                            'aria-label': '编辑任务',
                            onClick: () => setEditor({ task }),
                          },
                          h(Icon, { name: 'pencil', size: 12 }),
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'ma-task-mini is-danger',
                            title: '删除任务',
                            'aria-label': '删除任务',
                            onClick: () => setDeleteTarget(task),
                          },
                          h(Icon, { name: 'trash', size: 12 }),
                        ),
                      ),
                    ),
                    h('strong', { className: 'ma-task-title' }, task.title),
                    h('code', { className: 'ma-task-id' }, task.id),
                    h(
                      'span',
                      { className: cx('ma-task-assignee', task.assigneeSessionId && 'is-assigned') },
                      task.assigneeSessionId
                        ? `负责人 ${shortSessionId(task.assigneeSessionId)}`
                        : '未分配',
                    ),
                    task.description ? h('p', { className: 'ma-task-desc' }, task.description) : null,
                  )
                }),
              ),
        ),
        editor
          ? h(TaskEditor, {
              task: editor.task,
              members,
              onClose: () => setEditor(null),
              onSave: saveTask,
            })
          : null,
        deleteTarget
          ? h(ConfirmDialog, {
              title: '删除任务',
              description: `确定要删除「${deleteTarget.title}」吗？与它相连的连线也会一并删除。`,
              confirmLabel: '删除任务',
              tone: 'danger',
              onClose: () => setDeleteTarget(null),
              onConfirm: () => deleteTask(deleteTarget),
            })
          : null,
        notice
          ? h(
              'div',
              { className: cx('ma-toast', notice.tone === 'error' && 'is-error'), role: 'status' },
              h(Icon, { name: notice.tone === 'error' ? 'info' : 'check', size: 15 }),
              notice.message,
            )
          : null,
      )
    }

    const CSS = `
.ma-overlay, .ma-trigger {
  --ma-text: var(--dsw-alias-label-primary, #1d2129);
  --ma-text-2: var(--dsw-alias-label-secondary, #5c6470);
  --ma-text-3: var(--dsw-alias-label-tertiary, #8a929e);
  --ma-border: color-mix(in srgb, var(--ma-text) 12%, transparent);
  --ma-border-strong: color-mix(in srgb, var(--ma-text) 20%, transparent);
  --ma-surface: var(--dsw-alias-bg-base, #ffffff);
  --ma-soft: color-mix(in srgb, var(--ma-text) 4.5%, transparent);
  --ma-soft-strong: color-mix(in srgb, var(--ma-text) 8%, transparent);
  --ma-accent: #5b6cf9;
  --ma-leader: #b7791f;
  --ma-danger: var(--dsw-alias-state-error-primary, #d14343);
  color: var(--ma-text);
  font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif);
}
.ma-page {
  height: 100%;
  max-height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  --ma-text: var(--dsw-alias-label-primary, #1d2129);
  --ma-text-2: var(--dsw-alias-label-secondary, #5c6470);
  --ma-text-3: var(--dsw-alias-label-tertiary, #8a929e);
  --ma-border: color-mix(in srgb, var(--ma-text) 12%, transparent);
  --ma-border-strong: color-mix(in srgb, var(--ma-text) 20%, transparent);
  --ma-surface: var(--dsw-alias-bg-base, #ffffff);
  --ma-soft: color-mix(in srgb, var(--ma-text) 4.5%, transparent);
  --ma-soft-strong: color-mix(in srgb, var(--ma-text) 8%, transparent);
  --ma-accent: #5b6cf9;
  --ma-leader: #b7791f;
  --ma-danger: var(--dsw-alias-state-error-primary, #d14343);
  color: var(--ma-text);
  font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif);
  font-size: 14px;
  line-height: 1.5;
  max-width: 1180px;
  margin: 0 auto;
  padding: 28px 32px 48px;
  box-sizing: border-box;
}
.ma-page *, .ma-panel *, .ma-overlay *, .ma-trigger * { box-sizing: border-box; }
.ma-page-head { display: flex; align-items: flex-start; gap: 24px; }
.ma-page-copy { flex: 1; min-width: 0; }
.ma-kicker {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--ma-accent);
  font-size: 10px;
  font-weight: 750;
  letter-spacing: 0.13em;
}
.ma-kicker i { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.ma-page h1 {
  margin: 7px 0 6px;
  font-size: 24px;
  line-height: 1.2;
  letter-spacing: -0.025em;
  font-weight: 700;
}
.ma-page-head p { margin: 0; color: var(--ma-text-2); font-size: 13px; max-width: 680px; }
.ma-page-head > .ma-btn { margin-top: 20px; flex: 0 0 auto; }
.ma-overview {
  display: flex;
  align-items: stretch;
  margin: 22px 0 18px;
  border: 1px solid var(--ma-border);
  border-radius: 13px;
  background: var(--ma-surface);
  overflow: hidden;
}
.ma-overview-stat {
  display: flex;
  align-items: baseline;
  gap: 7px;
  padding: 13px 18px;
  min-width: 0;
  border-right: 1px solid var(--ma-border);
}
.ma-overview-stat strong { font-size: 20px; line-height: 1.1; letter-spacing: -0.02em; }
.ma-overview-stat > span:last-child { color: var(--ma-text-2); font-size: 12px; white-space: nowrap; }
.ma-overview-icon { color: var(--ma-text-3); display: inline-flex; align-self: center; margin-right: 2px; }
.ma-tone-sky .ma-overview-icon { color: #0284c7; }
.ma-tone-amber .ma-overview-icon { color: var(--ma-leader); }
.ma-overview-note {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 18px;
  color: var(--ma-text-3);
  font-size: 12px;
  white-space: nowrap;
}
.ma-workspace {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  min-height: 500px;
  border: 1px solid var(--ma-border);
  border-radius: 15px;
  overflow: hidden;
  background: var(--ma-surface);
}
.ma-list-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-right: 1px solid var(--ma-border);
  background: color-mix(in srgb, var(--ma-surface) 94%, var(--ma-text));
}
.ma-list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 15px 15px 10px;
  color: var(--ma-text-2);
  font-size: 12px;
}
.ma-list-head strong { color: var(--ma-text); font-size: 13px; }
.ma-count-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--ma-soft-strong);
  color: var(--ma-text-2);
  font-size: 11px;
  font-weight: 650;
}
.ma-search {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 34px;
  margin: 0 12px 10px;
  padding: 0 10px;
  border: 1px solid var(--ma-border);
  border-radius: 9px;
  color: var(--ma-text-3);
  background: var(--ma-surface);
}
.ma-search:focus-within { border-color: color-mix(in srgb, var(--ma-accent) 55%, transparent); }
.ma-search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--ma-text);
  font: inherit;
  font-size: 12.5px;
}
.ma-search input::placeholder { color: var(--ma-text-3); }
.ma-search-clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  color: var(--ma-text-3);
  background: var(--ma-soft-strong);
  cursor: pointer;
}
.ma-group-list { flex: 1; overflow-y: auto; padding: 0 8px 8px; min-height: 0; }
.ma-group-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 10px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: var(--ma-text);
  text-align: left;
  font: inherit;
  cursor: pointer;
  transition: background .15s ease, border-color .15s ease;
}
.ma-group-row:hover { background: var(--ma-soft); }
.ma-group-row.is-selected {
  background: color-mix(in srgb, var(--ma-c) 10%, transparent);
  border-color: color-mix(in srgb, var(--ma-c) 24%, transparent);
}
.ma-group-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 auto;
  background: var(--ma-c, var(--ma-accent));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ma-c, var(--ma-accent)) 13%, transparent);
}
.ma-group-row-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.ma-group-row-copy strong { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ma-group-row-copy span { color: var(--ma-text-3); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ma-group-row-arrow { color: var(--ma-text-3); flex: 0 0 auto; opacity: .65; }
.ma-list-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 14px;
  border-top: 1px solid var(--ma-border);
  color: var(--ma-text-3);
  font-size: 10.5px;
}
.ma-list-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 5px;
  padding: 26px 20px;
  color: var(--ma-text-2);
}
.ma-list-empty > svg { color: var(--ma-text-3); margin-bottom: 2px; }
.ma-list-empty strong { color: var(--ma-text); font-size: 13px; }
.ma-list-empty p { margin: 0 0 6px; font-size: 11.5px; color: var(--ma-text-3); }
.ma-detail-pane { min-width: 0; padding: 22px 24px; }
.ma-detail { min-height: 100%; display: flex; flex-direction: column; }
.ma-detail-head { display: flex; align-items: flex-start; gap: 12px; }
.ma-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  border: 1px solid;
  border-radius: 11px;
  font-weight: 700;
  letter-spacing: -0.03em;
}
.ma-detail-copy { flex: 1; min-width: 0; }
.ma-detail-copy h2 { margin: 0 0 3px; font-size: 18px; line-height: 1.25; letter-spacing: -0.015em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ma-detail-desc { margin: 0; color: var(--ma-text-2); font-size: 12.5px; }
.ma-detail-desc.is-empty { color: var(--ma-text-3); font-style: italic; }
.ma-detail-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 8px; color: var(--ma-text-3); font-size: 11px; }
.ma-detail-meta span { display: inline-flex; align-items: center; gap: 4px; }
.ma-detail-tools { display: flex; gap: 2px; flex: 0 0 auto; }
.ma-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--ma-text-2);
  cursor: pointer;
}
.ma-icon-btn:hover { background: var(--ma-soft-strong); color: var(--ma-text); }
.ma-icon-danger:hover { color: var(--ma-danger); background: color-mix(in srgb, var(--ma-danger) 10%, transparent); }
.ma-callout {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  margin: 18px 0 2px;
  padding: 10px 12px;
  border: 1px solid var(--ma-border);
  border-radius: 10px;
  background: var(--ma-soft);
  color: var(--ma-text-2);
  font-size: 12px;
}
.ma-callout > svg { flex: 0 0 auto; margin-top: 1px; color: var(--ma-leader); }
.ma-callout strong { color: var(--ma-text); font-size: 12px; display: block; }
.ma-callout p { margin: 2px 0 0; color: var(--ma-text-3); font-size: 11.5px; }
.ma-members-head { display: flex; align-items: center; justify-content: flex-end; gap: 12px; margin: 22px 0 10px; }
.ma-member-table { border: 1px solid var(--ma-border); border-radius: 11px; overflow: hidden; }
.ma-member-table-head, .ma-member-row {
  display: grid;
  grid-template-columns: minmax(0, 1.8fr) 100px 90px 150px;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
}
.ma-member-table-head {
  height: 32px;
  background: var(--ma-soft);
  color: var(--ma-text-3);
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.03em;
}
.ma-member-row { min-height: 54px; border-top: 1px solid var(--ma-border); }
.ma-member-person { display: flex; align-items: center; gap: 9px; min-width: 0; }
.ma-member-avatar {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  background: color-mix(in srgb, var(--ma-c) 11%, transparent);
}
.ma-member-name { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
.ma-member-name strong { font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ma-member-name small { color: var(--ma-text-3); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ma-member-date { color: var(--ma-text-3); font-size: 11px; }
.ma-member-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
.ma-leader-mark { display: inline-flex; align-items: center; gap: 3px; color: var(--ma-leader); font-size: 9.5px; font-weight: 600; white-space: nowrap; }
.ma-text-btn {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ma-text-3);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.ma-text-btn:hover { color: var(--ma-text); }
.ma-text-btn-accent { color: var(--ma-accent); }
.ma-text-btn-danger:hover { color: var(--ma-danger); }
.ma-text-btn:disabled { opacity: .45; cursor: default; }
.ma-detail-foot { display: flex; align-items: flex-start; gap: 6px; margin-top: auto; padding-top: 18px; color: var(--ma-text-3); font-size: 10.5px; }
.ma-detail-empty {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 34px 24px;
}
.ma-detail-empty-art {
  width: 66px;
  height: 66px;
  border-radius: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ma-accent);
  background: color-mix(in srgb, var(--ma-accent) 9%, transparent);
  border: 1px solid color-mix(in srgb, var(--ma-accent) 14%, transparent);
  margin-bottom: 14px;
}
.ma-detail-empty h2 { margin: 0 0 5px; font-size: 16px; }
.ma-detail-empty p { margin: 0 0 16px; max-width: 360px; color: var(--ma-text-3); font-size: 12px; }
.ma-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 30px 20px;
  border: 1px dashed var(--ma-border-strong);
  border-radius: 11px;
  text-align: center;
  color: var(--ma-text-2);
}
.ma-empty-icon { color: var(--ma-text-3); margin-bottom: 2px; }
.ma-empty strong { font-size: 12.5px; color: var(--ma-text); }
.ma-empty p { margin: 0; max-width: 380px; font-size: 11.5px; color: var(--ma-text-3); }
.ma-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 34px;
  padding: 0 13px;
  border: 1px solid transparent;
  border-radius: 9px;
  font: inherit;
  font-size: 12.5px;
  font-weight: 550;
  cursor: pointer;
  white-space: nowrap;
  transition: background .15s ease, border-color .15s ease, opacity .15s ease;
}
.ma-btn:disabled { opacity: .5; cursor: default; }
.ma-btn-primary { color: #fff; background: var(--ma-accent); box-shadow: 0 1px 2px color-mix(in srgb, var(--ma-accent) 25%, transparent); }
.ma-btn-primary:hover { background: color-mix(in srgb, var(--ma-accent) 88%, #000); }
.ma-btn-ghost { color: var(--ma-text-2); background: transparent; border-color: var(--ma-border); }
.ma-btn-ghost:hover { background: var(--ma-soft); color: var(--ma-text); }
.ma-btn-outline { color: var(--ma-text-2); background: transparent; border-color: var(--ma-border-strong); }
.ma-btn-outline:hover { background: var(--ma-soft); color: var(--ma-text); }
.ma-btn-danger { color: #fff; background: var(--ma-danger); }
.ma-btn-danger:hover { background: color-mix(in srgb, var(--ma-danger) 88%, #000); }
.ma-btn-sm { height: 29px; padding: 0 10px; font-size: 11.5px; }
.ma-alert {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  margin-bottom: 14px;
  border: 1px solid color-mix(in srgb, var(--ma-danger) 28%, transparent);
  border-radius: 9px;
  background: color-mix(in srgb, var(--ma-danger) 7%, transparent);
  color: var(--ma-danger);
  font-size: 12px;
}
.ma-alert span { flex: 1; min-width: 0; }
.ma-alert-action { border: 0; background: transparent; color: inherit; font: inherit; font-weight: 600; cursor: pointer; }
.ma-role {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 20px;
  padding: 0 6px;
  border-radius: 5px;
  font-size: 10.5px;
  font-weight: 600;
  white-space: nowrap;
}
.ma-role-leader { color: var(--ma-leader); background: color-mix(in srgb, var(--ma-leader) 11%, transparent); }
.ma-role-member { color: var(--ma-text-2); background: var(--ma-soft-strong); }
.ma-role-compact { height: 18px; padding: 0 5px; font-size: 10px; gap: 2px; }
.ma-muted { color: var(--ma-text-3); }
.ma-toast {
  position: fixed;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%);
  z-index: 1000;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: min(420px, calc(100vw - 32px));
  padding: 9px 13px;
  border: 1px solid var(--ma-border);
  border-radius: 9px;
  background: var(--dsw-alias-bg-elevated, var(--ma-surface));
  color: var(--ma-text);
  box-shadow: 0 8px 26px rgba(0, 0, 0, .18);
  font-size: 12px;
  animation: ma-rise .18s ease-out;
}
.ma-toast > svg { color: #10b981; }
.ma-toast.is-error > svg { color: var(--ma-danger); }
@keyframes ma-rise { from { opacity: 0; transform: translate(-50%, 5px); } to { opacity: 1; transform: translate(-50%, 0); } }
.ma-overlay {
  position: fixed;
  inset: 0;
  z-index: 1100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(8, 10, 16, .48);
  backdrop-filter: blur(2px);
}
.ma-modal {
  width: min(440px, 100%);
  max-height: min(720px, calc(100vh - 40px));
  display: flex;
  flex-direction: column;
  border: 1px solid var(--ma-border);
  border-radius: 14px;
  background: var(--ma-surface);
  box-shadow: 0 20px 60px rgba(0, 0, 0, .28);
  overflow: hidden;
  animation: ma-modal-in .16s ease-out;
}
.ma-modal-wide { width: min(560px, 100%); }
@keyframes ma-modal-in { from { opacity: 0; transform: scale(.985); } to { opacity: 1; transform: scale(1); } }
.ma-modal-head { display: flex; align-items: flex-start; gap: 12px; padding: 18px 18px 0; }
.ma-modal-head > div { flex: 1; min-width: 0; }
.ma-modal-head h2 { margin: 0; font-size: 16px; letter-spacing: -0.01em; }
.ma-modal-head p { margin: 4px 0 0; color: var(--ma-text-3); font-size: 11.5px; }
.ma-modal-body { padding: 14px 18px 18px; overflow-y: auto; }
.ma-modal-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--ma-border); background: var(--ma-soft); }
.ma-form { display: flex; flex-direction: column; gap: 15px; }
.ma-field { display: flex; flex-direction: column; gap: 6px; }
.ma-field-label { display: flex; align-items: center; justify-content: space-between; color: var(--ma-text-2); font-size: 11.5px; font-weight: 550; }
.ma-field-label em { font-style: normal; color: var(--ma-text-3); font-size: 10.5px; font-weight: 400; }
.ma-field-hint { align-self: flex-end; color: var(--ma-text-3); font-size: 10px; margin-top: -2px; }
.ma-leader-fixed { display: flex; align-items: center; gap: 7px; min-height: 34px; padding: 0 10px; border: 1px solid color-mix(in srgb, var(--ma-accent) 25%, transparent); border-radius: 8px; background: color-mix(in srgb, var(--ma-accent) 7%, transparent); color: var(--ma-accent); font-size: 11px; }
.ma-input, .ma-textarea {
  width: 100%;
  border: 1px solid var(--ma-border-strong);
  border-radius: 8px;
  background: var(--ma-surface);
  color: var(--ma-text);
  font: inherit;
  font-size: 12.5px;
  outline: 0;
}
.ma-input { height: 35px; padding: 0 10px; }
.ma-textarea { padding: 8px 10px; resize: vertical; min-height: 70px; }
.ma-input:focus, .ma-textarea:focus { border-color: color-mix(in srgb, var(--ma-accent) 55%, transparent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ma-accent) 10%, transparent); }
.ma-swatches { display: flex; flex-wrap: wrap; gap: 7px; }
.ma-swatch {
  width: 26px;
  height: 26px;
  border: 2px solid transparent;
  border-radius: 8px;
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .22);
}
.ma-swatch.is-selected { box-shadow: 0 0 0 2px var(--ma-surface), 0 0 0 4px var(--ma-text); }
.ma-form-error, .ma-inline-error {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--ma-danger);
  font-size: 11.5px;
}
.ma-confirm { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 9px; padding: 4px 0; }
.ma-confirm-icon {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ma-leader);
  background: color-mix(in srgb, var(--ma-leader) 11%, transparent);
}
.ma-confirm-icon.is-danger { color: var(--ma-danger); background: color-mix(in srgb, var(--ma-danger) 10%, transparent); }
.ma-confirm p { margin: 0; font-size: 12px; color: var(--ma-text-2); }
.ma-confirm strong { color: var(--ma-text); }
.ma-confirm .ma-form-error { justify-content: center; }
.ma-confirm .ma-muted { color: var(--ma-text-3); }
.ma-skeleton { border-radius: 7px; background: var(--ma-soft-strong); animation: ma-pulse 1.4s ease-in-out infinite; }
.ma-skeleton-title { width: 45%; height: 12px; margin: 8px 14px 16px; }
.ma-skeleton-row { height: 44px; margin: 0 12px 8px; }
.ma-skeleton-detail { height: 70%; margin: 26px 20px; }
@keyframes ma-pulse { 0%, 100% { opacity: .55; } 50% { opacity: .95; } }
.ma-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 230px;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--ma-border);
  border-radius: 7px;
  background: var(--ma-soft);
  color: var(--ma-text-2);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
  white-space: nowrap;
}
.ma-trigger:hover { background: var(--ma-soft-strong); color: var(--ma-text); }
.ma-trigger.is-open { border-color: color-mix(in srgb, var(--ma-accent) 40%, transparent); }
.ma-trigger-icon { display: inline-flex; color: var(--ma-accent); flex: 0 0 auto; }
.ma-trigger-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--ma-text); font-weight: 550; }
.ma-trigger-role { color: var(--ma-text-3); font-size: 10px; flex: 0 0 auto; }
.ma-trigger-role.is-leader { color: var(--ma-leader); }
.ma-trigger-chevron { color: var(--ma-text-3); flex: 0 0 auto; transition: transform .15s ease; }
.ma-trigger.is-open .ma-trigger-chevron { transform: rotate(180deg); }
.ma-panel {
  position: fixed;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--ma-border-strong, rgba(127, 127, 127, .28));
  border-radius: 13px;
  background: var(--dsw-alias-bg-elevated, var(--ma-surface, #1c1f26));
  color: var(--ma-text);
  box-shadow: 0 16px 48px rgba(0, 0, 0, .3);
  overflow: hidden;
  font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif);
  font-size: 13px;
  line-height: 1.5;
  --ma-text: var(--dsw-alias-label-primary, #e7e9ee);
  --ma-text-2: var(--dsw-alias-label-secondary, #aeb4c0);
  --ma-text-3: var(--dsw-alias-label-tertiary, #7f8795);
  --ma-border: color-mix(in srgb, var(--ma-text) 12%, transparent);
  --ma-border-strong: color-mix(in srgb, var(--ma-text) 20%, transparent);
  --ma-surface: var(--dsw-alias-bg-base, #16181e);
  --ma-soft: color-mix(in srgb, var(--ma-text) 5%, transparent);
  --ma-soft-strong: color-mix(in srgb, var(--ma-text) 9%, transparent);
  --ma-accent: var(--dsw-alias-brand-primary, #7c8cff);
  --ma-leader: #d6a04a;
  --ma-danger: var(--dsw-alias-state-error-primary, #e05d5d);
  animation: ma-panel-in .15s ease-out;
}
@keyframes ma-panel-in { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: translateY(0); } }
.ma-panel-head { display: flex; align-items: flex-start; gap: 10px; padding: 14px 14px 11px; border-bottom: 1px solid var(--ma-border); }
.ma-panel-head-copy { flex: 1; min-width: 0; }
.ma-panel-eyebrow { display: flex; align-items: center; gap: 6px; color: var(--ma-accent); font-size: 9px; font-weight: 750; letter-spacing: .13em; }
.ma-panel-eyebrow i { width: 4px; height: 4px; border-radius: 50%; background: currentColor; }
.ma-panel h3 { margin: 3px 0 5px; font-size: 16px; letter-spacing: -0.015em; }
.ma-session-line { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 11px; }
.ma-session-label { color: var(--ma-text-3); flex: 0 0 auto; }
.ma-session-name {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  max-width: 270px;
  padding: 1px 4px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--ma-text-2);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.ma-session-name span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ma-session-name:hover { color: var(--ma-text); background: var(--ma-soft); }
.ma-rename-row { display: flex; align-items: center; gap: 4px; flex: 1; min-width: 0; }
.ma-rename-input {
  flex: 1;
  min-width: 0;
  height: 25px;
  padding: 0 6px;
  border: 1px solid color-mix(in srgb, var(--ma-accent) 50%, transparent);
  border-radius: 5px;
  background: var(--ma-surface);
  color: var(--ma-text);
  font: inherit;
  font-size: 11px;
  outline: 0;
}
.ma-rename-save, .ma-rename-cancel {
  border: 0;
  padding: 1px 3px;
  background: transparent;
  color: var(--ma-accent);
  font: inherit;
  font-size: 10.5px;
  cursor: pointer;
}
.ma-rename-cancel { color: var(--ma-text-3); }
.ma-rename-save:disabled, .ma-rename-cancel:disabled { opacity: .5; cursor: default; }
.ma-inline-error { margin-top: 4px; color: var(--ma-danger); font-size: 10.5px; }
.ma-panel-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 13px 14px; }
.ma-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--ma-text-3); font-size: 10.5px; font-weight: 650; letter-spacing: .02em; }
.ma-section-head-spaced { margin-top: 18px; }
.ma-session-line + .ma-section-head { margin-top: 2px; }
.ma-current { border: 1px solid var(--ma-border); border-radius: 9px; padding: 10px 11px; margin-top: 8px; background: var(--ma-soft); }
.ma-current-empty { color: var(--ma-text-3); }
.ma-current-top { display: flex; align-items: center; gap: 6px; color: var(--ma-text-2); font-size: 12px; }
.ma-current-top strong { color: var(--ma-text); }
.ma-current p { margin: 4px 0 0; color: var(--ma-text-3); font-size: 11px; }
.ma-memberships { display: flex; flex-direction: column; gap: 7px; margin-top: 8px; }
.ma-membership {
  border: 1px solid color-mix(in srgb, var(--ma-c) 24%, var(--ma-border));
  border-radius: 9px;
  padding: 9px 10px;
  background: color-mix(in srgb, var(--ma-c) 6%, transparent);
}
.ma-membership-top { display: flex; align-items: center; gap: 7px; min-width: 0; }
.ma-membership-top strong { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.ma-link-danger { border: 0; padding: 0; background: transparent; color: var(--ma-text-3); font: inherit; font-size: 10px; cursor: pointer; }
.ma-link-danger:hover { color: var(--ma-danger); }
.ma-link-danger:disabled { opacity: .5; cursor: default; }
.ma-membership-desc { margin: 4px 0 6px; color: var(--ma-text-3); font-size: 10.5px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.ma-membership-members { display: flex; align-items: flex-start; gap: 6px; margin-top: 6px; }
.ma-membership-label { flex: 0 0 auto; color: var(--ma-text-3); font-size: 9.5px; padding-top: 2px; }
.ma-chips { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
.ma-chips.is-compact { gap: 3px; }
.ma-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
  max-width: 150px;
  padding: 1px 5px;
  border-radius: 4px;
  color: var(--ma-text-2);
  background: var(--ma-soft-strong);
  font-size: 9.5px;
}
.ma-chip.is-leader { color: var(--ma-leader); background: color-mix(in srgb, var(--ma-leader) 10%, transparent); }
.ma-chip.is-current { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ma-accent) 35%, transparent); }
.ma-chip i { width: 4px; height: 4px; border-radius: 50%; background: currentColor; flex: 0 0 auto; }
.ma-chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ma-chip em { font-style: normal; color: var(--ma-accent); font-size: 8px; flex: 0 0 auto; }
.ma-chip-more { color: var(--ma-text-3); }
.ma-inline-notice {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  color: #10b981;
  background: color-mix(in srgb, #10b981 9%, transparent);
  font-size: 10.5px;
}
.ma-panel-empty { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 4px; padding: 16px 12px; color: var(--ma-text-3); }
.ma-panel-empty-small { padding: 10px; }
.ma-panel-empty > svg { color: var(--ma-text-3); opacity: .8; }
.ma-panel-empty p { margin: 0; max-width: 300px; font-size: 10.5px; line-height: 1.45; }
.ma-choice-list { display: flex; flex-direction: column; gap: 6px; margin-top: 7px; }
.ma-choice { border: 1px solid var(--ma-border); border-radius: 8px; padding: 8px 9px; background: var(--ma-soft); }
.ma-choice-main { min-width: 0; }
.ma-choice-title { display: flex; align-items: center; gap: 6px; min-width: 0; }
.ma-choice-title strong { font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ma-choice-meta { display: flex; align-items: center; gap: 4px; margin-top: 2px; color: var(--ma-text-3); font-size: 9.5px; min-width: 0; }
.ma-choice-meta span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ma-choice-meta i { width: 3px; height: 3px; border-radius: 50%; background: currentColor; flex: 0 0 auto; }
.ma-choice-actions { display: flex; gap: 4px; margin-top: 7px; }
.ma-role-btn {
  flex: 1;
  height: 25px;
  border: 1px solid var(--ma-border);
  border-radius: 6px;
  background: var(--ma-surface);
  color: var(--ma-text-2);
  font: inherit;
  font-size: 10.5px;
  cursor: pointer;
}
.ma-role-btn:hover { border-color: var(--ma-border-strong); color: var(--ma-text); }
.ma-role-btn-leader { color: var(--ma-leader); border-color: color-mix(in srgb, var(--ma-leader) 24%, var(--ma-border)); }
.ma-role-btn:disabled { opacity: .5; cursor: default; }
.ma-takeover {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-top: 6px;
  padding: 6px;
  border: 1px solid color-mix(in srgb, var(--ma-leader) 25%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--ma-leader) 7%, transparent);
  color: var(--ma-leader);
  font-size: 9.5px;
}
.ma-takeover span { min-width: 0; flex: 1; }
.ma-takeover-btn { flex: 0 0 auto; border: 0; border-radius: 4px; padding: 2px 5px; background: var(--ma-leader); color: #fff; font: inherit; font-size: 9.5px; cursor: pointer; }
.ma-panel-error { display: flex; align-items: flex-start; gap: 5px; margin-top: 8px; padding: 6px 8px; border-radius: 6px; color: var(--ma-danger); background: color-mix(in srgb, var(--ma-danger) 8%, transparent); font-size: 10.5px; }
.ma-panel-foot { display: flex; align-items: flex-start; gap: 6px; padding: 9px 14px; border-top: 1px solid var(--ma-border); color: var(--ma-text-3); font-size: 9.5px; flex: 0 0 auto; }
.ma-panel-foot svg { flex: 0 0 auto; margin-top: 1px; }
.ma-overlay.is-stacked { z-index: 1200; }
.ma-members-head-actions { display: flex; align-items: center; gap: 7px; flex: 0 0 auto; }
.ma-section-tools { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.ma-section-action {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 21px;
  padding: 0 6px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--ma-accent);
  font: inherit;
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
}
.ma-section-action:hover { background: color-mix(in srgb, var(--ma-accent) 9%, transparent); }
.ma-membership-tools { display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; }
.ma-link { border: 0; padding: 0; background: transparent; color: var(--ma-accent); font: inherit; font-size: 10px; cursor: pointer; }
.ma-link:hover { text-decoration: underline; }
.ma-add { display: flex; flex-direction: column; gap: 11px; }
.ma-add-scope {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 38px;
  padding: 7px 9px;
  border: 1px solid var(--ma-border);
  border-radius: 9px;
  background: var(--ma-soft);
  color: var(--ma-text-2);
  font-size: 11px;
}
.ma-add-scope > svg { flex: 0 0 auto; color: var(--ma-text-3); }
.ma-add-scope-label { flex: 0 0 auto; color: var(--ma-text-3); }
.ma-add-scope strong { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ma-text); font-weight: 600; font-size: 11.5px; }
.ma-add-scope em { flex: 0 0 auto; font-style: normal; color: var(--ma-text-3); font-size: 10px; }
.ma-select {
  flex: 1;
  min-width: 0;
  height: 27px;
  border: 1px solid var(--ma-border);
  border-radius: 6px;
  background: var(--ma-surface);
  color: var(--ma-text);
  font: inherit;
  font-size: 11px;
  padding: 0 6px;
}
.ma-add-search { margin: 0; }
.ma-add-list {
  max-height: 264px;
  min-height: 64px;
  overflow-y: auto;
  border: 1px solid var(--ma-border);
  border-radius: 10px;
  background: var(--ma-surface);
}
.ma-add-option {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 44px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--ma-border);
  cursor: pointer;
  transition: background .12s ease;
}
.ma-add-option:last-child { border-bottom: 0; }
.ma-add-option:hover { background: var(--ma-soft); }
.ma-add-option.is-selected { background: color-mix(in srgb, var(--ma-accent) 8%, transparent); }
.ma-add-option input { width: 14px; height: 14px; margin: 0; flex: 0 0 auto; accent-color: var(--ma-accent); }
.ma-add-person { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.ma-add-person strong { color: var(--ma-text); font-size: 12px; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ma-add-person small { color: var(--ma-text-3); font-size: 9.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ma-add-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 17px;
  height: 17px;
  flex: 0 0 auto;
  border: 1px solid var(--ma-border-strong);
  border-radius: 5px;
  color: #fff;
  background: var(--ma-surface);
}
.ma-add-option.is-selected .ma-add-check { border-color: var(--ma-accent); background: var(--ma-accent); }
.ma-add-empty { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 5px; padding: 22px 18px; color: var(--ma-text-3); }
.ma-add-empty svg { opacity: .75; }
.ma-add-empty strong { color: var(--ma-text-2); font-size: 12px; font-weight: 600; }
.ma-add-empty p { margin: 0; max-width: 310px; font-size: 10.5px; line-height: 1.5; }
.ma-role-pick { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ma-role-pick-label { color: var(--ma-text-3); font-size: 10.5px; margin-right: 1px; }
.ma-role-choice {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 27px;
  padding: 0 9px;
  border: 1px solid var(--ma-border);
  border-radius: 7px;
  background: var(--ma-surface);
  color: var(--ma-text-2);
  font: inherit;
  font-size: 10.5px;
  cursor: pointer;
}
.ma-role-choice.is-selected { border-color: color-mix(in srgb, var(--ma-accent) 45%, transparent); background: color-mix(in srgb, var(--ma-accent) 9%, transparent); color: var(--ma-accent); }
.ma-role-pick-hint { margin-left: auto; color: var(--ma-text-3); font-size: 9.5px; }
.ma-add-warn { display: flex; align-items: flex-start; gap: 6px; padding: 7px 9px; border-radius: 7px; color: var(--ma-leader); background: color-mix(in srgb, var(--ma-leader) 9%, transparent); font-size: 10.5px; line-height: 1.45; }
.ma-add-warn svg { flex: 0 0 auto; margin-top: 1px; }
.ma-add-count { margin-right: auto; color: var(--ma-text-3); font-size: 10.5px; }
.ma-manage { display: flex; flex-direction: column; gap: 10px; }
.ma-manage-summary {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px;
  border: 1px solid color-mix(in srgb, var(--ma-c, var(--ma-accent)) 24%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--ma-c, var(--ma-accent)) 7%, transparent);
}
.ma-manage-summary-copy { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
.ma-manage-summary-copy strong { font-size: 12px; line-height: 1.45; font-weight: 550; }
.ma-manage-summary-copy span { color: var(--ma-text-3); font-size: 10.5px; }
.ma-capacity { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border: 1px solid var(--ma-border); border-radius: 10px; background: var(--ma-surface); }
.ma-capacity-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ma-capacity-body { display: flex; align-items: flex-end; gap: 8px; }
.ma-capacity-body .ma-field { flex: 1; }
.ma-capacity .ma-field-hint { line-height: 1.5; }
.ma-spawn { display: flex; flex-direction: column; gap: 8px; padding: 10px 11px; border: 1px solid var(--ma-border); border-radius: 12px; background: var(--ma-soft); }
.ma-spawn-head { display: flex; align-items: center; gap: 6px; color: var(--ma-text-2); font-size: 11.5px; }
.ma-spawn-head strong { color: var(--ma-text); font-weight: 600; }
.ma-spawn-badge { margin-left: auto; padding: 1px 7px; border-radius: 999px; background: color-mix(in srgb, var(--ma-accent) 12%, transparent); color: var(--ma-accent); font-size: 10px; }
.ma-spawn-hint { margin: 0; color: var(--ma-text-3); font-size: 10.5px; line-height: 1.5; }
.ma-spawn-tabs { display: inline-flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--ma-soft-strong); width: fit-content; }
.ma-spawn-tabs button { border: 0; border-radius: 6px; padding: 3px 10px; background: transparent; color: var(--ma-text-2); font: inherit; font-size: 10.5px; cursor: pointer; }
.ma-spawn-tabs button.is-active { background: var(--ma-surface); color: var(--ma-text); box-shadow: 0 1px 2px color-mix(in srgb, var(--ma-text) 15%, transparent); }
.ma-spawn-fields { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: 8px; }
.ma-spawn-inline { display: flex; align-items: center; gap: 5px; margin: 0; color: var(--ma-text-3); font-size: 10.5px; }
.ma-spawn-foot { display: flex; justify-content: flex-end; }
@media (max-width: 560px) { .ma-spawn-fields { grid-template-columns: 1fr; } }
.ma-manage-head { display: flex; align-items: center; gap: 7px; margin-top: 2px; color: var(--ma-text-2); font-size: 11px; }
.ma-manage-head strong { font-size: 11.5px; }
.ma-manage-list { display: flex; flex-direction: column; border: 1px solid var(--ma-border); border-radius: 9px; overflow: hidden; }
.ma-manage-row { display: flex; align-items: center; gap: 8px; padding: 8px 9px; border-bottom: 1px solid var(--ma-border); min-width: 0; }
.ma-manage-row:last-child { border-bottom: 0; }
.ma-manage-person { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; }
.ma-manage-person strong { font-size: 11.5px; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ma-manage-person small { color: var(--ma-text-3); font-size: 9px; }
.ma-manage-actions { display: inline-flex; align-items: center; gap: 7px; flex-wrap: wrap; justify-content: flex-end; flex: 0 0 auto; }
.ma-manage-confirm { padding: 9px 10px; border: 1px solid color-mix(in srgb, var(--ma-leader) 25%, transparent); border-radius: 8px; background: color-mix(in srgb, var(--ma-leader) 7%, transparent); }
.ma-manage-confirm.is-danger { border-color: color-mix(in srgb, var(--ma-danger) 25%, transparent); background: color-mix(in srgb, var(--ma-danger) 7%, transparent); }
.ma-manage-confirm p { margin: 0; font-size: 10.5px; line-height: 1.55; }
.ma-manage-confirm-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 8px; }
.ma-panel-empty .ma-btn { margin-top: 4px; }
.ma-modal-wide:has(.ma-msg-shell) { width: min(960px, 100%); max-height: min(820px, calc(100vh - 36px)); }
.ma-msg-shell { display: flex; flex-direction: column; gap: 12px; }
.ma-msg-identity { display: flex; align-items: center; gap: 10px; min-width: 0; }
.ma-msg-identity-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.ma-msg-identity-copy strong { font-size: 14px; font-weight: 600; }
.ma-msg-identity-copy span { color: var(--ma-text-3); font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ma-msg-viewer { display: flex; flex-direction: column; gap: 3px; color: var(--ma-text-3); font-size: 9.5px; flex: 0 0 auto; }
.ma-msg-viewer select {
  height: 27px;
  max-width: 230px;
  padding: 0 7px;
  border: 1px solid var(--ma-border);
  border-radius: 6px;
  background: var(--ma-surface);
  color: var(--ma-text);
  font: inherit;
  font-size: 10.5px;
}
.ma-msg-access {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  height: 22px;
  padding: 0 7px;
  border-radius: 5px;
  color: var(--ma-text-3);
  background: var(--ma-soft-strong);
  font-size: 9.5px;
  font-weight: 600;
  white-space: nowrap;
}
.ma-msg-access.is-leader { color: var(--ma-leader); background: color-mix(in srgb, var(--ma-leader) 10%, transparent); }
.ma-msg-access.is-user { color: var(--ma-accent); background: color-mix(in srgb, var(--ma-accent) 10%, transparent); }
.ma-msg-compose-title { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
.ma-msg-compose-title strong { font-size: 11.5px; font-weight: 600; }
.ma-msg-compose-title span { color: var(--ma-text-3); font-size: 9.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ma-msg-stats { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding-top: 9px; border-top: 1px solid var(--ma-border); color: var(--ma-text-3); font-size: 10px; }
.ma-msg-stats span strong { color: var(--ma-text); font-size: 11px; }
.ma-msg-stats span.is-warn strong { color: var(--ma-leader); }
.ma-msg-stats .ma-text-btn { margin-left: auto; }
.ma-msg-compose {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 11px;
  border: 1px solid var(--ma-border);
  border-radius: 10px;
  background: var(--ma-soft);
}
.ma-msg-compose-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ma-msg-compose-head > strong { font-size: 11.5px; font-weight: 600; }
.ma-msg-mode { display: inline-flex; align-items: center; gap: 2px; padding: 2px; border: 1px solid var(--ma-border); border-radius: 7px; background: var(--ma-surface); }
.ma-msg-mode button {
  height: 22px;
  padding: 0 8px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--ma-text-3);
  font: inherit;
  font-size: 10px;
  font-weight: 550;
  cursor: pointer;
}
.ma-msg-mode button.is-active { color: var(--ma-text); background: var(--ma-soft-strong); }
.ma-msg-recipient { display: flex; align-items: center; gap: 7px; color: var(--ma-text-2); font-size: 10.5px; }
.ma-msg-recipient select {
  flex: 1;
  min-width: 0;
  height: 27px;
  padding: 0 7px;
  border: 1px solid var(--ma-border);
  border-radius: 6px;
  background: var(--ma-surface);
  color: var(--ma-text);
  font: inherit;
  font-size: 10.5px;
}
.ma-msg-audience-note { display: flex; align-items: center; gap: 5px; margin: 0; color: var(--ma-text-3); font-size: 10px; }
.ma-msg-input {
  width: 100%;
  min-height: 66px;
  max-height: 150px;
  resize: vertical;
  padding: 8px 9px;
  border: 1px solid var(--ma-border-strong);
  border-radius: 7px;
  background: var(--ma-surface);
  color: var(--ma-text);
  font: inherit;
  font-size: 11.5px;
  line-height: 1.5;
  outline: none;
}
.ma-msg-input:focus { border-color: var(--ma-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--ma-accent) 12%, transparent); }
.ma-msg-compose-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--ma-text-3); font-size: 9.5px; }
.ma-msg-block {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 9px;
  border-radius: 7px;
  color: var(--ma-leader);
  background: color-mix(in srgb, var(--ma-leader) 8%, transparent);
  font-size: 10px;
}
.ma-msg-block > span { flex: 1; min-width: 0; }
.ma-msg-block svg { flex: 0 0 auto; }
.ma-msg-queue-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.ma-msg-queue-head > strong { font-size: 12px; }
.ma-msg-filters { display: inline-flex; align-items: center; gap: 3px; }
.ma-msg-filters button {
  height: 23px;
  padding: 0 7px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--ma-text-3);
  font: inherit;
  font-size: 9.5px;
  cursor: pointer;
}
.ma-msg-filters button:hover { background: var(--ma-soft); color: var(--ma-text-2); }
.ma-msg-filters button.is-active { border-color: var(--ma-border); background: var(--ma-surface); color: var(--ma-text); font-weight: 600; }
.ma-msg-list { display: flex; flex-direction: column; gap: 8px; max-height: 336px; overflow-y: auto; padding-right: 2px; }
.ma-msg-card {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px;
  border: 1px solid var(--ma-border);
  border-radius: 9px;
  background: var(--ma-surface);
}
.ma-msg-card.is-mine { border-color: color-mix(in srgb, var(--ma-accent) 22%, transparent); background: color-mix(in srgb, var(--ma-accent) 3%, var(--ma-surface)); }
.ma-msg-card-head { display: flex; align-items: center; gap: 7px; min-width: 0; }
.ma-msg-card-who { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
.ma-msg-card-who strong { font-size: 11.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ma-msg-card-who span { color: var(--ma-text-3); font-size: 9.5px; }
.ma-msg-card-head time { color: var(--ma-text-3); font-size: 9px; flex: 0 0 auto; }
.ma-msg-mine-tag { flex: 0 0 auto; padding: 2px 5px; border-radius: 4px; color: var(--ma-accent); background: color-mix(in srgb, var(--ma-accent) 9%, transparent); font-size: 9px; font-weight: 600; }
.ma-msg-content { margin: 0; padding: 1px 0 0 35px; color: var(--ma-text); font-size: 11.5px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.ma-msg-deliveries { display: flex; flex-direction: column; gap: 4px; margin-left: 35px; padding-top: 2px; border-top: 1px dashed var(--ma-border); }
.ma-msg-delivery { display: flex; flex-direction: column; gap: 3px; padding: 5px 0; border-bottom: 1px dashed var(--ma-border); }
.ma-msg-delivery:last-child { border-bottom: 0; }
.ma-msg-delivery-top { display: flex; align-items: center; gap: 5px; min-width: 0; color: var(--ma-text-3); font-size: 9.5px; }
.ma-msg-delivery-top > svg { flex: 0 0 auto; }
.ma-msg-target { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ma-text-2); }
.ma-msg-status { flex: 0 0 auto; padding: 1px 5px; border-radius: 4px; color: var(--ma-text-3); background: var(--ma-soft); font-size: 8.5px; font-weight: 600; }
.ma-msg-status.is-pending { color: var(--ma-leader); background: color-mix(in srgb, var(--ma-leader) 8%, transparent); }
.ma-msg-status.is-ok { color: #0f9f76; background: color-mix(in srgb, #0f9f76 9%, transparent); }
.ma-msg-status.is-failed { color: var(--ma-danger); background: color-mix(in srgb, var(--ma-danger) 8%, transparent); }
.ma-msg-reply { margin-top: 2px; padding: 6px 8px; border-left: 2px solid var(--ma-accent); border-radius: 0 5px 5px 0; background: var(--ma-soft); }
.ma-msg-reply p { margin: 0; color: var(--ma-text-2); font-size: 10.5px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.ma-msg-reply span { display: block; margin-top: 3px; color: var(--ma-text-3); font-size: 8.5px; }
.ma-msg-reply-box { display: flex; flex-direction: column; gap: 6px; }
.ma-msg-reply-box textarea {
  width: 100%;
  min-height: 58px;
  resize: vertical;
  padding: 7px 8px;
  border: 1px solid var(--ma-border-strong);
  border-radius: 7px;
  background: var(--ma-soft);
  color: var(--ma-text);
  font: inherit;
  font-size: 11px;
  line-height: 1.5;
  outline: none;
}
.ma-msg-reply-box textarea:focus { border-color: var(--ma-accent); }
.ma-msg-reply-actions { display: flex; align-items: center; gap: 6px; color: var(--ma-text-3); font-size: 9.5px; }
.ma-msg-reply-actions span { flex: 1; min-width: 0; }
.ma-msg-actions { display: flex; justify-content: flex-end; }
.ma-msg-empty { display: flex; align-items: center; justify-content: center; gap: 6px; min-height: 76px; padding: 18px; border: 1px dashed var(--ma-border); border-radius: 9px; color: var(--ma-text-3); font-size: 10.5px; text-align: center; }
.ma-msg-empty.is-error { color: var(--ma-danger); border-color: color-mix(in srgb, var(--ma-danger) 25%, transparent); }
.ma-msg-foot { display: flex; align-items: flex-start; gap: 6px; padding-top: 9px; border-top: 1px solid var(--ma-border); color: var(--ma-text-3); font-size: 9.5px; line-height: 1.5; }
.ma-msg-foot svg { flex: 0 0 auto; margin-top: 1px; }
.ma-task-page { width: 100%; min-width: 0; max-width: 1400px; }
.ma-task-page .ma-page-head { flex-wrap: wrap; }
.ma-task-page .ma-page-head p { overflow-wrap: anywhere; }
.ma-task-page .ma-page-head > .ma-btn { margin-top: 20px; }
.ma-task-toolbar { display: flex; align-items: center; gap: 10px; margin: 18px 0 12px; flex-wrap: wrap; }
.ma-task-group { display: inline-flex; align-items: center; gap: 6px; color: var(--ma-text-3); font-size: 12px; white-space: nowrap; }
.ma-task-group .ma-select { height: 30px; min-width: 120px; max-width: 200px; }
.ma-task-assignee { display: inline-block; margin-top: 3px; color: var(--ma-text-3); font-size: 11px; }
.ma-task-assignee.is-assigned { color: var(--ma-accent); }
.ma-task-id { display: inline-block; margin-top: 2px; color: var(--ma-text-3); font-size: 10px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: .01em; user-select: text; }
.ma-task-counts { display: flex; gap: 8px; flex-wrap: wrap; }
.ma-task-hint { flex: 1; min-width: 180px; color: var(--ma-text-3); font-size: 12px; overflow-wrap: anywhere; }
.ma-task-canvas-scroll {
  position: relative;
  overflow: auto;
  width: 100%;
  max-width: 100%;
  height: 62vh;
  min-height: 380px;
  border: 1px solid var(--ma-border);
  border-radius: 15px;
  background-color: var(--ma-surface);
  background-image: radial-gradient(circle, color-mix(in srgb, var(--ma-text) 9%, transparent) 1px, transparent 1.2px);
  background-size: 22px 22px;
  -webkit-overflow-scrolling: touch;
}
.ma-task-flow {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 26px;
  width: 100%;
  max-width: 680px;
  margin: 0 auto;
  padding: 22px 0 28px;
}
.ma-task-edges { position: absolute; inset: 0; overflow: visible; pointer-events: none; }
.ma-task-edges marker path { fill: var(--ma-accent); }
.ma-task-edge-hit { fill: none; stroke: transparent; stroke-width: 18; pointer-events: stroke; cursor: pointer; }
.ma-task-edge-line {
  fill: none;
  stroke: var(--ma-accent);
  stroke-width: 1.6;
  opacity: .55;
  transition: opacity .12s ease, stroke-width .12s ease;
}
.ma-task-edge:hover .ma-task-edge-line { opacity: 1; stroke-width: 2.2; }
.ma-task-card {
  position: relative;
  z-index: 1;
  width: calc(100% - 44px);
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 11px 13px;
  border: 1px solid var(--ma-border-strong);
  border-radius: 12px;
  background: var(--ma-surface);
  box-shadow: 0 1px 2px rgba(15, 23, 42, .05);
  user-select: none;
  -webkit-user-select: none;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.ma-task-card:hover { border-color: color-mix(in srgb, var(--ma-accent) 42%, var(--ma-border-strong)); }
.ma-task-card.is-linking {
  border-color: var(--ma-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ma-accent) 20%, transparent);
}
.ma-task-card-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.ma-task-card-actions { display: flex; gap: 2px; }
.ma-task-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 650;
  letter-spacing: .02em;
  background: var(--ma-soft);
  color: var(--ma-text-3);
}
.ma-task-status.is-doing { color: #1f6feb; background: color-mix(in srgb, #1f6feb 12%, transparent); }
.ma-task-status.is-done { color: #18863f; background: color-mix(in srgb, #18863f 12%, transparent); }
.ma-task-mini {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ma-text-3);
  cursor: pointer;
}
.ma-task-mini:hover { background: var(--ma-soft-strong); color: var(--ma-text); }
.ma-task-mini.is-danger:hover { color: var(--ma-danger); }
.ma-task-title {
  font-size: 12.5px;
  font-weight: 650;
  line-height: 1.3;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
}
.ma-task-desc {
  margin: 0;
  color: var(--ma-text-3);
  font-size: 10.5px;
  line-height: 1.45;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.ma-task-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 24px;
  color: var(--ma-text-2);
  text-align: center;
  pointer-events: none;
}
.ma-task-empty > svg { color: var(--ma-text-3); margin-bottom: 2px; }
.ma-task-empty strong { color: var(--ma-text); font-size: 14px; }
.ma-task-empty p { margin: 0; max-width: 380px; color: var(--ma-text-3); font-size: 12px; line-height: 1.55; }
.ma-task-foot-spacer { flex: 1; }
@media (max-width: 560px) {
  .ma-task-canvas-scroll { height: 60vh; min-height: 320px; }
  .ma-task-flow { padding: 18px 0 22px; gap: 22px; }
  .ma-task-card { width: calc(100% - 34px); padding: 10px 11px; }
  .ma-task-toolbar { margin-top: 14px; }
  .ma-task-hint { flex-basis: 100%; order: 3; }
  .ma-task-page .ma-page-head > .ma-btn { margin-top: 0; }
}

@media (max-width: 1180px) {
  .ma-member-table-head, .ma-member-row { grid-template-columns: minmax(0, 1fr) 66px 132px; }
  .ma-member-date, .ma-member-table-head > span:nth-child(3) { display: none; }
}
@media (max-width: 900px) {
  .ma-page { padding: 22px 18px calc(36px + env(safe-area-inset-bottom, 0px)); }
  .ma-page-head { flex-direction: column; gap: 12px; }
  .ma-page-head > .ma-btn { margin-top: 0; }
  .ma-overview { flex-wrap: wrap; }
  .ma-overview-stat { flex: 1 1 33%; border-bottom: 1px solid var(--ma-border); }
  .ma-overview-note { width: 100%; margin: 0; padding: 9px 14px; }
  .ma-workspace { grid-template-columns: 1fr; }
  .ma-list-pane { border-right: 0; border-bottom: 1px solid var(--ma-border); max-height: 290px; }
  .ma-group-list { overflow-y: auto; }
  .ma-detail-pane { padding: 18px; }
}
@media (max-width: 560px) {
  .ma-page h1 { font-size: 21px; }
  .ma-overview-stat { flex-basis: 50%; }
  .ma-overview-note { display: none; }
  .ma-member-table-head, .ma-member-row { grid-template-columns: minmax(0, 1fr) 58px 104px; gap: 6px; padding: 0 8px; }
  .ma-detail-head { flex-wrap: wrap; }
  .ma-detail-tools { margin-left: 56px; }
}
@media (prefers-reduced-motion: reduce) {
  .ma-page *, .ma-panel *, .ma-overlay *, .ma-trigger * { animation-duration: .001ms !important; transition-duration: .001ms !important; }
}
.ma-activity { display: flex; flex-direction: column; gap: 8px; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--ma-border); }
.ma-activity-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.ma-activity-title { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--ma-text-2); }
.ma-activity-title strong { font-size: 12px; color: var(--ma-text); }
.ma-activity-empty { margin: 0; font-size: 10.5px; line-height: 1.6; color: var(--ma-text-3); }
.ma-activity-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.ma-activity-row { display: flex; align-items: flex-start; gap: 8px; padding: 7px 9px; border: 1px solid var(--ma-border); border-radius: 8px; background: var(--ma-surface); }
.ma-activity-state { flex: none; padding: 2px 7px; border-radius: 999px; font-size: 9.5px; font-weight: 600; line-height: 1.6; }
.ma-activity-state.is-using { color: #b45309; background: color-mix(in srgb, #f59e0b 14%, transparent); }
.ma-activity-state.is-viewing { color: var(--ma-text-2); background: var(--ma-soft); }
.ma-activity-state.is-modified { color: #1d4ed8; background: color-mix(in srgb, #3b82f6 12%, transparent); }
.ma-activity-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.ma-activity-main strong { font-size: 11px; color: var(--ma-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ma-activity-main small { font-size: 9.5px; color: var(--ma-text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.ma-usage { display: flex; flex-direction: column; gap: 8px; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--ma-border); }
.ma-usage-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.ma-usage-title { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--ma-text-2); }
.ma-usage-title strong { font-size: 12px; color: var(--ma-text); }
.ma-usage-total { display: flex; align-items: baseline; gap: 6px; padding: 9px 11px; border-radius: 9px; border: 1px solid var(--ma-border); background: var(--ma-soft); }
.ma-usage-total span { font-size: 10.5px; color: var(--ma-text-3); }
.ma-usage-total strong { font-size: 20px; line-height: 1.1; color: var(--ma-accent); font-variant-numeric: tabular-nums; }
.ma-usage-total em { font-style: normal; font-size: 9.5px; color: var(--ma-text-3); }
.ma-usage-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.ma-usage-row { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(54px, 1.5fr) auto auto; align-items: center; gap: 8px; padding: 7px 9px; border: 1px solid var(--ma-border); border-radius: 8px; background: var(--ma-surface); }
.ma-usage-person { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.ma-usage-person strong { font-size: 11px; color: var(--ma-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ma-usage-person small { font-size: 9px; color: var(--ma-text-3); }
.ma-usage-bar { position: relative; height: 6px; border-radius: 999px; background: var(--ma-soft-strong); overflow: hidden; }
.ma-usage-bar i { position: absolute; inset: 0 auto 0 0; border-radius: 999px; background: var(--ma-accent); }
.ma-usage-value { font-size: 11px; font-weight: 600; color: var(--ma-text); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ma-usage-percent { font-size: 10px; color: var(--ma-text-2); min-width: 34px; text-align: right; font-variant-numeric: tabular-nums; }
.ma-usage-empty { margin: 0; font-size: 10.5px; line-height: 1.6; color: var(--ma-text-3); }
.ma-usage-empty.is-error { color: #b91c1c; }
.ma-usage-hint { margin: 0; font-size: 9.5px; line-height: 1.55; color: var(--ma-text-3); }
@media (max-width: 560px) {
  .ma-usage-row { grid-template-columns: minmax(0, 1fr) auto auto; }
  .ma-usage-bar { display: none; }
}
`

    function installStyles() {
      if (typeof document === 'undefined') return
      const previous = document.getElementById(STYLE_ID)
      if (previous) previous.remove()
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    const inject = ['slots', 'sessions']

    function apply(ctx) {
      installStyles()
      const store = createStore()
      const sessions = ctx.sessions
      const renameSession = async (sessionId, title) => {
        const result = await sessions.using(
          sessionId,
          { source: 'controllerOperation' },
          (reference) => reference.binding.session.rename(title),
        )
        if (!result || result.ok !== true) {
          throw new Error((result && result.error && result.error.message) || '重命名对话失败')
        }
        return result.value
      }
      const deliverInterjection = async (sessionId, text) => {
        const result = await sessions.using(
          sessionId,
          { source: 'controllerOperation' },
          (reference) =>
            reference.binding.session.prompt([{ type: 'text', text }], 'steer'),
        )
        if (!result || result.ok !== true) {
          throw new Error((result && result.error && result.error.message) || '插话投递失败')
        }
        return result.value
      }

      ctx.slots.inject('main', () => {
        let dispose
        try {
          dispose = ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              inject: () => ({ store, deliverInterjection }),
            },
            GroupPage,
          )
        } catch (error) {
          console.error('[dsh-multi-agent] 无法注册分组主页：', error)
          return () => {}
        }
        return typeof dispose === 'function' ? dispose : () => {}
      })

      ctx.slots.inject('sidebar.panellist', () => {
        let dispose
        try {
          dispose = ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 16,
              label: () => 'Agent 分组',
            },
            GroupGlyph,
          )
        } catch (error) {
          console.error('[dsh-multi-agent] 无法注册侧栏入口：', error)
          return () => {}
        }
        return typeof dispose === 'function' ? dispose : () => {}
      })

      ctx.slots.inject('main', () => {
        let dispose
        try {
          dispose = ctx.slots.register(
            {
              name: 'main',
              key: TASKS_PANEL_ID,
              inject: () => ({ store }),
            },
            TaskBoard,
          )
        } catch (error) {
          console.error('[dsh-multi-agent] 无法注册任务主页：', error)
          return () => {}
        }
        return typeof dispose === 'function' ? dispose : () => {}
      })

      ctx.slots.inject('sidebar.panellist', () => {
        let dispose
        try {
          dispose = ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: TASKS_PANEL_ID,
              order: 17,
              label: () => '任务',
            },
            TaskGlyph,
          )
        } catch (error) {
          console.error('[dsh-multi-agent] 无法注册任务侧栏入口：', error)
          return () => {}
        }
        return typeof dispose === 'function' ? dispose : () => {}
      })

      ctx.slots.inject('conversation.session.header.actions', () => {
        let dispose
        try {
          dispose = ctx.slots.register(
            {
              name: 'conversation.session.header.actions',
              id: 'multi-agent',
              order: 20,
              inject: () => ({ store, renameSession, deliverInterjection }),
            },
            HeaderAction,
          )
        } catch (error) {
          console.error('[dsh-multi-agent] 无法注册对话操作：', error)
          return () => {}
        }
        return typeof dispose === 'function' ? dispose : () => {}
      })
    }

    module.exports.inject = inject
    module.exports.apply = apply
    return module.exports
  },
})
