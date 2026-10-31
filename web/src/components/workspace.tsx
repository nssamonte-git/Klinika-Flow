"use client";
import type { User } from "@backend/server/accounts";
import type { TextUsageSummary } from "@backend/domain/text-usage";
import TokenUsagePanel from "./token-usage-panel";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, AudioLines, Check, ChevronRight, CircleCheck, ClipboardCheck, FileHeart, FlaskConical, HeartPulse, Info, LoaderCircle, LockKeyhole, MessageCircle, Play, Printer, RefreshCw, ShieldCheck, TriangleAlert, X } from "lucide-react";
import type { Claim, Encounter, Fact, Turn } from "@backend/domain/schema";
import { renderEnglish, sectionLabel } from "@backend/domain/render";
import Recorder from "./recorder";
import AiReviewPanel from "./ai-review-panel";
import TeachBackVoice from "./teach-back-voice";
import AttemptHistory from "./attempt-history";
import PrintExceptionPanel from "./print-exception-panel";
import GuidedPreparation from "./guided-preparation";
import { workflowGuidance, resumeStep as workflowResumeStep } from "../lib/workflow-guidance";
import NoteCorrectionPanel from "./note-correction-panel";
import PlanQuestionPanel from "./plan-question-panel";
import IllustrationLibrary from "./illustration-library";
import InstructionIllustration from "./instruction-illustration";
import DocumentImport from "./document-import";
import LiveTranscript from "./live-transcript";
import AgentPanel from "./agent-panel";

