# Installing and spreading 1session

Read this when the probe in SKILL.md fails in a way the two-line fallback does
not cover, or when the user asks how to get this onto another machine or into
another agent.

- [What it needs](#what-it-needs)
- [Three ways to run it](#three-ways-to-run-it)
- [Spreading the skill to every agent](#spreading-the-skill-to-every-agent)
- [Upgrading](#upgrading)
- [Uninstalling](#uninstalling)
- [Handing it to someone else](#handing-it-to-someone-else)
- [Troubleshooting](#troubleshooting)

## What it needs

**Node.js >= 22.15**, and nothing else. The version floor is real, not
defensive: the index is `node:sqlite` and dsh's sessions are zstd-compressed,
which only landed in `node:zlib` in 22.15. On an older runtime the package
installs and then fails at the first call, so check first:

```bash
node -v
```

If it is below 22.15, say so and stop. `npx` runs the same code on the same
runtime and will fail identically — there is no way around it except upgrading
Node (`nvm install 22`, `brew upgrade node`, or whatever that machine uses).

Everything else is already on the machine. The only runtime dependency is
`@1agents/dreammate-network` (12 kB, zero dependencies of its own), which npm
pulls in automatically. There is no daemon, no service to start, no config file,
and no account. The reader opens session files the agents already wrote and
never writes back to them.

macOS, Linux and WSL all work. On native Windows the paths it reads
(`~/.claude`, `~/.codex`, …) resolve through `os.homedir()`, but it is the least
exercised platform — if something looks wrong there, check that the agent in
question actually stores sessions under the Windows home directory before
assuming the reader is broken.

## Three ways to run it

**Zero install (`npx`).** Correct for a one-off answer, for a machine you are
only visiting, and for the first call before anyone has agreed to install
anything:

```bash
npx -y @1agents/session-reader@latest list --global --limit 10
```

Every command in SKILL.md works with this prefix substituted for `1session`.
The cost is a few seconds of download per invocation and a cache directory npm
cleans up on its own schedule — fine for answering, wrong as a permanent setup
(see the warning under [spreading](#spreading-the-skill-to-every-agent)).

**Global install.** The normal choice for a machine the user works on daily:

```bash
npm i -g @1agents/session-reader
1session help          # verify: prints the command list
```

**As a library.** The parsers and ledgers are exported, so a script can consume
sessions without shelling out:

```bash
npm i @1agents/session-reader
```

```js
import { listSessions } from '@1agents/session-reader';
```

Reach for this only when the user is building something on top of session data.
For answering questions about the past, the CLI is both cheaper and denser.

## Spreading the skill to every agent

The package ships this skill inside it, and the CLI installs it into every
agent's skills directory in one call:

```bash
1session skill install     # all agents found on this machine
1session skill status      # what is installed where, and whether it is current
1session skill uninstall   # remove it again
```

| Agent | Where it lands |
| --- | --- |
| claude | `~/.claude/skills/1session` |
| codex | `~/.codex/skills/1session` |
| antigravity | `~/.gemini/antigravity/skills/1session` (**not** `~/.gemini/skills`, which is gemini-cli's) |
| grok | `~/.grok/skills/1session` |
| dsh | `~/.dsh/skills/1session` |

All five load `<dir>/<name>/SKILL.md` with the same YAML frontmatter, so it is
genuinely one file serving five agents, not five ports of it.

**Do not run `skill install` through `npx`.** In link mode — the default — the
installed entry is a symlink back to wherever the package lives, and under npx
that is a cache directory like `~/.npm/_npx/<hash>/node_modules/…` which npm
garbage-collects. The skill works right up until the day the cache is pruned and
then silently disappears from all five agents. Install the package globally
first and then run `skill install`; if you truly must bootstrap through npx, use
`--copy` so the bytes are owned by the agent rather than borrowed from a cache.

Link mode is otherwise the better default: after `npm i -g …@latest`, every
agent is already looking at the new skill with nothing to re-run. Use `--copy`
when an agent's loader does not follow symlinks — the symptom is `skill status`
reporting a healthy link while the agent itself never mentions the skill. The
cost of a copy is that upgrades no longer propagate; `skill status` marks a copy
that has drifted from the installed package, so the drift is visible rather than
silent.

Other flags:

| Flag | Why |
| --- | --- |
| `--agent claude,codex` | Only these. Named agents get their skills directory created even if the agent is not installed yet, which is how you set a machine up before installing the agent. |
| `--copy` | Copy instead of symlink. |
| `--force` | Overwrite a same-named entry that this installer did not create, or convert an existing copy into a link. Without it, both cases are refused rather than clobbered. |
| `--dry-run` | Print the plan and touch nothing. Worth doing first on someone else's machine. |
| `--json` | Machine-readable result. |

Agents that are not installed are skipped rather than failed, so a machine with
only Claude Code reports three skips and one install, and that is success.

## Upgrading

```bash
npm i -g @1agents/session-reader@latest
```

Linked skills are current the moment that finishes. Copied ones need
`1session skill install --copy --force` afterwards; `1session skill status` is
what tells you which case you are in.

The index rebuilds itself when the parser version moves, so an upgrade that
changes how sessions are read costs one slower call and needs no manual
clearing. To force it: `1session index --all --global`.

## Uninstalling

```bash
1session skill uninstall         # remove the skill from the agents
npm rm -g @1agents/session-reader
rm -rf ~/.1agents/session-reader # the index; sessions themselves are untouched
```

`skill uninstall` only removes entries it could have created (its own links and
copies); anything else needs `--force`, which exists so a hand-written skill of
the same name is never deleted by accident. Nothing here touches the agents'
session files — the reader has never written to them.

## Handing it to someone else

The whole thing is one npm package, so the shortest correct instruction is two
lines:

```bash
npm i -g @1agents/session-reader
1session skill install
```

That is the version to paste into a chat or a README. It gets them the CLI and
puts the skill into every agent they have, which is the part people forget: a
colleague who installs only the CLI has to remember it exists, while one who ran
both lines has their agent remember for them.

If they cannot install globally (locked-down machine, shared box), the npx form
plus `skill install --copy` gets them to the same place with the package living
in a cache instead of `/usr/local`.

If they want to read the source or file a bug:
<https://github.com/scottzx/session-reader>.

When you are the one setting this up on a user's machine, prefer offering these
commands over running them unasked — a global npm install changes their system.
Running the read-only CLI to answer a question is not the same kind of act as
installing software, and the difference is worth respecting.

## Troubleshooting

| Symptom | What is actually wrong |
| --- | --- |
| `1session: command not found` right after `npm i -g` | npm's global bin directory is not on `PATH`. It is `$(npm prefix -g)/bin` — `npm bin -g` was removed in npm 9, so use the prefix form — and it goes in the shell profile. Meanwhile `npx -y @1agents/session-reader@latest …` works unchanged. |
| `EACCES` / permission denied during `npm i -g` | The global prefix is root-owned. Do not reach for `sudo npm` — repoint the prefix (`npm config set prefix ~/.npm-global`, then put `~/.npm-global/bin` on `PATH`) or use a Node version manager, both of which leave the system directories alone. |
| Installs fine, then throws on the first real command | Almost always Node < 22.15 — `node:sqlite` or zstd missing. Check `node -v`. |
| `skill status` shows a healthy link, but the agent never uses the skill | That agent's loader does not follow symlinks. `1session skill install --copy --force`. |
| The skill vanished from every agent at once | It was installed in link mode from an npx cache that npm has since pruned. Install the package globally, then `1session skill install --force`. |
| `skill install` reports `blocked` | Something else already owns that name — a hand-written skill, or a copy where a link is wanted. Look at it before passing `--force`. |
| The first call takes ~10s | That is the initial index build over every session on the machine, not a hang. Subsequent calls are sub-second. |
| Results look stale or wrong | `1session index --all --global` rebuilds, and `--no-index` on any command reads the raw files directly — if those two disagree, that is a real bug worth reporting. |
| `list` returns nothing in a directory that definitely had sessions | Scope, not installation. `list` defaults to the pwd subtree; add `--global`. |
