# Changelog

## 0.13.1 — 2026-09-23

- `figma_prepare_review` now reads ordered copy and runs optional overflow audits in one packaged plugin command, then exports one PNG per artboard. With two artboards and audits, the plugin handles three commands instead of five.
- The public MCP tool name, inputs, and output shape stay the same. The plugin runs only its built-in JavaScript; it does not accept agent-written code.
- Upgrade both parts: restart the MCP server and reload the Figma development plugin. Check that `figma_bridge_status` reports bridge and plugin version `0.13.1` before a live review.

## 0.13.0 — September 2026

- Added native section and frame composition safeguards, including collision checks and verified replacement before archiving prior layouts.
- Repaired design-system asset discovery and tightened timeout, rollback, credential-removal, instance-cleanup, and style-batch failure reporting.
