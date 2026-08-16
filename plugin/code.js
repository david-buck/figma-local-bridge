figma.showUI(__html__, { width: 360, height: 250, title: "Local MCP Bridge" });

let bridgeGeneration = 0;
const bridgeUrl = "http://localhost:3846";
const pluginVersion = "0.10.1";
const bridgeClientId = `figma-client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const mutatingCommands = new Set([
  "moveResizeReparent", "updateText", "deleteNode", "duplicateNode",
  "createFrame", "createText", "createRectangle", "createEllipse",
  "importSvg", "styleNode", "createColorTokens", "setAutoLayout",
  "applyCopyUpdates", "setTextFrame", "splitTextBlock",
  "archiveNodes", "composeFrame", "copyStyleFromNode", "copyImageFill", "placeLocalImage",
  "createComponentInstance", "applyDesignStyle",
]);

function bridgeStatus(message, kind = "") {
  figma.ui.postMessage({ type: "bridge-status", message, kind });
}

function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object") {
    if (typeof error.message === "string") return error.message;
    try { return JSON.stringify(error); } catch { return "Unknown local connection error"; }
  }
  return String(error);
}

async function bridgeRequest(path, options = {}) {
  const response = await fetch(`${bridgeUrl}${path}`, options);
  if (response.status === 204) return null;
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || `Bridge returned ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function bridgeContext() {
  return {
    pluginVersion,
    editorType: figma.editorType,
    pageId: figma.currentPage.id,
    pageName: figma.currentPage.name,
    selectionCount: figma.currentPage.selection.length,
  };
}

function pollQuery(sessionId) {
  const context = bridgeContext();
  const params = {
    sessionId,
    pageId: context.pageId,
    pageName: context.pageName,
    selectionCount: String(context.selectionCount),
  };
  return `?${Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&")}`;
}

function isReplacementError(error) {
  return error?.status === 409 && /replaced|newer figma plugin/i.test(errorMessage(error));
}

async function postHeartbeat(sessionId) {
  return bridgeRequest("/v1/heartbeat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, info: bridgeContext() }),
  });
}

async function executeWithHeartbeat(sessionId, command) {
  let heartbeatError = null;
  const heartbeat = () => postHeartbeat(sessionId).catch((error) => { heartbeatError = error; });
  await heartbeat();
  const timer = setInterval(heartbeat, 10_000);
  try {
    const result = await execute(command.name, command.input);
    if (isReplacementError(heartbeatError)) throw heartbeatError;
    return result;
  } finally {
    clearInterval(timer);
  }
}

