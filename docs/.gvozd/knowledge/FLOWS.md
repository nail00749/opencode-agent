---
updatedAtCommit: a7c45e3a0af9b8eb55b9115533bd43c5da0684b0
---
# FLOWS

Ключевые потоки, заземленные на текущий код. Stamp — проверенный base HEAD release 0.12.3; team contract/Git policy и DevOps claim grant ниже — uncommitted working tree, не выпущенный релиз.

## Setup/configure manual

`src/cli/configure.ts` (`chooseManualProfile(catalog, ui, existingProfile?)`): плоский выбор fast/deep из всего `catalog.models` через `selectModelFromPool`. Малый пул (≤ `LARGE_MANUAL_CATALOG=20`) — один select; большой — сначала опциональный фильтр по провайдеру (`All providers`), затем модели. Начальные значения — `initialManualModel` (deep по умолчанию равен fast, иначе из `existingProfile`). Валидация — `manualProfile(fast, deep, catalog)` в `src/cli/provider-catalog.ts` против всего пула (`providerOf`); кросс-провайдер и `fast===deep` валидны.

## Sync

`src/core/sync.ts` материализует resolved-конфиг (`defaults/` → global → `docs/.gvozd/`) в `.opencode/agents/*.md` и `docs/.gvozd/{config.jsonc,schema.json,tasks}`. Marker-owned writes, `knowledge/` не затрагивает. Проверка: `bun run verify:sync`.

## Built-in CLI skills (release 0.12.0)

`src/core/builtin-skills.ts:35` читает packaged `defaults/skills/*/SKILL.md`, валидирует frontmatter/marker, canonical paths и ownership; конфликт с unmanaged skill (включая flat alias) останавливает установку. `installBuiltinSkills` (`:69`) повторяет preflight под cooperative lock, проверяет preview и пишет атомарно. Check не создаёт файлов. Установка не транзакционная и не защищает от произвольного same-user процесса.

Project sync (`src/core/sync.ts:156,233`) устанавливает skills в `.opencode/skills/`; global setup (`src/cli/setup.ts:335,361,380`) показывает preview до подтверждения и устанавливает в config-root `skills/`. Doctor проверяет содержимое, но не доказывает runtime discovery. Другие источники skills могут переопределять managed копии.

Git использует `forge-workflow`; DevOps — `ci-workflow` и `runner-workflow`. Native CLI first, scoped `glab api`/`gh api` fallback; shell approvals сохраняются. CI run/retry/cancel/manual job и supported runner pause/resume требуют подтверждения target/action. Нет automatic CLI install/login, runner registration/deletion, token operations или configuration mutations. Read-only CI inspection не использует interactive mutation-capable UI (`defaults/skills/ci-workflow/SKILL.md:31–38`). Live authenticated provider проверки не выполнялись.

## Forge evidence reporting (release 0.12.1)

Master → Git для scoped MR/PR evidence. Git выполняет local inspection отдельно от CLI discovery/forge operations (`defaults/prompts/git.md:18–20,30–31`). Pending approval означает not executed; rejection возвращает точную команду и подтверждённый target без retry/bypass. Один `permission.rejected` не устанавливает источник отказа. Anonymous HTTP login/redirect не проверяет CLI/keyring auth: вывод об auth failure возможен только по выполненному CLI-ответу. Master сохраняет host/full repo/IID во всех делегациях, командах и user suggestions (`defaults/prompts/master.md:49,59`). Это guidance release 0.12.1; новые permission changes описаны отдельно ниже.

## Team contract and Git policy (working tree)

Git остаётся file-lease `readonly`: direct patch/edit и source-file mutations запрещены. Обычные canonical `git add`, `git commit`, `git push` имеют ALLOW (`defaults/agents/git.jsonc:34–91`), но только явно user-authorized scope допустим по prompt/context (`defaults/prompts/git.md:10–13,17–24,28–31`, `src/core/agent-context.ts:52–55`). User intent не проверяется permission machinery.

`buildAgentPermissions` добавляет protected DENY после конфигурации и только для resolved ID `git` — final ASK exceptions (`src/core/agent-permissions.ts:63–70`). Force `--force*` (включая `--force-with-lease`), `-f`, covered `-vf/-qf` и forced refspec требуют exact-command approval; amend и exceptional pushes, включая remote deletion refspec `:…` и `--prune`, тоже ASK (`src/core/tool-permissions.ts:154–183,260–275`). Другие protected destructive families остаются DENY; non-Git force не получает exception. Runtime/generated parity охватывает plugin, project/global sync и doctor (см. MODULES); тест — `src/core/agent-contract.test.ts:28–85`.

