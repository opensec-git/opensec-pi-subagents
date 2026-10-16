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
| `get_subagent_result` | Returns the full result of an agent. |
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

The join mode (`/agents → Settings → Join mode`, `defaultJoinMode`) decides whether a result waits for its siblings:

| Mode | Behaviour |
|---|---|
| `smart` (default) | No waiting: each result is delivered at the parent's next boundary. `async` is accepted as an older name for it. |
| `group` | The background agents spawned in one parent turn report together, in one notification once all of them have finished (a lone spawn reports alone). A 30 s timeout after the first completion sends a partial notification; stragglers follow within 15 s. |

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
  file, under the same id, for as long as that file exists. Sessions are saved by default (`rememberAgents`; turn it
  off and agents are resumable only for those ten minutes).
- What survives a restart, `/resume`, `/fork` or `/reload`: finished agents of that session (on its branch, for a fork)
  stay resumable by the model and by `@handle`. Agents still running are stopped, as before, and recorded as stopped
  and resumable. `/new` starts with none. Nested agents can be resumed by their parent while their parent's manager
  lives; across a restart only top-level agents are rebuilt.
- In workflows, `agent(prompt, { resume: label })` continues a child of the same run the same way, also after its record
  was evicted.

### Custom agents

Put custom definitions in `.pi/agents/<name>.md` or the global Pi agents directory. Agents inherit the current parent's
model and thinking level unless their definition or call overrides them.

`isolated: true` (on a call or in an agent file) removes extension and MCP tools, skills, `ext:` selectors and nested
delegation. It is not a sandbox: the agent still inherits Pi's environment variables (including provider keys its
`bash` can read), the parent's model registry and auth, global and trusted project settings (shell, command prefix,
retry, compaction), and, for append-mode agents such as `general-purpose`, the parent's whole system prompt.

The agent file wins over the caller for `isolated:` and `isolation:`; a call's value applies only when the file leaves
the field unset. This holds on every spawn path: the `Agent` tool, `@handle` mentions (direct mode and the fallback
when a mention clone fails), resumed and reopened agents, cross-extension RPC and the manager registry. So
`isolation: off` in a file refuses a caller's `isolation: "worktree"`, and an `isolation: worktree` file gets its
worktree even when the caller asked for none; outside a git repository such an agent fails to start instead of running
in the main checkout. Two exceptions: in a workflow, only the script's `agent()` option decides `isolation` (as in Claude
Code; `isolated:` from the file still applies), and an agent reopened from its session file continues where it ran.

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

By default (`projectTrust: "full"`) subagents and this extension trust every project: a child session loads the
project's `.pi/extensions` and `.pi/settings.json`, and the extension uses the project's agents, skills, workflows and
`subagents.json`, whatever Pi decided for the parent session.

To have them follow Pi's project trust decision instead, set `"projectTrust": "pi"` in the global
`~/.pi/agent/subagents.json` (a project's own file cannot change it). Then:

- In a folder Pi does not trust, subagents load none of the project's `.pi/extensions`, `.pi/settings.json` (for
  example `shellCommandPrefix`), skills or prompts, exactly like the parent. This extension also ignores the project's
  `.pi/agents`, `.agents/agents`, `.pi/skills`, `.agents/skills`, `.pi/subagents.json`,
  `.pi/agent-tool-description.md` and saved workflows there. A trusted project behaves as before.
- Code the project ships for this extension needs a recorded decision: saved workflows in `.pi/workflows` or
  `.agents/workflows`, and path entries in a project agent's `extensions:`. Pi trusts a folder without asking when
  it holds nothing Pi gates (agent and workflow folders are not gated), so these run only when the folder was trusted
  at Pi's prompt, by `defaultProjectTrust` or a CLI flag, or recorded with `/trust`. Otherwise the workflow is refused
  and the extension path is skipped with a warning; the rest of the agent file still applies.
- A project agent file named `general-purpose`, `Explore` or `Plan` replaces the built-in agent. A warning names the
  file, and the `Agent` tool's type list marks the type as defined by the project.
- The extension starts before Pi asks about trust. A folder you trust at the prompt gets its project agents and settings
  for that session, but the `Agent` tool's description, built at startup, lists them from the next session on.

## Configuration

| Setting | Default | Meaning |
|---|---|---|
| Background concurrency (`/agents → Settings`) | `10` | How many background agents run at once. |
| `backgroundKey` (`subagents.json`) | `ctrl+b` | Key that sends running foreground `Agent` calls to the background (see [Sending a foreground agent to the background](#sending-a-foreground-agent-to-the-background)); `"off"` disables it. |
| Tool timeout (`/agents → Settings`, `toolTimeoutSeconds`) | `1200` | Seconds one subagent tool call may run (`0` = no limit). A `bash` call is killed at the limit and the agent sees the timeout; any other tool still running a minute later is stopped and the agent is told to continue another way (up to 3 times per run). The main agent's `bash` calls get the same timeout when they set none; a timeout the main agent asks for is kept. |

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
