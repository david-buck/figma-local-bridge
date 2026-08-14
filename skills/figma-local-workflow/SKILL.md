---
name: figma-local-workflow
description: Use the local figma_local MCP bridge to inspect, analyse, edit, copy-sync, re-layout, compose, archive, style, add approved images to, or export the Figma Design file currently open in Figma Desktop. Trigger for requests to review artboards or spreads, sync external source copy such as Fieldwerk, read or revise copy, inspect or replace layouts, inherit page styles/tokens, audit text overflow, export frame PNGs, or make controlled canvas changes through the Local MCP Bridge plugin.
---

# Local Figma workflow

Use an inspect-first sequence. Do not begin by querying arbitrary page nodes or editing the current selection.

## Required sequence

1. Call `figma_bridge_status`. Continue only when exactly one plugin is connected, and use its reported page name to confirm the expected Figma context.
2. Call `figma_list_artboards` to discover stable artboard IDs and page order. Never guess IDs. If the relevant artboard is absent, call `figma_list_pages`, navigate with `figma_navigate_to_page`, then list artboards again.
3. Identify the relevant artboard or page pair:
   - Call `figma_read_frame_content` with `detail: summary` for one artboard.
   - Call `figma_read_spread_content` with `detail: summary` for a spread, passing `nodeIds` in the order returned by `figma_list_artboards`.
   - Request `detail: full` only when hierarchy or hidden variants are needed.
4. Call `figma_export_frame_png` for each relevant artboard and inspect the returned local PNG path. Use the visual together with the structured copy; neither is sufficient alone.
5. Analyse copy and layout before proposing or making changes. Call `figma_audit_text_overflow` when text fit, truncation, clipping, or typography may matter.
6. Only then edit identified nodes. Prefer the narrowest appropriate mutation tool and preserve unrelated content.
7. Verify after editing:
   - Re-read affected frame or spread content.
   - Re-run the overflow audit when text or dimensions changed.
   - Re-export the affected artboard PNG and inspect it.

## Fast review path

After artboard discovery, prefer `figma_prepare_review` when reviewing one to eight known artboards. It performs the read, local PNG exports, and optional overflow audits in that order without editing. Inspect every returned PNG before analysis. Use the individual tools when only one result is needed or when diagnosing a failed step.

## Delegated copy preparation

Use a capable subagent for copy analysis or source-to-Figma diffing when it will reduce context cost, especially across several pages. Do this *before* the live bridge session.

- Give the subagent the source copy and a compact, already-captured Figma copy snapshot with frame IDs and text-node IDs.
- Ask it to return a narrow diff packet: frame ID, node ID, exact current text, replacement text and a one-line rationale. Omit unchanged nodes.
- Keep the subagent read-only. It must not call the local bridge, edit the Figma file, or perform visual verification.
- The primary agent owns the live bridge connection, makes all mutations serially, and verifies the rendered result.

The bridge has one live plugin connection and Figma mutations are serial. Delegation improves preparation quality and token use; it does not make the live write path parallel or safer.

## Copy sync recipe

Use this deterministic flow when Fieldwerk or another external source is the copy source of truth:

1. Confirm the bridge/page and list artboards. Identify the exact target frame IDs.
2. Call `figma_read_copy` with those frame IDs and `includeHidden: false`. Use its text IDs and copy as the Figma side of the diff; do not request full hierarchy unless the compact result is ambiguous.
3. Diff source fields against Figma text IDs outside the bridge. Omit unchanged nodes. Preserve `expectedText` from the compact read for every proposed update.
4. For a small, known-safe batch, call `figma_apply_copy_updates` with narrow updates. Keep hidden text excluded unless the source explicitly targets a hidden variant. For longer copy, several frames or a bridge that has been slow, use serial `figma_update_text` calls instead.
5. Audit and export *after* the writes in separate calls. Do not make a large write, audit and export transaction depend on one long bridge request.
6. Inspect every exported PNG and audit result. If hierarchy or fit changed, use `figma_set_text_frame` for sizing/auto-resize or `figma_split_text_block` at a verified character boundary; then audit and export again.
7. Re-read compact copy when an `expectedText` guard fails or verification is incomplete. Never overwrite a concurrent Figma edit from stale source data.

