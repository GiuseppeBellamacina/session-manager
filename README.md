# session-manager

Every [Claude Code](https://code.claude.com) session on your computer, in one place: see them all, open one, **move a session (or a whole project) to another folder** when the project moved, and **delete sessions, or all the orphans at once**. Every change is shown first and done only after you confirm.

It comes with a page in your browser, in the style of [omniboard](https://github.com/GiuseppeBellamacina/omniboard), and with `/sessions` commands for the same things from the chat.

## Why

Claude Code keeps a session in `~/.claude/projects/<folder name>/<id>.jsonl`, and `/resume` shows only the sessions of the folder you are in. Move or rename a project and its sessions are stranded: they are still on disk (some are 100 MB), but nothing shows them where you need them. This plugin brings them with the project, and clears the ones whose folder is gone for good.

## Install

```text
/plugin marketplace add GiuseppeBellamacina/session-manager
/plugin install session-manager@session-manager
```

Where `/plugin` is not available (the VS Code extension), use a terminal:

```bash
claude plugin marketplace add GiuseppeBellamacina/session-manager
claude plugin install session-manager@session-manager
```

Then `/reload-plugins`. [Node.js](https://nodejs.org) 18 or later is needed (standard library only, nothing to `npm install`), as for omniboard.

## The page

`/sessions` opens it. Sessions are grouped by the folder they started in, the latest first (or the largest). A group whose folder is gone is marked **folder missing**.

- **Open**: *VS Code* (resumes the session in the Claude Code panel), *Terminal* (a terminal in its folder with `claude --resume`, on Windows) or *Copy command*.
- **Move…**: asks for the full path of the folder, then shows what will change.
- **Move project…** on a group: every session of that project follows it to its new folder.
- **Delete…**, one or several (tick the boxes), and **Delete N orphans** for the whole lot.
- Search by title, folder, id or branch; filters *Orphans* and *Unknown folder*; light and dark.

Nothing is done by a click on its own: each change opens a window with what it will do (the sessions, their size, where they go), the focus is on **Cancel**, and the red or dark button names the number of sessions and the size.

## The commands

| Command | What it does |
| --- | --- |
| `/sessions` | Opens the page. |
| `/sessions list [text]` | The sessions, latest first. The text filters by title, folder, id or branch. |
| `/sessions open <id>` | Opens a session in VS Code. An id is its first 4 or more characters. |
| `/sessions orphans` | The sessions whose folder is gone. |
| `/sessions prune` | Sends the orphans to the trash. |
| `/sessions delete <id>...` | Sends sessions to the trash. |
| `/sessions move <id>... <folder>` | Moves sessions to the folder they live in now. |
| `/sessions move-project <old> <new>` | Moves every session of a project that moved from `<old>` to `<new>`. |

Every change is a command twice: the first time it shows what it would do and the exact line to type to go on, ending in `yes <code>`; the second time, with the code, it does it.

```text
> /sessions prune
7 sessions to send to the trash (245.6 MB):
- c38a6d52  123.9 MB  puoi configurare una test suit…
  D:\Codici\Workspace\EPUB_Translator
...
Nothing was changed yet. To send them to the trash (you can put them back from there): /sessions prune yes 470df32f3f
```

The code stands for exactly what was shown. If a session grew, or a folder came back, in between, the code no longer matches, nothing is done, and you look at a new preview.

Put a path with spaces in double quotes: `/sessions move aaaa "D:\My Projects\new place"`.

## What a move does

Say a project was in `D:\old\proj` and now is in `D:\new\proj`: `/sessions move-project D:\old\proj D:\new\proj`. For each session of that project:

1. its transcript is written again in the folder of the new project, with the `cwd` of its rows changed from the old folder to the new one (only that text: every other byte stays, and each changed row is compared with the original);
2. its side folder (subagents, tool results) is copied the same way;
3. the rows of its prompt history follow it;
4. the new copy is checked (same number of rows) and **only then** the old one goes to the trash. If anything fails before that, the new files are removed and the old session is untouched.

Then `/resume` in the new folder shows it. Limits: a path that appears *inside* the text of a tool result stays the old one (it is history); and if Claude Code is writing to the prompt history at that moment, that file is left as it was and the move says so.

## What a delete does

Sessions go to the **system's trash** (the Recycle Bin on Windows, Trash on macOS, `gio trash` on Linux), never deleted for good, so a mistake is undone from there. With a session go its saved file history and session environment (`~/.claude/file-history/<id>`, `~/.claude/session-env/<id>`). If no trash can be reached, nothing is deleted.

## What is an orphan

A session whose folder (the first one it recorded) no longer exists. It is **never** guessed:

- a session with **no folder recorded** is *unknown*, not an orphan, and no command touches it by itself;
- a folder on a **drive that is not plugged in** is *unknown* too, not an orphan;
- folders are compared as the same place whatever way Claude Code wrote them (`D:\x`, `d:\x`, `/d/x` from Git Bash).

A session **open right now** in a running Claude Code cannot be moved or deleted.

## Safety

- The page is served on `127.0.0.1` only, on a secret path, for the exact host, and a change needs the same origin and a header another site cannot send. It stops after 30 idle minutes. Titles on the page are the first words you typed in each session: they never leave your computer, and are put in the page as text.
- What you type in `/sessions` reaches the program as one argument, never through a shell.
- Only the plugin hooks of the Claude Code mod API; no `classic.*` hooks.

## Where things are

Sessions: `~/.claude/projects/` (or `$CLAUDE_CONFIG_DIR/projects`). The plugin keeps no data of its own and writes no log.

## Systems

Windows is the system it was built on and tried on, including the real Recycle Bin. macOS (Finder's trash through `osascript`) and Linux (`gio trash`) are written and tested against stand-ins, not yet on real machines; opening a terminal from the page is Windows only (elsewhere it copies the command). The *VS Code* button uses `vscode://anthropic.claude-code/open?session=<id>`, an address reported by users of the extension and not documented by Anthropic: if it does nothing in your version, use *Terminal* or *Copy command*.

## Develop

```bash
git clone https://github.com/GiuseppeBellamacina/session-manager
node --test "tests/*.test.mjs"            # the files, the server, the CLI (a made-up .claude folder each time)
claude plugin validate ./session-manager
claude plugin test ./session-manager      # the plugin's hooks
SESSION_MANAGER_REAL_TRASH=1 node --test tests/trash.test.mjs   # Windows: the real Recycle Bin, leaves two small items in it
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
