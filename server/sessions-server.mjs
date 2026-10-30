#!/usr/bin/env node
// Serves the session manager page on 127.0.0.1. The page reads the list of sessions here, asks for the preview of a change,
// and sends it back with the preview's code to have it done. Node standard library only.
//   node sessions-server.mjs --page <index.html> [--claude-dir <folder>]
import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { claudeDirOf, listSessions, orphansOf } from '../lib/sessions.mjs'
import { confirm, defaultContext, describePlan, makePlan } from '../lib/plan.mjs'

const IDLE_MS = 30 * 60 * 1000
const MAX_BODY = 64 * 1024
const KINDS = new Set(['delete', 'prune', 'delete-project', 'move', 'move-project'])
const ID = /^[0-9a-f-]{8,64}$/i

const sanitize = s => ({ id: s.id, project: s.project, folder: s.folder, folderState: s.folderState, title: s.title, branch: s.branch, lastActivity: s.lastActivity, bytes: s.bytes, inUse: s.inUse })

/** The request the page sent, checked: only the kinds we know, ids that look like ids, two paths at most. Anything else is refused. */
export function parseRequest(value) {
  if (!value || typeof value !== 'object' || !KINDS.has(value.kind)) return undefined
  const request = { kind: value.kind }
  if (value.ids !== undefined) {
    if (!Array.isArray(value.ids) || value.ids.length > 500 || !value.ids.every(i => typeof i === 'string' && ID.test(i))) return undefined
    request.ids = value.ids
  }
  for (const key of ['to', 'from']) {
    if (value[key] === undefined) continue
    if (typeof value[key] !== 'string' || value[key].length > 1000 || value[key].includes('\0')) return undefined
    request[key] = value[key]
  }
  if ((request.kind === 'delete' || request.kind === 'move') && !request.ids?.length) return undefined
  if ((request.kind === 'move' || request.kind === 'move-project') && !request.to) return undefined
  if (request.kind === 'delete-project' && !request.from) return undefined
  if (request.kind === 'move-project' && !request.from) return undefined
  return request
}

/** A terminal in the folder of a session with `claude --resume`: Windows only, and only for a folder with nothing a command line could misread. */
export function openInTerminal(session, platform = process.platform, run = execFile) {
  const command = `cd "${session.folder}" && claude --resume ${session.id}`
  if (platform !== 'win32') return Promise.resolve({ ok: false, command, message: 'Opening a terminal is only done on Windows: the command is copied instead.' })
  if (!session.folder || /[&|<>^%"!;`]/.test(session.folder) || !ID.test(session.id)) return Promise.resolve({ ok: false, command, message: 'The folder has characters a command line could misread: the command is copied instead.' })
  return stat(session.folder).then(
    info => {
      if (!info.isDirectory()) return { ok: false, command, message: 'The folder of this session is gone: move it first, or copy the command.' }
      return new Promise(resolve => run('cmd', ['/c', 'start', '', '/D', session.folder, 'cmd', '/k', 'claude', '--resume', session.id], { windowsHide: false }, error => resolve(error ? { ok: false, command, message: error.message } : { ok: true })))
    },
    () => ({ ok: false, command, message: 'The folder of this session is gone: move it first, or copy the command.' }),
  )
}

export function start({ page, ctx = defaultContext(), log = line => process.stdout.write(line + '\n'), idleMs = IDLE_MS, terminal = openInTerminal } = {}) {
  const token = randomBytes(18).toString('base64url')
  let idle
  let busy = false
  const touch = () => {
    clearTimeout(idle)
    idle = setTimeout(() => server.close(() => process.exit(0)), idleMs)
    idle.unref?.()
  }

  const server = createServer(async (req, res) => {
    const port = server.address().port
    const origin = `http://127.0.0.1:${port}`
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' })
      res.end(body)
    }
    // Another site in the browser, or a DNS-rebinding name, never gets in: exact host, secret path, same origin for writes.
    if (req.headers.host !== `127.0.0.1:${port}`) return send(403, '{"error":"host"}')
    const url = new URL(req.url ?? '/', origin)
    const prefix = `/${token}/`
    if (!url.pathname.startsWith(prefix)) return send(404, '{"error":"not found"}')
    const route = url.pathname.slice(prefix.length)
    touch()
    try {
      if (req.method === 'GET' && route === '') {
        res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
        return send(200, await readFile(page, 'utf8'), 'text/html; charset=utf-8')
      }
      if (req.method === 'GET' && route === 'api/sessions') {
        const sessions = await listSessions(ctx)
        return send(200, JSON.stringify({ sessions: sessions.map(sanitize), orphans: orphansOf(sessions).length, platform: ctx.platform, now: Date.now() }))
      }
      if (req.method === 'POST' && route.startsWith('api/')) {
        // Writes: this page only (the Origin of a form on another site is another one), and a header a form cannot send.
        if (req.headers.origin !== origin || req.headers['x-session-manager'] !== '1') return send(403, '{"error":"origin"}')
        let body = ''
        for await (const chunk of req) {
          body += chunk
          if (body.length > MAX_BODY) return send(413, '{"error":"too large"}')
        }
        let data
        try {
          data = JSON.parse(body)
        } catch {
          return send(400, '{"error":"not json"}')
        }
        if (route === 'api/preview') {
          const request = parseRequest(data)
          if (!request) return send(400, '{"error":"not a request"}')
          const plan = await makePlan(request, ctx)
          return send(200, JSON.stringify({ kind: plan.kind, ok: plan.ok, error: plan.error ?? '', code: plan.code, bytes: plan.bytes, items: plan.items.map(i => ({ id: i.id, title: i.title, folder: i.folder, toFolder: i.toFolder ?? '', bytes: i.bytes, problems: i.problems })), text: describePlan(plan) }))
        }
        if (route === 'api/apply') {
          const request = parseRequest(data?.request)
          if (!request || typeof data?.code !== 'string') return send(400, '{"error":"not a request"}')
          if (busy) return send(409, '{"error":"another change is running"}')
          busy = true
          try {
            const result = await confirm(request, data.code, ctx)
            log(`APPLIED ${request.kind} ${result.ok ? 'ok' : 'failed'}`)
            return send(200, JSON.stringify(result))
          } finally {
            busy = false
          }
        }
        if (route === 'api/open') {
          if (typeof data?.id !== 'string' || !ID.test(data.id)) return send(400, '{"error":"not an id"}')
          const session = (await listSessions(ctx)).find(s => s.id === data.id)
          if (!session) return send(404, '{"error":"no such session"}')
          return send(200, JSON.stringify(await terminal(session, ctx.platform)))
        }
      }
      return send(404, '{"error":"not found"}')
    } catch (error) {
      return send(500, JSON.stringify({ error: String(error?.message ?? error) }))
    }
  })

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}/${token}/`
      log(`READY ${url}`)
      touch()
      resolve({ server, url })
    })
  })
}

const arg = name => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const page = arg('--page')
  if (!page) {
    console.error('usage: sessions-server.mjs --page <index.html> [--claude-dir <folder>]')
    process.exit(2)
  }
  const ctx = defaultContext()
  const dir = arg('--claude-dir')
  start({ page, ctx: dir ? { ...ctx, claudeDir: dir } : { ...ctx, claudeDir: claudeDirOf() } })
}
