# Jev SDK Integration Design

## Purpose

Add Jev to Gvozd as an optional built-in evaluation tool that any explicitly
allowed Gvozd agent can call for narrow, typed semantic decisions. The
integration uses SDKs directly rather than requiring users to install or invoke
a TypeSafe agent skill.

Jev is disabled by default. Users configure it through `gvozd setup`, may route
requests either directly to TypeSafe or through Vercel AI Gateway, and can use a
validated custom base URL for either transport. A persistent global switch in
the Gvozd TUI enables or disables the integration for every OpenCode session.
API keys remain environment variables and are never written to Gvozd config.

## Goals

- Expose one stable `gvozd_jev` tool with TypeSafe-compatible `noul`, `choice`,
  and `score` questions.
- Support the official TypeSafe JavaScript SDK and Vercel AI SDK as two
  interchangeable transports behind one internal provider interface.
- Make the global enabled state visible and mutable from the existing Gvozd
  Control Center without restarting OpenCode.
- Add guided Jev configuration to interactive setup while keeping `--yes`
  deterministic and non-secret.
- Allow a controlled set of agents to use Jev, with recommended defaults for
  `master`, `master-trusted`, `planner`, and `researcher`.
- Preserve typed probabilities and scoring detail so agents can reason about
  uncertainty instead of receiving only a flattened label.
- Keep project configuration, diagnostics, logs, and RPC payloads free of API
  key values.

## Non-goals

- Replace an agent's model, planning, review, or security judgment with Jev.
- Let a tool caller choose a provider, URL, model, credential, or arbitrary
  request headers per invocation.
- Store credentials in JSONC, the operating-system keychain, or generated agent
  files.
- Add an MCP server or make the TypeSafe agent skill a runtime dependency.
- Provide a generic proxy for arbitrary AI SDK models or endpoints.
- Run paid or state-bearing network probes from `gvozd doctor`.
- Automatically retry or synthesize a successful answer after a terminal Jev
  failure beyond the retry behavior already supplied by the selected SDK.

## Architecture

The OpenCode-facing surface is one built-in Gvozd tool:

```text
agent -> gvozd_jev -> JevRuntime -> JevProvider
                                      |-- TypeSafeProvider
                                      `-- VercelGatewayProvider
