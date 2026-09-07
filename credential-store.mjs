import { spawn } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const service = "figma-local-bridge";
const account = "figma-rest-api";

export async function runCredentialCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(reject, new Error("Credential storage command timed out."));
    }, options.timeoutMs ?? 10_000);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => finish(reject, error));
    child.once("close", (code) => finish(resolve, {
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function removeTransportNewline(value) {
  return value.endsWith("\r\n") ? value.slice(0, -2) : value.endsWith("\n") ? value.slice(0, -1) : value;
}

function macosBackend(run) {
  const security = "/usr/bin/security";
  return {
    id: "macos-keychain",
    label: "macOS Keychain",
    async get() {
      const result = await run(security, ["find-generic-password", "-a", account, "-s", service, "-w"]);
      // security also collapses search failures into item-not-found (44), so it
      // cannot reliably confirm absence. Treat every nonzero status as unknown.
      if (result.code !== 0) throw new Error("macOS Keychain could not read the credential.");
      return removeTransportNewline(result.stdout);
    },
    async set(secret) {
      // `security -w` reads from a controlling terminal, not a plain pipe.
      // `script` supplies that pseudo-terminal while the secret itself remains on stdin.
      const result = await run("/usr/bin/script", [
        "-q", "/dev/null", "/bin/sh", "-c",
        `stty -echo; exec ${security} add-generic-password -U -a ${account} -s ${service} -w`,
      ], { input: `${secret}\n${secret}\n`, timeoutMs: 15_000 });
      if (result.code !== 0) throw new Error("macOS Keychain did not accept the credential.");
      const saved = await this.get();
      if (saved !== secret) throw new Error("macOS Keychain could not verify the saved credential.");
    },
    async delete() {
      const result = await run(security, ["delete-generic-password", "-a", account, "-s", service]);
      if (result.code !== 0) throw new Error("macOS Keychain could not confirm removal.");
    },
  };
}

const dpapiProtectScript = [
  "$s=[Console]::In.ReadToEnd();",
  "$b=[Text.Encoding]::UTF8.GetBytes($s);",
  "$e=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);",
  "[Console]::Out.Write([Convert]::ToBase64String($e));",
].join("");

const dpapiUnprotectScript = [
  "$s=[Console]::In.ReadToEnd();",
  "$e=[Convert]::FromBase64String($s);",
  "$b=[Security.Cryptography.ProtectedData]::Unprotect($e,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);",
  "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($b));",
].join("");

async function runPowerShell(run, script, input) {
  let lastError;
  for (const executable of ["powershell.exe", "pwsh.exe"]) {
    try {
      const result = await run(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { input });
      if (result.code === 0) return result.stdout;
      lastError = new Error("Windows secure storage command failed.");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("PowerShell is unavailable.");
}

function windowsBackend(run, directory) {
  const credentialPath = join(directory, "figma-rest-token.dpapi");
  return {
    id: "windows-dpapi",
    label: "Windows user encryption",
    async get() {
      let encrypted;
      try { encrypted = await readFile(credentialPath, "utf8"); } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
      return runPowerShell(run, dpapiUnprotectScript, encrypted);
    },
    async set(secret) {
      const encrypted = await runPowerShell(run, dpapiProtectScript, secret);
      if (!encrypted) throw new Error("Windows did not return an encrypted credential.");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporaryPath = `${credentialPath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, encrypted, { mode: 0o600 });
      await rename(temporaryPath, credentialPath);
    },
    async delete() {
      await unlink(credentialPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    },
  };
}

function secretServiceItemNotFound(result) {
  // secret-tool uses status 1 for both absence and errors, printing errors to stderr.
  // Other statuses or output cannot confirm absence; never expose backend diagnostics.
  return result.code === 1 && result.stdout === "" && result.stderr === "";
}

function linuxBackend(run, environment) {
  return {
    id: "linux-secret-service",
    label: "Linux Secret Service",
    async get() {
      if (!environment.DBUS_SESSION_BUS_ADDRESS) throw new Error("No desktop Secret Service session is available.");
      const result = await run("secret-tool", ["lookup", "service", service, "account", account]);
      if (secretServiceItemNotFound(result)) return null;
      if (result.code !== 0) throw new Error("Linux Secret Service could not read the credential.");
      return removeTransportNewline(result.stdout);
    },
    async set(secret) {
      if (!environment.DBUS_SESSION_BUS_ADDRESS) throw new Error("No desktop Secret Service session is available.");
      const result = await run("secret-tool", [
        "store", "--label=Figma Local Bridge API token", "service", service, "account", account,
      ], { input: `${secret}\n` });
      if (result.code !== 0) throw new Error("Linux Secret Service did not accept the credential.");
    },
    async delete() {
      if (!environment.DBUS_SESSION_BUS_ADDRESS) throw new Error("No desktop Secret Service session is available.");
      const result = await run("secret-tool", ["clear", "service", service, "account", account]);
      if (result.code !== 0 && !secretServiceItemNotFound(result)) throw new Error("Linux Secret Service could not remove the credential.");
    },
  };
}

function memoryBackend() {
  return { id: "session", label: "Current bridge session", async get() { return null; }, async set() {}, async delete() {} };
}

export function createCredentialStore(options = {}) {
  const run = options.run ?? runCredentialCommand;
  const targetPlatform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const directory = options.directory;
  const forced = environment.FIGMA_CREDENTIAL_BACKEND;
  const backend = forced === "memory"
    ? memoryBackend()
    : targetPlatform === "darwin"
      ? macosBackend(run)
      : targetPlatform === "win32"
        ? windowsBackend(run, directory)
        : targetPlatform === "linux"
          ? linuxBackend(run, environment)
          : memoryBackend();
  let sessionSecret = null;
  let persistenceError = null;

  return {
    async get() {
      if (sessionSecret !== null) return sessionSecret;
      try { return await backend.get(); } catch {
        persistenceError = "Secure system storage is unavailable.";
        return null;
      }
    },
    async set(secret) {
      try {
        await backend.set(secret);
        if (backend.id === "session") {
          sessionSecret = secret;
          persistenceError = "Secure system storage is unavailable; the token is held only for this bridge session.";
          return { persisted: false };
        }
        sessionSecret = null;
        persistenceError = null;
        return { persisted: true };
      } catch {
        sessionSecret = secret;
        persistenceError = "Secure system storage is unavailable; the token is held only for this bridge session.";
        return { persisted: false };
      }
    },
    async delete() {
      sessionSecret = null;
      try { await backend.delete(); } catch {
        persistenceError = "The secure credential store could not confirm removal.";
        throw new Error(persistenceError);
      }
      persistenceError = null;
    },
    async status() {
      const configured = Boolean(await this.get());
      const sessionOnly = sessionSecret !== null || backend.id === "session";
      return {
        configured,
        backend: sessionOnly ? "session" : backend.id,
        label: sessionOnly ? "Current bridge session" : backend.label,
        persisted: configured && !sessionOnly,
        warning: persistenceError,
      };
    },
  };
}
