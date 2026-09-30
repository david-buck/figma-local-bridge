# Changelog

## 0.13.4 — 2026-09-30

- `figma_place_local_image` now accepts an approved HTTPS image URL as well as an absolute local image path. Provide exactly one source; PNG, JPEG, GIF, and WebP remain supported.
- URL downloads are capped at 25 MB, reject embedded credentials and non-public destinations, and recheck each destination across up to five redirects. The bridge checks image signatures before sending bytes to Figma and omits URL query strings from returned source metadata.
- Added offline checks for source validation, DNS and redirect restrictions, image signatures, transfer limits, and Node's DNS lookup callback modes.
- Updated the tool reference and workflow guidance for approved URL images. Reload the MCP server and Figma development plugin after updating.

## 0.13.3 — 2026-09-23

- Replaced the temporary mark with the supplied icon in the Codex plugin listing, composer, README, and Figma plugin status panel. All placements use the same unmodified PNG.
- Canvas commands and MCP tool behavior are unchanged.

## 0.13.2 — 2026-09-23

- Added a matching icon to the Codex plugin listing, composer, README, and Figma plugin status panel. The vector master and square PNG exports are in `assets/`.
- Aligned the Codex and Claude package versions with the bridge and Figma plugin. Canvas commands and MCP tool behavior are unchanged.

## 0.13.1 — 2026-09-23

- `figma_prepare_review` now reads ordered copy and runs optional overflow audits in one packaged plugin command, then exports one PNG per artboard. With two artboards and audits, the plugin handles three commands instead of five.
- The public MCP tool name, inputs, and output shape stay the same. The plugin runs only its built-in JavaScript; it does not accept agent-written code.
- Upgrade both parts: restart the MCP server and reload the Figma development plugin. Check that `figma_bridge_status` reports bridge and plugin version `0.13.1` before a live review.

## 0.13.0 — September 2026

- Added native section and frame composition safeguards, including collision checks and verified replacement before archiving prior layouts.
- Repaired design-system asset discovery and tightened timeout, rollback, credential-removal, instance-cleanup, and style-batch failure reporting.
