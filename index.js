/**
 * dsh-better-session — Host half.
 *
 * The sidebar/settings UI can archive a Session through the Client
 * `workspaces` service, but nothing in the shipped surface deletes a Session
 * log. This plugin owns that one destructive operation and the reads that
 * describe a Session for the management lists:
 *
 * - `describe` — title, on-disk size and last-write time for a set of
 *   Sessions, read through `sessionQuery` / `sessionPersistence` without
 *   resuming an Agent.
 * - `delete` — permanent removal of the stored log (never the recycle bin),
 *   after dropping the Session from the archive/pin sets and its Workspace
 *   accounting.
 *
 * Everything is exposed over one fenced POST route so the Client half never
 * needs filesystem access. A live Agent refuses deletion: its Session is
 * still owned by the runtime, and removing the log underneath it would make
 * the running conversation unrecoverable.
 */
import { readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, sep } from 'node:path'

/** Route the Client half posts to. */
const API_PATH = '/session-mgr/api'

/** Session ids are `session-<uuid>`; anything else is refused before it can
 *  reach a path join. */
const SESSION_ID = /^session-[A-Za-z0-9-]+$/

/** How much JSON body one call may carry. */
const BODY_LIMIT = 1 << 20

/**
 * The DSH home directory that owns `sessions/` and `storages/`.
 * @returns the absolute home path.
 */
function resolveHome () {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/**
 * Whether `path` lies inside `root` (and is not `root` itself).
 * @param root - containing directory.
 * @param path - candidate path.
 * @returns true when the candidate is strictly contained.
 */
function isInside (root, path) {
  const rel = relative(root, path)
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)
}

/**
 * Session directories on disk: `<home>/sessions/<encoded workspace>/<id>`.
 * The workspace directory name is an encoding of the Session cwd, so the
 * listing is what turns an id into a path.
 * @param root - `<home>/sessions`.
 * @param id - the Session id.
 * @returns every existing directory whose name is exactly `id`.
 */
async function scanSessionDirs (root, id) {
  const found = []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = join(root, entry.name, id)
    try {
      const info = await stat(candidate)
      if (info.isDirectory() && basename(candidate) === id && isInside(root, candidate)) found.push(candidate)
    } catch {
      // Not every workspace directory owns this Session.
    }
  }
  return found
}

/**
 * Everything the plugin will remove for one Session, plus the facts the UI
 * shows: the stored log directory, its projection-cache checkpoint, size, and
 * last-write time.
 * @param home - DSH home directory.
 * @param id - the Session id.
 * @returns `{ id, dirs, cacheFile, bytes, updatedAt }`.
 */
