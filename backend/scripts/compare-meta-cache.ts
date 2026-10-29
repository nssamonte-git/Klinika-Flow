import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { closeDb } from "../src/server/db";
import { parseComparisonOptions, runComparison, safeComparisonError } from "../src/server/cache-comparison";
try {
  const options = parseComparisonOptions(process.argv.slice(2)), report = await runComparison(options);
  const folder = resolve("backend/eval/runs"); mkdirSync(folder, { recursive: true });
  const path = resolve(folder, `${new Date().toISOString().replace(/[:.]/g, "-")}-meta-cache.json`); writeFileSync(path, JSON.stringify({ ...report, implementationHash: createHash("sha256").update(["backend/src/server/meta.ts", "backend/src/server/text-call.ts", "backend/src/server/cache-comparison.ts", "backend/src/domain/text-usage.ts"].map(path => readFileSync(path, "utf8")).join("\n")).digest("hex") }, null, 2), { mode: 0o600 });
  console.log(`Meta cache comparison: ${report.mode}. Paid calls: ${report.paidCalls}/${report.plannedCalls}.`);
  console.log(`Complete measured quality/cost gate: ${report.acceptance.qualityAndCostPass ? "PASS for selected workload" : "PENDING/NOT PASSED"}. Profile unchanged.`);
  console.log(`Counts-and-hashes report: ${path}`);
} catch (error) { console.error(safeComparisonError(error)); process.exitCode = 1; } finally { closeDb(); }
