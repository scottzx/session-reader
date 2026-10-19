# 1session — full CLI reference

Read this when SKILL.md doesn't cover the flag you need.

- [Global flags](#global-flags)
- [Discovery: list, projects, search, workspace](#discovery)
- [One session: overview, turns, turn, digest](#one-session)
- [Ledgers: commands, files, errors, jobs](#ledgers)
- [Index and graph](#index-and-graph)
- [Programmatic API](#programmatic-api)

## Global flags

| Flag | Effect |
| --- | --- |
| `--json` | Machine-readable output instead of the rendered text. |
| `--no-index` | Bypass the SQLite index and read the raw files. Use it to explicitly skip cache writes, retry a read on an older installation with an unwritable index, or verify a suspicious result (it is slower). |

The index lives at `~/.1agents/session-reader/index-v3.db`. It fingerprints each
session file (size + mtime + head hash) and reparses only changed bytes, so
`list` never silently truncates older sessions no matter how wide `--scope` is.
Search, listing and session reads automatically bypass an index that cannot be
opened or written due to permissions or a read-only filesystem. The fallback
warning goes to stderr and does not alter JSON on stdout. `index` and `graph`
still require a writable index; unrelated database errors are not hidden.

DSH supports v2 and v4 transcripts, plain or zstd-compressed. When both remain
after a migration, the current format wins and the session ID stays unchanged.
Unknown versions produce a `SESSION_FORMAT_UNSUPPORTED` warning on stderr with
the source path; they are skipped without falling back to an older transcript.
The warning does not alter the JSON on stdout. A zero-match result therefore
does not establish absence from any sources named in those warnings.

## Discovery

### `list`

```
1session list [--limit n] [--scope <path>|cwd|global] [--global]
              [--provider claude|codex|antigravity|grok|dsh] [--since 24h] [--json]
```

Most recently updated sessions first. Columns: provider, 8-char id, updated-at,
workspace basename, title.

`--since` accepts `24h`, `7d`, `30d` and similar.

### `projects`

```
1session projects [--weekly] [--page n] [--limit n] [--scope <path>|cwd|global] [--global]
                  [--project-map file.json] [--timezone Asia/Shanghai]
                  [--provider claude|codex|antigravity|grok|dsh] [--json]
```

Defaults to all projects, page 1, 20 projects per page. Merges providers by
canonical workspace, Git repository (including subdirectories and worktrees),
and normalized origin across clones. SSH and HTTPS origins match; credentials
are omitted. Nested repositories and forks remain separate. Same-named paths
without repository evidence remain separate. Names come from the origin repo,
repository root, or final workspace directory, in that order.
Columns: name, last-modified time, providers, session count, directory count, representative path.
Last-modified time means the newest **session creation time**, never file mtime
or the last transcript event. Undated projects sort last; ties sort by path.
Sessions without a workspace are omitted; historical paths need not still exist.

Grouping and sorting happen before pagination. `--page` and `--limit` must be
positive integers. JSON returns `{ projects, total, page, limit, hasMore, nextPage? }`;
Each project has `id`, `name`, `workspace`, `workspaces`, `mergeSource`
(`workspace`, `git`, or `mapping`), `createdAt?`, `updatedAt?`, `sessionCount`, and `providers`.
The final page omits `nextPage`; pages past the end return an empty `projects`
array with the original total. Use `--scope cwd` to narrow to the current subtree.

`--project-map file.json` explicitly merges moved/deleted paths that Git cannot
identify. The JSON array contains `{ id, name, workspaces: [path, ...] }` entries.
IDs and canonical paths must be unique; longest subtree prefix wins, so an
independent nested project can override its parent. The first path is the
representative. Mappings override Git resolution; relative paths resolve from
the command's working directory. History is never changed.

`--weekly` pages **weeks**, newest first, using session creation time and local
Monday–Sunday boundaries. Defaults to the machine's zone; `--timezone` accepts
an IANA zone and requires `--weekly`. Includes empty weeks between first and last
dated records. Identity and first appearance use the complete selected scope
before pagination; provider/scope filters change that sample.
JSON returns `{ weeks, total, page, limit, hasMore, nextPage?, timeZone, undatedSessionCount }`.
Each week has `week`, `endDate`, `projectCount`, `newProjectCount`,
`cumulativeProjectCount`, `sessionCount`, `providerSessionCounts`, and `projects`.
Each weekly project has `id`, `name`, `workspace`, `sessionCount`, `providers`,
`providerSessionCounts`, and `isNew`. Projects sort by session count, then ID.
Missing/invalid creation times are counted only in `undatedSessionCount`.
Counts include empty/test/review sessions with a workspace. First appearance
is not a launch date; blank weeks are not proof of inactivity or cancellation.

### `search`

```
1session search <query> [--scope <path>|cwd|global] [--global] [--since 24h]
                [--limit n] [--provider name]
                [--kind user,assistant,thinking,tool_call,tool_result]
                [--regex] [--case] [--context n] [--max-hits n]
                [--area dialogue|tools|artifacts|all] [--session <id>]
                [--terms <JSON array>] [--operator and|or] [--sort relevance|time]
                [--cursor <cursor>] [--include-self] [--json]
```

Keyword search across sessions; defaults to user/assistant text and persisted
provider titles/summaries. Tools and artifacts are opt-in through `--area`.
AND terms match one message or one native tool call with its results; OR matches
any term. Default order is field relevance, then newest time and stable tie breaks.
`--sort time` prioritizes newest time. JSON includes fields, ranges, groups and
`nextCursor`; repeat the same query and filters with `--cursor` to continue.

Event hits carry `T<turn> · E<event>` and a stable `locator`. Metadata and artifact
hits belong to the session level. Event handles are in the order the drill-down wants, and
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

Layer 3. Visible user/assistant dialogue plus a tool directory by default.
With `--event`, read the selected events explicitly, including tool arguments,
results or thinking. Long content uses cursors rather than silent truncation.

`--event` takes one index (`491`), a range (`491-493`), a list (`491,495,502`),
or a mix, up to 50 events in one call; ranges are clipped to the session, so
`560-999` means "to the end". Reading a tool call usually means reading its
result and the assistant's verdict too, which is the range form in one process
instead of three. `--json` returns a page object with `items` and optional
`nextCursor` for both single and batch reads.

### `digest <id> [--focus marketing|review|full]`

Compact narrative: goal, changed files, commands, key moments (需求 / 转向 / 受阻 /
结论). `--focus review` leans toward what broke and how it was resolved;
`marketing` toward the story; `full` keeps everything.

### Exact and paginated content reads

```bash
1session turn 'claude:<full-id>' 1-3 --json
1session turn 'claude:<full-id>' --locator '<event:reference>' --json
1session turn 'claude:<full-id>' --call '<native-call-id>' --json
1session turn 'claude:<full-id>' --artifact '<registered-path>' --json
1session turn 'claude:<full-id>' --event 11 --raw --json
```

Default turn content includes every visible user/assistant message and a tool
metadata directory. Tool parameters, results and thinking are read explicitly.
`--raw` returns original JSONL records, including omitted instruction envelopes.
Pages default to 32,000 characters; `--max-chars` changes the budget. Repeat the
same selector with `--cursor` using `nextCursor`, until no cursor remains.
`offset` and `totalChars` preserve precise progress; changed sources invalidate
cursors. Prefer canonical `provider:full-id`; ambiguous prefixes fail with candidates.
Native event locators remain stable across appends, positional fallbacks include a
record checksum. Numeric turns/events are convenience addresses of the current parse.

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

## Standalone web UI

```
1session web [--port 7780] [--host 127.0.0.1] [--open] [--scope <path>|cwd|global]
```

A local browser for the same session list, chat preview and file ledger the DSH
plugin shows. Does not require DSH. Default bind is loopback `127.0.0.1:7780`.

The listing is metadata-only; clicking a row loads that session's turns and
files. `--open` launches the default browser. `--scope global` starts the UI
on every workspace; a path scopes "当前工作区" to that directory.

This is not `1session serve`. `serve` is the DreamMate Network JSON service;
`web` is a human-facing page.

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


## Opt-in semantic search (since 0.11.0)

Probe `1session help` first: versions before 0.11.0 do not expose these flags.
Default keyword search remains unchanged. A natural-language question may use:

```sh
1session index --all --scope /absolute/project
1session index build --semantic --scope /absolute/project --model qwen3 --json
1session index status --semantic --scope /absolute/project --json
1session search 'why was this plugin split out' --scope /absolute/project --mode semantic --json
```

Only explicitly build on user-approved local sources. Search never builds automatically.
Check `retrieval.partial`, `pendingEvents`, `skippedEvents` and `rawSourceDiscovery:false`:
coverage is the structural-index snapshot, NOT all raw history or all devices.
Semantic JSON is `{hits,retrieval}`; keyword JSON retains its old shape.
Both CLI and DSH `session_search` accept `mode: keyword|semantic` and `model: qwen3|embeddinggemma2`.
Qwen uses the existing document_search profile; Gemma document indexing needs the updated shared client.
Errors are explicit, never silently mix models. Only dialogue is indexed; no tool/thinking text.
The first implementation limits chunks and questions to 320 UTF-8 bytes (not tokens).
Read full original evidence with `turn <provider:id> --locator <exact-locator>` after finding a candidate.
Similarity is not correctness or proof of implementation; check later corrections and timestamps.
Raw transcripts are never changed. Separate semantic-v1.db stores vectors; index-v3.db is structural.
Do not point old CLI versions at the new DB or delete unknown-schema stores to make a query pass.
