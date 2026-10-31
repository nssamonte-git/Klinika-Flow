"use client";
import { useEffect, useState } from "react";
import type { Encounter } from "@backend/domain/schema";

export default function CompanionPanel({ encounter: e, disabled, onAction }: { encounter: Encounter; disabled: boolean; onAction: (name: string, body: Record<string, unknown>) => Promise<void> }) {
  const [present, setPresent] = useState(!!e.companion?.present), [relation, setRelation] = useState(e.companion?.relation ?? "");
  useEffect(() => { setPresent(!!e.companion?.present); setRelation(e.companion?.relation ?? ""); }, [e.companion?.present, e.companion?.relation]);
  const changed = present !== !!e.companion?.present || (present && relation.trim() !== (e.companion?.relation ?? ""));
  return <section className="companion-panel" id="companion" tabIndex={-1} aria-label="Companion">
    <label className="checkbox-line"><input type="checkbox" checked={present} disabled={disabled} onChange={event => setPresent(event.target.checked)} /><span><strong>A companion (bantay) is here</strong><small>Record who helps at home, so the person who will carry out an instruction is the one who says it back.</small></span></label>
    {present && <label className="field">Relationship to the patient<input value={relation} onChange={event => setRelation(event.target.value)} maxLength={40} placeholder="anak, asawa, kapatid…" disabled={disabled} /></label>}
    {changed && <button type="button" className="button secondary" disabled={disabled || (present && !relation.trim())} onClick={() => void onAction("set-companion", { value: present, relation: relation.trim() })}>{present ? "Save companion" : "Remove companion"}</button>}
  </section>;
}
