import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadPluginHelpers() {
  const pluginPath = new URL("../plugin/code.js", import.meta.url);
  const source = await readFile(pluginPath, "utf8");
  const figma = {
    editorType: "figma",
    currentPage: { id: "0:1", name: "Test", selection: [] },
    mixed: Symbol("mixed"),
    showUI() {},
    ui: { postMessage() {}, onmessage: null },
    viewport: { scrollAndZoomIntoView() {} },
    async loadFontAsync() {},
  };
  const context = vm.createContext({
    __html__: "",
    btoa,
    clearInterval,
    fetch,
    figma,
    setInterval,
    setTimeout,
  });
  vm.runInContext(`${source}\nglobalThis.__pluginTests = { pollQuery, activityForCommand, replaceTextPreservingStyles, visibilityInfo, auditTextOverflow, auditSummary, archiveNodes, createStyledText, composeFrame, setTextFrame, splitTextBlock, createComponentInstance, applyDesignStyle, figma };`, context);
  return context.__pluginTests;
}

test("poll query is encoded without browser-only URLSearchParams", async () => {
  const helpers = await loadPluginHelpers();
  helpers.figma.currentPage.name = "Brochure frames & copy / Māori";
  helpers.figma.currentPage.selection = [{ id: "1:2" }];
  assert.equal(
    helpers.pollQuery("figma session+1"),
    "?sessionId=figma%20session%2B1&pageId=0%3A1&pageName=Brochure%20frames%20%26%20copy%20%2F%20M%C4%81ori&selectionCount=1",
  );
});

test("plugin activity distinguishes document writes from reads", async () => {
  const { activityForCommand } = await loadPluginHelpers();
  const write = activityForCommand("applyCopyUpdates");
  assert.equal(write.mutating, true);
  assert.equal(write.label, "Apply copy updates");
  const read = activityForCommand("readFrameContent");
  assert.equal(read.mutating, false);
  assert.equal(read.label, "Read frame content");
});

function styledText(id, characters, parent) {
  const node = {
    id,
    name: "Combined copy",
    type: "TEXT",
    parent,
    characters,
    visible: true,
    opacity: 1,
    removed: false,
    x: 10,
    y: 20,
    width: 180,
    height: 60,
    textAutoResize: "NONE",
    textTruncation: "DISABLED",
    maxLines: null,
    fontName: { family: "Inter", style: "Regular" },
    absoluteBoundingBox: { x: 10, y: 20, width: 180, height: 60 },
    getStyledTextSegments() {
      return this.characters ? [{ start: 0, end: this.characters.length, characters: this.characters, fontName: this.fontName, fontSize: 16, fills: [] }] : [];
    },
    insertCharacters(start, value) {
      this.characters = this.characters.slice(0, start) + value + this.characters.slice(start);
    },
    deleteCharacters(start, end) {
      this.characters = this.characters.slice(0, start) + this.characters.slice(end);
    },
    resize(width, height) {
      this.width = width;
      this.height = height;
    },
    clone() {
      const copy = styledText(`${this.id}-clone`, this.characters, this.parent);
      copy.name = this.name;
      copy.x = this.x;
      copy.y = this.y;
      copy.width = this.width;
      copy.height = this.height;
      return copy;
    },
    remove() {
      this.removed = true;
      const index = this.parent?.children?.indexOf(this) ?? -1;
      if (index >= 0) this.parent.children.splice(index, 1);
    },
  };
  return node;
}

function configurePage(figma, children) {
  const page = {
    id: "0:1",
    name: "Test",
    type: "PAGE",
    children,
    selection: [],
    appendChild(node) {
      const previousIndex = node.parent?.children?.indexOf(node) ?? -1;
      if (previousIndex >= 0) node.parent.children.splice(previousIndex, 1);
      node.parent = this;
      this.children.push(node);
    },
    findOne(predicate) {
      const visit = (nodes) => {
        for (const node of nodes) {
          if (predicate(node)) return node;
          const found = node.children ? visit(node.children) : null;
          if (found) return found;
        }
        return null;
      };
      return visit(this.children);
    },
    findAll(predicate) {
      const found = [];
      const visit = (nodes) => {
        for (const node of nodes) {
          if (predicate(node)) found.push(node);
          if (node.children) visit(node.children);
        }
      };
      visit(this.children);
      return found;
    },
  };
  for (const child of children) child.parent = page;
  figma.currentPage = page;
  return page;
}

