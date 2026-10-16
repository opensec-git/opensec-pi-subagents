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
| `@<agent> <message>` | With agent mentions enabled, sends a message to that agent, e.g. `@explore check the RPC path`. A finished agent can be resumed. |

### Custom agents

Put custom definitions in `.pi/agents/<name>.md` or the global Pi agents directory. Agents inherit the current parent's
model and thinking level unless their definition or call overrides them.

## Configuration

| Setting | Default | Meaning |
|---|---|---|
| Background concurrency (`/agents → Settings`) | `10` | How many background agents run at once. |
| Tool timeout (`/agents → Settings`, `toolTimeoutSeconds`) | `1200` | Seconds one subagent tool call may run (`0` = no limit). A `bash` call is killed at the limit and the agent sees the timeout; any other tool still running a minute later is stopped and the agent is told to continue another way (up to 3 times per run). The main agent's `bash` calls get the same timeout when they set none; a timeout the main agent asks for is kept. |

## Notes

- Schedules: interval schedules must be at least `1m` (stored shorter intervals are raised to one minute); intervals and
  relative delays are capped at `3650d`.
- Worktree isolation is optional and commits an isolated agent's changes to its branch on completion.
- Review `/agents → Settings` before enabling delegation or isolation for write-capable agents.

## Security

Workflow scripts run in a vm that is a determinism and accident boundary, not a defence against a deliberately hostile
script; see [`docs/workflows.md`](docs/workflows.md).

## License

Proprietary. © 2026 OpenSec. All rights reserved. Includes `@tintinweb/pi-subagents` (MIT); see LICENSE.

Based on `@tintinweb/pi-subagents` by tintinweb.