async function locateSession (home, id) {
  const sessionsRoot = join(home, 'sessions')
  const dirs = await scanSessionDirs(sessionsRoot, id)
  const cacheFile = join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`)
  let bytes = null
  let updatedAt = null
  for (const dir of dirs) {
    try {
      const inner = await readdir(dir)
      for (const name of inner) {
        const file = join(dir, name)
        try {
          const info = await stat(file)
          if (!info.isFile()) continue
          bytes = (bytes ?? 0) + info.size
          updatedAt = Math.max(updatedAt ?? 0, info.mtimeMs)
        } catch {
          // A vanished file contributes nothing.
        }
      }
    } catch {
      // An unreadable directory still counts as a deletion target.
    }
  }
  return { id, dirs, cacheFile, bytes, updatedAt }
}

/**
 * Read the request body as JSON, bounded.
 * @param req - the HTTP request.
 * @returns the parsed body (an empty object for an empty body).
 */
async function readJson (req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > BODY_LIMIT) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Answer one call.
 * @param req - the HTTP request.
 * @param res - the HTTP response.
 */
function writeJson (res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Titles for a set of Sessions, folded from their logs without resuming an
 * Agent.
 * @param ctx - Host plugin context.
 * @param ids - Session ids.
 * @returns a map id → title.
 */
async function readTitles (ctx, ids) {
  const titles = new Map()
  const query = ctx.get('sessionQuery')
  if (query === undefined || ids.length === 0) return titles
  try {
    const results = await query.readTitleSnapshots(ids)
    for (const result of results) {
      if (result.status !== 'fulfilled') continue
      const title = result.value?.title?.title
      if (typeof title === 'string' && title !== '') titles.set(result.sessionId, title)
    }
  } catch {
    // Titles are decoration: an unreadable log still lists by id.
  }
  return titles
}

/**
 * Describe Sessions for the management lists.
 * @param ctx - Host plugin context.
 * @param home - DSH home directory.
 * @param ids - Session ids.
 * @returns one row per id, in input order.
 */
async function describeSessions (ctx, home, ids) {
  const titles = await readTitles(ctx, ids)
  const rows = []
  for (const id of ids) {
    const located = await locateSession(home, id)
    rows.push({
      sessionId: id,
      title: titles.get(id) ?? null,
      bytes: located.bytes,
      updatedAt: located.updatedAt,
      present: located.dirs.length > 0,
    })
  }
  return rows
}

/**
 * Drop a Session from every Workspace accounting slot. Deleting the log is
 * what makes the Session disappear from the list; this keeps the stored
 * registry from carrying a dangling id.
 * @param ctx - Host plugin context.
 * @param id - the Session id.
 */
async function detachFromWorkspaces (ctx, id) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return
  for (const workspace of registry.list()) {
    if (!workspace.sessionIds.includes(id)) continue
    try {
      await workspace.detachSession(id)
    } catch {
      // Accounting is best-effort; the log removal already hides the Session.
    }
  }
}

/**
 * Tell the browser surface that a Session is gone. The sidebar list follows
 * the Session feed rather than the filesystem, so removing the log alone
 * leaves the row on screen until the list happens to refetch.
 * @param ctx - Host plugin context.
 * @param id - the removed Session id.
 */
function announceRemoval (ctx, id) {
  try {
    ctx.emit('api-session/removed', id)
  } catch {
    // A profile without the Session controller has no feed to update.
  }
}

/**
 * Permanently delete one Session.
 * @param ctx - Host plugin context.
 * @param home - DSH home directory.
 * @param id - the Session id.
 * @returns `{ sessionId, deleted: true, bytes }`.
 */
async function deleteSession (ctx, home, id) {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) {
    return { sessionId: String(id), deleted: false, code: 'bad-id', message: 'not a Session id' }
  }
  // A live Agent still owns this Session: its conversation would break.
  const agents = ctx.get('agents')
  if (agents !== undefined && agents.get(id) !== undefined) {
    return { sessionId: id, deleted: false, code: 'session-live', message: 'session is open in this process' }
  }

  const registry = ctx.get('workspaceRegistry')
  if (registry !== undefined) {
    try {
      await registry.unarchiveSession(id)
    } catch {
      // Already unarchived.
    }
    try {
      await registry.unpinSession(id)
    } catch {
      // Already unpinned.
    }
  }
  await detachFromWorkspaces(ctx, id)

  const located = await locateSession(home, id)
  const targets = [...located.dirs, located.cacheFile]
  for (const target of targets) {
    try {
      await rm(target, { recursive: true, force: true })
    } catch (error) {
      return {
        sessionId: id,
        deleted: false,
        code: 'delete-failed',
        message: `${basename(target)}: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }
  announceRemoval(ctx, id)
  return { sessionId: id, deleted: true, bytes: located.bytes, removed: targets.length }
}

/** Hard dependencies: the route carrier, and the Session registry reads. */
export const inject = ['webServer']

/**
 * Host half: mount the fenced API route.
 * @param ctx - Host plugin context.
 */
export function apply (ctx) {
  const home = resolveHome()
  const fence = (req) => {
    const connection = ctx.get('connection')
    if (connection === undefined) return true
    try {
      return connection.requestRejection(req) === undefined
    } catch {
      return false
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: API_PATH,
    handler: async (req, res) => {
      if (!fence(req)) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method', message: 'POST only' } })
        return
      }
      let payload
      try {
        payload = await readJson(req)
      } catch (error) {
        writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: String(error?.message ?? error) } })
        return
      }
      const method = payload?.method
      try {
        if (method === 'health') {
          writeJson(res, 200, { ok: true, value: { home } })
          return
        }
        if (method === 'describe') {
          const ids = Array.isArray(payload.sessionIds) ? payload.sessionIds.filter(id => typeof id === 'string').slice(0, 500) : []
          writeJson(res, 200, { ok: true, value: { sessions: await describeSessions(ctx, home, ids) } })
          return
        }
        if (method === 'delete') {
          const ids = Array.isArray(payload.sessionIds) ? payload.sessionIds.filter(id => typeof id === 'string').slice(0, 500) : []
          if (payload.confirm !== true) {
            writeJson(res, 400, { ok: false, error: { code: 'unconfirmed', message: 'confirm:true is required' } })
            return
          }
          const results = []
          for (const id of ids) results.push(await deleteSession(ctx, home, id))
          writeJson(res, 200, { ok: true, value: { results } })
          return
        }
        writeJson(res, 404, { ok: false, error: { code: 'unknown-method', message: String(method) } })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } })
      }
    },
  }), 'dsh-better-session: session management API')
}
