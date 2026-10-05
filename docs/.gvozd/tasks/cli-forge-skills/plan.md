# CLI forge skills

## Status

Completed implementation, verification and review; ready for user-requested commit. Base HEAD: `f6c1b54c82e0de9a66aa3a982429f9d533fc0d2f`.

## Scope

- Replace built-in GitLab MCP guidance/grants with `forge-workflow`, `ci-workflow`, `runner-workflow` using git/glab/gh.
- Secure managed installation through global setup and project sync; doctor and package acceptance.
- Reads and diagnostics; confirmed CI run/retry/cancel/manual jobs and supported runner pause/resume.
- Preserve user MCP config and shell approvals; no new dependencies, CLI auto-install/login, runner registration/deletion or token/config operations.

## Verification and review

Writer reports lint/typecheck, 638 unit tests including package smoke, build, verify:package (45 files), verify:sync (20 generated files) and diff whitespace checks PASS. Review Deep APPROVE after one targeted fix: replace interactive `glab ci view` with `glab ci get --pipeline-id` for read inspection.

## Next steps

- Commit only on explicit user request; preserve unrelated work.
- Optional authenticated smoke on chosen GitLab/GitHub test repositories; no live provider operations have been performed.
