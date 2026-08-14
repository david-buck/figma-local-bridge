import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      socket.close(() => resolve(address.port));
    });
  });
}

async function waitForBridge(url) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await fetch(url);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}

function rpcClient(child) {
  let buffer = "";
  let nextId = 1;
  const pending = new Map();

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const newline = buffer.indexOf("\n");
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    }
  });

  return {
    request(method, params = {}) {
      const id = nextId;
      nextId += 1;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    notify(method, params = {}) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
  };
}

async function postJson(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function toolJson(result) {
  assert.equal(result.isError, undefined);
  return JSON.parse(result.content[0].text);
}

test("bridge advertises and orchestrates review and copy-sync workflows", async (context) => {
  const port = await freePort();
  const exportDirectory = await mkdtemp(join(tmpdir(), "figma-local-bridge-test-"));
  const child = spawn(process.execPath, [new URL("../server.mjs", import.meta.url).pathname], {
    cwd: new URL("../..", import.meta.url).pathname,
    env: { ...process.env, FIGMA_BRIDGE_PORT: String(port), FIGMA_EXPORT_DIR: exportDirectory },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  context.after(async () => {
    if (child.exitCode === null) {
      child.stdin.end();
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
      if (child.exitCode === null) child.kill("SIGTERM");
    }
    await rm(exportDirectory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForBridge(`${baseUrl}/health`);
  const dashboard = await fetch(`${baseUrl}/`);
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /Local Figma MCP Bridge/);
  const initialHttpStatus = await (await fetch(`${baseUrl}/v1/status`)).json();
  assert.equal(initialHttpStatus.connected, false);
  const rpc = rpcClient(child);
  const initialized = await rpc.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "figma-bridge-test", version: "1.0.0" },
  });
  assert.equal(initialized.serverInfo.version, "0.9.1");
  assert.match(initialized.instructions, /figma_prepare_review/);
  assert.match(initialized.instructions, /figma_apply_copy_updates/);
  rpc.notify("notifications/initialized");

  const listed = await rpc.request("tools/list");
  const toolNames = new Set(listed.tools.map((tool) => tool.name));
  for (const name of [
    "figma_prepare_review", "figma_read_copy", "figma_apply_copy_updates", "figma_set_text_frame", "figma_split_text_block",
    "figma_archive_nodes", "figma_supersede_layout", "figma_compose_frame", "figma_copy_style_from_node", "figma_list_page_tokens", "figma_copy_image_fill", "figma_place_local_image",
  ]) {
    assert.ok(toolNames.has(name), `${name} should be advertised`);
  }
  assert.equal(toolJson(await rpc.request("tools/call", { name: "figma_bridge_status", arguments: {} })).connected, false);

  const denied = await fetch(`${baseUrl}/v1/connect`, {
    method: "OPTIONS",
    headers: { origin: "https://untrusted.example" },
  });
  assert.equal(denied.status, 403);

  const sessionId = "test-session";
  const connected = await postJson(`${baseUrl}/v1/connect`, {
    sessionId,
    clientId: "test-client",
    info: { pluginVersion: "test", editorType: "figma", pageId: "0:1", pageName: "Campaign", selectionCount: 0 },
  });
  assert.equal(connected.status, 200);
  const status = toolJson(await rpc.request("tools/call", { name: "figma_bridge_status", arguments: {} }));
  assert.equal(status.connected, true);
  assert.equal(status.plugin.pageName, "Campaign");
  assert.equal(status.mcpProcess.role, "owner");

  const proxyChild = spawn(process.execPath, [new URL("../server.mjs", import.meta.url).pathname], {
    cwd: new URL("../..", import.meta.url).pathname,
    env: { ...process.env, FIGMA_BRIDGE_PORT: String(port), FIGMA_EXPORT_DIR: exportDirectory },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let proxyStderr = "";
  proxyChild.stderr.setEncoding("utf8");
  proxyChild.stderr.on("data", (chunk) => { proxyStderr += chunk; });
  context.after(async () => {
    if (proxyChild.exitCode === null) {
      proxyChild.stdin.end();
      await Promise.race([
        new Promise((resolve) => proxyChild.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
      if (proxyChild.exitCode === null) proxyChild.kill("SIGTERM");
    }
  });
  const proxyRpc = rpcClient(proxyChild);
  const proxyInitialized = await proxyRpc.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "figma-bridge-proxy-test", version: "1.0.0" },
  });
  assert.equal(proxyInitialized.serverInfo.version, "0.9.1");
  proxyRpc.notify("notifications/initialized");
  const proxyStatus = toolJson(await proxyRpc.request("tools/call", { name: "figma_bridge_status", arguments: {} }));
  assert.equal(proxyStatus.connected, true);
  assert.equal(proxyStatus.mcpProcess.role, "proxy");
  assert.equal(proxyStatus.mcpProcess.ownerProcessId, child.pid);

  async function serveOne(expectedName, createResult) {
    while (true) {
      const response = await fetch(`${baseUrl}/v1/poll?sessionId=${sessionId}&pageId=0%3A1&pageName=Campaign&selectionCount=0`);
      if (response.status === 204) continue;
      assert.equal(response.status, 200);
      const { command } = await response.json();
      assert.equal(command.name, expectedName);
      const result = await createResult(command);
      const posted = await postJson(`${baseUrl}/v1/result`, { sessionId, id: command.id, ok: true, result });
      assert.equal(posted.status, 204);
      return command;
    }
  }

  const commandNames = [];
  const fakePlugin = (async () => {
    for (let handled = 0; handled < 5;) {
      const response = await fetch(`${baseUrl}/v1/poll?sessionId=${sessionId}&pageId=0%3A1&pageName=Campaign&selectionCount=0`);
      if (response.status === 204) continue;
      assert.equal(response.status, 200);
      const { command } = await response.json();
      commandNames.push(command.name);
      let result;
      if (command.name === "readSpreadContent") {
        result = { page: { id: "0:1", name: "Campaign" }, frameCount: 2, frames: [], copy: "Left\n\nRight" };
      } else if (command.name === "exportFramePng") {
        result = { imageBase64: onePixelPng, mimeType: "image/png", nodeId: command.input.nodeId, nodeName: `Frame ${command.input.nodeId}`, width: 1, height: 1 };
      } else if (command.name === "auditTextOverflow") {
        result = { frame: { id: command.input.nodeId }, textCount: 0, warningCount: 0, text: [] };
      } else {
        throw new Error(`Unexpected command ${command.name}`);
      }
      const posted = await postJson(`${baseUrl}/v1/result`, { sessionId, id: command.id, ok: true, result });
      assert.equal(posted.status, 204);
      handled += 1;
    }
  })();

  const prepared = toolJson(await rpc.request("tools/call", {
    name: "figma_prepare_review",
    arguments: { nodeIds: ["1:1", "1:2"], auditOverflow: true, maxDimension: 1_024, scale: 1 },
  }));
  await fakePlugin;
  assert.deepEqual(commandNames, ["readSpreadContent", "exportFramePng", "exportFramePng", "auditTextOverflow", "auditTextOverflow"]);
  assert.equal(prepared.exports.length, 2);
  assert.equal(prepared.overflowAudits.length, 2);
  for (const exported of prepared.exports) {
    const bytes = await readFile(exported.path);
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  }

  const summaryWorker = serveOne("readFrameContent", (command) => {
    assert.deepEqual(command.input, { nodeId: "1:1", detail: "summary", includeHidden: false });
    return { frame: { id: "1:1", name: "Left" }, textCount: 1, excludedHiddenTextCount: 0, text: [{ id: "2:1", copy: "Visible", bounds: { x: 1, y: 1, width: 50, height: 10 }, fontSizes: [16], effectiveVisible: true }], copy: "Visible" };
  });
  const summary = toolJson(await rpc.request("tools/call", {
    name: "figma_read_frame_content",
    arguments: { nodeId: "1:1" },
  }));
  await summaryWorker;
  assert.equal(summary.copy, "Visible");
  assert.equal(summary.text[0].hierarchy, undefined);

  const composeWorker = serveOne("composeFrame", (command) => {
    assert.equal(command.input.elements[1].spans[0].fontStyle, "Bold");
    assert.equal(command.input.elements[1].spans[0].textCase, "upper");
    assert.equal(command.input.audit, true);
    assert.equal(command.input.export, true);
    return {
      createdNodeIds: ["7:1", "7:2", "7:3"],
      frame: { id: "7:1", name: "Replacement" },
      elements: [{ key: "panel", id: "7:2" }, { key: "copy", id: "7:3" }],
      audits: [{ frameId: "7:1", result: { frame: { id: "7:1" }, warningCount: 0, text: [] } }],
      exports: [{ frameId: "7:1", result: { imageBase64: onePixelPng, mimeType: "image/png", nodeId: "7:1", nodeName: "Replacement", width: 1, height: 1 } }],
      verificationComplete: true,
    };
  });
  const composed = toolJson(await rpc.request("tools/call", {
    name: "figma_compose_frame",
    arguments: {
      frame: { name: "Replacement", width: 300, height: 400, x: 0, y: 0, fillColor: "#FFFFFF" },
      elements: [
        { type: "frame", key: "panel", name: "Panel", width: 260, height: 100, x: 20, y: 20, fillColor: "#EEEEEE" },
        { type: "text", key: "copy", parentKey: "panel", text: "Heading\nBody", x: 12, y: 12, width: 236, spans: [{ start: 0, end: 7, fontStyle: "Bold", textCase: "upper" }] },
      ],
    },
  }));
  await composeWorker;
  assert.equal(composed.verificationComplete, true);
  assert.equal(composed.exports[0].result.imageBase64, undefined);
  const composePng = await readFile(composed.exports[0].result.path);
  assert.deepEqual([...composePng.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

  const approvedImagePath = join(exportDirectory, "approved.png");
  await writeFile(approvedImagePath, Buffer.from(onePixelPng, "base64"));
  const imageWorker = serveOne("placeLocalImage", (command) => {
    assert.equal(command.input.sourcePath, approvedImagePath);
    assert.equal(command.input.mimeType, "image/png");
    assert.equal(command.input.imageBase64, onePixelPng);
    return { createdNodeIds: ["8:1"], node: { id: "8:1", name: "Approved photo", type: "RECTANGLE" }, source: { path: approvedImagePath, mimeType: "image/png" }, image: { scaleMode: "FILL" } };
  });
  const placedImage = toolJson(await rpc.request("tools/call", {
    name: "figma_place_local_image",
    arguments: { path: approvedImagePath, name: "Approved photo", width: 300, height: 200, x: 0, y: 0 },
  }));
  await imageWorker;
  assert.equal(placedImage.node.id, "8:1");

  const compactWorker = serveOne("readCopy", (command) => {
    assert.deepEqual(command.input, { nodeIds: ["1:1"], includeHidden: false });
    return {
      page: { id: "0:1", name: "Campaign" },
      includeHidden: false,
      frameCount: 1,
      excludedHiddenTextCount: 1,
      frames: [{ frame: { id: "1:1", name: "Left", bounds: { x: 0, y: 0, width: 100, height: 100 } }, textCount: 1, excludedHiddenTextCount: 1, text: [{ id: "2:1", copy: "Visible", bounds: { x: 1, y: 1, width: 50, height: 10 }, visible: true, opacity: 1, effectiveOpacity: 1, effectiveVisible: true }], copy: "Visible" }],
      copy: "Visible",
    };
  });
  const compact = toolJson(await proxyRpc.request("tools/call", {
    name: "figma_read_copy",
    arguments: { nodeIds: ["1:1"] },
  }));
  await compactWorker;
  assert.equal(compact.copy, "Visible");
  assert.equal(compact.excludedHiddenTextCount, 1);

  const batchWorker = serveOne("applyCopyUpdates", (command) => {
    assert.equal(command.input.includeHidden, false);
    assert.equal(command.input.updates[0].expectedText, "Visible");
    return {
      mutatedNodeIds: ["2:1"],
      updates: [{ nodeId: "2:1", before: "Visible", after: "Updated", changed: true, styleStrategy: "minimal-range" }],
      audits: [{ frameId: "1:1", result: { frame: { id: "1:1" }, includeHidden: false, textCount: 1, skippedHiddenTextCount: 1, warningCount: 0, text: [] } }],
      exports: [{ frameId: "1:1", result: { imageBase64: onePixelPng, mimeType: "image/png", nodeId: "1:1", nodeName: "Left", width: 1, height: 1 } }],
      verificationComplete: true,
    };
  });
  const applied = toolJson(await rpc.request("tools/call", {
    name: "figma_apply_copy_updates",
    arguments: {
      updates: [{ nodeId: "2:1", text: "Updated", expectedText: "Visible" }],
      auditFrames: ["1:1"],
      exportFrames: ["1:1"],
    },
  }));
  await batchWorker;
  assert.equal(applied.verificationComplete, true);
  assert.equal(applied.audits[0].result.skippedHiddenTextCount, 1);
  assert.equal(applied.exports[0].result.imageBase64, undefined);
  const batchPng = await readFile(applied.exports[0].result.path);
  assert.deepEqual([...batchPng.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

  const displacedPoll = fetch(`${baseUrl}/v1/poll?sessionId=${sessionId}&pageId=0%3A1&pageName=Campaign&selectionCount=0`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const takeover = await postJson(`${baseUrl}/v1/connect`, {
    sessionId: "replacement-session",
    clientId: "replacement-client",
    info: { pluginVersion: "test", editorType: "figma", pageId: "0:2", pageName: "Review", selectionCount: 1 },
  });
  assert.equal(takeover.status, 200);
  assert.equal((await displacedPoll).status, 409);
  const replacementStatus = toolJson(await rpc.request("tools/call", { name: "figma_bridge_status", arguments: {} }));
  assert.equal(replacementStatus.plugin.pageName, "Review");
  assert.equal(replacementStatus.plugin.selectionCount, 1);

  child.stdin.end();
  await new Promise((resolve) => child.once("exit", resolve));
  let failoverHttpStatus;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/v1/status`);
      if (response.ok) {
        const candidate = await response.json();
        if (candidate.bridge.processId === proxyChild.pid) {
          failoverHttpStatus = candidate;
          break;
        }
      }
    } catch {
      // The port is briefly unavailable while the proxy is taking ownership.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(failoverHttpStatus?.bridge.role, "owner");
  const failoverMcpStatus = toolJson(await proxyRpc.request("tools/call", { name: "figma_bridge_status", arguments: {} }));
  assert.equal(failoverMcpStatus.connected, false);
  assert.equal(failoverMcpStatus.mcpProcess.role, "owner");
  assert.equal(stderr, "");
  assert.equal(proxyStderr, "");
});
