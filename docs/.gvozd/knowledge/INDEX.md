---
updatedAtCommit: 5b7792f36f63b9ed422be82dc173fa770f4a3bbb
---
# INDEX

Knowledge index for Cartographer. Grounded in current source at the stamped commit.

- [MODULES](./MODULES.md) — карта `src/{core,shared,rpc,plugin,tui,cli}/`, `scripts/`, `defaults/` и направления зависимостей.
- [FLOWS](./FLOWS.md) — ключевые потоки: sync, file leases, project trust.

Контракт: `src/core/knowledge.ts` (`KNOWLEDGE_DIR`, `parseUpdatedAtCommit`, `assertKnowledgePath`, `commitDistance`, `isPageStale`). Sync (`src/core/sync.ts`) владеет только `.opencode/agents/*.md`, `.opencode/plugins/agent-gvozd/index.ts`, `docs/.gvozd/{config.jsonc,schema.json,tasks}` и не затрагивает `knowledge/`.
