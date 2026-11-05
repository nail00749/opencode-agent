---
updatedAtCommit: a90b67b8dc1f9251cb5b614fa5b9faa11a224fe0
---
# FLOWS

Ключевые потоки, заземленные на текущий код. Stamp — проверенный HEAD `a90b67b8dc1f9251cb5b614fa5b9faa11a224fe0`, committed package 0.12.10, а не commit P1–P4. Team/Git contract и DevOps claim входят в base HEAD (0.12.4); A/B/C audit/runtime changes ниже также уже в base (0.12.10, `CHANGELOG.md:18–39` на этом HEAD). P1–P4 — uncommitted working tree, не release. README-документация есть в working tree (`README.md:913–984`) и не выпущена. Committed `CHANGELOG.md:3–16` описывает только 0.12.11 per-agent model и OpenCode 2.x pin, не эту фичу. Working-tree `package.json` version `0.12.11` — не publish. Прежние audit gates/handoff notes сохранены как исторические, не P1–P4 verification.

## Setup/configure manual

`src/cli/configure.ts` (`chooseManualProfile(catalog, ui, existingProfile?)`): плоский выбор fast/deep из всего `catalog.models` через `selectModelFromPool`. Малый пул (≤ `LARGE_MANUAL_CATALOG=20`) — один select; большой — сначала опциональный фильтр по провайдеру (`All providers`), затем модели. Начальные значения — `initialManualModel` (deep по умолчанию равен fast, иначе из `existingProfile`). Валидация — `manualProfile(fast, deep, catalog)` в `src/cli/provider-catalog.ts` против всего пула (`providerOf`); кросс-провайдер и `fast===deep` валидны.

## Sync

`src/core/sync.ts:150–291` материализует resolved-конфиг (`defaults/` → global → `docs/.gvozd/`) в `.opencode/agents/*.md`, managed skills и project config/schema. Dev-plugin entrypoint создаётся только с `devPlugin`, иначе прежний generated entrypoint удаляется. Marker-owned writes; `tasks/` только создаётся как каталог, содержимое `tasks/` и `knowledge/` не затрагивается. Проверка: `bun run verify:sync`.

## Built-in CLI skills (0.12.0; caveman added in 0.12.6)

`src/core/builtin-skills.ts:35` читает packaged `defaults/skills/*/SKILL.md`, валидирует frontmatter/marker, canonical paths и ownership; конфликт с unmanaged skill (включая flat alias) останавливает установку. `installBuiltinSkills` (`:69`) повторяет preflight под cooperative lock, проверяет preview и пишет атомарно. Check не создаёт файлов. Установка не транзакционная и не защищает от произвольного same-user процесса.

Project sync (`src/core/sync.ts:156,233`) устанавливает skills в `.opencode/skills/`; global setup (`src/cli/setup.ts`, `installBuiltinSkills` at `:380`) показывает preview до подтверждения и устанавливает в config-root `skills/`. Doctor проверяет содержимое, но не доказывает runtime discovery. Другие источники skills могут переопределять managed копии.

Git использует `forge-workflow`; DevOps — `ci-workflow` и `runner-workflow`. Native CLI first, scoped `glab api`/`gh api` fallback; shell approvals сохраняются. CI run/retry/cancel/manual job и supported runner pause/resume требуют подтверждения target/action. Нет automatic CLI install/login, runner registration/deletion, token operations или configuration mutations. Read-only CI inspection не использует interactive mutation-capable UI (`defaults/skills/ci-workflow/SKILL.md:31–38`). Live authenticated provider проверки не выполнялись.

## Forge evidence reporting (release 0.12.1)

Master → Git для scoped MR/PR evidence. Git выполняет local inspection отдельно от CLI discovery/forge operations (`defaults/prompts/git.md:18–20,30–31`). Pending approval означает not executed; rejection возвращает точную команду и подтверждённый target без retry/bypass. Один `permission.rejected` не устанавливает источник отказа. Anonymous HTTP login/redirect не проверяет CLI/keyring auth: вывод об auth failure возможен только по выполненному CLI-ответу. Master сохраняет host/full repo/IID во всех делегациях, командах и user suggestions (`defaults/prompts/master.md:52–54`). Это guidance release 0.12.1; новые permission changes описаны отдельно ниже.

