---
updatedAtCommit: 6233cb9a403854b6848aaef80c669a3eff0e3874
---
# MODULES

Карта кодовой базы (см. `docs/architecture.md`, `AGENTS.md`). Stamp — проверенный base HEAD, package version 0.12.9. Audit fixes A/B/C и явно отмеченные runtime additions ниже — uncommitted working tree, не новый релиз.

- `src/core/` — домен: config, sync, agent-generation, agent-permissions, tool-permissions, file-leases (`reserve/claim/extend/release`, TTL 5 мин reserved / 30 мин active), project-trust, knowledge, release-metadata, config-root.
- `src/shared/` — инфраструктура: fs, text, file-lock, secure-path (`secureCanonicalPath`), runtime-events (`redactDiagnostic`).
- `src/rpc/` — контракты plugin↔TUI: permissions, leases, roster, config, trusted-mode (`gvozd-mode`), goal-mode (`gvozd-goal`).
- `src/plugin/` — server plugin (`index.ts`, `file-lease-plugin.ts` с `gvozd_lease`/`gvozd_claim`, `jev-plugin`); native permissions, shared runtime и goal persistence описаны ниже.
- `src/tui/` — TUI plugin (`index.tsx`, insights, agent-roster, session-insights/tools, command-pipeline, permission-panel).
- `src/cli/` — бинарь `gvozd`: setup, config, doctor, sync, agents, trust-project, analyze, init, completion (см. `src/cli/index.ts`); реестр — `command-registry.ts` (single source of truth для `--help` и completion `bash|zsh|fish`); setup/configure manual pool — `chooseManualProfile` / `selectModelFromPool` / `manualProfile` (`LARGE_MANUAL_CATALOG=20`).
- `scripts/` — build (`dist/index.js`, `dist/tui.js`, `dist/cli.js`), verify-sync, verify-package, live-opencode-compat; уже в base HEAD: isolated manual proofs `live-native-claim-smoke.ts` (включая DevOps), `live-agent-contract-smoke.ts` (Git host fixture).
- `defaults/` — команда агентов: `default.jsonc`, `agents/*.jsonc` (17 агентов, cartographer=`writer` только на `docs/.gvozd/knowledge/*`), `prompts/*.md`. Полный roster, роли и runtime/generated parity проверяет `src/core/agent-contract.test.ts:11–17,45–91`.

Team/Git contract уже в base HEAD: `src/core/agent-context.ts:20–55` разделяет coordinator/writer/readonly guidance и Git exception; `src/core/agent-permissions.ts:40–75` строит final resource rules, добавляя Git-only asks по resolved roster ID, не по роли/capabilities. Runtime (`src/plugin/index.ts:280`) и generated Markdown (`src/core/agent-generation.ts:43–45`) используют тот же builder; ID передают project sync (`src/core/sync.ts:182`), global sync (`src/cli/global-sync.ts:71`) и doctor (`src/cli/doctor.ts:91`). `src/core/tool-permissions.ts:159–203,300–315,333–380` — force/destructive/exceptional resource patterns и lease no-escalation; это wildcard matching, не shell parser. DevOps получает exact native `gvozd_claim` grant (`defaults/agents/devops.jsonc:25–28`); claim не требует общего gateway/MCP grant.

## Audit/runtime additions (uncommitted)

- A: `src/plugin/native-permissions.ts:15–28` требует `session.get`, предпочитает SDK `permission.rules`, использует optional `session.update` только при отсутствии первого writer. Ошибка write не вызывает fallback retry. Реальный installed Promise adapter SDK 2.0.2 проверяется изолированным fixture (`src/plugin/native-permissions.test.ts:77–123`), без live server. `src/plugin/index.ts:326–395,406–435,564–589,872–895` — shared-before-local hydration/RPC queues, сохранение foreign rules и reconciliation known/unknown children (см. FLOWS).
- B: `src/core/tool-permissions.ts:65–92,247–277` — exact-only baseline `uniq`, `eslint`, `tsc --noEmit`, `npx tsc --noEmit`; аргументные формы исключаются conservative resource globs. `src/core/agent-permissions.ts:66–68` добавляет readonly DENY / writer ASK; runtime lease path — `src/plugin/file-lease-plugin.ts:155–179`. Generated `.opencode/agents/*.md` уже изменены в working tree; parity pin — `src/core/agent-contract.test.ts:53–62`. Это не filesystem sandbox.
- Shared state: `src/plugin/runtime-state.ts:7–63` хранит ref-counted lease managers по real project root, goals/overrides/families/intent clock/policy queues по resolved global config directory. Это process-local coordination между location instances, не межпроцессная блокировка. Подключение: `src/plugin/file-lease-plugin.ts:216–224,331–336`, `src/plugin/index.ts:300–309`.
- Goal: `src/plugin/goal-tool.ts:6–38` регистрирует native `gvozd_goal` (`codemode: false`) только для enabled coordinator; status/record без start или command replacement. `src/rpc/goal-mode.ts:253–330` валидирует record и применяет domain loop (`src/core/goal-mode.ts`). C: `src/plugin/goal-log.ts:18–22,51–150,157–207` ограничивает snapshot 64 KiB UTF-8, сохраняет bounded histories/latest verify и counters либо пишет inactive fallback. Atomic swap (`src/shared/fs.ts:35–59`) не даёт fsync/durability гарантии; storage failure может оставить старый snapshot.

Built-in skills: `defaults/skills/{forge-workflow,ci-workflow,runner-workflow}/SKILL.md` — CLI workflows (0.12.0), `defaults/skills/caveman/SKILL.md` — terse-answer guidance (0.12.6; `CHANGELOG.md`). `src/core/builtin-skills.ts:7,35,69` — каталог, безопасный preflight и managed installer. Установка интегрирована в project sync (`src/core/sync.ts:156,233`) и global setup (`src/cli/setup.ts:380`), проверка — `src/cli/doctor.ts`. Skills не являются permission enforcement; стандартные GitLab MCP grants удалены, пользовательские MCP настройки сохранены.

Направление зависимостей: `plugin → rpc → core → shared`; `tui → rpc + core`; `cli → core + shared`; `scripts → core + shared`; `shared` ни от кого не зависит.
