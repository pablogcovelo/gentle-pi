# OpenCode Go subscription usage on current main
Branch: `feat/opencode-go-usage` (existing PR #1525 branch, merging current main `9ec634973b62c4b12a7a8a36218fc8f1725cad04`).
Issue: Gentleman-Programming/gentle-shell#872; PR #1525; Engram: `odd/opencode-go-usage-main/tasks`.

## Specs
S1. "Add OpenCode Go (`opencode-go`) subscription-usage retrieval through its authenticated usage endpoint, using the configured provider API key. Normalize the returned usage windows into the existing usage store, refresh configured Codex and OpenCode Go providers independently". "The implementation should fail closed when credentials are missing, the endpoint returns a non-success response, or required rolling usage data is malformed."
S2. "Adaptamos la implementación a main y actualizamos la issue para limitar la visualización al encabezado y /gentle:usage". "The footer should continue to show only the active provider."
S3. "revisa también los mensajes que ha dejado coderabbit en el PR por si son relevantes y requieren arreglo". Preserve the current main's bounded per-provider refresh and source precedence when adding OpenCode Go.
S4. "quiero reabrir tanto la issue como el PR pero antes revisa que el código siga siendo válido con el estado actual del repo en la rama main". Update the issue's outdated sidebar language, reopen the issue and PR only after a verified candidate is on the existing PR branch; publishing is a separate explicit action.

## Tasks
T1 | S1 | done: reconciled parser and parser tests; RED percent 101 accepted → GREEN 47/47 | commit: pending merge | Risk: none (pure parsing).
T2 | S1,S2,S3 | parent: reconcile endpoint fetch, bounded provider refresh, active UI, regression tests and docs with main | commit: pending | Risk: items 2,4 (bearer credential and concurrent refresh).
T3 | S1-S4 | parent: verification, issue update, existing PR branch coordination and reopen | commit: pending.

## Log
L1. Ok, quiero reabrir tanto la issue como el PR pero antes revisa que el código siga siendo válido con el estado actual del repo en la rama main y revisa también los mensajes que ha dejado coderabbit en el PR por si son relevantes y requieren arreglo
L2. Adaptamos la implementación a main y actualizamos la issue para limitar la visualización al encabezado y /gentle:usage
L3. Current main already bounds provider credential + fetch + body reads to ten seconds and refreshes the active provider plus frozen session-profile routes concurrently; the old PR patch does not apply. The old PR's target branch is `pablogcovelo/gentle-pi:feat/opencode-go-usage` and `maintainer_can_modify=false`. Dependencies installed via frozen lockfile; main baseline usage tests: 390/390 pass.
L4. ¿No podemos reutilzar la rama de la issue ya existente feat/opencode-go-usage?
L5. Existing fork branch at `50731ae49d63f7525acd189a05260dbeec2657bc` fetched and checked out locally without force-push or touching the remote. Preserve original PR history by merging main into this branch and resolving conflicts.
L6. A non-committing merge of current main stopped with five conflicts: docs/gentle-shell.md, extensions/gentle-shell.ts, lib/shell-usage.ts, tests/gentle-shell.test.ts and tests/shell-usage.test.ts. Main changes are staged; resolve each conflict while preserving current main's unrelated behavior.
L7. Worker resolved only parser and parser-test conflicts, retained main header-window and scope behavior; RED: OpenCode Go rolling 101 accepted; GREEN: tests/shell-usage.test.ts 47/47.
L8. T2 RED: active Go lacked fetch (0 vs 1 requests); GREEN Go-focused 4/4. RED: configured inactive Go absent alongside Codex; GREEN independent provider test 1/1. Added missing-key and body-timeout tests: 2/2. Combined shell usage suite 398/398 passed before the last two tests; re-run after final changes is pending. Current main's per-provider timeout and source precedence remain in control. Main comparison diff has no whitespace defects. `pnpm run typecheck` 0 diagnostics, `pnpm run check:provider-contract` pass, `pnpm run test:harness` pass.
L9. Full `pnpm test` failed 1 unrelated test (`tests/gentle-ai-binary.test.ts:181`, same-size binary rewrite digest cache); isolated rerun failed identically. That test and `lib/gentle-ai-binary.ts` are byte-identical to main. Do not claim a green full suite; decide disposition before delivery. The test suite produced untracked `odd/work` fixtures, absent at baseline; they were removed after the run.
L10. Removed `odd/tasks/opencode-go-usage-main-sync.md` from the resulting feature diff: the old PR's 165-line administrative merge note triggered CodeRabbit's out-of-scope warning, and its historic contents remain retrievable from PR branch commit `50731ae` and the earlier branch history. This current feature document supersedes that note. The candidate diff against main is ~330 changed lines.
L11. Independent high-risk verifier: S1/S2 supported, S3 initially blocked by two issues in inactive-provider discovery (double timeout and stale row after credential revocation). RED revocation test reproduced stale row; both issues fixed by using one bounded refreshProvider window and dropping revoked key from the extra scope. Verifier rechecked S3 with no remaining blocker. Final focused usage suite: 401/401 pass, 0 fail; full suite remains red only on the unchanged binary-cache test noted in L9.
