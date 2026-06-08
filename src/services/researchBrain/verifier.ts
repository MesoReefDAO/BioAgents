import { resolveResearchBrainLLM } from "./llm";
import { formatEvidencePackForPrompt } from "./search";
import type { EvidencePack } from "./types";

const NO_EVIDENCE_MESSAGE =
  "No encuentro evidencia suficiente en los papers cargados para responder esta pregunta como hecho científico.";

export async function verifyEvidenceGroundedResponse(params: {
  question: string;
  draft: string;
  evidencePack: EvidencePack;
}): Promise<string> {
  const hasEvidence =
    params.evidencePack.bioprospectingFacts.length > 0 ||
    params.evidencePack.supportedClaims.length > 0 ||
    params.evidencePack.partialClaims.length > 0 ||
    params.evidencePack.contradictions.length > 0;

  if (!hasEvidence) {
    return NO_EVIDENCE_MESSAGE;
  }

  const { llm, model } = resolveResearchBrainLLM();
  if (!llm || !model) {
    return appendEvidenceNotice(params.draft, params.evidencePack);
  }

  const prompt = `You are an evidence verifier for a strict scientific assistant.

Rewrite the draft so every scientific factual claim is grounded in the evidence pack.

Rules:
- Do not introduce facts not present in the evidence pack.
- If evidence is partial, use cautious wording.
- If evidence is external, explicitly say it is external.
- For bioprospection questions, prefer the structured Bioprospecting facts section and distinguish direct evidence, indirect evidence, hypotheses, and open questions.
- Follow the evidence pack query plan when present: use its strategy, answer sections, and cautions to decide the response structure.
- If contradictions exist, state them without resolving them as consensus.
- If a claim in the draft is unsupported, remove it.
- Include compact inline provenance using source title and DOI when available.
- Always include a final short section titled "Evidencia usada" when evidence exists. For each key claim, list source title, DOI as a clickable inline citation using [DOI]{https://doi.org/...}, internal fragment link using citation format [fragmento N]{/library/...?...}, fragment/page when available, and a short quoted snippet from the evidence pack.
- Use "fragmento" in Spanish user-facing answers, not "chunk". Prefer the internal fragment link for claim-level citations and the DOI link for the public paper reference.
- Do not invent snippets, chunks, pages, paper links, DOI links, or citations; use only the evidence pack.
- Answer in the same language as the user's question.

${formatEvidencePackForPrompt(params.evidencePack)}

User question:
${params.question}

Draft response:
${params.draft}`;

  const response = await llm.createChatCompletion({
    model,
    messages: [{ role: "user", content: prompt }],
    maxTokens: 2200,
    temperature: 0,
  });

  return (
    response.content.trim() ||
    appendEvidenceNotice(params.draft, params.evidencePack)
  );
}

function appendEvidenceNotice(draft: string, pack: EvidencePack): string {
  if (pack.contradictions.length > 0) {
    return `${draft}\n\nNota de evidencia: hay claims contradictorios en Research Brain; tratá esta respuesta como síntesis provisional.`;
  }
  const hasSupportedEvidence =
    pack.supportedClaims.length > 0 ||
    pack.bioprospectingFacts.some((fact) => fact.status === "supported");
  const hasPartialEvidence =
    pack.partialClaims.length > 0 ||
    pack.bioprospectingFacts.some(
      (fact) => fact.status === "partial" || fact.status === "hypothesis",
    );

  if (hasPartialEvidence && !hasSupportedEvidence) {
    return `${draft}\n\nNota de evidencia: el soporte encontrado es parcial o hipotético, no concluyente.`;
  }
  return draft;
}
