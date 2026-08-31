import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitFor(url) {
  let error;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { const response = await fetch(url); if (response.ok) return; } catch (caught) { error = caught; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw error ?? new Error(`Timed out waiting for ${url}`);
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
      const id = nextId++;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    notify(method, params = {}) { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`); },
  };
}

async function postJson(url, body) {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.stdin.end();
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 2_000))]);
  if (child.exitCode === null) child.kill("SIGTERM");
}

test("plugin-managed credentials stay private and proxy comment calls use the owner store", async (context) => {
  const port = await freePort();
  const apiPort = await freePort();
  const preferencesDirectory = await mkdtemp(join(tmpdir(), "figma-api-credentials-test-"));
  const requests = [];
  const api = http.createServer((request, response) => {
    requests.push({ url: request.url, token: request.headers["x-figma-token"] });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ comments: [{ id: "review-1", message: "Looks good" }] }));
  });
  await new Promise((resolve, reject) => { api.once("error", reject); api.listen(apiPort, "127.0.0.1", resolve); });
  const children = [];
  const errors = [];
  const launch = () => {
    const child = spawn(process.execPath, [new URL("../server.mjs", import.meta.url).pathname], {
      env: { ...process.env, FIGMA_BRIDGE_PORT: String(port), FIGMA_PREFERENCES_DIR: preferencesDirectory, FIGMA_CREDENTIAL_BACKEND: "memory", FIGMA_API_BASE_URL: `http://127.0.0.1:${apiPort}` },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => errors.push(chunk));
    children.push(child);
    return child;
  };
  context.after(async () => {
    for (const child of children) await stop(child);
    await new Promise((resolve) => api.close(resolve));
    await rm(preferencesDirectory, { recursive: true, force: true });
  });

  const owner = launch();
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitFor(`${baseUrl}/v1/status`);
  const sessionId = "plugin-session";
  const clientId = "plugin-client";
  assert.equal((await postJson(`${baseUrl}/v1/connect`, { sessionId, clientId, info: { pluginVersion: "test", pageName: "Review" } })).status, 200);
  assert.equal((await postJson(`${baseUrl}/v1/api-credentials/save`, { sessionId, clientId: "wrong", accessToken: "figd_private", fileKey: "test-file" })).status, 400);
  const savedResponse = await postJson(`${baseUrl}/v1/api-credentials/save`, { sessionId, clientId, accessToken: "figd_private", fileKey: "test-file" });
  assert.equal(savedResponse.status, 200);
  const savedText = await savedResponse.text();
  assert.doesNotMatch(savedText, /figd_private/);
  const saved = JSON.parse(savedText);
  assert.equal(saved.storage.backend, "session");
  assert.equal(saved.capabilities.commentsRead, "verified");

  const proxy = launch();
  const rpc = rpcClient(proxy);
  await rpc.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "credential-proxy-test", version: "1" } });
  rpc.notify("notifications/initialized");
  const result = await rpc.request("tools/call", { name: "figma_list_comments", arguments: {} });
  const comments = JSON.parse(result.content[0].text);
  assert.equal(comments.comments[0].id, "review-1");
  assert.ok(requests.length >= 2);
  assert.ok(requests.every((request) => request.token === "figd_private"));

  const cleared = await postJson(`${baseUrl}/v1/api-credentials/clear`, { sessionId, clientId });
  assert.equal(cleared.status, 200);
  assert.doesNotMatch(errors.join(""), /figd_private/);
  await stop(proxy);
  await stop(owner);
});
