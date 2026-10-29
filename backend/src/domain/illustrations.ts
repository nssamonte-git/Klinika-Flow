import type { IllustrationAttachment, SheetLine } from "./schema";
// Reusable native artwork, never a generated clinical instruction. Review each use.
export const ILLUSTRATION_VERSION = "klinikaflow-illustrations@1";
export const illustrations = [
  { id: "rest", title: "Rest", description: "A bed representing rest", icon: "bed" },
  { id: "water", title: "Drink water", description: "A glass of water", icon: "water" },
  { id: "followup", title: "Follow-up visit", description: "A calendar representing the approved follow-up", icon: "calendar" },
] as const;
export function compatibleIllustrations(line: SheetLine) {
  const action = line.fact.action.trim().toLowerCase();
  if (/\b(do not|don.t|avoid|never|stop)\b|huwag/.test(action)) return [];
  return illustrations.filter(item => item.id === "followup" ? line.fact.kind === "followup" && !!line.fact.date && !line.fact.negated : line.fact.kind === "advice" && !line.fact.negated && (item.id === "rest" ? /\brest\b|magpahinga/.test(action) : /\bdrink water\b|uminom ng tubig/.test(action)));
}
export function illustrationMatches(attachment: IllustrationAttachment, line: SheetLine | undefined) {
  return !!line && attachment.libraryVersion === ILLUSTRATION_VERSION && compatibleIllustrations(line).some(item => item.id === attachment.illustrationId) && !!attachment.reviewer.trim() && !!attachment.at;
}
