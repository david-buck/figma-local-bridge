# Detailed workflows and tool reference

The [README](../README.md) has setup and the quickest review path. The bundled [workflow skill](../skills/figma-local-workflow/SKILL.md) gives agents the inspect-first sequence.

## Workflows

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

### Colour-token workflow

When a prompt names colours, call `figma_create_color_tokens` before creating artwork. Preserve the supplied names exactly (for example, `Oxford blue`, `SBS orange`, `Lilac`, `White`, and `Black`) and provide their hex values. Use the returned `fillTokenId` or `strokeTokenId` on frames and shapes, and `fillTokenId` on text. This keeps the artwork bound to one reusable source of truth instead of scattering raw hex values across layers.

## Tool reference

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
- `figma_inspect_canvas_layout` — list native sections and the occupied canvas envelope, or collision-check an existing/proposed placement against visible siblings.
- `figma_screenshot` — return a PNG for a selected node or the visible page.
- `figma_move_resize_reparent`, `figma_set_selection`, `figma_duplicate_node` — controlled structural editing.
- `figma_read_text` / `figma_update_text` — inspect and replace existing editable text with its current fonts loaded first.
- `figma_set_text_case` — display existing natural-case copy as uppercase, lowercase, title case, small caps, or original without rewriting its characters.
- `figma_read_copy` — compact, ordered text IDs/copy/bounds/visibility for external-source diffing.
- `figma_apply_copy_updates` — guarded style-preserving updates plus overflow audits and local PNG verification in one response.
- `figma_set_text_frame` — set text width, height, auto-resize, truncation, and line limits without replacing copy.
- `figma_split_text_block` — split one styled text layer into heading and body while preserving each range's typography.
- `figma_delete_node` — permanently remove one identified node and its descendants; use only on an explicit user request.
- `figma_read_frame_content` / `figma_read_spread_content` — ordered editorial copy with text-node IDs and hierarchy paths.
- `figma_list_artboards` — clean page-level and section-level artboard list, excluding nested implementation frames.
- `figma_create_section` — create a native reference-board/artboard section with collision rejection by default.
- `figma_audit_text_overflow` — bounds and natural-size checks with actionable overflow and clipping warnings.
- `figma_export_frame_png` — write a PNG to `~/Pictures/Figma MCP Exports` and return only its absolute path and dimensions.
- `figma_prepare_review` — read and optionally audit one to eight ordered artboards in one packaged plugin operation, then export them locally in the same MCP call.
- `figma_archive_nodes` / `figma_supersede_layout` — hide explicit prior siblings in a named reversible group and record the replacement relationship.
- `figma_compose_frame` — atomically create a native frame in the page or a section, with root auto-layout, panels/dividers and styled-span text; reject accidental overlap and empty/incomplete results.
- `figma_copy_style_from_node` / `figma_list_page_tokens` — inherit verified on-brand styling and discover local variables/styles plus page usage.
- `figma_list_design_system_assets` — discover components, styles, and variables verified in the current file, including remote assets currently used and enabled linked-library variable collections.
- `figma_create_component_instance` / `figma_apply_design_style` — create a linked instance or apply a named local/library style by verified ID or key.
- `figma_get_user_preferences` / `figma_set_user_preference` / `figma_delete_user_preference` / `figma_revert_user_preferences` — manage explicit, revision-guarded per-user design-system guidance.
- `figma_resolve_design_choice` — score candidates against confirmed scoped preferences and require clarification rather than guessing when they tie.
- `figma_copy_image_fill` / `figma_place_local_image` — reuse/crop an existing Figma image or place an explicitly approved local raster image.
- `figma_comment_status` / `figma_list_comments` — check optional REST setup and read file comments, with resolved comments excluded by default.
- `figma_post_comment` — post a canvas- or frame-pinned comment, or reply to an existing comment.
- `figma_delete_comment` — permanently delete one identified comment behind an explicit confirmation guard.

For brand assets, read a trusted SVG file locally and pass its content to `figma_import_svg`; do not redraw logo artwork as text or paths. SVG import is only for approved logos, icons and isolated vector artwork—not boards, UI layouts, panels or editable labels.

## Optional comment setup

Figma does not expose comments to its Plugin API, so comment tools are the one part of the bridge that needs REST credentials. Open **Figma API access** in the connected plugin, paste a personal access token and the file URL, then choose **Save & test**. Grant `file_comments:read`; add `file_comments:write` if you also want to post, reply, or delete.

The bridge saves the token in macOS Keychain, Windows user-scoped DPAPI encryption, or Linux Secret Service. If secure system storage is unavailable, it says so and keeps the token only for the current bridge session—there is no plaintext fallback. The plugin immediately clears the password field and never puts the token in the Figma document, plugin storage, logs, or MCP output.

**Save & test** safely verifies comment-read access against the chosen file. Figma does not provide scope introspection, so write access remains “not tested” until you intentionally post a comment. As an advanced alternative, set `FIGMA_ACCESS_TOKEN` and `FIGMA_FILE_KEY` privately in the MCP server environment; environment-managed credentials cannot be changed in the plugin.

## Security model

The canvas bridge listens only on localhost (`127.0.0.1`), so it is not reachable over your network. Browser requests are accepted only without an Origin header or from Figma origins; unrelated web pages cannot use its CORS surface. It intentionally removes the former shared bridge token to make the local Figma workflow frictionless. Other local processes running as your OS user could still call its port while the MCP is open, so do not use it on a shared, untrusted computer.

If comment support is enabled, the server sends the saved token only to Figma's configured API endpoint in an `X-Figma-Token` header. The plugin UI passes a newly entered token directly to the authenticated localhost bridge, clears the field immediately, and never sends it through the plugin main thread or stores it in the Figma document. Secure storage is macOS Keychain, Windows CurrentUser DPAPI, or Linux Secret Service; when none is usable, the UI reports a session-only fallback. Environment variables remain available for managed setups. Grant only the comment scopes you need. Canvas tools continue to work without a token.

The preference store is created with user-only file permissions. It contains guidance you explicitly ask the LLM to remember, not Figma document contents. No preference is learned or written automatically.
