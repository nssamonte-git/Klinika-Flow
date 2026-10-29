// Shared identifiers only; importing these must not initialize storage or provider clients.
export const OPERATION_VERSIONS = {
  note: "klinikaflow-core@1", filipino_sheet: "klinikaflow-core@1",
  note_review: "klinikaflow-discrepancy@1", sheet_review: "klinikaflow-discrepancy@1",
  teach_back_analysis: "klinikaflow-teach-back@1", note_correction: "klinikaflow-note-correction@1",
  plan_question: "klinikaflow-plan-question@1", document_extraction: "klinikaflow-document@1",
} as const;
export const operationVersion = (operation: string) => OPERATION_VERSIONS[operation as keyof typeof OPERATION_VERSIONS] ?? "klinikaflow-text@1";
