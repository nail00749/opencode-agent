---
updatedAtCommit: 5b7792f36f63b9ed422be82dc173fa770f4a3bbb
---
# FLOWS

Ключевые потоки, заземленные на текущий код.

## Sync

`src/core/sync.ts` материализует resolved-конфиг (`defaults/` → global → `docs/.gvozd/`) в `.opencode/agents/*.md` и `docs/.gvozd/{config.jsonc,schema.json,tasks}`. Marker-owned writes, `knowledge/` не затрагивает. Проверка: `bun run verify:sync`.

## File leases

`src/core/file-leases.ts` (`FileLeaseManager`): `reserve → claim → extend/release`, роли `coordinator | writer | readonly`. Мост в permission hook — `src/plugin/file-lease-plugin.ts` (`gvozd_lease`, `gvozd_claim`). Cartographer (`defaults/agents/cartographer.jsonc`) — `writer` только на `docs/.gvozd/knowledge/*`.

## Project trust

`src/core/project-trust.ts`: проектный `docs/.gvozd/config.jsonc` без токена `gvozd trust-project` принимает только `$schema` и описания существующих агентов; иначе требуется токен (`GVOZD_TRUST_PROJECT_CONFIG`). Сам себе доверять не может.
