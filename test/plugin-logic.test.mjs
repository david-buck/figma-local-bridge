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
  vm.runInContext(`${source}\nglobalThis.__pluginTests = { pollQuery, activityForCommand, replaceTextPreservingStyles, visibilityInfo, auditTextOverflow, auditSummary, archiveNodes, createStyledText, composeFrame, canvasLayout, setTextFrame, setTextCase, splitTextBlock, createComponentInstance, applyDesignStyle, copyStyleFromNode, listDesignSystemAssets, execute, figma };`, context);
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
    textCase: "ORIGINAL",
    fontName: { family: "Inter", style: "Regular" },
    absoluteBoundingBox: { x: 10, y: 20, width: 180, height: 60 },
    getStyledTextSegments() {
      return this.characters ? [{ start: 0, end: this.characters.length, characters: this.characters, fontName: this.fontName, fontSize: 16, textCase: this.textCase, fills: [] }] : [];
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
    getStyledTextSegments() { return [{ fontName: this.fontName }]; },
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

test("compose frame can build native panels inside a section with root auto-layout", async () => {
  const { composeFrame, figma } = await loadPluginHelpers();
  const section = {
    id: "7:1", name: "Reference board", type: "SECTION", x: 100, y: 100, width: 800, height: 600, visible: true, opacity: 1, children: [],
    appendChild(child) {
      const previousIndex = child.parent?.children?.indexOf(child) ?? -1;
      if (previousIndex >= 0) child.parent.children.splice(previousIndex, 1);
      child.parent = this;
      this.children.push(child);
    },
  };
  const page = configurePage(figma, [section]);
  let nextId = 2;
  figma.createFrame = () => {
    const node = {
      id: `7:${nextId++}`, name: "", type: "FRAME", x: 0, y: 0, width: 100, height: 100, visible: true, opacity: 1, fills: [], strokes: [], children: [], removed: false, layoutMode: "NONE",
      resize(width, height) { this.width = width; this.height = height; },
      appendChild(child) {
        const previousIndex = child.parent?.children?.indexOf(child) ?? -1;
        if (previousIndex >= 0) child.parent.children.splice(previousIndex, 1);
        child.parent = this;
        this.children.push(child);
      },
      remove() { this.removed = true; const index = this.parent?.children?.indexOf(this) ?? -1; if (index >= 0) this.parent.children.splice(index, 1); },
    };
    page.appendChild(node);
    return node;
  };
  const result = await composeFrame({
    frame: { name: "Native board", parentId: section.id, width: 500, height: 400, x: 20, y: 30, layout: "vertical", itemSpacing: 16, padding: 24 },
    elements: [{ type: "frame", key: "panel", name: "Panel", width: 452, height: 100, x: 0, y: 0, layout: "none", itemSpacing: 0, padding: 0 }],
    archiveNodeIds: [], collisionPolicy: "reject", audit: false, export: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.frame.parent.id, section.id);
  assert.equal(section.children[0].layoutMode, "VERTICAL");
  assert.equal(section.children[0].itemSpacing, 16);
  assert.equal(section.children[0].paddingTop, 24);
  assert.equal(result.elements[0].type, "FRAME");
  assert.equal(result.placement.clear, true);
});

test("canvas layout reports sections, occupied bounds, and proposed sibling collisions", async () => {
  const { canvasLayout, figma } = await loadPluginHelpers();
  const sectionChild = { id: "3:1", name: "Reference panel", type: "FRAME", x: 20, y: 30, width: 200, height: 120, visible: true, opacity: 1, children: [] };
  const section = { id: "2:1", name: "References", type: "SECTION", x: 0, y: 0, width: 400, height: 300, visible: true, opacity: 1, children: [sectionChild] };
  const frame = { id: "2:2", name: "Existing board", type: "FRAME", x: 500, y: 0, width: 100, height: 100, visible: true, opacity: 1, children: [] };
  const page = configurePage(figma, [section, frame]);
  sectionChild.parent = section;
  const result = canvasLayout({ proposed: { x: 350, y: 0, width: 200, height: 100 }, ignoreNodeIds: [], includeHidden: false, limit: 250 });
  assert.equal(result.contentBounds.x, 0);
  assert.equal(result.contentBounds.y, 0);
  assert.equal(result.contentBounds.width, 600);
  assert.equal(result.contentBounds.height, 300);
  assert.equal(result.sections[0].id, section.id);
  assert.equal(result.sections[0].artboards[0].id, sectionChild.id);
  assert.equal(result.parent.id, page.id);
  assert.equal(result.collision.clear, false);
  assert.equal(result.collision.overlapCount, 2);
});

test("native section creation rejects accidental overlap", async () => {
  const { execute, figma } = await loadPluginHelpers();
  const occupied = { id: "2:1", name: "Occupied", type: "FRAME", x: 0, y: 0, width: 200, height: 200, visible: true, opacity: 1, children: [] };
  const page = configurePage(figma, [occupied]);
  let nextId = 2;
  figma.createSection = () => {
    const section = {
      id: `2:${nextId++}`, name: "", type: "SECTION", x: 0, y: 0, width: 100, height: 100, visible: true, opacity: 1, fills: [], children: [], removed: false,
      resize(width, height) { this.width = width; this.height = height; },
      remove() { this.removed = true; const index = page.children.indexOf(this); if (index >= 0) page.children.splice(index, 1); },
    };
    page.appendChild(section);
    return section;
  };
  const created = await execute("createSection", { name: "References", x: 300, y: 0, width: 400, height: 300, collisionPolicy: "reject" });
  assert.equal(created.section.type, "SECTION");
  await assert.rejects(() => execute("createSection", { name: "Overlapping", x: 100, y: 50, width: 300, height: 200, collisionPolicy: "reject" }), /would overlap/);
  assert.equal(page.children.filter((node) => node.type === "SECTION").length, 1);
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

test("typographic case changes presentation without rewriting stored copy", async () => {
  const { setTextCase, figma } = await loadPluginHelpers();
  const node = styledText("2:2", "Quarterly outlook", null);
  configurePage(figma, [node]);
  const result = await setTextCase({ nodeId: node.id, textCase: "upper", expectedText: "Quarterly outlook" });
  assert.equal(node.characters, "Quarterly outlook");
  assert.equal(node.textCase, "UPPER");
  assert.equal(result.before.textCase, "ORIGINAL");
  assert.equal(result.after.textCase, "UPPER");
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


test("asset discovery loads document components using supported APIs and preserves page usage", async () => {
  const { listDesignSystemAssets, figma } = await loadPluginHelpers();
  const local = { id: "c", type: "COMPONENT", name: "Local", remote: false };
  const remote = { id: "r", type: "COMPONENT", name: "Remote", remote: true };
  const set = { id: "s", type: "COMPONENT_SET", name: "Set", remote: false };
  const style = { id: "style", type: "PAINT", name: "Paint" };
  configurePage(figma, [{ type: "INSTANCE", getMainComponentAsync: async () => remote, fillStyleId: style.id }, { type: "INSTANCE", getMainComponentAsync: async () => remote }]);
  const currentPage = figma.currentPage;
  const otherPage = configurePage(figma, [local, remote, set]);
  figma.currentPage = currentPage;
  let loaded = false;
  figma.loadAllPagesAsync = async () => { loaded = true; };
  figma.root = { findAllWithCriteria({ types }) { assert.equal(loaded, true); return [currentPage, otherPage].flatMap((page) => page.findAll((node) => types.includes(node.type))); } };
  for (const kind of ["Paint", "Text", "Effect", "Grid"]) figma[`getLocal${kind}StylesAsync`] = async () => kind === "Paint" ? [style] : [];
  figma.variables = { getLocalVariablesAsync: async () => [{ id: "v", name: "Token" }], getLocalVariableCollectionsAsync: async () => [{ id: "vc", variableIds: ["v"] }] };
  figma.getNodeByIdAsync = async () => remote;
  figma.getStyleByIdAsync = async () => style;
  figma.teamLibrary = { getAvailableLibraryVariableCollectionsAsync: async () => { throw new Error("unavailable"); } };
  const result = await listDesignSystemAssets({ scanLimit: 10, limit: 10, includeLinkedLibraries: true });
  assert.deepEqual(Array.from(result.components.local, (node) => node.id), ["c"]);
  assert.deepEqual(Array.from(result.components.localSets, (node) => node.id), ["s"]);
  assert.equal(result.components.used[0].usageCount, 2);
  assert.equal(result.styles.used[0].usageCount, 1);
  assert.equal(result.variables.local[0].id, "v");
  assert.match(result.warning, /unavailable/);
  const limited = await listDesignSystemAssets({ scanLimit: 1, limit: 1 });
  assert.equal(limited.components.used[0].usageCount, 1);
  assert.equal(limited.scan.truncated, true);
  configurePage(figma, []);
  figma.root.findAllWithCriteria = () => [];
  const empty = await listDesignSystemAssets({ scanLimit: 10, limit: 10 });
  assert.equal(empty.components.local.length, 0);
  assert.equal(empty.components.used.length, 0);
});

for (const failure of ["parent", "properties", "result"]) {
  test(`failed component instance ${failure} removes only the new instance`, async () => {
    const { createComponentInstance, figma } = await loadPluginHelpers();
    const source = { id: "source", name: "Source", type: "COMPONENT" };
    const unrelated = { id: "other", type: "FRAME" };
    const page = configurePage(figma, [source, unrelated]);
    let instance;
    source.createInstance = () => {
      instance = { id: "new", type: "INSTANCE", name: "New", remove() { this.removed = true; this.parent.children.splice(this.parent.children.indexOf(this), 1); }, setProperties() { if (failure === "properties") throw new Error("properties failed"); } };
      page.appendChild(instance);
      if (failure === "result") Object.defineProperty(instance, "componentProperties", { get() { throw new Error("result failed"); } });
      return instance;
    };
    figma.getNodeByIdAsync = async () => source;
    await assert.rejects(createComponentInstance({ componentId: source.id, parentId: failure === "parent" ? "missing" : undefined, x: 1, y: 2, componentProperties: { Variant: "invalid" } }));
    assert.equal(instance.removed, true);
    assert.deepEqual(page.children, [source, unrelated]);
  });
}

function compositionFixture(figma, failure) {
  const page = configurePage(figma, []);
  page.insertChild = function(index, child) { this.appendChild(child); this.children.splice(this.children.indexOf(child), 1); this.children.splice(index, 0, child); };
  let next = 0;
  function make(type = "FRAME") {
    const node = { id: `compose:${next++}`, name: type, type, visible: true, removed: false, x: 12, y: 24, width: 100, height: 100, relativeTransform: [[0, -1, 12], [1, 0, 24]], children: [], fills: [], strokes: [], opacity: 1, layoutMode: "NONE",
      resize(width, height) { this.width = width; this.height = height; },
      appendChild: page.appendChild,
      remove() { this.removed = true; for (const child of [...this.children]) child.remove(); const at = this.parent.children.indexOf(this); if (at >= 0) this.parent.children.splice(at, 1); },
      setPluginData(key, value) { if (failure === "metadata") throw new Error("metadata failed"); (this.data ??= {})[key] = value; },
      async exportAsync() { if (failure === "export") throw new Error("export failed"); return new Uint8Array([1]); },
    };
    page.appendChild(node);
    return node;
  }
  const leading = make(), first = make(), sibling = make(), second = make(), trailing = make();
  const originalOrder = [leading, first, sibling, second, trailing];
  second.visible = false;
  figma.createFrame = () => { const root = make(); root.findAllWithCriteria = () => []; if (failure === "audit") { let reads = 0; Object.defineProperty(root, "absoluteBoundingBox", { get() { if (++reads > 1) throw new Error("audit failed"); return null; } }); } return root; };
  figma.group = (nodes, parent) => {
    const index = parent.children.indexOf(nodes[0]);
    const group = make("GROUP");
    parent.insertChild(index, group);
    for (const node of nodes) { group.appendChild(node); node.x = 0; node.y = 0; node.relativeTransform = [[1, 0, 0], [0, 1, 0]]; }
    if (failure === "group") throw new Error("group failed");
    return group;
  };
  return { page, first, second, sibling, originalOrder, input: { frame: { name: "Replacement", x: 300, y: 300, width: 100, height: 100 }, elements: [], archiveNodeIds: [first.id, second.id], archiveName: "Archive", archiveReason: "Test", audit: failure === "audit", export: failure === "export" } };
}

for (const failure of ["export", "audit", "metadata", "group"]) {
  test(`composition restores originals after ${failure} failure`, async () => {
    const { composeFrame, figma } = await loadPluginHelpers();
    const { page, first, second, originalOrder, input } = compositionFixture(figma, failure);
    await assert.rejects(composeFrame(input), new RegExp(`${failure} failed`));
    assert.deepEqual(page.children.map((node) => node.id), originalOrder.map((node) => node.id));
    for (const node of [first, second]) {
      assert.equal(node.parent, page);
      assert.equal(node.removed, false);

      assert.deepEqual(JSON.parse(JSON.stringify(node.relativeTransform)), [[0, -1, 12], [1, 0, 24]]);
    }
    assert.equal(first.visible, true);
    assert.equal(second.visible, false);
  });
}

test("composition archives originals only after verification and preserves replacement metadata", async () => {
  const { composeFrame, figma } = await loadPluginHelpers();
  const { page, first, second, input } = compositionFixture(figma);
  const result = await composeFrame(input);
  const archive = page.children.find((node) => node.type === "GROUP");
  assert.equal(archive.visible, false);
  assert.deepEqual(archive.children, [first, second]);
  assert.equal(result.archived.replacementNodeId, result.frame.id);
  assert.equal(archive.data["figma_local_bridge.replacementNodeId"], result.frame.id);
  assert.equal(page.children.find((node) => node.id === result.frame.id).removed, false);
});


for (const failure of ["target", "style", "font"]) {
  test(`named style preflights ${failure} failures before any mutation`, async () => {
    const { applyDesignStyle, figma } = await loadPluginHelpers();
    let writes = 0;
    const first = styledText("first", "Text");
    const second = failure === "target" ? { id: "second", type: "FRAME" } : styledText("second", "Text");
    first.setTextStyleIdAsync = second.setTextStyleIdAsync = async () => { writes++; };
    configurePage(figma, [first, second]);
    figma.getStyleByIdAsync = async () => ({ id: "style", type: failure === "style" ? "PAINT" : "TEXT", fontName: { family: "Source", style: "Regular" } });
    let loads = 0;
    figma.loadFontAsync = async () => { if (failure === "font" && ++loads > 1) throw new Error("font failed"); };
    await assert.rejects(applyDesignStyle({ targetNodeIds: [first.id, second.id], styleId: "style", aspect: "text" }));
    assert.equal(writes, 0);
  });
}

test("named paint style rejects incompatible style type without writes", async () => {
  const { applyDesignStyle, figma } = await loadPluginHelpers();
  let writes = 0;
  configurePage(figma, [{ id: "target", type: "RECTANGLE", setFillStyleIdAsync: async () => { writes++; } }]);
  figma.getStyleByIdAsync = async () => ({ id: "style", type: "EFFECT" });
  await assert.rejects(applyDesignStyle({ targetNodeIds: ["target"], styleId: "style", aspect: "fill" }));
  assert.equal(writes, 0);
});

for (const operation of ["named", "copy"]) {
  test(`${operation} style setter failure reports exact partial target status`, async () => {
    const { applyDesignStyle, copyStyleFromNode, figma } = await loadPluginHelpers();
    const writes = [];
    const source = { id: "source", type: "RECTANGLE", fills: [] };
    const targets = ["a", "b", "c"].map((id) => {
      const node = { id, type: "RECTANGLE" };
      const set = () => { writes.push(id); if (id === "b") throw new Error("raw private failure details"); };
      node.setFillStyleIdAsync = async () => set();
      Object.defineProperty(node, "fills", { get: () => [], set });
      return node;
    });
    configurePage(figma, [source, ...targets]);
    figma.getStyleByIdAsync = async () => ({ id: "style", type: "PAINT" });
    const result = operation === "named"
      ? await applyDesignStyle({ targetNodeIds: targets.map((n) => n.id), styleId: "style", aspect: "fill" })
      : await copyStyleFromNode({ sourceNodeId: source.id, targetNodeIds: targets.map((n) => n.id), aspects: ["fills"] });
    assert.equal(result.ok, false);
    assert.equal(result.partial, true);
    assert.deepEqual(Array.from(result.completedNodeIds), ["a"]);
    assert.deepEqual(Array.from(result.potentiallyMutatedNodeIds), ["b"]);
    assert.deepEqual(Array.from(result.unattemptedNodeIds), ["c"]);
    assert.deepEqual(writes, ["a", "b"]);
    assert.doesNotMatch(result.error, /private/);
  });
}

for (const failure of ["target", "font"]) {
  test(`copy style preflights all visual and typography ${failure} requirements`, async () => {
    const { copyStyleFromNode, figma } = await loadPluginHelpers();
    const source = styledText("source", "Source"), first = styledText("first", "Text");
    const second = failure === "target" ? { id: "second", type: "FRAME" } : styledText("second", "Text");
    source.fills = [{ type: "SOLID" }];
    let writes = 0;
    for (const target of [first, second]) Object.defineProperty(target, "fills", { get: () => [], set() { writes++; } });
    second.fontName = { family: "Unavailable", style: "Regular" };
    configurePage(figma, [source, first, second]);
    figma.loadFontAsync = async (font) => { if (failure === "font" && font.family === "Unavailable") throw new Error("font failed"); };
    await assert.rejects(copyStyleFromNode({ sourceNodeId: source.id, targetNodeIds: [first.id, second.id], aspects: ["fills", "typography"], textSource: "first-span" }));
    assert.equal(writes, 0);
  });
}


test("copy style supports first-span mixed typography and visual aspects", async () => {
  const { copyStyleFromNode, figma } = await loadPluginHelpers();
  const source = styledText("source", "Mixed"), target = styledText("target", "Unchanged copy");
  source.fontName = figma.mixed;
  source.fills = figma.mixed;
  source.effects = [{ type: "LAYER_BLUR", radius: 4, visible: true }];
  target.effects = [];
  target.fills = [];
  source.getStyledTextSegments = () => [{ fontName: { family: "Source", style: "Bold" }, fontSize: 20, textCase: "UPPER", lineHeight: { unit: "AUTO" }, letterSpacing: { unit: "PIXELS", value: 0 }, fills: [] }];
  const loaded = [];
  figma.loadFontAsync = async (font) => { loaded.push(font.family); };
  configurePage(figma, [source, target]);
  const result = await copyStyleFromNode({ sourceNodeId: source.id, targetNodeIds: [target.id], aspects: ["fills", "effects", "typography", "corners"], textSource: "first-span" });
  assert.deepEqual(Array.from(result.mutatedNodeIds), [target.id]);
  assert.equal(result.partial, undefined);
  assert.equal(target.characters, "Unchanged copy");
  assert.equal(target.fontName.family, "Source");
  assert.equal(target.effects[0].radius, 4);
  assert.deepEqual(loaded, ["Source", "Inter"]);
});

for (const operation of ["named", "copy"]) {
  test(`${operation} style reports completed writes when viewport preparation fails`, async () => {
    const { applyDesignStyle, copyStyleFromNode, figma } = await loadPluginHelpers();
    const source = { id: "source", type: "RECTANGLE", fills: [] };
    const target = { id: "target", type: "RECTANGLE", fills: [], setFillStyleIdAsync: async () => {} };
    configurePage(figma, [source, target]);
    figma.getStyleByIdAsync = async () => ({ id: "style", type: "PAINT" });
    figma.viewport.scrollAndZoomIntoView = () => { throw new Error("viewport failed"); };
    const result = operation === "named"
      ? await applyDesignStyle({ targetNodeIds: [target.id], styleId: "style", aspect: "fill" })
      : await copyStyleFromNode({ sourceNodeId: source.id, targetNodeIds: [target.id], aspects: ["fills"] });
    assert.equal(result.partial, true);
    assert.deepEqual(Array.from(result.completedNodeIds), [target.id]);
    assert.equal(result.potentiallyMutatedNodeIds.length, 0);
    assert.equal(result.unattemptedNodeIds.length, 0);
  });
}
