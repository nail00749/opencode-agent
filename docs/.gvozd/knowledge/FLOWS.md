---
updatedAtCommit: d459056fd3a9084b5d351d830af55e93a262ee2b
---
# FLOWS

Ключевые потоки, заземленные на текущий код.

## Setup/configure manual

`src/cli/configure.ts` (`chooseManualProfile(catalog, ui, existingProfile?)`): плоский выбор fast/deep из всего `catalog.models` через `selectModelFromPool`. Малый пул (≤ `LARGE_MANUAL_CATALOG=20`) — один select; большой — сначала опциональный фильтр по провайдеру (`All providers`), затем модели. Начальные значения — `initialManualModel` (deep по умолчанию равен fast, иначе из `existingProfile`). Валидация — `manualProfile(fast, deep, catalog)` в `src/cli/provider-catalog.ts` против всего пула (`providerOf`); кросс-провайдер и `fast===deep` валидны.

## Sync

`src/core/sync.ts` материализует resolved-конфиг (`defaults/` → global → `docs/.gvozd/`) в `.opencode/agents/*.md` и `docs/.gvozd/{config.jsonc,schema.json,tasks}`. Marker-owned writes, `knowledge/` не затрагивает. Проверка: `bun run verify:sync`.

## Built-in CLI skills (release 0.12.0)

`src/core/builtin-skills.ts:35` читает packaged `defaults/skills/*/SKILL.md`, валидирует frontmatter/marker, canonical paths и ownership; конфликт с unmanaged skill (включая flat alias) останавливает установку. `installBuiltinSkills` (`:69`) повторяет preflight под cooperative lock, проверяет preview и пишет атомарно. Check не создаёт файлов. Установка не транзакционная и не защищает от произвольного same-user процесса.

Project sync (`src/core/sync.ts:156,233`) устанавливает skills в `.opencode/skills/`; global setup (`src/cli/setup.ts:335,361,380`) показывает preview до подтверждения и устанавливает в config-root `skills/`. Doctor проверяет содержимое, но не доказывает runtime discovery. Другие источники skills могут переопределять managed копии.

Git использует `forge-workflow`; DevOps — `ci-workflow` и `runner-workflow`. Native CLI first, scoped `glab api`/`gh api` fallback; shell approvals сохраняются. CI run/retry/cancel/manual job и supported runner pause/resume требуют подтверждения target/action. Нет automatic CLI install/login, runner registration/deletion, token operations или configuration mutations. Read-only CI inspection не использует interactive mutation-capable UI (`defaults/skills/ci-workflow/SKILL.md:31–38`). Live authenticated provider проверки не выполнялись.

## Forge evidence reporting (release 0.12.1)

Master → Git для scoped MR/PR evidence. Git выполняет local inspection отдельно от CLI discovery/forge operations (`defaults/prompts/git.md:18–20,29`). Pending approval означает not executed; rejection возвращает точную команду и подтверждённый target без retry/bypass. Один `permission.rejected` не устанавливает источник отказа. Anonymous HTTP login/redirect не проверяет CLI/keyring auth: вывод об auth failure возможен только по выполненному CLI-ответу. Master сохраняет host/full repo/IID во всех делегациях, командах и user suggestions (`defaults/prompts/master.md:47–49,59`). Permissions и runtime gates этим фиксом не меняются.

## File lease ownership

`src/core/file-leases.ts` (`FileLeaseManager`): `reserve → claim → extend/release`, роли `coordinator | writer | readonly`. Мост в permission hook — `src/plugin/file-lease-plugin.ts` (`gvozd_lease`, `gvozd_claim`). Cartographer (`defaults/agents/cartographer.jsonc`) — `writer` только на `docs/.gvozd/knowledge/*`.

Release 0.12.2 связывает native claim с точным permission `gvozd_claim` и добавляет Docs это разрешение после default deny, но Code Mode gateway `execute` у строгих writers запрещён. Reviewed working-tree repair, ещё без commit: `src/plugin/file-lease-plugin.ts` регистрирует claim с `codemode: false`, сохраняя namespace и permission; `defaults/prompts/{cartographer,docs}.md` требуют прямой native вызов. Это не MCP: не добавлять `mcp: ["gvozd"]` или общий `execute allow`. Regression-тесты `src/plugin/file-lease-plugin.test.ts` моделируют host permission filtering и direct/Code Mode partition; `src/core/agent-permissions.test.ts` проверяет точные grants и readonly denial. Role/assignee/parent и запреты unclaimed/out-of-lease edits сохранены.

`bun run scripts/live-native-claim-smoke.ts` прошёл на настоящем OpenCode 2.0.24 с локальной сборкой: реальный catalog, parent reservations, дочерние Cartographer/Docs без `execute`, BackFast control и readonly без claim; каждый writer успешно claim/edit и получает четыре отказа (preclaim, wrong agent, wrong parent, out-of-lease), запрещённые файлы не изменяются. Transport/helpers и девять тестов находятся в `scripts/live-native-claim-transport{,.test}.ts`: private service registration/auth, PID/version checks через `/api/info`, location query, bounded asynchronous plugin activation polling, завершающий experimental session wait (204). Fixture использует loopback-only macOS sandbox и disposable config/data/service; cleanup прошёл, production не меняется. 651 unit-тест и lint/typecheck/build/sync/package gates зелёные; deep review APPROVE, advisory — локальные macOS пути smoke. Карта обновлена Master: текущая production-сессия Cartographer по-прежнему не видит direct claim до установки новой сборки. Изолированный PASS не означает проверенную production-установку.

## Project trust

`src/core/project-trust.ts`: проектный `docs/.gvozd/config.jsonc` без токена `gvozd trust-project` принимает только `$schema` и описания существующих агентов; иначе требуется токен (`GVOZD_TRUST_PROJECT_CONFIG`). Сам себе доверять не может.

## CLI completion

`src/cli/command-registry.ts` (команды, флаги, пресеты, субкоманды) → `--help` (`buildHelp()`) и эмиттеры `src/cli/completion.ts` (`gvozd completion bash|zsh|fish`); parity-тест падает при флаге без реестра.
