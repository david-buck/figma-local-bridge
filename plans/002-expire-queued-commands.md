# Plan 002: Prevent timed-out queued commands from executing

> Executor: follow each step, honor boundaries, run the gates, and report evidence. Reviewer maintains the index.
> Drift check: `git diff --stat 923c6bb..HEAD -- server.mjs test/server.test.mjs`. Compare current functions against excerpts; earlier approved plans may change the same file outside this plan's target functions.

## Status
- Priority: P1
- Effort: S
- Risk: LOW
- Category: bug
- Depends on: none functionally; serialize all plugin/code.js plans (001, 003, 005, 006) to avoid concurrent edits.
- Planned at: 923c6bb, 2026-09-08.

## Why this matters
sendLocalCommand times out by deleting a pending waiter but leaves its command queued. A resumed plugin poll can execute a mutation after the caller has received a failure; a retry can duplicate the change.

## Current state
Repository: /Users/davidbuck/Documents/ChatGPT/figma-local-bridge. Node >=20, ESM JavaScript, MCP SDK and Zod. server.mjs owns stdio/HTTP orchestration; plugin/code.js executes a narrow Figma Plugin API command set; credential-store.mjs isolates OS credential storage. Tests use node:test, assert/strict and VM Figma mocks. There is no typecheck or lint script.
```js
server.mjs:425-427
const timeout = setTimeout(() => {
  session.pending.delete(id);
  reject(new Error(`Figma did not respond within ${Math.round(timeoutMs / 1_000)} seconds. Confirm the bridge plugin is still open and connected.`));
}, timeoutMs);
// server.mjs:354
if (session.queue.length > 0) return json(response, 200, { command: session.queue.shift() });
```
Follow existing two-space formatting and helpers. plugin/code.js:920 removeFailedCreation is the new-node cleanup exemplar; test/plugin-logic.test.mjs:7 loadPluginHelpers executes actual source in a VM. Transport tests use random ports and temporary directories. Credential tests inject run rather than using real storage.
Preserve documented constraints: local-only canvas bridge, explicit scoped mutations, native editable composition, confirmed user preferences, secure storage without plaintext fallback.

## Scope
Only modify: `server.mjs`, `test/server.test.mjs`. The integration executor may regenerate dist/server.mjs once after all source changes using npm run build.
Out of scope: the xero-mcp mirror, personal/installed plugins, live Figma documents, dependencies/lockfile, version bumps, unrelated commands, deployment, remote pushes, main-branch changes. Do not apply the advisor skill to implementation.

## Git workflow
Use the shared executor's isolated worktree, starting at 923c6bb on advisor/figma-improve-20260908 (choose a unique suffix if already used). Never switch the original checkout. Commit logical fixes in that worktree only, imperative messages matching "Restore SVG safety validation". No merge, push, or PR. An executor with multiple workers must assign exclusive file ownership.

## Commands
Run inside the isolated worktree:
- `npm ci --ignore-scripts`: install locked dependencies, exit 0. Network/setup failure is a blocker; do not update the lockfile to bypass it.
- `node --test test/server.test.mjs`: focused tests pass after fix.
- `npm run check`: syntax checks plus all tests pass. Baseline has 25 tests; an initial local run had two connection-refused failures but rerun passed 25/25. Capture subprocess diagnostics for recurrence; do not weaken tests.
- `npm run build`: exit 0; rebuild bundled runtime in disposable worktree at integration.
- `git diff --check`: exit 0.
- `git diff --name-only 923c6bb`: only approved union of six plans plus generated dist/server.mjs.

## Steps
1. Read target functions and existing tests; verify drift and install dependencies. Run `npm run check`; expect baseline pass or diagnose the documented transient setup failure before implementation.
2. Add regressions: Cover queued expiry followed by polling (no command delivered), a stale entry preceding a live command (live command delivered once), ordinary success, and already-dispatched timeout (unknown outcome, late result safely ignored). Prefer extracted helper/VM controlled timers or the existing fake-plugin HTTP harness; do not add a 30-second sleep or connect to port 3846.
   Verify with the focused node --test command above: the new regression must fail for its intended behavior on baseline, not because the mock is missing unrelated APIs.
3. Implement: Remove a command that is still queued when its timeout expires. Use one shared eligible-command dequeue helper for immediate poll responses and completePoll, defensively skipping entries no longer pending. Preserve order for live commands. An already-dispatched operation cannot be rolled back by this transport: report its outcome as unknown and advise re-reading before retrying; never imply cancellation. Preserve owner/proxy transport and the public command envelope.
   Verify with the focused command: all cases pass, including new regressions.
4. Run `npm run check` and `git diff --check`: both exit 0. Review changed files against scope; integration executor rebuilds and verifies all combined fixes before final commit/report.

## Done criteria
- New regression cases above exist, failed on baseline for the expected reason, and pass after the change.
- Focused tests, npm run check, npm run build (integration), and git diff --check exit 0.
- Original checkout and live systems remain untouched except reviewer-authored plans.
- Report changed functions/files, commits, exact test totals, limits and any deviations. Reviewer updates plans/README.md.

## STOP conditions
Report to reviewer if target behavior has drifted, dependencies cannot install, the same gate fails twice after a reasonable fix attempt, or out-of-scope edits are necessary. Changing plugin protocol, retrying mutations automatically, or treating in-flight operations as cancelled is outside scope.

## Maintenance
Keep failure-path assertions when adding new awaited calls or setters to this operation. Do not substitute mock-only assertions for executing the actual source. Live Figma acceptance remains separate from local mock/integration proof.
