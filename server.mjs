import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const host = process.env.FIGMA_BRIDGE_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.FIGMA_BRIDGE_PORT ?? "3846", 10);
const launchParentPid = process.ppid;
const sessionFreshnessMs = 35_000;
const replacedSessionRetentionMs = 5 * 60_000;
const proxyHealthIntervalMs = 2_000;
const bridgeVersion = "0.10.2";
const exportDirectory = process.env.FIGMA_EXPORT_DIR ?? join(homedir(), "Pictures", "Figma MCP Exports");
const preferencesDirectory = process.env.FIGMA_PREFERENCES_DIR ?? join(homedir(), ".figma-local-bridge");
const preferencesPath = join(preferencesDirectory, "preferences.json");
const preferencesLockPath = join(preferencesDirectory, "preferences.lock");
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error("FIGMA_BRIDGE_PORT must be a valid TCP port.");
}

const sessions = new Map();
const replacedSessions = new Map();
let bridgeRole = "starting";
let bridgeListening = false;
let stopping = false;
let electionInFlight = false;
let proxyHealthInFlight = false;
let proxyHealthTimer = null;
let resolveInitialBridgeRole;
const initialBridgeRole = new Promise((resolve) => { resolveInitialBridgeRole = resolve; });

function setBridgeRole(role) {
  bridgeRole = role;
  if (resolveInitialBridgeRole) {
    resolveInitialBridgeRole(role);
    resolveInitialBridgeRole = null;
  }
}

function json(response, status, data) {
  const corsOrigin = response.bridgeCorsOrigin;
  response.writeHead(status, {
    ...(corsOrigin ? { "access-control-allow-origin": corsOrigin, vary: "origin" } : {}),
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(data === undefined ? "" : JSON.stringify(data));
}

function html(response, status, body) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "text/html; charset=utf-8",
  });
  response.end(body);
}

function isAllowedBrowserOrigin(origin) {
  if (!origin || origin === "null") return true;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname) && parsed.port === String(port)) return true;
    return parsed.protocol === "https:" && (parsed.hostname === "figma.com" || parsed.hostname.endsWith(".figma.com"));
  } catch {
    return false;
  }
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 70 * 1024 * 1024) throw new Error("Request body is too large. Keep screenshots at or below the requested maximum dimension.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function getSession(sessionId) {
  return sessions.get(sessionId) ?? null;
}

function cleanReplacedSessions(now = Date.now()) {
  for (const [sessionId, replacedAt] of replacedSessions) {
    if (now - replacedAt > replacedSessionRetentionMs) replacedSessions.delete(sessionId);
  }
}

function sessionWasReplaced(sessionId) {
  cleanReplacedSessions();
  return replacedSessions.has(sessionId);
}

function cleanString(value, maxLength = 200) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : undefined;
}

function cleanSessionInfo(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries({
    pluginVersion: cleanString(value.pluginVersion, 40),
    editorType: cleanString(value.editorType, 40),
    pageId: cleanString(value.pageId),
    pageName: cleanString(value.pageName),
    selectionCount: Number.isSafeInteger(value.selectionCount) && value.selectionCount >= 0 ? value.selectionCount : undefined,
  }).filter(([, item]) => item !== undefined));
}

function updateSession(session, info) {
  session.lastSeenAt = Date.now();
  session.info = { ...session.info, ...cleanSessionInfo(info) };
}

function rejectSession(session, message, status = 409, rememberReplacement = false) {
  if (rememberReplacement) replacedSessions.set(session.sessionId, Date.now());
  if (session.poll) {
    clearTimeout(session.poll.timeout);
    json(session.poll.response, status, { error: message });
    session.poll = null;
  }
  for (const pending of session.pending.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error(message));
  }
  session.pending.clear();
  sessions.delete(session.sessionId);
}

function activeSessions(now = Date.now()) {
  return [...sessions.values()].filter((session) => now - session.lastSeenAt < sessionFreshnessMs || session.pending.size > 0);
}

function bridgeStatusSnapshot() {
  const active = activeSessions();
  const session = active.length === 1 ? active[0] : null;
  return {
    connected: active.length === 1,
    activePluginCount: active.length,
    bridge: { host, port, version: bridgeVersion, role: "owner", processId: process.pid },
    ...(session ? {
      plugin: {
        ...session.info,
        connectedAt: new Date(session.connectedAt).toISOString(),
        lastSeenAt: new Date(session.lastSeenAt).toISOString(),
        pendingCommandCount: session.pending.size,
      },
    } : {}),
  };
}

