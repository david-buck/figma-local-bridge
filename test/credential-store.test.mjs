import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCredentialStore, runCredentialCommand } from "../credential-store.mjs";

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

for (const platform of ["darwin", "linux"]) {
  const environment = { DBUS_SESSION_BUS_ADDRESS: "test" };
  test(`${platform} handles an absent-item response conservatively`, async () => {
    const store = createCredentialStore({ platform, environment, run: async () => ({
      code: platform === "darwin" ? 44 : 1, stdout: "", stderr: "",
    }) });
    assert.equal(await store.get(), null);
    if (platform === "darwin") {
      assert.equal((await store.status()).warning, "Secure system storage is unavailable.");
      await assert.rejects(store.delete(), /could not confirm removal/);
    } else {
      assert.equal((await store.status()).warning, null);
      await store.delete();
      await store.delete();
    }
  });

  test(`${platform} denied deletion and unavailable lookup cannot report removal`, async () => {
    let unavailable = true;
    const store = createCredentialStore({ platform, environment, run: async () => unavailable
      ? { code: 1, stdout: "", stderr: "Denied: figd_fixture" }
      : { code: 0, stdout: "figd_fixture\n", stderr: "" } });
    await assert.rejects(store.delete(), { message: "The secure credential store could not confirm removal." });
    assert.equal(await store.get(), null);
    assert.equal((await store.status()).warning, "Secure system storage is unavailable.");
    unavailable = false;
    assert.equal(await store.get(), "figd_fixture");
  });

  test(`${platform} read failures report a redacted warning`, async () => {
    const store = createCredentialStore({ platform, environment, run: async () => ({ code: 1, stdout: "", stderr: "figd_fixture" }) });
    assert.equal(await store.get(), null);
    assert.equal((await store.status()).warning, "Secure system storage is unavailable.");
  });
}

test("Linux does not mistake other silent exit failures for absence", async () => {
  for (const code of [2, 127, null]) {
    const store = createCredentialStore({ platform: "linux", environment: { DBUS_SESSION_BUS_ADDRESS: "test" },
      run: async () => ({ code, stdout: "", stderr: "" }) });
    await assert.rejects(store.delete(), /could not confirm removal/);
    assert.equal((await store.status()).warning, "Secure system storage is unavailable.");
  }
});

test("Linux successful deletion clears the saved credential", async () => {
  let saved = "figd_fixture";
  const store = createCredentialStore({ platform: "linux", environment: { DBUS_SESSION_BUS_ADDRESS: "test" },
    run: async (_command, args) => {
      if (args[0] === "clear") { saved = null; return { code: 0, stdout: "", stderr: "" }; }
      return { code: saved ? 0 : 1, stdout: saved ? `${saved}\n` : "", stderr: "" };
    } });
  await store.delete();
  assert.equal(await store.get(), null);
  assert.equal((await store.status()).warning, null);
});

test("Linux missing DBUS cannot claim removal even after session fallback", async () => {
  const store = createCredentialStore({ platform: "linux", environment: {},
    run: async () => { assert.fail("No command should run without DBUS"); } });
  assert.deepEqual(await store.set("figd_fixture"), { persisted: false });
  await assert.rejects(store.delete(), /could not confirm removal/);
  assert.equal(await store.get(), null);
});

test("Linux command-not-found failures remain redacted", async () => {
  const store = createCredentialStore({ platform: "linux", environment: { DBUS_SESSION_BUS_ADDRESS: "test" },
    run: async () => { throw Object.assign(new Error("figd_fixture ENOENT"), { code: "ENOENT" }); } });
  await assert.rejects(store.delete(), { message: "The secure credential store could not confirm removal." });
  assert.equal((await store.status()).warning, "Secure system storage is unavailable.");
});

test("memory backend deletion clears a session credential idempotently", async () => {
  const store = createCredentialStore({ platform: "linux", environment: { FIGMA_CREDENTIAL_BACKEND: "memory" },
    run: async () => { assert.fail("Memory storage must never run a command"); } });
  await store.set("figd_fixture");
  await store.delete();
  await store.delete();
  assert.deepEqual(await store.status(), { configured: false, backend: "session", label: "Current bridge session", persisted: false, warning: null });
});

test("a signalled command cannot look like Secret Service absence", async () => {
  const result = await runCredentialCommand(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"]);
  assert.equal(result.code, null);
});
