# Session memory

How agents keep work resumable across sessions without polluting context.
For the knowledge index see `docs/.gvozd/knowledge/INDEX.md`; for workflow
rules see `AGENTS.md`.

## Ownership

| Path | Owner | Produced by |
| --- | --- | --- |
| `docs/.gvozd/tasks/<id>/plan.md` | Master creates, extends scope | Hand-written, never generated |
| `docs/.gvozd/tasks/<id>/handoff.md` | Writer appends per session, reviewer appends verdict | Hand-written + `gvozd analyze` snapshot |
| `docs/.gvozd/knowledge/` | Cartographer | Hand-written knowledge pages |
| `docs/.gvozd/{config.jsonc,schema.json}` | sync | `bun run sync` from `defaults/` |

Sync only ensures the `tasks/` directory exists (`src/core/sync.ts:283`) and
never generates, updates, or removes anything inside `tasks/` or `knowledge/`.

## `plan.md` — one work package, one file

```markdown
# <task-id>: <goal in one sentence>

## Architecture
Where the change lives (layers from `docs/architecture.md`), what stays untouched.

## Scope
- In: ...
- Out: ...

## Files
- `exact/path.ts` — why it changes

## Leases
- `<leaseId>` → `<agent>` → `<files>`

## Decisions
- <date>: <decision> — <why>

## Status
- [ ] planned / [~] in progress / [x] done / [!] blocked

## Next steps
- ...
```

Keep the task badges (`Files:`, `Interfaces:`, checkbox steps) compatible with
the style of `docs/superpowers/plans/*.md` so plans stay greppable.

## `handoff.md` — append-only per session

One section per session, newest last:

```markdown
## <sessionID> <date>
### Done
- ...
### Not done
- ...
### Blockers
- ...
### Resume
- Exact commands / lease IDs needed to continue
### Evidence
- Diff ranges, `gvozd analyze` snapshot refs — never full logs
```

Reviewer appends `### Verdict: accept | request-changes` after the writer's
lease is released and never edits scope.

## Evidence rule (context budget)

Reference, don't paste: diff ranges (`git diff <a>..<b> --stat`), file paths
with line numbers, `gvozd analyze <sessionID>` snapshots. A handoff must fit
in one screen: status, next step, blockers, links. Full logs stay in the
session they were produced in.

## Resume order

1. `docs/.gvozd/knowledge/INDEX.md` when present — check its
   `updatedAtCommit` against HEAD; when stale, trust source over pages.
2. `docs/.gvozd/tasks/<id>/plan.md` — Status, then Next steps.
3. `git status` — what is actually dirty right now.
4. Lease status — what is claimed before touching anything.
5. `handoff.md` — only the latest session section, not the whole history.