## Team contract and Git policy (base HEAD)

Git остаётся file-lease `readonly`: direct patch/edit и source-file mutations запрещены. Обычные canonical `git add`, `git commit`, `git push` имеют ALLOW (`defaults/agents/git.jsonc:34–91`), но только явно user-authorized scope допустим по prompt/context (`defaults/prompts/git.md:10–13,17–24,28–31`, `src/core/agent-context.ts:52–55`). User intent не проверяется permission machinery.

`buildAgentPermissions` добавляет protected DENY после конфигурации и только для resolved ID `git` — final ASK exceptions (`src/core/agent-permissions.ts:69–74`). Force `--force*` (включая `--force-with-lease`), `-f`, covered `-vf/-qf` и forced refspec требуют exact-command approval; amend и exceptional pushes, включая remote deletion refspec `:…` и `--prune`, тоже ASK (`src/core/tool-permissions.ts:159–186,300–315`). Другие protected destructive families остаются DENY; non-Git force не получает exception. Runtime/generated parity охватывает plugin, project/global sync и doctor (см. MODULES); тест — `src/core/agent-contract.test.ts:28–91`.

Без explicit family shell override writer baseline и active-lease shell gates сохраняются: ordinary mutations следуют `lease.shellEscalation` ask/deny, force остаётся hard DENY (`src/plugin/file-lease-plugin.ts:115–126,255–256`, `src/core/tool-permissions.ts:196–203,376–380`). Explicit family shell allow может обходить shell lease prompts, но не structured-edit leases и never-escalate clamp (`src/plugin/access-explanation.ts:377–381`, `src/plugin/index.ts:823–826`). Coordinator guidance предупреждает о собственном shell pause; generic readonly не получает Git exception (`src/core/agent-context.ts:20–35`). Master уже имеет direct-shell guidance (`defaults/prompts/master.md:48–51`), не старый no-shell contract. Forge CLI остаётся ASK; skills не дают широкого CLI/token/config/admin/runner grant (`defaults/agents/git.jsonc`, `defaults/prompts/git.md:30`).

Границы: last-match resource wildcards, не shell/refspec parser; conservative lookalikes могут требовать approval. Поддержаны bounded ≤4 environment assignments; alternate executables, aliases, quoting/wrappers, произвольные short-option clusters и global-option ordinary mutations не являются поддержанными pre-approved формами (`src/core/tool-permissions.ts:333–340`, `defaults/prompts/git.md:24`). Duplicate patterns остаются advisory по историческому supplied review; zero-error/performance или machine-enforced intent гарантий нет.

## File lease ownership

`src/core/file-leases.ts` (`FileLeaseManager`): `reserve → claim → extend/release`, роли `coordinator | writer | readonly`. Мост в permission hook — `src/plugin/file-lease-plugin.ts` (`gvozd_lease`, `gvozd_claim`). Cartographer (`defaults/agents/cartographer.jsonc`) — `writer` только на `docs/.gvozd/knowledge/*`.

Native claim (в base HEAD с 0.12.3) регистрируется с `codemode: false`, сохраняя namespace и exact permission `gvozd_claim` (`src/plugin/file-lease-plugin.ts:359–367`); Cartographer/Docs вызывают native tool напрямую, без запрещённого Code Mode gateway `execute`. Это не MCP: не добавлять `mcp: ["gvozd"]` или общий `execute allow`. DevOps exact claim grant также уже в base HEAD (`defaults/agents/devops.jsonc:25–28`, 0.12.4). Regression-тесты `src/plugin/file-lease-plugin.test.ts` моделируют host permission filtering и direct/Code Mode partition; `src/core/agent-permissions.test.ts` проверяет точные grants и readonly denial. Role/assignee/parent и запреты unclaimed/out-of-lease edits сохранены.

