<p align="center">
  <img src="https://pi-bolt.opensec.in/plugins/opensec-pi-subagents.svg" width="96" height="96" alt="Subagents for Pi logo">
</p>

<h1 align="center">Subagents for Pi</h1>

<p align="center">Run specialized Pi agents in separate sessions, inheriting the parent's model and thinking level, with cached agent discovery.</p>

<p align="center">
  <img alt="Pi extension" src="https://img.shields.io/badge/Pi-extension-2A78D6?style=flat-square">
  <img alt="Node build: latest" src="https://img.shields.io/badge/node-latest-4C96EA?style=flat-square&logo=nodedotjs&logoColor=white">
  <img alt="Bun build: @bun" src="https://img.shields.io/badge/bun-%40bun-F7C04A?style=flat-square&logo=bun&logoColor=black">
  <img alt="License: proprietary" src="https://img.shields.io/badge/license-proprietary-555?style=flat-square">
</p>

## Install

| Runtime | Command |
|---|---|
| **Pi on Node** (`latest`) | `pi install npm:@kushalkhemka/opensec-pi-subagents` |
| **pi-bolt** (`bun`) | `pi-bolt install npm:@kushalkhemka/opensec-pi-subagents@bun` |

> Pick the one that matches the Pi you run: `pi-bolt` → `@bun`; Pi on Node → the plain name.
> The builds are maintained per runtime and can differ in details (the Bun README lists what differs). These are private packages: log in to npm with an account that can read
> `@kushalkhemka` first (`npm login`), or put a read token in `~/.npmrc`.
>
> pi-bolt and Node Pi share `~/.pi/agent`, so installing the `@bun` build with either command replaces the Node
> build for both. To run both side by side, give one of them its own agent dir with `PI_CODING_AGENT_DIR`.

Restart Pi or run `/reload` after installing. Update with `pi update --extensions` (pi-bolt: `pi-bolt update --extensions`); remove with
`pi remove npm:@kushalkhemka/opensec-pi-subagents` (pi-bolt: `pi-bolt remove npm:@kushalkhemka/opensec-pi-subagents`).

### Requirements

- Pi 1.1.0 or newer (peer range `>=1.1.0`, the test suite runs against Pi 1.1.0). `typebox` is a `"*"` peer that Pi
  supplies; `@sinclair/typebox` is no longer used.
- Install only one Subagents package at a time: the public and private packages expose the same tools.

## Features

This maintained fork of `@tintinweb/pi-subagents` runs specialized Pi agents in separate sessions while the main agent
continues working, and adds parent model and thinking-level inheritance and cached agent discovery.

- Background agents by default, with optional foreground runs, steering, result retrieval, and session resume.
- Built-in `Explore` and `Plan` agents for read-only work, plus a general-purpose agent and custom agent definitions.
- Parallel and staged workflows through `SubagentWorkflow` (`agent()`, `parallel()`, `pipeline()`).
- An `/agents` UI for live conversations, settings, workflows, and scheduled jobs.
- Optional nested delegation, persistent memory, skill preloading, and Git worktree isolation.

## Usage

Ask Pi to delegate work, for example: “Use an Explore agent to find the authentication code, then report the relevant
files.” Pi can call the `Agent` tool like this:

```text
Agent({ subagent_type: "Explore", prompt: "Find authentication code", description: "Find auth files" })
```

### Tools

| Tool | What it does |
|---|---|
| `Agent` | Starts an agent. A background run returns an ID and notifies the main session when it finishes; set `run_in_background: false` when the next step must wait for its result. Also accepts session-scoped cron, interval, and one-shot schedules. |
| `get_subagent_result` | Returns the full result of a finished agent, also after its record was released from memory. For an agent still running it says to wait for the completion notification instead of checking again (`wait: true` blocks, and is off by default). |
| `steer_subagent` | Redirects a running agent. |
| `SubagentWorkflow` | Runs repeatable multi-agent work (`agent()`, `parallel()`, `pipeline()`). |

### Commands

