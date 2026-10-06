---
updatedAtCommit: fb3da109f48c83bfe8387580dd8a1dd5c6e8c58f
---
# MODULES

Карта кодовой базы (см. `docs/architecture.md`, `AGENTS.md`).

- `src/core/` — домен: config, sync, agent-generation, agent-permissions, tool-permissions, file-leases (`reserve/claim/extend/release`, TTL 5 мин reserved / 30 мин active), project-trust, knowledge, release-metadata, config-root.
- `src/shared/` — инфраструктура: fs, text, file-lock, secure-path (`secureCanonicalPath`), runtime-events (`redactDiagnostic`).
- `src/rpc/` — контракты plugin↔TUI: permissions, leases, roster, config, trusted-mode (`gvozd-mode`).
- `src/plugin/` — server plugin (`index.ts`, `file-lease-plugin.ts` с `gvozd_lease`, `jev-plugin`).
- `src/tui/` — TUI plugin (`index.tsx`, insights, agent-roster, session-insights/tools, command-pipeline, permission-panel).
- `src/cli/` — бинарь `gvozd`: setup, config, doctor, sync, agents, trust-project, analyze, init, completion (см. `src/cli/index.ts`); реестр — `command-registry.ts` (single source of truth для `--help` и completion `bash|zsh|fish`); setup/configure manual pool — `chooseManualProfile` / `selectModelFromPool` / `manualProfile` (`LARGE_MANUAL_CATALOG=20`).
- `scripts/` — build (`dist/index.js`, `dist/tui.js`, `dist/cli.js`), verify-sync, verify-package, live-opencode-compat.
- `defaults/` — команда агентов: `default.jsonc`, `agents/*.jsonc` (16 агентов, cartographer=`writer` только на `docs/.gvozd/knowledge/*`), `prompts/*.md`.

CLI skills (release 0.12.0): `defaults/skills/{forge-workflow,ci-workflow,runner-workflow}/SKILL.md` — инструкции для `git`/`glab`/`gh`; `src/core/builtin-skills.ts:7,35,69` — каталог, безопасный preflight и managed installer. Установка интегрирована в project sync (`src/core/sync.ts:156,233`) и global setup (`src/cli/setup.ts:335,361,380`), проверка — doctor (`src/cli/doctor.ts:300`). Skills не являются permission enforcement; стандартные GitLab MCP grants удалены, пользовательские MCP настройки сохранены.

Направление зависимостей: `plugin → rpc → core → shared`; `tui → rpc + core`; `cli → core + shared`; `scripts → core + shared`; `shared` ни от кого не зависит.