const statusPage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Local Figma MCP Bridge</title>
    <style>
      :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      body { display: grid; min-height: 100vh; margin: 0; place-items: center; background: #f4f4f2; color: #20201e; }
      main { width: min(520px, calc(100vw - 48px)); padding: 28px; border: 1px solid #d8d8d2; border-radius: 18px; background: #fff; box-shadow: 0 16px 40px #00000012; }
      h1 { margin: 0 0 18px; font-size: 22px; }
      .state { display: flex; gap: 10px; align-items: center; margin-bottom: 20px; font-size: 17px; font-weight: 650; }
      .dot { width: 11px; height: 11px; border-radius: 50%; background: #b87600; box-shadow: 0 0 0 4px #b8760018; }
      .connected .dot { background: #16834b; box-shadow: 0 0 0 4px #16834b18; }
      dl { display: grid; grid-template-columns: 130px 1fr; gap: 9px 14px; margin: 0; font-size: 14px; }
      dt { color: #6b6b66; } dd { margin: 0; overflow-wrap: anywhere; }
      p { margin: 20px 0 0; color: #6b6b66; font-size: 13px; line-height: 1.45; }
      @media (prefers-color-scheme: dark) { body { background: #171716; color: #f3f3ef; } main { background: #222220; border-color: #3a3a36; box-shadow: none; } dt, p { color: #aaa9a1; } }
    </style>
  </head>
  <body>
    <main>
      <h1>Local Figma MCP Bridge</h1>
      <div id="state" class="state"><span class="dot"></span><span id="label">Checking…</span></div>
      <dl>
        <dt>Bridge</dt><dd id="bridge">—</dd>
        <dt>Figma page</dt><dd id="page">—</dd>
        <dt>Plugin</dt><dd id="plugin">—</dd>
        <dt>Last seen</dt><dd id="seen">—</dd>
      </dl>
      <p>Open the Local MCP Bridge development plugin in the target Figma Desktop file and leave its panel open. This page refreshes automatically.</p>
    </main>
    <script>
      const state = document.getElementById('state');
      const set = (id, value) => { document.getElementById(id).textContent = value ?? '—'; };
      async function refresh() {
        try {
          const response = await fetch('/v1/status', { cache: 'no-store' });
          const data = await response.json();
          state.className = data.connected ? 'state connected' : 'state';
          set('label', data.connected ? 'Figma plugin connected' : 'Waiting for Figma plugin');
          set('bridge', 'v' + data.bridge.version + ' on ' + data.bridge.host + ':' + data.bridge.port);
          set('page', data.plugin?.pageName);
          set('plugin', data.plugin?.pluginVersion ? 'v' + data.plugin.pluginVersion : null);
          set('seen', data.plugin?.lastSeenAt ? new Date(data.plugin.lastSeenAt).toLocaleTimeString() : null);
        } catch {
          set('label', 'Bridge unavailable');
        }
      }
      refresh(); setInterval(refresh, 2000);
    </script>
  </body>
</html>`;

function completePoll(session) {
  if (!session.poll || session.queue.length === 0) return;
  const poll = session.poll;
  session.poll = null;
  clearTimeout(poll.timeout);
  json(poll.response, 200, { command: session.queue.shift() });
}

function addSession(body) {
  cleanReplacedSessions();
  for (const prior of sessions.values()) {
    rejectSession(prior, "A newer Figma plugin connection replaced this session.", 409, true);
  }
  const now = Date.now();
  const session = {
    sessionId: body.sessionId,
    clientId: body.clientId,
    connectedAt: now,
    lastSeenAt: now,
    info: cleanSessionInfo(body.info),
    queue: [],
    pending: new Map(),
    poll: null,
  };
  sessions.set(body.sessionId, session);
  return session;
}

const bridge = http.createServer(async (request, response) => {
  const origin = request.headers.origin;
  if (!isAllowedBrowserOrigin(origin)) return json(response, 403, { error: "Browser origin is not permitted by this local bridge." });
  if (origin) response.bridgeCorsOrigin = origin;
  if (request.method === "OPTIONS") return json(response, 204);
  const url = new URL(request.url, `http://${host}:${port}`);

  try {
    if (request.method === "GET" && url.pathname === "/") return html(response, 200, statusPage);
    if (request.method === "GET" && url.pathname === "/v1/status") return json(response, 200, bridgeStatusSnapshot());

    if (request.method === "POST" && url.pathname === "/v1/mcp-command") {
      const body = await readJson(request);
      if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 200) return json(response, 400, { error: "A valid command name is required." });
      if (!body.input || typeof body.input !== "object" || Array.isArray(body.input)) return json(response, 400, { error: "Command input must be an object." });
      const timeoutMs = body.timeoutMs === undefined ? 30_000 : body.timeoutMs;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) return json(response, 400, { error: "timeoutMs must be between 1000 and 600000." });
      return json(response, 200, { result: await sendLocalCommand(body.name, body.input, timeoutMs) });
    }

    if (request.method === "POST" && url.pathname === "/v1/connect") {
      const body = await readJson(request);
      if (typeof body.sessionId !== "string" || !body.sessionId.trim() || body.sessionId.length > 200) return json(response, 400, { error: "A valid sessionId is required." });
      if (typeof body.clientId !== "string" || !body.clientId.trim() || body.clientId.length > 200) return json(response, 400, { error: "A valid clientId is required." });
      addSession(body);
      return json(response, 200, { ok: true });
    }

    if (request.method === "GET" && url.pathname === "/v1/poll") {
      const sessionId = url.searchParams.get("sessionId");
      const session = getSession(sessionId);
      if (!session) {
        const replaced = sessionWasReplaced(sessionId);
        const error = replaced ? "This plugin session was replaced by a newer Figma connection." : "Unknown bridge session.";
        return json(response, replaced ? 409 : 401, { error });
      }
      updateSession(session, {
        pageId: url.searchParams.get("pageId"),
        pageName: url.searchParams.get("pageName"),
        selectionCount: Number.parseInt(url.searchParams.get("selectionCount") ?? "", 10),
      });
      if (session.poll) return json(response, 409, { error: "Only one active poll is permitted per session." });
      if (session.queue.length > 0) return json(response, 200, { command: session.queue.shift() });
      const timeout = setTimeout(() => {
        if (session.poll?.response === response) {
          session.poll = null;
          json(response, 204);
        }
      }, 25_000);
      session.poll = { response, timeout };
      // IncomingMessage's `close` fires after a normal request body completes,
      // not only when the caller disconnects. Treat only an aborted request (or
      // an unfinished response closing) as a cancelled long poll.
      const cancelPoll = () => {
        if (session.poll?.response === response) {
          clearTimeout(timeout);
          session.poll = null;
        }
      };
      request.once("aborted", cancelPoll);
      response.once("close", () => {
        if (!response.writableEnded) cancelPoll();
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/heartbeat") {
      const body = await readJson(request);
      const session = getSession(body.sessionId);
      if (!session) {
        const replaced = sessionWasReplaced(body.sessionId);
        return json(response, replaced ? 409 : 401, { error: replaced ? "This plugin session was replaced by a newer Figma connection." : "Unknown bridge session." });
      }
      updateSession(session, body.info);
      return json(response, 204);
    }

    if (request.method === "POST" && url.pathname === "/v1/result") {
      const body = await readJson(request);
      const session = getSession(body.sessionId);
      if (!session) {
        const replaced = sessionWasReplaced(body.sessionId);
        return json(response, replaced ? 409 : 401, { error: replaced ? "This plugin session was replaced by a newer Figma connection." : "Unknown bridge session." });
      }
      updateSession(session, body.info);
      const pending = session.pending.get(body.id);
      if (!pending) return json(response, 404, { error: "No matching command." });
      session.pending.delete(body.id);
      clearTimeout(pending.timeout);
      if (body.ok) pending.resolve(body.result);
      else pending.reject(new Error(typeof body.error === "string" ? body.error : "The Figma plugin rejected the command."));
      return json(response, 204);
    }

    return json(response, 404, { error: "Not found." });
  } catch (error) {
    return json(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
});

function sendLocalCommand(name, input, timeoutMs = 30_000) {
  const liveSessions = activeSessions();
  if (liveSessions.length === 0) {
    throw new Error("No Figma plugin is connected. Open Local MCP Bridge in the target Figma file and leave its status panel open; it connects automatically.");
  }
  if (liveSessions.length > 1) {
    throw new Error("More than one Figma plugin is connected. Keep only the target file's bridge plugin connected.");
  }

  const session = liveSessions[0];
  const id = randomUUID();
  const command = { id, name, input };
  const result = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      session.pending.delete(id);
      reject(new Error(`Figma did not respond within ${Math.round(timeoutMs / 1_000)} seconds. Confirm the bridge plugin is still open and connected.`));
    }, timeoutMs);
    session.pending.set(id, { resolve, reject, timeout });
  });
  session.queue.push(command);
  completePoll(session);
  return result;
}

async function ownerRequest(pathname, options = {}, timeoutMs = 5_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://${host}:${port}${pathname}`, { ...options, signal: controller.signal });
    const text = await response.text();
    let data = {};
    if (text) {
      try { data = JSON.parse(text); } catch { throw new Error(`Bridge owner returned an invalid response for ${pathname}.`); }
    }
    if (!response.ok) {
      throw new Error(typeof data.error === "string" ? data.error : `Bridge owner returned HTTP ${response.status} for ${pathname}.`);
    }
    return data;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`Bridge owner did not respond within ${Math.round(timeoutMs / 1_000)} seconds.`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function bridgeStatusForMcp() {
  await initialBridgeRole;
  if (bridgeRole === "owner") {
    return {
      ...bridgeStatusSnapshot(),
      mcpProcess: { role: "owner", processId: process.pid },
    };
  }
  const status = await ownerRequest("/v1/status");
  return {
    ...status,
    mcpProcess: {
      role: "proxy",
      processId: process.pid,
      ownerProcessId: status.bridge?.processId,
    },
  };
}

async function sendCommand(name, input, timeoutMs = 30_000) {
  await initialBridgeRole;
  if (bridgeRole === "owner") return sendLocalCommand(name, input, timeoutMs);
  const response = await ownerRequest("/v1/mcp-command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, input, timeoutMs }),
  }, timeoutMs + 5_000);
  return response.result;
}

function output(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function imageOutput(data) {
  const { imageBase64, mimeType, ...metadata } = data;
  return {
    content: [
      { type: "text", text: JSON.stringify(metadata, null, 2) },
      { type: "image", data: imageBase64, mimeType },
    ],
  };
}

function safeFileStem(value) {
  const stem = String(value ?? "figma-frame")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._ -]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 100);
  return stem || "figma-frame";
}

async function writePngExport(data) {
  const { imageBase64, mimeType, nodeName, ...metadata } = data;
  if (mimeType !== "image/png" || typeof imageBase64 !== "string") throw new Error("Figma did not return a valid PNG export.");
  const bytes = Buffer.from(imageBase64, "base64");
  if (bytes.length === 0) throw new Error("Figma returned an empty PNG export.");
  if (bytes.length > 50 * 1024 * 1024) throw new Error("PNG export exceeds the 50 MB local safety limit. Reduce maxDimension or scale.");
  await mkdir(exportDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${safeFileStem(nodeName)}-${timestamp}-${randomUUID().slice(0, 8)}.png`;
  const path = join(exportDirectory, filename);
  await writeFile(path, bytes, { flag: "wx" });
  return { ...metadata, nodeName, path, bytes: bytes.length };
}

function imageMimeType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

async function localImageInput(input) {
  if (!isAbsolute(input.path)) throw new Error("Local image path must be absolute.");
  const bytes = await readFile(input.path);
  if (bytes.length === 0) throw new Error("The approved local image is empty.");
  if (bytes.length > 25 * 1024 * 1024) throw new Error("The approved local image exceeds the 25 MB safety limit.");
  const mimeType = imageMimeType(bytes);
  if (!mimeType) throw new Error("Local image must be a valid PNG, JPEG, GIF, or WebP file.");
  const { path, ...rest } = input;
  return { ...rest, sourcePath: path, mimeType, imageBase64: bytes.toString("base64") };
}

async function localizeBatchExports(data) {
  const exports = [];
  for (const item of data.exports ?? []) {
    if (item.error || !item.result) {
      exports.push(item);
      continue;
    }
    try {
      exports.push({ frameId: item.frameId, result: await writePngExport(item.result) });
    } catch (error) {
      exports.push({ frameId: item.frameId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    ...data,
    exports,
    verificationComplete: data.audits?.every((item) => !item.error) !== false && exports.every((item) => !item.error),
  };
}

function failure(error) {
  return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
}

const nodeId = z.string().trim().min(1).max(200);
const tokenId = z.string().trim().min(1).max(300);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex colour such as #161238.");
const opacity = z.number().finite().min(0).max(1);
const position = {
  x: z.number().finite().min(-100_000).max(100_000).default(0),
  y: z.number().finite().min(-100_000).max(100_000).default(0),
};
const visualStyle = {
  fillColor: hexColor.optional().describe("Solid fill colour in #RRGGBB."),
  fillTokenId: tokenId.optional().describe("Optional local Figma colour-variable ID to bind to the solid fill. Prefer this after creating named colour tokens."),
  fillOpacity: opacity.optional().describe("Fill opacity from 0 to 1."),
  strokeColor: hexColor.optional().describe("Solid stroke colour in #RRGGBB."),
  strokeTokenId: tokenId.optional().describe("Optional local Figma colour-variable ID to bind to the solid stroke. Prefer this after creating named colour tokens."),
  strokeOpacity: opacity.optional().describe("Stroke opacity from 0 to 1."),
  strokeWeight: z.number().finite().min(0).max(1_000).optional(),
  opacity: opacity.optional().describe("Whole-node opacity from 0 to 1."),
  cornerRadius: z.number().finite().min(0).max(10_000).optional(),
  clipsContent: z.boolean().optional(),
};
const readDetail = z.enum(["summary", "full"]).default("summary");
const textCase = z.enum(["original", "upper", "lower", "title", "small-caps"]);
const textStyleFields = {
  fontFamily: z.string().trim().min(1).max(200).optional(),
  fontStyle: z.string().trim().min(1).max(200).optional(),
  fontSize: z.number().finite().min(1).max(1_000).optional(),
  lineHeight: z.number().finite().min(1).max(2_000).optional(),
  letterSpacing: z.number().finite().min(-1_000).max(1_000).optional(),
  textCase: textCase.optional().describe("Apply character casing typographically without changing the stored text."),
  fillColor: hexColor.optional(),
  fillOpacity: opacity.optional(),
};
const styledSpan = z.object({
  start: z.number().int().min(0).max(100_000),
  end: z.number().int().min(1).max(100_000),
  ...textStyleFields,
}).refine((span) => span.end > span.start, "Styled span end must be greater than start.");
const imageTransform = z.array(z.tuple([z.number().finite(), z.number().finite(), z.number().finite()])).length(2);
const composeFrameElement = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("frame"), key: z.string().trim().min(1).max(100), name: z.string().trim().min(1).max(200),
    parentKey: z.string().trim().min(1).max(100).optional(), width: z.number().finite().min(1).max(10_000), height: z.number().finite().min(1).max(10_000),
    ...position, layout: z.enum(["none", "horizontal", "vertical"]).default("none"), itemSpacing: z.number().finite().min(0).max(1_000).default(0), padding: z.number().finite().min(0).max(1_000).default(0), ...visualStyle,
  }),
  z.object({
    type: z.literal("rectangle"), key: z.string().trim().min(1).max(100), name: z.string().trim().min(1).max(200),
    parentKey: z.string().trim().min(1).max(100).optional(), width: z.number().finite().min(1).max(10_000), height: z.number().finite().min(1).max(10_000), ...position, ...visualStyle,
  }),
  z.object({
    type: z.literal("text"), key: z.string().trim().min(1).max(100), name: z.string().trim().min(1).max(200).optional(),
    parentKey: z.string().trim().min(1).max(100).optional(), text: z.string().max(100_000), ...position,
    width: z.number().finite().min(1).max(10_000).optional(), textAlign: z.enum(["left", "center", "right"]).optional(),
    fontFamily: z.string().trim().min(1).max(200).default("Inter"), fontStyle: z.string().trim().min(1).max(200).default("Regular"), fontSize: z.number().finite().min(1).max(1_000).default(16),
    textCase: textCase.default("original"),
    lineHeight: z.number().finite().min(1).max(2_000).optional(), letterSpacing: z.number().finite().min(-1_000).max(1_000).optional(), fillColor: hexColor.optional(), fillOpacity: opacity.optional(), opacity: opacity.optional(),
    spans: z.array(styledSpan).max(100).default([]),
  }),
]);

const preferenceCategory = z.enum(["component", "style", "token", "typography", "layout", "copy", "asset", "general"]);
const preferenceScope = z.object({
  project: z.string().trim().min(1).max(200).optional(),
  documentType: z.string().trim().min(1).max(200).optional(),
  context: z.string().trim().min(1).max(300).optional(),
});
const preferenceAsset = z.object({
  role: z.string().trim().min(1).max(200).optional(),
  componentId: nodeId.optional(),
  componentKey: z.string().trim().min(1).max(300).optional(),
  componentName: z.string().trim().min(1).max(300).optional(),
  styleId: nodeId.optional(),
  styleKey: z.string().trim().min(1).max(300).optional(),
  styleName: z.string().trim().min(1).max(300).optional(),
  tokenId: tokenId.optional(),
  tokenName: z.string().trim().min(1).max(300).optional(),
  variantProperties: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
});
const storedPreference = z.object({
  id: z.string().uuid(),
  designSystem: z.string().trim().min(1).max(300),
  category: preferenceCategory,
  rule: z.string().trim().min(1).max(2_000),
  scope: preferenceScope,
  asset: preferenceAsset.optional(),
  rationale: z.string().trim().min(1).max(1_000).optional(),
  source: z.string().trim().min(1).max(500),
  status: z.literal("confirmed"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
const preferenceHistoryEntry = z.object({
  revision: z.number().int().min(1),
  previousRevision: z.number().int().min(0),
  changedAt: z.string().datetime(),
  action: z.enum(["create", "update", "delete", "revert"]),
  preferenceId: z.string().uuid().nullable(),
  preferences: z.array(storedPreference).max(1_000),
});
const preferenceStore = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().min(0),
  updatedAt: z.string().datetime().nullable(),
  preferences: z.array(storedPreference).max(1_000),
  history: z.array(preferenceHistoryEntry).max(50),
});

function emptyPreferenceStore() {
  return { schemaVersion: 1, revision: 0, updatedAt: null, preferences: [], history: [] };
}

async function readPreferenceStore() {
  let contents;
  try {
    contents = await readFile(preferencesPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return emptyPreferenceStore();
    throw error;
  }
  try {
    return preferenceStore.parse(JSON.parse(contents));
  } catch (error) {
    throw new Error(`The local preference file is invalid and was not changed: ${preferencesPath}. ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writePreferenceStore(store) {
  await mkdir(preferencesDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(preferencesDirectory, `preferences.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(preferenceStore.parse(store), null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, preferencesPath);
}

async function withPreferenceLock(callback) {
  await mkdir(preferencesDirectory, { recursive: true, mode: 0o700 });
  let handle;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      handle = await open(preferencesLockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid} ${Date.now()}\n`);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const lockStatus = await stat(preferencesLockPath);
        if (Date.now() - lockStatus.mtimeMs > 15_000) await unlink(preferencesLockPath);
      } catch (lockError) {
        if (lockError?.code !== "ENOENT") throw lockError;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!handle) throw new Error("The user-preference store is busy. Re-read preferences and try again.");
  try {
    return await callback();
  } finally {
    await handle.close().catch(() => {});
    await unlink(preferencesLockPath).catch(() => {});
  }
}

function assertPreferenceRevision(store, expectedRevision) {
  if (store.revision !== expectedRevision) {
    throw new Error(`Preference revision changed from ${expectedRevision} to ${store.revision}. Call figma_get_user_preferences again before updating.`);
  }
}

function preferenceSummary(item) {
  const scope = [item.scope.project, item.scope.documentType, item.scope.context].filter(Boolean);
  const role = item.asset?.role ? ` (${item.asset.role})` : "";
  return `${item.designSystem} · ${item.category}${role}${scope.length ? ` · ${scope.join(" / ")}` : ""}: ${item.rule}`;
}

function filteredPreferences(store, input) {
  const query = input.query?.toLowerCase();
  return store.preferences.filter((item) => {
    if (input.designSystem && item.designSystem.toLowerCase() !== input.designSystem.toLowerCase()) return false;
    if (input.category && item.category !== input.category) return false;
    if (!query) return true;
    return JSON.stringify(item).toLowerCase().includes(query);
  });
}

async function getUserPreferences(input) {
  const store = await readPreferenceStore();
  const preferences = filteredPreferences(store, input);
  return {
    schemaVersion: store.schemaVersion,
    revision: store.revision,
    updatedAt: store.updatedAt,
    storagePath: preferencesPath,
    count: preferences.length,
    summary: preferences.map(preferenceSummary),
    preferences,
    ...(input.includeHistory ? { history: store.history.map(({ preferences: _snapshot, ...entry }) => entry) } : {}),
  };
}

function nextPreferenceStore(store, preferences, action, preferenceId) {
  const changedAt = new Date().toISOString();
  const revision = store.revision + 1;
  const history = [...store.history, {
    revision,
    previousRevision: store.revision,
    changedAt,
    action,
    preferenceId,
    preferences,
  }].slice(-50);
  return { schemaVersion: 1, revision, updatedAt: changedAt, preferences, history };
}

async function setUserPreference(input) {
  return withPreferenceLock(async () => {
    const store = await readPreferenceStore();
    assertPreferenceRevision(store, input.expectedRevision);
    const now = new Date().toISOString();
    const existingIndex = input.preferenceId ? store.preferences.findIndex((item) => item.id === input.preferenceId) : -1;
    if (input.preferenceId && existingIndex < 0) throw new Error(`Preference ${input.preferenceId} was not found. Re-read preferences before updating.`);
    const existing = existingIndex >= 0 ? store.preferences[existingIndex] : null;
    const preference = storedPreference.parse({
      id: existing?.id ?? randomUUID(),
      designSystem: input.designSystem,
      category: input.category,
      rule: input.rule,
      scope: input.scope,
      ...(input.asset ? { asset: input.asset } : {}),
      ...(input.rationale ? { rationale: input.rationale } : {}),
      source: input.source,
      status: "confirmed",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    const preferences = [...store.preferences];
    if (existingIndex >= 0) preferences[existingIndex] = preference;
    else preferences.push(preference);
    const next = nextPreferenceStore(store, preferences, existing ? "update" : "create", preference.id);
    await writePreferenceStore(next);
    return { revision: next.revision, updatedAt: next.updatedAt, storagePath: preferencesPath, preference, summary: preferenceSummary(preference) };
  });
}

async function deleteUserPreference(input) {
  return withPreferenceLock(async () => {
    const store = await readPreferenceStore();
    assertPreferenceRevision(store, input.expectedRevision);
    const deleted = store.preferences.find((item) => item.id === input.preferenceId);
    if (!deleted) throw new Error(`Preference ${input.preferenceId} was not found. Re-read preferences before deleting.`);
    const next = nextPreferenceStore(store, store.preferences.filter((item) => item.id !== input.preferenceId), "delete", input.preferenceId);
    await writePreferenceStore(next);
    return { revision: next.revision, updatedAt: next.updatedAt, storagePath: preferencesPath, deleted, remainingCount: next.preferences.length };
  });
}

async function revertUserPreferences(input) {
  return withPreferenceLock(async () => {
    const store = await readPreferenceStore();
    assertPreferenceRevision(store, input.expectedRevision);
    const targetPreferences = input.targetRevision === 0
      ? []
      : store.history.find((entry) => entry.revision === input.targetRevision)?.preferences;
    if (!targetPreferences) throw new Error(`Preference revision ${input.targetRevision} is not retained in local history.`);
    const next = nextPreferenceStore(store, structuredClone(targetPreferences), "revert", null);
    await writePreferenceStore(next);
    return { revision: next.revision, revertedToRevision: input.targetRevision, updatedAt: next.updatedAt, storagePath: preferencesPath, count: next.preferences.length, summary: next.preferences.map(preferenceSummary) };
  });
}

const designCandidate = z.object({
  candidateId: z.string().trim().min(1).max(300),
  designSystem: z.string().trim().min(1).max(300),
  assetType: z.enum(["component", "style", "token"]),
  name: z.string().trim().min(1).max(300),
  role: z.string().trim().min(1).max(200).optional(),
  key: z.string().trim().min(1).max(300).optional(),
  nodeId: nodeId.optional(),
});

function preferenceAppliesToScope(preference, input) {
  if (preference.scope.project && preference.scope.project.toLowerCase() !== input.project?.toLowerCase()) return false;
  if (preference.scope.documentType && preference.scope.documentType.toLowerCase() !== input.documentType?.toLowerCase()) return false;
  if (preference.scope.context && preference.scope.context.toLowerCase() !== input.context?.toLowerCase()) return false;
  return true;
}

function scoreDesignCandidate(candidate, preferences, input) {
  let score = 0;
  const matchedPreferenceIds = [];
  for (const preference of preferences) {
    if (!preferenceAppliesToScope(preference, input)) continue;
    if (preference.designSystem.toLowerCase() !== candidate.designSystem.toLowerCase()) continue;
    const asset = preference.asset;
    let match = 5;
    if (asset?.role && candidate.role && asset.role.toLowerCase() === candidate.role.toLowerCase()) match += 25;
    if (asset?.componentKey && candidate.key === asset.componentKey) match += 100;
    if (asset?.styleKey && candidate.key === asset.styleKey) match += 100;
    if (asset?.tokenId && candidate.key === asset.tokenId) match += 100;
    if (asset?.componentId && candidate.nodeId === asset.componentId) match += 90;
    if (asset?.styleId && candidate.nodeId === asset.styleId) match += 90;
    if (asset?.componentName && asset.componentName.toLowerCase() === candidate.name.toLowerCase()) match += 70;
    if (asset?.styleName && asset.styleName.toLowerCase() === candidate.name.toLowerCase()) match += 70;
    if (asset?.tokenName && asset.tokenName.toLowerCase() === candidate.name.toLowerCase()) match += 70;
    const searchable = `${preference.rule} ${preference.rationale ?? ""}`.toLowerCase();
    if (candidate.role && searchable.includes(candidate.role.toLowerCase())) match += 10;
    if (searchable.includes(input.intent.toLowerCase())) match += 10;
    if (match > 5 || !asset) {
      score += match;
      matchedPreferenceIds.push(preference.id);
    }
  }
  return { candidate, score, matchedPreferenceIds };
}

async function resolveDesignChoice(input) {
  const store = await readPreferenceStore();
  const scored = input.candidates
    .map((candidate) => scoreDesignCandidate(candidate, store.preferences, input))
    .sort((left, right) => right.score - left.score || left.candidate.name.localeCompare(right.candidate.name));
  if (scored.length === 1) {
    return { revision: store.revision, resolved: true, needsClarification: false, selected: scored[0].candidate, matchedPreferenceIds: scored[0].matchedPreferenceIds, reason: "Only one candidate was supplied." };
  }
  const top = scored[0];
  const tied = scored.filter((item) => item.score === top.score);
  if (top.score > 0 && tied.length === 1) {
    return { revision: store.revision, resolved: true, needsClarification: false, selected: top.candidate, matchedPreferenceIds: top.matchedPreferenceIds, reason: "One candidate matched the confirmed user preferences more strongly." };
  }
  return {
    revision: store.revision,
    resolved: false,
    needsClarification: true,
    intent: input.intent,
    question: `Multiple design-system choices are equally plausible for “${input.intent}”. Which should be used?`,
    candidates: tied.map((item) => ({ ...item.candidate, score: item.score, matchedPreferenceIds: item.matchedPreferenceIds })),
    instruction: "Do not edit until the user chooses. After the answer, offer to save it as a confirmed scoped preference so this tie does not recur.",
  };
}

const workflowInstructions = [
  "Use this server with the inspect-first $figma-local-workflow skill when available.",
  "For best first-pass results, always follow this order:",
  "1. figma_bridge_status — confirm exactly one Figma Desktop plugin is connected.",
  "2. figma_get_user_preferences — load confirmed per-user design-system, component, style, token, typography, layout and copy preferences before choosing assets.",
  "3. figma_list_design_system_assets and figma_list_artboards — discover verified components/styles and clean artboard IDs; never guess IDs or redraw an available appropriate component.",
  "4. figma_read_frame_content or figma_read_spread_content — read the relevant copy with hierarchy before editing.",
  "Use detail=summary for routine reads and overflow audits; request full only when hierarchy or hidden variants are needed.",
  "For source-to-Figma copy sync, use figma_read_copy for compact IDs/copy/bounds, diff outside Figma, then use figma_apply_copy_updates for narrow writes plus audit/export verification.",
  "5. figma_export_frame_png — inspect each relevant artboard visually from its returned local path.",
  "6. Analyse copy and layout together; call figma_audit_text_overflow when fit or clipping matters.",
  "Fast path after step 2: figma_prepare_review performs steps 3–5 for one to eight known artboards, writes their PNGs locally, and makes no edits.",
  "7. Only then edit identified nodes with the narrowest mutation tools.",
  "8. Re-read, re-audit, and re-export affected artboards after editing.",
  "Prefer confirmed user choices, linked-system component instances, bound variables and named Figma styles—in that order—over detached copies, manually reconstructed components or raw visual values.",
  "When multiple systems or assets are equally plausible, call figma_resolve_design_choice. If it returns needsClarification=true, do not edit: ask the user to choose, then offer to save the answer with figma_set_user_preference.",
  "Only create, update, delete or revert a stored preference after an explicit user instruction or confirmation. Never silently learn a preference from one document.",
  "Treat casing as typography: use textCase on the text layer or styled span rather than replacing natural-case characters with capitals, unless the source copy or user explicitly requires a character-level case change.",
  "For a page re-layout: inspect and export the current artboard, list page tokens or copy style from verified source nodes, compose the named replacement with figma_compose_frame, archive explicit previous sibling nodes only after the replacement succeeds, then inspect the returned audit and PNG.",
  "Prefer figma_archive_nodes or figma_supersede_layout over deletion or opacity-zero superseded layers. Use approved local image paths only when the user placed that file in scope.",
  "Do not begin from arbitrary page traversal or the current selection when artboard discovery is available. Delete only a clearly stray, user-identified element; otherwise preserve it.",
].join("\n");

const server = new McpServer(
  { name: "figma-local-bridge", version: bridgeVersion },
  { instructions: workflowInstructions },
);

server.registerTool("figma_bridge_status", {
  title: "Figma local bridge status",
  description: "Check whether exactly one Figma local bridge plugin is connected, including bridge/plugin versions, current Figma page, selection count, last heartbeat, and in-flight command count.",
  inputSchema: {},
}, async () => {
  try { return output(await bridgeStatusForMcp()); } catch (error) { return failure(error); }
});

server.registerTool("figma_get_user_preferences", {
  title: "Get local Figma user preferences",
  description: "Load the confirmed per-user design-system preferences stored locally by this bridge. Call this immediately after bridge status and before choosing components, styles, tokens, typography or layout. Works without a connected Figma plugin.",
  inputSchema: {
    designSystem: z.string().trim().min(1).max(300).optional(),
    category: preferenceCategory.optional(),
    query: z.string().trim().min(1).max(500).optional(),
    includeHistory: z.boolean().default(false),
  },
}, async (input) => {
  try { return output(await getUserPreferences(input)); } catch (error) { return failure(error); }
});

server.registerTool("figma_set_user_preference", {
  title: "Set a confirmed Figma user preference",
  description: "Create or update one local per-user design-system preference. Call only after the user explicitly states or confirms the rule. Read preferences first and pass its revision to prevent concurrent overwrites.",
  inputSchema: {
    confirmed: z.literal(true).describe("Assert that the user explicitly stated or confirmed this preference."),
    expectedRevision: z.number().int().min(0),
    preferenceId: z.string().uuid().optional().describe("Provide an existing ID to update it; omit to create a new preference."),
    designSystem: z.string().trim().min(1).max(300),
    category: preferenceCategory,
    rule: z.string().trim().min(1).max(2_000),
    scope: preferenceScope.default({}),
    asset: preferenceAsset.optional(),
    rationale: z.string().trim().min(1).max(1_000).optional(),
    source: z.string().trim().min(1).max(500).default("Explicit user instruction"),
  },
}, async (input) => {
  try { return output(await setUserPreference(input)); } catch (error) { return failure(error); }
});

server.registerTool("figma_delete_user_preference", {
  title: "Delete a confirmed Figma user preference",
  description: "Delete one stored preference only after the user explicitly requests it. Read preferences first and pass its current revision.",
  inputSchema: {
    confirmed: z.literal(true),
    expectedRevision: z.number().int().min(0),
    preferenceId: z.string().uuid(),
  },
}, async (input) => {
  try { return output(await deleteUserPreference(input)); } catch (error) { return failure(error); }
});

server.registerTool("figma_revert_user_preferences", {
  title: "Revert local Figma user preferences",
  description: "Restore the retained snapshot from an earlier preference revision after explicit user confirmation. This creates a new revision and preserves history.",
  inputSchema: {
    confirmed: z.literal(true),
    expectedRevision: z.number().int().min(0),
    targetRevision: z.number().int().min(0),
  },
}, async (input) => {
  try { return output(await revertUserPreferences(input)); } catch (error) { return failure(error); }
});

server.registerTool("figma_resolve_design_choice", {
  title: "Resolve a design-system choice",
  description: "Compare plausible components, styles or tokens against confirmed user preferences. If the result needs clarification, stop and ask the returned question instead of guessing or editing.",
  inputSchema: {
    intent: z.string().trim().min(1).max(500),
    project: z.string().trim().min(1).max(200).optional(),
    documentType: z.string().trim().min(1).max(200).optional(),
    context: z.string().trim().min(1).max(500).optional(),
    candidates: z.array(designCandidate).min(1).max(50),
  },
}, async (input) => {
  try { return output(await resolveDesignChoice(input)); } catch (error) { return failure(error); }
});

server.registerTool("figma_get_selection", {
  title: "Get Figma selection",
  description: "Return the selected nodes in the Figma file connected to the local bridge.",
  inputSchema: {},
}, async () => {
  try { return output(await sendCommand("getSelection", {})); } catch (error) { return failure(error); }
});

server.registerTool("figma_list_pages", {
  title: "List Figma pages",
  description: "List the pages in the connected Figma file and identify the currently active page.",
  inputSchema: {},
}, async () => {
  try { return output(await sendCommand("listPages", {})); } catch (error) { return failure(error); }
});

server.registerTool("figma_navigate_to_page", {
  title: "Navigate to a Figma page",
  description: "Switch the open Figma editor to a page by ID or exact name, loading that page before any subsequent node operation.",
  inputSchema: z.object({
    pageId: nodeId.optional(),
    pageName: z.string().trim().min(1).max(200).optional(),
  }).refine((input) => input.pageId || input.pageName, "Provide pageId or pageName."),
}, async (input) => {
  try { return output(await sendCommand("navigateToPage", input)); } catch (error) { return failure(error); }
});

server.registerTool("figma_query_page_nodes", {
  title: "Query Figma page nodes",
  description: "List nodes on the active Figma page with stable IDs, bounds, parent hierarchy, and concise visual/text style metadata. Use selector for a Figma node-query selector; otherwise use query and/or nodeTypes for simple filtering. Set includeHierarchy to retrieve the page's top-level tree instead.",
  inputSchema: {
    selector: z.string().trim().min(1).max(500).optional().describe("Optional Figma node-query selector, such as FRAME > TEXT[name*=Title]."),
    query: z.string().trim().min(1).max(200).optional().describe("Optional case-insensitive name substring filter when selector is omitted."),
    nodeTypes: z.array(z.string().trim().min(1).max(60)).max(50).optional().describe("Optional node type filter, for example FRAME, TEXT, or RECTANGLE."),
    limit: z.number().int().min(1).max(1_000).default(250),
    includeHierarchy: z.boolean().default(false).describe("Return the top-level page tree rather than a flat filtered result."),
    maxDepth: z.number().int().min(0).max(20).default(4).describe("Maximum child depth when includeHierarchy is true."),
  },
}, async (input) => {
  try { return output(await sendCommand("queryPageNodes", input)); } catch (error) { return failure(error); }
});

server.registerTool("figma_list_artboards", {
  title: "List Figma artboards",
  description: "Return a clean, position-ordered list of artboard-like frames on the active page. Includes page-level frames/components/instances and frames directly inside sections; excludes incidental nested frames.",
  inputSchema: {},
}, async () => {
  try { return output(await sendCommand("listArtboards", {})); } catch (error) { return failure(error); }
});

server.registerTool("figma_read_frame_content", {
  title: "Read Figma frame content",
  description: "Read text inside one frame in visual order. Summary mode returns stable IDs, visible copy, bounds, visibility, and font sizes without verbose hierarchy; full mode also returns names, hierarchy, and hidden copy.",
  inputSchema: { nodeId, detail: readDetail, includeHidden: z.boolean().default(false) },
}, async (input) => {
  try { return output(await sendCommand("readFrameContent", input)); } catch (error) { return failure(error); }
});

server.registerTool("figma_read_copy", {
  title: "Read compact Figma copy",
  description: "Return compact copy-sync data for one or more ordered frames: text IDs, copy, bounds, opacity, and effective visibility. Hidden or opacity-zero text is excluded by default. Prefer this over full frame reads when diffing external source copy.",
  inputSchema: {
    nodeIds: z.array(nodeId).min(1).max(20).describe("Frame IDs in source/spread order."),
    includeHidden: z.boolean().default(false),
  },
}, async (input) => {
  try { return output(await sendCommand("readCopy", input)); } catch (error) { return failure(error); }
});

server.registerTool("figma_read_spread_content", {
  title: "Read Figma spread content",
  description: "Read copy from a page pair or multi-artboard spread. Frames follow the supplied nodeIds order; text follows visual reading order. Returns per-frame structure, combined visible `copy`, and `allCopy` including hidden/conditional text.",
  inputSchema: { nodeIds: z.array(nodeId).min(2).max(20), detail: readDetail, includeHidden: z.boolean().default(false) },
}, async (input) => {
  try { return output(await sendCommand("readSpreadContent", input)); } catch (error) { return failure(error); }
});

server.registerTool("figma_audit_text_overflow", {
  title: "Audit Figma text overflow",
  description: "Audit visible text inside a frame for fixed-height overflow, truncation/max-line settings, missing fonts, and clipping. Invisible or opacity-zero text is skipped by default; set includeHidden only when intentionally auditing hidden variants.",
  inputSchema: { nodeId, includeHidden: z.boolean().default(false), detail: readDetail },
}, async (input) => {
  try { return output(await sendCommand("auditTextOverflow", input, 120_000)); } catch (error) { return failure(error); }
});

server.registerTool("figma_apply_copy_updates", {
  title: "Apply and verify Figma copy updates",
  description: "Apply a bounded batch of text changes, then audit and export named frames in the same plugin transaction. Uses expectedText guards and minimal character-range replacement to reduce stale writes and preserve unaffected mixed styles. Hidden text is excluded from audits by default.",
  inputSchema: {
    updates: z.array(z.object({
      nodeId,
      text: z.string().max(100_000),
      expectedText: z.string().max(100_000).optional().describe("Recommended optimistic guard: the exact copy returned by figma_read_copy."),
    })).min(1).max(50),
    auditFrames: z.array(nodeId).max(8).default([]),
    exportFrames: z.array(nodeId).max(8).default([]),
    includeHidden: z.boolean().default(false).describe("Include hidden/opacity-zero text in overflow audits."),
    maxDimension: z.number().int().min(128).max(8_192).default(4_096),
    scale: z.number().finite().min(0.1).max(4).default(2),
  },
}, async (input) => {
  try {
    return output(await localizeBatchExports(await sendCommand("applyCopyUpdates", input, 300_000)));
  } catch (error) {
    return failure(error);
  }
});

server.registerTool("figma_export_frame_png", {
  title: "Export Figma frame PNG",
  description: `Export one current-page node to a PNG file under ${exportDirectory}. Returns the absolute local path and metadata only; base64 image data is never included in the MCP response.`,
  inputSchema: {
    nodeId,
    maxDimension: z.number().int().min(128).max(8_192).default(4_096).describe("Maximum longest image dimension in pixels."),
    scale: z.number().finite().min(0.1).max(4).default(2),
  },
}, async (input) => {
  try { return output(await writePngExport(await sendCommand("exportFramePng", input, 120_000))); } catch (error) { return failure(error); }
});

server.registerTool("figma_prepare_review", {
  title: "Prepare Figma artboards for review",
  description: "After figma_list_artboards, prepare one artboard or an ordered spread for copy/layout review in one call. Reads structured copy first, writes each artboard to a local PNG, then optionally audits text overflow. It never edits the document.",
  inputSchema: {
    nodeIds: z.array(nodeId).min(1).max(8).describe("One to eight artboard IDs in the exact review/spread order returned by figma_list_artboards."),
    auditOverflow: z.boolean().default(true),
    detail: readDetail,
    maxDimension: z.number().int().min(128).max(8_192).default(4_096).describe("Maximum longest dimension for each local PNG."),
    scale: z.number().finite().min(0.1).max(4).default(2),
  },
}, async (input) => {
  try {
    const content = input.nodeIds.length === 1
      ? await sendCommand("readFrameContent", { nodeId: input.nodeIds[0], detail: input.detail, includeHidden: false })
      : await sendCommand("readSpreadContent", { nodeIds: input.nodeIds, detail: input.detail, includeHidden: false });
    const exports = [];
    for (const reviewNodeId of input.nodeIds) {
      exports.push(await writePngExport(await sendCommand("exportFramePng", {
        nodeId: reviewNodeId,
        maxDimension: input.maxDimension,
        scale: input.scale,
      }, 120_000)));
    }
    const overflowAudits = [];
    if (input.auditOverflow) {
      for (const reviewNodeId of input.nodeIds) {
        overflowAudits.push(await sendCommand("auditTextOverflow", { nodeId: reviewNodeId, detail: input.detail, includeHidden: false }, 120_000));
      }
    }
    return output({
      nodeIds: input.nodeIds,
      content,
      exports,
      ...(input.auditOverflow ? { overflowAudits } : {}),
      nextStep: "Inspect every exported PNG together with the structured copy before proposing or making edits.",
    });
  } catch (error) {
    return failure(error);
  }
});

server.registerTool("figma_screenshot", {
  title: "Screenshot a Figma node or page",
  description: "Return a PNG screenshot of one current-page node, or a rendered composite of the visible current page. Page screenshots use a temporary local frame which is removed before the result is returned.",
  inputSchema: z.object({
    target: z.enum(["node", "page"]).default("node"),
    nodeId: nodeId.optional().describe("Required when target is node."),
    maxDimension: z.number().int().min(128).max(4_096).default(2_048).describe("Longest returned-image dimension in pixels."),
    scale: z.number().finite().min(0.1).max(4).default(1),
  }).refine((input) => input.target === "page" || input.nodeId, "nodeId is required when target is node."),
}, async (input) => {
  try { return imageOutput(await sendCommand("screenshot", input)); } catch (error) { return failure(error); }
});

server.registerTool("figma_set_selection", {
  title: "Set Figma selection",
  description: "Set the active selection to existing nodes on the current page and bring them into view. Pass an empty array to clear the selection.",
  inputSchema: { nodeIds: z.array(nodeId).max(100) },
}, async (input) => {
  try { return output(await sendCommand("setSelection", input)); } catch (error) { return failure(error); }
});

server.registerTool("figma_move_resize_reparent", {
  title: "Move, resize, or reparent a Figma node",
  description: "Update an existing current-page node's x/y position, dimensions, and/or parent. Coordinates are relative to the resulting parent. Reparenting can be rejected by Figma for protected structures such as instance children.",
  inputSchema: z.object({
    nodeId,
    parentId: nodeId.optional().describe("Optional new current-page parent ID."),
    x: z.number().finite().min(-100_000).max(100_000).optional(),
    y: z.number().finite().min(-100_000).max(100_000).optional(),
    width: z.number().finite().min(1).max(100_000).optional(),
    height: z.number().finite().min(1).max(100_000).optional(),
  }).refine((input) => input.parentId || input.x !== undefined || input.y !== undefined || input.width !== undefined || input.height !== undefined, "Provide at least one mutation."),
}, async (input) => {
  try { return output(await sendCommand("moveResizeReparent", input)); } catch (error) { return failure(error); }
});

server.registerTool("figma_read_text", {
  title: "Read Figma text",
  description: "Read the complete characters and styled text segments from an existing text node on the current Figma page.",
  inputSchema: { nodeId },
}, async (input) => {
  try { return output(await sendCommand("readText", input)); } catch (error) { return failure(error); }
});

server.registerTool("figma_update_text", {
  title: "Update Figma text",
  description: "Replace text using a minimal character-range edit so unaffected mixed styles survive. Supply expectedText from the latest compact read to prevent overwriting a newer Figma edit.",
  inputSchema: { nodeId, text: z.string().max(100_000), expectedText: z.string().max(100_000).optional() },
}, async (input) => {
  try { return output(await sendCommand("updateText", input)); } catch (error) { return failure(error); }
});

server.registerTool("figma_set_text_frame", {
  title: "Set Figma text-frame sizing",
  description: "Adjust an existing text node's width, height, auto-resize mode, ellipsis truncation, or maximum lines without replacing its copy or typography.",
  inputSchema: z.object({
    nodeId,
    width: z.number().finite().min(1).max(100_000).optional(),
    height: z.number().finite().min(1).max(100_000).optional(),
    autoResize: z.enum(["fixed", "height", "width-and-height"]).optional(),
    truncate: z.boolean().optional(),
    maxLines: z.number().int().min(1).max(1_000).nullable().optional().describe("A number enables ending truncation; null removes the line limit."),
  }).refine((input) => input.width !== undefined || input.height !== undefined || input.autoResize !== undefined || input.truncate !== undefined || Object.prototype.hasOwnProperty.call(input, "maxLines"), "Provide at least one text-frame change."),
}, async (input) => {
  try { return output(await sendCommand("setTextFrame", input)); } catch (error) { return failure(error); }
});

server.registerTool("figma_split_text_block", {
  title: "Split a Figma text block",
  description: "Split one mixed-style text node into heading and body layers at a UTF-16 character boundary. Clones then deletes ranges so each half retains its existing typography. Rejects instance children and horizontal auto-layout parents.",
  inputSchema: {
    nodeId,
    splitAt: z.number().int().min(1).max(100_000).describe("Zero-based index where the body begins, using the exact string returned by a read tool."),
    trimBoundary: z.boolean().default(true).describe("Remove whitespace around the split boundary."),
    gap: z.number().finite().min(0).max(10_000).default(8).describe("Vertical gap for non-auto-layout parents."),
    headingName: z.string().trim().min(1).max(200).optional(),
    bodyName: z.string().trim().min(1).max(200).optional(),
    autoResize: z.enum(["preserve", "height"]).default("height"),
  },
}, async (input) => {
  try { return output(await sendCommand("splitTextBlock", input)); } catch (error) { return failure(error); }
});

server.registerTool("figma_archive_nodes", {
  title: "Archive Figma nodes",
  description: "Move explicit sibling nodes into one hidden, named archive group and record what replaced them. This is reversible and preferred over deletion or accumulating opacity-zero layers.",
  inputSchema: {
    nodeIds: z.array(nodeId).min(1).max(100),
    replacementNodeId: nodeId.optional(),
    archiveName: z.string().trim().min(1).max(200).default("Previous layout"),
    reason: z.string().trim().min(1).max(500).optional(),
  },
}, async (input) => {
  try { return output(await sendCommand("archiveNodes", input)); } catch (error) { return failure(error); }
});

server.registerTool("figma_supersede_layout", {
  title: "Supersede a Figma layout",
  description: "Archive explicit previous-layout nodes into a hidden named group after a verified replacement frame already exists, recording the replacement relationship for reversal and audit.",
  inputSchema: {
    previousNodeIds: z.array(nodeId).min(1).max(100),
    replacementNodeId: nodeId,
    archiveName: z.string().trim().min(1).max(200).default("Previous layout"),
    reason: z.string().trim().min(1).max(500).default("Superseded by replacement layout"),
  },
}, async (input) => {
  try { return output(await sendCommand("archiveNodes", { nodeIds: input.previousNodeIds, replacementNodeId: input.replacementNodeId, archiveName: input.archiveName, reason: input.reason })); } catch (error) { return failure(error); }
});

server.registerTool("figma_compose_frame", {
  title: "Compose and verify a Figma frame",
  description: "Create one frame plus ordered panels, dividers, and styled-span text in a single guarded plugin command. On failure every newly created node is removed. Optionally archive previous sibling nodes only after composition succeeds, then audit and export the replacement.",
  inputSchema: {
    frame: z.object({ name: z.string().trim().min(1).max(200), width: z.number().finite().min(1).max(10_000), height: z.number().finite().min(1).max(10_000), ...position, ...visualStyle }),
    elements: z.array(composeFrameElement).min(1).max(100),
    archiveNodeIds: z.array(nodeId).max(100).default([]),
    archiveName: z.string().trim().min(1).max(200).default("Previous layout"),
    archiveReason: z.string().trim().min(1).max(500).default("Superseded by composed layout"),
    audit: z.boolean().default(true),
    export: z.boolean().default(true),
    maxDimension: z.number().int().min(128).max(8_192).default(4_096),
    scale: z.number().finite().min(0.1).max(4).default(2),
  },
}, async (input) => {
  try { return output(await localizeBatchExports(await sendCommand("composeFrame", input, 300_000))); } catch (error) { return failure(error); }
});

server.registerTool("figma_copy_style_from_node", {
  title: "Copy Figma style from node",
  description: "Copy selected visual or typography properties from a known on-brand source node to one or more targets. Text targets load the source font before mutation; content and dimensions are preserved.",
  inputSchema: {
    sourceNodeId: nodeId,
    targetNodeIds: z.array(nodeId).min(1).max(100),
    aspects: z.array(z.enum(["fills", "strokes", "effects", "corners", "opacity", "typography"])).min(1).max(6).default(["fills", "strokes", "effects", "corners", "opacity", "typography"]),
    textSource: z.enum(["whole", "first-span"]).default("first-span"),
  },
}, async (input) => {
  try { return output(await sendCommand("copyStyleFromNode", input)); } catch (error) { return failure(error); }
});

server.registerTool("figma_list_page_tokens", {
  title: "List Figma page tokens and styles",
  description: "List local variables, paint/text/effect styles, and concise colours/fonts actually used on the current page so new work can inherit verified brand values instead of approximating them.",
  inputSchema: { includePageUsage: z.boolean().default(true), limit: z.number().int().min(1).max(1_000).default(250) },
}, async (input) => {
  try { return output(await sendCommand("listPageTokens", input, 120_000)); } catch (error) { return failure(error); }
});

server.registerTool("figma_list_design_system_assets", {
  title: "List available Figma design-system assets",
  description: "Discover components, component sets, named styles and variables verified in the open file, including remote assets already used on the page and linked library variable collections enabled by the user. Use before constructing UI from raw values.",
  inputSchema: {
    includeLinkedLibraries: z.boolean().default(true),
    limit: z.number().int().min(1).max(1_000).default(250),
    scanLimit: z.number().int().min(1).max(10_000).default(2_000),
  },
}, async (input) => {
  try { return output(await sendCommand("listDesignSystemAssets", input, 120_000)); } catch (error) { return failure(error); }
});

server.registerTool("figma_create_component_instance", {
  title: "Create a Figma component instance",
  description: "Create an instance from a verified local component ID or an enabled/importable library component key. Prefer this over manually reconstructing a component. Resolve design-system ties before calling.",
  inputSchema: z.object({
    componentId: nodeId.optional(),
    componentKey: z.string().trim().min(1).max(300).optional(),
    componentProperties: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
    parentId: nodeId.optional(),
    name: z.string().trim().min(1).max(200).optional(),
    ...position,
  }).refine((input) => Number(Boolean(input.componentId)) + Number(Boolean(input.componentKey)) === 1, "Provide exactly one of componentId or componentKey."),
}, async (input) => {
  try { return output(await sendCommand("createComponentInstance", input)); } catch (error) { return failure(error); }
});

server.registerTool("figma_apply_design_style", {
  title: "Apply a verified Figma style",
  description: "Apply a named local or library style to existing nodes by ID or key. Prefer this over copying raw paint, effect or typography values. Resolve design-system ties before calling.",
  inputSchema: z.object({
    targetNodeIds: z.array(nodeId).min(1).max(100),
    styleId: nodeId.optional(),
    styleKey: z.string().trim().min(1).max(300).optional(),
    aspect: z.enum(["fill", "stroke", "effect", "text"]),
  }).refine((input) => Number(Boolean(input.styleId)) + Number(Boolean(input.styleKey)) === 1, "Provide exactly one of styleId or styleKey."),
}, async (input) => {
  try { return output(await sendCommand("applyDesignStyle", input)); } catch (error) { return failure(error); }
});

server.registerTool("figma_copy_image_fill", {
  title: "Copy or crop a Figma image fill",
  description: "Copy the first existing image fill from a source node to a target node, optionally changing FILL/FIT/CROP/TILE mode and supplying a Figma 2×3 crop transform. The underlying approved image remains in Figma.",
  inputSchema: {
    sourceNodeId: nodeId,
    targetNodeId: nodeId,
    scaleMode: z.enum(["FILL", "FIT", "CROP", "TILE"]).optional(),
    imageTransform: imageTransform.optional(),
  },
}, async (input) => {
  try { return output(await sendCommand("copyImageFill", input)); } catch (error) { return failure(error); }
});

server.registerTool("figma_place_local_image", {
  title: "Place an approved local image in Figma",
  description: "Read an explicitly approved absolute local PNG/JPEG/GIF/WebP path (maximum 25 MB), create an image-filled rectangle in the current Figma page or parent, and return its node ID. No network fetch is performed.",
  inputSchema: {
    path: z.string().trim().min(1).max(4_096), name: z.string().trim().min(1).max(200), width: z.number().finite().min(1).max(10_000), height: z.number().finite().min(1).max(10_000),
    ...position, parentId: nodeId.optional(), scaleMode: z.enum(["FILL", "FIT", "CROP", "TILE"]).default("FILL"), imageTransform: imageTransform.optional(), cornerRadius: z.number().finite().min(0).max(10_000).optional(), opacity: opacity.optional(),
  },
}, async (input) => {
  try { return output(await sendCommand("placeLocalImage", await localImageInput(input), 120_000)); } catch (error) { return failure(error); }
});

server.registerTool("figma_duplicate_node", {
  title: "Duplicate a Figma node",
  description: "Duplicate an existing node or frame in its current parent, offsetting the copy to make it visible. The returned node ID identifies the duplicate.",
  inputSchema: {
    nodeId,
    name: z.string().trim().min(1).max(200).optional(),
    offsetX: z.number().finite().min(-100_000).max(100_000).default(16),
    offsetY: z.number().finite().min(-100_000).max(100_000).default(16),
  },
}, async (input) => {
  try { return output(await sendCommand("duplicateNode", input)); } catch (error) { return failure(error); }
});

server.registerTool("figma_delete_node", {
  title: "Delete a Figma node",
  description: "Permanently remove one existing current-page node and its descendants. Use only when the user explicitly asks to delete that specific node; return the node's identity before deleting it.",
  inputSchema: { nodeId },
}, async (input) => {
  try { return output(await sendCommand("deleteNode", input)); } catch (error) { return failure(error); }
});

server.registerTool("figma_create_frame", {
  title: "Create Figma frame",
  description: "Create a styled frame on the current Figma page. Supports exact size, solid fill/stroke or bound colour tokens, opacity, corner radius, clipping, and optional parenting. When a prompt names colours, create those named tokens first and bind them here. Use vertical or horizontal auto-layout only when explicitly requested.",
  inputSchema: {
    name: z.string().trim().min(1).max(200),
    width: z.number().finite().min(1).max(10_000).default(320),
    height: z.number().finite().min(1).max(10_000).default(180),
    ...position,
    parentId: nodeId.optional().describe("Optional frame, group, component, or section on the current page. Omit to create on the page."),
    layout: z.enum(["none", "horizontal", "vertical"]).default("none"),
    itemSpacing: z.number().finite().min(0).max(1_000).default(0),
    padding: z.number().finite().min(0).max(1_000).default(0),
    ...visualStyle,
  },
}, async (input) => {
  try { return output(await sendCommand("createFrame", input)); } catch (error) { return failure(error); }
});

server.registerTool("figma_create_text", {
  title: "Create Figma text",
  description: "Create styled, editable text on the current Figma page. Supports typographic text case without rewriting the stored copy, styled spans, colour or a bound colour token, parent frame, fixed-width wrapping, alignment, line height, letter spacing, and opacity. It uses Inter Regular unless a different installed Figma font is supplied.",
  inputSchema: {
    text: z.string().max(10_000),
    name: z.string().trim().min(1).max(200).optional(),
    fontFamily: z.string().trim().min(1).max(200).default("Inter"),
    fontStyle: z.string().trim().min(1).max(200).default("Regular"),
    fontSize: z.number().finite().min(1).max(1_000).default(16),
    textCase: textCase.default("original").describe("Figma typographic case. Keep the text value in natural case and use this for uppercase, lowercase, title case, or small caps."),
    ...position,
    parentId: nodeId.optional().describe("Optional frame, group, component, or section on the current page. Omit to create on the page."),
    width: z.number().finite().min(1).max(10_000).optional().describe("Sets a fixed text width and wraps content to height."),
    textAlign: z.enum(["left", "center", "right"]).optional(),
    lineHeight: z.number().finite().min(1).max(2_000).optional(),
    letterSpacing: z.number().finite().min(-1_000).max(1_000).optional(),
    fillColor: hexColor.optional().describe("Text colour in #RRGGBB."),
    fillTokenId: tokenId.optional().describe("Optional local Figma colour-variable ID to bind to the text fill."),
    fillOpacity: opacity.optional().describe("Text-fill opacity from 0 to 1."),
    opacity: opacity.optional().describe("Whole-node opacity from 0 to 1."),
    spans: z.array(styledSpan).max(100).default([]).describe("Optional UTF-16 ranges with font, size, text-case, or colour overrides inside this single text layer."),
  },
}, async (input) => {
  try { return output(await sendCommand("createText", input)); } catch (error) { return failure(error); }
});

const shapeSchema = {
  name: z.string().trim().min(1).max(200),
  width: z.number().finite().min(1).max(10_000),
  height: z.number().finite().min(1).max(10_000),
  ...position,
  parentId: nodeId.optional().describe("Optional frame, group, component, or section on the current page. Omit to create on the page."),
  ...visualStyle,
};

server.registerTool("figma_create_rectangle", {
  title: "Create Figma rectangle",
  description: "Create a styled rectangle for backgrounds, CTA buttons, dividers, and blocks. Supports solid fill/stroke or bound colour tokens, opacity, corner radius, and parenting.",
  inputSchema: shapeSchema,
}, async (input) => {
  try { return output(await sendCommand("createRectangle", input)); } catch (error) { return failure(error); }
});

server.registerTool("figma_create_ellipse", {
  title: "Create Figma ellipse",
  description: "Create a styled ellipse for simple graphic devices. Supports solid fill/stroke or bound colour tokens, opacity, and parenting.",
  inputSchema: shapeSchema,
}, async (input) => {
  try { return output(await sendCommand("createEllipse", input)); } catch (error) { return failure(error); }
});

server.registerTool("figma_import_svg", {
  title: "Import SVG into Figma",
  description: "Place an SVG string as editable vector artwork on the current page. Intended for approved SVG logo assets, icons, and simple decorative paths; it rejects scripts and event handlers.",
  inputSchema: {
    name: z.string().trim().min(1).max(200),
    svg: z.string().trim().min(20).max(200_000)
      .refine((value) => /^<svg[\\s>]/i.test(value), "SVG content must begin with an <svg> element.")
      .refine((value) => !/<\\s*(script|iframe|foreignObject)\\b/i.test(value), "SVG may not contain scripts, iframes, or foreignObject elements.")
      .refine((value) => !/\\son\\w+\\s*=/i.test(value), "SVG may not contain event handlers."),
    ...position,
    parentId: nodeId.optional().describe("Optional frame, group, component, or section on the current page. Omit to create on the page."),
    width: z.number().finite().min(1).max(10_000).optional(),
    height: z.number().finite().min(1).max(10_000).optional(),
    opacity: opacity.optional(),
  },
}, async (input) => {
  try { return output(await sendCommand("importSvg", input)); } catch (error) { return failure(error); }
});

server.registerTool("figma_style_node", {
  title: "Style a Figma node",
  description: "Apply a constrained visual style to one existing visible node on the current page: solid fill/stroke or bound colour tokens, opacity, corner radius, and frame clipping. This does not alter node content or delete anything.",
  inputSchema: {
    nodeId,
    ...visualStyle,
  },
}, async (input) => {
  try { return output(await sendCommand("styleNode", input)); } catch (error) { return failure(error); }
});

server.registerTool("figma_create_color_tokens", {
  title: "Create named Figma colour tokens",
  description: "Create or update named local Figma colour variables in one collection. Preserve the names used in the prompt exactly—for example, Oxford blue, SBS orange, Lilac, White, and Black—then bind the returned token IDs to fills, strokes, or text rather than repeating hex values.",
  inputSchema: {
    collectionName: z.string().trim().min(1).max(200).default("Campaign colours"),
    modeName: z.string().trim().min(1).max(200).default("Default"),
    colors: z.array(z.object({
      name: z.string().trim().min(1).max(200).describe("Use the colour name from the prompt exactly."),
      value: hexColor.describe("The colour's #RRGGBB value."),
    })).min(1).max(100),
  },
}, async (input) => {
  try { return output(await sendCommand("createColorTokens", input)); } catch (error) { return failure(error); }
});

server.registerTool("figma_list_fonts", {
  title: "List Figma fonts",
  description: "List installed Figma font families and styles before choosing typography for local-bridge text creation.",
  inputSchema: {
    query: z.string().trim().min(1).max(200).optional().describe("Optional case-insensitive family-name filter."),
    limit: z.number().int().min(1).max(500).default(100),
  },
}, async (input) => {
  try { return output(await sendCommand("listFonts", input)); } catch (error) { return failure(error); }
});

server.registerTool("figma_set_auto_layout", {
  title: "Set Figma auto-layout",
  description: "Apply or remove auto-layout on a selected frame, component, or instance. This is destructive only to the node's layout settings, not its children.",
  inputSchema: {
    nodeId: z.string().trim().min(1).max(200).optional().describe("Target node ID. Omit only when exactly one compatible node is selected."),
    direction: z.enum(["none", "horizontal", "vertical"]),
    itemSpacing: z.number().finite().min(0).max(1_000).default(0),
    padding: z.number().finite().min(0).max(1_000).default(0),
  },
}, async (input) => {
  try { return output(await sendCommand("setAutoLayout", input)); } catch (error) { return failure(error); }
});

async function connectMcp() {
  await server.connect(new StdioServerTransport());
  // A stdio MCP process must never outlive its client. Some desktop-app
  // updates can orphan children rather than terminating them, so monitor the
  // parent PID as a final lifecycle guard.
  process.stdin.once("end", stop);
  process.stdin.once("close", stop);
}

function clearProxyHealthTimer() {
  if (!proxyHealthTimer) return;
  clearInterval(proxyHealthTimer);
  proxyHealthTimer = null;
}

async function checkOwnerAndElect() {
  if (stopping || bridgeRole === "owner" || electionInFlight || proxyHealthInFlight) return;
  proxyHealthInFlight = true;
  let healthy = false;
  try {
    const status = await ownerRequest("/v1/status", {}, Math.min(proxyHealthIntervalMs, 1_500));
    healthy = status.bridge?.version === bridgeVersion && status.bridge?.role === "owner";
  } catch {
    healthy = false;
  } finally {
    proxyHealthInFlight = false;
  }
  if (!healthy) tryBecomeOwner();
}

function scheduleProxyHealthChecks() {
  if (proxyHealthTimer || stopping || bridgeRole === "owner") return;
  proxyHealthTimer = setInterval(checkOwnerAndElect, proxyHealthIntervalMs);
  proxyHealthTimer.unref();
}

function tryBecomeOwner() {
  if (stopping || bridgeListening || electionInFlight) return;
  electionInFlight = true;

  const onError = (error) => {
    electionInFlight = false;
    if (stopping) return;
    setBridgeRole("proxy");
    scheduleProxyHealthChecks();
    if (error.code !== "EADDRINUSE") {
      process.stderr.write(`figma-local bridge owner election failed on ${host}:${port}: ${error.message}\n`);
    }
  };

  bridge.once("error", onError);
  try {
    bridge.listen(port, host, () => {
      bridge.off("error", onError);
      electionInFlight = false;
      bridgeListening = true;
      clearProxyHealthTimer();
      setBridgeRole("owner");
    });
  } catch (error) {
    bridge.off("error", onError);
    onError(error);
  }
}

function stop(exitProcess = false) {
  if (stopping) return;
  stopping = true;
  clearProxyHealthTimer();
  for (const session of sessions.values()) rejectSession(session, "Bridge is stopping.", 503);
  const finish = () => {
    bridgeListening = false;
    if (exitProcess) process.exit(0);
  };
  if (bridgeListening) bridge.close(finish);
  else finish();
}

process.once("SIGINT", () => stop(true));
process.once("SIGTERM", () => stop(true));
process.once("disconnect", () => stop(true));

const orphanWatchdog = setInterval(() => {
  if (process.ppid === 1 && launchParentPid !== 1) stop(true);
}, 1_000);
orphanWatchdog.unref();

connectMcp().catch((error) => {
  process.stderr.write(`figma-local bridge could not start MCP: ${error instanceof Error ? error.message : String(error)}\n`);
  stop(true);
});
tryBecomeOwner();
