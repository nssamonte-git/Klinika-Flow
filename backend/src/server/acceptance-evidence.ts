// Local, privileged evidence tooling. Never import the application's db() initializer here.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { z } from "zod";
import { MODEL, PRICING } from "../domain/model-ids";
import { OPERATION_VERSIONS } from "../domain/prompt-versions";

const id = z.string().regex(/^[a-zA-Z0-9-]{1,100}$/);
const amount = z.number().finite().nonnegative();
const count = z.number().int().nonnegative();
const nullableCount = count.nullable();
const operation = z.enum(["note", "filipino_sheet", "note_review", "sheet_review", "teach_back_analysis", "note_correction", "plan_question", "document_extraction", "transcription", "agent_teach_back_plan", "agent_source_review_plan", "other"]);
const basis = z.enum(["measured-tokens", "cache-unknown-estimate", "unknown"]);
const textSchema = z.object({
  model: z.enum([MODEL.text, "unknown"]), operation,
  promptVersion: z.string().regex(/^klinikaflow-[a-z-]+@[12]$|^unknown$/),
  profile: z.enum(["legacy", "efficient", "unknown"]),
  status: z.enum(["started", "completed", "incomplete", "refused", "invalid-output", "invalid-usage", "network-error", "http-error", "unknown"]),
  latencyMs: amount.nullable(), pricingVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}$|^unknown$/),
  inputTokens: nullableCount, cachedTokens: nullableCount, outputTokens: nullableCount,
  costBasis: basis, costUsd: amount.nullable(),
}).strict();
const reservationSchema = z.object({ id, operation, created: count, estimatedUsd: amount, calculatedUsd: amount.nullable(), text: textSchema.nullable() }).strict();
export const EvidenceSnapshotSchema = z.object({
  format: z.literal("klinikaflow-acceptance-snapshot@1"), at: z.iso.datetime(),
  databaseIdentity: z.string().regex(/^[a-f0-9]{64}$/), schemaVersion: z.union([z.literal(5), z.literal(6)]),
  encounterId: id, encounterVersion: count, accountId: id,
  configuration: z.object({
    source: z.literal("CLI environment; server configuration must be confirmed separately"),
    profile: z.enum(["legacy", "efficient"]), models: z.object({ text: z.literal(MODEL.text), voice: z.literal(MODEL.voice) }).strict(),
    pricingVersion: z.literal(PRICING.checked), promptVersions: z.record(z.string(), z.string().regex(/^klinikaflow-[a-z-]+@[12]$/)),
  }).strict(),
  reservations: z.array(reservationSchema),
}).strict();
export type EvidenceSnapshot = z.infer<typeof EvidenceSnapshotSchema>;

function safeText(raw: string | null) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw), usage = value.usage;
    const numberOrNull = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
    const countOrNull = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
    const parsed = textSchema.safeParse({
      model: value.model === MODEL.text ? value.model : "unknown",
      operation: operation.safeParse(value.operation).success ? value.operation : "other",
      promptVersion: /^klinikaflow-[a-z-]+@[12]$/.test(value.promptVersion) ? value.promptVersion : "unknown",
      profile: ["legacy", "efficient"].includes(value.profile) ? value.profile : "unknown",
      status: ["started", "completed", "incomplete", "refused", "invalid-output", "invalid-usage", "network-error", "http-error"].includes(value.status) ? value.status : "unknown",
      latencyMs: numberOrNull(value.latencyMs), pricingVersion: /^\d{4}-\d{2}-\d{2}$/.test(value.pricingVersion) ? value.pricingVersion : "unknown",
      inputTokens: countOrNull(usage?.inputTokens), cachedTokens: countOrNull(usage?.cachedTokens), outputTokens: countOrNull(usage?.outputTokens),
      costBasis: usage?.valid && ["measured-tokens", "cache-unknown-estimate"].includes(usage?.costBasis) ? usage.costBasis : "unknown",
      costUsd: usage?.valid ? numberOrNull(usage.costUsd) : null,
    });
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