async function startBridge() {
  const generation = ++bridgeGeneration;
  while (generation === bridgeGeneration) {
    try {
      const sessionId = `figma-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      bridgeStatus("Connecting…");
      await bridgeRequest("/v1/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, clientId: bridgeClientId, info: bridgeContext() }),
      });
      bridgeStatus(`Connected to local MCP bridge on “${figma.currentPage.name}”. Keep this plugin open.`, "connected");
      while (generation === bridgeGeneration) {
        const message = await bridgeRequest(`/v1/poll${pollQuery(sessionId)}`);
        if (!message?.command || generation !== bridgeGeneration) continue;
        let result;
        try {
          result = await executeWithHeartbeat(sessionId, message.command);
          if (mutatingCommands.has(message.command.name)) figma.commitUndo();
        } catch (error) {
          if (isReplacementError(error)) throw error;
          await bridgeRequest("/v1/result", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId, id: message.command.id, ok: false, error: errorMessage(error), info: bridgeContext() }),
          });
          continue;
        }
        await bridgeRequest("/v1/result", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, id: message.command.id, ok: true, result, info: bridgeContext() }),
        });
      }
    } catch (error) {
      if (generation !== bridgeGeneration) return;
      if (isReplacementError(error)) {
        bridgeStatus("Disconnected because another Figma file took over this bridge. Reload this plugin to reconnect here.", "waiting");
        return;
      }
      bridgeStatus(`Waiting for Codex bridge… (${errorMessage(error)})`, "waiting");
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}

function serializeNode(node) {
  const bounds = node.absoluteBoundingBox;
  const parent = node.parent && node.parent.type !== "DOCUMENT" ? node.parent : null;
  const style = {};
  if ("visible" in node) style.visible = node.visible;
  if ("locked" in node) style.locked = node.locked;
  if ("opacity" in node) style.opacity = node.opacity;
  if ("fills" in node) style.fills = node.fills === figma.mixed ? "mixed" : node.fills.slice(0, 4).map(summarizePaint);
  if ("strokes" in node) style.strokes = node.strokes === figma.mixed ? "mixed" : node.strokes.slice(0, 4).map(summarizePaint);
  if ("strokeWeight" in node) style.strokeWeight = mixedValue(node.strokeWeight);
  if ("cornerRadius" in node) style.cornerRadius = mixedValue(node.cornerRadius);
  if ("layoutMode" in node) style.layoutMode = node.layoutMode;
  if (node.type === "TEXT") {
    style.fontName = mixedValue(node.fontName);
    style.fontSize = mixedValue(node.fontSize);
    style.textAutoResize = node.textAutoResize;
    style.textAlignHorizontal = node.textAlignHorizontal;
    style.textCase = mixedValue(node.textCase);
  }
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    ...(bounds ? { bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } } : {}),
    ...(typeof node.x === "number" ? { x: node.x, y: node.y, width: node.width, height: node.height } : {}),
    ...(parent ? { parent: { id: parent.id, name: parent.name, type: parent.type } } : {}),
    childCount: "children" in node ? node.children.length : 0,
    style,
  };
}

function mixedValue(value) {
  return value === figma.mixed ? "mixed" : value;
}

function summarizePaint(paint) {
  const result = { type: paint.type, visible: paint.visible !== false, opacity: paint.opacity ?? 1 };
  if (paint.type === "SOLID") result.color = paint.color;
  if (paint.type === "IMAGE") result.scaleMode = paint.scaleMode;
  return result;
}

function nodePath(node) {
  const path = [];
  let current = node;
  while (current && current.type !== "DOCUMENT") {
    path.unshift({ id: current.id, name: current.name, type: current.type });
    current = current.parent;
  }
  return path;
}

function descendantsForQuery(input) {
  let nodes;
  if (input.selector && typeof figma.currentPage.query === "function") {
    nodes = figma.currentPage.query(input.selector).toArray();
  } else {
    nodes = figma.currentPage.findAll(() => true);
    if (input.query) {
      const query = input.query.toLowerCase();
      nodes = nodes.filter((node) => node.name.toLowerCase().includes(query));
    }
    if (input.nodeTypes?.length) nodes = nodes.filter((node) => input.nodeTypes.includes(node.type));
  }
  return nodes.slice(0, input.limit);
}

function hierarchy(node, depth, maxDepth) {
  const result = serializeNode(node);
  if (depth < maxDepth && "children" in node) {
    result.children = node.children.map((child) => hierarchy(child, depth + 1, maxDepth));
  }
  return result;
}

async function loadCurrentTextFonts(node) {
  const fonts = node.characters.length
    ? node.getStyledTextSegments(["fontName"]).map((segment) => segment.fontName)
    : [node.fontName];
  const seen = new Set();
  for (const font of fonts) {
    if (font === figma.mixed) continue;
    const key = `${font.family}\u0000${font.style}`;
    if (!seen.has(key)) {
      seen.add(key);
      await figma.loadFontAsync(font);
    }
  }
}

function textNodeById(nodeId) {
  const node = sceneNode(nodeId);
  if (node.type !== "TEXT") throw new Error(`Node ${nodeId} is not text.`);
  return node;
}

function styleSegmentCount(node) {
  return node.characters.length ? node.getStyledTextSegments(["fontName", "fontSize", "fills"]).length : 0;
}

function splitsSurrogatePair(text, index) {
  if (index <= 0 || index >= text.length) return false;
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function replaceTextPreservingStyles(node, nextText) {
  const previousText = node.characters;
  if (previousText === nextText) return { changed: false, prefixLength: previousText.length, removedLength: 0, insertedLength: 0, styleStrategy: "unchanged" };

  let prefixLength = 0;
  while (prefixLength < previousText.length && prefixLength < nextText.length && previousText[prefixLength] === nextText[prefixLength]) prefixLength += 1;
  let suffixLength = 0;
  while (
    suffixLength < previousText.length - prefixLength
    && suffixLength < nextText.length - prefixLength
    && previousText[previousText.length - 1 - suffixLength] === nextText[nextText.length - 1 - suffixLength]
  ) suffixLength += 1;

  if (splitsSurrogatePair(previousText, prefixLength) || splitsSurrogatePair(nextText, prefixLength)) prefixLength -= 1;
  while (suffixLength > 0 && (
    splitsSurrogatePair(previousText, previousText.length - suffixLength)
    || splitsSurrogatePair(nextText, nextText.length - suffixLength)
  )) suffixLength -= 1;

  const previousEnd = previousText.length - suffixLength;
  const nextEnd = nextText.length - suffixLength;
  const insertion = nextText.slice(prefixLength, nextEnd);
  const removesWholeValue = prefixLength === 0 && previousEnd === previousText.length;

  if (removesWholeValue && previousText.length > 0 && insertion.length > 0) {
    node.insertCharacters(0, insertion, "AFTER");
    node.deleteCharacters(insertion.length, insertion.length + previousText.length);
  } else {
    if (previousEnd > prefixLength) node.deleteCharacters(prefixLength, previousEnd);
    if (insertion.length > 0) node.insertCharacters(prefixLength, insertion, prefixLength > 0 ? "BEFORE" : "AFTER");
  }

  return {
    changed: true,
    prefixLength,
    removedLength: previousEnd - prefixLength,
    insertedLength: insertion.length,
    styleStrategy: removesWholeValue ? "first-existing-character" : "minimal-range",
  };
}

async function applyTextUpdates(updates) {
  const seen = new Set();
  const prepared = [];
  for (const update of updates) {
    if (seen.has(update.nodeId)) throw new Error(`Duplicate text update for ${update.nodeId}. Send each text node once per batch.`);
    seen.add(update.nodeId);
    const node = textNodeById(update.nodeId);
    if (update.expectedText !== undefined && node.characters !== update.expectedText) {
      throw new Error(`Text ${update.nodeId} changed since it was read. Re-read compact copy before applying this batch.`);
    }
    prepared.push({ update, node, before: node.characters, styleSegmentsBefore: styleSegmentCount(node) });
  }
  for (const item of prepared) await loadCurrentTextFonts(item.node);

  const results = [];
  for (const item of prepared) {
    const change = replaceTextPreservingStyles(item.node, item.update.text);
    results.push({
      nodeId: item.node.id,
      before: item.before,
      after: item.node.characters,
      ...change,
      styleSegmentsBefore: item.styleSegmentsBefore,
      styleSegmentsAfter: styleSegmentCount(item.node),
      verification: compactTextNode(figma.currentPage, item.node, 0),
    });
  }
  return {
    mutatedNodeIds: results.filter((item) => item.changed).map((item) => item.nodeId),
    updates: results,
  };
}

async function setTextFrame(input) {
  const node = textNodeById(input.nodeId);
  await loadCurrentTextFonts(node);
  const before = {
    width: node.width,
    height: node.height,
    textAutoResize: node.textAutoResize,
    textTruncation: node.textTruncation,
    maxLines: node.maxLines,
  };
  if (input.width !== undefined || input.height !== undefined) node.resize(input.width ?? node.width, input.height ?? node.height);
  if (input.autoResize !== undefined) {
    node.textAutoResize = input.autoResize === "fixed" ? "NONE" : input.autoResize === "height" ? "HEIGHT" : "WIDTH_AND_HEIGHT";
  }
  if (input.truncate !== undefined) node.textTruncation = input.truncate ? "ENDING" : "DISABLED";
  if (Object.prototype.hasOwnProperty.call(input, "maxLines")) {
    if (input.maxLines !== null) node.textTruncation = "ENDING";
    node.maxLines = input.maxLines;
  }
  focus(node);
  return {
    mutatedNodeIds: [node.id],
    before,
    after: {
      width: node.width,
      height: node.height,
      textAutoResize: node.textAutoResize,
      textTruncation: node.textTruncation,
      maxLines: node.maxLines,
    },
    text: compactTextNode(figma.currentPage, node, 0),
  };
}

function hasInstanceAncestor(node) {
  let current = node.parent;
  while (current && current.type !== "DOCUMENT") {
    if (current.type === "INSTANCE") return true;
    current = current.parent;
  }
  return false;
}

async function splitTextBlock(input) {
  const node = textNodeById(input.nodeId);
  if (hasInstanceAncestor(node)) throw new Error("Text inside an instance cannot be split structurally. Detach or edit the source component first.");
  const parent = node.parent;
  if (!parent || !("insertChild" in parent) || !("children" in parent)) throw new Error("The text node's parent cannot accept a second text layer.");
  if (parent.layoutMode === "HORIZONTAL") throw new Error("Cannot split text into a vertical heading/body pair inside a horizontal auto-layout parent.");
  const original = node.characters;
  if (input.splitAt <= 0 || input.splitAt >= original.length) throw new Error("splitAt must leave non-empty heading and body text.");
  if (splitsSurrogatePair(original, input.splitAt)) throw new Error("splitAt falls inside a multi-unit character. Choose the boundary before or after it.");

  let headingEnd = input.splitAt;
  let bodyStart = input.splitAt;
  if (input.trimBoundary) {
    while (headingEnd > 0 && /\s/.test(original[headingEnd - 1])) headingEnd -= 1;
    while (bodyStart < original.length && /\s/.test(original[bodyStart])) bodyStart += 1;
  }
  if (headingEnd <= 0 || bodyStart >= original.length) throw new Error("The requested split would leave an empty heading or body after trimming.");
  if (splitsSurrogatePair(original, headingEnd) || splitsSurrogatePair(original, bodyStart)) throw new Error("The trimmed split falls inside a multi-unit character.");

  await loadCurrentTextFonts(node);
  const originalName = node.name;
  const originalWidth = node.width;
  const originalX = node.x;
  const originalY = node.y;
  const originalIndex = parent.children.indexOf(node);
  const body = node.clone();
  try {
    parent.insertChild(originalIndex + 1, body);
    body.deleteCharacters(0, bodyStart);
    body.name = input.bodyName ?? `${originalName} body`;
    if (input.autoResize === "height") {
      body.resize(originalWidth, Math.max(1, body.height));
      body.textAutoResize = "HEIGHT";
    }

    node.deleteCharacters(headingEnd, original.length);
    node.name = input.headingName ?? `${originalName} heading`;
    if (input.autoResize === "height") {
      node.resize(originalWidth, Math.max(1, node.height));
      node.textAutoResize = "HEIGHT";
    }

    if (parent.layoutMode !== "VERTICAL") {
      node.x = originalX;
      node.y = originalY;
      body.x = originalX;
      body.y = originalY + node.height + input.gap;
    }
    figma.currentPage.selection = [node, body];
    figma.viewport.scrollAndZoomIntoView([node, body]);
    return {
      mutatedNodeIds: [node.id],
      createdNodeIds: [body.id],
      heading: compactTextNode(figma.currentPage, node, 0),
      body: compactTextNode(figma.currentPage, body, 1),
    };
  } catch (error) {
    if (!body.removed) body.remove();
    throw error;
  }
}

async function applyCopyUpdates(input) {
  const updateResult = await applyTextUpdates(input.updates);
  const audits = [];
  for (const frameId of input.auditFrames) {
    try {
      audits.push({ frameId, result: await auditTextOverflow(sceneNode(frameId), { includeHidden: input.includeHidden }) });
    } catch (error) {
      audits.push({ frameId, error: errorMessage(error) });
    }
  }

  const exports = [];
  let totalExportBytes = 0;
  const maxBatchExportBytes = 45 * 1024 * 1024;
  for (const frameId of input.exportFrames) {
    try {
      const frame = sceneNode(frameId);
      const image = await screenshotNode(frame, input);
      const estimatedBytes = Math.floor(image.imageBase64.length * 0.75);
      if (totalExportBytes + estimatedBytes > maxBatchExportBytes) {
        exports.push({ frameId, error: "Skipped because successful batch exports would exceed the 45 MB bridge-response safety limit." });
        continue;
      }
      totalExportBytes += estimatedBytes;
      exports.push({ frameId, result: { ...image, nodeName: frame.name } });
    } catch (error) {
      exports.push({ frameId, error: errorMessage(error) });
    }
  }

  return {
    ...updateResult,
    audits,
    exports,
    verificationComplete: audits.every((item) => !item.error) && exports.every((item) => !item.error),
  };
}

function orderedByPosition(nodes) {
  return [...nodes].sort((left, right) => {
    const leftBounds = left.absoluteBoundingBox;
    const rightBounds = right.absoluteBoundingBox;
    if (!leftBounds && !rightBounds) return left.name.localeCompare(right.name);
    if (!leftBounds) return 1;
    if (!rightBounds) return -1;
    const rowTolerance = Math.max(4, Math.min(leftBounds.height, rightBounds.height) * 0.5);
    if (Math.abs(leftBounds.y - rightBounds.y) > rowTolerance) return leftBounds.y - rightBounds.y;
    return leftBounds.x - rightBounds.x;
  });
}

function orderedChildren(container) {
  if (!("children" in container)) return [];
  if (container.layoutMode === "HORIZONTAL") {
    return [...container.children].sort((left, right) => (left.absoluteBoundingBox?.x ?? left.x) - (right.absoluteBoundingBox?.x ?? right.x));
  }
  if (container.layoutMode === "VERTICAL") {
    return [...container.children].sort((left, right) => (left.absoluteBoundingBox?.y ?? left.y) - (right.absoluteBoundingBox?.y ?? right.y));
  }
  return orderedByPosition(container.children);
}

function textNodesInReadingOrder(root) {
  const results = [];
  function visit(node) {
    if (node.type === "TEXT") {
      results.push(node);
      return;
    }
    for (const child of orderedChildren(node)) visit(child);
  }
  for (const child of orderedChildren(root)) visit(child);
  return results;
}

function relativeHierarchy(root, node) {
  const path = [];
  let current = node;
  while (current) {
    path.unshift({ id: current.id, name: current.name, type: current.type });
    if (current.id === root.id) return path;
    current = current.parent;
  }
  return path;
}

function fontSizesForText(node) {
  return [...new Set(node.getStyledTextSegments(["fontSize"]).map((segment) => segment.fontSize))].sort((left, right) => left - right);
}

function visibilityInfo(root, node) {
  let current = node;
  let effectiveOpacity = 1;
  const hiddenBy = [];
  while (current) {
    if ("visible" in current && current.visible === false) hiddenBy.push({ id: current.id, name: current.name, reason: "visible=false" });
    if ("opacity" in current && typeof current.opacity === "number") {
      effectiveOpacity *= current.opacity;
      if (current.opacity === 0) hiddenBy.push({ id: current.id, name: current.name, reason: "opacity=0" });
    }
    if (current.id === root.id) break;
    current = current.parent;
  }
  return {
    visible: node.visible,
    opacity: node.opacity,
    effectiveOpacity,
    effectiveVisible: current?.id === root.id && hiddenBy.length === 0 && effectiveOpacity > 0,
    hiddenBy,
  };
}

function compactTextNode(root, node, readingIndex) {
  const visibility = visibilityInfo(root, node);
  return {
    readingIndex,
    id: node.id,
    copy: node.characters,
    bounds: node.absoluteBoundingBox,
    fontSizes: fontSizesForText(node),
    visible: visibility.visible,
    opacity: visibility.opacity,
    effectiveOpacity: visibility.effectiveOpacity,
    effectiveVisible: visibility.effectiveVisible,
  };
}

function compactCopy(root, includeHidden = false) {
  if (!("findAllWithCriteria" in root)) throw new Error("The target node cannot contain text descendants.");
  const allText = textNodesInReadingOrder(root).map((node, index) => compactTextNode(root, node, index));
  const text = includeHidden ? allText : allText.filter((item) => item.effectiveVisible);
  return {
    frame: { id: root.id, name: root.name, bounds: root.absoluteBoundingBox },
    textCount: text.length,
    excludedHiddenTextCount: allText.length - text.length,
    text,
    copy: text.map((item) => item.copy).filter(Boolean).join("\n"),
  };
}

function textContent(root) {
  if (!("findAllWithCriteria" in root)) throw new Error("The target node cannot contain text descendants.");
  const textNodes = textNodesInReadingOrder(root);
  const text = textNodes.map((node, index) => {
    const visibility = visibilityInfo(root, node);
    return {
      readingIndex: index,
      id: node.id,
      name: node.name,
      characters: node.characters,
      bounds: node.absoluteBoundingBox,
      hierarchy: relativeHierarchy(root, node),
      fontSizes: fontSizesForText(node),
      ...visibility,
    };
  });
  const visibleText = text.filter((item) => item.effectiveVisible);
  return {
    frame: serializeNode(root),
    textCount: text.length,
    visibleTextCount: visibleText.length,
    hiddenTextCount: text.length - visibleText.length,
    text,
    copy: visibleText.map((item) => item.characters).filter(Boolean).join("\n"),
    allCopy: text.map((item) => item.characters).filter(Boolean).join("\n"),
  };
}

function containsBounds(outer, inner, tolerance = 0.5) {
  return inner.x >= outer.x - tolerance
    && inner.y >= outer.y - tolerance
    && inner.x + inner.width <= outer.x + outer.width + tolerance
    && inner.y + inner.height <= outer.y + outer.height + tolerance;
}

function clippingAncestorsWithin(root, node) {
  const ancestors = [];
  let current = node.parent;
  while (current && current.id !== root.id) {
    if ("clipsContent" in current && current.clipsContent && current.absoluteBoundingBox) ancestors.push(current);
    current = current.parent;
  }
  if (current?.id === root.id && "clipsContent" in current && current.clipsContent && current.absoluteBoundingBox) ancestors.push(current);
  return ancestors;
}

async function naturalTextMetrics(node) {
  if (node.hasMissingFont) return { error: "Missing font prevents reliable measurement." };
  await loadCurrentTextFonts(node);
  const probe = node.clone();
  try {
    figma.currentPage.appendChild(probe);
    probe.visible = false;
    probe.x = 100_000;
    probe.y = 100_000;
    probe.textAutoResize = "NONE";
    probe.resize(node.width, Math.max(1, node.height));
    probe.textAutoResize = "HEIGHT";
    const wrappedHeight = probe.height;
    probe.textAutoResize = "WIDTH_AND_HEIGHT";
    return { wrappedHeight, unwrappedWidth: probe.width, unwrappedHeight: probe.height };
  } finally {
    probe.remove();
  }
}

async function auditTextOverflow(root, options = {}) {
  if (!("findAllWithCriteria" in root)) throw new Error("The target node cannot contain text descendants.");
  const rootBounds = root.absoluteBoundingBox;
  const allTexts = textNodesInReadingOrder(root);
  const texts = options.includeHidden ? allTexts : allTexts.filter((node) => visibilityInfo(root, node).effectiveVisible);
  const results = [];
  for (const node of texts) {
    const bounds = node.absoluteBoundingBox;
    const warnings = [];
    let metrics;
    try {
      metrics = await naturalTextMetrics(node);
    } catch (error) {
      metrics = { error: errorMessage(error) };
      warnings.push({ code: "MEASUREMENT_FAILED", message: `Figma could not measure this text node: ${metrics.error}` });
    }
    if (node.hasMissingFont) warnings.push({ code: "MISSING_FONT", message: "Text uses a font unavailable to Figma, so overflow measurement is unreliable." });
    if (node.textTruncation === "ENDING" || node.textAutoResize === "TRUNCATE") {
      warnings.push({ code: "TRUNCATION_ENABLED", message: "Text is configured to truncate with an ellipsis." });
    }
    if (node.maxLines !== null && node.maxLines !== undefined) {
      warnings.push({ code: "MAX_LINES", message: `Text is limited to ${node.maxLines} lines.` });
    }
    if (metrics.wrappedHeight !== undefined && ["NONE", "TRUNCATE"].includes(node.textAutoResize) && metrics.wrappedHeight > node.height + 0.5) {
      warnings.push({ code: "VERTICAL_OVERFLOW", message: `Text needs approximately ${metrics.wrappedHeight.toFixed(1)}px height but its box is ${node.height.toFixed(1)}px.` });
    }
    if (bounds && rootBounds && !containsBounds(rootBounds, bounds)) {
      warnings.push({ code: "OUTSIDE_FRAME", message: "The text node extends outside the audited frame bounds." });
    }
    for (const ancestor of bounds ? clippingAncestorsWithin(root, node) : []) {
      if (!containsBounds(ancestor.absoluteBoundingBox, bounds)) {
        warnings.push({ code: "CLIPPED_BY_ANCESTOR", message: `Text extends outside clipping ancestor “${ancestor.name}” (${ancestor.id}).`, ancestorId: ancestor.id });
      }
    }
    const visibility = visibilityInfo(root, node);
    results.push({
      id: node.id,
      name: node.name,
      characters: node.characters,
      bounds,
      box: { width: node.width, height: node.height },
      hierarchy: relativeHierarchy(root, node),
      fontSizes: fontSizesForText(node),
      ...visibility,
      hasMissingFont: node.hasMissingFont,
      textAutoResize: node.textAutoResize,
      textTruncation: node.textTruncation,
      maxLines: node.maxLines,
      requiredSize: metrics.error ? { error: metrics.error } : { wrappedHeight: metrics.wrappedHeight, unwrappedWidth: metrics.unwrappedWidth, unwrappedHeight: metrics.unwrappedHeight },
      warnings,
    });
  }
  return {
    frame: serializeNode(root),
    includeHidden: options.includeHidden === true,
    textCount: results.length,
    skippedHiddenTextCount: allTexts.length - texts.length,
    warningCount: results.reduce((count, item) => count + item.warnings.length, 0),
    visibleWarningCount: results.filter((item) => item.effectiveVisible).reduce((count, item) => count + item.warnings.length, 0),
    text: results,
  };
}

function auditSummary(audit) {
  return {
    frame: { id: audit.frame.id, name: audit.frame.name, bounds: audit.frame.bounds },
    includeHidden: audit.includeHidden,
    textCount: audit.textCount,
    skippedHiddenTextCount: audit.skippedHiddenTextCount,
    warningCount: audit.warningCount,
    visibleWarningCount: audit.visibleWarningCount,
    text: audit.text.map((item) => ({
      id: item.id,
      name: item.name,
      copy: item.characters,
      bounds: item.bounds,
      fontSizes: item.fontSizes,
      effectiveVisible: item.effectiveVisible,
      warnings: item.warnings,
    })),
  };
}

function base64(bytes) {
  let result = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    result += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunkSize, bytes.length)));
  }
  return btoa(result);
}

function constrainedScale(node, maxDimension, requestedScale) {
  const bounds = node.absoluteBoundingBox ?? node;
  const largestDimension = Math.max(bounds.width, bounds.height, 1);
  return Math.min(requestedScale, maxDimension / largestDimension);
}

async function screenshotNode(node, input) {
  if (!("exportAsync" in node)) throw new Error("The target node cannot be exported as an image.");
  const scale = constrainedScale(node, input.maxDimension, input.scale);
  const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: scale } });
  const bounds = node.absoluteBoundingBox ?? node;
  return { imageBase64: base64(bytes), mimeType: "image/png", width: Math.round(bounds.width * scale), height: Math.round(bounds.height * scale), nodeId: node.id };
}

async function screenshotPage(input) {
  const sources = figma.currentPage.children.filter((node) => node.visible !== false && node.absoluteBoundingBox);
  if (sources.length === 0) throw new Error("The current page has no visible exportable nodes.");
  const boxes = sources.map((node) => node.absoluteBoundingBox);
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.width));
  const maxY = Math.max(...boxes.map((box) => box.y + box.height));
  const temporary = figma.createFrame();
  temporary.name = "__Local MCP temporary page screenshot";
  temporary.resize(Math.max(1, maxX - minX), Math.max(1, maxY - minY));
  temporary.x = minX;
  temporary.y = minY;
  temporary.fills = [];
  temporary.clipsContent = true;
  try {
    for (const source of sources) {
      const copy = source.clone();
      try {
        temporary.appendChild(copy);
        const box = source.absoluteBoundingBox;
        copy.x = box.x - minX;
        copy.y = box.y - minY;
      } catch {
        copy.remove();
      }
    }
    const image = await screenshotNode(temporary, input);
    return { ...image, nodeId: undefined, pageId: figma.currentPage.id };
  } finally {
    temporary.remove();
  }
}

function focus(node) {
  figma.currentPage.selection = [node];
  figma.viewport.scrollAndZoomIntoView([node]);
}

function removeFailedCreation(node, error) {
  if (!node.removed) node.remove();
  throw error;
}

function compatibleAutoLayoutNode(node) {
  return node && ["FRAME", "COMPONENT", "INSTANCE", "COMPONENT_SET"].includes(node.type) ? node : null;
}

function pageNode(nodeId) {
  if (!nodeId) return figma.currentPage;
  const node = figma.currentPage.findOne((candidate) => candidate.id === nodeId);
  if (!node) throw new Error("The target node was not found on the current page.");
  return node;
}

function appendToParent(node, parentId) {
  const parent = pageNode(parentId);
  if (!("appendChild" in parent)) {
    throw new Error("The supplied parent cannot contain children.");
  }
  if (node.parent === parent) return;
  parent.appendChild(node);
}

function hexToColor(hex) {
  const value = hex.slice(1);
  return {
    r: Number.parseInt(value.slice(0, 2), 16) / 255,
    g: Number.parseInt(value.slice(2, 4), 16) / 255,
    b: Number.parseInt(value.slice(4, 6), 16) / 255,
  };
}

function solidPaint(hex, opacity = 1) {
  return { type: "SOLID", color: hexToColor(hex), opacity };
}

async function tokenPaint(hex, tokenId, opacity = 1) {
  const paint = solidPaint(hex ?? "#000000", opacity);
  if (!tokenId) return paint;
  const token = await figma.variables.getVariableByIdAsync(tokenId);
  if (!token || token.resolvedType !== "COLOR") throw new Error("The supplied colour token was not found or is not a colour variable.");
  return figma.variables.setBoundVariableForPaint(paint, "color", token);
}

async function applyVisualStyle(node, input) {
  let fill;
  let stroke;
  if ((input.fillColor !== undefined || input.fillTokenId !== undefined) && "fills" in node) {
    fill = await tokenPaint(input.fillColor, input.fillTokenId, input.fillOpacity ?? 1);
  }
  if ((input.strokeColor !== undefined || input.strokeTokenId !== undefined) && "strokes" in node) {
    stroke = await tokenPaint(input.strokeColor, input.strokeTokenId, input.strokeOpacity ?? 1);
  }
  if (fill) node.fills = [fill];
  if (stroke) node.strokes = [stroke];
  if (input.strokeWeight !== undefined && "strokeWeight" in node) node.strokeWeight = input.strokeWeight;
  if (input.opacity !== undefined && "opacity" in node) node.opacity = input.opacity;
  if (input.cornerRadius !== undefined && "cornerRadius" in node) node.cornerRadius = input.cornerRadius;
  if (input.clipsContent !== undefined && "clipsContent" in node) node.clipsContent = input.clipsContent;
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function figmaTextCase(value = "original") {
  return value === "small-caps" ? "SMALL_CAPS" : value.toUpperCase();
}

async function createStyledText(input, parent) {
  const fonts = [{ family: input.fontFamily, style: input.fontStyle }];
  for (const span of input.spans ?? []) {
    fonts.push({ family: span.fontFamily ?? input.fontFamily, style: span.fontStyle ?? input.fontStyle });
    if (span.end > input.text.length) throw new Error(`Styled span ${span.start}–${span.end} exceeds text length ${input.text.length}.`);
    if (splitsSurrogatePair(input.text, span.start) || splitsSurrogatePair(input.text, span.end)) throw new Error(`Styled span ${span.start}–${span.end} splits a multi-unit character.`);
  }
  const loaded = new Set();
  for (const font of fonts) {
    const key = `${font.family}\u0000${font.style}`;
    if (!loaded.has(key)) {
      loaded.add(key);
      await figma.loadFontAsync(font);
    }
  }

  const node = figma.createText();
  try {
    parent.appendChild(node);
    node.name = input.name || input.text.replace(/\s+/g, " ").slice(0, 80) || "Text";
    node.fontName = fonts[0];
    node.fontSize = input.fontSize;
    if (input.lineHeight !== undefined) node.lineHeight = { unit: "PIXELS", value: input.lineHeight };
    if (input.letterSpacing !== undefined) node.letterSpacing = { unit: "PIXELS", value: input.letterSpacing };
    if (input.textAlign !== undefined) node.textAlignHorizontal = input.textAlign.toUpperCase();
    node.characters = input.text;
    node.textCase = figmaTextCase(input.textCase);
    if (input.width !== undefined) {
      node.resize(input.width, Math.max(1, node.height));
      node.textAutoResize = "HEIGHT";
    }
    node.x = input.x;
    node.y = input.y;
    await applyVisualStyle(node, input);

    for (const span of input.spans ?? []) {
      const font = { family: span.fontFamily ?? input.fontFamily, style: span.fontStyle ?? input.fontStyle };
      node.setRangeFontName(span.start, span.end, font);
      if (span.fontSize !== undefined) node.setRangeFontSize(span.start, span.end, span.fontSize);
      if (span.lineHeight !== undefined) node.setRangeLineHeight(span.start, span.end, { unit: "PIXELS", value: span.lineHeight });
      if (span.letterSpacing !== undefined) node.setRangeLetterSpacing(span.start, span.end, { unit: "PIXELS", value: span.letterSpacing });
      if (span.textCase !== undefined) node.setRangeTextCase(span.start, span.end, figmaTextCase(span.textCase));
      if (span.fillColor !== undefined) node.setRangeFills(span.start, span.end, [solidPaint(span.fillColor, span.fillOpacity ?? 1)]);
    }
    return node;
  } catch (error) {
    if (!node.removed) node.remove();
    throw error;
  }
}

function validateArchiveNodes(nodeIds, replacementNodeId) {
  const nodes = nodeIds.map(sceneNode);
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length) throw new Error("Archive node IDs must be unique.");
  if (replacementNodeId && nodeIds.includes(replacementNodeId)) throw new Error("The replacement node cannot also be archived.");
  const parent = nodes[0].parent;
  if (!parent || !("children" in parent) || nodes.some((node) => node.parent !== parent)) throw new Error("Archive nodes must be siblings under the same page, frame, section, or group.");
  for (const node of nodes) {
    if (hasInstanceAncestor(node)) throw new Error(`Node ${node.id} is inside an instance and cannot be archived structurally.`);
    let current = node.parent;
    while (current && current !== parent) {
      if (nodeIds.includes(current.id)) throw new Error("Archive IDs cannot contain both an ancestor and its descendant.");
      current = current.parent;
    }
  }
  const replacement = replacementNodeId ? sceneNode(replacementNodeId) : null;
  return { nodes, parent, replacement };
}

function archiveNodes(input, prepared) {
  const { nodes, parent, replacement } = prepared ?? validateArchiveNodes(input.nodeIds, input.replacementNodeId);
  const group = figma.group(nodes, parent);
  group.name = input.archiveName;
  group.setPluginData("figma_local_bridge.archivedAt", new Date().toISOString());
  group.setPluginData("figma_local_bridge.replacementNodeId", replacement?.id ?? "");
  group.setPluginData("figma_local_bridge.reason", input.reason ?? "");
  group.visible = false;
  return {
    createdNodeIds: [group.id],
    mutatedNodeIds: nodes.map((node) => node.id),
    archive: { id: group.id, name: group.name, hidden: true, archivedNodeIds: nodes.map((node) => node.id), replacementNodeId: replacement?.id ?? null, reason: input.reason ?? null },
  };
}

async function composeFrame(input) {
  const keys = new Set();
  for (const element of input.elements) {
    if (keys.has(element.key)) throw new Error(`Duplicate compose element key “${element.key}”.`);
    if (element.parentKey && !keys.has(element.parentKey)) throw new Error(`Element “${element.key}” refers to parentKey “${element.parentKey}” before that parent is created.`);
    keys.add(element.key);
  }
  const preparedArchive = input.archiveNodeIds.length ? validateArchiveNodes(input.archiveNodeIds) : null;
  const root = figma.createFrame();
  const created = [root];
  const byKey = new Map();
  try {
    root.name = input.frame.name;
    root.resize(input.frame.width, input.frame.height);
    root.x = input.frame.x;
    root.y = input.frame.y;
    await applyVisualStyle(root, input.frame);

    for (const element of input.elements) {
      const parent = element.parentKey ? byKey.get(element.parentKey) : root;
      if (!parent || !("appendChild" in parent)) throw new Error(`Element “${element.key}” requires a frame parent.`);
      let node;
      if (element.type === "frame") {
        node = figma.createFrame();
        parent.appendChild(node);
        node.name = element.name;
        node.resize(element.width, element.height);
        node.x = element.x;
        node.y = element.y;
        await applyVisualStyle(node, element);
        applyAutoLayout(node, { direction: element.layout, itemSpacing: element.itemSpacing, padding: element.padding });
      } else if (element.type === "rectangle") {
        node = figma.createRectangle();
        parent.appendChild(node);
        node.name = element.name;
        node.resize(element.width, element.height);
        node.x = element.x;
        node.y = element.y;
        await applyVisualStyle(node, element);
      } else {
        node = await createStyledText(element, parent);
      }
      created.push(node);
      byKey.set(element.key, node);
    }

    let archived = null;
    if (preparedArchive) archived = archiveNodes({ nodeIds: input.archiveNodeIds, replacementNodeId: root.id, archiveName: input.archiveName, reason: input.archiveReason }, { ...preparedArchive, replacement: root });
    const audits = input.audit ? [{ frameId: root.id, result: auditSummary(await auditTextOverflow(root, { includeHidden: false })) }] : [];
    const exports = input.export ? [{ frameId: root.id, result: { ...(await screenshotNode(root, input)), nodeName: root.name } }] : [];
    focus(root);
    return {
      createdNodeIds: created.map((node) => node.id),
      frame: serializeNode(root),
      elements: [...byKey].map(([key, node]) => ({ key, id: node.id, name: node.name, type: node.type })),
      ...(archived ? { archived: archived.archive } : {}),
      audits,
      exports,
      verificationComplete: audits.every((item) => !item.error) && exports.every((item) => !item.error),
    };
  } catch (error) {
    if (!root.removed) root.remove();
    throw error;
  }
}

function colorHex(color) {
  const channel = (value) => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, "0");
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`.toUpperCase();
}

async function listPageTokens(input) {
  const [variables, paintStyles, textStyles, effectStyles] = await Promise.all([
    figma.variables.getLocalVariablesAsync(), figma.getLocalPaintStylesAsync(), figma.getLocalTextStylesAsync(), figma.getLocalEffectStylesAsync(),
  ]);
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const collectionById = new Map(collections.map((collection) => [collection.id, collection]));
  const result = {
    variables: variables.slice(0, input.limit).map((variable) => ({
      id: variable.id, name: variable.name, type: variable.resolvedType, scopes: variable.scopes,
      collection: collectionById.get(variable.variableCollectionId)?.name ?? null,
      valuesByMode: cloneValue(variable.valuesByMode),
    })),
    paintStyles: paintStyles.slice(0, input.limit).map((style) => ({ id: style.id, name: style.name, paints: style.paints.map(summarizePaint) })),
    textStyles: textStyles.slice(0, input.limit).map((style) => ({ id: style.id, name: style.name, fontName: style.fontName, fontSize: style.fontSize, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing })),
    effectStyles: effectStyles.slice(0, input.limit).map((style) => ({ id: style.id, name: style.name, effectCount: style.effects.length })),
  };
  if (input.includePageUsage) {
    const colors = new Map();
    const fonts = new Map();
    for (const node of figma.currentPage.findAll(() => true).slice(0, input.limit)) {
      if ("fills" in node && node.fills !== figma.mixed) {
        for (const paint of node.fills) if (paint.type === "SOLID") colors.set(colorHex(paint.color), { value: colorHex(paint.color), opacity: paint.opacity ?? 1 });
      }
      if (node.type === "TEXT") {
        for (const segment of node.getStyledTextSegments(["fontName", "fontSize"])) {
          const key = `${segment.fontName.family}\u0000${segment.fontName.style}\u0000${segment.fontSize}`;
          fonts.set(key, { family: segment.fontName.family, style: segment.fontName.style, size: segment.fontSize });
        }
      }
    }
    result.pageUsage = { colors: [...colors.values()], fonts: [...fonts.values()] };
  }
  return result;
}

function componentSummary(component, usageCount = 0) {
  return {
    id: component.id, key: component.key || null, name: component.name, description: component.description || "",
    remote: component.remote === true, usageCount,
    componentSet: component.parent?.type === "COMPONENT_SET"
      ? { id: component.parent.id, key: component.parent.key || null, name: component.parent.name, remote: component.parent.remote === true }
      : null,
    componentProperties: cloneValue(component.componentPropertyDefinitions ?? {}),
  };
}

function styleSummary(style, usageCount = 0) {
  return { id: style.id, key: style.key || null, name: style.name, type: style.type, description: style.description || "", remote: style.remote === true, usageCount };
}

async function listDesignSystemAssets(input) {
  const usageByComponentId = new Map();
  const usedStyleIds = new Map();
  const pageNodes = figma.currentPage.findAll(() => true).slice(0, input.scanLimit);
  for (const node of pageNodes) {
    if (node.type === "INSTANCE") {
      const main = await node.getMainComponentAsync();
      if (main) usageByComponentId.set(main.id, (usageByComponentId.get(main.id) ?? 0) + 1);
    }
    for (const [aspect, property] of [["fill", "fillStyleId"], ["stroke", "strokeStyleId"], ["effect", "effectStyleId"], ["grid", "gridStyleId"], ["text", "textStyleId"]]) {
      const styleId = node[property];
      if (typeof styleId === "string" && styleId) {
        const usage = usedStyleIds.get(styleId) ?? { aspects: new Set(), count: 0 };
        usage.aspects.add(aspect);
        usage.count += 1;
        usedStyleIds.set(styleId, usage);
      }
    }
  }
  const [localComponents, localComponentSets, localPaintStyles, localTextStyles, localEffectStyles, localGridStyles, localVariables, localCollections] = await Promise.all([
    figma.getLocalComponentsAsync(), figma.getLocalComponentSetsAsync(), figma.getLocalPaintStylesAsync(), figma.getLocalTextStylesAsync(),
    figma.getLocalEffectStylesAsync(), figma.getLocalGridStylesAsync(), figma.variables.getLocalVariablesAsync(), figma.variables.getLocalVariableCollectionsAsync(),
  ]);
  const usedComponents = [];
  for (const [id, count] of usageByComponentId) {
    const component = await figma.getNodeByIdAsync(id);
    if (component?.type === "COMPONENT") usedComponents.push(componentSummary(component, count));
  }
  const usedStyles = [];
  for (const [id, usage] of usedStyleIds) {
    const style = await figma.getStyleByIdAsync(id);
    if (style) usedStyles.push({ ...styleSummary(style, usage.count), aspects: [...usage.aspects] });
  }
  let linkedLibraryVariableCollections = [];
  let linkedLibraryWarning = null;
  if (input.includeLinkedLibraries && figma.teamLibrary?.getAvailableLibraryVariableCollectionsAsync) {
    try {
      linkedLibraryVariableCollections = (await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync()).slice(0, input.limit).map((collection) => ({ key: collection.key, name: collection.name, libraryName: collection.libraryName }));
    } catch (error) {
      linkedLibraryWarning = errorMessage(error);
    }
  }
  return {
    page: { id: figma.currentPage.id, name: figma.currentPage.name },
    scan: { nodeCount: pageNodes.length, truncated: pageNodes.length === input.scanLimit },
    components: {
      used: usedComponents.slice(0, input.limit),
      local: localComponents.slice(0, input.limit).map((component) => componentSummary(component, usageByComponentId.get(component.id) ?? 0)),
      localSets: localComponentSets.slice(0, input.limit).map((set) => ({ id: set.id, key: set.key || null, name: set.name, description: set.description || "", remote: set.remote === true, variantGroupProperties: cloneValue(set.variantGroupProperties ?? {}) })),
    },
    styles: {
      used: usedStyles.slice(0, input.limit),
      local: [...localPaintStyles, ...localTextStyles, ...localEffectStyles, ...localGridStyles].slice(0, input.limit).map((style) => styleSummary(style)),
    },
    variables: {
      localCollections: localCollections.slice(0, input.limit).map((collection) => ({ id: collection.id, key: collection.key || null, name: collection.name, modes: collection.modes, variableCount: collection.variableIds.length })),
      local: localVariables.slice(0, input.limit).map((variable) => ({ id: variable.id, key: variable.key || null, name: variable.name, type: variable.resolvedType, collectionId: variable.variableCollectionId, scopes: variable.scopes })),
      linkedLibraryCollections: linkedLibraryVariableCollections,
    },
    ...(linkedLibraryWarning ? { warning: `Linked library variables could not be listed: ${linkedLibraryWarning}` } : {}),
    guidance: "Prefer a matching used remote component/style, then a local component/style or bound variable. A library must already be enabled in this Figma file; plugins cannot enable libraries.",
  };
}

async function createComponentInstance(input) {
  let component;
  if (input.componentId) {
    component = await figma.getNodeByIdAsync(input.componentId);
    if (component?.type !== "COMPONENT") throw new Error(`Component ${input.componentId} was not found in the current file.`);
  } else {
    component = await figma.importComponentByKeyAsync(input.componentKey);
  }
  const instance = component.createInstance();
  appendToParent(instance, input.parentId);
  instance.name = input.name ?? component.name;
  instance.x = input.x;
  instance.y = input.y;
  if (input.componentProperties && Object.keys(input.componentProperties).length) instance.setProperties(input.componentProperties);
  focus(instance);
  return { createdNodeIds: [instance.id], component: componentSummary(component), instance: serializeNode(instance), componentProperties: cloneValue(instance.componentProperties ?? {}) };
}

async function applyDesignStyle(input) {
  const style = input.styleId ? await figma.getStyleByIdAsync(input.styleId) : await figma.importStyleByKeyAsync(input.styleKey);
  if (!style) throw new Error("The requested Figma style was not found.");
  const targets = input.targetNodeIds.map(sceneNode);
  for (const target of targets) {
    if (input.aspect === "fill") {
      if (!("setFillStyleIdAsync" in target)) throw new Error(`Node ${target.id} cannot accept a fill style.`);
      await target.setFillStyleIdAsync(style.id);
    } else if (input.aspect === "stroke") {
      if (!("setStrokeStyleIdAsync" in target)) throw new Error(`Node ${target.id} cannot accept a stroke style.`);
      await target.setStrokeStyleIdAsync(style.id);
    } else if (input.aspect === "effect") {
      if (!("setEffectStyleIdAsync" in target)) throw new Error(`Node ${target.id} cannot accept an effect style.`);
      await target.setEffectStyleIdAsync(style.id);
    } else {
      if (target.type !== "TEXT" || !("setTextStyleIdAsync" in target)) throw new Error(`Node ${target.id} cannot accept a text style.`);
      if (style.type !== "TEXT") throw new Error(`Style ${style.name} is not a text style.`);
      await figma.loadFontAsync(style.fontName);
      await target.setTextStyleIdAsync(style.id);
    }
  }
  if (targets.length) figma.viewport.scrollAndZoomIntoView(targets);
  return { style: styleSummary(style), aspect: input.aspect, mutatedNodeIds: targets.map((target) => target.id), targets: targets.map(serializeNode) };
}

async function copyStyleFromNode(input) {
  const source = sceneNode(input.sourceNodeId);
  const targets = input.targetNodeIds.map(sceneNode);
  let textStyle = null;
  if (input.aspects.includes("typography")) {
    if (source.type !== "TEXT") throw new Error("Typography can only be copied from a text source node.");
    const segment = source.characters.length ? source.getStyledTextSegments(["fontName", "fontSize", "lineHeight", "letterSpacing", "textCase", "fills"])[0] : null;
    if (input.textSource === "whole" && [source.fontName, source.fontSize, source.lineHeight, source.letterSpacing, source.textCase].includes(figma.mixed)) throw new Error("Source typography is mixed; use textSource=first-span or choose a uniform source node.");
    textStyle = segment ?? { fontName: source.fontName, fontSize: source.fontSize, lineHeight: source.lineHeight, letterSpacing: source.letterSpacing, textCase: source.textCase, fills: source.fills };
    await figma.loadFontAsync(textStyle.fontName);
  }
  for (const target of targets) {
    if (input.aspects.includes("fills") && "fills" in source && "fills" in target && source.fills !== figma.mixed) target.fills = cloneValue(source.fills);
    if (input.aspects.includes("strokes") && "strokes" in source && "strokes" in target && source.strokes !== figma.mixed) {
      target.strokes = cloneValue(source.strokes);
      if ("strokeWeight" in source && "strokeWeight" in target && source.strokeWeight !== figma.mixed) target.strokeWeight = source.strokeWeight;
    }
    if (input.aspects.includes("effects") && "effects" in source && "effects" in target) target.effects = cloneValue(source.effects);
    if (input.aspects.includes("corners") && "cornerRadius" in source && "cornerRadius" in target && source.cornerRadius !== figma.mixed) target.cornerRadius = source.cornerRadius;
    if (input.aspects.includes("opacity") && "opacity" in source && "opacity" in target) target.opacity = source.opacity;
    if (input.aspects.includes("typography")) {
      if (target.type !== "TEXT") throw new Error(`Typography target ${target.id} is not text.`);
      await loadCurrentTextFonts(target);
      target.fontName = textStyle.fontName;
      target.fontSize = textStyle.fontSize;
      target.lineHeight = textStyle.lineHeight;
      target.letterSpacing = textStyle.letterSpacing;
      target.textCase = textStyle.textCase;
      if (textStyle.fills && textStyle.fills !== figma.mixed) target.fills = cloneValue(textStyle.fills);
    }
  }
  if (targets.length) figma.viewport.scrollAndZoomIntoView(targets);
  return { sourceNodeId: source.id, mutatedNodeIds: targets.map((node) => node.id), targets: targets.map(serializeNode), aspects: input.aspects };
}

function imageFill(node) {
  if (!("fills" in node) || node.fills === figma.mixed) throw new Error(`Node ${node.id} does not have readable fills.`);
  const paint = node.fills.find((fill) => fill.type === "IMAGE" && fill.imageHash);
  if (!paint) throw new Error(`Node ${node.id} has no image fill.`);
  return paint;
}

function copyImageFill(input) {
  const source = sceneNode(input.sourceNodeId);
  const target = sceneNode(input.targetNodeId);
  if (!("fills" in target)) throw new Error("Target node cannot accept image fills.");
  const paint = cloneValue(imageFill(source));
  if (input.scaleMode) paint.scaleMode = input.scaleMode;
  if (input.imageTransform) {
    paint.scaleMode = "CROP";
    paint.imageTransform = input.imageTransform;
  } else if (paint.scaleMode !== "CROP") {
    delete paint.imageTransform;
  }
  target.fills = [paint];
  focus(target);
  return { sourceNodeId: source.id, mutatedNodeIds: [target.id], target: serializeNode(target), image: { scaleMode: paint.scaleMode, imageTransform: paint.imageTransform ?? null } };
}

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function placeLocalImage(input) {
  const node = figma.createRectangle();
  try {
    node.name = input.name;
    node.resize(input.width, input.height);
    appendToParent(node, input.parentId);
    node.x = input.x;
    node.y = input.y;
    const image = figma.createImage(decodeBase64(input.imageBase64));
    const paint = { type: "IMAGE", imageHash: image.hash, scaleMode: input.imageTransform ? "CROP" : input.scaleMode };
    if (input.imageTransform) paint.imageTransform = input.imageTransform;
    node.fills = [paint];
    if (input.cornerRadius !== undefined) node.cornerRadius = input.cornerRadius;
    if (input.opacity !== undefined) node.opacity = input.opacity;
    focus(node);
    return { createdNodeIds: [node.id], node: serializeNode(node), source: { path: input.sourcePath, mimeType: input.mimeType }, image: { scaleMode: paint.scaleMode, imageTransform: paint.imageTransform ?? null } };
  } catch (error) {
    return removeFailedCreation(node, error);
  }
}

function sceneNode(nodeId) {
  const node = pageNode(nodeId);
  if (node.type === "PAGE" || node.type === "DOCUMENT") throw new Error("Select a visible object, not the page.");
  return node;
}

function autoLayoutNode(nodeId) {
  if (nodeId) {
    return compatibleAutoLayoutNode(figma.currentPage.findOne((node) => node.id === nodeId));
  }
  if (figma.currentPage.selection.length !== 1) {
    throw new Error("Select exactly one frame, component, component set, or instance—or provide its node ID.");
  }
  return compatibleAutoLayoutNode(figma.currentPage.selection[0]);
}

function applyAutoLayout(node, input) {
  node.layoutMode = input.direction === "none" ? "NONE" : input.direction === "horizontal" ? "HORIZONTAL" : "VERTICAL";
  if (node.layoutMode !== "NONE") {
    node.itemSpacing = input.itemSpacing;
    node.paddingTop = input.padding;
    node.paddingRight = input.padding;
    node.paddingBottom = input.padding;
    node.paddingLeft = input.padding;
  }
}

async function execute(name, input) {
  if (name === "getSelection") {
    return { page: { id: figma.currentPage.id, name: figma.currentPage.name }, selection: figma.currentPage.selection.map(serializeNode) };
  }

  if (name === "listPages") {
    return figma.root.children.map((page) => ({ id: page.id, name: page.name, isCurrent: page.id === figma.currentPage.id }));
  }

  if (name === "navigateToPage") {
    const page = figma.root.children.find((candidate) => candidate.id === input.pageId || candidate.name === input.pageName);
    if (!page) throw new Error("No page with that ID or exact name exists in this file.");
    await figma.setCurrentPageAsync(page);
    figma.currentPage.selection = [];
    return { page: { id: page.id, name: page.name } };
  }

  if (name === "queryPageNodes") {
    const nodes = descendantsForQuery(input);
    if (input.includeHierarchy) {
      return {
        page: { id: figma.currentPage.id, name: figma.currentPage.name },
        nodes: figma.currentPage.children.slice(0, input.limit).map((node) => hierarchy(node, 0, input.maxDepth)),
      };
    }
    return {
      page: { id: figma.currentPage.id, name: figma.currentPage.name },
      count: nodes.length,
      nodes: nodes.map((node) => ({ ...serializeNode(node), path: nodePath(node) })),
    };
  }

  if (name === "listArtboards") {
    const artboards = [];
    for (const child of figma.currentPage.children) {
      if (["FRAME", "COMPONENT", "INSTANCE"].includes(child.type)) artboards.push(child);
      if (child.type === "SECTION") {
        for (const sectionChild of child.children) {
          if (["FRAME", "COMPONENT", "INSTANCE"].includes(sectionChild.type)) artboards.push(sectionChild);
        }
      }
    }
    const ordered = orderedByPosition(artboards);
    return {
      page: { id: figma.currentPage.id, name: figma.currentPage.name },
      count: ordered.length,
      artboards: ordered.map((node, index) => ({
        index,
        id: node.id,
        name: node.name,
        type: node.type,
        bounds: node.absoluteBoundingBox,
        parent: node.parent?.type === "SECTION" ? { id: node.parent.id, name: node.parent.name, type: node.parent.type } : null,
        childCount: "children" in node ? node.children.length : 0,
      })),
    };
  }

  if (name === "readFrameContent") {
    const root = sceneNode(input.nodeId);
    return input.detail === "full" ? textContent(root) : compactCopy(root, input.includeHidden);
  }

  if (name === "readCopy") {
    const frames = input.nodeIds.map((id) => compactCopy(sceneNode(id), input.includeHidden));
    return {
      page: { id: figma.currentPage.id, name: figma.currentPage.name },
      includeHidden: input.includeHidden === true,
      frameCount: frames.length,
      excludedHiddenTextCount: frames.reduce((count, frame) => count + frame.excludedHiddenTextCount, 0),
      frames,
      copy: frames.map((frame) => frame.copy).join("\n\n"),
    };
  }

  if (name === "readSpreadContent") {
    const frames = input.nodeIds.map((id) => input.detail === "full" ? textContent(sceneNode(id)) : compactCopy(sceneNode(id), input.includeHidden));
    return {
      page: { id: figma.currentPage.id, name: figma.currentPage.name },
      frameCount: frames.length,
      frames,
      copy: frames.map((frame) => frame.copy).join("\n\n"),
      ...(input.detail === "full" ? { allCopy: frames.map((frame) => frame.allCopy).join("\n\n") } : {}),
    };
  }

  if (name === "auditTextOverflow") {
    const audit = await auditTextOverflow(sceneNode(input.nodeId), { includeHidden: input.includeHidden });
    return input.detail === "full" ? audit : auditSummary(audit);
  }

  if (name === "applyCopyUpdates") return applyCopyUpdates(input);

  if (name === "exportFramePng") {
    const node = sceneNode(input.nodeId);
    const image = await screenshotNode(node, input);
    return { ...image, nodeName: node.name };
  }

  if (name === "screenshot") {
    return input.target === "page" ? screenshotPage(input) : screenshotNode(sceneNode(input.nodeId), input);
  }

  if (name === "setSelection") {
    const nodes = input.nodeIds.map((id) => sceneNode(id));
    figma.currentPage.selection = nodes;
    if (nodes.length > 0) figma.viewport.scrollAndZoomIntoView(nodes);
    return { page: { id: figma.currentPage.id, name: figma.currentPage.name }, selection: nodes.map(serializeNode) };
  }

  if (name === "moveResizeReparent") {
    const node = sceneNode(input.nodeId);
    const parent = input.parentId ? pageNode(input.parentId) : null;
    if (parent && !("appendChild" in parent)) throw new Error("The supplied parent cannot contain children.");
    if (input.width !== undefined || input.height !== undefined) {
      if (!("resize" in node)) throw new Error("The target node cannot be resized.");
    }
    if (parent && node.parent !== parent) parent.appendChild(node);
    if (input.width !== undefined || input.height !== undefined) node.resize(input.width ?? node.width, input.height ?? node.height);
    if (input.x !== undefined) node.x = input.x;
    if (input.y !== undefined) node.y = input.y;
    focus(node);
    return { mutatedNodeIds: [node.id], node: serializeNode(node) };
  }

  if (name === "readText") {
    const node = sceneNode(input.nodeId);
    if (node.type !== "TEXT") throw new Error("The target node is not text.");
    return {
      ...serializeNode(node),
      text: node.characters,
      segments: node.getStyledTextSegments(["fontName", "fontSize", "textCase", "fills"]).map((segment) => ({
        start: segment.start,
        end: segment.end,
        characters: segment.characters,
        fontName: mixedValue(segment.fontName),
        fontSize: mixedValue(segment.fontSize),
        textCase: mixedValue(segment.textCase),
      })),
    };
  }

  if (name === "updateText") {
    const result = await applyTextUpdates([{ nodeId: input.nodeId, text: input.text, expectedText: input.expectedText }]);
    const node = textNodeById(input.nodeId);
    focus(node);
    return { ...result, node: serializeNode(node), text: node.characters };
  }

  if (name === "setTextFrame") return setTextFrame(input);

  if (name === "splitTextBlock") return splitTextBlock(input);

  if (name === "archiveNodes") return archiveNodes(input);

  if (name === "composeFrame") return composeFrame(input);

  if (name === "copyStyleFromNode") return copyStyleFromNode(input);

  if (name === "listPageTokens") return listPageTokens(input);

  if (name === "listDesignSystemAssets") return listDesignSystemAssets(input);

  if (name === "createComponentInstance") return createComponentInstance(input);

  if (name === "applyDesignStyle") return applyDesignStyle(input);

  if (name === "copyImageFill") return copyImageFill(input);

  if (name === "placeLocalImage") return placeLocalImage(input);

  if (name === "deleteNode") {
    const node = sceneNode(input.nodeId);
    const deleted = serializeNode(node);
    node.remove();
    return { deletedNodeIds: [deleted.id], deleted };
  }

  if (name === "duplicateNode") {
    const node = sceneNode(input.nodeId);
    if (!("clone" in node)) throw new Error("The target node cannot be duplicated.");
    const duplicate = node.clone();
    duplicate.name = input.name ?? `${node.name} copy`;
    duplicate.x += input.offsetX;
    duplicate.y += input.offsetY;
    focus(duplicate);
    return { sourceNodeId: node.id, createdNodeIds: [duplicate.id], node: serializeNode(duplicate) };
  }

  if (name === "createFrame") {
    const node = figma.createFrame();
    try {
      node.name = input.name;
      node.resize(input.width, input.height);
      appendToParent(node, input.parentId);
      node.x = input.x;
      node.y = input.y;
      await applyVisualStyle(node, input);
      applyAutoLayout(node, { direction: input.layout, itemSpacing: input.itemSpacing, padding: input.padding });
      focus(node);
      return { createdNodeIds: [node.id], node: serializeNode(node) };
    } catch (error) {
      return removeFailedCreation(node, error);
    }
  }

  if (name === "createText") {
    let node;
    try {
      node = await createStyledText(input, pageNode(input.parentId));
      focus(node);
      return { createdNodeIds: [node.id], node: serializeNode(node) };
    } catch (error) {
      if (node && !node.removed) node.remove();
      throw error;
    }
  }

  if (name === "createRectangle" || name === "createEllipse") {
    const node = name === "createRectangle" ? figma.createRectangle() : figma.createEllipse();
    try {
      node.name = input.name;
      node.resize(input.width, input.height);
      appendToParent(node, input.parentId);
      node.x = input.x;
      node.y = input.y;
      await applyVisualStyle(node, input);
      focus(node);
      return { createdNodeIds: [node.id], node: serializeNode(node) };
    } catch (error) {
      return removeFailedCreation(node, error);
    }
  }

  if (name === "importSvg") {
    const node = figma.createNodeFromSvg(input.svg);
    try {
      node.name = input.name;
      appendToParent(node, input.parentId);
      if (input.width !== undefined || input.height !== undefined) {
        node.resize(input.width ?? node.width, input.height ?? node.height);
      }
      node.x = input.x;
      node.y = input.y;
      if (input.opacity !== undefined) node.opacity = input.opacity;
      focus(node);
      return { createdNodeIds: [node.id], node: serializeNode(node) };
    } catch (error) {
      return removeFailedCreation(node, error);
    }
  }

  if (name === "styleNode") {
    const node = sceneNode(input.nodeId);
    await applyVisualStyle(node, input);
    focus(node);
    return { mutatedNodeIds: [node.id], node: serializeNode(node) };
  }

  if (name === "createColorTokens") {
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    let collection = collections.find((candidate) => candidate.name === input.collectionName);
    const createdCollection = !collection;
    if (!collection) {
      collection = figma.variables.createVariableCollection(input.collectionName);
      collection.renameMode(collection.defaultModeId, input.modeName);
    }

    const existingVariables = await Promise.all(collection.variableIds.map((id) => figma.variables.getVariableByIdAsync(id)));
    const variablesByName = new Map(existingVariables.filter(Boolean).map((variable) => [variable.name, variable]));
    for (const color of input.colors) {
      const existing = variablesByName.get(color.name);
      if (existing && existing.resolvedType !== "COLOR") {
        throw new Error(`A non-colour variable named "${color.name}" already exists in ${input.collectionName}.`);
      }
    }
    const variableIds = [];
    for (const color of input.colors) {
      let variable = variablesByName.get(color.name);
      if (!variable) variable = figma.variables.createVariable(color.name, collection, "COLOR");
      variable.scopes = ["FRAME_FILL", "SHAPE_FILL", "TEXT_FILL", "STROKE_COLOR"];
      variable.setValueForMode(collection.defaultModeId, hexToColor(color.value));
      variablesByName.set(variable.name, variable);
      variableIds.push({ id: variable.id, name: variable.name, value: color.value });
    }

    return {
      collection: { id: collection.id, name: collection.name, modeName: collection.modes.find((mode) => mode.modeId === collection.defaultModeId)?.name },
      createdCollection,
      colors: variableIds,
    };
  }

  if (name === "listFonts") {
    const query = input.query?.toLowerCase();
    const fontMap = new Map();
    for (const font of await figma.listAvailableFontsAsync()) {
      if (query && !font.fontName.family.toLowerCase().includes(query)) continue;
      const styles = fontMap.get(font.fontName.family) ?? [];
      styles.push(font.fontName.style);
      fontMap.set(font.fontName.family, styles);
    }
    return [...fontMap.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, input.limit)
      .map(([family, styles]) => ({ family, styles }));
  }

  if (name === "setAutoLayout") {
    const node = autoLayoutNode(input.nodeId);
    if (!node) throw new Error("The target is not a frame, component, component set, or instance on the current page.");
    applyAutoLayout(node, input);
    focus(node);
    return { mutatedNodeIds: [node.id], node: serializeNode(node), layoutMode: node.layoutMode, itemSpacing: node.itemSpacing };
  }

  throw new Error(`Unsupported command: ${name}`);
}

figma.ui.onmessage = async (message) => {
  if (message.type === "start") startBridge();
};
