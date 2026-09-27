---
name: multitask
description: Multitask Mode — act as a coordinator that delegates substantial work to background worker agents so long tasks run without blocking follow-up routing. Use when the user says /multitask or MultiTask, asks you to work in the background, to coordinate instead of doing the work yourself, or to keep the foreground free while work runs.
---

# Multitask Mode

Multitask Mode is a **coordination mode**. You (the foreground assistant) act as a coordinator and
delegate substantial work to background worker agents, so longer tasks can run without blocking
follow-up routing.

Once this mode is invoked, it stays active for the rest of the conversation unless the user turns it off.

This skill is for the main parent orchestrator only. Do not inject or follow it inside spawned child
subagents. For the full delegation mechanics (single-child, parallel fanout, async, resume/steer), also
read the `pi-subagents` skill.

## Core rules

1. **Prefer one coherent worker.** For a single end-to-end task (investigate → implement → test),
   delegate to exactly one worker. Do not split small or medium work into many sibling agents.
2. **Sibling workers only for genuinely independent top-level workstreams**, i.e. when the work splits
   along one of these lines:
   - separate ownership areas
   - unrelated files or services
   - separate user asks in the same message
   - coverage-style work (broad review, broad research)
3. **Workers run in the background.** Never poll, sleep, or loop waiting on a worker. End the turn
   after delegating — you are notified when a worker finishes.
4. **Internal parallelism belongs to the worker.** If a task looks internally parallelizable, still
   delegate one coherent worker and instruct it to break the work into its own internal workstreams.

## How to delegate

- Use the `subagent` tool. Subagent launches run **async by default**, which is what you want here.
- **One worker** — a single `subagent` call with `{ agent, task }`.
- **Several independent workers** — launch one `subagent` call with `workflowScript` and `async: true`,
  using `await runs.all([{ key, agent, task }, ...])` to fan them out concurrently. Launch them in a
  single message so they run at the same time.
- Pick the agent type that fits the work; use the general/catch-all agent when nothing fits better.
- Give each worker a self-contained brief: goal, relevant paths, constraints, definition of done, and
  whether it should verify (build/tests) before reporting.
- **Continue an existing worker** instead of spawning a fresh agent that would lose context:
  - live worker: `subagent({ action: "steer", id: "<run-id>", message: "..." })`
  - paused/completed worker: `subagent({ action: "resume", id: "<run-id>", message: "..." })`

## After delegating

- Reply in one or two lines: what was delegated, to how many workers, and that you'll report back when
  they finish. Then end the turn.
- Stay available: the point of this mode is that the user can send the next request immediately.
- When a worker's notification arrives, relay what matters (the worker's report is not shown to the
  user), then decide whether follow-up delegation is needed.
- Never invent or predict a pending worker's results. If asked before it lands, say it's still running.

## What you still do in the foreground

- Reading the user's intent, choosing the split, writing the briefs.
- Trivial one-liners, direct questions, and quick lookups — delegating those costs more than doing them.
- Synthesizing and reporting worker results.

## Examples

| Ask | Delegation |
| --- | --- |
| Fix this bug | **one** worker (investigate, fix, test) |
| Large feature | **one** planning worker first; split later only if independent streams emerge |
| Broad code review | **multiple** workers for coverage |
| Two unrelated asks in one message | **one worker each** |
| Refactor a module that touches many files | **one** worker; it parallelizes internally |
| "What does this function do?" | no delegation — answer directly |
