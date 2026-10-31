import { z } from "zod";

export const FactSchema = z.object({
  kind: z.enum(["medication", "warning", "followup", "advice", "negation"]),
  medicine: z.string().max(100), dose: z.string().max(100), quantity: z.string().max(100),
  frequency: z.string().max(100), duration: z.string().max(100), timing: z.string().max(100),
  condition: z.string().max(240), urgency: z.enum(["immediate", "scheduled", "none"]),
  delayDays: z.number().int().min(0).max(365).nullable(),
  date: z.string().max(100), action: z.string().max(240), negated: z.boolean(),
}).strict();
export type Fact = z.infer<typeof FactSchema>;
export const TurnSchema = z.object({
  id: z.string().min(1).max(40), speaker: z.enum(["clinician", "patient", "unknown"]),
  providerSpeaker: z.string().min(1).max(40).optional(), roleOverride: z.boolean().optional(),
  documentSource: z.object({ documentId: z.string().max(40), lineId: z.string().max(40), page: z.number().int().positive() }).strict().optional(),
  text: z.string().min(1).max(3000), startMs: z.number().min(0), endMs: z.number().min(0),
}).strict();
export type Turn = z.infer<typeof TurnSchema>;
export const ClaimSchema = z.object({ id: z.string().min(1).max(40), sourceTurnIds: z.array(z.string()).min(1).max(10), fact: FactSchema }).strict();
export type Claim = z.infer<typeof ClaimSchema>;
export const LineSchema = z.object({ id: z.string().min(1).max(40), sourceClaimIds: z.array(z.string()).min(1).max(10), fact: FactSchema, text: z.string().min(1).max(1500) }).strict();
export type SheetLine = z.infer<typeof LineSchema>;
export const NoteSchema = z.object({ claims: z.array(ClaimSchema).min(1).max(40) }).strict();
export const SheetSchema = z.object({ lines: z.array(LineSchema).min(1).max(40) }).strict();
export type Check = { id: string; severity: "error" | "review"; message: string; target: string };
export type Approval = { fingerprint: string; reviewer: string; at: string };
export const ReviewFindingSchema = z.object({
  category: z.enum(["medication", "negation", "warning", "followup", "omission", "other"]),
  sourceIds: z.array(z.string()).min(1).max(10), targetId: z.string(),
  sourceQuote: z.string().min(1).max(400), targetQuote: z.string().max(400),
  explanation: z.string().min(1).max(500),
}).strict();
export const ReviewResultSchema = z.object({ findings: z.array(ReviewFindingSchema).max(40) }).strict();
export type ReviewFinding = z.infer<typeof ReviewFindingSchema> & { id: string; dismissal?: { reviewer: string; reason: string; at: string } };
export type AiReview = { status: "saved" | "live" | "manual"; fingerprint: string; findings: ReviewFinding[]; model: string; promptVersion: string; latencyMs: number | null; costUsd: number | null; costBasis?: "measured-tokens" | "cache-unknown-estimate" | "unknown"; reviewer?: string; reason?: string };
export const TeachBackResultSchema = z.object({ findings: z.array(z.object({
  category: z.enum(["missing", "changed", "unclear"]), sourceLineIds: z.array(z.string()).min(1).max(10),
  expectedQuote: z.string().min(1).max(400), responseQuote: z.string().max(400), explanation: z.string().min(1).max(500),
}).strict()).max(20) }).strict();
export type TeachBackFinding = z.infer<typeof TeachBackResultSchema>["findings"][number];
export type RuleCheck = { parserVersion: string; findings: TeachBackFinding[]; sheetFingerprint: string };
export type Respondent = "patient" | "companion";
export type TeachBackAnalysis = { status: "saved" | "live" | "manual"; transcript: string; findings: z.infer<typeof TeachBackResultSchema>["findings"]; model: string; promptVersion: string; latencyMs: number | null; costUsd: number | null; costBasis?: "measured-tokens" | "cache-unknown-estimate" | "unknown"; sheetFingerprint: string; reason?: string; reviewer?: string };
export type TeachBackOutcome = "pending" | "understood" | "reexplained" | "not-understood";
export type TeachBackAttempt = { id: string; sheetFingerprint: string; createdAt: string | null; audioAvailable: boolean; rawTranscript: string | null; correctedTranscript: string | null; transcription: { model: string; latencyMs: number; costUsd: number; costBasis?: "measured-tokens" | "cache-unknown-estimate" | "unknown" } | null; analysis: TeachBackAnalysis | null; outcome: TeachBackOutcome; reviewer: string | null; decidedAt: string | null; ruleCheck?: RuleCheck | null; overrideReason?: string | null; respondent?: Respondent };
export type TeachBack = { id: string; question: string; expected: string; outcome: TeachBackOutcome; sheetFingerprint: string; audioAvailable?: boolean; transcript?: string; transcriptSource?: "live" | "human-corrected"; transcription?: { model: string; latencyMs: number; costUsd: number; costBasis?: "measured-tokens" | "cache-unknown-estimate" | "unknown" }; analysis?: TeachBackAnalysis | null; attempts?: TeachBackAttempt[]; activeAttemptId?: string; requiredRespondent?: Respondent };
export type SpeakerMapping = { recordingFingerprint: string; roles: Record<string, "clinician" | "patient" | "unknown">; reviewer: string; confirmedAt: string };
export type PrintException = { reviewer: string; reason: string; at: string; sheetFingerprint: string; attemptFingerprint: string; unresolvedQuestionIds: string[] };
export type TranscriptConfirmation = { fingerprint: string; reviewer: string; at: string; recordingFingerprint: string | null };
export type PreparationProgress = { completed: { action: string; requestKey: string; fingerprint: string; at: string }[] };
export type NoteCorrectionProposal = { id: string; findingId: string; claimId: string; sourceFingerprint: string; before: Claim; after: Claim; sourceQuote: string; explanation: string; model: string; promptVersion: string; latencyMs: number; costUsd: number; costBasis?: "measured-tokens" | "cache-unknown-estimate" | "unknown"; status: "pending" | "accepted" | "rejected"; reviewer?: string; decisionReason?: string; decidedAt?: string };
export type PlanQuestion = { id: string; kind: "typed" | "spoken"; question: string; rawTranscript?: string; sheetFingerprint: string; lineIds: string[]; answerLines: { id: string; text: string }[]; needsReviewer: boolean; model: string; promptVersion: string; latencyMs: number | null; costUsd: number | null; costBasis?: "measured-tokens" | "cache-unknown-estimate" | "unknown"; askedAt: string; audioAvailable?: boolean };
export type SpokenQuestionDraft = { id: string; sheetFingerprint: string; createdAt: string; rawTranscript: string | null; correctedTranscript: string | null; transcription: { model: string; latencyMs: number; costUsd: number; costBasis?: "measured-tokens" | "cache-unknown-estimate" | "unknown" } | null; confirmedBy: string | null; confirmedAt: string | null; confirmedFingerprint: string | null; answered: boolean };
export const DocumentLineSchema = z.object({ id: z.string().min(1).max(40), page: z.number().int().min(1).max(100), text: z.string().trim().min(1).max(3000) }).strict();
export const DocumentExtractionSchema = z.object({ lines: z.array(DocumentLineSchema).min(1).max(40) }).strict();
export const DocumentDecisionSchema = z.object({ lineId: z.string().max(40), text: z.string().trim().min(1).max(3000), speaker: z.enum(["clinician", "patient"]), confirmed: z.literal(true) }).strict();
export type SourceDocument = { id: string; name: string; mime: string; hash: string; createdAt: string; fixtureText?: string; extraction: { lines: z.infer<typeof DocumentLineSchema>[]; model: string; promptVersion: string; latencyMs: number; costUsd: number; costBasis?: "measured-tokens" | "cache-unknown-estimate" | "unknown" } | null; accepted: { reviewer: string; at: string; decisions: z.infer<typeof DocumentDecisionSchema>[] } | null };
export type IllustrationAttachment = { lineId: string; illustrationId: string; libraryVersion: string; lineFingerprint: string; reviewer: string; at: string };
export type Audit = { actorId?: string; at: string; action: string; version: number };
export type ConsultationTranscription = {
  transcript: string; turns: Turn[]; providerLabels: string[];
  recordingFingerprint: string | null; model: string; requestKey: string;
  at: string; latencyMs: number; estimatedCostUsd: number;
};
export type Encounter = {
  id: string; caseId: string; title: string; version: number; createdAt: string;
  consent: boolean; synthetic: true; mode: "saved" | "live"; turns: Turn[]; claims: Claim[]; lines: SheetLine[];
  checks: Check[]; checkedFingerprint: string | null; noteApproval: Approval | null; sheetApproval: Approval | null; noteReview?: AiReview | null; sheetReview?: AiReview | null;
  teachBack: TeachBack[]; teachBackArchive?: TeachBack[]; teachBackSkip: string; audit: Audit[]; audioAvailable: boolean;
  recordingFingerprint?: string | null; speakerMapping?: SpeakerMapping | null;
  consultationTranscriptions?: ConsultationTranscription[];
  printException?: PrintException | null;
  companion?: { present: boolean; relation: string } | null;
  transcriptConfirmation?: TranscriptConfirmation | null; preparation?: PreparationProgress;
  documents?: SourceDocument[];
  illustrations?: IllustrationAttachment[];
  noteProposals?: NoteCorrectionProposal[];
  planQuestions?: PlanQuestion[];
  spokenQuestionDrafts?: SpokenQuestionDraft[]; activeSpokenQuestionId?: string | null;
  provenance: { transcript: string; note: string; sheet: string }; audioReviewed: string[];
  sheetMode: "template" | "model"; lastError: string | null;
};
export type Case = { id: string; title: string; subtitle: string; patient: string; turns: Turn[]; claims: Claim[]; companion?: { relation: string; answers: string[] }; plantedAnswers?: Record<string, { transcript: string; respondent: Respondent }> };
export const emptyFact: Fact = { kind: "advice", medicine: "", dose: "", quantity: "", frequency: "", duration: "", timing: "", condition: "", urgency: "none", delayDays: null, date: "", action: "", negated: false };
