# Local Figma MCP bridge

This is a small, local-only bridge between an MCP client and a Figma plugin. It does not use the Figma REST API or Figma's hosted MCP server. The Figma plugin must be open in the file you intend to edit; it uses Figma's Plugin API under your own active Figma session.

The repository is a dual Codex/Claude package:

- `.codex-plugin/plugin.json`, `.mcp.json`, and `skills/` package the bridge and workflow for Codex.
- `.claude-plugin/plugin.json` and `.claude-mcp.json` package the same MCP server for Claude Code.
- `plugin/` contains the Figma Desktop development plugin. Importing it into Figma is still a separate, one-time step.
- `dist/server.mjs` is a self-contained MCP runtime. Recipients do not need this repository's parent project or its dependencies.

Clone it or download the latest release ZIP:

```bash
git clone https://github.com/david-buck/figma-local-bridge.git
cd figma-local-bridge
```

## What it can do today

- Report the active Figma selection.
- Create styled frames, rectangles, ellipses, and editable text on the current page.
- Set solid fills and strokes, opacity, corner radii, frame clipping, text wrapping, alignment, line height, and letter spacing.
- Create named local colour variables from prompt-supplied colour names and bind them to fills, strokes, and text.
- Place safe SVG strings as editable vector artwork (for approved logo assets, icons, and simple decorative devices).
- Parent newly created nodes inside a frame or other compatible container.
- List fonts installed in the open Figma desktop app before creating text.
- Apply or remove auto-layout on a selected frame, component, component set, or instance.
- List pages; navigate between them; query page nodes with IDs, bounds, hierarchy, and basic style metadata.
- Return PNG screenshots of a node or the visible current page.
- Move, resize, reparent, duplicate, select, read/update text in, or explicitly delete existing nodes.
- Read all frame or spread copy in visual reading order with IDs and hierarchy.
- Read compact copy-sync data containing only text IDs, copy, bounds, opacity, and effective visibility.
- Separate effectively visible copy from hidden/conditional text while retaining both for review.
- List only artboard-level frames, excluding incidental nested layout frames.
- Audit text overflow, clipping, truncation, missing fonts, and font sizes without changing the document; hidden and opacity-zero nodes are skipped by default.
- Export a frame directly to a local PNG under `~/Pictures/Figma MCP Exports` without returning base64 through MCP.
- Prepare one artboard or an ordered spread for review in one call: structured copy, local PNGs, then overflow audits.
- Apply multiple copy updates and return compact update verification, overflow audits, and local PNG paths in one MCP response.
- Resize text frames, change auto-resize/truncation, or split a mixed-style text layer into heading and body while preserving its range styles.
- Return summary frame/audit results by default to avoid oversized, truncated MCP responses; request full hierarchy only when needed.
- Compose a replacement frame with panels, dividers, and styled-span text in one guarded command, then audit and export it.
- Archive or supersede explicit sibling nodes into a hidden named group with replacement metadata instead of deleting them or leaving opacity-zero layers.
- List verified local variables/styles plus colours and fonts used on the page, or copy style from a known on-brand node.
- Discover verified local and currently used library components/styles, create linked component instances, and apply named styles by ID or key.
- Store explicit per-user design-system preferences locally, query/update/revert them through the LLM, and return a no-edit clarification result when plausible systems tie.
- Copy/crop an existing Figma image fill or place an explicitly approved local PNG/JPEG/GIF/WebP file.

It deliberately binds only to `127.0.0.1` and accepts only one open Figma file at a time. It does not accept arbitrary JavaScript. SVG imports reject scripts, event handlers, iframes, and `foreignObject` elements.

## Install the Figma Desktop plugin

1. In Figma desktop, open **Plugins → Development → Import plugin from manifest…**.
2. Select [`plugin/manifest.json`](plugin/manifest.json).
3. In the Figma file you want to edit, run **Plugins → Development → Local MCP Bridge**. It connects automatically; leave its small status panel open.

## Build from source

The committed `dist/server.mjs` is ready to run. To rebuild it after changing `server.mjs`:

```bash
npm ci
npm run build
npm run check
```

Node 20 or newer is required when running outside a host that supplies its own Node runtime.

## Use with Codex

Install the folder as a Codex plugin to load both the `figma_local` MCP tools and the included inspect-first skill. The plugin manifest is at `.codex-plugin/plugin.json` and its MCP configuration is in `.mcp.json`.

For a direct local MCP configuration instead, add the absolute path to the bundled server in `~/.codex/config.toml`:

```toml
[mcp_servers.figma_local]
command = "node"
args = ["/ABSOLUTE/PATH/TO/figma-local-bridge/dist/server.mjs"]
```

Start a new Codex task after installing or updating the plugin so its skills and MCP tool definitions are loaded.

## Use with Claude

The MCP tools work with Claude because the bridge uses standard stdio MCP rather than a Codex-specific protocol.

For Claude Code, install it as a local Claude plugin, or add the bundled server directly:

```bash
claude mcp add --scope user figma-local -- node /ABSOLUTE/PATH/TO/figma-local-bridge/dist/server.mjs
```

The `.claude-plugin/plugin.json` manifest and `.claude-mcp.json` use `${CLAUDE_PLUGIN_ROOT}` when it is installed as a Claude Code plugin. Claude Code can also discover the included `skills/figma-local-workflow/SKILL.md` from the plugin.

Claude Desktop can run the same server as a local desktop extension/MCP bundle, but this repository does not yet ship a signed or directory-listed extension. Directly shared local extensions should only be installed when the recipient trusts the source.

## Run a smoke test

Start it directly for a smoke test:

```bash
node dist/server.mjs
```

Open the Figma plugin in one file and call `figma_bridge_status` from the MCP client. The plugin retries automatically if the active bridge process changes.

Codex may start a separate MCP process for each task. Every process exposes the complete tool set over stdio, while one elected owner holds the localhost Figma connection and the others proxy commands to it. If the owner task closes, a proxy takes over automatically and the Figma plugin reconnects. Each process also exits when its own Codex parent or stdio client disappears. The plugin sends heartbeats during slow exports and audits, so those operations remain visibly connected. You should not need to kill a stale process manually or restart Codex merely because another task is using the bridge.

For a human-readable connection check, open [http://localhost:3846/](http://localhost:3846/). It shows the bridge version, connected plugin version, current Figma page, and last heartbeat. `figma_bridge_status` also reports whether the calling task is the bridge owner or a proxy. Opening the plugin in another Figma file deliberately transfers the single connection; the displaced plugin stops retrying until reloaded.

## Recommended inspect-first workflow

The MCP advertises this sequence in its server instructions, and the companion personal skill at `~/.codex/skills/figma-local-workflow` reinforces it:

1. `figma_bridge_status`, then `figma_get_user_preferences`
2. `figma_list_design_system_assets`, then `figma_list_artboards`
3. `figma_read_frame_content` or `figma_read_spread_content`
4. `figma_export_frame_png`
5. Analyse copy and layout together; run `figma_audit_text_overflow` when fit matters
6. Only then edit identified nodes
7. Re-read, re-audit, and re-export after editing

After artboard discovery, `figma_prepare_review` is the faster equivalent for one to eight known artboards. It performs steps 2–4 in order, writes each PNG locally, and does not edit the file.

This avoids guessed node IDs, partial-copy edits, and layout changes made without visual evidence.

### Design-system preference workflow

`figma_get_user_preferences` returns only choices the user explicitly confirmed. When choosing assets, prefer a matching scoped preference, then a linked component already used in the file, then another verified component/style/token, and construct from raw values only as a fallback. Use `figma_create_component_instance` and `figma_apply_design_style` to preserve linkage.

If multiple systems remain equally plausible, call `figma_resolve_design_choice`. A tie returns `needsClarification: true` with candidate details and must not trigger an edit. Ask the user which system to use; apply that answer once, or save it with `figma_set_user_preference` only after explicit confirmation. Preferences can be queried, updated, deleted, and reverted in ordinary LLM conversation. Revision guards prevent two MCP tasks from silently overwriting each other.

Preferences are private to the local OS user and stored at `~/.figma-local-bridge/preferences.json` by default. Set `FIGMA_PREFERENCES_DIR` to relocate the store. The bridge never infers or saves preferences from the canvas automatically.

### External copy-sync workflow

When the user identifies an external system as the source of truth:

1. List artboards and call `figma_read_copy` for the exact target frame IDs.
2. Diff external fields against the returned text IDs and `copy`. Omit unchanged nodes.
3. Call `figma_apply_copy_updates` once, passing each prior value as `expectedText`, and include affected frames in both `auditFrames` and `exportFrames`.
4. Inspect the local PNGs and audits returned by that call. Use `figma_set_text_frame` or `figma_split_text_block` only when changed hierarchy or fit requires it, then verify again.

Delete only a clearly stray element identified by the user. Preserve all other nodes, including hidden or superseded content.

### Page re-layout workflow

1. List artboards, read the target in `summary` mode, and export its current PNG.
2. Call `figma_list_design_system_assets` and `figma_list_page_tokens`. Prefer verified linked components, named styles, and variables; use `figma_copy_style_from_node` against an on-brand source node when needed. Do not approximate available assets, fonts, or colours.
3. Call `figma_compose_frame` with one named replacement frame and ordered frame/rectangle/text elements. Use styled spans for mixed emphasis and typographic case inside a single text layer; keep the stored copy in natural case. The command removes its whole new subtree if any element fails.
4. Prefer passing explicit `archiveNodeIds` to the composer so previous sibling content is grouped and hidden only after the replacement succeeds. Otherwise verify the replacement, then call `figma_supersede_layout` or `figma_archive_nodes`.
5. Inspect the returned compact overflow audit and local PNG. Re-read in `full` mode only when hierarchy or hidden variants require diagnosis.

## Updating the bridge

After changing `plugin/code.js`, reload the development plugin in Figma (**Plugins → Development → Local MCP Bridge → Reload plugin**). It reconnects automatically. Restart Codex after changing `server.mjs` so the MCP process and its tool definitions are reloaded.

Rebuild and run all local checks after bridge changes:

```bash
npm run build
npm run check
```

## Design-oriented tools

The bridge keeps its command surface intentionally narrow. It exposes the following controlled operations rather than arbitrary Plugin API code:

- `figma_create_frame` — exact dimensions, solid fill/stroke, clipping, auto-layout, and optional parent.
- `figma_create_rectangle` / `figma_create_ellipse` — graphic blocks, CTA backgrounds, and simple devices.
- `figma_create_text` — editable text with colour, wrapping, alignment, line height, letter spacing, typographic case, styled spans, opacity, and optional parent.
- `figma_style_node` — apply a constrained visual style to an existing node.
- `figma_create_color_tokens` — create/update local Figma colour variables using the prompt's colour names verbatim, then return token IDs for binding.
- `figma_import_svg` — place a validated SVG string as editable vectors.
- `figma_list_fonts` — discover installed typefaces and style names.
- `figma_list_pages` / `figma_navigate_to_page` — inspect and switch the active page.
- `figma_query_page_nodes` — inspect node IDs, bounds, ancestry, child counts, and concise visual metadata.
- `figma_screenshot` — return a PNG for a selected node or the visible page.
- `figma_move_resize_reparent`, `figma_set_selection`, `figma_duplicate_node` — controlled structural editing.
- `figma_read_text` / `figma_update_text` — inspect and replace existing editable text with its current fonts loaded first.
- `figma_read_copy` — compact, ordered text IDs/copy/bounds/visibility for external-source diffing.
- `figma_apply_copy_updates` — guarded style-preserving updates plus overflow audits and local PNG verification in one response.
- `figma_set_text_frame` — set text width, height, auto-resize, truncation, and line limits without replacing copy.
- `figma_split_text_block` — split one styled text layer into heading and body while preserving each range's typography.
- `figma_delete_node` — permanently remove one identified node and its descendants; use only on an explicit user request.
- `figma_read_frame_content` / `figma_read_spread_content` — ordered editorial copy with text-node IDs and hierarchy paths.
- `figma_list_artboards` — clean page-level and section-level artboard list, excluding nested implementation frames.
- `figma_audit_text_overflow` — bounds and natural-size checks with actionable overflow and clipping warnings.
- `figma_export_frame_png` — write a PNG to `~/Pictures/Figma MCP Exports` and return only its absolute path and dimensions.
- `figma_prepare_review` — read one to eight ordered artboards, export them locally, and optionally audit their text in one non-mutating call.
- `figma_archive_nodes` / `figma_supersede_layout` — hide explicit prior siblings in a named reversible group and record the replacement relationship.
- `figma_compose_frame` — atomically create a frame, panels/dividers, and styled-span text, optionally archive previous content, then audit/export.
- `figma_copy_style_from_node` / `figma_list_page_tokens` — inherit verified on-brand styling and discover local variables/styles plus page usage.
- `figma_list_design_system_assets` — discover components, styles, and variables verified in the current file, including remote assets currently used and enabled linked-library variable collections.
- `figma_create_component_instance` / `figma_apply_design_style` — create a linked instance or apply a named local/library style by verified ID or key.
- `figma_get_user_preferences` / `figma_set_user_preference` / `figma_delete_user_preference` / `figma_revert_user_preferences` — manage explicit, revision-guarded per-user design-system guidance.
- `figma_resolve_design_choice` — score candidates against confirmed scoped preferences and require clarification rather than guessing when they tie.
- `figma_copy_image_fill` / `figma_place_local_image` — reuse/crop an existing Figma image or place an explicitly approved local raster image.

For brand assets, read a trusted SVG file locally and pass its content to `figma_import_svg`; do not redraw logo artwork as text or paths.

### Colour-token workflow

When a prompt names colours, call `figma_create_color_tokens` before creating artwork. Preserve the supplied names exactly (for example, `Oxford blue`, `SBS orange`, `Lilac`, `White`, and `Black`) and provide their hex values. Use the returned `fillTokenId` or `strokeTokenId` on frames and shapes, and `fillTokenId` on text. This keeps the artwork bound to one reusable source of truth instead of scattering raw hex values across layers.

## Security model

The bridge listens only on localhost (`127.0.0.1`), so it is not reachable over your network. Browser requests are accepted only without an Origin header or from Figma origins; unrelated web pages cannot use its CORS surface. It intentionally removes the former shared token to make the local Figma workflow frictionless. Other local processes running as you on this Mac could still call its port while Codex is open, so do not use it on a shared, untrusted Mac.

The preference store is created with user-only file permissions. It contains guidance you explicitly ask the LLM to remember, not Figma document contents. No preference is learned or written automatically.
