import { z } from "zod";

export const AgentModeSchema = z.enum(["teach_back", "source_review"]);
export type AgentMode = z.infer<typeof AgentModeSchema>;
export const TOOL_LABELS = {
  compare_answer: "Compare current answer", approved_lines: "Retrieve exact approved lines",
  prior_attempts: "Inspect prior attempts", repeat_answer: "Request another answer",
  reviewer_help: "Pause for reviewer", note_sources: "Retrieve cited source evidence",
  compare_note: "Compare note with source", propose_correction: "Propose a supported correction",
} as const;
export const AgentPlanSchema = z.object({
  tool: z.enum(["compare_answer", "approved_lines", "prior_attempts", "repeat_answer", "reviewer_help", "note_sources", "compare_note", "propose_correction"]),
  targetId: z.string().max(100), sourceIds: z.array(z.string().min(1).max(100)).max(10),
  reason: z.enum(["comparison_needed", "inspect_evidence", "changed_or_missing", "review_history", "repeat_needed", "human_review", "source_unclear", "supported_correction"]),
}).strict();
export type AgentPlan = z.infer<typeof AgentPlanSchema>;
export type AgentTool = AgentPlan["tool"];
export type AgentCapability = { tool: AgentTool; targetId: string; sourceIds: string[]; paid: boolean };
export type AgentEvidence = { id: string; label: string; text: string };
export type AgentStatus = "ready" | "awaiting_tool" | "executing" | "paused" | "completed" | "stopped" | "failed" | "stale";
export type AgentEvent = {
  id: string; kind: string; status: "running" | "done" | "failed" | "stale";
  at: string; plan?: AgentPlan; evidence?: AgentEvidence[]; notice?: string;
  reservationIds: string[]; latencyMs?: number; fixture: boolean;
  measurements?: { reservationId: string; estimatedUsd: number; calculatedUsd: number | null; undiscountedEstimateUsd: number | null; basis: string; status: string; latencyMs: number | null }[];
};
export type AgentRun = {
  id: string; mode: AgentMode; status: AgentStatus; revision: number; sourceFingerprint: string;
  questionId: string | null; attemptId: string | null; parentId: string | null;
  decisions: number; executions: number; paidAttempts: number; createdAt: string;
  pendingStepId: string | null; fixture: boolean; events: AgentEvent[];
  superseded?: boolean; checkpoint?: string;
};
export type ReviewerHandoff = {
  version: number; noteApproved: boolean; sheetApproved: boolean;
  reviews: { stage: string; status: string; current: boolean; reviewer: string | null; at: string | null }[];
  instructions: { id: string; text: string; approved: boolean; sourceIds: string[] }[];
  unresolved: { id: string; stage: string; text: string }[];
  answers: { id: string; question: string; current: boolean; outcome: string; attempts: { id: string; outcome: string; reviewer: string | null; at: string | null; analysis: string; current: boolean }[] }[];
  nextCheckpoints: string[]; exception: { current: boolean; reviewer: string; reason: string } | null;
  comprehension: { lineId: string; status: string; label: string; required: string | null; respondent: string | null }[];
};
export type AgentView = {
  runs: AgentRun[]; handoff: ReviewerHandoff;
  capabilities: { enabled: boolean; fixture: boolean; correctionEnabled: boolean };
};
export const AgentCommandSchema = z.object({
  command: z.enum(["start", "plan", "execute", "stop", "resume", "fixture"]),
  expectedVersion: z.number().int().positive(), runId: z.string().uuid().optional(),
  expectedRevision: z.number().int().positive().optional(), stepId: z.string().uuid().optional(),
  mode: AgentModeSchema.optional(), questionId: z.string().min(1).max(40).optional(),
  confirmedPaid: z.boolean().optional(), fixtureFailure: z.boolean().optional(),
  scenario: z.enum(["unclear_answer", "unsupported_claim"]).optional(),
}).strict();
export type AgentCommand = z.infer<typeof AgentCommandSchema>;