Active writer leases сохраняют baseline-only shell, ordinary mutations следуют `lease.shellEscalation` ask/deny, force остаётся hard DENY (`src/plugin/file-lease-plugin.ts:119`, `src/core/tool-permissions.ts:193–200,326–341`). Coordinator guidance предупреждает о собственном shell pause; generic readonly не получает Git exception, untrusted Master сохраняет no-shell guidance (`src/core/agent-context.ts:20–35`, `defaults/prompts/master.md:43`). Forge CLI остаётся ASK; skills не дают широкого CLI/token/config/admin/runner grant (`defaults/agents/git.jsonc:858–886`, `defaults/prompts/git.md:30`).

Границы: last-match resource wildcards, не shell/refspec parser; conservative lookalikes могут требовать approval. Поддержаны bounded ≤4 environment assignments; alternate executables, aliases, quoting/wrappers, произвольные short-option clusters и global-option ordinary mutations не являются поддержанными pre-approved формами (`src/core/tool-permissions.ts:293–300`, `defaults/prompts/git.md:24`). Duplicate patterns остаются advisory по supplied review; zero-error/performance или machine-enforced intent гарантий нет.

## File lease ownership

`src/core/file-leases.ts` (`FileLeaseManager`): `reserve → claim → extend/release`, роли `coordinator | writer | readonly`. Мост в permission hook — `src/plugin/file-lease-plugin.ts` (`gvozd_lease`, `gvozd_claim`). Cartographer (`defaults/agents/cartographer.jsonc`) — `writer` только на `docs/.gvozd/knowledge/*`.

Released 0.12.3 регистрирует claim с `codemode: false`, сохраняя namespace и exact permission `gvozd_claim` (`src/plugin/file-lease-plugin.ts:278–295`); Cartographer/Docs вызывают native tool напрямую, без запрещённого Code Mode gateway `execute`. Это не MCP: не добавлять `mcp: ["gvozd"]` или общий `execute allow`. Working tree добавляет DevOps exact claim grant (`defaults/agents/devops.jsonc:24–28`). Regression-тесты `src/plugin/file-lease-plugin.test.ts` моделируют host permission filtering и direct/Code Mode partition; `src/core/agent-permissions.test.ts` проверяет точные grants и readonly denial. Role/assignee/parent и запреты unclaimed/out-of-lease edits сохранены.

Manual proofs: `scripts/live-native-claim-smoke.ts:19–20` включает Cartographer/Docs/DevOps и BackFast control, readonly без claim; каждый writer claim/edit и четыре denial checks (preclaim, wrong agent, wrong parent, out-of-lease). `scripts/live-agent-contract-smoke.ts:123–144,244–273` проверяет native Git add/commit/push в LOCAL disposable bare remote без approval, ровно один force ASK с fixture REJECT, отсутствие force execution/retry и active-writer restrictions. Fixture rejection — тестовый ответ, не реальный отказ пользователя. Transport/helpers — `scripts/live-native-claim-transport{,.test}.ts`.

Supplied verification (Master, не rerun Cartographer): 679 full tests и gates PASS; оба isolated actual OpenCode 2.0.24 smoke PASS, cleanup выполнен, globals не затронуты; DeepReview/Security APPROVE после blocking fix remote deletion/prune. Source assertions проверены здесь, live/test результаты не воспроизводились. Изолированный PASS не означает проверенную production-установку; новый contract repair ещё не committed/released.

## Project trust

`src/core/project-trust.ts`: проектный `docs/.gvozd/config.jsonc` без токена `gvozd trust-project` принимает только `$schema` и описания существующих агентов; иначе требуется токен (`GVOZD_TRUST_PROJECT_CONFIG`). Сам себе доверять не может.

## CLI completion

`src/cli/command-registry.ts` (команды, флаги, пресеты, субкоманды) → `--help` (`buildHelp()`) и эмиттеры `src/cli/completion.ts` (`gvozd completion bash|zsh|fish`); parity-тест падает при флаге без реестра.
