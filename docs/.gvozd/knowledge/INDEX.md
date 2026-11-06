---
updatedAtCommit: a90b67b8dc1f9251cb5b614fa5b9faa11a224fe0
---
# INDEX

Knowledge index for Cartographer. Stamp — verified HEAD `a90b67b8dc1f9251cb5b614fa5b9faa11a224fe0` (committed package 0.12.10), not a commit containing P1–P4. Denial-explanation, grouped sidebar, and the README documentation of them are uncommitted working-tree changes, not a release. Committed `CHANGELOG.md:3–16` documents 0.12.11 per-agent model selection and the OpenCode 2.x pin only; it does not document this feature. The working-tree `package.json` / `src/core/release-metadata.ts:2` version `0.12.11` is not a publish of these features. Source references describe the inspected working tree; no production-installation claim.

Base history contains native claim (0.12.3), the team/Git-policy repair (0.12.4), and A/B/C audit fixes, shared runtime state and the coordinator goal tool (0.12.10; `CHANGELOG.md:18–39` at this HEAD). Earlier audit verification notes in FLOWS are historical, not P1–P4 gates.

P1 (uncommitted): access-explanation domain (`src/core/access-explanation.ts:3–71`), additive `gvozd-access-explanation.explain` RPC contract (`src/rpc/permissions-rpc.ts:4–72`), and non-mutating lease inspection (`src/core/file-leases.ts:226–258`). Runtime registration, observation lookup, and the sidebar consumer are P2/P3 in the same working tree, not this commit. See [MODULES](./MODULES.md#p1--access-explanation-uncommitted) and [FLOWS](./FLOWS.md#p1--access-explanation-uncommitted). Master-supplied P1 evidence: writer lint/typecheck green, 41 targeted / 727 full tests pass; Review Deep APPROVE, independently 67 tests pass. These are supplied results, not Cartographer reruns; no security relaxation.

P2 (uncommitted): registered explanation producer and process-local observation log. Master-supplied review: Review Deep APPROVE; Security no blockers. See [MODULES](./MODULES.md#p2--runtime-explanations-uncommitted) and [FLOWS](./FLOWS.md#p2--runtime-explanations-uncommitted). Protection is not weakened.

P3 (uncommitted): grouped read-only sidebar. Master-supplied review: initial blockers fixed in two capped rounds; final targeted Review Deep APPROVE. Residual advisories: preview can be stale; a non-winning deny can influence an allow `nextStep`; the sidebar may attribute a pending check to the family root unless the requesting agent is evidenced; raw resources are displayed; an unknown deny defaults to `ask-coordinator`. See [MODULES](./MODULES.md#p3--grouped-sidebar-uncommitted) and [FLOWS](./FLOWS.md#p3--grouped-sidebar-uncommitted). These residuals are advisory; they are not a weakened deny, lease, or policy check.

P4 (uncommitted): README documents the grouped sidebar and ACCESS explanation (`README.md:913–984`), including the same residual limits (`README.md:966–984`). README review: APPROVE with advisory wording only — not a blocker and not a protection change. The text states that a preview is not authorization and does not grant access, refresh policy or lease TTL, or weaken a deny (`README.md:950–958`). Changelog and package publish for this feature are still absent. See [MODULES](./MODULES.md#p4--readme-documentation-uncommitted) and [FLOWS](./FLOWS.md#p4--readme-documentation-uncommitted).

Review status for this refresh: P1 remains the previously supplied Review Deep APPROVE (not re-opened here); P2 APPROVE; Security no blockers; P3 APPROVE after two capped fix rounds; P4 README review APPROVE with advisory wording only.

Independent integration evidence supplied for this uncommitted feature (Cartographer did not rerun these gates): lint/typecheck pass, `bun test` 774 pass / 0 fail, build pass, `verify:sync` pass (21 generated files). Not a release or production-installation claim.

- [MODULES](./MODULES.md) — карта `src/{core,shared,rpc,plugin,tui,cli}/`, `scripts/`, `defaults/` и направления зависимостей.
- [FLOWS](./FLOWS.md) — setup/configure manual, sync, file leases, access-explanation contracts, runtime explanations, grouped sidebar, README documentation, native permissions, verification restrictions, goal persistence, project trust.

Контракт: `src/core/knowledge.ts` (`KNOWLEDGE_DIR`, `parseUpdatedAtCommit`, `assertKnowledgePath`, `commitDistance`, `isPageStale`). Sync (`src/core/sync.ts:150–291`) обслуживает generated agents, managed skills, optional dev-plugin entrypoint и project config/schema; `tasks/` только создаётся как каталог, содержимое `tasks/` и `knowledge/` не генерируется и не удаляется.