Manual proofs: `scripts/live-native-claim-smoke.ts:19–20` включает Cartographer/Docs/DevOps и BackFast control, readonly без claim; каждый writer claim/edit и четыре denial checks (preclaim, wrong agent, wrong parent, out-of-lease). `scripts/live-agent-contract-smoke.ts:123–144,244–273` проверяет native Git add/commit/push в LOCAL disposable bare remote без approval, ровно один force ASK с fixture REJECT, отсутствие force execution/retry и active-writer restrictions. Fixture rejection — тестовый ответ, не реальный отказ пользователя. Transport/helpers — `scripts/live-native-claim-transport{,.test}.ts`.

Историческая verification для team/Git repair (ранее supplied Master, не текущий audit gate): 679 full tests/gates и оба isolated actual OpenCode 2.0.24 smoke PASS; cleanup без global mutations, DeepReview/Security APPROVE после remote deletion/prune fix. Repair теперь в base HEAD; этот старый PASS не проверяет новые A/B/C и не доказывает production-установку.

## P1 — access explanation (uncommitted)

Контракт exact check: sessionID + agent + action + resources; без observationID — preview, с ним — observed (`src/core/access-explanation.ts:7–15,50–55`). Builder сохраняет только evidence выбранного basis, копирует resources/rules, не исполняет команды и не выводит причины из error text. Только observed native-host evidence определяет nativeOutcome; без него outcome unknown, даже при allow preview (`:43–69`). Correlation observation с session/agent/action/resources обязан обеспечить будущий server producer; builder не делает lookup/authentication.

Для lease preview `inspectMutation` → общий `checkMutation` → status (`src/core/file-leases.ts:233–258`): пустые targets, отсутствие/expiry ownership и out-of-scope paths отклоняются теми же проверками, без sweep/TTL refresh/ownership changes. Реальная authorization сохраняет sweep и refresh (`:226–230`). Tests (`src/core/file-leases.test.ts:452–505`) покрывают successful/denied preview, expiry без удаления, canonical paths и unsafe links; preview не выдаёт grant.

`GvozdAccessExplanation.explain` — additive JSON-schema contract (`src/rpc/permissions-rpc.ts:4–72`); tests проверяют запрет execute/diagnostic payload и совместимость старого evaluate (`src/rpc/permissions-rpc.test.ts:59–85`). Регистрация producer, observation log и sidebar consumer — P2/P3 ниже, не этот stamp-commit. `GvozdPermissions.evaluate` остаётся agent-policy-only dry run (`src/plugin/index.ts:680–686`) и не объясняет итоговый native host outcome.

Helper по-прежнему берёт nextStep последнего ask/deny (`src/core/access-explanation.ts:68–69`), не наиболее строгого слоя и не `decisive`. P2 упорядочивает только decisive ask/deny. Security relaxation нет: это explanation contract, не новый authorization path.

Master-supplied P1 verification: writer lint/typecheck green, 41 targeted / 727 full tests pass; Review Deep APPROVE, independent 67 tests pass. Cartographer эти suites не перезапускал; live-host outcome этим не подтверждён.

## P2 — runtime explanations (uncommitted)

Не входит в stamp-commit, changelog или package. README фиксирует те же limits как uncommitted advisory wording (P4), не как release. Master-supplied review: Review Deep APPROVE; Security no blockers. Cartographer gates не перезапускал. Защита не ослаблена.

Preview: `explain` без observationID вызывает `decideAccess({ preview: true })` (`src/plugin/index.ts:688–735`). Policy не гидрируется и не пишется (`:698–699`). Lease trace идёт с `authorize: false` в `inspectMutation` (`src/plugin/file-lease-plugin.ts:185–223`, `src/core/file-leases.ts:233–236`): нет sweep, TTL refresh и смены ownership. Regression не сдвигает `expiresAt`/`lastActivityAt` (`src/plugin/policy-regressions.test.ts:83–104`). Incoming effect preview — константа `ask` (`src/plugin/index.ts:720`), поэтому preview может разойтись с live host effect и устареть относительно policy/lease, которые обновит только enforcement. Это не grant.

