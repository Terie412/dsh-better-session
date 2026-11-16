/** Live-only, Host-wide completion feed. No session content crosses this route. */
const PATH = '/better-session/completions'
const MAX_CLIENTS = 16
const HEARTBEAT_MS = 30_000
const MAX_BUFFER_BYTES = 64 * 1024

/**
 * Install an authenticated SSE feed, owned entirely by the plugin effect.
 * `fence` must return exactly true after Connection request admission succeeds.
 * @param {object} ctx Host Cordis context.
 * @param {(req: object) => boolean} fence Authenticated Host/Origin fence.
 */
export function installCompletionFeed (ctx, fence) {
  ctx.effect(() => {
    const clients = new Set()
    const turns = new WeakMap()
    let disposed = false
    let heartbeat

    const stopHeartbeat = () => {
      if (heartbeat !== undefined) clearInterval(heartbeat)
      heartbeat = undefined
    }
    const close = (client, destroy = false) => {
      if (!clients.delete(client)) return
      client.res.off('close', client.onClose)
      client.res.off('error', client.onError)
      client.req.off('aborted', client.onClose)
      try {
        if (destroy) client.res.destroy()
        else client.res.end()
      } catch { client.res.destroy?.() }
      if (clients.size === 0) stopHeartbeat()
    }
    const send = (client, frame) => {
      try {
        if (client.res.destroyed || client.res.writableEnded ||
            client.res.writableLength > MAX_BUFFER_BYTES || !client.res.write(frame)) {
          close(client, true)
        }
      } catch { close(client, true) }
    }
    const readGoal = (session) => {
      const goals = ctx.get('goals')
      if (goals === undefined) return undefined
      const agent = ctx.get('agents')?.get(session.id)
      // Never treat an unavailable/invalid goal read as ordinary completion.
      if (agent === undefined || agent.session !== session) throw new Error('live agent unavailable')
      return goals.get(agent)
    }
    const stopEvents = ctx.on('session/event', (session, event) => {
      if (disposed || session.header.origin === 'subagent') return
      if (event.type === 'turn/start') {
        let goal
        let unreadable = false
        try { goal = readGoal(session) } catch { unreadable = true }
        turns.set(session, {
          turn: event.data.turn,
          unfinishedGoalId: goal !== undefined && goal.phase !== 'complete' ? goal.id : undefined,
          completedGoalId: undefined,
          unreadable,
        })
        return
      }
      const turn = turns.get(session)
      if (turn === undefined) return
      if (event.type === 'goal/change') {
        const change = event.data
        if (change.operation === 'create' && change.goal?.phase !== 'complete') {
          turn.unfinishedGoalId = change.goal?.id
        }
        if (change.operation === 'complete' && change.goal?.phase === 'complete') {
          turn.completedGoalId = change.goal.id
        }
        return
      }
      if (event.type !== 'turn/end' || event.data.turn !== turn.turn) return
      turns.delete(session)
      if (event.data.reason.kind !== 'completed' || turn.unreadable) return
      let goal
      try { goal = readGoal(session) } catch { return }
      if (goal !== undefined && goal.phase !== 'complete') return
      const goalCompleted = goal !== undefined && goal.phase === 'complete' &&
        (turn.completedGoalId === goal.id || turn.unfinishedGoalId === goal.id)
      // Clearing/replacing a goal is not evidence that its objective succeeded.
      if (turn.unfinishedGoalId !== undefined && !goalCompleted) return
      const value = {
        id: `${session.id}:${turn.turn}`,
        sessionId: session.id,
        kind: goalCompleted ? 'goal' : 'turn',
      }
      const frame = `data: ${JSON.stringify(value)}\n\n`
      for (const client of clients) send(client, frame)
    })
    let stopRoute
    try {
      stopRoute = ctx.get('webServer').register({
        kind: 'exact',
        path: PATH,
        handler: (req, res) => {
          let admitted = false
          try { admitted = typeof fence === 'function' && fence(req) === true } catch {}
          if (!admitted) { res.writeHead(403); res.end(); return }
          if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return }
          if (disposed || clients.size >= MAX_CLIENTS) {
            res.writeHead(503, { 'retry-after': '30' }); res.end(); return
          }
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store, no-transform',
            'x-accel-buffering': 'no',
          })
          const client = { req, res }
          client.onClose = () => close(client)
          client.onError = () => close(client)
          clients.add(client)
          res.on('close', client.onClose)
          res.on('error', client.onError)
          req.on('aborted', client.onClose)
          // A comment opens the response but cannot replay a past completion.
          send(client, ': connected\n\n')
          if (clients.size > 0 && heartbeat === undefined) {
            heartbeat = setInterval(() => {
              for (const client of clients) send(client, ': heartbeat\n\n')
            }, HEARTBEAT_MS)
            heartbeat.unref?.()
          }
        },
      })
    } catch (error) {
      stopEvents()
      throw error
    }
    return () => {
      disposed = true
      stopEvents()
      stopRoute()
      stopHeartbeat()
      for (const client of clients) close(client)
    }
  }, 'dsh-better-session: live completion feed')
}