```

`JevRuntime` owns validation, configuration snapshots, agent authorization,
request cancellation, output normalization, and safe error projection. It
depends on a small `JevProvider` interface and does not depend on either SDK's
response types.

`TypeSafeProvider` uses `@typesafe-ai/sdk` and calls `TypeSafeClient.systemOne`.
`VercelGatewayProvider` uses the `ai` package's `experimental_evaluate` with a
gateway provider created for the configured URL and credential. The Vercel
boolean question and answer are normalized to Gvozd's public `noul` contract.
Its per-call evaluation-model wrapper removes raw provider warnings before AI
SDK's global warning logger can emit them; Gvozd retains only a warning count.

The two approved runtime dependencies are:

- `@typesafe-ai/sdk` for direct TypeSafe requests;
- `ai@^7.0.107` for Vercel AI Gateway evaluation; this is the first verified
  package version in the design that exports `experimental_evaluate`.

They are imported only from the plugin-side provider adapters, preserving the
repository dependency direction. Core owns plain configuration and validation
types; RPC, TUI, and CLI do not import runtime SDKs.

## Runtime compatibility

AI SDK 7.0.107 provides the verified Jev `experimental_evaluate` API and
requires Node.js 22 or newer. Gvozd therefore raises its package runtime
requirement from Node.js 20.12 to Node.js 22. The package `engines.node` field,
README prerequisites, setup preflight, doctor diagnostics, package smoke tests,
and release metadata must agree on this minimum.

Setup fails before any write when the detected Node runtime is older than 22
and prints an actionable upgrade message. Doctor reports the detected and
required versions without attempting to load the Vercel adapter on an
unsupported runtime. The change does not add a separate compatibility mode or
silently fall back to a non-SDK Vercel request.

## Configuration

The Gvozd root config gains a `jev` object:

```jsonc
{
  "jev": {
    "enabled": false,
    "provider": "typesafe",
    "baseUrl": "https://api.typesafe.ai",
    "model": "jev-latest",
    "apiKeyEnv": "TYPESAFE_API_KEY",
    "allowedAgents": [
      "master",
      "master-trusted",
      "planner",
      "researcher"
    ]
  }
}
```

Fields have these meanings:

- `enabled` is the global master switch and defaults to `false`.
- `provider` is `typesafe` or `vercel`.
- `baseUrl` is the provider API root. Direct TypeSafe appends its System One
  path through the SDK; the Vercel adapter treats the value as the gateway
  provider base URL.
- `model` defaults to `jev-latest` for TypeSafe and `typesafe-ai/jev` for
  Vercel.
- `apiKeyEnv` is an environment-variable name, never a credential value. It
  defaults to `TYPESAFE_API_KEY` or `AI_GATEWAY_API_KEY` according to provider.
  It must match `[A-Za-z_][A-Za-z0-9_]*`.
- `allowedAgents` is a unique list of configured agent IDs. An empty list is
  valid and makes the tool unavailable to every agent while retaining the
  provider settings.

Package defaults, global config, and trusted project config retain the existing
layering rules for provider settings. However, `enabled` is intentionally a
global kill switch: a project layer may further disable Jev for that project,
but it cannot enable Jev when the global value is false. This prevents a
repository from overriding the user's TUI decision. Project Jev overrides are
ignored unless the existing `GVOZD_TRUST_PROJECT_CONFIG` gate succeeds.

Changing providers in setup resets provider-specific defaults only when the
user accepts the provider change. Otherwise existing values, including a custom
base URL, are preserved.

## Base URL validation

The same validator is used by config parsing, setup, doctor, and the runtime:

- the URL must be absolute;
- HTTPS is required for remote hosts;
- HTTP is allowed only for `localhost`, `127.0.0.1`, or `[::1]`;
- username, password, query, and fragment components are rejected;
- a non-root pathname is allowed so a self-hosted proxy can live below a path;
- malformed URLs fail before any request is created.

The runtime sends the evaluated `state` to the configured host. Setup and TUI
therefore identify a non-default host as custom, and setup explicitly warns
that evaluated data will be sent there. No endpoint is accepted from a tool
call.

## Setup flow

Interactive `gvozd setup` and `gvozd config` add a Jev section after model
selection:

1. Ask whether Jev should be enabled.
2. If enabled, select direct TypeSafe or Vercel AI Gateway.
3. Ask for the environment-variable name, showing the provider default.
4. Select the standard provider URL or enter a custom base URL.
5. Ask for the model, showing the provider default.
6. Select allowed Gvozd agents, initially recommending `master`,
   `master-trusted`, `planner`, and `researcher`.
7. Show the Jev settings, excluding any environment-variable value, in the
   existing write plan before confirmation.

Setup never asks for or stores an API key. It checks whether the chosen
environment variable exists in the current process and emits a warning when it
does not, but the warning does not block setup because OpenCode may run under a
different service environment.

With `--yes`, a valid existing Jev configuration is preserved exactly. On a
fresh installation Jev remains disabled and provider details use package
defaults; unattended setup never guesses a credential source or enables an
external request path.

JSONC updates use the existing atomic config-editing path and preserve comments,
formatting where practical, and unrelated settings.

## TUI and RPC behavior

The Gvozd Control Center adds a compact Jev block containing:

- `Enabled` or `Disabled` status;
- provider and model;
- the base URL host, marked when custom;
- credential environment status as `present` or `missing`;
- `Enable`/`Disable` and `Refresh` actions.

The TUI deliberately edits only the global `enabled` master switch. Provider,
base URL, model, environment-variable name, and agent allowlist remain setup
choices so an accidental keypress cannot redirect evaluated data.

The config RPC extends its existing get/patch contract with a narrow Jev status
projection and a global-enabled patch. It never returns the API key value and
does not accept provider secrets. The server revalidates the patch, performs an
atomic global config update, refreshes the in-memory configuration, and reports
the resulting status.

An enabled-state change applies without restarting OpenCode:

- disabling aborts all active Jev requests and blocks new ones;
- enabling makes the tool available on the next context/tool projection for
  every allowed agent;
- `Refresh` rereads status but does not make a network request.

## Tool visibility and authorization

`gvozd_jev` is visible only when all of these conditions hold:

- the global master switch is enabled;
- the resolved project configuration does not disable Jev;
- the current agent ID appears in `allowedAgents`;
- the selected provider configuration is structurally valid.

Visibility is a usability feature, not the authorization boundary. The tool
executor resolves the current config and agent again immediately before every
request. A hidden, stale, or indirect invocation therefore fails closed when
Jev is disabled or the agent is not allowed.

Default prompts describe Jev as an optional evaluator for tasks such as
classification, routing, rubric scoring, retrieval/reranking decisions, and
verification signals. They also state that Jev is not authority to execute a
shell command, edit files, deploy, merge, grant trust, or dismiss a review or
security finding.

## Tool input contract

The tool accepts one evaluation batch:

```ts
type JevInput = {
  state: string | Record<string, unknown> | unknown[]
  questions: Record<string, JevQuestion>
}