Observed: permission hook (`src/plugin/index.ts:804–864`) записывает evidence в process-local log (cap 128, `src/plugin/access-explanation.ts:27,488–533`; close на dispose, `src/plugin/index.ts:518–519`) и дописывает `observationID=` только в ask/deny message. Lookup требует exact session/agent/action/resources (`src/plugin/access-explanation.ts:535–541`). Missing → `OBSERVATION_MISSING`, mismatch → `OBSERVATION_MISMATCH`; оба unknown, не deny (`src/plugin/index.ts:691–694`, `src/plugin/policy-regressions.test.ts:130–146`). Log не переживает процесс и вытесняет записи старше 128.

`decideAccess` сохраняет прежний порядок: readonly verification mutation, explicit shell override, lease guard, skill/MCP scope, session override/posture, затем goal (`src/plugin/access-explanation.ts:363–461`). Goal expiry и MCP refresh вызываются только из enforcement callback (`src/plugin/index.ts:823–847`). Применённый effect — `decision.effect` (`:850–852`), не recommendation. `authorize: true` по-прежнему вызывает `authorizeMutation` (`src/plugin/file-lease-plugin.ts:264–274`, `src/core/file-leases.ts:226–230`).

`orderDecisionEvidence` переносит в конец только decisive ask/deny (`src/plugin/access-explanation.ts:182–203`). Builder затем берёт последний ask/deny независимо от `decisive` (`src/core/access-explanation.ts:68–69`). Residual: non-winning deny может задать `nextStep`, даже если applied effect — allow. `nextStepFor` для неизвестного deny code возвращает `ask-coordinator` (`src/plugin/access-explanation.ts:149–160`); неизвестный effect остаётся `inspect-host`. Сообщения redact и не исполняют команды (`:163–167,463–486`).

## P3 — grouped sidebar (uncommitted)

`src/tui/index.tsx:57–63` монтирует `GroupedSidebar` в `sidebar.content`. Footer и `/gvozd*` panels остаются отдельно (`:64–71`). Секции: GVOZD, TASKS, AGENTS, SKILLS, ACCESS, CONTEXT (`src/tui/sidebar-model.ts:7`); default expanded — только GVOZD (`:77–79`). Host tasks hardcoded unavailable (`src/tui/sidebar.tsx:353`). Строка ACCESS явно read-only и не approve/execute/policy (`src/tui/sidebar-model.ts:246`). Master-supplied review: initial blockers исправлены в двух capped rounds; финальный targeted Review Deep APPROVE. README section uncommitted (P4); changelog и package фичу не выпускают.

План объяснений берёт не больше четырёх pending checks (`src/tui/sidebar-model.ts:350`). Без agent, action или availability запрос не угадывается как master и не становится empty allow (`:335–360`). `explainAccess` при сбое остаётся undefined (`src/tui/insights.ts:376–394`); sidebar не рисует это как пустое разрешение (`src/tui/sidebar.tsx:266–267`). Loading/error с предыдущим значением — stale, не confirmed empty (`src/tui/sidebar-model.ts:88–99,232–234`). Смена сессии сбрасывает чужие mode/explanation до paint (`src/tui/sidebar.tsx:218–225`).

Residual advisories, не новые grant path и не ослабление проверок:

- Preview can be stale: server preview не refresh policy/TTL (P2), а sidebar может показать предыдущее объяснение как stale.
- Non-winning deny can influence allow nextStep: recommendation последнего ask/deny не равен applied allow.
- Sidebar may attribute a pending check to the family root unless the requesting agent is evidenced. `PendingCheck` не несёт agent (`src/tui/sidebar-model.ts:49–54`); `agentForSession` возвращает только root этой сессии (`:387–392`) и этот id ставится на каждый check (`:349–358`). Exact `observationID` из metadata (`:317–321`, `src/tui/sidebar.tsx:198`) — единственное evidence requesting agent; без корреляции сервер не отдаёт чужую запись.
- Raw resources are displayed: `formatExplanation` печатает `resources[0]` и evidence resource без redact (`src/tui/sidebar-model.ts:136–152`). Preview allow помечен как не авторизация. Tool error text не атрибутирует permission (`src/tui/session-tools.ts:92–120`).
- Unknown deny defaults to ask-coordinator (`src/plugin/access-explanation.ts:160`). Это recommendation, не смена deny.

