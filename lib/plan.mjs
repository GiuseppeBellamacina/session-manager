// What changes files here, in two steps. `makePlan` only reads: it says what would be moved or sent to the trash, and gives
// that plan a code. `confirm` makes the plan again from what is on disk now and goes on only if its code is the one the
// person saw: whatever changed in between (a session grew, a folder came back) means a new preview. Nothing is deleted for
// good: originals go to the system's trash, and a move writes the new copy and checks it before it touches the old one.
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { isInside, normalizePath, replacePrefix, samePlace, slugOf } from './paths.mjs'
import { copySide, countRows, rewriteTranscript } from './rewrite.mjs'
import { claudeDirOf, exists, findSession, listSessions, orphansOf } from './sessions.mjs'
import { sendToTrash } from './trash.mjs'

export const defaultContext = () => ({ claudeDir: claudeDirOf(), platform: process.platform, trash: paths => sendToTrash(paths) })

const isFolder = path => stat(path).then(s => s.isDirectory(), () => false)

const absolute = (path, platform) => (platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path) : isAbsolute(path))

const sizeSignature = async file => {
  const s = await stat(file).catch(() => undefined)
  return s ? `${s.size}:${Math.round(s.mtimeMs)}` : 'gone'
}

/** The sessions a request names, whole ids or the start of one; an id that fits nothing, or several, stops the plan. */
function select(request, sessions, platform) {
  if (request.kind === 'prune') return { chosen: orphansOf(sessions) }
  if (request.kind === 'move-project') {
    const from = normalizePath(request.from ?? '', platform)
    if (!from) return { error: 'Say which folder the project was in.' }
    return { chosen: sessions.filter(s => s.folder && isInside(s.folder, from, platform)) }
  }
  const chosen = []
  for (const id of request.ids ?? []) {
    const found = findSession(sessions, id)
    if (found.error) return { error: found.error }
    if (!chosen.includes(found.session)) chosen.push(found.session)
  }
  return { chosen }
}

const base = (s, extra) => ({ id: s.id, title: s.title, folder: s.folder, project: s.project, bytes: s.bytes, inUse: s.inUse, problems: s.inUse ? ['it is open in a running Claude Code session'] : [], ...extra })

/** The preview of a request: `{ kind, items, bytes, ok, error?, code }`. Nothing is written. */
export async function makePlan(request, ctx = defaultContext()) {
  const { claudeDir, platform } = ctx
  const sessions = await listSessions(ctx)
  const picked = select(request, sessions, platform)
  if (picked.error) return { kind: request.kind, request, items: [], bytes: 0, ok: false, error: picked.error, code: '' }
  if (picked.chosen.length === 0) return { kind: request.kind, request, items: [], bytes: 0, ok: false, error: request.kind === 'prune' ? 'There is no orphan session.' : 'No session matches.', code: '' }

  const items = []
  if (request.kind === 'delete' || request.kind === 'prune') {
    for (const s of picked.chosen) {
      const history = [s.file, s.sideDir, join(claudeDir, 'file-history', s.id), join(claudeDir, 'session-env', s.id)]
      const paths = []
      for (const p of history) if (p && (await exists(p))) paths.push(p)
      items.push(base(s, { paths, signature: await sizeSignature(s.file) }))
    }
  } else {
    const to = normalizePath(request.to ?? '', platform)
    const rootProblems = []
    if (!to || !absolute(to, platform)) rootProblems.push('give the full path of the new folder')
    else if (!(await isFolder(to))) rootProblems.push(`the new folder does not exist: ${to}`)
    for (const s of picked.chosen) {
      const problems = [...rootProblems]
      const fromFolder = request.kind === 'move-project' ? normalizePath(request.from, platform) : s.folder
      const toFolder = request.kind === 'move-project' ? replacePrefix(s.folder, fromFolder, to, platform) : to
      const toProjectDir = join(claudeDir, 'projects', slugOf(toFolder || 'none'))
      const toFile = join(toProjectDir, `${s.id}.jsonl`)
      if (!s.folder) problems.push('it has no folder recorded, so its rows cannot be moved')
      if (samePlace(toProjectDir, join(claudeDir, 'projects', s.project), platform)) problems.push('it is already in that folder')
      else if (await exists(toFile)) problems.push('a session with this id is already in the new folder')
      items.push(
        base(s, {
          fromFolder: s.folder,
          rewriteFrom: fromFolder,
          rewriteTo: to,
          toFolder,
          toProjectDir,
          fromFile: s.file,
          fromSide: s.sideDir,
          signature: await sizeSignature(s.file),
          problems: [...(s.inUse ? ['it is open in a running Claude Code session'] : []), ...problems],
        }),
      )
    }
  }
  const bytes = items.reduce((n, i) => n + i.bytes, 0)
  const ok = items.every(i => i.problems.length === 0)
  const basis = JSON.stringify([request.kind, request.to ?? '', request.from ?? '', items.map(i => [i.id, i.signature, i.paths ?? i.toFolder, i.problems])])
  return { kind: request.kind, request, items, bytes, ok, code: createHash('sha256').update(basis).digest('hex').slice(0, 10) }
}

