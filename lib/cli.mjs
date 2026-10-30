#!/usr/bin/env node
// The `/sessions` commands as text in, text out. The plugin runs this file with the words the person typed as ONE argument
// (`node cli.mjs --args "delete aaaaaaaa"`), so nothing they type is ever read by a shell.
import { fileURLToPath } from 'node:url'
import { confirm, defaultContext, describePlan, makePlan } from './plan.mjs'
import { findSession, listSessions, orphansOf } from './sessions.mjs'

/** Words, with "double quotes" keeping the spaces inside (a Windows path may have them); a backslash is just a backslash. */
export function tokenize(text) {
  const out = []
  const pattern = /"([^"]*)"|(\S+)/g
  let m
  while ((m = pattern.exec(text ?? ''))) out.push(m[1] ?? m[2])
  return out
}

const quote = word => (/\s/.test(word) ? `"${word}"` : word)
const mb = n => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(1)} MB`)
const ago = ms => {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  return s < 5400 ? `${Math.round(s / 60)} min` : s < 129600 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`
}

export const HELP = [
  '/sessions                          open the page in the browser',
  '/sessions list [text]              the sessions, latest first; text filters by title, folder, id or branch',
  '/sessions open <id>                open a session in VS Code (the id can be its first 4+ characters)',
  '/sessions orphans                  the sessions whose folder is gone',
  '/sessions prune                    send the orphans to the trash (it shows what first, and asks you to confirm)',
  '/sessions delete <id>...           send sessions to the trash (previewed and confirmed the same way)',
  '/sessions move <id>... <folder>    move sessions to the folder they live in now, with their rows',
  '/sessions move-project <old> <new> move every session of a project that moved from <old> to <new>',
  'Every change is previewed first, and done only by repeating the command with `yes <code>`.',
].join('\n')

/** What to type to go on: the same command, with the code the preview gave. */
const again = (verb, words, code) => `/sessions ${[verb, ...words].map(quote).join(' ')} yes ${code}`

async function change(verb, request, words, tail, ctx) {
  const yes = tail.length === 2 && tail[0].toLowerCase() === 'yes' ? tail[1] : undefined
  if (yes) {
    const result = await confirm(request, yes, ctx)
    if (result.error) return result.error
    const done = result.results.filter(r => r.ok).length
    const lines = [result.ok ? `Done: ${done} session${done === 1 ? '' : 's'}.` : `Stopped at an error: ${done} session${done === 1 ? ' was' : 's were'} done before it.`]
    for (const r of result.results.filter(x => !x.ok)) lines.push(`- ${r.id.slice(0, 8)}: ${r.message}`)
    for (const r of result.results.filter(x => x.ok && x.history === 'skipped')) lines.push(`- ${r.id.slice(0, 8)}: its prompt history was left as it was (Claude Code was writing it).`)
    return lines.join('\n')
  }
  const plan = await makePlan(request, ctx)
  if (plan.error) return plan.error
  const where = plan.kind === 'move' || plan.kind === 'move-project' ? 'move them' : 'send them to the trash (you can put them back from there)'
  return `${describePlan(plan)}\n\n` + (plan.ok ? `Nothing was changed yet. To ${where}: ${again(verb, words, plan.code)}` : 'Nothing was changed. Some of these cannot be done: see above.')
}

/** One command line, answered as text. `ctx` is where the sessions are and what the trash is (tests give their own). */
export async function run(argsText, ctx = defaultContext()) {
  const words = tokenize(argsText)
  const verb = (words.shift() ?? '').toLowerCase()
  const tail2 = () => (words.length >= 2 && words.at(-2).toLowerCase() === 'yes' ? words.splice(-2) : [])

  if (verb === 'list') {
    const q = words.join(' ').toLowerCase()
    const list = (await listSessions(ctx)).filter(s => !q || `${s.title} ${s.folder} ${s.id} ${s.branch}`.toLowerCase().includes(q))
    if (!list.length) return 'No session matches.'
    const lines = list.slice(0, 40).map(s => `${s.id.slice(0, 8)}  ${ago(s.lastActivity).padStart(6)}  ${mb(s.bytes).padStart(8)}  ${s.folderState === 'missing' ? '[orphan] ' : s.folderState === 'unknown' ? '[no folder] ' : ''}${s.inUse ? '[open now] ' : ''}${s.title || '(no title)'}\n          ${s.folder || '-'}`)
    return `${list.length} session${list.length === 1 ? '' : 's'}${list.length > 40 ? ' (the latest 40)' : ''}, ${orphansOf(list).length} orphan${orphansOf(list).length === 1 ? '' : 's'}:\n${lines.join('\n')}`
  }
  if (verb === 'open') {
    const found = findSession(await listSessions(ctx), words[0])
    if (found.error) return found.error
    const s = found.session
    // An id comes from a file name: only a normal one is put in an address that gets started.
    if (!/^[0-9a-f-]{8,64}$/i.test(s.id)) return `Cannot open ${s.id.slice(0, 20)}: its id is not a normal session id. Run it in a terminal: claude --resume`
    // The first line is for the plugin, which opens it: VS Code takes this address and resumes the session in its Claude panel.
    return `OPEN vscode://anthropic.claude-code/open?session=${encodeURIComponent(s.id)}\nOpening ${s.id.slice(0, 8)} in VS Code. If nothing happens, run it in a terminal: ${s.folder ? `cd "${s.folder}" && ` : ''}claude --resume ${s.id}`
  }
  if (verb === 'orphans') {
    const orphans = orphansOf(await listSessions(ctx))
    if (!orphans.length) return 'No orphan session: every folder is there (or not known).'
    return `${orphans.length} orphan${orphans.length === 1 ? '' : 's'} (${mb(orphans.reduce((n, s) => n + s.bytes, 0))}), their folder is gone:\n${orphans.map(s => `${s.id.slice(0, 8)}  ${mb(s.bytes).padStart(8)}  ${s.title || '(no title)'}\n          ${s.folder}`).join('\n')}\n\nTo send them to the trash: /sessions prune`
  }
  if (verb === 'prune') return change('prune', { kind: 'prune' }, [], words, ctx)
  if (verb === 'delete') {
    const tail = tail2()
    if (!words.length) return 'Usage: /sessions delete <id>...'
    return change('delete', { kind: 'delete', ids: words }, words, tail, ctx)
  }
  if (verb === 'move') {
    const tail = tail2()
    if (words.length < 2) return 'Usage: /sessions move <id>... <folder>'
    const to = words.at(-1)
    return change('move', { kind: 'move', ids: words.slice(0, -1), to }, words, tail, ctx)
  }
  if (verb === 'move-project') {
    const tail = tail2()
    if (words.length !== 2) return 'Usage: /sessions move-project <old folder> <new folder>'
    return change('move-project', { kind: 'move-project', from: words[0], to: words[1] }, words, tail, ctx)
  }
  return HELP
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf('--args')
  run(i > 0 ? process.argv[i + 1] : '').then(
    text => process.stdout.write(text + '\n'),
    error => {
      process.stdout.write(`Something went wrong: ${error?.message ?? error}\n`)
      process.exitCode = 1
    },
  )
}
