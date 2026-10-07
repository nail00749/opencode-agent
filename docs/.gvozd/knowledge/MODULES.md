---
updatedAtCommit: a7c45e3a0af9b8eb55b9115533bd43c5da0684b0
---
# MODULES

Карта кодовой базы (см. `docs/architecture.md`, `AGENTS.md`). Stamp — проверенный base HEAD release 0.12.3; изменения team contract/Git policy ниже относятся к uncommitted working tree.

- `src/core/` — домен: config, sync, agent-generation, agent-permissions, tool-permissions, file-leases (`reserve/claim/extend/release`, TTL 5 мин reserved / 30 мин active), project-trust, knowledge, release-metadata, config-root.
- `src/shared/` — инфраструктура: fs, text, file-lock, secure-path (`secureCanonicalPath`), runtime-events (`redactDiagnostic`).
- `src/rpc/` — контракты plugin↔TUI: permissions, leases, roster, config, trusted-mode (`gvozd-mode`).
- `src/plugin/` — server plugin (`index.ts`, `file-lease-plugin.ts` с `gvozd_lease`, `jev-plugin`).
- `src/tui/` — TUI plugin (`index.tsx`, insights, agent-roster, session-insights/tools, command-pipeline, permission-panel).
- `src/cli/` — бинарь `gvozd`: setup, config, doctor, sync, agents, trust-project, analyze, init, completion (см. `src/cli/index.ts`); реестр — `command-registry.ts` (single source of truth для `--help` и completion `bash|zsh|fish`); setup/configure manual pool — `chooseManualProfile` / `selectModelFromPool` / `manualProfile` (`LARGE_MANUAL_CATALOG=20`).
- `scripts/` — build (`dist/index.js`, `dist/tui.js`, `dist/cli.js`), verify-sync, verify-package, live-opencode-compat; isolated manual proofs — `live-native-claim-smoke.ts` (в working tree добавлен DevOps), `live-agent-contract-smoke.ts` (новый Git host fixture).
- `defaults/` — команда агентов: `default.jsonc`, `agents/*.jsonc` (17 агентов, cartographer=`writer` только на `docs/.gvozd/knowledge/*`), `prompts/*.md`. Полный roster и роли проверяет `src/core/agent-contract.test.ts:11–17,45–79`.

Working-tree contract: `src/core/agent-context.ts:20–55` разделяет coordinator/writer/readonly guidance и Git exception; `src/core/agent-permissions.ts:39–71` строит final resource rules, добавляя Git-only asks по resolved roster ID, не по роли/capabilities. Runtime (`src/plugin/index.ts:276`) и generated Markdown (`src/core/agent-generation.ts:21–26`) используют тот же builder; ID передают project sync (`src/core/sync.ts:182`), global sync (`src/cli/global-sync.ts:71`) и doctor (`src/cli/doctor.ts:91`). `src/core/tool-permissions.ts:154–183,260–275,293–300,326–341` — force/destructive/exceptional resource patterns и lease no-escalation; это wildcard matching, не shell parser. DevOps получает exact native `gvozd_claim` grant (`defaults/agents/devops.jsonc:24–28`), без общего gateway/MCP grant. Regression-контракт всех 17 агентов — `src/core/agent-contract.test.ts:28–85`.

CLI skills (release 0.12.0): `defaults/skills/{forge-workflow,ci-workflow,runner-workflow}/SKILL.md` — инструкции для `git`/`glab`/`gh`; `src/core/builtin-skills.ts:7,35,69` — каталог, безопасный preflight и managed installer. Установка интегрирована в project sync (`src/core/sync.ts:156,233`) и global setup (`src/cli/setup.ts:335,361,380`), проверка — doctor (`src/cli/doctor.ts:300`). Skills не являются permission enforcement; стандартные GitLab MCP grants удалены, пользовательские MCP настройки сохранены.

Направление зависимостей: `plugin → rpc → core → shared`; `tui → rpc + core`; `cli → core + shared`; `scripts → core + shared`; `shared` ни от кого не зависит.