type Envelope = { encounter: Encounter; view: { noteApproved: boolean; sheetApproved: boolean; exportReasons: string[] } };
type Session = { user: User | null; mode: "demo" | "account"; role: "judge" | "studio"; cases: { id: string; title: string; subtitle: string; patient: string }[]; encounters: { id: string; title: string }[]; modelUsage: { estimatedUsd: number; actualUsd: number; unknownCalls: number; text?: TextUsageSummary }; liveConfigured: boolean; studioEnabled: boolean; features?: { noteCorrections: boolean; planQuestions: boolean; spokenQuestions: boolean; streaming: boolean; documentImport: boolean } };
const steps = [{ title: "Consultation", subtitle: "Check the source", icon: AudioLines }, { title: "Review note", subtitle: "Review & approve", icon: ClipboardCheck }, { title: "Review instructions", subtitle: "Make it clear", icon: FileHeart }, { title: "Check understanding", subtitle: "Check understanding", icon: MessageCircle }];
async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...(init.body instanceof Blob ? {} : { "Content-Type": "application/json" }), ...init.headers } });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || "The request failed. Your saved work is preserved."); return result;
}
const actionLabels: Record<string, string> = {
  consent: "Saving synthetic-data permission", transcript: "Saving transcript edits", "generate-note": "Preparing the clinical note",
  "edit-note": "Saving note edits", checks: "Checking current instructions", "approve-note": "Approving the reviewed note",
  "generate-sheet": "Preparing Filipino instructions", "approve-sheet": "Approving the reviewed instructions", "teach-back": "Preparing teach-back questions",
  "record-teach-back": "Saving teach-back outcome", "run-note-review": "Comparing note with transcript", "run-sheet-review": "Comparing sheet with note",
  "dismiss-review": "Saving finding disposition", "manual-review": "Recording manual review", "plant-error": "Planting the demonstration error",
  "transcribe-teach-back": "Transcribing the actor’s answer", "edit-teach-back-transcript": "Saving answer correction",
  "analyze-teach-back": "Comparing the answer with the instructions", "manual-teach-back": "Recording manual answer analysis",
  "start-teach-back-attempt": "Starting another answer attempt", "map-speakers": "Confirming speaker roles",
  "record-print-exception": "Recording named print exception", "revoke-print-exception": "Revoking print exception",
  "confirm-transcript": "Confirming transcript and speaker roles",
  "propose-note-correction": "Requesting a note correction proposal", "accept-note-proposal": "Applying reviewed note correction", "reject-note-proposal": "Rejecting note proposal",
  "ask-plan-question": "Checking the approved plan for relevant wording",
  "transcribe-spoken-question": "Transcribing the actor's question", "edit-spoken-question-transcript": "Saving question correction", "confirm-spoken-question": "Confirming the spoken question", "ask-spoken-plan-question": "Checking the spoken question against approved lines",
};
const actionNotices: Record<string, string> = {
  consent: "Synthetic-data permission saved.", transcript: "Transcript saved. Dependent drafts and approvals were cleared.",
  "generate-note": "Note ready. Compare each instruction with its source, then approve.", "edit-note": "Note edits saved. Review the changed note again.",
  "approve-note": "Note approved. Continue to the instruction sheet.", "generate-sheet": "Instruction sheet ready. Review every line against its source.",
  "approve-sheet": "Instruction sheet approved. Continue to teach-back.", "record-teach-back": "Teach-back outcome saved.",
};
const outcomeLabel = { pending: "Outcome needed", understood: "Understood", reexplained: "Re-explained · ask again", "not-understood": "Needs another explanation" };
const resumeStep = (value: Envelope) => workflowResumeStep(value.encounter, value.view);
const time = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
export default function Workspace() {
  const [session, setSession] = useState<Session | null>(null), [data, setData] = useState<Envelope | null>(null), [step, setStep] = useState(0), [lab, setLab] = useState(false);
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState(""), [reviewer, setReviewer] = useState(""), [confirmed, setConfirmed] = useState(false);
  const [streaming, setStreaming] = useState(false), [agentBusy, setAgentBusy] = useState(false);
  const [recording, setRecording] = useState(false), [referenceEncounter, setReferenceEncounter] = useState<string | null>(null);
  const menuRef = useRef<HTMLDetailsElement | null>(null);
  const [dirtyAnswers, setDirtyAnswers] = useState<Record<string, boolean>>({});
  const answerDirty = Object.values(dirtyAnswers).some(Boolean);
  const [activeQuestion, setActiveQuestion] = useState<string | null>(null);
  const [speakerRoles, setSpeakerRoles] = useState<Record<string, Turn["speaker"]>>({}), [speakerConfirmed, setSpeakerConfirmed] = useState(false), [transcriptChecked, setTranscriptChecked] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]), [claims, setClaims] = useState<Claim[]>([]), [focusedTurn, setFocusedTurn] = useState("");
  const panelHeading = useRef<HTMLHeadingElement | null>(null), previousStep = useRef(0);
  const [navigationRequest, setNavigationRequest] = useState(0);
  const navigationTarget = useRef<string | null>(null);
  const busyRef = useRef(false);
  const audio = useRef<HTMLAudioElement | null>(null), stopAt = useRef(0), startup = useRef<Promise<{ session: Session; data: Envelope }> | null>(null);
  const uncertainRequest = useRef<{ signature: string; key: string } | null>(null);
  const e = data?.encounter;
  function receive(value: Envelope) { setSession(current => current ? { ...current, encounters: [{ id: value.encounter.id, title: value.encounter.title }, ...current.encounters.filter(item => item.id !== value.encounter.id)] } : current); setData(value); setTurns(structuredClone(value.encounter.turns)); setClaims(structuredClone(value.encounter.claims)); setConfirmed(false); setSpeakerConfirmed(false); setTranscriptChecked(false); setSpeakerRoles(value.encounter.speakerMapping?.roles ?? {}); setReviewer(current => current || value.encounter.sheetApproval?.reviewer || value.encounter.noteApproval?.reviewer || ""); }
  useEffect(() => {
    if (!startup.current) startup.current = (async () => { const s = await api<Session>("/api/session", { method: "POST", body: JSON.stringify(new URLSearchParams(window.location.search).has("demo") ? { mode: "demo" } : new URLSearchParams(window.location.search).has("workspace") ? { mode: "account" } : {}) }); const d = s.encounters.length ? await api<Envelope>(`/api/encounters/${s.encounters[0].id}`) : await api<Envelope>("/api/encounters", { method: "POST", body: JSON.stringify({ caseId: "case-01" }) }); return { session: s, data: d }; })();
    let active = true; startup.current.then(value => { if (active) { setSession(value.session); receive(value.data); if (value.session.role === "studio" && value.session.user) setReviewer(value.session.user.name); setStep(resumeStep(value.data)); } }).catch(err => { if (active) setError(err.message); }); return () => { active = false; };
  }, []);
  function goToStep(index: number, target?: string) {
    if (streaming || recording) { setError("Stop and save the recording before leaving this step."); return; }
    if (answerDirty && index !== step) { setError("Save your answer transcript correction before leaving this step."); return; }
    navigationTarget.current = target ?? (index === 0 && !e?.consent ? "synthetic-consent" : null);
    setLab(false); setStep(index); setConfirmed(false); setNotice("");
    // A repeated click on the current tab still needs a visible destination.
    setNavigationRequest(current => current + 1);
  }
  useEffect(() => {
    if (previousStep.current !== step || navigationRequest > 0) {
      const target = (navigationTarget.current ? document.getElementById(navigationTarget.current) : null) ?? panelHeading.current;
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: navigationTarget.current ? "center" : "start" });
      previousStep.current = step;
    }
  }, [step, navigationRequest]);
  useEffect(() => {
    if (activeQuestion) document.getElementById(`question-${activeQuestion}`)?.focus({ preventScroll: true });
  }, [activeQuestion, e?.version]);
  async function work(label: string, task: () => Promise<void>) {
    if (busyRef.current) return; busyRef.current = true; setBusy(label); setError(""); setNotice("");
    try { await task(); } catch (err) { setError(err instanceof Error ? err.message : "Something went wrong. Your saved work is preserved."); } finally { busyRef.current = false; setBusy(""); }
  }
  async function action(name: string, body: Record<string, unknown> = {}, next?: number) {
    if (!e) return;
    if (streaming || recording) { setError("Stop and save the recording before changing the encounter."); return; }
    if (answerDirty && name !== "edit-teach-back-transcript") { setError("Save your answer transcript correction before continuing."); return; }
    if (turnDirty && name !== "transcript") { setError("Save your transcript edits before continuing. Other actions will not overwrite them."); return; }
    if (noteDirty && !["edit-note", "transcript"].includes(name)) { setError("Save your note edits before continuing. Other actions will not overwrite them."); return; }
    await work(actionLabels[name] ?? "Saving your changes", async () => {
      const payload = JSON.stringify({ action: name, expectedVersion: e.version, ...body });
      const signature = `${e.id}:${payload}`;
      const key = uncertainRequest.current?.signature === signature ? uncertainRequest.current.key : crypto.randomUUID();
      uncertainRequest.current = { signature, key };
      const response = await fetch(`/api/encounters/${e.id}`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: payload });
      const result = await response.json(); uncertainRequest.current = null;
      if (!response.ok) throw new Error(result.error);
      receive(result); if (next !== undefined) goToStep(next);
      if (name === "record-teach-back" && body.outcomes && Object.values(body.outcomes).includes("understood")) {
        const nextQuestion = (result as Envelope).encounter.teachBack.find(q => q.outcome === "pending");
        if (nextQuestion) setActiveQuestion(nextQuestion.id);
      }
      setNotice(actionNotices[name] ?? "Review saved to this encounter.");
    });
  }
  async function newCase(caseId: string) { if (recording || streaming || answerDirty) return; if (turnDirty || noteDirty) { setError("Save your current edits before opening another encounter."); return; } await work("Opening case", async () => { receive(await api<Envelope>("/api/encounters", { method: "POST", body: JSON.stringify({ caseId }) })); goToStep(0); setActiveQuestion(null); setLab(false); }); }
  async function uploadDocument(file: File) {
    if (!e || turnDirty || noteDirty) { setError("Save current edits before uploading a source."); return; }
    if (file.size > 8_000_000 || !["image/png", "image/jpeg", "application/pdf"].includes(file.type)) { setError("Choose PNG, JPEG or PDF up to 8 MB."); return; }
    await work("Saving synthetic document", async () => { receive(await api<Envelope>(`/api/encounters/${e.id}/documents`, { method: "POST", headers: { "Content-Type": file.type, "X-Synthetic-Document": "true", "X-Document-Name": file.name.replace(/[^a-zA-Z0-9 ._-]/g, "_"), "X-Encounter-Version": String(e.version), "Idempotency-Key": crypto.randomUUID() }, body: file })); setNotice("Source saved. Extract visible text when ready; this is a separate paid step."); });
  }
  async function refresh() { if (recording || streaming || answerDirty) return; if (turnDirty || noteDirty) { setError("Save your current edits before reloading saved work."); return; } if (e) await work("Reloading", async () => { receive(await api<Envelope>(`/api/encounters/${e.id}`)); }); }
  async function upload(blob: Blob) {
    if (!e) return;
    if (turnDirty || noteDirty || answerDirty) { setError("Save your edits before replacing the source recording."); return; }
    await work("Saving synthetic audio", async () => { receive(await api<Envelope>(`/api/encounters/${e.id}/audio`, { method: "POST", headers: { "Content-Type": "audio/wav", "X-Synthetic-Audio": "true", "X-Encounter-Version": String(e.version) }, body: blob })); setNotice("Audio saved. Transcribe it next, then assign speaker roles."); });
  }
  async function uploadTeachBack(questionId: string, blob: Blob) {
    if (!e) return;
    await work("Saving synthetic teach-back answer", async () => {
      receive(await api<Envelope>(`/api/encounters/${e.id}/teach-back/${questionId}/audio`, { method: "POST", headers: { "Content-Type": "audio/wav", "X-Synthetic-Audio": "true", "X-Encounter-Version": String(e.version) }, body: blob }));
      setNotice("Answer saved. Transcribe and compare it, then record the reviewer's outcome.");
    });
  }
  async function uploadSpokenQuestion(blob: Blob) {
    if (!e) return;
    if (turnDirty || noteDirty || answerDirty) { setError("Save your edits before recording a question."); return; }
    await work("Saving synthetic spoken question", async () => {
      receive(await api<Envelope>(`/api/encounters/${e.id}/plan-questions/audio`, { method: "POST", headers: { "Content-Type": "audio/wav", "X-Synthetic-Audio": "true", "X-Encounter-Version": String(e.version) }, body: blob }));
      setNotice("Question audio saved separately. Transcribe and confirm it before checking approved lines.");
    });
  }
  async function transcribe() {
    if (!e) return;
    await work("Transcribing audio — this may take up to 3 minutes", async () => {
      const signature = `${e.id}:transcribe:${e.version}`;
      const key = uncertainRequest.current?.signature === signature ? uncertainRequest.current.key : crypto.randomUUID();
      uncertainRequest.current = { signature, key };
      const response = await fetch(`/api/encounters/${e.id}/transcribe`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ expectedVersion: e.version }) });
      const result = await response.json(); uncertainRequest.current = null;
      if (!response.ok) throw new Error(result.error);
      receive(result);
    });
  }
  function source(id: string) {
    const turn = e?.turns.find(t => t.id === id); setFocusedTurn(id); if (e) setReferenceEncounter(e.id); goToStep(0, `turn-${id}`);
    setTimeout(() => {
      document.getElementById(`turn-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      if (turn && !turn.documentSource && e?.audioAvailable && audio.current) { audio.current.currentTime = turn.startMs / 1000; stopAt.current = turn.endMs / 1000; void audio.current.play().catch(() => setError("Select Play in the audio player to allow playback.")); }
    }, 100);
  }
  const turnDirty = e && JSON.stringify(turns) !== JSON.stringify(e.turns), noteDirty = e && JSON.stringify(claims) !== JSON.stringify(e.claims);
  const disabled = Boolean(busy || streaming || agentBusy);
  const exportBlockers = [...(turnDirty || noteDirty || answerDirty ? ["Save your edits before printing."] : []), ...(data?.view.exportReasons ?? [])];
  const completion = Boolean(data && exportBlockers.length === 0);
  const recordedAnswers = e?.teachBack.filter(q => q.outcome !== "pending").length ?? 0;
  const followUpAnswers = e?.teachBack.filter(q => q.outcome === "not-understood" || q.outcome === "reexplained").length ?? 0;
  const selectedQuestion = activeQuestion && e?.teachBack.some(q => q.id === activeQuestion) ? activeQuestion : e?.teachBack.find(q => q.outcome === "not-understood" || q.outcome === "reexplained")?.id ?? e?.teachBack.find(q => q.outcome === "pending")?.id ?? e?.teachBack[0]?.id;

  const navigationLocked = disabled || recording || answerDirty;
  const usingReference = session?.role !== "studio" || referenceEncounter === e?.id || Boolean(!e?.audioAvailable && (e?.transcriptConfirmation || e?.claims.length || e?.documents?.some(d => d.accepted)));
  const guidance = e && data ? workflowGuidance(e, data.view, {
    step, studio: session?.role === "studio", configured: Boolean(session?.liveConfigured), referenceSelected: usingReference,
    transcriptDirty: Boolean(turnDirty), noteDirty: Boolean(noteDirty), answerDirty, reviewer, confirmed, transcriptChecked, speakerConfirmed,
    speakerRolesReady: [...new Set(e.turns.map(t => t.providerSpeaker).filter((v): v is string => !!v))].every(label => ["clinician", "patient"].includes(speakerRoles[label])),
  }) : null;
  const guidanceAtEnd = guidance?.step === step && ["approve-note", "approve-sheet", "confirm-transcript", "transcript", "edit-note"].includes(guidance?.action ?? "");
  function closeMenu() { if (menuRef.current) menuRef.current.open = false; }
  async function guidedAction(name: string, body: Record<string, unknown> = {}) {
    if (name === "transcript") return action(name, { turns });
    if (name === "edit-note") return action(name, { claims });
    if (name === "map-speakers") return action(name, { speakerRoles, reviewer, confirmed: speakerConfirmed });
    if (name === "confirm-transcript") return action(name, { reviewer, confirmed: transcriptChecked });
    if (name === "approve-note" || name === "approve-sheet") return action(name, { reviewer, confirmed });
    return action(name, body, name === "generate-note" ? 1 : name === "teach-back" ? 3 : undefined);
  }
  useEffect(() => {
    if (!turnDirty && !noteDirty && !answerDirty && !recording && !streaming) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [turnDirty, noteDirty, answerDirty, recording, streaming]);
  return <div className="app-shell guided-workspace">
    <main className="main-shell">
      <header className="workspace-topbar">
        <a className="brand" href="/" onClick={event => { if (navigationLocked) event.preventDefault(); }}><span className="brand-mark"><HeartPulse size={23} /></span><span>Klinika<span className="brand-flow">Flow</span></span></a>
        <div className="header-tools"><span className="environment"><ShieldCheck size={14} /> Synthetic only</span>
          <details className="workspace-menu" ref={menuRef} onKeyDown={event => { if (event.key === "Escape") { closeMenu(); menuRef.current?.querySelector("summary")?.focus(); } }}>
            <summary aria-label="Workspace menu">Menu <ChevronRight size={15} /></summary>
            <nav aria-label="Workspace options">
              <button disabled={navigationLocked} onClick={() => { setLab(false); closeMenu(); }}>Encounter</button>
              <button disabled={navigationLocked} onClick={() => { setLab(true); closeMenu(); }}>Test cases, evidence & usage</button>
              <button disabled={navigationLocked} onClick={() => { closeMenu(); void refresh(); }}>Reload saved work</button>
              {session?.user ? <><a href="/account" onClick={event => { if (navigationLocked) event.preventDefault(); }}>Account</a>{session.user.role === "admin" && session.user.status === "active" && <a href="/admin/users" onClick={event => { if (navigationLocked) event.preventDefault(); }}>Manage users</a>}{session.role === "judge" && session.user.status === "active" ? <a href="/?workspace=1" onClick={event => { if (navigationLocked) event.preventDefault(); }}>Open workspace</a> : <a href="/?demo=1" onClick={event => { if (navigationLocked) event.preventDefault(); }}>Saved Demo</a>}<button disabled={navigationLocked || Boolean(turnDirty || noteDirty)} onClick={() => work("Signing out", async () => { await api("/api/auth", { method: "POST", body: JSON.stringify({ action: "logout" }) }); window.location.assign("/sign-in"); })}>Sign out</button></> : <><a href="/sign-in">Sign in</a><a href="/sign-up">Create account</a></>}
            </nav>
          </details>
        </div>
      </header>
      <div className="main-content">
        {session?.user?.status === "pending" && <section className="source-note"><strong>Awaiting approval</strong><p>You can explore Saved Demo. Your administrator must approve your account before you can use live features.</p><a href="/account">Check approval status</a></section>}
        {error && <div className="alert error" role="alert"><TriangleAlert size={18} /><div>{error}<button className="text-link" onClick={refresh}>Reload saved encounter</button></div><button className="icon-button" aria-label="Dismiss error" onClick={() => setError("")}><X size={16} /></button></div>}
        <div className={notice && !busy ? "save-notice" : "sr-only"} role="status" aria-live="polite">{busy || notice}</div>
        {lab ? <>
          <div className="page-heading"><div><div className="eyebrow">EVIDENCE BEFORE CLAIMS</div><h1>Capability lab</h1><p>Three synthetic cases. Clear gates. Honest results.</p></div><span className="pill neutral"><FlaskConical size={14} /> Human review pending</span></div>
          <div className="lab-intro"><div className="lab-icon"><FlaskConical size={28} /></div><div><h2>Prove the two riskiest capabilities.</h2><p>Read the reference script aloud in your signed-in workspace, check the transcript, then compare every instruction. Saved references are human-authored fixtures, not live model results.</p></div></div>
          <div className="case-grid">{session?.cases.map((c, i) => <article className="case-card" key={c.id}><span className="case-number">0{i + 1}</span><h3>{c.title}</h3><p>{c.subtitle}</p><div className="case-state"><span className="status-dot amber" /> Live tests pending</div><button className="button secondary" disabled={disabled} onClick={() => newCase(c.id)}>Open synthetic case <ArrowRight size={15} /></button></article>)}</div>
          <div className="lab-bottom"><section className="panel"><h3>Quality gates</h3><ul className="check-list"><li><Check size={16} /> No changed meaning or added instructions</li><li><Check size={16} /> No changed medicine schedule or negation</li><li><Check size={16} /> Immediate warnings stay immediate</li><li><Check size={16} /> Clinician and native-speaker review before quality claims</li></ul><p className="muted small">Free-form Filipino generation stays gated. The current fallback is a controlled template draft, still awaiting human language review.</p></section><section className="panel"><h3>Model API usage</h3><div className="budget-number">${session?.modelUsage.actualUsd.toFixed(3) ?? "0.000"}<span> recorded usage cost · ${session?.modelUsage.estimatedUsd.toFixed(3) ?? "0.000"} attempted estimate</span></div><p className="muted small">Estimated usage includes failed calls whose final charge may be unknown. Refresh for current records.</p><button className="text-link" disabled={disabled} onClick={() => work("Refreshing usage", async () => setSession(await api<Session>("/api/session", { method: "POST", body: "{}" })))}><RefreshCw size={14} /> Refresh usage</button><TokenUsagePanel usage={session?.modelUsage.text} /><p className="small muted">CLI reports: <code>npm run eval</code> · <code>npm run eval:live</code> · <code>npm run eval:cache</code></p></section></div>
        </> : <>
          <div className="workspace-title"><div><h1>{session?.role === "studio" ? "Consultation" : "Saved Demo"}</h1><p>{session?.role === "studio" ? "Record, review and check understanding." : "A fictional walkthrough · no model calls"}</p></div></div>
          {!e ? <div className="loading-state"><LoaderCircle className="spin" size={28} /><h2>Preparing your private workspace…</h2>{error && <button className="button secondary" onClick={() => location.reload()}>Try again</button>}</div> : <>
            <section className="encounter-summary" aria-label="Encounter details">
              <div className="encounter-identity">{session?.role === "studio" && session.encounters.length > 0 && <label className="field saved-encounters">Encounter<select value={e?.id ?? ""} disabled={navigationLocked} onChange={event => { const id = event.target.value; if (turnDirty || noteDirty) { setError("Save current edits before switching encounters."); return; } void work("Opening saved encounter", async () => { const value = await api<Envelope>(`/api/encounters/${id}`); receive(value); setStep(resumeStep(value)); setLab(false); }); }}>{!session.encounters.some(item => item.id === e?.id) && e && <option value={e.id}>{e.title}</option>}{session.encounters.map(item => <option key={item.id} value={item.id}>{item.title} · {item.id.slice(0, 8)}</option>)}</select></label>}{session?.role !== "studio" && <strong>{session?.cases.find(c => c.id === e.caseId)?.patient ?? "Synthetic encounter"}</strong>}<span className="small muted">{e.audioAvailable ? "Recorded actor audio" : usingReference ? "Saved synthetic reference" : "No recording yet"}</span></div>
              <label className="field compact-reviewer" htmlFor="encounter-reviewer">Reviewer<input id="encounter-reviewer" value={reviewer} onChange={event => setReviewer(event.target.value)} maxLength={80} placeholder="Name or initials" disabled={navigationLocked || session?.role === "studio"} autoComplete="off" /></label>
              <div className="save-state"><span className={`status-dot ${completion ? "teal" : "amber"}`} /><span>{completion ? "Print available" : turnDirty || noteDirty || answerDirty ? "Unsaved edits" : "Saved"}<small>Version {e.version}</small></span></div>
            </section>
            <div className="stepper" aria-label="Encounter workflow">{steps.map((s, i) => { const Icon = s.icon; const done = i === 0 ? e.consent && e.claims.length > 0 : i === 1 ? data.view.noteApproved : i === 2 ? data.view.sheetApproved : completion; return <button key={s.title} className={`step ${step === i ? "selected" : ""} ${done ? "complete" : ""}`} disabled={navigationLocked} onClick={() => goToStep(i)} aria-current={step === i ? "step" : undefined}><span className="step-icon">{done ? <Check size={18} /> : <Icon size={18} />}</span><span><strong>{s.title}</strong></span><span className="step-count">0{i + 1}</span></button>; })}</div>
            <div className="workspace-grid"><section className="work-panel">
              <div className="panel-heading"><div><span className="eyebrow">STEP 0{step + 1}</span><h2 ref={panelHeading} tabIndex={-1}>{["What was said", "Check the clinical plan", "Mga Bilin ng Doktor", "Did the instructions land?"][step]}</h2><p>{["Review the source and confirm who said what.", "Every instruction stays connected to its source.", "Plain Filipino, built only from the approved plan.", "Ask in the patient’s own words. Re-explain when needed."][step]}</p></div><span className="pill neutral">{step === 0 ? usingReference || e.audioAvailable ? `${e.turns.length} turns` : "Ready to record" : step === 1 ? `${e.claims.length} claims` : step === 2 ? "FILIPINO" : "TEACH-BACK"}</span></div>
              {guidance && !guidanceAtEnd && <GuidedPreparation encounter={e} view={data.view} studio={session?.role === "studio"} configured={Boolean(session?.liveConfigured)} disabled={disabled || recording} unsaved={Boolean(turnDirty || noteDirty)} currentStep={step} guidance={guidance} onAction={(name, body) => { void guidedAction(name, body); }} onTranscribe={transcribe} onGo={goToStep} />}
              {e.checks.length > 0 && ((step === 1 && !data.view.noteApproved) || (step === 2 && data.view.noteApproved)) && <section className="inline-checks" id="instruction-checks" tabIndex={-1}><h3>{e.checks.length} check{e.checks.length === 1 ? "" : "s"} to resolve</h3><ul>{e.checks.map(check => <li key={check.id}><span>{check.message}</span><small>{check.target}</small></li>)}</ul></section>}
              {step === 0 && <>
                <label className="consent"><input id="synthetic-consent" type="checkbox" checked={e.consent} disabled={disabled} onChange={ev => action("consent", { value: ev.target.checked })} /><span><strong>This encounter uses synthetic data only.</strong><small>I have permission to record any actors. No real patient details will be entered.</small></span><ShieldCheck size={20} /></label>
                {session?.role === "studio" && <section id="consultation-recorder" tabIndex={-1} className="consultation-input">
                  {!e.audioAvailable && !usingReference ? <><Recorder primary label="Record consultation" disabled={disabled || !e.consent} onRecordingChange={setRecording} onUpload={upload} onError={setError} prompt="Record the fictional consultation with two actors." /><button className="text-link" disabled={navigationLocked || !e.consent} onClick={() => setReferenceEncounter(e.id)}>Use saved reference instead</button></> : <details><summary>{e.audioAvailable ? "Replace consultation audio" : "Record actor audio instead"}</summary><p className="small muted">Replacing the source clears dependent drafts, reviews and answers.</p><Recorder label="Record consultation" disabled={disabled || !e.consent} onRecordingChange={setRecording} onUpload={upload} onError={setError} /></details>}
                  {session?.features?.streaming && session.liveConfigured && e.consent && <details><summary>Live transcription · optional</summary><LiveTranscript encounter={e} disabled={Boolean(busy || recording)} onSaved={refresh} onUploadFallback={upload} onStreamingChange={setStreaming} onError={setError} /></details>}
                </section>}
                {(usingReference || e.audioAvailable) && <>
                {e.audioAvailable ? <div className="audio-player"><audio ref={audio} controls src={`/api/encounters/${e.id}/audio?v=${e.version}`} onTimeUpdate={() => { if (audio.current && stopAt.current && audio.current.currentTime >= stopAt.current) { audio.current.pause(); stopAt.current = 0; } }} /><span>Source audio · synthetic recording</span></div> : <div className="source-note"><Info size={15} /> Saved text reference. No source audio is attached; timestamps are illustrative.</div>}
                {e.recordingFingerprint && e.turns.some(t => t.providerSpeaker) && <section id="speaker-mapping" tabIndex={-1} className="source-note" aria-label="Recording speaker mapping"><strong>Assign recording speakers once</strong><p>Provider labels identify voices, not clinician or patient roles. Confirm each label; individual turn changes stay as overrides.</p><div className="button-row">{[...new Set(e.turns.map(t => t.providerSpeaker).filter((v): v is string => !!v))].map(label => <label key={label}>Speaker {label} <select value={speakerRoles[label] ?? "unknown"} disabled={disabled || Boolean(turnDirty)} onChange={event => setSpeakerRoles(current => ({ ...current, [label]: event.target.value as Turn["speaker"] }))}><option value="unknown">Unresolved</option><option value="clinician">Clinician</option><option value="patient">Patient</option></select></label>)}</div><label className="checkbox-line"><input type="checkbox" checked={speakerConfirmed} disabled={disabled || Boolean(turnDirty)} onChange={event => setSpeakerConfirmed(event.target.checked)} />I reviewed these roles against this recording.</label>{e.speakerMapping?.recordingFingerprint === e.recordingFingerprint && <p>Confirmed by {e.speakerMapping.reviewer}.</p>}</section>}
                <div className="transcript" id="consultation-transcript" tabIndex={-1}>{turns.map((t, i) => <article id={`turn-${t.id}`} tabIndex={-1} className={`turn ${t.speaker} ${focusedTurn === t.id ? "focused" : ""}`} key={t.id}><div className="turn-avatar">{t.speaker === "clinician" ? <HeartPulse size={17} /> : t.speaker === "patient" ? "P" : "?"}</div><div className="turn-content"><div className="turn-meta"><label className="sr-only" htmlFor={`speaker-${t.id}`}>Speaker for turn {i + 1}</label><select id={`speaker-${t.id}`} value={t.speaker} disabled={disabled} onChange={ev => setTurns(turns.map(x => x.id === t.id ? { ...x, speaker: ev.target.value as Turn["speaker"], roleOverride: Boolean(x.providerSpeaker) } : x))}><option value="clinician">Clinician</option><option value="patient">Patient</option><option value="unknown">Unassigned speaker</option></select><span>{t.providerSpeaker && <span className="source-id">Voice {t.providerSpeaker} · </span>}{t.documentSource ? <a href={`/api/encounters/${e.id}/documents/${t.documentSource.documentId}#page=${t.documentSource.page}`} target="_blank" rel="noreferrer">Document page {t.documentSource.page}</a> : time(t.startMs)} <span className="source-id">{t.id}</span></span></div><label className="sr-only" htmlFor={`text-${t.id}`}>Transcript turn {i + 1}</label><textarea id={`text-${t.id}`} value={t.text} disabled={disabled} rows={Math.max(2, Math.ceil(t.text.length / 80))} onChange={ev => setTurns(turns.map(x => x.id === t.id ? { ...x, text: ev.target.value } : x))} /></div></article>)}</div>
                {session?.role === "studio" && !turnDirty && e.turns.length > 0 && !e.turns.some(t => t.speaker === "unknown") && <div id="transcript-checkpoint" tabIndex={-1} className="source-note"><strong>Review confirmation</strong>{e.transcriptConfirmation ? <p>Confirmed by {e.transcriptConfirmation.reviewer} at {new Date(e.transcriptConfirmation.at).toLocaleString()}.</p> : <><p>Listen to the source, correct each turn and role, then confirm before drafting. This approval does not certify clinical accuracy.</p><label className="checkbox-line"><input type="checkbox" checked={transcriptChecked} disabled={disabled} onChange={event => setTranscriptChecked(event.target.checked)} />I reviewed the transcript and speaker roles against this recording or saved reference.</label></>}</div>}
                {turnDirty && <p className="inline-warning">Unsaved transcript edits. Saving clears dependent drafts and approvals.</p>}
                </>}
                <DocumentImport encounter={e} studio={session?.role === "studio"} enabled={Boolean(session?.features?.documentImport)} configured={Boolean(session?.liveConfigured)} reviewer={reviewer} disabled={disabled || turnDirty || Boolean(noteDirty)} onUpload={uploadDocument} onAction={(name, body) => action(name, body)} /> 
                {session?.role === "studio" && usingReference && !e.audioAvailable && !e.claims.length && e.transcriptConfirmation && <details className="regeneration-controls"><summary>Use a saved note instead</summary><p>A labelled fixture draft; it is not generated from live audio.</p><button className="button secondary" disabled={navigationLocked || Boolean(turnDirty)} onClick={() => action("generate-note", { provider: "saved" }, 1)}>Load saved note · no model call</button></details>}
                {e.claims.length > 0 && <details className="regeneration-controls"><summary>Replace the current note</summary><p>A replacement clears note review and approval, the instruction sheet and teach-back. Continue to the note above to keep your existing work.</p><div className="button-row"><button className="button secondary" disabled={disabled || !e.consent || Boolean(turnDirty) || Boolean(noteDirty)} onClick={() => action("generate-note", { provider: "saved" }, 1)}>Reload saved note</button>{session?.role === "studio" && <button className="button secondary" disabled={disabled || !e.consent || Boolean(turnDirty) || Boolean(noteDirty) || !session.liveConfigured} onClick={() => action("generate-note", { provider: "live" }, 1)}>Generate replacement · paid call</button>}</div></details>}
              </>}
              {step === 1 && <>
                {!e.claims.length ? <Empty icon={<ClipboardCheck size={30} />} title="Start with the consultation" text="Review the transcript, confirm synthetic-data consent, then load the saved note or generate a live draft." onClick={() => goToStep(0)} button="Go to consultation" /> : <><div className="provenance"><Info size={15} />{e.provenance.note}</div><div className="claim-list">{claims.map(c => <article className="claim" key={c.id}><div className="claim-top"><span className={`claim-kind ${c.fact.kind}`}>{c.fact.kind}</span><span className="source-id">{c.id}</span><div className="source-chips">{c.sourceTurnIds.map(id => <button className="source-chip" key={id} disabled={disabled} onClick={() => source(id)}><Play size={10} /> {id}</button>)}</div></div><p className="claim-summary">{renderEnglish(c.fact)}</p><details className="source-preview" open={e.checks.some(check => check.target === c.id || c.sourceTurnIds.includes(check.target)) || e.noteReview?.findings.some(f => !f.dismissal && f.targetId === c.id)}><summary>Compare with transcript source</summary>{c.sourceTurnIds.map(id => { const turn = e.turns.find(t => t.id === id); return <div key={id}><strong>{id} · {turn?.speaker ?? "Missing source"}</strong><p>{turn?.text ?? "Source turn unavailable. Resolve this before approval."}</p><button className="text-link" disabled={disabled} onClick={() => source(id)}>{e.audioAvailable ? "Play source and open transcript" : "Open transcript to correct"} <ArrowRight size={13} /></button></div>; })}</details><details><summary>Edit structured instruction</summary><FactEditor fact={c.fact} disabled={disabled} onChange={fact => setClaims(claims.map(x => x.id === c.id ? { ...x, fact } : x))} /></details></article>)}</div>{noteDirty && <p className="inline-warning">Unsaved note edits. Saving clears sheet approval and teach-back.</p>}<AiReviewPanel guided stage="note" review={e.noteReview} reviewer={reviewer} studio={session?.role === "studio"} configured={Boolean(session?.liveConfigured)} disabled={disabled || Boolean(noteDirty)} onRun={() => { void action("run-note-review"); }} onManual={(reviewer, reason) => { void action("manual-review", { stage: "note", reviewer, reason }); }} onDismiss={(findingId, reviewer, reason) => { void action("dismiss-review", { stage: "note", findingId, reviewer, reason }); }} /><NoteCorrectionPanel encounter={e} enabled={session?.role === "studio" && Boolean(session?.features?.noteCorrections)} reviewer={reviewer} disabled={disabled || Boolean(noteDirty)} onAction={(name, body) => action(name, body)} onStage={setClaims} /><ApprovalConfirmation approved={data.view.noteApproved} reviewer={reviewer} approvedBy={e.noteApproval?.reviewer} label="Clinical note" confirmed={confirmed} disabled={disabled} onConfirm={setConfirmed}>I compared every instruction with its source{e.mode === "live" ? " audio, including all medication details" : " reference, including all medication details"}. This is a synthetic demonstration approval.</ApprovalConfirmation></>}
              </>}
              {step === 2 && <>
                {!e.lines.length ? <Empty icon={<FileHeart size={30} />} title={data.view.noteApproved ? "Create patient instructions" : "An approved plan comes first"} text={data.view.noteApproved ? "Your note is approved. Create the controlled Filipino draft, then review each line." : "Review and approve the clinical note, then create the instruction sheet."} onClick={() => data.view.noteApproved ? action("generate-sheet") : goToStep(1)} button={data.view.noteApproved ? "Create instruction sheet" : "Review clinical note"} /> : <><div className="provenance"><Info size={15} />{e.provenance.sheet}</div>{e.checks.some(check => check.id.startsWith("wording-")) && <div className="inline-warning"><TriangleAlert size={16} /><span>The sheet differs from the controlled template. Restore it, then review and approve again.</span><button className="button primary" disabled={disabled} onClick={() => action("generate-sheet")}>Restore controlled sheet</button></div>}<div className="patient-sheet" lang="fil"><div className="sheet-letterhead"><HeartPulse size={21} /><strong>Mga Bilin ng Doktor</strong><span>SYNTHETIC SAMPLE</span></div><p className="sheet-subtitle">Basahin kasama ng inyong doktor. Magtanong kung may hindi malinaw.</p>{["medication", "advice", "negation", "warning", "followup"].map(kind => { const lines = e.lines.filter(l => l.fact.kind === kind); if (!lines.length) return null; return <section className={`sheet-section ${kind}`} key={kind}><h3>{sectionLabel[kind as Fact["kind"]]}</h3>{lines.map(l => <div className="sheet-line" key={l.id}><p>{e.illustrations?.find(image => image.lineId === l.id) && <InstructionIllustration illustrationId={e.illustrations.find(image => image.lineId === l.id)!.illustrationId} />}{l.text}</p><div><details className="sheet-source-preview" lang="en" open={e.checks.some(check => check.target === l.id) || e.sheetReview?.findings.some(f => !f.dismissal && f.targetId === l.id)}><summary>Compare with approved source</summary>{l.sourceClaimIds.map(id => { const claim = e.claims.find(c => c.id === id); return <div key={id}><strong>{id}</strong><p>{claim ? renderEnglish(claim.fact) : "Source instruction unavailable."}</p></div>; })}<button className="text-link" disabled={disabled} onClick={() => goToStep(1)}>Open clinical note <ArrowRight size={13} /></button></details></div></div>)}</section>; })}<div className="sheet-end"><ShieldCheck size={14} /> Bawat linya ay may pinanggalingang bilin sa plano.</div></div><details className="demo-exercise"><summary>Optional demo: test the export safeguard</summary><div className="demo-test"><div><FlaskConical size={18} /><span><strong>Plant an incorrect three-day delay</strong><small>This clears sheet approval and teach-back. Restoring the sheet requires fresh review.</small></span></div><button className="button secondary" disabled={disabled} onClick={() => action("plant-error")}>Plant timing error</button><button className="text-link" disabled={disabled} onClick={() => action("generate-sheet")}>Restore correct sheet</button></div></details><IllustrationLibrary encounter={e} reviewer={reviewer} disabled={disabled} onAction={(name, body) => action(name, body)} /><AiReviewPanel guided stage="sheet" review={e.sheetReview} reviewer={reviewer} studio={session?.role === "studio"} configured={Boolean(session?.liveConfigured)} disabled={disabled} onRun={() => { void action("run-sheet-review"); }} onManual={(reviewer, reason) => { void action("manual-review", { stage: "sheet", reviewer, reason }); }} onDismiss={(findingId, reviewer, reason) => { void action("dismiss-review", { stage: "sheet", findingId, reviewer, reason }); }} /><ApprovalConfirmation approved={data.view.sheetApproved} reviewer={reviewer} approvedBy={e.sheetApproval?.reviewer} label="Instruction sheet" confirmed={confirmed} disabled={disabled} onConfirm={setConfirmed}>I checked every Filipino line against the approved plan, including timing and negation. This does not certify clinical or language quality.</ApprovalConfirmation>{session?.features?.planQuestions && <details className="optional-tools"><summary>Questions about the plan · optional</summary><PlanQuestionPanel encounter={e} enabled={Boolean(session?.features?.planQuestions)} spokenEnabled={Boolean(session?.features?.spokenQuestions)} configured={Boolean(session?.liveConfigured)} approved={data.view.sheetApproved} disabled={disabled} studio={session?.role === "studio"} reviewer={reviewer} onAsk={question => action("ask-plan-question", { question })} onUpload={uploadSpokenQuestion} onRecordingChange={setRecording} onAction={(name, body) => action(name, body)} onError={setError} /></details>}</>}
              </>}
              {step === 3 && <>
                {!e.teachBack.length ? <Empty icon={<MessageCircle size={30} />} title={data.view.sheetApproved ? "Check understanding" : "Check the approved instructions"} text={data.view.sheetApproved ? "Open the questions linked to this approved sheet. Review each answer and record the human outcome." : "Approve the patient sheet, then create questions from those exact lines."} onClick={() => data.view.sheetApproved ? action("teach-back") : goToStep(2)} button={data.view.sheetApproved ? "Create teach-back questions" : "Review instruction sheet"} /> : <><div className="teach-intro"><MessageCircle size={20} /><p>“Para masigurong malinaw ang paliwanag ko, maaari po bang sabihin ninyo sa inyong sariling salita…”</p></div><div className="teach-progress"><strong>{recordedAnswers} of {e.teachBack.length} outcomes recorded</strong><span>{e.teachBack.filter(q => q.outcome === "understood").length} understood{followUpAnswers > 0 ? ` · ${followUpAnswers} need follow-up` : ""}</span></div><div className="teach-list" id="teach-questions" tabIndex={-1}>{e.teachBack.map((q, i) => <article className={`teach-card ${q.outcome === "not-understood" || q.outcome === "reexplained" ? "needs-follow-up" : ""}`} key={q.id}><div><h3><button id={`question-${q.id}`} className="question-toggle" disabled={navigationLocked} aria-expanded={selectedQuestion === q.id} aria-controls={`answer-${q.id}`} onClick={() => setActiveQuestion(q.id)}><span className="question-number">0{i + 1}</span><span lang="fil">{q.question}</span><span className={`pill ${q.outcome === "understood" ? "success" : "neutral"}`}>{outcomeLabel[q.outcome]}</span><ChevronRight className={selectedQuestion === q.id ? "expanded" : ""} size={17} /></button></h3><div id={`answer-${q.id}`} hidden={selectedQuestion !== q.id}><details><summary>Expected answer from the sheet</summary><p lang="fil">{q.expected}</p></details><AttemptHistory question={q} encounterId={e.id} lines={e.lines} current disabled={disabled} onRepeat={() => action("start-teach-back-attempt", { questionId: q.id })} /><TeachBackVoice question={q} reviewer={reviewer} encounterId={e.id} studio={session?.role === "studio"} configured={Boolean(session?.liveConfigured)} disabled={disabled} onUpload={blob => uploadTeachBack(q.id, blob)} onAction={(name, body) => action(name, body)} onError={setError} onRecordingChange={setRecording} onDirtyChange={dirty => setDirtyAnswers(current => current[q.id] === dirty ? current : { ...current, [q.id]: dirty })} /><fieldset disabled={disabled || recording || Boolean(dirtyAnswers[q.id]) || !q.analysis || !reviewer.trim()}><legend className="sr-only">Outcome for question {i + 1}</legend>{(["understood", "reexplained", "not-understood"] as const).map(outcome => <label key={outcome} className={`outcome ${q.outcome === outcome ? "chosen" : ""}`}><input type="radio" name={q.id} checked={q.outcome === outcome} onChange={() => action("record-teach-back", { outcomes: { [q.id]: outcome }, reviewer })} />{outcome === "understood" ? "Understood" : outcome === "reexplained" ? "Re-explained" : "Not yet understood"}</label>)}</fieldset>{(q.outcome === "not-understood" || q.outcome === "reexplained") && <p className="small amber-text">{q.outcome === "reexplained" ? "Re-explanation is recorded; understanding is not yet confirmed." : "This instruction is not yet understood."} Explain it again, ask for another answer and update the outcome.</p>}</div></div></article>)}</div>{Boolean(e.teachBackArchive?.length) && <details className="skip-teach"><summary>Historical answers from earlier instructions · {e.teachBackArchive?.length}</summary>{e.teachBackArchive?.map((old, index) => <AttemptHistory key={`${old.sheetFingerprint}-${old.id}-${index}`} question={old} encounterId={e.id} lines={[]} current={false} disabled={disabled} />)}</details>}<details className="skip-teach"><summary>If teach-back must be skipped</summary><form onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); void action("record-teach-back", { reason: form.get("reason") }); }}><label className="field">Record the reason<textarea name="reason" required minLength={3} maxLength={500} placeholder="Why could teach-back not be completed?" /></label><button className="button secondary" disabled={disabled}>Save skip reason</button></form></details>{e.teachBackSkip && <div className="source-note">Teach-back skipped: {e.teachBackSkip}</div>}{e.teachBack.length > 0 && <div id="print-options" tabIndex={-1}>{e.printException ? <PrintExceptionPanel encounter={e} reviewer={reviewer} disabled={disabled} policySatisfied={!data.view.exportReasons.some(reason => reason.includes("Confirm understanding"))} onAction={(name, body) => action(name, body)} /> : <details className="optional-tools"><summary>Print with unresolved understanding · exception</summary><PrintExceptionPanel encounter={e} reviewer={reviewer} disabled={disabled} policySatisfied={!data.view.exportReasons.some(reason => reason.includes("Confirm understanding"))} onAction={(name, body) => action(name, body)} /></details>}</div>}<div className="export-card"><div className="export-icon"><Printer size={24} /></div><div><h3>{completion ? "Approved documents available" : "Before you can print"}</h3><p>{completion ? e.teachBackSkip ? "Teach-back was skipped. The reason and named exception appear in the printout; understanding was not confirmed." : followUpAnswers ? "A named reviewer exception permits this printout; understanding remains unconfirmed for some answers." : "Print the approved Filipino instructions and reviewed note." : exportBlockers.join(" ")}</p></div>{completion ? <a className="button primary" href={`/print/${e.id}`} target="_blank" rel="noreferrer"><Printer size={16} /> Open print preview</a> : <button className="button secondary" disabled><LockKeyhole size={15} /> Export locked</button>}</div></>}
              </>}
              <AgentPanel key={e.id} encounter={e} disabled={Boolean(disabled || recording || answerDirty || turnDirty || noteDirty)} onBusyChange={setAgentBusy} onRefresh={async () => { const fresh = await api<Envelope>(`/api/encounters/${e.id}`); if (fresh.encounter.version !== e.version) receive(fresh); }} />
              {guidance && guidanceAtEnd && <GuidedPreparation encounter={e} view={data.view} studio={session?.role === "studio"} configured={Boolean(session?.liveConfigured)} disabled={disabled || recording} unsaved={Boolean(turnDirty || noteDirty)} currentStep={step} guidance={guidance} onAction={(name, body) => { void guidedAction(name, body); }} onTranscribe={transcribe} onGo={goToStep} />}
            </section></div>
            <footer className="workspace-footer"><span>Synthetic demonstration · not for patient care</span><details><summary>Encounter options</summary><p>Reset permanently removes this encounter and its saved content.</p><button disabled={navigationLocked} onClick={() => { if (turnDirty || noteDirty) { setError("Save your edits before resetting."); return; } if (!window.confirm("Permanently reset this synthetic encounter? Its saved content will be removed.")) return; void work("Deleting encounter", async () => { await api(`/api/encounters/${e.id}`, { method: "DELETE" }); receive(await api<Envelope>("/api/encounters", { method: "POST", body: JSON.stringify({ caseId: e.caseId }) })); goToStep(0); setActiveQuestion(null); }); }}>Reset this encounter</button></details></footer>
          </>}
        </>}
      </div>
      {busy && <div className="busy-toast" role="status"><LoaderCircle className="spin" size={17} />{busy}<span>Your work stays saved.</span></div>}
    </main>
  </div>;
}
function Empty({ icon, title, text }: { icon: React.ReactNode; title: string; text: string; button: string; onClick: () => void }) { return <div className="empty-state"><div>{icon}</div><h3>{title}</h3><p>{text}</p></div>; }
function FactEditor({ fact, disabled, onChange }: { fact: Fact; disabled: boolean; onChange: (f: Fact) => void }) {
  const fields: (keyof Fact)[] = fact.kind === "medication" ? ["medicine", "dose", "quantity", "frequency", "duration", "timing"] : fact.kind === "warning" ? ["condition", "urgency", "delayDays"] : fact.kind === "followup" ? ["date"] : fact.kind === "negation" ? ["action", "negated"] : ["action"];
  return <div className="fact-fields">{fields.map(key => <label className="field" key={key}>{key === "delayDays" ? "Waiting days (0 = immediate)" : key}{key === "urgency" ? <select value={fact.urgency} disabled={disabled} onChange={ev => onChange({ ...fact, urgency: ev.target.value as Fact["urgency"] })}><option value="immediate">Immediate</option><option value="scheduled">Scheduled</option><option value="none">None</option></select> : key === "negated" ? <input type="checkbox" checked={fact.negated} disabled={disabled} onChange={ev => onChange({ ...fact, negated: ev.target.checked })} /> : <input value={fact[key] === null ? "" : String(fact[key])} disabled={disabled} type={key === "delayDays" ? "number" : "text"} onChange={ev => onChange({ ...fact, [key]: key === "delayDays" ? ev.target.value === "" ? null : Number(ev.target.value) : ev.target.value })} />}</label>)}</div>;
}

function ApprovalConfirmation({ approved, reviewer, approvedBy, label, confirmed, disabled, onConfirm, children }: {
  approved: boolean; reviewer: string; approvedBy?: string; label: string; confirmed: boolean; disabled: boolean;
  onConfirm: (value: boolean) => void; children: React.ReactNode;
}) {
  return <div className="approval-box">{approved ? <p className="approval-reviewer"><CircleCheck size={16} /> <strong>{label} approved by {approvedBy}</strong>. Editing the content clears this approval.</p> : <><p className="approval-reviewer">Approving as <strong>{reviewer.trim() || "— reviewer needed"}</strong>{!reviewer.trim() && <> · <button className="text-link" onClick={() => document.getElementById("encounter-reviewer")?.focus()}>Enter reviewer initials</button></>}</p><label className="checkbox-line"><input type="checkbox" checked={confirmed} disabled={disabled} onChange={event => onConfirm(event.target.checked)} /><span>{children}</span></label></>}</div>;
}
