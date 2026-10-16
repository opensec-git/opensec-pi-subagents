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

- Pi: this Node build loads and runs a real turn on Pi 0.87.1 and Pi 1.0.0 (both on Node). The peer-dependency
  range is `>=0.84.0`; earlier versions were not re-tested.
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

`tools:` limits built-in tools only. Tools registered by extensions stay available unless the file sets
`extensions: false` (or names the extensions to load), or lists `ext:` selectors in `tools:`, which turns extension
tools into an allowlist. The built-in `Explore` and `Plan` agents get `read`, `grep`, `find` and `ls` and no extension
tools, so they cannot write files or run commands; a file named `Explore.md` or `Plan.md` replaces them if you want
them to have more.

### Project trust

Subagents follow Pi's project trust decision for the parent session.

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
