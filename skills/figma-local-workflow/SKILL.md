---
name: figma-local-workflow
description: Use the local figma_local MCP bridge to inspect, analyse, edit, copy-sync, re-layout, compose, archive, style, use design-system components and confirmed user preferences, add approved images to, or export the Figma Design file currently open in Figma Desktop. Trigger for requests to review artboards or spreads, sync copy with an external source, read or revise copy, inspect or replace layouts, use linked components/styles/tokens, audit text overflow, export frame PNGs, or make controlled canvas changes through the Local MCP Bridge plugin.
---

# Local Figma workflow

Use an inspect-first sequence. Do not begin by querying arbitrary page nodes or editing the current selection.

## Required sequence

1. Call `figma_bridge_status`. Continue only when exactly one plugin is connected, and use its reported page name to confirm the expected Figma context.
2. Call `figma_get_user_preferences` before choosing components, styles, tokens, typography, layout conventions, or copy patterns. Treat only returned confirmed preferences as durable user guidance.
3. Call `figma_list_design_system_assets`, then `figma_list_artboards`. Discover verified component/style/token candidates and stable artboard IDs; never guess IDs or recreate an appropriate available component. If the relevant artboard is absent, call `figma_list_pages`, navigate with `figma_navigate_to_page`, then repeat discovery.
4. Identify the relevant artboard or page pair:
   - Call `figma_read_frame_content` with `detail: summary` for one artboard.
   - Call `figma_read_spread_content` with `detail: summary` for a spread, passing `nodeIds` in the order returned by `figma_list_artboards`.
   - Request `detail: full` only when hierarchy or hidden variants are needed.
5. For routine copy-only work, use the structured read and `figma_audit_text_overflow`; do not export or screenshot by default. Export or screenshot only when layout, imagery, geometry or uncertain wrapping needs visual judgement.
6. Analyse copy and layout before proposing or making changes. Call `figma_audit_text_overflow` when text fit, truncation, clipping, or typography may matter.
7. Only then edit identified nodes. Prefer the narrowest appropriate mutation tool and preserve unrelated content.
8. Verify after editing:
   - Re-read affected frame or spread content.
   - Re-run the overflow audit when text or dimensions changed.
   - Capture a screenshot only for uncertain wraps, adjacency or visual hierarchy; export a PNG only for a full-page/layout review, imagery or retained comparison.

## Fast review path

After artboard discovery, use `figma_prepare_review` only for a visual page/spread review. It performs the read, local PNG exports, and optional overflow audits in that order without editing. For copy reconciliation, prefer `figma_read_copy` and overflow auditing so routine work does not consume image tokens.

## Layout responsibility and evidence cost

Use the bridge for deterministic mechanics: frame geometry, hierarchy, components, named styles, text bounds, overflow, alignment and mutations. Use this skill for editorial hierarchy, page purpose, content density, print-reading judgement and deciding when an image review is worth its cost.

Do not ask image output to prove routine text updates. Treat text bounds, re-read copy and overflow results as sufficient unless a change may alter adjacent elements, column balance, image relationship or hierarchy. Prefer one targeted screenshot over a PNG export when a visual check is necessary.

## Design-system preferences and tie-breaks

Treat the bridge preference store as explicit per-user memory, not automatic learning.

- Query it with `figma_get_user_preferences`. The user may ask in natural language what is known, why a choice is preferred, or which scope it applies to; answer from the returned records.
- Prefer assets in this order: a confirmed scoped user choice; an appropriate linked-system component already used in the file; another verified component instance; a named style or bound variable; a verified source-node style; raw construction only when none applies.
- Use `figma_create_component_instance` for a verified component ID/key and `figma_apply_design_style` for a verified style ID/key. Preserve component linkage and variables instead of detaching or copying raw values.
- When two or more systems or assets remain equally plausible, call `figma_resolve_design_choice`. If it returns `needsClarification: true`, make no edit and ask the returned question with a concise candidate list. Never settle the tie from visual similarity, current selection, or library order.
- After the user answers a tie, use that choice for the current task. Offer to save it with an appropriate project, document-type, or context scope; do not save unless the user explicitly confirms.
- Create or update a record with `figma_set_user_preference` only from explicit user guidance. Read first and pass `expectedRevision`. Use the same revision guard for delete or revert operations.
- Do not convert a one-off canvas choice into an ongoing preference. Do not silently infer taste from existing documents, generated layouts, or repeated tool calls.
- A linked library must already be enabled by the user in the Figma file. If an expected library is unavailable, explain that boundary rather than approximating its assets.