export function snapshotEvidence(databasePath: string, encounterId: string): EvidenceSnapshot {
  id.parse(encounterId);
  const path = realpathSync(databasePath), stat = statSync(path);
  const databaseIdentity = createHash("sha256").update(`${path}:${stat.dev}:${stat.ino}`).digest("hex");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; BEGIN");
    const schemaVersion = Number(db.prepare("PRAGMA user_version").get()?.user_version);
    if (schemaVersion !== 5 && schemaVersion !== 6) throw new Error("Evidence requires an existing schema-v5/v6 database; run the application migration separately.");
    const row = db.prepare("SELECT e.version,w.user_id FROM encounters e JOIN workspaces w ON w.id=e.owner WHERE e.id=?").get(encounterId);
    if (!row?.user_id) throw new Error("Select an existing account-owned encounter; Saved Demo and unclaimed legacy encounters are excluded.");
    const profile = process.env.META_REQUEST_PROFILE ?? "legacy";
    if (profile !== "legacy" && profile !== "efficient") throw new Error("Invalid request profile.");
    const rows = db.prepare("SELECT r.id,r.purpose,r.created,r.reserved,r.actual,t.metadata FROM reservations r LEFT JOIN text_calls t ON t.reservation=r.id WHERE r.user_id=? ORDER BY r.created,r.id").all(row.user_id);
    const snapshot = EvidenceSnapshotSchema.parse({
      format: "klinikaflow-acceptance-snapshot@1", at: new Date().toISOString(), databaseIdentity, schemaVersion,
      encounterId, encounterVersion: Number(row.version), accountId: row.user_id,
      configuration: { source: "CLI environment; server configuration must be confirmed separately", profile, models: MODEL, pricingVersion: PRICING.checked,
        promptVersions: Object.fromEntries(Object.entries(OPERATION_VERSIONS).map(([op, version]) => [op, version.replace(/@1$/, profile === "efficient" ? "@2" : "@1")])) },
      reservations: rows.map(r => ({ id: r.id, operation: operation.safeParse(r.purpose).success ? r.purpose : "other", created: Number(r.created), estimatedUsd: Number(r.reserved), calculatedUsd: r.actual === null ? null : Number(r.actual), text: safeText(r.metadata as string | null) })),
    });
    db.exec("COMMIT");
    return snapshot;
  } finally { db.close(); }
}

export function compareEvidence(beforeInput: unknown, afterInput: unknown, activity: "exclusive" | "concurrent" | "unknown" = "unknown") {
  const before = EvidenceSnapshotSchema.parse(beforeInput), after = EvidenceSnapshotSchema.parse(afterInput);
  if (before.schemaVersion !== after.schemaVersion) throw new Error("Start a new snapshot pair after a schema migration.");
  for (const key of ["databaseIdentity", "accountId", "encounterId"] as const) if (before[key] !== after[key]) throw new Error("Snapshots must describe the same database, account and encounter.");
  if (Date.parse(after.at) < Date.parse(before.at) || after.encounterVersion < before.encounterVersion) throw new Error("Snapshots are out of order.");
  const old = new Map(before.reservations.map(r => [r.id, r]));
  const current = new Map(after.reservations.map(r => [r.id, r]));
  if (old.size !== before.reservations.length || current.size !== after.reservations.length) throw new Error("Duplicate reservation IDs.");
  if (before.reservations.some(r => !current.has(r.id))) throw new Error("Historical reservations disappeared; comparison is invalid.");
  const changedExistingReservationIds = before.reservations.filter(r => JSON.stringify(r) !== JSON.stringify(current.get(r.id))).map(r => r.id);
  const added = after.reservations.filter(r => !old.has(r.id));
  const groups = [...new Set(added.map(r => r.operation))].map(op => {
    const calls = added.filter(r => r.operation === op);
    return { operation: op, attempts: calls.length, completedTextCalls: calls.filter(r => r.text?.status === "completed").length,
      measuredTextLatenciesMs: calls.flatMap(r => r.text?.status !== "started" && r.text?.latencyMs != null ? [r.text.latencyMs] : []),
      estimatedReservedUsd: calls.reduce((sum, r) => sum + r.estimatedUsd, 0),
      calculatedTextUsd: calls.reduce((sum, r) => sum + (r.text?.costBasis === "measured-tokens" ? r.text.costUsd ?? 0 : 0), 0),
      cacheUnknownTextEstimateUsd: calls.reduce((sum, r) => sum + (r.text?.costBasis === "cache-unknown-estimate" ? r.text.costUsd ?? 0 : 0), 0),
      recordedCalculatedUsd: calls.reduce((sum, r) => sum + (r.calculatedUsd ?? 0), 0),
      unknownChargeAttempts: calls.filter(r => r.calculatedUsd === null).length,
      voiceAttemptsWithoutBilledUsage: calls.filter(r => r.operation === "transcription").length,
    };
  });
  const inconclusive = activity !== "exclusive" || changedExistingReservationIds.length > 0 || before.reservations.some(r => r.text?.status === "started") || added.some(r => r.text?.status === "started");
  return { format: "klinikaflow-acceptance-comparison@1", before: before.at, after: after.at,
    encounterId: after.encounterId, encounterVersions: [before.encounterVersion, after.encounterVersion],
    activity, attribution: inconclusive ? "inconclusive" : "account interval; operator attests exclusive activity",
    newReservationIds: added.map(r => r.id), attempts: added.length, changedExistingReservationIds, groups,
    notes: ["Account interval evidence, not provider invoice reconciliation or automatic encounter attribution.", "Reserved estimates, calculated costs and cache-unknown estimates overlap; do not add them together.", "Voice failures/latency and stopwatch timings require the manual observation record.", "CLI configuration is not proof of the running server configuration."] };
}
