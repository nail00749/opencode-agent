---
updatedAtCommit: fb3da109f48c83bfe8387580dd8a1dd5c6e8c58f
---
# INDEX

Knowledge index for Cartographer. Grounded in current source at the stamped commit.

CLI skills are part of release 0.12.0. The forge evidence reporting section includes the reviewed, uncommitted prompt fix; the stamp is its base HEAD.

- [MODULES](./MODULES.md) — карта `src/{core,shared,rpc,plugin,tui,cli}/`, `scripts/`, `defaults/` и направления зависимостей.
- [FLOWS](./FLOWS.md) — ключевые потоки: setup/configure manual, sync, file leases, project trust.

Контракт: `src/core/knowledge.ts` (`KNOWLEDGE_DIR`, `parseUpdatedAtCommit`, `assertKnowledgePath`, `commitDistance`, `isPageStale`). Sync (`src/core/sync.ts`) владеет только `.opencode/agents/*.md`, `.opencode/plugins/agent-gvozd/index.ts`, `docs/.gvozd/{config.jsonc,schema.json,tasks}` и не затрагивает `knowledge/`.
