import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { startStatusServer } from "./minecraft-status.mjs";

function hasFlag(flags, ...names) {
  return flags.some(flag => names.some(name => flag === name || flag.startsWith(name + "=")));
}

function readFlagValues(flags, names, multi = false) {
  const values = [];
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    const eq = names.find(name => flag.startsWith(name + "="));
    if (eq) {
      values.push(flag.slice(eq.length + 1));
      continue;
    }
    if (!names.includes(flag)) continue;
    if (multi) {
      while (i + 1 < flags.length && !flags[i + 1].startsWith("-")) values.push(flags[++i]);
    } else if (i + 1 < flags.length) {
      values.push(flags[++i]);
    }
  }
  return values;
}

function readEnvVars(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    return parseEnv(raw);
  } catch {
    return null;
  }
}

export function resolveUpstreamProtocol(flags, env = process.env) {
  if (hasFlag(flags, "--upstream-protocol")) return null;
  const configPath = readFlagValues(flags, ["--config", "-c"]).at(-1) ?? "dist/server/wrangler.json";
  const configDir = dirname(resolve(configPath));
  const envName = readFlagValues(flags, ["--env", "-e"]).at(-1);
  const envFiles = readFlagValues(flags, ["--env-file"], true);
  const vars = env.CLOUDFLARE_INCLUDE_PROCESS_ENV === "true" ? { ...env } : {};

  if (envFiles.length) {
    for (const file of envFiles) {
      const target = existsSync(resolve(configDir, file)) ? resolve(configDir, file) : resolve(file);
      Object.assign(vars, readEnvVars(target) ?? {});
    }
  } else {
    const devVars = (envName ? readEnvVars(resolve(configDir, `.dev.vars.${envName}`)) : null)
      ?? readEnvVars(resolve(configDir, ".dev.vars"));
    if (devVars) {
      Object.assign(vars, devVars);
    } else if (env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV !== "false") {
      const defaults = [".env", ".env.local", ...(envName ? [`.env.${envName}`, `.env.${envName}.local`] : [])];
      for (const file of defaults) Object.assign(vars, readEnvVars(resolve(configDir, file)) ?? {});
    }
  }

  for (const entry of readFlagValues(flags, ["--var"], true)) {
    const sep = entry.indexOf(":");
    if (sep > 0) vars[entry.slice(0, sep)] = entry.slice(sep + 1);
  }

  const selfHosted = vars.MICET_SELF_HOSTED?.trim();
  const siteOrigin = vars.MICET_SITE_ORIGIN?.trim() ?? "";
  if (selfHosted === "1" || (selfHosted === undefined && /^https:\/\//i.test(siteOrigin))) {
    return "https";
  }
  return null;
}

export function buildWranglerArgs(flags, { reconcileToken, statusUrl, env = process.env }) {
  const upstreamProtocol = resolveUpstreamProtocol(flags, env);
  const common = [
    ...(hasFlag(flags, "--config", "-c") ? [] : ["--config", "dist/server/wrangler.json"]),
    "--local",
    ...(hasFlag(flags, "--persist-to") ? [] : ["--persist-to", ".wrangler/state"]),
    "--var", "MICET_RECONCILE_TOKEN:" + reconcileToken,
    "--ip", "127.0.0.1",
    "--inspector-port", "0",
    "--var", "MICET_STATUS_URL:" + statusUrl,
    ...(upstreamProtocol ? ["--upstream-protocol", upstreamProtocol] : []),
  ];
  return ["--import", "./scripts/sites-env.mjs", "./node_modules/wrangler/bin/wrangler.js", "dev", ...common, ...flags];
}

const isMain = Boolean(process.argv[1]) && (process.platform === "win32"
  ? resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
  : resolve(process.argv[1]) === fileURLToPath(import.meta.url));

if (isMain) {
  const [mode, ...flags] = process.argv.slice(2);
  if (!["dev", "start"].includes(mode)) throw new Error("Expected dev or start.");

  const configuredStatusUrl = process.env.MICET_STATUS_URL?.trim();
  const statusServer = configuredStatusUrl ? null : await startStatusServer();
  const statusUrl = configuredStatusUrl || "http://127.0.0.1:" + statusServer.address().port + "/status";
  const reconcileToken = randomUUID();
  const args = mode === "dev"
    ? ["scripts/run-framework.mjs", "dev", ...flags]
    : buildWranglerArgs(flags, { reconcileToken, statusUrl });
  const child = spawn(process.execPath, args, { stdio: "inherit", env: { ...process.env, MICET_STATUS_URL: statusUrl } });

  // The local Worker has no production cron scheduler. Keep reconciliation alive without a browser.
  const portIndex = flags.indexOf("--port");
  const port = portIndex >= 0 ? Number(flags[portIndex + 1]) : Number(flags.find(flag => flag.startsWith("--port="))?.slice(7) ?? 8787);
  let reconciling = false;
  if (mode === "start") setInterval(async () => {
    if (reconciling) return;
    reconciling = true;
    try {
      const response = await fetch("http://127.0.0.1:" + port + "/api/payments/reconcile", {
        method: "POST", headers: { Authorization: "Bearer " + reconcileToken }, redirect: "error", signal: AbortSignal.timeout(80_000),
      });
      if (!response.ok && response.status !== 404) console.warn("Reconciliation HTTP", response.status);
      await response.body?.cancel();
    } catch { console.warn("Local payment reconciliation unavailable."); }
    finally { reconciling = false; }
  }, 60_000).unref();

  const stop = () => { if (child.exitCode === null) child.kill("SIGINT"); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.once("exit", code => {
    statusServer?.close();
    process.exitCode = code ?? 0;
  });
  child.once("error", error => {
    statusServer?.close();
    console.error(error.message);
    process.exitCode = 1;
  });
}
