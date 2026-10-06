---
updatedAtCommit: d459056fd3a9084b5d351d830af55e93a262ee2b
---
# INDEX

Knowledge index for Cartographer. Grounded in current source at the stamped commit.

CLI skills are part of release 0.12.0; forge evidence reporting is part of 0.12.1. Release 0.12.2 binds the claim permission but does not expose it directly to strict writers. File lease ownership includes the reviewed, uncommitted direct native claim repair; the stamp is its base HEAD. Isolated OpenCode 2.0.24 acceptance passed with the local build; production installation remains unchanged and unverified.

- [MODULES](./MODULES.md) — карта `src/{core,shared,rpc,plugin,tui,cli}/`, `scripts/`, `defaults/` и направления зависимостей.
- [FLOWS](./FLOWS.md) — ключевые потоки: setup/configure manual, sync, file leases, project trust.

Контракт: `src/core/knowledge.ts` (`KNOWLEDGE_DIR`, `parseUpdatedAtCommit`, `assertKnowledgePath`, `commitDistance`, `isPageStale`). Sync (`src/core/sync.ts`) владеет только `.opencode/agents/*.md`, `.opencode/plugins/agent-gvozd/index.ts`, `docs/.gvozd/{config.jsonc,schema.json,tasks}` и не затрагивает `knowledge/`.
