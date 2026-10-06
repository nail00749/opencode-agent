---
updatedAtCommit: 88ef79d231ad703a45eadd0efd0f3a0a14bcfbb4
---
# INDEX

Knowledge index for Cartographer. Grounded in current source at the stamped commit.

CLI skills are part of release 0.12.0; forge evidence reporting is part of 0.12.1. File lease ownership includes the reviewed, uncommitted native claim permission fix; the stamp is its base HEAD. Live strict-writer discovery remains unverified.

- [MODULES](./MODULES.md) — карта `src/{core,shared,rpc,plugin,tui,cli}/`, `scripts/`, `defaults/` и направления зависимостей.
- [FLOWS](./FLOWS.md) — ключевые потоки: setup/configure manual, sync, file leases, project trust.

Контракт: `src/core/knowledge.ts` (`KNOWLEDGE_DIR`, `parseUpdatedAtCommit`, `assertKnowledgePath`, `commitDistance`, `isPageStale`). Sync (`src/core/sync.ts`) владеет только `.opencode/agents/*.md`, `.opencode/plugins/agent-gvozd/index.ts`, `docs/.gvozd/{config.jsonc,schema.json,tasks}` и не затрагивает `knowledge/`.
