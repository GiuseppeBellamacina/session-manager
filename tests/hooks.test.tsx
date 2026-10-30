import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const ID = 'aaaaaaaa-1111-4111-8111-111111111111'

// The engine beneath the plugin: every process run lands in `runs`, and the CLI answers what a test says.
function engine(on: On, answer: (argv: string[]) => { exitCode: number; stdout: string; stderr: string } = () => ({ exitCode: 0, stdout: 'ok\n', stderr: '' })) {
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, { USERPROFILE: 'C:/Users/test', OS: 'Windows_NT' })
  const runs: string[][] = []
  const registered: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => (registered.push(e.name), { value: { command: e.name } }))
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    return { value: answer([...e.argv]) } as never
  })
  return { runs, registered }
}

const cmd = async ($: Engine, args: string) => ((await $.command.run({ command: 'sessions', args, origin: { kind: 'composer' } } as never)) as { text?: string }).text ?? ''
const start = ($: Engine) => $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })

test('the command is registered as sessions', async ($, on) => {
  const { registered } = engine(on)
  await start($)
  expect(registered).toEqual(['sessions'])
})

test('what the person types reaches the CLI as one argument, never as part of a command line', async ($, on) => {
  const { runs } = engine(on, () => ({ exitCode: 0, stdout: '2 sessions, 0 orphans:\n', stderr: '' }))
  await start($)
  const text = await cmd($, 'list "a b" & calc | del x')
  expect(text).toBe('2 sessions, 0 orphans:')
  expect(runs.length).toBe(1)
  expect(runs[0]!.slice(0, 1)).toEqual(['node'])
  expect(runs[0]!.at(-3)!.endsWith('/lib/cli.mjs')).toBe(true)
  expect(runs[0]!.slice(-2)).toEqual(['--args', 'list "a b" & calc | del x'])
})

test('open: the address for VS Code is started, and not shown as text', async ($, on) => {
  const { runs } = engine(on, argv => (argv[0] === 'node' ? { exitCode: 0, stdout: `OPEN vscode://anthropic.claude-code/open?session=${ID}\nOpening aaaaaaaa in VS Code.\n`, stderr: '' } : { exitCode: 0, stdout: '', stderr: '' }))
  await start($)
  const text = await cmd($, 'open aaaa')
  expect(text).toBe('Opening aaaaaaaa in VS Code.')
  expect(runs.at(-1)).toEqual(['cmd', '/c', 'start', '', `vscode://anthropic.claude-code/open?session=${ID}`])
})

test('an address that is not the one for a session is never started', async ($, on) => {
  let line = ''
  const { runs } = engine(on, argv => (argv[0] === 'node' ? { exitCode: 0, stdout: `OPEN ${line}
hello
`, stderr: '' } : { exitCode: 0, stdout: '', stderr: '' }))
  await start($)
  for (const bad of [
    'vscode://anthropic.claude-code/open?session=x&calc',
    'https://evil.example/',
    'vscode://other/open?session=aaaaaaaa',
    'vscode://anthropic.claude-code/open?session=aaaaaaaa&x=1',
    'file:///c:/windows/system32/calc.exe',
    'vscode://anthropic.claude-code/open?session=aaaaaaaa^&calc',
  ]) {
    line = bad
    expect(await cmd($, 'open aaaa')).toBe('hello')
  }
  expect(runs.filter(a => a[0] === 'cmd').length).toBe(0)
  // The right one, for comparison.
  line = `vscode://anthropic.claude-code/open?session=${ID}`
  await cmd($, 'open aaaa')
  expect(runs.filter(a => a[0] === 'cmd').length).toBe(1)
})

test('a CLI that fails says why, and one with nothing to say still answers', async ($, on) => {
  let out = { exitCode: 1, stdout: '', stderr: 'node: not found' }
  engine(on, () => out)
  await start($)
  expect(await cmd($, 'list')).toBe('node: not found')
  out = { exitCode: 1, stdout: '', stderr: '' }
  expect(await cmd($, 'list')).toBe('sessions: no answer (is Node.js installed?)')
})