/** What `/sessions` and the page show the person before they confirm. */
export function describePlan(plan) {
  if (plan.error) return plan.error
  const verb = plan.kind === 'move' || plan.kind === 'move-project' ? 'move' : 'send to the trash'
  const lines = [`${plan.items.length} session${plan.items.length === 1 ? '' : 's'} to ${verb} (${(plan.bytes / 1e6).toFixed(1)} MB):`]
  for (const i of plan.items) {
    const where = plan.kind === 'move' || plan.kind === 'move-project' ? `  ${i.folder || '(no folder)'} -> ${i.toFolder}` : `  ${i.folder || '(no folder)'}`
    lines.push(`- ${i.id.slice(0, 8)}  ${(i.bytes / 1e6).toFixed(1)} MB  ${i.title || '(no title)'}`, where)
    for (const p of i.problems) lines.push(`    cannot: ${p}`)
  }
  return lines.join('\n')
}

/** The prompt history rows of a session follow it to its new folder. `between` lets a test act while the file is half done. */
export const rewriteHistory = async (claudeDir, id, from, to, platform, between = async () => undefined) => {
  const file = join(claudeDir, 'history.jsonl')
  const before = await stat(file).catch(() => undefined)
  if (!before) return 'none'
  const lines = (await readFile(file, 'utf8')).split('\n')
  let changed = 0
  const out = lines.map(line => {
    if (!line.includes(id)) return line
    try {
      const row = JSON.parse(line)
      if (row.sessionId !== id || typeof row.project !== 'string' || !isInside(row.project, from, platform)) return line
      const moved = replacePrefix(row.project, from, to, platform)
      const pair = `"project":${JSON.stringify(row.project)}`
      changed++
      return line.includes(pair) ? line.replace(pair, () => `"project":${JSON.stringify(moved)}`) : JSON.stringify({ ...row, project: moved })
    } catch {
      return line
    }
  })
  if (changed === 0) return 'none'
  const temp = `${file}.session-manager`
  await writeFile(temp, out.join('\n'))
  await between()
  // Claude Code appends to this file as it runs: if it grew while it was read, the old one is left and the person told.
  const after = await stat(file).catch(() => undefined)
  if (!after || after.size !== before.size || Math.round(after.mtimeMs) !== Math.round(before.mtimeMs)) {
    await rm(temp, { force: true })
    return 'skipped'
  }
  await rename(temp, file)
  return 'updated'
}

async function moveOne(item, ctx) {
  const created = []
  let committed = false
  try {
    await mkdir(item.toProjectDir, { recursive: true })
    const toFile = join(item.toProjectDir, `${item.id}.jsonl`)
    const partial = `${toFile}.partial`
    created.push(partial)
    const { rows, changed } = await rewriteTranscript(item.fromFile, partial, item.rewriteFrom, item.rewriteTo, ctx.platform)
    if ((await countRows(partial)) !== rows || rows !== (await countRows(item.fromFile))) throw new Error('the new transcript does not have the rows of the old one')
    await rename(partial, toFile)
    created.splice(0, 1, toFile)
    if (item.fromSide) {
      const toSide = join(item.toProjectDir, item.id)
      created.push(toSide)
      await copySide(item.fromSide, toSide, item.rewriteFrom, item.rewriteTo, ctx.platform)
    }
    const history = await rewriteHistory(ctx.claudeDir, item.id, item.rewriteFrom, item.rewriteTo, ctx.platform).catch(() => 'skipped')
    // The copy is whole and checked: from here the originals go, and what was made is no longer undone.
    committed = true
    await ctx.trash([item.fromFile, ...(item.fromSide ? [item.fromSide] : [])])
    return { id: item.id, ok: true, rows, changed, history }
  } catch (error) {
    if (committed) return { id: item.id, ok: false, partial: true, message: `moved, but the old copy could not be sent to the trash (${error.message}). The session is now in both places.` }
    for (const path of created.reverse()) await rm(path, { recursive: true, force: true }).catch(() => undefined)
    return { id: item.id, ok: false, message: String(error.message) }
  }
}

/** Does what a plan says, one session after the other, and stops at the first that fails. */
export async function applyPlan(plan, ctx = defaultContext()) {
  const results = []
  for (const item of plan.items) {
    const result =
      plan.kind === 'move' || plan.kind === 'move-project'
        ? await moveOne(item, ctx)
        : await ctx.trash(item.paths).then(
            () => ({ id: item.id, ok: true }),
            error => ({ id: item.id, ok: false, message: String(error.message) }),
          )
    results.push(result)
    if (!result.ok) break
  }
  return { ok: results.length === plan.items.length && results.every(r => r.ok), results }
}

/** The step after the preview: the plan is made again, and goes ahead only if it is the one the person confirmed. */
export async function confirm(request, code, ctx = defaultContext()) {
  const plan = await makePlan(request, ctx)
  if (plan.error) return { ok: false, error: plan.error, results: [] }
  if (!code || plan.code !== code) return { ok: false, error: 'Things changed since the preview (or the code is not the one it gave). Nothing was done: look at the preview again.', results: [] }
  if (!plan.ok) return { ok: false, error: 'The plan has sessions that cannot be done (see the preview). Nothing was done.', results: [] }
  return applyPlan(plan, ctx)
}
