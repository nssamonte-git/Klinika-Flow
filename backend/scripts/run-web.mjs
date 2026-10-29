import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const command = process.argv[2];
if (!["dev", "build", "start"].includes(command)) throw new Error("Expected dev, build or start.");
const database = process.env.DATABASE_PATH || "data/klinikaflow.sqlite";
const flags = command === "build" ? ["--webpack"] : command === "dev" ? ["--webpack", "--hostname", "127.0.0.1"] : ["--hostname", "127.0.0.1"];
const realtime = command !== "build" && process.env.ENABLE_REALTIME_TRANSCRIPTION === "true";
const executable = realtime ? ["--import", "tsx", resolve(root, "backend/scripts/realtime-server.ts")] : [resolve(root, "node_modules/next/dist/bin/next"), command, resolve(root, "web"), ...flags, ...process.argv.slice(3)];
const child = spawn(process.execPath, executable, {
  cwd: root,
  env: { ...process.env, NODE_ENV: command === "dev" ? "development" : "production", DATABASE_PATH: database === ":memory:" ? database : resolve(root, database) },
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", () => { console.error("Could not start the web application."); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 0; });
