import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { startStatusServer } from "./minecraft-status.mjs";

const [mode, ...flags] = process.argv.slice(2);
if (!["dev", "start"].includes(mode)) throw new Error("Expected dev or start.");

const configuredStatusUrl = process.env.MICET_STATUS_URL?.trim();
const statusServer = configuredStatusUrl ? null : await startStatusServer();
const statusUrl = configuredStatusUrl || "http://127.0.0.1:" + statusServer.address().port + "/status";
const reconcileToken = randomUUID();
const common = ["--config", "dist/server/wrangler.json", "--local", "--persist-to", ".wrangler/state",
  "--var", "MICET_RECONCILE_TOKEN:" + reconcileToken,
  "--ip", "127.0.0.1", "--inspector-port", "0", "--var", "MICET_STATUS_URL:" + statusUrl];
const args = mode === "dev"
  ? ["scripts/run-framework.mjs", "dev", ...flags]
  : ["--import", "./scripts/sites-env.mjs", "./node_modules/wrangler/bin/wrangler.js", "dev", ...common, ...flags];
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
