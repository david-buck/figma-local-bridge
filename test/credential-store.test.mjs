import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCredentialStore } from "../credential-store.mjs";

test("macOS Keychain adapter keeps the token out of process arguments", async () => {
  const calls = [];
  let saved = null;
  const run = async (command, args, options = {}) => {
    calls.push({ command, args, input: options.input });
    assert.ok(!args.includes("figd_secret"));
    if (args.join(" ").includes("add-generic-password")) {
      saved = options.input.split("\n")[0];
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args.includes("find-generic-password")) return { code: saved ? 0 : 44, stdout: saved ? `${saved}\n` : "", stderr: "" };
    if (args.includes("delete-generic-password")) { saved = null; return { code: 0, stdout: "", stderr: "" }; }
    return { code: 1, stdout: "", stderr: "" };
  };
  const store = createCredentialStore({ platform: "darwin", directory: "/unused", environment: {}, run });
  assert.deepEqual(await store.set("figd_secret"), { persisted: true });
  assert.equal(await store.get(), "figd_secret");
  assert.match(calls.find((call) => call.args.join(" ").includes("add-generic-password")).input, /^figd_secret\nfigd_secret\n$/);
  assert.match(calls.find((call) => call.args.join(" ").includes("add-generic-password")).args.join(" "), /stty -echo/);
  await store.delete();
  assert.equal(await store.get(), null);
});

test("Windows DPAPI adapter writes only encrypted output to disk", async () => {
  const directory = await mkdtemp(join(tmpdir(), "figma-credential-test-"));
  const calls = [];
  const run = async (_command, args, options = {}) => {
    calls.push({ args, input: options.input });
    assert.ok(!args.includes("figd_secret"));
    if (options.input === "figd_secret") return { code: 0, stdout: "encrypted-value", stderr: "" };
    if (options.input === "encrypted-value") return { code: 0, stdout: "figd_secret", stderr: "" };
    return { code: 1, stdout: "", stderr: "" };
  };
  try {
    const store = createCredentialStore({ platform: "win32", directory, environment: {}, run });
    assert.deepEqual(await store.set("figd_secret"), { persisted: true });
    assert.equal(await readFile(join(directory, "figma-rest-token.dpapi"), "utf8"), "encrypted-value");
    assert.equal(await store.get(), "figd_secret");
    await store.delete();
    assert.equal((await store.status()).configured, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Linux Secret Service adapter sends the token only through stdin", async () => {
  const calls = [];
  let saved = null;
  const run = async (command, args, options = {}) => {
    calls.push({ command, args, input: options.input });
    assert.equal(command, "secret-tool");
    assert.ok(!args.includes("figd_secret"));
    if (args[0] === "store") { saved = options.input.slice(0, -1); return { code: 0, stdout: "", stderr: "" }; }
    if (args[0] === "lookup") return { code: saved ? 0 : 1, stdout: saved ? `${saved}\n` : "", stderr: "" };
    if (args[0] === "clear") { saved = null; return { code: 0, stdout: "", stderr: "" }; }
    return { code: 1, stdout: "", stderr: "" };
  };
  const store = createCredentialStore({ platform: "linux", directory: "/unused", environment: { DBUS_SESSION_BUS_ADDRESS: "test" }, run });
  assert.deepEqual(await store.set("figd_secret"), { persisted: true });
  assert.equal(await store.get(), "figd_secret");
  assert.equal(calls.find((call) => call.args[0] === "store").input, "figd_secret\n");
});

test("unavailable secure storage falls back to the current session without plaintext files", async () => {
  const store = createCredentialStore({
    platform: "linux",
    directory: "/unused",
    environment: {},
    run: async () => { throw new Error("missing"); },
  });
  assert.deepEqual(await store.set("figd_session"), { persisted: false });
  assert.equal(await store.get(), "figd_session");
  const status = await store.status();
  assert.equal(status.persisted, false);
  assert.equal(status.backend, "session");
  assert.match(status.warning, /session/);
});