type JevQuestion =
  | {
      type: "noul"
      instructions: string | Record<string, unknown> | unknown[]
      criteria?: { true?: string; false?: string }
    }
  | {
      type: "choice"
      instructions: string | Record<string, unknown> | unknown[]
      criteria: Record<string, string | null>
    }
  | {
      type: "score"
      instructions: string | Record<string, unknown> | unknown[]
      criteria: string[]
    }
```

The configured model is always used. A caller cannot supply a model, provider,
URL, key, headers, retry policy, or timeout.

Validation limits are deliberately smaller than provider maxima:

- 1 to 32 questions per call;
- at most 256 KiB for the serialized `state`;
- at most 512 KiB for the complete serialized request;
- non-empty question IDs, unique by object-key semantics;
- non-empty `instructions` after structural validation;
- 2 to 255 unique options for `choice`;
- at least 2 non-empty levels for `score`;
- finite JSON-compatible input only: no functions, symbols, cycles, `NaN`, or
  infinities.

The runtime validates before reading the credential or starting network I/O.

## Tool output contract

Both providers return one normalized result:

```ts
type JevResult = {
  provider: "typesafe" | "vercel"
  model: string
  answers: Record<string, JevAnswer>
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
  }
  warnings: string[]
}

type JevAnswer =
  | { type: "noul"; noul: number }
  | {
      type: "choice"
      choice: string
      probabilities?: Record<string, number>
      confidence?: number
    }
  | {
      type: "score"
      score: number
      legend: Record<string, string>
      probabilities?: Record<string, number>
      confidence?: number
    }
