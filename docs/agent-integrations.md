# Coding-agent integrations

Upstream Radar separates deterministic detection from project-specific reasoning. Every matched incident becomes the same constrained `AnalysisTask`, regardless of which coding agent consumes it.

## Support today

| Consumer | Integration | Delivery | Current boundary |
| --- | --- | --- | --- |
| DeepSeek Harness | Native Cordis bundle, `upstream-radar/dsh` | Automatic follow-up to a live root Agent; durable while no Agent exists | Uses the first live root Agent rather than a project-specific session |
| Codex CLI | Generic task-outbox bridge | One task rendered to stdin for `codex exec` | Manual dispatch and acknowledgement; not a Codex plugin |
| Claude Code | Generic task-outbox bridge | One task rendered to stdin for `claude -p` | Manual dispatch and acknowledgement; not a Claude Code plugin |
| Other agents and CI | Text or JSON task export | `task show` or `task show --json` | Consumer owns execution permissions and result storage |

## The outbox contract

List durable pending tasks:

```bash
upstream-radar task list /absolute/path/radar-state.json
upstream-radar task list /absolute/path/radar-state.json --json
```

Render the oldest task, or one exact task id:

```bash
upstream-radar task show /absolute/path/radar-state.json
upstream-radar task show /absolute/path/radar-state.json analysis-abc123
upstream-radar task show /absolute/path/radar-state.json analysis-abc123 --json
```

Only after the consumer has accepted the task, acknowledge it:

```bash
upstream-radar task ack /absolute/path/radar-state.json analysis-abc123
```

Use one state file per dispatcher. Do not let a DSH process and an external dispatcher write the same state file concurrently; cross-process state locking is not implemented yet.

## Codex CLI

Codex supports non-interactive execution, a selected workspace, stdin prompts, and a read-only sandbox:

```bash
upstream-radar task show /absolute/path/codex-state.json analysis-abc123 \
  | codex exec -C /absolute/path/to/project --sandbox read-only \
      --output-schema /absolute/path/to/upstream-radar/schemas/analysis-result.schema.json -
```

The task itself requires project evidence and forbids modifying files, installing packages, or executing source-controlled advisory commands. The explicit sandbox is still important because prompt instructions are not an operating-system boundary.

See the official [Codex CLI command reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli#codex-exec).

## Claude Code

Claude Code supports non-interactive `-p` mode and piped stdin. Start it in plan mode so the first integration remains read-only:

```bash
cd /absolute/path/to/project
upstream-radar task show /absolute/path/claude-state.json analysis-abc123 \
  | claude -p "Analyze the Upstream Radar task supplied on stdin." --permission-mode plan
```

See Anthropic's official [programmatic Claude Code documentation](https://code.claude.com/docs/en/headless).

## What is not native yet

- Codex and Claude Code do not receive background wakeups from this repository.
- Upstream Radar does not create or resume their sessions.
- Their structured result is not written back into incident state yet.
- There is no automatic retry or acknowledgement wrapper around either CLI.
- GitHub Action dispatch remains a later execution adapter.

These are delivery adapters. They do not change vulnerability applicability, dependency paths, incident lifecycle, or the untrusted-source boundary.
