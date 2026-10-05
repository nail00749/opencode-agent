---
updatedAtCommit: f6c1b54c82e0de9a66aa3a982429f9d533fc0d2f
---
# INDEX

Knowledge index for Cartographer. Grounded in current source at the stamped commit.

CLI skills sections include the reviewed, uncommitted `cli-forge-skills` work package; the stamp is its base HEAD, not a release commit.

- [MODULES](./MODULES.md) — карта `src/{core,shared,rpc,plugin,tui,cli}/`, `scripts/`, `defaults/` и направления зависимостей.
- [FLOWS](./FLOWS.md) — ключевые потоки: setup/configure manual, sync, file leases, project trust.

Контракт: `src/core/knowledge.ts` (`KNOWLEDGE_DIR`, `parseUpdatedAtCommit`, `assertKnowledgePath`, `commitDistance`, `isPageStale`). Sync (`src/core/sync.ts`) владеет только `.opencode/agents/*.md`, `.opencode/plugins/agent-gvozd/index.ts`, `docs/.gvozd/{config.jsonc,schema.json,tasks}` и не затрагивает `knowledge/`.