## P4 — README documentation (uncommitted)

`README.md:907–911` говорит, что `/gvozd-dryrun` не объясняет block и не сообщает native host outcome, а pending blocks объясняет sidebar `ACCESS`. `README.md:913–984` описывает grouped sidebar: секции, честные fetch states, read-only `ACCESS`, и что preview не авторизация (`:950–958`). Limits (`:966–984`) — advisory wording тех же residual risks, не новый grant path и не ослабление deny/lease/policy:

- preview может разойтись с later applied effect, потому что preview не refresh policy, goal, MCP или lease TTL;
- recommended next step — последний ask/deny, не applied allow;
- pending check без exact correlated `observationID` спрашивает как root открытой сессии;
- resource strings показываются как supplied, без redact;
- unknown deny code → ask coordinator; unknown effect → inspect host.

Master-supplied README review: APPROVE with advisory wording only. Замечания не blockers и не claim, что проверки ослаблены.

Review status этого refresh: P1 остаётся ранее supplied Review Deep APPROVE (здесь не переоткрывался); P2 APPROVE; Security no blockers; P3 APPROVE after two capped fix rounds; P4 README review APPROVE with advisory wording only.

Independent integration evidence (Master-supplied, Cartographer не перезапускал): lint/typecheck pass, `bun test` 774 pass / 0 fail, build pass, `verify:sync` pass (21 generated files). Это не release и не production-install claim.

## A — Native permission persistence (base HEAD)

`src/plugin/native-permissions.ts:15–28`: обязательный reader `session.get` + preferred writer `permission.rules`; optional compatibility `session.update` выбирается только если `permission.rules` отсутствует. Write/read failures пробрасываются, failed preferred write не повторяется другим writer. Без reader нет replacement writer, чтобы не стереть user/other-plugin rules. SDK 2.0.2 Promise-adapter smoke (`src/plugin/native-permissions.test.ts:77–123`) проверяет endpoint decoding, payload и ошибки на изолированном host fixture, без live OpenCode server.

Hydration migration — read-modify-write: shared per-family `policyQueues` берётся перед instance-local family queue (`src/plugin/index.ts:332–339,388–401`), как в mode/override RPC (`:526–550,560–597`). Read-only refresh (`:449–463`) не пишет migration из stale read. Root policy обновляется с сохранением foreign rules, затем сверяются известные children (`:412–428`). Повторный `setOverrides` с тем же значением root всё равно вызывает reconciliation: предыдущий root write мог пройти, а child write — упасть (`:572–591`). При ошибке выполняется попытка root readback; family update не является атомарной транзакцией для всех children.

SDK не перечисляет unknown descendants: они сверяют copied policy с root на следующем context hook (`src/plugin/index.ts:872–895`). Shared queues принадлежат одному процессу/global config directory (`src/plugin/runtime-state.ts:33–63`); они не сериализуют внешние plugins, другие host processes или пользовательские writers. Full-ruleset read-modify-write не даёт cross-process CAS/transaction guarantee.

## B — Verification argument restrictions (base HEAD)

Baseline exact-only: `uniq`, `eslint`, `tsc --noEmit`, `npx tsc --noEmit` (`src/core/tool-permissions.ts:65–92`). Любые дополнительные аргументы этих форм попадают под conservative restrictions (`:247–277`), включая harmless lookalikes: `uniq` может писать второй positional operand, ESLint — report/cache, tsc — отменить noEmit или включить output/incremental writes. Общие patterns также покрывают указанные find/sort/rg mutation/runner flags, fix/write/snapshot и Git output forms; bounded assignment prefixes — `:333–340`.

`buildAgentPermissions` добавляет final readonly DENY / writer ASK (`src/core/agent-permissions.ts:66–68`). Runtime classifier исключает эти формы из verification baseline; readonly guard действует до family shell override, writer следует lease ask/deny без explicit shell override (`src/plugin/access-explanation.ts:372–381`, `src/plugin/file-lease-plugin.ts:236–237,255–256`). Runtime и generated Markdown используют один builder; sync/render parity проверяет `src/core/agent-contract.test.ts:53–62`. Generated files входят в base 0.12.10; прежние pending gates относятся к историческому handoff ниже. Resource matching — не shell parser и не sandbox: разрешённые builds/tests/project scripts могут писать файлы и выполнять произвольный project code.

