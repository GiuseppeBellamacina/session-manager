// What is on disk: Claude Code keeps each session as `<claude dir>/projects/<project folder>/<id>.jsonl`, with an
// optional `<id>/` folder beside it (subagents, tool results). This module only reads. Nothing here writes.
import { readdir, stat, open, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizePath, rootOf } from './paths.mjs'

const HEAD_BYTES = 1024 * 1024
const TITLE_LENGTH = 120

export const claudeDirOf = (env = process.env) => env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')

const exists = async path => stat(path).then(() => true, () => false)
const isDir = async path => stat(path).then(s => s.isDirectory(), () => false)

/** Total bytes of a folder (a session's subagents and tool results can be large). */
export async function sizeOf(path) {
  let total = 0
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) total += await sizeOf(child)
    else total += await stat(child).then(s => s.size, () => 0)
  }
  return total
}

/** The rows at the start of a transcript: what is needed to name a session, without reading a file of 100 MB. */
export async function readHead(file, bytes = HEAD_BYTES) {
  const handle = await open(file, 'r')
  try {
    const { size } = await handle.stat()
    const buffer = Buffer.alloc(Math.min(size, bytes))
    await handle.read(buffer, 0, buffer.length, 0)
    const lines = buffer.toString('utf8').split('\n')
    // A chunk that stops in the middle of a row: that row is not read.
    if (size > bytes) lines.pop()
    const rows = []
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        rows.push(JSON.parse(line))
      } catch {
        /* a row that is not JSON is skipped */
      }
    }
    return rows
  } finally {
    await handle.close()
  }
}

const cut = text => (text.length > TITLE_LENGTH ? text.slice(0, TITLE_LENGTH - 1) + '…' : text)

const textsOf = row => {
  const content = row.message?.content
  if (typeof content === 'string') return [content]
  return Array.isArray(content) ? content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text) : []
}

/** The words with the tagged parts taken out: an IDE or a browser wraps its notes in tags before the person's own words. */
const withoutTags = text => text.replace(/<([A-Za-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * A title for a session: the first words the person wrote, not what an IDE, a browser or the engine put around them.
 * A session that starts with a command and has no prompt of its own is called by the command (`/init`).
 */
function titleOf(rows) {
  let command = ''
  for (const row of rows) {
    if (row.type !== 'user' || row.isMeta) continue
    for (const text of textsOf(row)) {
      const name = /<command-name>\s*([^<]+?)\s*<\/command-name>/.exec(text)?.[1]
      if (name) {
        const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim()
        command ||= args ? `${name} ${args}` : name
        continue
      }
      const clean = withoutTags(text)
      if (clean) return cut(clean)
    }
  }
  return cut(command.replace(/\s+/g, ' ').trim())
}

/**
 * Does the folder of a session exist? `missing` only when the folder is gone and its drive is there: a drive that is not
 * plugged in makes every folder on it look gone, and a session with no folder recorded is `unknown`. Neither is an orphan.
 */
export async function folderState(cwd, platform = process.platform) {
  const normal = normalizePath(cwd, platform)
  if (!normal) return 'unknown'
  if (await isDir(normal)) return 'exists'
  const root = rootOf(normal, platform)
  if (root && !(await isDir(root))) return 'unknown'
  return 'missing'
}

/** The sessions running now: each Claude Code process leaves `<claude dir>/sessions/<pid>.json`, valid while the process lives. */
export async function runningSessionIds(claudeDir) {
  const ids = new Set()
  const dir = join(claudeDir, 'sessions')
  for (const name of await readdir(dir).catch(() => [])) {
    if (!name.endsWith('.json')) continue
    try {
      const info = JSON.parse(await readFile(join(dir, name), 'utf8'))
      if (typeof info.sessionId !== 'string' || !Number.isInteger(info.pid)) continue
      try {
        process.kill(info.pid, 0)
        ids.add(info.sessionId)
      } catch (error) {
        // EPERM: the process is there, but not ours to signal.
        if (error?.code === 'EPERM') ids.add(info.sessionId)
      }
    } catch {
      /* a file that is not ours to read is skipped */
    }
  }
  return ids
}

/**
 * Every session on this machine, the latest first.
 * `folder` is the first folder the session recorded (what the session started in: it may `cd` later), as normalized.
 */
export async function listSessions({ claudeDir = claudeDirOf(), platform = process.platform } = {}) {
  const projects = join(claudeDir, 'projects')
  const running = await runningSessionIds(claudeDir)
  const sessions = []
  for (const project of await readdir(projects).catch(() => [])) {
    const projectDir = join(projects, project)
    if (!(await isDir(projectDir))) continue
    for (const name of await readdir(projectDir)) {
      if (!name.endsWith('.jsonl')) continue
      const id = name.slice(0, -'.jsonl'.length)
      const file = join(projectDir, name)
      const info = await stat(file).catch(() => undefined)
      if (!info?.isFile()) continue
      const rows = await readHead(file).catch(() => [])
      const first = rows.find(r => typeof r.cwd === 'string' && r.cwd !== '')
      const folder = first ? normalizePath(first.cwd, platform) : ''
      const sideDir = join(projectDir, id)
      const hasSide = await isDir(sideDir)
      sessions.push({
        id,
        project,
        file,
        sideDir: hasSide ? sideDir : null,
        folder,
        folderState: await folderState(folder, platform),
        title: titleOf(rows),
        branch: rows.find(r => typeof r.gitBranch === 'string' && r.gitBranch)?.gitBranch ?? '',
        lastActivity: info.mtimeMs,
        bytes: info.size + (hasSide ? await sizeOf(sideDir) : 0),
        inUse: running.has(id),
      })
    }
  }
  return sessions.sort((a, b) => b.lastActivity - a.lastActivity)
}

/** The sessions whose folder is gone. A session with no folder recorded, or on a drive that is away, is never in this list. */
export const orphansOf = sessions => sessions.filter(s => s.folderState === 'missing')

/** One session by the start of its id (at least 4 characters), or why not. */
export function findSession(sessions, query) {
  const q = String(query ?? '').trim().toLowerCase()
  if (q.length < 4) return { error: 'Give at least the first 4 characters of the id.' }
  const found = sessions.filter(s => s.id.toLowerCase().startsWith(q))
  if (found.length === 0) return { error: `No session starts with "${q}".` }
  if (found.length > 1) return { error: `"${q}" fits ${found.length} sessions: ${found.map(s => s.id.slice(0, 8)).join(', ')}. Give more characters.` }
  return { session: found[0] }
}

export { exists }