function mockText(characters) {
  return {
    characters,
    calls: [],
    insertCharacters(start, value, style) {
      this.calls.push({ action: "insert", start, value, style });
      this.characters = this.characters.slice(0, start) + value + this.characters.slice(start);
    },
    deleteCharacters(start, end) {
      this.calls.push({ action: "delete", start, end });
      this.characters = this.characters.slice(0, start) + this.characters.slice(end);
    },
  };
}

test("minimal text replacement preserves unchanged styled ranges", async () => {
  const { replaceTextPreservingStyles } = await loadPluginHelpers();
  const node = mockText("Heading\nOld body copy");
  const result = replaceTextPreservingStyles(node, "Heading\nNew body copy");
  assert.equal(node.characters, "Heading\nNew body copy");
  assert.equal(result.styleStrategy, "minimal-range");
  assert.deepEqual(node.calls.map((call) => call.action), ["delete", "insert"]);
  assert.equal(node.calls[1].style, "BEFORE");
});

test("full replacement seeds new copy from the existing first-character style", async () => {
  const { replaceTextPreservingStyles } = await loadPluginHelpers();
  const node = mockText("Old");
  const result = replaceTextPreservingStyles(node, "Entirely new");
  assert.equal(node.characters, "Entirely new");
  assert.equal(result.styleStrategy, "first-existing-character");
  assert.deepEqual(node.calls.map((call) => call.action), ["insert", "delete"]);
  assert.equal(node.calls[0].style, "AFTER");
});

test("visibility and overflow audit exclude opacity-zero descendants by default", async () => {
  const { visibilityInfo, auditTextOverflow } = await loadPluginHelpers();
  const root = {
    id: "1:1",
    name: "Frame",
    type: "FRAME",
    children: [],
    findAllWithCriteria() {},
    absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
    parent: { id: "0:1", name: "Page", type: "PAGE" },
  };
  const hiddenParent = { id: "1:2", name: "Hidden", type: "FRAME", visible: true, opacity: 0, children: [], parent: root };
  const hiddenText = { id: "1:3", name: "Old copy", type: "TEXT", visible: true, opacity: 1, characters: "Superseded", parent: hiddenParent };
  root.children.push(hiddenParent);
  hiddenParent.children.push(hiddenText);

  const visibility = visibilityInfo(root, hiddenText);
  assert.equal(visibility.effectiveVisible, false);
  assert.equal(visibility.effectiveOpacity, 0);

  const audit = await auditTextOverflow(root, { includeHidden: false });
  assert.equal(audit.textCount, 0);
  assert.equal(audit.skippedHiddenTextCount, 1);
  assert.equal(audit.warningCount, 0);
});

test("summary audit keeps IDs, copy, bounds, font sizes, and warnings only", async () => {
  const { auditSummary } = await loadPluginHelpers();
  const summary = auditSummary({
    frame: { id: "1:1", name: "Frame", bounds: { x: 0, y: 0, width: 100, height: 100 }, style: { fills: [] } },
    includeHidden: false, textCount: 1, skippedHiddenTextCount: 0, warningCount: 1, visibleWarningCount: 1,
    text: [{ id: "2:1", name: "Body", characters: "Copy", bounds: { x: 10, y: 10, width: 80, height: 20 }, fontSizes: [14], effectiveVisible: true, hierarchy: [{ id: "1:1" }, { id: "2:1" }], requiredSize: { wrappedHeight: 40 }, warnings: [{ code: "VERTICAL_OVERFLOW", message: "Too tall" }] }],
  });
  assert.equal(summary.text[0].copy, "Copy");
  assert.equal(summary.text[0].hierarchy, undefined);
  assert.equal(summary.text[0].requiredSize, undefined);
  assert.equal(summary.text[0].warnings[0].code, "VERTICAL_OVERFLOW");
});

