---
updatedAtCommit: a7c45e3a0af9b8eb55b9115533bd43c5da0684b0
---
# INDEX

Knowledge index for Cartographer. Grounded in current source; the stamp is verified base HEAD, including the explicitly identified working-tree changes below.

Released 0.12.3 exposes direct native claim to strict writers (`CHANGELOG.md`, `src/plugin/file-lease-plugin.ts:278–284`). The 17-agent contract and Git-policy repair are uncommitted working-tree changes, not a new release: identity-scoped runtime/generated permissions, Git authorization guidance, and DevOps claim access (see MODULES/FLOWS). Master reports review approval, 679 full tests/gates and two isolated OpenCode 2.0.24 smoke passes; these results were supplied, not rerun here. Local fixture acceptance does not verify production installation or machine-enforce user intent.

- [MODULES](./MODULES.md) — карта `src/{core,shared,rpc,plugin,tui,cli}/`, `scripts/`, `defaults/` и направления зависимостей.
- [FLOWS](./FLOWS.md) — ключевые потоки: setup/configure manual, sync, file leases, project trust.

Контракт: `src/core/knowledge.ts` (`KNOWLEDGE_DIR`, `parseUpdatedAtCommit`, `assertKnowledgePath`, `commitDistance`, `isPageStale`). Sync (`src/core/sync.ts`) владеет только `.opencode/agents/*.md`, `.opencode/plugins/agent-gvozd/index.ts`, `docs/.gvozd/{config.jsonc,schema.json,tasks}` и не затрагивает `knowledge/`.
