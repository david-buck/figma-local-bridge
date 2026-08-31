import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ui = await readFile(new URL("../plugin/ui.html", import.meta.url), "utf8");

test("plugin API setup uses a transient password field and all credential routes", () => {
  assert.match(ui, /type="password"/);
  assert.match(ui, /api-credentials\/status/);
  assert.match(ui, /api-credentials\/\$\{action\}/);
  assert.match(ui, /perform\("save"\)/);
  assert.match(ui, /perform\("test"\)/);
  assert.match(ui, /perform\("clear"\)/);
  assert.match(ui, /tokenInput\.value = ""/);
});

test("plugin UI never stores the token in browser or Figma client storage", () => {
  assert.doesNotMatch(ui, /localStorage|sessionStorage|clientStorage/);
  assert.match(ui, /file_comments:read/);
  assert.match(ui, /file_comments:write/);
});
