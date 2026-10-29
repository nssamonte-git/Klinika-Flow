import "server-only";
import { MODEL } from "../domain/model-ids";
export async function verifyMetaAccess(env: Record<string, string | undefined> = process.env, send: typeof fetch = fetch) {
  const key = env.MODEL_API_KEY?.trim();
  const report = { at: new Date().toISOString(), keyConfigured: Boolean(key), studioConfigured: env.ALLOW_LIVE_MODE === "true", requestProfile: env.META_REQUEST_PROFILE ?? "legacy", status: "configuration-missing", httpStatus: null as number | null, latencyMs: 0, models: [MODEL.text, MODEL.voice].map(id => ({ id, listed: null as boolean | null })), inferenceCalls: 0, inferenceVerified: false, note: "Catalogue listing confirms only authenticated catalogue visibility. Successful inference and clinical/language quality remain unverified." };
  if (!key) return report;
  if (["SAMPLE_KEY_NOT_VALID", "DEMO_ONLY_NOT_A_REAL_META_API_KEY"].includes(key)) { report.status = "placeholder-key"; return report; }
  const started = Date.now();
  try {
    const response = await send("https://api.meta.ai/v1/models", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) });
    report.httpStatus = response.status;
    if (!response.ok) { report.status = response.status === 401 ? "authentication-rejected" : response.status === 403 ? "access-denied" : response.status === 429 ? "rate-limited" : "provider-error"; return report; }
    const data = await response.json();
    if (!Array.isArray(data?.data) || !data.data.every((item: unknown) => !!item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string")) { report.status = "invalid-catalogue-response"; return report; }
    const ids = new Set(data.data.map((item: { id: string }) => item.id));
    report.models = report.models.map(model => ({ id: model.id, listed: ids.has(model.id) }));
    report.status = report.models.every(model => model.listed) ? "catalogue-confirmed" : "model-not-listed";
    return report;
  } catch { report.status = "network-or-response-error"; return report; }
  finally { report.latencyMs = Date.now() - started; }
}
