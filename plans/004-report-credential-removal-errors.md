# Plan 004: Report secure credential removal failures truthfully

> Executor: follow each step, honor boundaries, run the gates, and report evidence. Reviewer maintains the index.
> Drift check: `git diff --stat 923c6bb..HEAD -- credential-store.mjs test/credential-store.test.mjs test/api-credentials.test.mjs`. Compare current functions against excerpts; earlier approved plans may change the same file outside this plan's target functions.

## Status
- Priority: P1
- Effort: S
- Risk: LOW
- Category: security
- Depends on: none functionally; serialize all plugin/code.js plans (001, 003, 005, 006) to avoid concurrent edits.
- Planned at: 923c6bb, 2026-09-08.

## Why this matters
macOS and Linux credential lookups treat any nonzero command status as absence. Their delete methods therefore accept deletion failure when a follow-up lookup also fails. The server can return cleared:true although the saved credential still exists.

## Current state
Repository: /Users/davidbuck/Documents/ChatGPT/figma-local-bridge. Node >=20, ESM JavaScript, MCP SDK and Zod. server.mjs owns stdio/HTTP orchestration; plugin/code.js executes a narrow Figma Plugin API command set; credential-store.mjs isolates OS credential storage. Tests use node:test, assert/strict and VM Figma mocks. There is no typecheck or lint script.
```js
credential-store.mjs:48
if (result.code !== 0) return null;
// macOS delete at 64
if (result.code !== 0 && await this.get()) throw new Error("macOS Keychain could not remove the credential.");
// Linux delete at 142-144
if (!environment.DBUS_SESSION_BUS_ADDRESS) return;
const result = await run("secret-tool", ["clear", "service", service, "account", account]);
if (result.code !== 0 && await this.get()) throw new Error("Linux Secret Service could not remove the credential.");
```
Follow existing two-space formatting and helpers. plugin/code.js:920 removeFailedCreation is the new-node cleanup exemplar; test/plugin-logic.test.mjs:7 loadPluginHelpers executes actual source in a VM. Transport tests use random ports and temporary directories. Credential tests inject run rather than using real storage.
Preserve documented constraints: local-only canvas bridge, explicit scoped mutations, native editable composition, confirmed user preferences, secure storage without plaintext fallback.

## Scope
Only modify: `credential-store.mjs`, `test/credential-store.test.mjs`, `test/api-credentials.test.mjs`. The integration executor may regenerate dist/server.mjs once after all source changes using npm run build.
Out of scope: the xero-mcp mirror, personal/installed plugins, live Figma documents, dependencies/lockfile, version bumps, unrelated commands, deployment, remote pushes, main-branch changes. Do not apply the advisor skill to implementation.

## Git workflow
Use the shared executor's isolated worktree, starting at 923c6bb on advisor/figma-improve-20260908 (choose a unique suffix if already used). Never switch the original checkout. Commit logical fixes in that worktree only, imperative messages matching "Restore SVG safety validation". No merge, push, or PR. An executor with multiple workers must assign exclusive file ownership.

## Commands
Run inside the isolated worktree:
- `npm ci --ignore-scripts`: install locked dependencies, exit 0. Network/setup failure is a blocker; do not update the lockfile to bypass it.
- `node --test test/credential-store.test.mjs test/api-credentials.test.mjs`: focused tests pass after fix.
- `npm run check`: syntax checks plus all tests pass. Baseline has 25 tests; an initial local run had two connection-refused failures but rerun passed 25/25. Capture subprocess diagnostics for recurrence; do not weaken tests.
- `npm run build`: exit 0; rebuild bundled runtime in disposable worktree at integration.
- `git diff --check`: exit 0.
- `git diff --name-only 923c6bb`: only approved union of six plans plus generated dist/server.mjs.

## Steps
1. Read target functions and existing tests; verify drift and install dependencies. Run `npm run check`; expect baseline pass or diagnose the documented transient setup failure before implementation.
2. Add regressions: Use injected run backends as in existing credential-store tests, never real storage. Cover confirmed absence, successful removal, denied removal plus unavailable lookup, read failure warning, Linux missing DBUS and command-not-found, and memory-backend deletion. Confirm failed removal rejects rather than reporting success and storage recovery can reveal the retained fixture credential. Use synthetic fixtures only.
   Verify with the focused node --test command above: the new regression must fail for its intended behavior on baseline, not because the mock is missing unrelated APIs.
3. Implement: Distinguish documented not-found results from denied/unavailable backend errors. For macOS verify item-not-found exit handling; for Secret Service verify command semantics and remain conservative when failure and absence are ambiguous. Missing DBUS must not claim removal of a possibly persisted credential. Preserve idempotent deletion for confirmed absence, successful deletion, session-only fallback, Windows DPAPI behavior, and generic redacted warnings. Existing createCredentialStore.delete already throws backend failures and server clearOwnerApiCredentials already awaits it; prefer fixing that shared seam.
   Verify with the focused command: all cases pass, including new regressions.
4. Run `npm run check` and `git diff --check`: both exit 0. Review changed files against scope; integration executor rebuilds and verifies all combined fixes before final commit/report.

## Done criteria
- New regression cases above exist, failed on baseline for the expected reason, and pass after the change.
- Focused tests, npm run check, npm run build (integration), and git diff --check exit 0.
- Original checkout and live systems remain untouched except reviewer-authored plans.
- Report changed functions/files, commits, exact test totals, limits and any deviations. Reviewer updates plans/README.md.

## STOP conditions
Report to reviewer if target behavior has drifted, dependencies cannot install, the same gate fails twice after a reasonable fix attempt, or out-of-scope edits are necessary. Do not access, clear, rotate or print real credentials. If Linux cannot reliably distinguish absence from failure, choose explicit failure and document the limitation instead of guessing.

## Maintenance
Reviewer amendment, 2026-09-08: Apple's security CLI maps failed generic-password searches to item-not-found even for some backend errors. Primary evidence: https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/keychain_find.c (find_first_generic_password and do_delete_generic_password). Therefore exit 44 cannot confirm absence. Reject every nonzero macOS delete with a generic could-not-confirm-removal error; warn on ambiguous reads. This overrides macOS absent-delete idempotence above. Successful exit 0 removal and confirmed absence on other backends remain supported. Test exit 44 rejection and zero success. A native Keychain helper is deferred; it is not necessary to stop false success reports.

Keep failure-path assertions when adding new awaited calls or setters to this operation. Do not substitute mock-only assertions for executing the actual source. Live Figma acceptance remains separate from local mock/integration proof.
