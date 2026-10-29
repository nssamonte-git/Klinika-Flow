import { PRICING } from "./model-ids";
export type TextUsage = { inputTokens: number | null; cachedTokens: number | null; outputTokens: number | null; uncachedTokens: number | null; costUsd: number | null; costBasis: "measured-tokens" | "cache-unknown-estimate" | "unknown"; valid: boolean };
const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
export function parseTextUsage(value: unknown, responses: boolean): TextUsage {
  const usage = value as Record<string, any> | null;
  const input = usage?.[responses ? "input_tokens" : "prompt_tokens"], output = usage?.[responses ? "output_tokens" : "completion_tokens"];
  const cached = usage?.[responses ? "input_tokens_details" : "prompt_tokens_details"]?.cached_tokens;
  const valid = count(input) && count(output) && (cached === undefined || (count(cached) && cached <= input));
  const inputTokens = count(input) ? input : null, outputTokens = count(output) ? output : null;
  const cachedTokens = count(cached) && inputTokens !== null && cached <= inputTokens ? cached : null;
  const uncachedTokens = inputTokens !== null && cachedTokens !== null ? inputTokens - cachedTokens : null;
  const costBasis = !valid ? "unknown" : cachedTokens === null ? "cache-unknown-estimate" : "measured-tokens";
  const costUsd = !valid ? null : ((uncachedTokens ?? inputTokens!) * PRICING.inputPerMillion + (cachedTokens ?? 0) * PRICING.cachedInputPerMillion + outputTokens! * PRICING.outputPerMillion) / 1e6;
  return { inputTokens, cachedTokens, outputTokens, uncachedTokens, costUsd, costBasis, valid };
}
export type TextCallRecord = { model: string; endpoint: string; operation: string; promptVersion: string; cacheKey: string | null; profile: string; retention: string | null; prefixHash: string; requestHash: string; textBytes: number; attachmentBytes: number; pricingVersion: string; status: "started" | "completed" | "incomplete" | "refused" | "invalid-output" | "invalid-usage" | "network-error" | "http-error"; latencyMs: number; httpStatus?: number; usage?: TextUsage };
export type TextUsageAggregate = { calls: number; completedCalls: number; inputTokens: number; cachedTokens: number; uncachedTokens: number; outputTokens: number; cacheRatio: number | null; cacheMeasuredCalls: number; cacheUnknownCalls: number; coverage: number | null; undiscountedEstimateUsd: number };
export type TextUsageSummary = TextUsageAggregate & { historicalOrNonTextRecords: number; groups: (TextUsageAggregate & { operation: string; promptVersion: string; profile: string; endpoint: string; cacheKey: string | null })[] };
export function tokenCostLabel(cost: number | null | undefined, basis?: string) { return cost === null || cost === undefined ? "Cost unknown" : `$${cost.toFixed(5)} · ${basis === "measured-tokens" ? "calculated from reported tokens" : basis === "cache-unknown-estimate" ? "undiscounted estimate; cache unknown" : "historical/saved cost basis"}`; }
