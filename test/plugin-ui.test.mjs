import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ui = await readFile(new URL("../plugin/ui.html", import.meta.url), "utf8");

test("Figma status panel embeds the exact plugin icon", async () => {
  const icon = await readFile(new URL("../assets/icon.png", import.meta.url));
  const dataUri = ui.match(/<img src="data:image\/png;base64,([A-Za-z0-9+/=]+)" alt="">/);
  assert.ok(dataUri, "status panel should embed a PNG icon");
  assert.deepEqual(Buffer.from(dataUri[1], "base64"), icon);
});

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