| Command | What it does |
|---|---|
| `/agents` | Inspect and manage agents: live conversations, settings, workflows, and scheduled jobs (`/agents → Scheduled jobs`). |
| `@<agent> <message>` | With agent mentions enabled, sends a message to that agent, e.g. `@explore check the RPC path`. A finished agent is resumed (see [Resuming agents](#resuming-agents)). |

### Background completions

When a background agent (or workflow) finishes, the main session is notified, as in Claude Code:

- A busy parent gets the notification after its current batch of tool calls, before its next model call; running tools
  are not interrupted. Everything that finished during that batch arrives as one message.
- An idle parent gets a turn about 200 ms after a completion, together with anything else that finished in that window.
- If you interrupt the parent (`Esc`), what was waiting is kept and delivered once the interrupted turn has stopped,
  starting a turn.
- Reading a result with `get_subagent_result` (or the RPC `consume`) before the notification is sent suppresses it.
- A notification carries the first 10 lines of the result (at most 500 characters, 300 per agent in a group), the
  full result's size in `<result_bytes>`, the model and thinking level the run used (`<model>`, `<thinking>`), and,
  when anything was cut, how many lines and bytes were left out. `get_subagent_result` returns the rest.
- A result that lands while another session is open, or that is still waiting for its parent's boundary when you switch
  away, is recorded in its own session and delivered the same way when you return there (see
  [Switching sessions](#switching-sessions)).

The join mode (`/agents → Settings → Join mode`, `defaultJoinMode`) decides whether a result waits for its siblings:

| Mode | Behaviour |
|---|---|
| `smart` (default) | No waiting: each result is delivered at the parent's next boundary. `async` is accepted as an older name for it. |
| `group` | The background agents spawned in one parent turn report together, in one notification once all of them have finished (a lone spawn reports alone). A 30 s timeout after the first completion sends a partial notification; stragglers follow within 15 s. |

### Failed runs

An agent that ends in an error, is aborted at its turn limit, or is stopped by the user is reported to the main agent
as an error result (`isError`), not as a completed task: the foreground `Agent` result, a resumed run, and
`get_subagent_result`, top-level and nested. So are lookups of an unknown agent and refused steers or resumes.

- The result keeps the run's last assistant text (`Partial output before the failure:` for an error), also when the
  run threw or a stopped run had to be abandoned, and names the agent's saved session file, which holds every turn.
  The background notification carries the file as `<session-file>`.
- A run the user stopped says so (`Agent was stopped by the user …`, `STOPPED BY THE USER`). A run the end of the parent
  session interrupted (quit, `pi -p` exiting after a provider error, SIGTERM) says that instead (`interrupted when the
  parent session ended`, recorded as `stopCause: "session-end"`), and that the agent can be resumed.
- Background notifications of failed, stopped and aborted runs end with `<resume>`, naming the id to pass as `resume`:
  the agent keeps its context, so it is resumed rather than replaced. Only for agents with a saved session.
- Weak models' malformed tool arguments are repaired before Pi validates them: the arguments object sent as a JSON
  string or stuffed into one field, arrays for strings, `null` optional fields, `"true"` or `"5"` for booleans and
  numbers, and a missing `subagent_type` (the default type, under the `fallbackSubagent` policy). A missing prompt is
  never invented.

### Sending a foreground agent to the background

While a foreground `Agent` call runs (`run_in_background: false`), press `ctrl+b` at the prompt to hand it to the
background, as in Claude Code. The same run keeps going (session, in-flight turn, transcript and worktree); the blocked
call returns what a `run_in_background` spawn returns, and the result arrives later as the usual background
notification. `ctrl+b` hands off every running foreground call at once; a dim `(ctrl+b to run in background)` hint
appears under one of them after 2 s. In the conversation viewer (FleetView, `/agents`), `b` hands off just that agent.

- The key is claimed only while a foreground call runs and the prompt editor has focus; otherwise `ctrl+b` keeps its
  editor meaning (cursor left). Rebind it with `"backgroundKey"` in `subagents.json` (a Pi key id such as `alt+b`), or
  turn it off with `"backgroundKey": "off"`.
- After the handoff, `Esc` on the parent turn no longer stops the agent; `x` in the viewer and `/agents` still do. The
  run moves from the foreground to the background concurrency pool, over the limit if the pool is full.
- Nested agents, workflow agents, queued spawns and resumed runs cannot be handed off.

### Conversation viewer

Opening an agent (FleetView, `/agents`, the workflow inspector's `c`) shows its conversation drawn by Pi's own chat
components, exactly as Pi draws the main session: user and assistant messages with thinking blocks, each tool call
with its arguments and its tool's own result rendering (edit diffs, read previews, bash command, output, exit status
and duration, running/done/error state), `!` bash runs, compaction and branch summaries, skill blocks and extension
messages. Tool renderers come from the subagent's own session, so an extension tool draws as it does in Pi. A message
that is still streaming and a tool that is still running update live.

- `ctrl+o` expands and collapses tool output, as in Pi (it follows a rebinding of Pi's `app.tools.expand`).
- Pi's `hideThinkingBlock`, `outputPad` and `markdown.codeBlockIndent` settings apply, read when the viewer opens.
- Agent output is sanitized before Pi's components see it: escape and control sequences in messages, tool arguments
  and results are removed (Pi's own styling is kept).
- Not the same as the main session: images in tool results show as Pi's text placeholder (an inline image cannot be
  clipped to a scrolled overlay), Mermaid blocks are not drawn as diagrams (Pi's Mermaid renderer is not available to
  extensions), and clicking a tool block or thinking block does not toggle it (use `ctrl+o`).
- The `viewerMarkdown` setting and the viewer's `m` key were removed in 0.20.4; a `viewerMarkdown` key left in
  `subagents.json` is ignored.
- Cost: each message's component is built once and its rendered lines are kept; a frame re-renders only the streamed
  message and tools that changed, and scrolling never re-renders. Without a JIT (Pi-Bolt) a frame takes about 5 µs and
  a scroll step about 15 µs at any transcript length.

### Fullscreen conversation observer

In Pi's fullscreen mode (`/settings → TUI mode → fullscreen`, Pi's default), an agent opened from FleetView, `/agents`
or the workflow inspector fills the terminal; regular mode keeps the floating viewer. Neither replaces the main session
or pauses an agent, and `Esc` returns to the previous view (while composing, the first `Esc` cancels the draft).

- Mouse-wheel scrolling. Scrolling up pauses following; reaching the bottom resumes it.
- A one-column scrollbar in Pi's style that follows Pi's `/settings → Fullscreen scrollbar`: `auto` appears while
  scrolling or hovering and hides after a second, `always` stays, `hidden` removes it and its mouse target. Drag the
  thumb, or click the track to page. The column is kept free in `auto` mode too, so the bar never re-wraps the text.
- Clickable footer controls (steer, send to background, stop with two clicks, expand tool output, close).
- While scrolled away, the divider above the footer shows `[ ↓ N new messages · Ctrl+End ]` (conversation messages,
  not streaming updates); click it or press `Ctrl+End` to jump back and follow, without losing a steering draft.
- Mouse events are consumed, so they never scroll, select or click the main view underneath. Text selection, copying
  and switching agents without leaving the observer are not implemented.
- Cost: built on the viewer's incremental transcript, so scrolling, wheel and drags reuse cached lines, a frame checks
  only what changed and draws only the visible rows, and nothing ticks while it is idle (a running bash tool's elapsed
  time redraws its block once a second, as in Pi). Without a JIT (Pi-Bolt), a frame or a scroll step costs well under a
  millisecond whatever the transcript's length.

### Resuming agents

Every agent result names the agent: `Agent ID: <id>` (foreground and background results alike). Pass it back to continue
the same conversation instead of starting a fresh agent:

```text
Agent({ resume: "<id>", prompt: "Now check the tests too", description: "Continue audit", subagent_type: "Explore" })
```

- `resume` accepts the id or the agent's handle (`explore`, `explore-2`, or its `name`). It runs detached unless
  `run_in_background: false`; `subagent_type` is ignored. A running agent cannot be resumed: steer it instead.
- The resumed run keeps what the agent ran with: its model, the thinking level saved in its session, its working
  directory, `isolated`, and its turn limit (`max_turns` on the resume call replaces it), with the same grace turns and
  tool timeout as a first run.
- A worktree agent resumes in its worktree: it is restored at the same path from the agent's branch, and the new work
  is committed to that branch afterwards. If the branch is gone the resume is refused and nothing runs.
- How long: a finished agent stays in memory for about ten minutes; after that it is reopened from its saved session
  file, under the same id, for as long as that file exists, and `get_subagent_result` reads its status, model and
  final result from that file (marked as read from the saved session). Sessions are saved by default (`rememberAgents`;
  turn it off and agents are resumable only for those ten minutes). The last 2000 such agents of a session stay
  addressable, and 4000 nested and workflow children, at a few hundred bytes each.
- What survives a restart, `/resume`, `/fork` or `/reload`: finished, stopped and failed agents of that session (on its
  branch, for a fork) stay resumable by the model and by `@handle`. Agents still running when the session ended are
  named once, by id, in a notice ahead of the first prompt of the next start of that session (`pi -p --session-id`,
  `/resume`), which says to resume them with `Agent({ resume })`; a `subagents:interrupted-notice` entry records it. `/new` starts with none. Nested agents and workflow children are
  rebuilt too (their resume state is written to the parent session as `subagents:resume` entries, one small entry per
  settled child): a nested agent stays resumable by the agent that owns it, once that agent is resumed under its id.
- In workflows, `agent(prompt, { resume: label })` continues a child of the same run the same way, also after its record
  was evicted. `resumeFromRunId` finds a run of the same session after a restart or `/resume` by its files, and a child
  it replays from the journal can still be continued with `agent({ resume })`: the journal records which agent
  produced each answer.

### Switching sessions

Background agents keep running when you switch sessions with `/new`, `/resume`, `/fork` or `/reload`, as long as the
session that started them is saved (it has a session file).

- An agent belongs to the session that started it. While another session is open it does not show in that session's
  widget, FleetView, `/agents` lists or `@` suggestions, and `get_subagent_result`, `steer_subagent` and `resume` there
  do not find it. It still counts toward the background concurrency limit.
- If it finishes while another session is open, its result is written into its own session (a `subagents:record`
  entry marked `pending`) and nothing is sent to the open session. When you return to its session the result arrives as
  the usual completion notification, and the main agent takes a turn on it. The same happens after a restart if the
  result was recorded but not yet delivered.
- Its nested agents keep running with it. Foreground agents (Pi interrupts their tool call; send one to the background
  with `ctrl+b` first to keep it), workflows, `@mention` prompts in flight and agents of a session kept only in memory
  stop at a switch, as before, and are recorded as stopped.
- Quitting (`/quit`, Ctrl+D, SIGTERM, SIGHUP) stops every agent and saves worktrees, as before. If Pi exits while a
  switch is still in progress, the agents are recorded as stopped; their worktrees are recovered at the next start.
- After updating this package, the first `/reload` (or switch) loads the new version, which cannot take over the old
  version's running agents: they are stopped and recorded as stopped and resumable.

### Model and thinking level

A subagent runs on the parent's current model at the parent's current thinking level, on every spawn path: the `Agent`
tool, nested delegation, workflow `agent()`, `@mentions`, scheduled jobs and cross-extension RPC. For a nested agent the
parent is the agent that spawned it.

- An agent file's own `model:` or `thinking:` is your configuration and always applies. `model:` takes an exact
  `provider/id`, or a short name such as `haiku`. Among a short name's closest matches, the parent's provider wins when
  it serves one, and matches from one provider resolve to the tightest. A name whose matches span several other
  providers, or that matches nothing, is not guessed at: the agent runs on the parent's model and its result starts
  with a note naming the model asked for, why it was not used (with up to five candidates for an ambiguous name), and
  the model used instead. Workflows show the note as a warning. Spawns that pass no model of their own (`@mentions`, RPC, scheduled
  jobs) match the agent file's `model:` by exact `provider/id` only, and note a fallback the same way.
- A model passed per call (with `allowModelOverride`) resolves the same way; one that is ambiguous across providers or
  unknown is refused with the candidates.
- Per-call choices are ignored by default: the `Agent` tool and the nested tool do not offer `model` or `thinking`,
  workflow `agent({ model, effort })` is ignored, and so are a scheduled job's and an RPC spawn's model and thinking
  level. This keeps the main model from picking cheaper models or lower effort on its own.
- A resumed agent keeps the model and thinking level it ran with. Each run records the model and level it actually ran
  with; the foreground result, `get_subagent_result` and the notification show them.
- `allowModelOverride: true` (project or global `subagents.json`, or `/agents → Settings → Model override`) restores the
  per-call overrides and the tool parameters. The resolution changes at once; the tool parameters at the next session.

### Custom agents

Put custom definitions in `.pi/agents/<name>.md` or the global Pi agents directory. Agents inherit the current parent's
model and thinking level unless their definition sets one (see [Model and thinking level](#model-and-thinking-level)).

`isolated: true` (on a call or in an agent file) removes extension and MCP tools, skills, `ext:` selectors and nested
delegation. It is not a sandbox: the agent still inherits Pi's environment variables (including provider keys its
`bash` can read), the parent's model registry and auth, global and trusted project settings (shell, command prefix,
retry, compaction), and, for append-mode agents such as `general-purpose`, the parent's system prompt. That prompt
drops the lines of tools the agent does not have (each such tool's `- name: …` line and its own guidelines, matched
exactly): the orchestration tools, built-ins it was not given, denied tools and tools of extensions it does not load.

The agent file wins over the caller for `isolated:` and `isolation:`; a call's value applies only when the file leaves
the field unset. This holds on every spawn path: the `Agent` tool, `@handle` mentions (direct mode and the fallback
when a mention clone fails), cross-extension RPC and the manager registry. So
`isolation: off` in a file refuses a caller's `isolation: "worktree"`, and an `isolation: worktree` file gets its
worktree even when the caller asked for none; outside a git repository such an agent fails to start instead of running
in the main checkout. Two exceptions: in a workflow, only the script's `agent()` option decides `isolation` (as in Claude
Code; `isolated:` from the file still applies), and an agent reopened from its session file continues where it ran
(its `isolated:` is read from the file again).

`tools:` limits built-in tools only. Tools registered by extensions stay available unless the file sets
`extensions: false` (or names the extensions to load), or lists `ext:` selectors in `tools:`, which turns extension
tools into an allowlist. The built-in `Explore` and `Plan` agents get `read`, `grep`, `find` and `ls` and no extension
tools, so they cannot write files or run commands; a file named `Explore.md` or `Plan.md` replaces them if you want
them to have more.

Pi's built-in codemode and tool search (`builtin:codemode`, `builtin:tool-search`) load in subagents as in the main
session: on with `extensions: true`, kept or dropped by `extensions:` and `exclude_extensions:` like any other
extension (address them by the full `builtin:` name), and off for everyone with `-builtin:<name>` in Pi's `extensions`
setting or `--no-extensions`. Pi's built-in MCP (`builtin:mcp`) is the exception: subagents do not load it, so no
child starts its own set of `mcp.json` servers, unless the agent file names it, e.g. `extensions: ["*", builtin:mcp]`
(`--no-mcp` still keeps it out). MCP tools are reached through codemode or `tool_search`, so an `ext:` allowlist must
name that bridge too: `tools: "read, ext:builtin:codemode, ext:builtin:mcp/mcp__srv__search"`. A bare
`mcp__<server>__<tool>` name in `tools:` is reported as an unknown built-in (`tools-error:`); name MCP tools with
`ext:builtin:mcp/<tool>`.

A subagent activates only the tools Pi itself would declare to the model: `direct` and `model-only` tools, minus those
registered with `defaultActive: false` unless the agent names them (`ext:foo/bar`). `codemode` and `deferred` tools
(Pi's MCP tools) stay undeclared until codemode or `tool_search` reaches them. Calls a tool makes through
`ctx.executeTool()`, such as a codemode script calling another tool, go through the same scope check as the model's
own calls; out-of-scope tools are blocked but can still appear in codemode's `searchTools()` and `tool_search` results.

### Project trust

By default (`projectTrust: "pi"`) subagents and this extension follow Pi's project trust decision:

- In a folder Pi does not trust, subagents load none of the project's `.pi/extensions`, `.pi/settings.json` (for
  example `shellCommandPrefix`), skills or prompts, exactly like the parent.
- This extension uses the project's own files only in a project you trusted: agent files in `.pi/agents` and
  `.agents/agents` (and the paths their `extensions:` name), `.pi/subagents.json`, `.pi/agent-tool-description.md`, and
  saved workflows in `.pi/workflows` and `.agents/workflows`. "You trusted" means you trusted the folder at Pi's prompt,
  `defaultProjectTrust` is `"always"`, or `/trust` recorded it. Pi trusts a folder without asking when it holds nothing
  Pi gates, and these folders are not gated, so a cloned repo that ships only `.pi/agents` does not get its agents used
  until you run `/trust`. Otherwise a project agent named `general-purpose` would replace the built-in agent without
  any prompt.
- When it leaves a project's agents out, the extension says so once at session start, naming them, and an `Agent` call
  for one of them says why it fell back (or was refused). To use them, run `/trust` in Pi, then restart Pi.
- A project agent file named `general-purpose`, `Explore` or `Plan` replaces the built-in agent. A warning names the
  file, and the `Agent` tool's type list marks the type as defined by the project.
- The extension starts before Pi asks about trust. A folder you trust at the prompt gets its project agents and settings
  for that session, but the `Agent` tool's description, built at startup, lists them from the next session on.

To trust every project instead, as before 0.20.1 and in 0.20.2 to 0.20.8, set `"projectTrust": "full"` in the global
`~/.pi/agent/subagents.json`: a child session then loads the project's `.pi/extensions` and `.pi/settings.json`, and the
extension uses the project's agents, skills, workflows and `subagents.json`, whatever Pi decided. A project's own
`subagents.json` cannot set `projectTrust`.

## Configuration

| Setting | Default | Meaning |
|---|---|---|
| Background concurrency (`/agents → Settings`) | `10` | How many background agents run at once. |
| `backgroundKey` (`subagents.json`) | `ctrl+b` | Key that sends running foreground `Agent` calls to the background (see [Sending a foreground agent to the background](#sending-a-foreground-agent-to-the-background)); `"off"` disables it. |
| Model override (`/agents → Settings`, `allowModelOverride`) | `false` | Whether a spawn's own `model` / `thinking` (Agent tool, nested tool, workflow `agent()`, scheduled jobs, RPC) may choose the subagent's model and thinking level. Off: subagents run on the parent's current model and level unless their agent file sets one, and the tools do not offer the parameters. |
| Tool timeout (`/agents → Settings`, `toolTimeoutSeconds`) | `1200` | Seconds one subagent tool call may run (`0` = no limit). A `bash` call that sets no `timeout` gets this one and is killed at it, and the agent sees the timeout; a timeout the call sets is kept, longer or not. The watchdog stops any call still running a minute past its own limit (its `bash` timeout, a codemode script's deadline, else this) and tells the agent to continue another way (up to 3 times per run). The main agent's `bash` calls get the same timeout when they set none. |
| `watchdogExemptTools` (`subagents.json`) | `["second_opinion_agent"]` | Tools the subagent tool watchdog never stops, because they keep their own deadline. A list here replaces the default. |
| `codemodeTimeoutSeconds` (`subagents.json`) | `1800` | Deadline in seconds for a Pi `codemode` script whose first line sets no `timeout_ms` (`0` = none), in the main agent and in subagents; a deadline the script sets is kept. Every call a script makes is logged raw to `$PI_CODEMODE_AUDIT_DIR/<session>/<call id>.log` (default `<agent dir>/opensec/codemode/`, capped at `PI_CODEMODE_AUDIT_MAX_BYTES`, default 16 MiB), and the script's result names the file. |

## Notes

- Schedules: interval schedules must be at least `1m` (stored shorter intervals are raised to one minute); intervals and
  relative delays are capped at `3650d`.
- Worktree isolation is optional and commits an isolated agent's changes to its branch on completion. The worktree is
  removed afterwards unless that would delete work a branch cannot carry: files git ignores that the agent created
  (dependency, cache and build directories such as `node_modules`, `dist`, `build` and `coverage` do not count), or git
  repositories it created or changed inside the worktree. Then the worktree is kept and the result names its path and
  the reason; remove it with `git worktree remove --force <path>` when you are done. Stash entries made while the
  agent ran are reported too, since they are not on the branch.
- A running agent's worktree is locked (`git worktree lock`) with its process id. When pi starts in a repository, a
  worktree whose process is gone (pi was killed or crashed) has its uncommitted work committed to
  `pi-agent-<id>-recovered` and is removed unless it holds work a branch cannot carry; you are told either way.
  Worktrees of agents running in another pi are left alone, and unlocked agent worktrees that still hold changes or
  ignored files are only reported. At the same start, `pi-agent-*` branches already merged into `HEAD` whose last
  commit is more than 7 days old are deleted (`git branch -d`); resuming such an agent afterwards is refused.
- A workflow `gate` on an isolated agent runs after the agent's changes are committed; whatever the gate changes
  (snapshots, coverage, build output) is discarded and never reaches the branch.
- A worktree agent's `memory: project` and `memory: local` directories are in the real project, not the copy, so
  they outlast the worktree.
- Review `/agents → Settings` before enabling delegation or isolation for write-capable agents.

## Security

Workflow scripts run in a vm that is a determinism and accident boundary, not a defence against a deliberately hostile
script; see [`docs/workflows.md`](docs/workflows.md).

## License

Proprietary. © 2026 OpenSec. All rights reserved. Includes `@tintinweb/pi-subagents` (MIT); see LICENSE.

Based on `@tintinweb/pi-subagents` by tintinweb.
