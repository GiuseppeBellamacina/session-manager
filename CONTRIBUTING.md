# Contributing

## Layout

- `lib/paths.mjs`: the paths of a transcript in every spelling Claude Code uses (`D:\x`, `/d/x`), compared as one; the project folder name; moving a prefix and keeping each row's style. The platform is a parameter, so Windows rules are tested on any system.
- `lib/sessions.mjs`: reads `~/.claude/projects` (the start of each transcript only): folder, title, size, whether the folder is there, whether the session runs now. Never writes.
- `lib/rewrite.mjs`: a transcript written again as a stream with the `cwd` of its rows changed, each changed row compared with the original.
- `lib/trash.mjs`: the system's trash (Recycle Bin, Finder, `gio trash`). It never falls back to deleting.
- `lib/plan.mjs`: the two steps. `makePlan` reads and says what would change, with a code; `confirm` makes the plan again and goes on only if the code is the one shown. Moves write and check the new copy before the old one goes to the trash.
- `lib/cli.mjs`: the `/sessions` commands as text in, text out.
- `server/sessions-server.mjs` and `page/index.html`: the page and the server behind it.
- `hooks/register.tsx`: the plugin: it registers `/sessions` and runs `lib/cli.mjs` or starts the server.
- `tests/*.test.mjs` (Node's test runner, a made-up `.claude` folder in `tests/fixture.mjs`) and `tests/hooks.test.tsx` (`claude plugin test`).

## Ground rules

- **A change is two steps, always.** Anything that writes or deletes goes through `makePlan` then `confirm`, and `confirm` refuses a code that does not match what is on disk now. No shortcut for "small" changes.
- **Never delete for good.** Originals go to the system's trash; if there is none, the call fails. A new copy that was made and not yet committed is the only thing code here may remove itself.
- **The old session is touched last.** A move writes the new transcript, checks it, and only then sends the old one to the trash; before that, a failure removes what the move made and leaves the old session whole.
- **Nothing is guessed.** A session with no recorded folder, or on a drive that is away, is *unknown*, never an orphan. A session that runs now is never moved or deleted.
- **No shell.** Paths and ids reach a program as arguments or as data on its input; what the person types in `/sessions` reaches the CLI as one argument. Anything that becomes part of a started address is checked against a pattern first.
- **The page is local.** Host, secret path and same origin for writes; titles are put in the page as text, never as markup.
- **Only the plugin hooks of the mod API, never `classic.*`.** Some security setups skip the classic hooks without a word: `grep -rn "classic\." hooks/` must print nothing.
- **A plugin name cannot start with `claude-`**, and some command names are Claude Code's own: `claude plugin validate` says so.

## Develop

```bash
node --test "tests/*.test.mjs"
claude plugin validate .
claude plugin test .
claude --plugin-dir .          # try it in a session
```

Changes go in a pull request that closes an issue; CI runs on Windows, Ubuntu and macOS.
