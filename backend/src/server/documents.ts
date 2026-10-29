import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { WorkflowError } from "../domain/workflow";
import { beginJob, endJob, loadEncounter, saveSourceDocument, workspaceOwner } from "./db";
import { requireStudio } from "./auth-core";
export const DOCUMENT_LIMIT = 8_000_000;
export function validateDocument(data: Buffer, mime: string) {
  if (!data.length || data.length > DOCUMENT_LIMIT) throw new WorkflowError("Choose a PNG, JPEG or PDF up to 8 MB.", 400);
  const valid = mime === "image/png" ? data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : mime === "image/jpeg" ? data[0] === 255 && data[1] === 216 && data[2] === 255 : mime === "application/pdf" ? data.subarray(0, 5).toString() === "%PDF-" : false;
  if (!valid) throw new WorkflowError("File content must match PNG, JPEG or PDF. Other formats are not supported.", 400);
}
export async function uploadDocument(owner: { id: string; role: string }, id: string, version: number, key: string, name: string, mime: string, data: Buffer) {
  requireStudio(owner);
  if (process.env.ENABLE_DOCUMENT_IMPORT !== "true") throw new WorkflowError("Document import is disabled.", 403);
  validateDocument(data, mime);
  if (!/^[a-zA-Z0-9-]{8,100}$/.test(key)) throw new WorkflowError("A valid upload request key is required.", 400);
  owner = { ...owner, id: workspaceOwner(owner.id, id) };
  const previous = loadEncounter(owner.id, id), hash = createHash("sha256").update(data).digest("hex");
  const job = beginJob(owner.id, key, JSON.stringify({ action: "document-upload", id, version, hash, mime, name }));
  if (job.cached) return previous.version > job.cached.version ? previous : job.cached;
  try {
    if (previous.version !== version) throw new WorkflowError("Reload before uploading the document.");
    if (!previous.consent) throw new WorkflowError("Confirm synthetic-data permission first.");
    if ((previous.documents?.length ?? 0) >= 6) throw new WorkflowError("This encounter already has six source documents.");
    const e = structuredClone(previous), documentId = randomUUID();
    e.documents ??= []; e.documents.push({ id: documentId, hash, name: name.replace(/[^a-zA-Z0-9 ._-]/g, "_").slice(0, 100) || "Synthetic document", mime, createdAt: new Date().toISOString(), extraction: null, accepted: null });
    e.version++; e.audit.push({ action: "upload-document", at: new Date().toISOString(), version: e.version });
    saveSourceDocument(owner.id, previous.version, e, documentId, mime, data); endJob(job.id, e); return e;
  } catch (error) { endJob(job.id); throw error; }
}
