/**
 * dsh-better-session — Client half.
 *
 * Three surfaces share one store:
 * - two extra rows in a Session row's context menu (批量操作 / 删除会话);
 * - a per-row select toggle plus a batch bar at the sidebar foot while batch
 *   mode is on;
 * - a 会话设置 page in Settings listing every archived Session with
 *   restore/delete, singly or in batch.
 *
 * Every destructive path goes through one confirm dialog that states the
 * deletion is permanent, and only then calls the Host's delete route.
 */
window.__ModuleLoader__.load({
  id: 'dsh-better-session',
  factory (require) {
    const React = require('react')
    const h = React.createElement
    const { useSyncExternalStore, useMemo, useState, useEffect, useCallback, useRef } = React
    // `react-dom` is part of the browser module table the shell provides. The
    // lookup is guarded so a composition without it falls back to inline
    // rendering instead of throwing at module load.
    let createPortal = null
    try {
      const ReactDOM = require('react-dom')
      if (typeof ReactDOM?.createPortal === 'function') createPortal = ReactDOM.createPortal
    } catch {
      createPortal = null
    }
    /** Dictionary namespace owned by this plugin. */
    const NS = 'sessionMgr'
    /** Host route mounted by index.js. */
    const API_PATH = 'better-session/api'
    const EMPTY = []

    const zh = {
      'menu.batch': '批量操作',
      'menu.delete': '删除会话',
      'menu.select': '选择会话',
      'menu.unselect': '取消选择',
      'batch.selected': '已选 {count} 项',
      'batch.archive': '批量归档',
      'batch.delete': '批量删除',
      'batch.exit': '退出',
      'batch.all': '全选',
      'batch.clear': '取消全选',
      'batch.archived': '已归档 {count} 个会话',
      'settings.label': '会话设置',
      'order.label': '会话排序',
      'order.title': '会话排序',
      'order.intro': '内置排序依据是「最近更新时间」，且只有手动和最近更新两种。这里可以按更多方式排序，每个工作区各自独立。',
      'order.ungrouped': '未分组',
      'order.empty': '还没有可以排序的会话',
      'order.count': '{count} 个',
      'order.modeLabel': '排序方式',
      'order.byUpdated': '最近更新',
      'order.byCreated': '创建时间',
      'order.byName': '名称',
      'order.bySize': '占用空间',
      'order.ascending': '正序（当前倒序，点击切换）',
      'order.descending': '倒序（当前正序，点击切换）',
      'order.ascShort': '正序 ↑',
      'order.descShort': '倒序 ↓',
      'settings.title': '会话设置',
      'settings.intro': '这里列出全部已归档的会话。删除会连同会话日志与缓存一起永久移除，不进入回收站。',
      'settings.archived': '已归档会话',
      'settings.empty': '没有已归档的会话',
      'settings.restore': '恢复',
      'settings.delete': '删除',
      'settings.batchRestore': '批量恢复',
      'settings.batchDelete': '批量删除',
      'settings.selectAll': '全选',
      'settings.clear': '清空',
      'settings.loading': '加载中…',
      'settings.count': '共 {count} 个',
      'settings.restored': '已恢复 {count} 个会话',
      'confirm.deleteTitle': '永久删除会话？',
      'confirm.deleteBody': '将永久删除 {count} 个会话的日志与缓存。此操作无法恢复，不会进入回收站。',
      'confirm.confirm': '永久删除',
      'confirm.cancel': '取消',
      'confirm.busy': '正在删除…',
      'result.deleted': '已删除 {count} 个会话',
      'result.deletedLingering': '已删除 {count} 个会话（其中 {lingering} 个仍在关闭中，列表可能稍后才消失）',
      'result.failed': '有 {count} 个会话删除失败：{reason}',
      'error.offline': '无法连接本地会话管理服务',
    }

    const en = {
      'menu.batch': 'Select multiple',
      'menu.delete': 'Delete session',
      'menu.select': 'Select session',
      'menu.unselect': 'Deselect',
      'batch.selected': '{count} selected',
      'batch.archive': 'Archive selected',
      'batch.delete': 'Delete selected',
      'batch.exit': 'Exit',
      'batch.all': 'Select all',
      'batch.clear': 'Clear selection',
      'batch.archived': 'Archived {count} sessions',
      'settings.label': 'Session settings',
      'order.label': 'Session order',
      'order.title': 'Session order',
      'order.intro': "The built-in order is newest-updated and offers only manual or last-updated. This page sorts by more criteria, with settings kept per workspace.",
      'order.ungrouped': 'Ungrouped',
      'order.empty': 'No sessions to order yet',
      'order.count': '{count}',
      'order.modeLabel': 'Sort by',
      'order.byUpdated': 'Last updated',
      'order.byCreated': 'Created',
      'order.byName': 'Name',
      'order.bySize': 'Size',
      'order.ascending': 'Ascending (currently descending, click to flip)',
      'order.descending': 'Descending (currently ascending, click to flip)',
      'order.ascShort': 'Asc ↑',
      'order.descShort': 'Desc ↓',
      'settings.title': 'Session settings',
      'settings.intro': 'Every archived session is listed here. Deleting removes the session log and its cache permanently; nothing goes to the recycle bin.',
      'settings.archived': 'Archived sessions',
      'settings.empty': 'No archived sessions',
      'settings.restore': 'Restore',
      'settings.delete': 'Delete',
      'settings.batchRestore': 'Restore selected',
      'settings.batchDelete': 'Delete selected',
      'settings.selectAll': 'Select all',
      'settings.clear': 'Clear',
      'settings.loading': 'Loading…',
      'settings.count': '{count} total',
      'settings.restored': 'Restored {count} sessions',
      'confirm.deleteTitle': 'Delete sessions permanently?',
      'confirm.deleteBody': '{count} session logs and their caches will be permanently removed. This cannot be undone, and nothing goes to the recycle bin.',
      'confirm.confirm': 'Delete permanently',
      'confirm.cancel': 'Cancel',
      'confirm.busy': 'Deleting…',
      'result.deleted': 'Deleted {count} sessions',
      'result.deletedLingering': 'Deleted {count} sessions ({lingering} still shutting down; they may leave the list shortly)',
      'result.failed': '{count} sessions could not be deleted: {reason}',
      'error.offline': 'Cannot reach the local session management service',
    }

    let translate = (key) => key

    /** Interpolate `{name}` placeholders. */
    function fmt (text, values) {
      if (!values) return String(text)
      return String(text).replace(/\{(\w+)\}/g, (all, name) => (name in values ? String(values[name]) : all))
    }

    const t = (key, values) => fmt(translate(key), values)

    // ── Shared store ───────────────────────────────────────────────────────
    /** Modules evaluate once per page, so this is the single source of truth
     *  shared by the sidebar bar, the row toggles, and the settings page. */
    let snapshot = {
      batchMode: false,
      selected: EMPTY,
      settingsSelected: EMPTY,
      pending: null,
      busy: false,
      /** `{ scope, kind, text }`; scope keeps one surface's news out of the other. */
      notice: null,
      /** Bumped when the active locale changes, so mounted text re-renders. */
      revision: 0,
    }
    const listeners = new Set()

    function setState (patch) {
      snapshot = { ...snapshot, ...patch }
      for (const listener of [...listeners]) listener()
    }

    function subscribe (listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }

    function useStore (selector) {
      const read = useCallback(() => selector(snapshot), [selector])
      return useSyncExternalStore(subscribe, read, read)
    }

    const selectBatchMode = (s) => s.batchMode
    const selectSelected = (s) => s.selected
    const selectSettingsSelected = (s) => s.settingsSelected
    const selectPending = (s) => s.pending
    const selectBusy = (s) => s.busy

    /**
     * The notice one surface may show; the other surface's news stays hidden.
     * @param scope - 'sidebar' or 'settings'.
     * @returns the matching notice, or null.
     */
    function useNotice (scope) {
      const read = useCallback(() => (
        snapshot.notice !== null && snapshot.notice.scope === scope ? snapshot.notice : null
      ), [scope])
      return useSyncExternalStore(subscribe, read, read)
    }

    function toggleSelected (sessionId) {
      const selected = snapshot.selected.includes(sessionId)
        ? snapshot.selected.filter((id) => id !== sessionId)
        : [...snapshot.selected, sessionId]
      setState({ selected })
    }

    function toggleSettingsSelected (sessionId) {
      const settingsSelected = snapshot.settingsSelected.includes(sessionId)
        ? snapshot.settingsSelected.filter((id) => id !== sessionId)
        : [...snapshot.settingsSelected, sessionId]
      setState({ settingsSelected })
    }

    function startBatch (sessionId) {
      setState({ batchMode: true, selected: sessionId === undefined ? EMPTY : [sessionId] })
    }

    function exitBatch () {
      setState({ batchMode: false, selected: EMPTY })
    }

    /**
     * Escape leaves batch mode, the way it dismisses any other transient
     * surface. The confirm dialog stops the event first (it owns Escape while
     * it is open), and typing inside an editor keeps its own Escape.
     * @param event - the document keydown event.
     */
    function onBatchEscape (event) {
      if (event.key !== 'Escape') return
      if (!snapshot.batchMode || snapshot.busy) return
      if (snapshot.pending !== null) return
      const target = event.target
      if (typeof Element !== 'undefined' && target instanceof Element &&
          target.closest('input, textarea, [contenteditable="true"]') !== null) return
      event.preventDefault()
      exitBatch()
    }

    // ── Client services ────────────────────────────────────────────────────
    let rootCtx = null

    function clientService (name) {
      try {
        return rootCtx?.get?.(name)
      } catch {
        return undefined
      }
    }

    /** Workspace Controller's Client face owns archive/unarchive. */
    function workspaceService () {
      return clientService('workspaces')
    }

    /** The archive set, read through the service face (fallback path). */
    function archivedIdsNow () {
      try {
        const ids = workspaceService()?.list?.getSnapshot?.()?.archivedSessionIds
        return Array.isArray(ids) ? ids : EMPTY
      } catch {
        return EMPTY
      }
    }

    function subscribeArchived (listener) {
      try {
        return workspaceService()?.list?.subscribe?.(listener) ?? (() => {})
      } catch {
        return () => {}
      }
    }

    /**
     * Archived Session ids, read through the slot's own workspace hook when the
     * owner supplies one and through the service face otherwise.
     * @param props - the slot's props.
     * @returns archived ids (a stable empty array when nothing is archived).
     */
    function useArchivedIds (props) {
      const useWorkspaces = props?.useWorkspaces
      if (typeof useWorkspaces === 'function') {
        return useWorkspaces((value) => (
          Array.isArray(value?.archivedSessionIds) ? value.archivedSessionIds : EMPTY
        )) ?? EMPTY
      }
      return useSyncExternalStore(subscribeArchived, archivedIdsNow, archivedIdsNow)
    }

    async function archiveMany (ids) {
      const service = workspaceService()
      if (service?.archiveSession === undefined) throw new Error('archive unavailable')
      for (const id of ids) await service.archiveSession(id, { stopActivity: true })
    }

    async function unarchiveMany (ids) {
      const service = workspaceService()
      if (service?.unarchiveSession === undefined) throw new Error('restore unavailable')
      for (const id of ids) await service.unarchiveSession(id)
    }

    /**
     * Resolve one of the plugin's own host routes against the page base, so a
     * reverse-proxy prefix and the desktop shell both keep working.
     * @param path - route below the page directory.
     * @returns an absolute URL.
     */
    function hostUrl (path) {
      const base = typeof document !== 'undefined' && typeof document.baseURI === 'string'
        ? document.baseURI
        : 'http://dsh.internal/'
      return new URL(path.replace(/^\/+/, ''), new URL(base, 'http://dsh.internal/')).href
    }

    /**
     * Call the Host half.
     * @param method - route method name.
     * @param payload - extra request fields.
     * @returns the route's `value`.
     */
    async function callHost (method, payload) {
      const response = await fetch(hostUrl(API_PATH), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, ...payload }),
      })
      const body = await response.json().catch(() => null)
      if (body === null || body.ok !== true) {
        throw new Error(body?.error?.message ?? `HTTP ${response.status}`)
      }
      return body.value
    }

    /**
     * Permanently delete Sessions through the Host half.
     * @param ids - Session ids.
     * @returns one result row per id.
     */
    async function deleteMany (ids) {
      if (ids.length === 0) return EMPTY
      const value = await callHost('delete', { sessionIds: ids, confirm: true })
      return Array.isArray(value?.results) ? value.results : EMPTY
    }

    // ── Confirm dialog ─────────────────────────────────────────────────────
    /**
     * Ask before an irreversible deletion.
     * @param ids - Sessions that would be destroyed.
     * @returns true only when the user confirmed.
     */
    function confirmDelete (ids) {
      return new Promise((resolve) => {
        const finish = (ok) => {
          setState({ pending: null })
          resolve(ok)
        }
        setState({ pending: { ids: [...ids], resolve: finish } })
      })
    }

    /**
     * Confirm, then delete, then report and run the caller's cleanup.
     * @param ids - Session ids.
     * @param after - called after every deletion succeeded.
     * @param scope - which surface shows the outcome ('sidebar' or 'settings').
     */
    async function runDelete (ids, after, scope) {
      if (ids.length === 0) return
      const ok = await confirmDelete(ids)
      if (!ok) return
      setState({ busy: true, notice: null })
      try {
        const results = await deleteMany(ids)
        const failed = results.filter((row) => row.deleted !== true)
        // A Session whose Agent outlasted the release wait is still deleted;
        // report it separately so the user knows the window may be stale.
        const lingering = results.filter((row) => row.deleted === true && row.released === false)
        setState({
          busy: false,
          notice: {
            scope: scope ?? 'sidebar',
            kind: failed.length === 0 ? 'ok' : 'error',
            text: failed.length > 0
              ? t('result.failed', {
                  count: failed.length,
                  reason: failed.map((row) => row.message ?? row.code).join('; '),
                })
              : lingering.length > 0
                ? t('result.deletedLingering', {
                    count: results.length,
                    lingering: lingering.length,
                  })
                : t('result.deleted', { count: results.length }),
          },
        })
        if (failed.length === 0 && typeof after === 'function') after()
      } catch (error) {
        setState({
          busy: false,
          notice: {
            scope: scope ?? 'sidebar',
            kind: 'error',
            text: String(error?.message ?? error) || t('error.offline'),
          },
        })
      }
    }

    // ── Icons ──────────────────────────────────────────────────────────────
    function icon (paths, size, extra) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size ?? 14,
        height: size ?? 14,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block', flex: 'none' },
        ...extra,
      }, paths.map((d, index) => h('path', { key: index, d })))
    }

    const ICON_BATCH = ['M4 6h9', 'M4 12h9', 'M4 18h9', 'M16 8l2 2 4-4']
    const ICON_TRASH = ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3']
    const ICON_CHECK = ['M4 12l5 5L20 6']
    const ICON_RESTORE = ['M4 10a8 8 0 1 1 2 6', 'M4 4v6h6']
    // Ascending bars, the usual "sort" glyph.
    const ICON_SORT = ['M4 6h9', 'M4 12h6', 'M4 18h3']

    // ── Sidebar: context-menu rows ────────────────────────────────────────
    /**
     * Contribute two rows to the Session context menu's FOOTER group, the same
     * group the built-in 归档会话 lives in. Registering them in the
     * `sidebar.workspaces.session.menu.item` slot instead would place them
     * above that group's separator (the slot renders between the main items
     * and the footer), splitting archive away from its siblings.
     *
     * 批量操作 is a separate provider because the built-in archive declares
     * `separatorBefore`, and the footer keeps registry order: at order 550 the
     * batch row lands directly above 归档会话, while 删除会话 stays the last
     * (destructive) row below it. The batch row carries no separator of its
     * own, so the block still has exactly one line above it.
     *
     * The registry dispatches by `target: 'session'`; the open menu's identity
     * arrives through `ctx.contextMenus.active`.
     * @param ctx - Client plugin context.
     * @returns a disposer removing both contributions.
     */
    function registerMenuActions (ctx) {
      const menus = ctx.get('contextMenus')
      if (menus?.register === undefined) return () => {}
      const disposeIcons = [
        ctx.slots.register({ name: 'contextMenu.icon', key: 'better-session.batch' },
          () => icon(ICON_BATCH, 14)),
        ctx.slots.register({ name: 'contextMenu.icon', key: 'better-session.delete' },
          () => icon(ICON_TRASH, 14)),
      ]
      const disposeBatch = menus.register({
        id: 'better-session.batch',
        target: 'session',
        // Above the built-in archive row (600), so it opens the footer block.
        order: 550,
        resolve: ({ sessionId }) => [{
          id: 'batch',
          label: t('menu.batch'),
          icon: { key: 'better-session.batch' },
          // 归档会话 already declares a separator before itself; a second one
          // here would draw two adjacent lines in the footer.
          afterContent: true,
          run: () => { startBatch(sessionId) },
        }],
      })
      const disposeDelete = menus.register({
        id: 'better-session.delete',
        target: 'session',
        // Last row of the footer, after the built-in archive row.
        order: 700,
        resolve: ({ sessionId }) => [{
          id: 'delete',
          label: t('menu.delete'),
          icon: { key: 'better-session.delete' },
          danger: true,
          afterContent: true,
          run: () => { void runDelete([sessionId], undefined, 'sidebar') },
        }],
      })
      return () => {
        for (const dispose of [disposeDelete, disposeBatch, ...disposeIcons]) {
          try {
            dispose?.()
          } catch {
            // Already removed with the menu registry.
          }
        }
      }
    }

    // ── Sidebar: per-row select toggle ────────────────────────────────────
    /**
     * The always-visible selection control, in the row's leading cell. That
     * cell is only free while the row's own state is idle (a running or
     * unread row spends it on its status dot), so a busy row is selected
     * through its context menu's 批量操作 instead.
     */
    function rowSelectLeading (props) {
      const { sessionId } = props
      const batchMode = useStore(selectBatchMode)
      const selected = useStore(selectSelected)
      if (!batchMode) return null
      const on = selected.includes(sessionId)
      const label = on ? t('menu.unselect') : t('menu.select')
      return h('button', {
        type: 'button',
        className: `dsm-lead${on ? ' dsm-lead--on' : ''}`,
        title: label,
        'aria-label': label,
        'aria-pressed': on,
        onClick: (event) => {
          event.preventDefault()
          event.stopPropagation()
          toggleSelected(sessionId)
        },
      }, on ? icon(ICON_CHECK, 9, { strokeWidth: 3 }) : null)
    }

    // ── Sidebar foot: batch action bar ────────────────────────────────────
    /**
     * The Sessions the sidebar can currently select: every known Session that
     * is not archived. The list is read from the same services the browser
     * renders from, so 全选 never selects a row the user cannot see.
     * @param props - the slot's props (its `useSessions` hook is authoritative).
     * @returns selectable Session ids.
     */
    function useSelectableIds (props, archivedIds) {
      const useSessions = props?.useSessions
      const list = typeof useSessions === 'function' ? useSessions((state) => state) : undefined
      return useMemo(() => {
        const ids = Array.isArray(list?.ids) ? list.ids : []
        if (ids.length === 0) return EMPTY
        const archived = new Set(archivedIds)
        return ids.filter(id => !archived.has(id))
      }, [list, archivedIds])
    }

    /** The two batch buttons at the foot of the sidebar column. */
    function footerBatchBar (props) {
      const batchMode = useStore(selectBatchMode)
      const selected = useStore(selectSelected)
      const busy = useStore(selectBusy)
      const notice = useNotice('sidebar')
      const archivedIds = useArchivedIds(props)
      const selectable = useSelectableIds(props, archivedIds)
      // The foot row is a narrow rail when the column is collapsed; a batch
      // bar there would be unreadable, so it appears only on wide content.
      if (props?.wide === false) return null
      if (!batchMode) return null
      const count = selected.length
      const allSelected = selectable.length > 0 && selectable.every(id => selected.includes(id))
      return h('div', { className: 'dsm-foot', role: 'group', 'aria-label': t('menu.batch') },
        h('div', { className: 'dsm-foot-head' },
          h('button', {
            type: 'button',
            className: 'dsm-all',
            disabled: busy || selectable.length === 0,
            'aria-pressed': allSelected,
            title: allSelected ? t('batch.clear') : t('batch.all'),
            onClick: () => {
              setState({ selected: allSelected ? EMPTY : [...selectable] })
            },
          },
          h('span', { className: `dsm-check${allSelected ? ' dsm-check--on' : ''}` },
            allSelected ? icon(ICON_CHECK, 10, { strokeWidth: 3 }) : null),
          h('span', null, t('batch.all'))),
          h('span', { className: 'dsm-foot-count' }, t('batch.selected', { count })),
          h('button', {
            type: 'button',
            className: 'dsm-link',
            disabled: busy,
            onClick: exitBatch,
          }, t('batch.exit')),
        ),
        h('div', { className: 'dsm-foot-row' },
          h('button', {
            type: 'button',
            className: 'dsm-btn dsm-btn--tight',
            disabled: busy || count === 0,
            onClick: () => { void archiveSelection([...selected]) },
          }, t('batch.archive')),
          h('button', {
            type: 'button',
            className: 'dsm-btn dsm-btn--tight dsm-btn--danger',
            disabled: busy || count === 0,
            onClick: () => {
              void runDelete([...selected], () => {
                setState({ selected: EMPTY, batchMode: false })
              }, 'sidebar')
            },
          }, t('batch.delete')),
        ),
        notice === null ? null : h('div', {
          className: `dsm-notice dsm-notice--${notice.kind}`, role: 'status',
        }, notice.text),
      )
    }

    /** Archive the current selection and leave batch mode. */
    async function archiveSelection (ids) {
      if (ids.length === 0) return
      setState({ busy: true, notice: null })
      try {
        await archiveMany(ids)
        setState({
          busy: false,
          selected: EMPTY,
          notice: { scope: 'sidebar', kind: 'ok', text: t('batch.archived', { count: ids.length }) },
        })
      } catch (error) {
        setState({
          busy: false,
          notice: { scope: 'sidebar', kind: 'error', text: String(error?.message ?? error) },
        })
      }
    }

    // ── Confirm overlay ────────────────────────────────────────────────────
    /** The one irreversible-action dialog, mounted in the frame overlay. */
    function confirmOverlay () {
      const pending = useStore(selectPending)
      const busy = useStore(selectBusy)
      const resolveRef = useRef(null)
      resolveRef.current = pending === null ? null : pending.resolve

      useEffect(() => {
        if (pending === null) return undefined
        const onKey = (event) => {
          if (event.key !== 'Escape' || busy) return
          // While the dialog is open Escape belongs to it alone: the batch-mode
          // handler must not also drop the selection behind it.
          event.stopPropagation()
          resolveRef.current?.(false)
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
      }, [pending, busy])

      if (pending === null) return null
      const dialog = h('div', { className: 'dsm-scrim' },
        h('div', {
          className: 'dsm-modal',
          role: 'alertdialog',
          'aria-modal': 'true',
          'aria-labelledby': 'dsm-confirm-title',
          'aria-describedby': 'dsm-confirm-body',
        },
        h('div', { className: 'dsm-modal-title', id: 'dsm-confirm-title' }, t('confirm.deleteTitle')),
        h('div', { className: 'dsm-modal-body', id: 'dsm-confirm-body' },
          t('confirm.deleteBody', { count: pending.ids.length })),
        h('div', { className: 'dsm-modal-actions' },
          h('button', {
            type: 'button', className: 'dsm-btn', disabled: busy,
            onClick: () => resolveRef.current?.(false),
          }, t('confirm.cancel')),
          h('button', {
            type: 'button', className: 'dsm-btn dsm-btn--danger', disabled: busy,
            onClick: () => resolveRef.current?.(true),
          }, busy ? t('confirm.busy') : t('confirm.confirm')),
        ),
        ),
      )
      // The shell overlay this entry lives in is z-index 20, while the Settings
      // panel portals itself at 1000, so a dialog left in place would sit
      // BEHIND the settings window it was opened from. Portalling to the body
      // takes the dialog out of that stacking context entirely.
      return createPortal !== null
        ? createPortal(dialog, document.body)
        : dialog
    }

    // ── Settings nav icon ──────────────────────────────────────────────────
    /**
     * The 会话设置 navigation glyph: two stacked speech bubbles.
     *
     * Drawn to the Host's own icon contract so it sits level with the built-in
     * settings rows — 16×16 viewBox, no fill, `currentColor`, medium stroke
     * (1.3 at that viewBox), round joins/caps. The owner passes the square edge
     * (`size: 16`) and lets the glyph inherit the row's text colour, so the
     * active row tints it without a second rule here.
     * @param props - the settings nav row's presentation.
     * @returns the inline SVG.
     */
    function SessionSettingsIcon (props) {
      const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 16
      return h('svg', {
        xmlns: 'http://www.w3.org/2000/svg',
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block', flex: 'none' },
      },
      // Back bubble: the upper-right sheet. Both open ends land exactly on the
      // front bubble's outline, so it reads as emerging from behind it rather
      // than as strokes floating inside it.
      h('path', {
        d: 'M 5.6 4.4 V 3.1 A 1.6 1.6 0 0 1 7.2 1.5 H 12.8 A 1.6 1.6 0 0 1 14.4 3.1 V 6.9 A 1.6 1.6 0 0 1 12.8 8.5 H 9.9',
      }),
      // Front bubble with a pointer hanging from its bottom edge.
      h('path', {
        d: 'M 3.1 4.4 H 8.3 A 1.6 1.6 0 0 1 9.9 6.0 V 10.0 A 1.6 1.6 0 0 1 8.3 11.6 H 6.5 L 5.0 13.5 L 3.6 11.6 H 3.1 A 1.6 1.6 0 0 1 1.5 10.0 V 6.0 A 1.6 1.6 0 0 1 3.1 4.4 Z',
      }),
      )
    }

    // ── Session ordering: one panel, per-workspace settings ───────────────
    /**
     * The shipped sidebar orders Sessions two ways only — manual drag order, or
     * newest-updated first — and both its menu and its sort function are
     * compiled into the shell, so a plugin can neither add a mode to that menu
     * nor change how it sorts. This panel therefore carries its own ordering:
     * the same Session data, read from the same services, sorted by any of the
     * modes below.
     *
     * Settings are per Workspace, stored under this plugin's own key. The
     * ungrouped bucket uses the empty string, matching how the shell keys it.
     */
    const ORDER_STORAGE_KEY = 'dsh-better-session.order.v1'
    const UNGROUPED_KEY = ''

    /** Sort modes, in the order the picker lists them. */
    const ORDER_MODES = [
      { id: 'updated', label: 'order.byUpdated' },
      { id: 'created', label: 'order.byCreated' },
      { id: 'name', label: 'order.byName' },
      { id: 'size', label: 'order.bySize' },
    ]

    /** Per-account `{ mode, desc }`, loaded once from localStorage. */
    let orderSettings = loadOrderSettings()

    /** Read the stored per-Workspace ordering, ignoring anything malformed. */
    function loadOrderSettings () {
      try {
        const raw = globalThis.localStorage?.getItem(ORDER_STORAGE_KEY)
        if (typeof raw !== 'string') return {}
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') return {}
        const clean = {}
        for (const [key, value] of Object.entries(parsed)) {
          if (value === null || typeof value !== 'object') continue
          const mode = ORDER_MODES.some(entry => entry.id === value.mode) ? value.mode : 'updated'
          clean[key] = { mode, desc: value.desc === true }
        }
        return clean
      } catch {
        return {}
      }
    }

    /** Persist the current ordering settings. */
    function saveOrderSettings () {
      try {
        globalThis.localStorage?.setItem(ORDER_STORAGE_KEY, JSON.stringify(orderSettings))
      } catch {
        // A browser refusing storage only costs persistence, not the session.
      }
    }

    /**
     * The ordering in force for one account.
     * @param key - Workspace id, or '' for the ungrouped bucket.
     * @returns `{ mode, desc }`.
     */
    function orderFor (key) {
      return orderSettings[key] ?? { mode: 'updated', desc: true }
    }

    /**
     * Change one account's ordering.
     * @param key - Workspace id, or '' for the ungrouped bucket.
     * @param patch - `{ mode?, desc? }`.
     */
    function setOrderFor (key, patch) {
      orderSettings = { ...orderSettings, [key]: { ...orderFor(key), ...patch } }
      saveOrderSettings()
      setState({ orderRevision: (snapshot.orderRevision ?? 0) + 1 })
    }

    /**
     * Compare two Session rows under one ordering.
     * @param a - left row.
     * @param b - right row.
     * @param mode - sort mode id.
     * @returns a negative, zero, or positive comparison.
     */
    function compareRows (a, b, mode) {
      if (mode === 'name') {
        // localeCompare so CJK and accents sort the way a reader expects.
        return String(a.title ?? '').localeCompare(String(b.title ?? ''), undefined, { numeric: true, sensitivity: 'base' })
      }
      if (mode === 'size') return (a.bytes ?? 0) - (b.bytes ?? 0)
      if (mode === 'created') return (a.createdAt ?? 0) - (b.createdAt ?? 0)
      return (a.updatedAt ?? 0) - (b.updatedAt ?? 0)
    }

    /**
     * Sort rows for one account, honouring its direction. Ties fall back to the
     * Session id so the list never reorders itself between renders.
     * @param rows - rows to sort.
     * @param setting - `{ mode, desc }`.
     * @returns a new sorted array.
     */
    function sortRows (rows, setting) {
      const factor = setting.desc ? -1 : 1
      return [...rows].sort((a, b) => {
        const primary = compareRows(a, b, setting.mode)
        if (primary !== 0) return primary * factor
        return String(a.sessionId).localeCompare(String(b.sessionId))
      })
    }

    /**
     * Read every Session with the facts the ordering needs.
     *
     * The live snapshot carries title and `updatedAt` but no `createdAt`, so
     * creation time (and the exact on-disk size) come from the Host's own
     * records. The live snapshot still decides membership and titles, so a row
     * appears as soon as the sidebar shows it; Host facts only enrich it.
     * @param props - the panel's props (its selector hooks are authoritative).
     * @param revision - bump to re-derive after a settings change.
     * @returns `{ rows, workspaces, loading }`.
     */
    function useSortableRows (props, revision) {
      const useSessions = props?.useSessions
      const useWorkspaces = props?.useWorkspaces
      const list = typeof useSessions === 'function' ? useSessions(state => state) : undefined
      const archived = typeof useWorkspaces === 'function'
        ? useWorkspaces(value => (Array.isArray(value?.archivedSessionIds) ? value.archivedSessionIds : EMPTY))
        : EMPTY
      const workspaces = typeof useWorkspaces === 'function'
        ? useWorkspaces(value => (Array.isArray(value?.items) ? value.items : EMPTY))
        : EMPTY

      const [hostRows, setHostRows] = useState(null)
      const [loading, setLoading] = useState(true)
      const signature = (Array.isArray(list?.ids) ? list.ids : EMPTY).join(',')

      useEffect(() => {
        let cancelled = false
        // Re-read whenever the visible set changes; the Host read is cheap and
        // is the only place durable creation time exists.
        void (async () => {
          try {
            const value = await callHost('list', {})
            if (cancelled) return
            setHostRows(Array.isArray(value?.sessions) ? value.sessions : EMPTY)
          } catch {
            if (!cancelled) setHostRows(EMPTY)
          } finally {
            if (!cancelled) setLoading(false)
          }
        })()
        return () => { cancelled = true }
      }, [signature])

      return useMemo(() => {
        const ids = Array.isArray(list?.ids) ? list.ids : EMPTY
        const hidden = new Set(Array.isArray(archived) ? archived : EMPTY)
        const hostById = new Map((hostRows ?? EMPTY).map(row => [row.sessionId, row]))
        const rows = ids
          .filter(id => list?.byId?.[id] !== undefined && !hidden.has(id))
          .map(id => {
            const summary = list.byId[id]
            const host = hostById.get(id)
            return {
              sessionId: id,
              title: summary?.displayTitle ?? host?.title ?? id,
              updatedAt: typeof summary?.updatedAt === 'number' ? summary.updatedAt : (host?.updatedAt ?? 0),
              // Only the Host record has a real creation time.
              createdAt: typeof host?.createdAt === 'number' ? host.createdAt : 0,
              bytes: typeof host?.bytes === 'number' ? host.bytes : 0,
              workspaceId: host?.workspaceId ?? null,
            }
          })
        // Sessions the live snapshot has not listed yet still deserve a row.
        const known = new Set(rows.map(row => row.sessionId))
        for (const host of hostRows ?? EMPTY) {
          if (known.has(host.sessionId) || hidden.has(host.sessionId)) continue
          rows.push({
            sessionId: host.sessionId,
            title: host.title ?? host.sessionId,
            updatedAt: host.updatedAt ?? 0,
            createdAt: host.createdAt ?? 0,
            bytes: host.bytes ?? 0,
            workspaceId: host.workspaceId ?? null,
          })
        }
        return { rows, workspaces: Array.isArray(workspaces) ? workspaces : EMPTY, loading }
        // `revision` re-derives after a settings change even when data is equal.
      }, [list, archived, workspaces, hostRows, loading, revision])
    }

    /**
     * The ordering panel: pick a mode and a direction, per Workspace.
     *
     * Each Workspace is one section with its own controls and its own sorted
     * list, which is what "per Workspace" means here — the shell exposes one
     * global ordering, so this is where per-Workspace choice can exist.
     * @param props - slot props carrying the selector hooks.
     * @returns the panel body.
     */
    function sortPanel (props) {
      const revision = useStore(s => s.orderRevision ?? 0)
      const { rows, workspaces } = useSortableRows(props, revision)
      const navigate = useCallback((sessionId) => {
        try {
          clientService('uiWorkspace')?.openSession(sessionId)
        } catch {
          // A profile without that face simply cannot navigate from here.
        }
      }, [])

      // Group the rows exactly as the shell does: Workspace membership first,
      // leftovers in the ungrouped bucket.
      const groups = useMemo(() => {
        const byId = new Map(rows.map(row => [row.sessionId, row]))
        const seen = new Set()
        const out = []
        for (const workspace of workspaces) {
          const members = []
          for (const id of Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : EMPTY) {
            const row = byId.get(id)
            if (row === undefined) continue
            members.push(row)
            seen.add(id)
          }
          if (members.length === 0) continue
          out.push({ key: String(workspace.workspaceId), title: workspace.title ?? workspace.path ?? workspace.workspaceId, members })
        }
        const stray = rows.filter(row => !seen.has(row.sessionId))
        if (stray.length > 0) out.push({ key: UNGROUPED_KEY, title: t('order.ungrouped'), members: stray })
        return out
      }, [rows, workspaces])

      if (rows.length === 0) {
        return h('div', { className: 'dsm-page' },
          h('h2', { className: 'dsm-page-title' }, t('order.title')),
          h('div', { className: 'dsm-empty' }, t('order.empty')))
      }

      return h('div', { className: 'dsm-page' },
        h('h2', { className: 'dsm-page-title' }, t('order.title')),
        h('p', { className: 'dsm-page-intro' }, t('order.intro')),
        groups.map(group => {
          const setting = orderFor(group.key)
          const sorted = sortRows(group.members, setting)
          return h('div', { key: group.key || '__ungrouped__', className: 'dsm-order-group' },
            h('div', { className: 'dsm-order-head' },
              h('span', { className: 'dsm-order-title' }, group.title),
              h('span', { className: 'dsm-count' }, t('order.count', { count: sorted.length })),
              h('span', { className: 'dsm-order-spacer' }),
              h('select', {
                className: 'dsm-select',
                value: setting.mode,
                'aria-label': t('order.modeLabel'),
                onChange: (event) => setOrderFor(group.key, { mode: event.target.value }),
              }, ORDER_MODES.map(mode => h('option', { key: mode.id, value: mode.id }, t(mode.label)))),
              h('button', {
                type: 'button',
                className: 'dsm-btn dsm-btn--tight',
                title: setting.desc ? t('order.descending') : t('order.ascending'),
                'aria-pressed': setting.desc,
                onClick: () => setOrderFor(group.key, { desc: !setting.desc }),
              }, setting.desc ? t('order.descShort') : t('order.ascShort')),
            ),
            h('div', { className: 'dsm-list' }, sorted.map((row, index) => h('div', {
              key: row.sessionId,
              className: 'dsm-order-row',
              role: 'button',
              tabIndex: 0,
              onClick: () => navigate(row.sessionId),
              onKeyDown: (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  navigate(row.sessionId)
                }
              },
            },
            h('span', { className: 'dsm-order-index' }, String(index + 1)),
            h('span', { className: 'dsm-item-main' },
              h('span', { className: 'dsm-item-title' }, row.title || row.sessionId),
              h('span', { className: 'dsm-item-meta' }, orderMeta(row, setting.mode))),
            ))),
          )
        }),
      )
    }

    /**
     * The meta line under one row, showing the value the current mode sorts by.
     * @param row - the row.
     * @param mode - active sort mode.
     * @returns the meta text.
     */
    function orderMeta (row, mode) {
      if (mode === 'name') return formatMeta(row)
      if (mode === 'size') return formatBytes(row.bytes ?? 0)
      const stamp = mode === 'created' ? row.createdAt : row.updatedAt
      if (typeof stamp !== 'number' || stamp <= 0) return row.sessionId
      try {
        return new Date(stamp).toLocaleString()
      } catch {
        return row.sessionId
      }
    }

    // ── Settings: archived-session manager ────────────────────────────────
    /** The archived list arrives through the slot's own workspace hook. */
    function sessionSettingsWithProps (props) {
      const useWorkspaces = props.useWorkspaces
      const archivedIds = useWorkspaces((value) => (
        Array.isArray(value?.archivedSessionIds) ? value.archivedSessionIds : EMPTY
      )) ?? EMPTY
      return h(sessionSettingsBody, { ...props, archivedIds })
    }

    /** Deployments without that hook read the service face directly. */
    function sessionSettingsWithService (props) {
      const archivedIds = useSyncExternalStore(subscribeArchived, archivedIdsNow, archivedIdsNow)
      return h(sessionSettingsBody, { ...props, archivedIds })
    }

    /** Archived Sessions with restore/delete, singly or in batch. */
    function sessionSettingsBody (props) {
      const { archivedIds } = props
      const selected = useStore(selectSettingsSelected)
      const busy = useStore(selectBusy)
      const notice = useNotice('settings')
      const [rows, setRows] = useState(EMPTY)
      const [loading, setLoading] = useState(false)

      const ids = useMemo(() => [...archivedIds], [archivedIds])
      const key = ids.join(',')

      useEffect(() => {
        let cancelled = false
        if (ids.length === 0) {
          setRows(EMPTY)
          setLoading(false)
          return () => { cancelled = true }
        }
        setLoading(true)
        void (async () => {
          try {
            const value = await callHost('describe', { sessionIds: ids })
            if (cancelled) return
            setRows(Array.isArray(value?.sessions) ? value.sessions : EMPTY)
          } catch {
            if (!cancelled) setRows(ids.map((sessionId) => ({ sessionId, title: null, bytes: null, updatedAt: null })))
          } finally {
            if (!cancelled) setLoading(false)
          }
        })()
        return () => { cancelled = true }
      }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

      useEffect(() => {
        const kept = snapshot.settingsSelected.filter((id) => ids.includes(id))
        if (kept.length !== snapshot.settingsSelected.length) setState({ settingsSelected: kept })
      }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

      const allSelected = ids.length > 0 && selected.length === ids.length

      const restore = useCallback(async (targets) => {
        if (targets.length === 0) return
        setState({ busy: true, notice: null })
        try {
          await unarchiveMany(targets)
          setState({
            busy: false,
            notice: { scope: 'settings', kind: 'ok', text: t('settings.restored', { count: targets.length }) },
            settingsSelected: snapshot.settingsSelected.filter((id) => !targets.includes(id)),
          })
        } catch (error) {
          setState({
            busy: false,
            notice: { scope: 'settings', kind: 'error', text: String(error?.message ?? error) },
          })
        }
      }, [])

      return h('div', { className: 'dsm-page' },
        h('h2', { className: 'dsm-page-title' }, t('settings.title')),
        h('p', { className: 'dsm-page-intro' }, t('settings.intro')),
        h('div', { className: 'dsm-section-head' },
          h('div', { className: 'dsm-section-title' },
            t('settings.archived'),
            h('span', { className: 'dsm-count' }, t('settings.count', { count: ids.length }))),
          h('div', { className: 'dsm-section-actions' },
            h('button', {
              type: 'button',
              className: 'dsm-btn dsm-btn--ghost',
              disabled: ids.length === 0 || busy,
              onClick: () => setState({ settingsSelected: allSelected ? EMPTY : ids }),
            }, allSelected ? t('settings.clear') : t('settings.selectAll')),
            h('button', {
              type: 'button',
              className: 'dsm-btn',
              disabled: busy || selected.length === 0,
              onClick: () => { void restore([...selected]) },
            }, t('settings.batchRestore')),
            h('button', {
              type: 'button',
              className: 'dsm-btn dsm-btn--danger',
              disabled: busy || selected.length === 0,
              onClick: () => {
                void runDelete([...selected], () => setState({ settingsSelected: EMPTY }), 'settings')
              },
            }, t('settings.batchDelete')),
          ),
        ),
        notice === null ? null : h('div', {
          className: `dsm-notice dsm-notice--${notice.kind}`, role: 'status',
        }, notice.text),
        ids.length === 0
          ? h('div', { className: 'dsm-empty' }, t('settings.empty'))
          : h('div', { className: 'dsm-list' }, rows.map((row) => {
            const on = selected.includes(row.sessionId)
            return h('div', {
              key: row.sessionId,
              className: `dsm-item${on ? ' dsm-item--on' : ''}`,
              onClick: () => toggleSettingsSelected(row.sessionId),
              role: 'checkbox',
              'aria-checked': on,
              tabIndex: 0,
              onKeyDown: (event) => {
                if (event.key === ' ' || event.key === 'Enter') {
                  event.preventDefault()
                  toggleSettingsSelected(row.sessionId)
                }
              },
            },
            h('span', { className: `dsm-check${on ? ' dsm-check--on' : ''}`, 'aria-hidden': true },
              on ? icon(ICON_CHECK, 11, { strokeWidth: 3 }) : null),
            h('span', { className: 'dsm-item-main' },
              h('span', { className: 'dsm-item-title' }, row.title || row.sessionId),
              h('span', { className: 'dsm-item-meta' }, formatMeta(row))),
            h('span', { className: 'dsm-item-actions' },
              h('button', {
                type: 'button',
                className: 'dsm-btn dsm-btn--ghost',
                disabled: busy,
                onClick: (event) => {
                  event.stopPropagation()
                  void restore([row.sessionId])
                },
              }, icon(ICON_RESTORE, 12, { strokeWidth: 2 }), h('span', null, t('settings.restore'))),
              h('button', {
                type: 'button',
                className: 'dsm-btn dsm-btn--ghost dsm-btn--danger-text',
                disabled: busy,
                onClick: (event) => {
                  event.stopPropagation()
                  void runDelete([row.sessionId], () => setState({
                    settingsSelected: snapshot.settingsSelected.filter((id) => id !== row.sessionId),
                  }), 'settings')
                },
              }, icon(ICON_TRASH, 12, { strokeWidth: 2 }), h('span', null, t('settings.delete'))),
            ),
            )
          })),
        loading ? h('div', { className: 'dsm-hint' }, t('settings.loading')) : null,
      )
    }

    /**
     * Size and date for one archived row.
     * @param row - a `describe` row.
     * @returns the meta line.
     */
    function formatMeta (row) {
      const parts = []
      if (typeof row.bytes === 'number' && row.bytes > 0) parts.push(formatBytes(row.bytes))
      if (typeof row.updatedAt === 'number' && row.updatedAt > 0) {
        try {
          parts.push(new Date(row.updatedAt).toLocaleString())
        } catch {
          // A locale without date support simply omits the timestamp.
        }
      }
      if (parts.length === 0) parts.push(row.sessionId)
      return parts.join(' · ')
    }

    /** Human-readable byte count. */
    function formatBytes (bytes) {
      const units = ['B', 'KB', 'MB', 'GB']
      let value = bytes
      let unit = 0
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
      }
      return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
    }

    // ── Styles ─────────────────────────────────────────────────────────────
    const CSS = `
.dsm-lead{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:3px;background:transparent;color:#fff;cursor:pointer;flex:none}
.dsm-lead:hover{border-color:var(--dsw-alias-brand-primary)}
.dsm-lead--on{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary)}
.dsm-foot{display:flex;flex-direction:column;gap:5px;min-width:0;flex:1 1 auto}
.dsm-foot-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
.dsm-foot-count{font-size:11px;line-height:14px;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none;margin-left:auto}
.dsm-foot-row{display:flex;align-items:center;gap:5px;min-width:0}
.dsm-all{display:inline-flex;align-items:center;gap:6px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:16px;cursor:pointer;min-width:0}
.dsm-all:hover:not(:disabled){color:var(--dsw-alias-label-primary);text-decoration:underline}
.dsm-all:disabled{opacity:.5;cursor:default}
.dsm-all .dsm-check{margin:0}
.dsm-btn--tight{padding:3px 8px;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.dsm-link{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;padding:0}
.dsm-link:hover:not(:disabled){color:var(--dsw-alias-label-primary);text-decoration:underline}
.dsm-link:disabled{opacity:.5;cursor:default}
.dsm-hint{font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary)}
.dsm-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap}
.dsm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}
.dsm-btn:disabled{opacity:.45;cursor:default}
.dsm-btn--ghost{background:transparent;border-color:transparent}
.dsm-btn--danger{background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);color:#fff}
.dsm-btn--danger:hover:not(:disabled){background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);filter:brightness(1.08)}
.dsm-btn--danger-text{color:var(--dsw-alias-state-error-primary)}
.dsm-notice{font-size:12px;line-height:16px;padding:6px 8px;border-radius:var(--dsw-radius-sm,6px);word-break:break-word}
.dsm-notice--ok{color:var(--dsw-alias-state-success-primary)}
.dsm-notice--error{color:var(--dsw-alias-state-error-primary)}
.dsm-scrim{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);padding:24px}
.dsm-modal{width:min(420px,100%);display:flex;flex-direction:column;gap:12px;padding:18px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 18px 48px rgba(0,0,0,.35)}
.dsm-modal-title{font-size:15px;font-weight:600;line-height:22px}
.dsm-modal-body{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dsm-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
.dsm-page{display:flex;flex-direction:column;gap:14px;padding:4px 2px;color:var(--dsw-alias-label-primary)}
.dsm-page-title{margin:0;font-size:16px;font-weight:600;line-height:24px}
.dsm-page-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dsm-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1)}
.dsm-section-title{display:flex;align-items:baseline;gap:8px;font-size:13px;font-weight:600}
.dsm-count{font-size:12px;font-weight:400;color:var(--dsw-alias-label-secondary)}
.dsm-section-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dsm-list{display:flex;flex-direction:column;gap:2px}
.dsm-item{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid transparent;border-radius:var(--dsw-radius-md,8px);cursor:pointer}
.dsm-item:hover{background:var(--dsw-alias-bg-layer-2)}
.dsm-item--on{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}
.dsm-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsm-check{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;color:var(--dsw-alias-bg-base)}
.dsm-check--on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dsm-item-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto}
.dsm-item-title{font-size:13px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsm-item-meta{font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsm-item-actions{display:flex;align-items:center;gap:2px;flex:none}
.dsm-empty{font-size:13px;color:var(--dsw-alias-label-secondary);padding:18px 4px}
.dsm-order-group{display:flex;flex-direction:column;gap:6px;padding:10px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.dsm-order-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsm-order-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsm-order-spacer{flex:1 1 auto}
.dsm-select{font:inherit;font-size:12px;line-height:18px;padding:3px 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer}
.dsm-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsm-order-row{display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:var(--dsw-radius-md,8px);cursor:pointer}
.dsm-order-row:hover{background:var(--dsw-alias-bg-layer-2)}
.dsm-order-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsm-order-index{flex:none;width:20px;text-align:right;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
`

    /** One style tag for the whole plugin, removed with the client run. */
    function mountStyles () {
      if (typeof document === 'undefined') return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-better-session'
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }

    // ── Client entry ───────────────────────────────────────────────────────
    return {
      inject: ['slots', 'locale'],
      apply (ctx) {
        rootCtx = ctx
        ctx.effect(() => {
          const disposers = [
            ctx.locale.register(NS, 'zh', zh),
            ctx.locale.register(NS, 'en', en),
          ]
          return () => { for (const dispose of disposers) dispose() }
        }, 'dsh-better-session: dictionaries')

        const bound = ctx.locale.bind(NS)
        translate = (key) => bound(key)
        // Re-render mounted surfaces when the active locale changes.
        ctx.effect(() => ctx.locale.subscribe(() => setState({ revision: snapshot.revision + 1 })), 'dsh-better-session: locale')

        ctx.effect(mountStyles, 'dsh-better-session: styles')

        // Escape leaves batch mode. Registered on the document so it works
        // wherever focus happens to sit (row toggle, hover button, body).
        ctx.effect(() => {
          document.addEventListener('keydown', onBatchEscape)
          return () => document.removeEventListener('keydown', onBatchEscape)
        }, 'dsh-better-session: batch escape')

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => {
          // The menu rows come from the menu registry (see registerMenuActions);
          // this injection exists only to own their lifetime beside the slot.
          return registerMenuActions(ctx)
        })

        ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({
          name: 'sidebar.session.row.leading',
          id: 'better-session-lead',
          order: 5,
          locale: NS,
        }, rowSelectLeading))

        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'better-session-batch',
          order: 10,
          locale: NS,
        }, footerBatchBar))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'better-session-confirm',
          order: 900,
          locale: NS,
        }, confirmOverlay))

        // The icon registration id must equal the section id, or the shell
        // never renders it and keeps its default gear.
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon',
          id: 'better-session',
          order: 45,
          locale: NS,
        }, SessionSettingsIcon))

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'better-session',
          order: 45,
          label: () => t('settings.label'),
          locale: NS,
        }, (props) => (
          typeof props.useWorkspaces === 'function'
            ? h(sessionSettingsWithProps, props)
            : h(sessionSettingsWithService, props)
        )))

        // The ordering page: a `main` panel registered under this plugin's key,
        // opened from the sidebar panel list by the shell.
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'better-session-order',
          locale: NS,
        }, sortPanel))

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'better-session-order',
          order: 40,
          label: () => t('order.label'),
          locale: NS,
        }, (props) => icon(ICON_SORT, typeof props?.size === 'number' ? props.size : 16)))
      },
    }
  },
})