### Timeout recovery

If a mutation batch times out, do not retry it immediately. Reconnect the plugin if needed, then re-read the affected visible text and determine which updates landed. Apply only the remaining changes with fresh `expectedText` guards. Do not create an alternate frame, hide the old one or issue a second blind batch to recover.

## Re-layout a page recipe

Use this deterministic flow when replacing an existing brochure page or artboard layout:

1. Confirm the bridge/page, list artboards, read the exact target with `detail: summary`, and export its current PNG before changing anything.
2. Call `figma_list_page_tokens` to discover verified local variables, styles, colours, and fonts. Use `figma_copy_style_from_node` when a known source node is the clearest brand reference. Never approximate a value already present in the file.
3. Define one clearly named replacement frame. Call `figma_compose_frame` with ordered frame/rectangle/text elements; use styled spans for mixed emphasis inside one text layer. Keep keys unique and declare parent elements before their children.
4. Prefer supplying explicit previous sibling IDs in `archiveNodeIds`. The composer must build successfully before it groups those nodes into the hidden named archive. If composition and archiving are separate, verify the replacement first, then call `figma_supersede_layout` or `figma_archive_nodes` with the replacement ID.
5. Inspect the compact audit and local PNG returned by the composer. If verification is incomplete, preserve the previous layout and diagnose before retrying. Use a full read only when the summary lacks necessary hierarchy.
6. Re-read the replacement in summary mode and confirm the archive name/replacement relationship. Do not delete the archived group unless the user later identifies it for permanent removal.

## Working rules

- Treat artboard IDs and text-node IDs returned by read tools as the source of truth.
- Read a whole frame or spread before changing individual text nodes; surrounding copy determines meaning and fit.
- Keep spread order explicit. Do not infer left/right order from node names.
- Treat `copy` as effectively visible text. Check `allCopy`, `hiddenTextCount`, and each text item's `effectiveVisible` value when hidden variants or conditional content matter.
- Preserve the underlying copy's natural character case. Express uppercase, lowercase, title case or small caps through Figma typography (`textCase` on the text layer or styled span) instead of rewriting the stored characters. Only change the characters themselves when the source copy or user explicitly requires different casing; this keeps editing, accessibility, search and later restyling intact.
- Treat emphasis, case, decoration, line height, letter spacing, font family/style, and size as typography—not copy. Prefer verified Figma text styles, `figma_copy_style_from_node`, or styled-span options over manually altering characters or splitting text into extra layers.
- Use `figma_update_text` only for an identified text node. Use structural tools only after inspecting hierarchy and bounds.
- Make small, reversible batches and verify each batch before continuing.
- For copy-only work, overwrite the existing visible text layers. Do not create duplicate layouts, hide existing layers, or reduce old nodes to zero opacity. Use replacement/archival only for an explicitly requested layout change, and state the result clearly.
- Prefer `figma_archive_nodes` or `figma_supersede_layout` over opacity-zero superseded layers. Archive only explicit siblings and always record the replacement when one exists.
- Use `figma_compose_frame` for bounded page composition that would otherwise require many serial creation calls. Treat its audit and exported PNG as required verification, not optional decoration.
- Use `figma_place_local_image` only for an absolute local image path the user explicitly placed in scope. Prefer `figma_copy_image_fill` when an approved image already exists in Figma.
- Delete only a clearly stray element that the user identified. Otherwise preserve it, including superseded or hidden elements.
- Prefer `figma_export_frame_png` over inline screenshots for detailed visual review; it avoids base64 truncation.
- Keep bridge calls serial and in one task. A newer open plugin deliberately takes over the single local connection; the displaced plugin stops retrying.
- If the `figma_local` tools are absent from the task, stop and report that Codex has not loaded the configured MCP server. Do not substitute the hosted Figma MCP without the user's permission.
