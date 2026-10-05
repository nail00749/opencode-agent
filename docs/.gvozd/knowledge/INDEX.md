---
updatedAtCommit: 8f0cacba7dde2dcbc5f16a1df427fd604b8086e4
---
# INDEX

Knowledge index for Cartographer. Grounded in current source at the stamped commit.

- [MODULES](./MODULES.md) — карта `src/{core,shared,rpc,plugin,tui,cli}/`, `scripts/`, `defaults/` и направления зависимостей.
- [FLOWS](./FLOWS.md) — ключевые потоки: setup/configure manual, sync, file leases, project trust.

Контракт: `src/core/knowledge.ts` (`KNOWLEDGE_DIR`, `parseUpdatedAtCommit`, `assertKnowledgePath`, `commitDistance`, `isPageStale`). Sync (`src/core/sync.ts`) владеет только `.opencode/agents/*.md`, `.opencode/plugins/agent-gvozd/index.ts`, `docs/.gvozd/{config.jsonc,schema.json,tasks}` и не затрагивает `knowledge/`.
