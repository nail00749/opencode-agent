# Jev Integration Implementation Plan

1. Extend the strict layered config with Jev defaults, trusted project
   overrides, global kill-switch precedence, safe URL validation, atomic global
   edits, schema version 3, and focused core tests.
2. Add SDK-independent evaluation types and validation, then implement direct
   TypeSafe and Vercel AI SDK adapters behind an injectable provider boundary.
3. Register `gvozd_jev` in the server plugin, enforce visibility and executor
   authorization, cancel active calls on disable, redact failures, and cover the
   runtime with mock-only tests.
4. Extend config RPC and the TUI Control Center with safe Jev status plus a
   global enable/disable action that never transports credentials.
5. Extend setup/config persistence and prompts for provider, environment name,
   standard/custom base URL, model, and allowed agents; preserve existing Jev
   settings under `--yes`.
6. Add doctor and documentation coverage, raise Node.js support to 22, update
   package metadata, and regenerate only repository-owned artifacts.
7. Run targeted tests, lint, typecheck, the full unit suite, build, sync/package
   gates, and package smoke. Request one independent read-only review of the
   final diff and address verified findings.
