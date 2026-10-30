// Moving a session means writing its transcript again with another folder in the `cwd` of its rows. A transcript can be
// 100 MB, so it is read and written as a stream; only the `cwd` text of a row changes, every other byte stays as it was,
// and each row that changed is checked against the original before the file counts as written.
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import { once } from 'node:events'
import { join } from 'node:path'
import { isInside, replacePrefix } from './paths.mjs'

const without = (row, key) => {
  const { [key]: _gone, ...rest } = row
  return JSON.stringify(rest)
}

/** One row with the folder moved from `from` to `to`; the row itself if it has no `cwd` there. Throws if the change touched more than the `cwd`. */
export function rewriteRow(line, from, to, platform = process.platform) {
  if (!line.includes('"cwd"')) return { line, changed: false }
  let row
  try {
    row = JSON.parse(line)
  } catch {
    return { line, changed: false }
  }
  if (!row || typeof row.cwd !== 'string' || !isInside(row.cwd, from, platform)) return { line, changed: false }
  const moved = replacePrefix(row.cwd, from, to, platform)
  if (moved === row.cwd) return { line, changed: false }
  const pair = `"cwd":${JSON.stringify(row.cwd)}`
  // The pair is replaced where it stands, so the bytes around it do not move; a row written another way is written again whole.
  const next = line.includes(pair) ? line.replace(pair, () => `"cwd":${JSON.stringify(moved)}`) : JSON.stringify({ ...row, cwd: moved })
  const check = JSON.parse(next)
  if (check.cwd !== moved || without(check, 'cwd') !== without(row, 'cwd')) throw new Error('a row changed in more than its folder: nothing was written')
  return { line: next, changed: true }
}

/** `source` written to `dest` with the folder moved. Returns how many rows it has and how many it changed. */
export async function rewriteTranscript(source, dest, from, to, platform = process.platform) {
  const input = createReadStream(source, { encoding: 'utf8', highWaterMark: 1 << 20 })
  const output = createWriteStream(dest)
  // A write that fails reports on the stream: it is kept and raised where the work ends, not left to crash the process.
  let failure
  output.on('error', error => {
    failure ??= error
  })
  const closed = new Promise(resolve => output.once('close', resolve))
  let carry = ''
  let rows = 0
  let changed = 0
  const put = async text => {
    if (failure) throw failure
    if (!output.write(text)) await once(output, 'drain')
  }
  const handle = async (line, end) => {
    const r = rewriteRow(line, from, to, platform)
    rows++
    if (r.changed) changed++
    await put(r.line + end)
  }
  try {
    for await (const chunk of input) {
      const parts = (carry + chunk).split('\n')
      carry = parts.pop() ?? ''
      for (const line of parts) await handle(line, '\n')
    }
    if (carry !== '') await handle(carry, '')
    output.end()
    await closed
    if (failure) throw failure
  } catch (error) {
    input.destroy()
    output.destroy()
    // The file is let go before the caller removes it: on Windows a file that is still open cannot be deleted.
    await closed
    throw error
  }
  return { rows, changed }
}

/** The rows of a transcript, counted by reading it. */
export async function countRows(file) {
  let rows = 0
  let carry = ''
  for await (const chunk of createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 })) {
    const parts = (carry + chunk).split('\n')
    carry = parts.pop() ?? ''
    rows += parts.length
  }
  return rows + (carry !== '' ? 1 : 0)
}

/**
 * A session's side folder copied to `dest`: the transcripts in it (a subagent's own) get the same new folder, the rest is
 * copied as it is. Returns the files written, so a failure can be undone.
 */
export async function copySide(source, dest, from, to, platform = process.platform) {
  const written = []
  const walk = async (src, dst) => {
    await mkdir(dst, { recursive: true })
    for (const entry of await readdir(src, { withFileTypes: true })) {
      const a = join(src, entry.name)
      const b = join(dst, entry.name)
      if (entry.isDirectory()) await walk(a, b)
      else if (entry.name.endsWith('.jsonl')) {
        await rewriteTranscript(a, b, from, to, platform)
        written.push(b)
      } else {
        await copyFile(a, b)
        written.push(b)
      }
    }
  }
  await walk(source, dest)
  return written
}

export const sizeOfFile = path => stat(path).then(s => s.size)
