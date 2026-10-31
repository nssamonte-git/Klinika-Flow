import "server-only";
import { db, workspaceOwner } from "./db-core";
import type { AgentEvent, AgentRun } from "../domain/agent-contract";
import type { Encounter } from "../domain/schema";
import { agentFingerprint } from "../domain/agent-policy";
import { WorkflowError } from "../domain/workflow";

export const ACTIVE_AGENT_STATUSES = new Set(["ready", "awaiting_tool", "executing", "paused"]);
export function agentTransaction<T>(task: () => T): T {
  db().exec("BEGIN IMMEDIATE");
  try { const result = task(); db().exec("COMMIT"); return result; }
  catch (error) { db().exec("ROLLBACK"); throw error; }
}
export function storeAgentRun(run: AgentRun, owner: string, encounter: string) {
  const body = JSON.stringify({ ...run, events: [] });
  db().prepare("INSERT INTO agent_runs(id,encounter,owner,status,body,created) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body").run(run.id, encounter, owner, run.status, body, Date.parse(run.createdAt));
}
export function storeAgentEvent(event: AgentEvent) {
  db().prepare("UPDATE agent_events SET body=? WHERE id=?").run(JSON.stringify(event), event.id);
}
export function agentEvents(runId: string): AgentEvent[] {
  return db().prepare("SELECT body FROM agent_events WHERE run=? ORDER BY created,rowid").all(runId).map(row => {
    const event = JSON.parse(String(row.body)) as AgentEvent;
    event.measurements = event.reservationIds.map(id => {
      const r = db().prepare("SELECT r.reserved,r.actual,t.metadata FROM reservations r LEFT JOIN text_calls t ON t.reservation=r.id WHERE r.id=?").get(id);
      let metadata: any; try { metadata = JSON.parse(String(r?.metadata ?? "{}")); } catch { metadata = {}; }
      return { reservationId: id, estimatedUsd: Number(r?.reserved ?? 0), calculatedUsd: r?.actual == null ? null : Number(r.actual), undiscountedEstimateUsd: metadata.usage?.costBasis === "cache-unknown-estimate" && typeof metadata.usage.costUsd === "number" ? metadata.usage.costUsd : null, basis: ["measured-tokens", "cache-unknown-estimate"].includes(metadata.usage?.costBasis) ? metadata.usage.costBasis : "unknown", status: ["started", "completed", "incomplete", "refused", "invalid-output", "invalid-usage", "network-error", "http-error"].includes(metadata.status) ? metadata.status : "unknown", latencyMs: typeof metadata.latencyMs === "number" ? metadata.latencyMs : null };
    });
    return event;
  });
}
export function storedAgentRun(owner: string, encounter: string, id: string): AgentRun {
  const row = db().prepare("SELECT body FROM agent_runs WHERE id=? AND owner=? AND encounter=?").get(id, owner, encounter);
  if (!row) throw new WorkflowError("Agent run not found in this workspace.", 404);
  const run = JSON.parse(String(row.body)) as AgentRun;
  run.events = agentEvents(id); return run;
}
export function listAgentRuns(owner: string, e: Encounter): AgentRun[] {
  owner = workspaceOwner(owner, e.id);
  return db().prepare("SELECT id FROM agent_runs WHERE encounter=? AND owner=? ORDER BY created DESC,rowid DESC").all(e.id, owner).map(row => {
    const run = storedAgentRun(owner, e.id, String(row.id));
    run.superseded = run.sourceFingerprint !== agentFingerprint(e, run.mode, run.questionId);
    if (run.superseded && ACTIVE_AGENT_STATUSES.has(run.status)) run.status = "stale";
    return run;
  });
}