test("archive groups sibling nodes, hides them, and records their replacement", async () => {
  const { archiveNodes, figma } = await loadPluginHelpers();
  const first = { id: "1:1", name: "Old panel", type: "FRAME", visible: true };
  const second = { id: "1:2", name: "Old copy", type: "TEXT", visible: true };
  const replacement = { id: "1:3", name: "Replacement", type: "FRAME", visible: true };
  const page = configurePage(figma, [first, second, replacement]);
  figma.group = (nodes, parent) => {
    const data = new Map();
    const group = { id: "9:1", name: "Group", type: "GROUP", visible: true, parent, children: [...nodes], setPluginData(key, value) { data.set(key, value); }, getPluginData(key) { return data.get(key) ?? ""; } };
    parent.children = parent.children.filter((node) => !nodes.includes(node));
    parent.children.push(group);
    for (const node of nodes) node.parent = group;
    return group;
  };
  const result = archiveNodes({ nodeIds: [first.id, second.id], replacementNodeId: replacement.id, archiveName: "Previous layout — brochure", reason: "Relayout" });
  const group = page.children.find((node) => node.id === "9:1");
  assert.equal(group.visible, false);
  assert.equal(group.name, "Previous layout — brochure");
  assert.equal(group.getPluginData("figma_local_bridge.replacementNodeId"), replacement.id);
  assert.deepEqual(Array.from(result.mutatedNodeIds), [first.id, second.id]);
});

test("styled text loads span fonts and applies range typography in one layer", async () => {
  const { createStyledText, figma } = await loadPluginHelpers();
  const loadedFonts = [];
  figma.loadFontAsync = async (font) => { loadedFonts.push(`${font.family} ${font.style}`); };
  figma.createText = () => ({
    id: "4:1", type: "TEXT", name: "", removed: false, height: 20, calls: [],
    resize(width, height) { this.width = width; this.height = height; },
    setRangeFontName(start, end, value) { this.calls.push({ method: "font", start, end, value }); },
    setRangeFontSize(start, end, value) { this.calls.push({ method: "size", start, end, value }); },
    setRangeTextCase(start, end, value) { this.calls.push({ method: "case", start, end, value }); },
    setRangeLineHeight() {}, setRangeLetterSpacing() {}, setRangeFills() {},
    remove() { this.removed = true; },
  });
  const parent = { appendChild(node) { node.parent = this; } };
  const node = await createStyledText({
    text: "Heading\nBody", name: "Card copy", x: 10, y: 20, width: 180,
    fontFamily: "Inter", fontStyle: "Regular", fontSize: 14, textCase: "original",
    spans: [{ start: 0, end: 7, fontStyle: "Bold", fontSize: 20, textCase: "upper" }],
  }, parent);
  assert.deepEqual(loadedFonts, ["Inter Regular", "Inter Bold"]);
  assert.equal(node.characters, "Heading\nBody");
  assert.equal(node.textCase, "ORIGINAL");
  assert.equal(node.textAutoResize, "HEIGHT");
  assert.deepEqual(node.calls.map((call) => call.method), ["font", "size", "case"]);
  assert.equal(node.calls[2].value, "UPPER");
});

test("component instances are created from verified library keys with requested properties", async () => {
  const { createComponentInstance, figma } = await loadPluginHelpers();
  configurePage(figma, []);
  const component = {
    id: "4:1", key: "library-card", name: "Card", type: "COMPONENT", description: "", remote: true,
    parent: { type: "PAGE" }, componentPropertyDefinitions: { Density: { type: "VARIANT", defaultValue: "Comfortable" } },
    createInstance() {
      return {
        id: "4:2", name: "Card", type: "INSTANCE", x: 0, y: 0, width: 200, height: 100, visible: true, opacity: 1,
        componentProperties: {}, setProperties(values) { this.componentProperties = values; },
      };
    },
  };
  figma.importComponentByKeyAsync = async (key) => {
    assert.equal(key, "library-card");
    return component;
  };
  const result = await createComponentInstance({ componentKey: "library-card", componentProperties: { Density: "Compact" }, name: "Summary", x: 20, y: 30 });
  assert.equal(result.instance.id, "4:2");
  assert.equal(result.instance.name, "Summary");
  assert.equal(result.componentProperties.Density, "Compact");
});

