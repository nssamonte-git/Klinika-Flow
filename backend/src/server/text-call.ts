import "server-only";
import { z } from "zod";
import { fingerprint, WorkflowError } from "../domain/workflow";
import { MODEL, PRICING } from "../domain/model-ids";
import { parseTextUsage, type TextCallRecord } from "../domain/text-usage";
import { recordEstimatedCost, recordTextCall } from "./db";
import { operationVersion } from "../domain/prompt-versions";
export { operationVersion } from "../domain/prompt-versions";
export class TextRequestError extends WorkflowError { constructor(message: string, status: number, public readonly measurement: TextCallRecord) { super(message, status); } }
export type Attachment = { data: Buffer; mime: string; name: string };
export type RequestProfile = "legacy" | "efficient";
export function requestProfile(): RequestProfile { const value = process.env.META_REQUEST_PROFILE ?? "legacy"; if (value !== "legacy" && value !== "efficient") throw new WorkflowError("Invalid Meta request profile.", 500); return value; }
export function promptVersionFor(operation: string, profile = requestProfile()) { return operationVersion(operation).replace(/@1$/, profile === "efficient" ? "@2" : "@1"); }
function freeze(value: object): object { for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child); return Object.freeze(value); }
export function stableSerialize(value: unknown): string {
  const ordered = (v: any): any => Array.isArray(v) ? v.map(ordered) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(key => [key, ordered(v[key])])) : v;
  return JSON.stringify(ordered(value));
}
function efficientParts(operation: string, content: unknown): string[] {
  const data = { ...(content as Record<string, unknown>) };
  if (operation === "note" && Array.isArray(data.turns)) data.turns = data.turns.map(({ id, speaker, text }) => ({ id, speaker, text }));
  const priority = ["task", ...(operation === "plan_question" ? ["approvedLines"] : operation === "teach_back_analysis" ? ["expected", "question"] : [])];
  const keys = [...priority.filter(key => data[key] !== undefined), ...Object.keys(data).filter(key => !priority.includes(key)).sort()];
  const ordered = Object.fromEntries(keys.map(key => [key, JSON.parse(stableSerialize(data[key]))]));
  return [JSON.stringify({ untrusted_data: ordered })];
}
const schemas = new WeakMap<z.ZodType, object>();
export function responseSchema(schema: z.ZodType) { let value = schemas.get(schema); if (!value) { value = freeze(z.toJSONSchema(schema, { target: "draft-7" })); schemas.set(schema, value); } return value; }
export function buildTextRequest(schema: z.ZodType, operation: string, content: unknown, system: string, attachment?: Attachment, profile: RequestProfile = requestProfile()) {
  const user = JSON.stringify({ untrusted_data: content });
  if (Buffer.byteLength(user) > 50_000) throw new WorkflowError("This synthetic encounter is too large.", 400);
  const jsonSchema = responseSchema(schema), maxTokens = 4096;
  const legacyBody = { model: MODEL.text, max_tokens: maxTokens, temperature: 0, messages: [{ role: "developer", content: system }, { role: "user", content: attachment ? [{ type: "text", text: user }, ...(attachment.mime === "application/pdf" ? [{ type: "file", file: { filename: "synthetic.pdf", file_data: `data:${attachment.mime};base64,${attachment.data.toString("base64")}` } }] : [{ type: "image_url", image_url: { url: `data:${attachment.mime};base64,${attachment.data.toString("base64")}` } }])] : user }], response_format: { type: "json_schema", json_schema: { name: operation, strict: true, schema: jsonSchema } } };
  const version = promptVersionFor(operation, profile);
  const cacheKey = profile === "efficient" ? `klinikaflow:${operation}:${version}` : null;
  const retention = profile === "efficient" ? process.env.META_PROMPT_CACHE_RETENTION ?? "in_memory" : null;
  if (retention !== null && !["in_memory", "24h"].includes(retention)) throw new WorkflowError("Invalid Meta cache retention hint.", 500);
  const parts = efficientParts(operation, content);
  if (profile === "efficient" && Buffer.byteLength(parts.join("")) > 50_000) throw new WorkflowError("This synthetic encounter is too large.", 400);
  const input = [{ role: "user", content: [...parts.map(text => ({ type: "input_text", text })), ...(attachment ? attachment.mime === "application/pdf" ? [{ type: "input_file", filename: "synthetic.pdf", file_data: `data:${attachment.mime};base64,${attachment.data.toString("base64")}` }] : [{ type: "input_image", image_url: `data:${attachment.mime};base64,${attachment.data.toString("base64")}` }] : [])] }];
  const body = profile === "efficient" ? { model: MODEL.text, instructions: system, input, max_output_tokens: maxTokens, temperature: 0, store: false, prompt_cache_key: cacheKey, prompt_cache_retention: retention, text: { format: { type: "json_schema", name: operation, strict: true, schema: jsonSchema } } } : legacyBody;
  return { body, endpoint: `https://api.meta.ai/v1/${profile === "efficient" ? "responses" : "chat/completions"}`, profile, promptVersion: version, cacheKey, retention, textBytes: Buffer.byteLength(system + (profile === "efficient" ? parts.join("") : user) + JSON.stringify(jsonSchema)), prefixHash: fingerprint({ system, jsonSchema, ...(profile === "efficient" && (content as any)?.task ? { task: (content as any).task } : {}) }), maxTokens };
}
export async function callText<T>(schema: z.ZodType<T>, operation: string, content: unknown, system: string, attachment?: Attachment, profile: RequestProfile = requestProfile()) {
  const apiKey = process.env.MODEL_API_KEY;
  if (!apiKey) throw new WorkflowError("Meta API key is not configured on the server. Saved mode is available.", 503);
  const request = buildTextRequest(schema, operation, content, system, attachment, profile);
  const bound = request.textBytes * 2 + 8192 + (attachment?.data.length ?? 0) * 2;
  const reserved = (bound * PRICING.inputPerMillion + request.maxTokens * PRICING.outputPerMillion) / 1e6;
  const reservation = recordEstimatedCost(operation, reserved), started = Date.now();
  const metadata: TextCallRecord = { model: MODEL.text, endpoint: request.endpoint, operation, promptVersion: request.promptVersion, cacheKey: request.cacheKey, profile: request.profile, retention: request.retention, prefixHash: request.prefixHash, requestHash: fingerprint(request.body), textBytes: request.textBytes, attachmentBytes: attachment?.data.length ?? 0, pricingVersion: PRICING.checked, status: "started", latencyMs: 0 };
  const save = () => { metadata.latencyMs = Date.now() - started; recordTextCall(reservation, metadata); };
  save();
  let response: Response;
  try { response = await fetch(request.endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(60_000), body: JSON.stringify(request.body) }); }
  catch { metadata.status = "network-error"; save(); throw new TextRequestError("The model call timed out or the network failed. Your work is saved. Retry explicitly or use saved mode.", 503, metadata); }
  metadata.httpStatus = response.status;
  if (!response.ok) { metadata.status = "http-error"; save(); throw new TextRequestError(response.status === 429 ? "Meta quota reached. Your work is saved; use the saved demonstration or retry later." : "Meta could not complete this request. Your work is saved.", response.status === 429 ? 429 : 502, metadata); }
  try {
    const result = await response.json();
    metadata.usage = parseTextUsage(result.usage, request.profile === "efficient");
    if (!metadata.usage.valid) { metadata.status = "invalid-usage"; save(); throw new Error("Invalid usage"); }
    save();
    let output: string;
    if (request.profile === "efficient") {
      const parts = Array.isArray(result.output) ? result.output.filter((item: any) => item.type === "message").flatMap((item: any) => Array.isArray(item.content) ? item.content : []) : [];
      if (parts.some((item: any) => item.type === "refusal")) { metadata.status = "refused"; throw new Error("Refused"); }
      if (result.status !== "completed") { metadata.status = "incomplete"; throw new Error("Incomplete"); }
      output = parts.filter((item: any) => item.type === "output_text" && typeof item.text === "string").map((item: any) => item.text).join("");
    } else {
      if (result.choices?.[0]?.message?.refusal) { metadata.status = "refused"; throw new Error("Refused"); }
      if (result.choices?.[0]?.finish_reason && result.choices[0].finish_reason !== "stop") { metadata.status = "incomplete"; throw new Error("Incomplete"); }
      output = result.choices?.[0]?.message?.content;
    }
    const data = schema.parse(JSON.parse(output));
    metadata.status = "completed"; save();
    return { data, latencyMs: metadata.latencyMs, costUsd: metadata.usage.costUsd!, costBasis: metadata.usage.costBasis, promptVersion: request.promptVersion, usage: metadata.usage };
  } catch {
    if (metadata.status === "started") metadata.status = "invalid-output";
    save(); throw new TextRequestError("The model returned an invalid structure or incomplete result. The result was not applied; your work is saved.", 502, metadata);
  }
}
