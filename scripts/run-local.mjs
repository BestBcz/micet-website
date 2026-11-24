import { spawn } from "node:child_process";
import { startStatusServer } from "./minecraft-status.mjs";

const [mode, ...flags] = process.argv.slice(2);
if (!["dev", "start"].includes(mode)) throw new Error("Expected dev or start.");

const configuredStatusUrl = process.env.MICET_STATUS_URL?.trim();
const statusServer = configuredStatusUrl ? null : await startStatusServer();
const statusUrl = configuredStatusUrl || "http://127.0.0.1:" + statusServer.address().port + "/status";
const common = ["--config", "dist/server/wrangler.json", "--local", "--persist-to", ".wrangler/state",
  "--ip", "127.0.0.1", "--inspector-port", "0", "--var", "MICET_STATUS_URL:" + statusUrl];
const args = mode === "dev"
  ? ["scripts/run-framework.mjs", "dev", ...flags]
  : ["--import", "./scripts/sites-env.mjs", "./node_modules/wrangler/bin/wrangler.js", "dev", ...common, ...flags];
const child = spawn(process.execPath, args, { stdio: "inherit", env: { ...process.env, MICET_STATUS_URL: statusUrl } });

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
