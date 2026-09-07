# Figma MCP improvement plans

Written 2026-09-08 against 923c6bb after a read-only audit. User authorized plans and an executor for all six findings. Reviewer maintains statuses.

| Plan | Title | Priority | Effort | Status |
|---|---|---|---|---|
| [001](001-repair-asset-discovery.md) | Repair design-system component discovery | P1 | S | DONE |
| [002](002-expire-queued-commands.md) | Prevent timed-out queued commands from executing | P1 | S | DONE |
| [003](003-recover-composition-failures.md) | Preserve originals when composition verification fails | P1 | M | DONE |
| [004](004-report-credential-removal-errors.md) | Report secure credential removal failures truthfully | P1 | S | DONE |
| [005](005-cleanup-failed-instances.md) | Remove newly created instances after failed configuration | P2 | S | DONE |
| [006](006-preflight-style-batches.md) | Validate style batches and report partial mutations | P2 | M | DONE |

## Execution and dependencies
All fixes are functionally independent. Execute plugin plans 001, 003, 005, 006 serially under one file owner. Transport 002 and credentials 004 may run in parallel with exclusive file ownership. The executor phase required isolated worktree commits and advisor review before integration. That phase is complete; the user subsequently authorized merge, install, commit and push. Earlier per-plan no-merge/no-push boundaries apply to that completed executor phase.

## Reviewed implementation (before merge)
Verdict: APPROVE, 2026-09-08. All six plans completed in isolated worktree /Users/davidbuck/Documents/ChatGPT/figma-improve-20260908 on branch advisor/figma-improve-20260908, commit 72cf4ab (Fix Figma bridge discovery and mutation failure handling). DONE means reviewed in that worktree, not merged or installed.

Reviewer independently read the complete source/test/generated-runtime diff and re-ran npm run check (62/62 passed), npm run build (exit 0; no generated drift), git diff --check 923c6bb..HEAD (exit 0), and verified the seven changed files match the approved scope. Original implementation checkout remains at 923c6bb with only this plans directory untracked; executor worktree is clean.

Review caught and executor fixed nonadjacent archive sibling-order recovery before approval. Plan 004 was amended using primary Apple source: ambiguous macOS reads warn and all nonzero deletion statuses reject, including absent-item responses. This deliberately trades macOS absent-delete idempotence for truthful failure reporting; see the amendment in plan 004. All other success contracts remain preserved; style failures add explicit partial results.

Executor used two subagents for transport and credentials, then integrated and committed. Executor reports baseline regressions failed for intended reasons, including 17 plugin regressions against original source. No live Figma, real credential storage, installed-plugin or deployment acceptance was run. No merge, push, or publication was performed.

## Integration and local installation
On 2026-09-08, following explicit user authorization, main was fast-forwarded to implementation commit 72cf4ab. The seven changed runtime/test files were copied to the configured installation at /Users/davidbuck/Documents/ChatGPT/xero-mcp/figma-local-bridge after verifying that each destination matched the pre-fix baseline. Installed copies were checked byte-for-byte and npm run check passed 62/62 there. The parent xero-mcp repository has unrelated dirty work and was not committed.

A fresh stdio MCP client launched the installed server on an isolated port, listed 53 tools including design-system discovery, and successfully read bridge status. The temporary client exited cleanly. This proves the installed runtime starts; it does not refresh existing Codex MCP processes.

This installation updates files on disk. No Figma plugin was connected at verification time. Existing Codex MCP processes predate the installation; the computer-use tool explicitly blocks the Codex app, preventing use of its Restart control. Restart figma_local through MCP settings and reopen/reload the Figma development plugin to activate the updated runtime. No live document edits were performed.

## Baseline and scope
npm run check: initial 23/25 with two connection-refused integration failures; rerun 25/25 passed on Node 26.7.0. No live Figma or real credential operations tested. Source checkout clean before plans. The xero-mcp mirror is outside implementation scope.

## Considered and deferred
- Local unauthenticated OS-user bridge access: documented trust model, not an independent vulnerability finding.
- Dependency audit advisories: reachable exploitation not established; no blind upgrades.
- Broad module split: defer until failure contracts are covered.
- Capability-aware status and official API typing gate: grounded follow-on directions, outside these six fixes.
- Initial integration startup failure: intermittent, cause unproven; investigate if it recurs rather than weakening tests.
