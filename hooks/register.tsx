import type { EngineInterface, Register } from 'claude-code'

// The plugin is thin: the commands are answered by lib/cli.mjs (text in, text out) and the page by server/sessions-server.mjs.
// Both are plain Node files of this plugin, started with the words the person typed as one argument, never through a shell.

let pageUrl: string | undefined

/** An address VS Code answers to for a session, and nothing else: it is what the CLI prints for `open`, checked again here. */
const VSCODE = /^vscode:\/\/anthropic\.claude-code\/open\?session=[0-9A-Za-z%_.-]{8,80}$/

async function openUrl($: EngineInterface, url: string) {
  const windows = (await $.env.get('OS')) === 'Windows_NT'
  const mac = !windows && (await $.process.run(['uname']).catch(() => ({ stdout: '' }))).stdout.trim() === 'Darwin'
  await $.process.run(windows ? ['cmd', '/c', 'start', '', url] : [mac ? 'open' : 'xdg-open', url]).catch(() => undefined)
}

/** Starts the page's server and answers its address once it says READY. */
function startServer($: EngineInterface): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = $.process.spawn({ argv: ['node', `${$.plugin.root}/server/sessions-server.mjs`, '--page', `${$.plugin.root}/page/index.html`] })
    const timer = $.clock.after(15_000, () => reject(new Error('the page did not start: is Node.js installed?')))
    void (async () => {
      let buffer = ''
      try {
        for await (const piece of child) {
          if (piece.stream !== 'stdout') continue
          buffer += piece.text
          let nl: number
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim()
            buffer = buffer.slice(nl + 1)
            if (line.startsWith('READY ')) {
              timer.cancel()
              resolve(line.slice(6))
            }
          }
        }
      } catch (error) {
        reject(error)
      } finally {
        pageUrl = undefined
      }
      reject(new Error('the page server stopped before it was ready'))
    })()
  })
}

/** The page open in the browser: the server that is running if it still answers, else a new one. */
async function openPage($: EngineInterface): Promise<string> {
  if (pageUrl && (await $.http.fetch(`${pageUrl}api/sessions`).then(r => r.ok, () => false))) {
    await openUrl($, pageUrl)
    return pageUrl
  }
  pageUrl = await startServer($)
  await openUrl($, pageUrl)
  return pageUrl
}

async function command($: EngineInterface, args: string): Promise<string> {
  const words = args.trim()
  if (words === '' || words.toLowerCase() === 'page') {
    try {
      return `sessions: the page is open in your browser: ${await openPage($)}`
    } catch (error) {
      return `sessions: ${(error as Error).message}`
    }
  }
  const run = await $.process.run(['node', `${$.plugin.root}/lib/cli.mjs`, '--args', words], { timeoutMs: 600_000 }).catch(error => ({ exitCode: 1, stdout: '', stderr: String(error) }))
  let text = run.stdout.trim() || run.stderr.trim() || 'sessions: no answer (is Node.js installed?)'
  const open = /^OPEN (\S+)\n?/.exec(text)
  if (open) {
    text = text.slice(open[0].length)
    if (VSCODE.test(open[1]!)) await openUrl($, open[1]!)
  }
  return text
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'sessions', description: 'Session manager: every session on this computer, to open, move to another folder or delete, with a confirmation' })
    return next(e)
  })

  on('command.run', { command: 'sessions' }, async ($, e) => ({ text: await command($, e.args) }))
}
