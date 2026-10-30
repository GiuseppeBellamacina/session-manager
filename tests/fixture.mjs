// A `.claude` folder made for a test: real folders for the projects, transcripts that look like Claude Code's.
import { mkdtemp, mkdir, rename, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { slugOf } from '../lib/paths.mjs'

/** A stand-in for the system's trash: the paths are moved into a folder, so a test can see what was "trashed". */
export const fakeTrash = folder => {
  const sent = []
  const trash = async paths => {
    await mkdir(folder, { recursive: true })
    for (const path of paths) {
      await rename(path, join(folder, `${sent.length}-${basename(path)}`))
      sent.push(path)
    }
  }
  return { trash, sent }
}

export async function makeWorld() {
  const root = await mkdtemp(join(tmpdir(), 'session-manager-'))
  const claudeDir = join(root, '.claude')
  const work = join(root, 'work')
  await mkdir(join(claudeDir, 'projects'), { recursive: true })
  await mkdir(join(claudeDir, 'sessions'), { recursive: true })
  await mkdir(work, { recursive: true })

  /** A project folder on disk (`real`) or only in the transcripts (a folder that was moved away). */
  const folder = async (name, { real = true } = {}) => {
    const path = join(work, name)
    if (real) await mkdir(path, { recursive: true })
    return path
  }

  /** A session: the rows a transcript starts with, then `more` rows. `cwds` are the folders it recorded, in order. */
  const session = async (id, { cwds, prompt = 'Hello there', more = [], side = false, projectFolder = cwds?.[0], mtime } = {}) => {
    const dir = join(claudeDir, 'projects', slugOf(projectFolder ?? 'none'))
    await mkdir(dir, { recursive: true })
    const rows = [{ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-21T12:00:00Z', sessionId: id }]
    ;(cwds ?? []).forEach((cwd, i) => {
      rows.push({ type: 'user', cwd, sessionId: id, gitBranch: 'main', isMeta: i > 0, message: { role: 'user', content: [{ type: 'text', text: i === 0 ? prompt : 'later' }] } })
    })
    rows.push(...more)
    const file = join(dir, `${id}.jsonl`)
    await writeFile(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
    if (side) {
      await mkdir(join(dir, id, 'subagents'), { recursive: true })
      await writeFile(join(dir, id, 'subagents', 'agent-1.jsonl'), '{"type":"user"}\n')
    }
    if (mtime) {
      const { utimes } = await import('node:fs/promises')
      await utimes(file, mtime / 1000, mtime / 1000)
    }
    return { dir, file }
  }

  /** `sessions/<pid>.json`, the file a running Claude Code process leaves. */
  const process_ = async (pid, sessionId) => writeFile(join(claudeDir, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, kind: 'interactive' }))

  /** `history.jsonl`, the prompt history Claude Code keeps, one row per prompt with the project it was typed in. */
  const history = rows => writeFile(join(claudeDir, 'history.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n')

  /** The state a session keeps outside its project folder, by id. */
  const state = async id => {
    await mkdir(join(claudeDir, 'file-history', id), { recursive: true })
    await writeFile(join(claudeDir, 'file-history', id, 'a@v1'), 'old file')
    await mkdir(join(claudeDir, 'session-env', id), { recursive: true })
    await writeFile(join(claudeDir, 'session-env', id, 'env'), 'x')
  }

  const cleanup = () => rm(root, { recursive: true, force: true })
  return { root, claudeDir, work, folder, session, process: process_, history, state, cleanup, trashDir: join(root, 'trash') }
}