test("named text styles load their font and apply by style ID", async () => {
  const { applyDesignStyle, figma } = await loadPluginHelpers();
  const text = {
    id: "5:1", name: "Heading", type: "TEXT", characters: "Natural case", width: 120, height: 24, visible: true, opacity: 1,
    fontName: { family: "Inter", style: "Regular" }, fontSize: 16, textAutoResize: "WIDTH_AND_HEIGHT",
    async setTextStyleIdAsync(id) { this.appliedStyleId = id; },
  };
  configurePage(figma, [text]);
  const style = { id: "S:1", key: "heading-style", name: "Heading/Large", type: "TEXT", description: "", remote: true, fontName: { family: "SBS Sans", style: "Bold" } };
  figma.getStyleByIdAsync = async () => style;
  let loadedFont;
  figma.loadFontAsync = async (font) => { loadedFont = font; };
  const result = await applyDesignStyle({ targetNodeIds: [text.id], styleId: style.id, aspect: "text" });
  assert.equal(text.appliedStyleId, style.id);
  assert.equal(loadedFont.family, "SBS Sans");
  assert.deepEqual(Array.from(result.mutatedNodeIds), [text.id]);
});

test("compose frame removes the entire new subtree when a later element fails", async () => {
  const { composeFrame, figma } = await loadPluginHelpers();
  const page = configurePage(figma, []);
  let nextId = 1;
  const makeFrame = () => {
    const node = {
      id: `8:${nextId++}`, name: "", type: "FRAME", removed: false, children: [], x: 0, y: 0, width: 100, height: 100, fills: [], strokes: [], opacity: 1, layoutMode: "NONE",
      resize(width, height) { this.width = width; this.height = height; },
      appendChild(child) {
        const prior = child.parent?.children?.indexOf(child) ?? -1;
        if (prior >= 0) child.parent.children.splice(prior, 1);
        child.parent = this;
        this.children.push(child);
      },
      remove() {
        this.removed = true;
        for (const child of [...this.children]) child.remove?.();
        const index = this.parent?.children?.indexOf(this) ?? -1;
        if (index >= 0) this.parent.children.splice(index, 1);
      },
    };
    page.appendChild(node);
    return node;
  };
  figma.createFrame = makeFrame;
  await assert.rejects(() => composeFrame({
    frame: { name: "Replacement", width: 300, height: 400, x: 0, y: 0 },
    elements: [
      { type: "frame", key: "panel", name: "Panel", width: 260, height: 100, x: 20, y: 20, layout: "none", itemSpacing: 0, padding: 0 },
      { type: "text", key: "copy", parentKey: "panel", text: "Short", x: 10, y: 10, fontFamily: "Inter", fontStyle: "Regular", fontSize: 14, spans: [{ start: 0, end: 99 }] },
    ],
    archiveNodeIds: [], audit: false, export: false,
  }), /exceeds text length/);
  assert.equal(page.children.length, 0);
});

test("text-frame utility changes sizing without replacing copy", async () => {
  const { setTextFrame, figma } = await loadPluginHelpers();
  const node = styledText("2:1", "Copy stays intact", null);
  configurePage(figma, [node]);
  const result = await setTextFrame({ nodeId: node.id, width: 240, autoResize: "height", truncate: false, maxLines: null });
  assert.equal(node.characters, "Copy stays intact");
  assert.equal(result.after.width, 240);
  assert.equal(result.after.textAutoResize, "HEIGHT");
  assert.equal(result.after.textTruncation, "DISABLED");
});

test("split utility preserves copy in separate heading and body layers", async () => {
  const { splitTextBlock, figma } = await loadPluginHelpers();
  const parent = {
    id: "1:1",
    name: "Container",
    type: "FRAME",
    layoutMode: "NONE",
    children: [],
    insertChild(index, child) {
      const previousIndex = child.parent?.children?.indexOf(child) ?? -1;
      if (previousIndex >= 0) child.parent.children.splice(previousIndex, 1);
      child.parent = this;
      this.children.splice(index, 0, child);
    },
  };
  const source = styledText("2:1", "Heading\nBody copy", parent);
  parent.children.push(source);
  configurePage(figma, [parent]);
  const result = await splitTextBlock({ nodeId: source.id, splitAt: 8, trimBoundary: true, gap: 12, autoResize: "height" });
  assert.equal(source.characters, "Heading");
  assert.equal(parent.children[1].characters, "Body copy");
  assert.deepEqual(Array.from(result.mutatedNodeIds), [source.id]);
  assert.deepEqual(Array.from(result.createdNodeIds), [`${source.id}-clone`]);
  assert.equal(parent.children[1].y, source.y + source.height + 12);
});