```

The adapter validates provider output before returning it. Answer IDs and types
must match the request, `noul` and confidence values must be finite values in
`[0, 1]`, a choice must name a supplied option, and score values must remain
within the configured rubric range. When a provider returns probabilities,
their keys must match the supplied criteria and their finite values must be in
`[0, 1]`; Gvozd preserves them without inventing missing probability mass.
`legend` is deterministically reconstructed from the requested score criteria.

The direct TypeSafe API supplies choice/score probability maps and confidence.
AI SDK 7 declares its choice/score probability maps as optional and does not
declare confidence or a score legend. The Vercel adapter therefore preserves
probabilities when present, derives only the deterministic legend, and leaves
unsupported confidence fields absent. Invalid provider output is an error
rather than a partial result. `warnings` is reserved for non-fatal normalization
facts such as provider-omitted probabilities or unavailable usage data; it never
contains provider response bodies or evaluated state.

## Request lifecycle and cancellation

Each call receives an `AbortController` registered with `JevRuntime`. Provider
adapters accept its signal and pass it through the SDK's supported request or
custom-fetch surface. Disabling Jev aborts every registered controller before
the RPC update reports success. Cleanup removes settled calls from the
registry.

If an SDK cannot cancel work after it has reached the remote provider, Gvozd
still rejects the local call and discards any later result. The runtime never
delivers an answer obtained after the global switch was disabled.

Concurrent calls are allowed; no shared mutable SDK response state is retained.
The SDK's own bounded retry policy may handle transient rate limits. Gvozd does
not add a second retry loop. Vercel calls additionally have a 30-second local
deadline, which aborts the transport and settles the tool call even if a custom
provider ignores cancellation.

## Errors, privacy, and diagnostics

Credential lookup occurs only inside the plugin process at call time. A missing
or empty environment variable produces an actionable error naming the variable,
never its value. Provider failures are normalized into concise categories:

- authentication (`401`);
- invalid evaluation input (`422`);
- rate limited (`429`);
- provider overloaded (`529`);
- aborted;
- network or provider failure.

All provider and transport diagnostics pass through `redactDiagnostic` before
they reach the agent, TUI, doctor output, or runtime events. Gvozd does not log
the request state, normalized answers, API key, authorization headers, or raw
provider response bodies.

There is no synthetic fallback answer. The tool reports that Jev is unavailable
and the calling agent continues with its normal reasoning while making the
missing external signal explicit when it matters to the task.

## Doctor behavior

`gvozd doctor` remains read-only and adds checks for:

- effective global enabled state;
- selected provider and model;
- base URL validity and whether it is custom;
- whether the named credential environment variable is present;
- whether configured allowed-agent IDs exist;
- whether runtime tool registration is expected from the resolved settings.

Human output shows no secret values. JSON output uses booleans and safe names,
not environment values or authorization material. Doctor performs no Jev
request, because a health probe would transmit data, consume quota, and still
would not prove later task requests succeed.

## Internal boundaries

Implementation should preserve the repository's dependency graph:

- `src/core/`: Jev config schemas, resolution, base URL validation, safe status
  projection, and config-edit types;
- `src/rpc/`: typed Jev status and global toggle RPC contract;
- `src/plugin/`: `JevRuntime`, OpenCode tool registration, provider adapters,
  SDK imports, authorization, cancellation, and output normalization;
- `src/tui/`: Control Center status and toggle UI;
- `src/cli/`: setup/config prompts, persistence, and doctor checks;
- `defaults/`: package defaults and public config schema when generated by the
  repository's existing source-of-truth flow.

The provider interface uses plain internal types:

```ts
interface JevProvider {
  evaluate(input: JevInput, options: { signal: AbortSignal }): Promise<JevResult>
}
```

Provider construction happens from an immutable resolved config snapshot for
each call or cache generation. A configuration refresh must never mutate a
client currently used by a different call.

## Testing and verification

Focused Bun tests cover:

- Jev config defaults, schema rejection, layering, global kill-switch
  precedence, and the project-trust gate;
- base URL rules, including path prefixes, localhost HTTP, and rejected
  credentials/query/fragment;
- TypeSafe and Vercel adapters with injected mock transports and no live
  network access;
- Vercel boolean-to-`noul` request and response normalization;
- normalized choice/score probabilities, provider-omitted optional fields,
  usage, and malformed provider output;
- input size, question count, option/level, non-finite value, and empty-field
  limits;
- credential errors and diagnostic redaction;
- agent allowlist visibility plus executor-level rejection;
- global disable cancellation and rejection of late results;
- config RPC serialization and atomic enabled-state patching;
- TUI enabled/disabled, missing-env, custom-host, toggle, and refresh states;
- interactive setup for both providers and custom URLs;
- `--yes` preservation and fresh-install disabled behavior;
- human and JSON doctor output without secrets or network access.

Completion requires the repository gates appropriate to the touched runtime,
TUI, and CLI entrypoints:

```bash
bun test <targeted Jev and touched-module tests>
bun run lint
bun run typecheck
bun test
bun run build
bun run verify:sync
bun run verify:package
```

Because setup and CLI entrypoints change, the package smoke test is also run if
the implementation reaches the packaged CLI path. A manual OpenCode smoke test
should demonstrate tool visibility for an allowed agent, denial for an
unallowed agent, one direct or gateway mock/proxy request, and immediate global
disable without restart. Completion reporting distinguishes automated evidence
from any runtime smoke that could not be performed locally.

Package verification must run on Node.js 22 and must demonstrate that invoking
the CLI on an older Node runtime fails with the documented version diagnostic
rather than an SDK import or syntax error.

## Acceptance criteria

- A fresh installation keeps Jev disabled and stores no credential.
- Package metadata, setup, doctor, documentation, and smoke tests consistently
  require Node.js 22 or newer.
- Interactive setup configures either direct TypeSafe or Vercel Gateway,
  including a safe custom base URL and selected allowed agents.
- The TUI global switch changes all sessions without restarting OpenCode and a
  disabled switch cannot be overridden by project config.
- Only allowed agents can see and execute `gvozd_jev`; stale or indirect calls
  fail the same authorization check.
- The tool accepts bounded typed evaluations and returns normalized `noul`,
  `choice`, and `score` answers, preserving every probability distribution the
  selected provider returns.
- Active calls are aborted or locally invalidated when Jev is disabled.
- API key values, evaluated state, answers, and raw provider bodies do not
  appear in config, RPC, TUI, doctor, or logs.
- Doctor provides useful local diagnostics without sending a Jev request.
- Existing config layering, project trust, atomic-write, agent permission, and
  package verification guarantees continue to pass.

## References

- TypeSafe JavaScript SDK: <https://docs.typesafe.ai/sdk/javascript>
- TypeSafe HTTP API and typed answer shapes: <https://docs.typesafe.ai/api>
- Vercel AI Gateway Jev model and `experimental_evaluate` example:
  <https://vercel.com/ai-gateway/models/jev>
- AI SDK package and Node.js 22 requirement: <https://www.npmjs.com/package/ai>