## Delegated copy preparation

Use a capable subagent for copy analysis or source-to-Figma diffing when it will reduce context cost, especially across several pages. Do this *before* the live bridge session.

- Give the subagent the source copy and a compact, already-captured Figma copy snapshot with frame IDs and text-node IDs.
- Ask it to return a narrow diff packet: frame ID, node ID, exact current text, replacement text and a one-line rationale. Omit unchanged nodes.
- Keep the subagent read-only. It must not call the local bridge, edit the Figma file, or perform visual verification.
- The primary agent owns the live bridge connection, makes all mutations serially, and verifies the rendered result.

The bridge has one live plugin connection and Figma mutations are serial. Delegation improves preparation quality and token use; it does not make the live write path parallel or safer.

## External copy-sync recipe

Use this flow only after the user identifies which source is authoritative and the intended sync direction:

1. Confirm the bridge/page and list artboards. Identify the exact target frame IDs.
2. Call `figma_read_copy` with those frame IDs and `includeHidden: false`. Use its text IDs and copy as the Figma side of the diff; do not request full hierarchy unless the compact result is ambiguous.
3. Fetch the latest external source, then diff it against the visible Figma text IDs in the user-requested direction. Omit unchanged nodes and preserve source-specific metadata that the user did not ask to replace.
4. Re-fetch or stop on a source conflict. Never overwrite a newer external or Figma change blindly.
5. Preserve `expectedText` from the compact Figma read for every proposed Figma update. Keep hidden text excluded unless the source explicitly targets a hidden variant.
6. For a small, known-safe Figma batch, call `figma_apply_copy_updates`. For longer copy, several frames or a bridge that has been slow, use serial `figma_update_text` calls instead.
7. Audit and inspect after layout-affecting Figma edits. Use a re-read and overflow audit for routine copy-only edits; use a screenshot for uncertain wraps and a PNG export for layout, imagery, full-page review or retained comparison.
8. Re-read compact copy when an `expectedText` guard fails or verification is incomplete. Never overwrite a concurrent edit from stale source data.

### Timeout recovery

If a mutation batch times out, do not retry it immediately. Reconnect the plugin if needed, then re-read the affected visible text and determine which updates landed. Apply only the remaining changes with fresh `expectedText` guards. Do not create an alternate frame, hide the old one or issue a second blind batch to recover.

## Re-layout a page recipe

Use this deterministic flow when replacing an existing brochure page or artboard layout:

1. Confirm the bridge/page, list artboards, read the exact target with `detail: summary`, and export its current PNG before changing anything.
2. Use `figma_list_design_system_assets` and `figma_list_page_tokens` to discover verified components, variables, styles, colours, and fonts. Prefer an appropriate component instance or named style; use `figma_copy_style_from_node` when a known source node is the clearest brand reference. Never approximate a value already present in the file.
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
- Preserve design-system linkage. Prefer `figma_create_component_instance`, `figma_apply_design_style`, and bound variables over detached copies or hand-built imitations.
- Use `figma_update_text` only for an identified text node. Use structural tools only after inspecting hierarchy and bounds.
- Make small, reversible batches and verify each batch before continuing.
- For copy-only work, overwrite the existing visible text layers. Do not create duplicate layouts, hide existing layers, or reduce old nodes to zero opacity. Use replacement/archival only for an explicitly requested layout change, and state the result clearly.
- Prefer `figma_archive_nodes` or `figma_supersede_layout` over opacity-zero superseded layers. Archive only explicit siblings and always record the replacement when one exists.
- Use `figma_compose_frame` for bounded page composition that would otherwise require many serial creation calls. Treat its audit and exported PNG as required verification, not optional decoration.
- Use `figma_place_local_image` only for an absolute local image path the user explicitly placed in scope. Prefer `figma_copy_image_fill` when an approved image already exists in Figma.
- Delete only a clearly stray element that the user identified. Otherwise preserve it, including superseded or hidden elements.
- Use `figma_screenshot` for a targeted, one-off visual check. Use `figma_export_frame_png` only for a full-page/layout review, imagery, comparison or an artefact that needs to be retained; do not export routine copy-only changes.
- Keep bridge calls serial and in one task. A newer open plugin deliberately takes over the single local connection; the displaced plugin stops retrying.
- If the `figma_local` tools are absent from the task, stop and report that Codex has not loaded the configured MCP server. Do not substitute the hosted Figma MCP without the user's permission.
