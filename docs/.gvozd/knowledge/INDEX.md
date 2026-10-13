---
updatedAtCommit: 6233cb9a403854b6848aaef80c669a3eff0e3874
---
# INDEX

Knowledge index for Cartographer. Stamp — verified base HEAD (package version 0.12.9), not a commit containing the uncommitted changes described below. Source references describe the inspected working tree; no new release or production-installation claim.

Base history already contains native claim (0.12.3), the 17-agent/Git-policy repair and DevOps claim (0.12.4), plus later changes through 0.12.9 (`CHANGELOG.md`). Uncommitted audit fixes: A — native permission writer compatibility and family-policy reconciliation; B — conservative verification-argument restrictions shared by runtime/generated permissions; C — bounded UTF-8 goal snapshots and inactive fallback. Shared runtime state and the coordinator goal tool are also uncommitted (see MODULES/FLOWS).

Master-supplied evidence: A/B/C APPROVE; Security A/B blockers resolved after round 1; writer reports 713 full unit tests, 50 A-targeted tests, lint/typecheck; independent B 84 and C 42 tests. Cartographer independently reran lint, typecheck and `bun run test:unit`: 713 pass, 0 fail (package smoke excluded). Final integration build/sync/package gates remain pending in this handoff. The installed SDK 2.0.2 adapter smoke uses an isolated host fixture, not a live server or production proof (`src/plugin/native-permissions.test.ts:77–123`).

- [MODULES](./MODULES.md) — карта `src/{core,shared,rpc,plugin,tui,cli}/`, `scripts/`, `defaults/` и направления зависимостей.
- [FLOWS](./FLOWS.md) — setup/configure manual, sync, file leases, native permissions, verification restrictions, goal persistence, project trust.

Контракт: `src/core/knowledge.ts` (`KNOWLEDGE_DIR`, `parseUpdatedAtCommit`, `assertKnowledgePath`, `commitDistance`, `isPageStale`). Sync (`src/core/sync.ts:150–291`) обслуживает generated agents, managed skills, optional dev-plugin entrypoint и project config/schema; `tasks/` только создаётся как каталог, содержимое `tasks/` и `knowledge/` не генерируется и не удаляется.
