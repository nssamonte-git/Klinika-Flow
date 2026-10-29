import { parseArgs } from "node:util";
import { readFileSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { snapshotEvidence, compareEvidence } from "../src/server/acceptance-evidence";

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    encounter: { type: "string" }, out: { type: "string" }, before: { type: "string" }, after: { type: "string" }, activity: { type: "string" },
  } });
  const mode = positionals[0];
  if (positionals.length !== 1 || !values.out || !["snapshot", "compare"].includes(mode)) throw new Error("Usage: acceptance:evidence -- snapshot --encounter ID --out backend/eval/runs/NAME.json | compare --before FILE --after FILE --activity exclusive|concurrent|unknown --out backend/eval/runs/NAME.json");
  const folder = resolve("backend/eval/runs"), output = resolve(values.out);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const within = (path: string) => { const rel = relative(realpathSync(folder), path); return !!rel && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel); };
  if (!within(output)) throw new Error("Output must be inside ignored backend/eval/runs/.");
  // No nested paths: this also prevents escaping the private folder through nested symlinks.
  if (dirname(output) !== realpathSync(folder)) throw new Error("Use a filename directly inside backend/eval/runs/.");
  let report: unknown;
  if (mode === "snapshot") {
    if (!values.encounter || values.before || values.after || values.activity) throw new Error("Snapshot requires --encounter and --out only.");
    report = snapshotEvidence(process.env.DATABASE_PATH ?? "data/klinikaflow.sqlite", values.encounter);
  } else {
    if (!values.before || !values.after || values.encounter) throw new Error("Compare requires --before, --after and --out.");
    const activity = values.activity ?? "unknown";
    if (!["exclusive", "concurrent", "unknown"].includes(activity)) throw new Error("Invalid activity declaration.");
    report = compareEvidence(JSON.parse(readFileSync(values.before, "utf8")), JSON.parse(readFileSync(values.after, "utf8")), activity as "exclusive" | "concurrent" | "unknown");
  }
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  console.log(`Evidence ${mode} written. No model calls or database writes. Existing reports are never overwritten.`);
} catch {
  // Do not print parser/database errors: malformed inputs may contain private content.
  console.error("Evidence failed: check mode/arguments, snapshot schema, database access, and a new filename directly under backend/eval/runs/. Private input and database errors are not printed. See LIVE_ACCEPTANCE.md for usage.");
  process.exitCode = 1;
}
