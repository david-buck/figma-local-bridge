# Local Figma MCP bridge

<img src="assets/composer-icon.png" alt="Figma Local Bridge icon" width="64" height="64">

Use MCP tools to inspect and edit the Figma Design file open in Figma Desktop. A local Figma plugin performs canvas operations through the Plugin API; the MCP server relays named, validated commands to it. Canvas work needs no Figma API token. Comments are optional and use Figma's REST API.

The bridge can read artboards and copy, inspect layout and design-system assets, audit text fit, export PNGs, and make controlled edits to native Figma nodes. It connects to one open Figma file at a time and never runs JavaScript supplied by an agent. See the [tool and workflow reference](docs/reference.md) for the full list.

## Quick start

1. Clone this repository or download a release ZIP. Node 20 or newer runs the included `dist/server.mjs`; a build is not required for the committed bundle.
2. In Figma Desktop, choose **Plugins → Development → Import plugin from manifest…** and select [`plugin/manifest.json`](plugin/manifest.json).
3. Configure your MCP client to run `node /ABSOLUTE/PATH/TO/figma-local-bridge/dist/server.mjs`. For Codex, install this folder as a plugin or add:

   ```toml
   [mcp_servers.figma_local]
   command = "node"
   args = ["/ABSOLUTE/PATH/TO/figma-local-bridge/dist/server.mjs"]
   ```

4. Open the target Figma file and run **Plugins → Development → Local MCP Bridge**. Leave its status panel open.
5. Call `figma_bridge_status`. Check that it names the expected page and reports a connected plugin.

Claude Code can use the same server with `claude mcp add --scope user figma-local -- node /ABSOLUTE/PATH/TO/figma-local-bridge/dist/server.mjs`. The repository also includes Codex and Claude plugin manifests and the [inspect-first workflow skill](skills/figma-local-workflow/SKILL.md).

## Review an artboard or spread

Call `figma_list_artboards` to get IDs, then call `figma_prepare_review` with one to eight IDs in reading order. For example:

```json
{"nodeIds":["1:2","1:3"],"auditOverflow":true}
```

The result contains ordered copy, optional overflow audits, and local PNG paths under `~/Pictures/Figma MCP Exports` by default. It leaves no document edits. Use the individual read and audit tools for copy-only work that does not need images.

In **0.13.1**, the review call gathers copy and overflow results in one packaged plugin operation, followed by one PNG export command per artboard. A two-artboard review with audits uses three plugin commands instead of five; the MCP tool name and output shape stay the same. See the [changelog](CHANGELOG.md).

## Update or test

After updating, restart the `figma_local` MCP process in your client and reload the Figma development plugin. Check `figma_bridge_status`: both bridge and plugin should report the same version. The local status page is at [localhost:3846](http://localhost:3846/). An old running process may still report its previous version until restarted.

To build and run local checks from source:

```bash
npm ci
npm run build
npm run check
```

For a live check, run `figma_prepare_review` on two known artboards and confirm ordered copy, two PNG files, and two audits. The packaged read should appear as one plugin activity, followed by two exports. A live Figma-file check is separate from the local automated tests.

## Optional comments and safety

Canvas tools stay local to `127.0.0.1`. The bridge accepts one connected Figma plugin and does not execute agent-written JavaScript. SVG imports reject scripts and event handlers. Other processes running as your OS user can access the local bridge while it is open; use it on a trusted computer.

To read or write comments, configure **Figma API access** in the plugin with a personal access token and the file URL. Grant `file_comments:read`, plus `file_comments:write` only if needed. The token is kept in secure OS storage when available; canvas tools work without it. See [comment setup and the full security model](docs/reference.md#optional-comment-setup).
