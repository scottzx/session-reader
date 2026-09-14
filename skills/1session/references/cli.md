# 1session — full CLI reference

Read this when SKILL.md doesn't cover the flag you need.

- [Global flags](#global-flags)
- [Discovery: list, search, workspace](#discovery)
- [One session: overview, turns, turn, digest](#one-session)
- [Ledgers: commands, files, errors, jobs](#ledgers)
- [Index and graph](#index-and-graph)
- [Programmatic API](#programmatic-api)

## Global flags

| Flag | Effect |
| --- | --- |
| `--json` | Machine-readable output instead of the rendered text. |
| `--no-index` | Bypass the SQLite index and read the raw files. Results should match the indexed path exactly; use it to verify a suspicious result, not routinely (it is slower). |

The index lives at `~/.1agents/session-reader/index.db`. It fingerprints each
session file (size + mtime + head hash) and reparses only changed bytes, so
`list` never silently truncates older sessions no matter how wide `--scope` is.

## Discovery

### `list`

```
1session list [--limit n] [--scope <path>|cwd|global] [--global]
              [--provider claude|codex|antigravity] [--since 24h] [--json]
```

Most recently updated sessions first. Columns: provider, 8-char id, updated-at,
workspace basename, title.

`--since` accepts `24h`, `7d`, `30d` and similar.

### `search`

```
1session search <query> [--scope <path>|cwd|global] [--global] [--since 24h]
                [--limit n] [--provider name]
                [--kind user,assistant,thinking,tool_call,tool_result]
                [--regex] [--case] [--context n] [--max-hits n]
                [--include-self] [--json]
```

Full-text across sessions; prints matching turns with surrounding context.

Every hit carries `T<turn> · E<event>`, in the order the drill-down wants, and
each session ends with the command already assembled:

```text
### claude 3ab9fe0e  2026-09-13T03:33:32Z → 2026-09-13T05:52:59Z  (2 命中)
  T9 · E491 tool_call(Bash)  …curl --max-time 5 …
    ↳ 1session turn 3ab9fe0e 9 --event 491
```

`T?` means the session recorded no turn containing that event — drill in with
`turns` first. In `--json`, the handle is `match.turn` and `match.index`.

- `--kind user` is the sharpest filter for "what did I ask about X" — it drops
  the tool noise and leaves only the human's own words.
- `--kind tool_result` finds error text that an agent saw but never quoted back.
- `--regex` switches the query from literal to a regular expression; `--case`
  makes it case-sensitive. Default is literal and case-insensitive, which is what
  you want for CJK queries and for paths.
- `--max-hits n` raises the per-session cap when a session is truncated with
  "另有 N 处".
- `--context n` widens the excerpt around each hit.
- `--include-self` stops hiding the search's own footprint. By default a
  `1session` invocation written in the last five minutes, and the result
  carrying what it printed, are folded out of the hits — the calling agent's
  session is indexed live, so the query is in it because this command put it
  there. Only the live transcript can hold an event timestamped now, so no past
  session is affected, and the count of what was folded is always printed. In
  `--json` these sessions stay in the array, tagged `self` and `suppressed`.

Search is a SQL prefilter that narrows candidate lines, then a regex verifier
that decides. Empty queries are rejected rather than matching everything.

### `workspace`

```
1session workspace [path] [--since 24h] [--limit n] [--digest]
                   [--focus marketing|review|full] [--json]
```

Aggregates every agent's sessions for one directory into a single story:
collaborating agents, a unified cross-agent timeline, and file attribution
(which file was touched by whom, when). `--digest` renders the narrative form.

Use this — not three separate `overview` calls — when the user asks what happened
in a project and more than one agent was involved.

## One session

`<session-id>` accepts a full id, a prefix of 6+ characters, or a raw file path.

### `overview <id>`

Layer 1. Goal (the first user request), instruction trail (every subsequent user
turn with timestamps), end state, statistics table, token accounting, and the
resources the session mentioned. Sections that would require interpretation are
left explicitly blank rather than guessed.

### `turns <id>`

Layer 2. One line per turn: time, duration, event range, file/command/failure
counts, what the user said, what the agent replied. Use it to find the turn
number to drill into.

### `turn <id> <n> [--event k|a-b|a,b,c]`

Layer 3. Every event in a turn. With `--event`, the named events with full
arguments and **untruncated** results — the only way to see what a command
actually printed.

`--event` takes one index (`491`), a range (`491-493`), a list (`491,495,502`),
or a mix, up to 50 events in one call; ranges are clipped to the session, so
`560-999` means "to the end". Reading a tool call usually means reading its
result and the assistant's verdict too, which is the range form in one process
instead of three. `--json` returns an object for a bare index and an array for
anything that asked for more than one.

### `digest <id> [--focus marketing|review|full]`

Compact narrative: goal, changed files, commands, key moments (需求 / 转向 / 受阻 /
结论). `--focus review` leans toward what broke and how it was resolved;
`marketing` toward the story; `full` keeps everything.

## Ledgers

| Command | Answers |
| --- | --- |
| `commands <id> [--failed] [--host h] [--turn n]` | every shell command with exit code, duration, cwd |
| `files <id> [--group project\|runtime\|log\|all]` | every file actually written, with provenance and turn |
| `errors <id>` | failed commands with stderr, plus whether a later same-prefix command succeeded |
| `jobs <id>` | async/background jobs with status, evidence, pid, host, log path |

The file ledger never contains `candidate` paths — a path only enters after a
write is proven. Here-doc bodies are stripped before command analysis, so source
code being written to a file cannot masquerade as a redirect or an `ssh` host.

## Index and graph

```
1session index [<session-id>] [--all] [--scope <path>|cwd|global] [--force] [--since 30d]
1session graph <session-id> [--json]        # alias: related
```

`index` refreshes the store; `--all` backfills. Normally unnecessary — every
read path indexes on demand. Reach for `index --all --global --force` only when
results look stale after an upgrade.

`graph` shows edges between sessions with the evidence for each: `→` means this
session read the other one, `←` means the other read this one. Edge relations
include `references`, `handoff_from`, `forked_from`, `resumed_from`, `sends_to`.

## Programmatic API

When a task needs computation over many sessions rather than a few CLI calls,
import the library instead of shelling out repeatedly:

```ts
import {
  listRecentSessions, findSessionsByWorkspace, loadSession, parseSession,
  distillSession, aggregateWorkspaceSessions, searchSessions,
  buildOverview, summarizeTurns, turnDetail, eventDetail, eventDetails,
  turnStarts, turnNoAt,
} from '@1agents/session-reader';

const hits = await searchSessions('小红书', { workspace: process.cwd(), since: '24h', kinds: ['user'] });
hits[0].matches[0].turn;                       // the T of the T·E handle
const overview = buildOverview(await loadSession('01a0907c'));
const full = await eventDetail(session, 11);   // untruncated tool output
const around = await eventDetails(session, '11-13');
```

`searchSessions` takes `selfSessionId` to name the caller explicitly (it
defaults to `SESSION_READER_CALLER_SESSION`); hits from it come back tagged
`self` rather than dropped, so a caller decides whether to show them.

`loadSession` goes through the index; `parseSession` reads the source file
directly. Requires Node.js >= 22.5 (built-in `node:sqlite`), zero runtime deps.