## C — Goal snapshots and shared runtime (base HEAD)

Location instances одного процесса делят lease manager по real project root; ref-count release очищает его лишь при последнем consumer (`src/plugin/runtime-state.ts:7–30`). Goals/overrides/families/intent clock/policy queues разделяются по resolved global config directory (`:33–63`); первый consumer восстанавливает snapshots (`src/plugin/index.ts:300–309`). Это cooperative runtime, не cross-host ownership protocol.

Native `gvozd_goal` доступен enabled coordinators: status/record, session ID из tool context, без start, command replacement или revival (`src/plugin/goal-tool.ts:6–38`). Record требует текущий active goal и совпадающий goalId, валидирует finite measurements/budgets и применяет domain stop conditions (`src/rpc/goal-mode.ts:253–330`). Manual stop гасит grant, сохраняя record/rounds (`src/plugin/index.ts:634–656`). Active goal расширяет только shell/edit, не skill/MCP, после lease guard (`src/core/session-permissions.ts:85–105`, `src/plugin/access-explanation.ts:383–443`); старый comment перед `goalDecisionFor` всё ещё перечисляет skill/MCP, но implementation их исключает.

`persistFamilyGoal` → global `goal-logs/<family>.json`, не repository (`src/plugin/goal-log.ts:47–49,126–150`). Оба history tails (`loop.log`, `rounds.logTail`) сначала ограничиваются 100 entries и затем сокращаются до UTF-8 JSON ≤64 KiB. Последний verify/result и latest `after` сохраняются, если запись помещается; counters, budgets, retry flags, commands не пересчитываются и не обрезаются (`:51–85`). Если даже минимальная запись не помещается, successful write заменяет старый snapshot inactive fallback: terminal identity/stopReason когда помещаются, иначе invalidation marker `{active:false}`, который restore пропускает (`:88–118`). Fallback не останавливает текущий in-memory goal, но не восстанавливает старый active grant после успешной замены.

Restore валидирует shape/размер, восстанавливает loop/counters, пропускает malformed/expired snapshots; TTL 7 дней, sweep cap 50 families (`src/plugin/goal-log.ts:12–22,157–256`). Owner-only atomic replacement использует secure paths и writeability checks (`:139–149`, `src/shared/fs.ts:35–59`). OS/storage failure диагностируется и может оставить предыдущий, в том числе active, snapshot. Нет fsync или crash-durability гарантии; inactive fallback решает impossible-size case, не произвольный disk failure.

## Historical audit evidence (pre-0.12.10 handoff, not P1)

Master сообщает A/B/C APPROVE, Security A/B blockers resolved после round 1; writer — 713 full unit + 50 A-targeted tests, lint/typecheck; independent B — 84 tests, C — 42 tests. Это supplied evidence, не повторный запуск всех gates Cartographer. Final integration build/sync/package остаются pending в этом handoff; release/production readiness не заявляется.

Cartographer отдельно выполнил `bun run lint`, `bun run typecheck`, `bun run test:unit`: PASS, 713 tests / 0 fail (package smoke исключён). Source paths/line references проверены; whitespace gate — `git diff --check` для трёх knowledge pages. Live server smoke, build, sync и package gates здесь не запускались.

## Project trust

`src/core/project-trust.ts` вычисляет токен, `src/core/config.ts` применяет trust gate: проектный `docs/.gvozd/config.jsonc` без токена `gvozd trust-project` принимает только `$schema` и описания существующих агентов; иначе требуется токен (`GVOZD_TRUST_PROJECT_CONFIG`). Сам себе доверять не может.

## CLI completion

`src/cli/command-registry.ts` (команды, флаги, пресеты, субкоманды) → `--help` (`buildHelp()`) и эмиттеры `src/cli/completion.ts` (`gvozd completion bash|zsh|fish`); parity-тест падает при флаге без реестра.
