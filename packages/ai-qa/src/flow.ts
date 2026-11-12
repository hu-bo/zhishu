import { Value } from "@sinclair/typebox/value";
import {
  QaAnswerOutputSchema,
  type Citation,
  type EvidenceBundle,
  type EvidenceRef,
  type QaAnswer,
  type ScopeSelection,
} from "@zhishu/ai-contracts";

/**
 * Bounded answer flow: resolve scope → optional single rewrite → retrieval → evidence
 * registration → generation with bounded citation repair → final authorization re-check.
 * Every external effect arrives through injected ports so this engine owns no store,
 * no model SDK and no checkpoint. Recovery replays committed steps, never the model.
 */

export interface QaRunInput {
  runId: string;
  conversationId: string;
  question: string;
  /** Only currently permitted history; the host rebuilds this after any revision change. */
  history: readonly { role: "user" | "assistant"; text: string }[];
  scope: ScopeSelection;
  retrieval: { contextTokenBudget: number; maxEvidenceItems: number; maxRepairRounds: number };
  signal: AbortSignal;
  /** Committed facts from earlier attempts of this Run; skipped steps must stay valid. */
  resume?: {
    evidence?: { bundle: EvidenceBundle; evidenceArtifactId: string };
    staged?: { answer: QaAnswer };
  };
  /** Current execution attempt; recorded by the host alongside the staged result. */
  attempt: number;
}

export type QaStepName = "scope" | "rewrite" | "retrieve" | "generate" | "validate" | "stage";

export interface QaFlowPorts {
  onStep(stepId: string, status: "running" | "done"): Promise<void>;
  /** Optional single bounded anaphora rewrite; must never widen scope or read forbidden history. */
  rewrite?(input: {
    question: string;
    history: QaRunInput["history"];
    signal: AbortSignal;
  }): Promise<{
    query: string;
    changed: boolean;
    inputTokens: number;
    outputTokens: number;
  }>;
  retrieve(input: {
    query: string;
    scope: ScopeSelection;
    tokenBudget: number;
    signal: AbortSignal;
  }): Promise<EvidenceBundle>;
  /** Host persists the evidence artifact; identity is server-generated and idempotent. */
  registerEvidence(input: {
    bundle: EvidenceBundle;
    stepId: string;
    signal: AbortSignal;
  }): Promise<{ evidenceArtifactId: string; evidenceRefs: EvidenceRef[] }>;
  /** The generation adapter owns the model call and reports settled token usage. */
  generate(input: {
    question: string;
    query: string;
    history: QaRunInput["history"];
    evidence: EvidenceBundle;
    evidenceArtifactId: string;
    repairFeedback?: string;
    signal: AbortSignal;
  }): Promise<{ output: unknown; inputTokens: number; outputTokens: number }>;
  /** Final delivery authorization check over the exact items handed to the model. */
  verifyEvidence(input: { bundle: EvidenceBundle; signal: AbortSignal }): Promise<boolean>;
  /** Host writes the single assistant message as staged before the delivery transaction. */
  stage(input: { answer: QaAnswer; attempt: number; signal: AbortSignal }): Promise<void>;
}

export interface QaOutcome {
  status: "answered" | "insufficient-evidence";
  answer: QaAnswer;
  evidenceArtifactId?: string;
  evidenceRefs: EvidenceRef[];
  usage: {
    modelCalls: number;
    inputTokens: number;
    outputTokens: number;
    retrievalCalls: number;
    evidenceItems: number;
  };
  steps: { stepId: string; name: QaStepName }[];
}

export class QaFlowError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "QaFlowError";
  }
}

/** Resolve a model citation against registered evidence; fabrications return undefined. */
function resolveCitation(
  output: { evidenceId: string; quote: string },
  bundle: EvidenceBundle,
  evidenceArtifactId: string,
  index: number,
): Citation | undefined {
  const item = bundle.items.find((candidate) => candidate.evidenceId === output.evidenceId);
  if (!item) return;
  const offset = item.text.indexOf(output.quote);
  if (offset < 0) return;
  if (item.locator.kind === "page")
    return {
      citationId: `citation_${index + 1}`,
      evidenceArtifactId,
      evidenceId: item.evidenceId,
      locator: structuredClone(item.locator),
      quote: output.quote,
    };
  const locator =
    item.locator.kind === "block"
      ? {
          ...item.locator,
          start: item.locator.start + offset,
          end: item.locator.start + offset + output.quote.length,
        }
      : {
          ...item.locator,
          start: item.locator.start + offset,
          end: item.locator.start + offset + output.quote.length,
        };
  return {
    citationId: `citation_${index + 1}`,
    evidenceArtifactId,
    evidenceId: item.evidenceId,
    locator,
    quote: output.quote,
  };
}

export async function runQaAnswerFlow(ports: QaFlowPorts, input: QaRunInput): Promise<QaOutcome> {
  const { signal } = input;
  const steps: { stepId: string; name: QaStepName }[] = [];
  const record = async (stepId: string, name: QaStepName) => {
    steps.push({ stepId, name });
    await ports.onStep(stepId, "running");
    await ports.onStep(stepId, "done");
  };
  let modelCalls = 0,
    inputTokens = 0,
    outputTokens = 0;

  await record("scope", "scope");

  let query = input.question;
  if (ports.rewrite && input.history.length) {
    const rewrite = await ports.rewrite({
      question: input.question,
      history: input.history,
      signal,
    });
    modelCalls++;
    inputTokens += rewrite.inputTokens;
    outputTokens += rewrite.outputTokens;
    if (rewrite.changed) query = rewrite.query;
    await record("rewrite", "rewrite");
  }

  let bundle: EvidenceBundle;
  let evidenceArtifactId: string | undefined;
  let evidenceRefs: EvidenceRef[] = [];
  let retrievalCalls = 0;
  if (input.resume?.evidence) {
    bundle = input.resume.evidence.bundle;
    evidenceArtifactId = input.resume.evidence.evidenceArtifactId;
    steps.push({ stepId: "retrieve", name: "retrieve" });
  } else {
    bundle = await ports.retrieve({
      query,
      scope: input.scope,
      tokenBudget: input.retrieval.contextTokenBudget,
      signal,
    });
    retrievalCalls++;
    if (bundle.items.length > input.retrieval.maxEvidenceItems)
      bundle = { ...bundle, items: bundle.items.slice(0, input.retrieval.maxEvidenceItems) };
    if (bundle.items.length) {
      const registered = await ports.registerEvidence({ bundle, stepId: "retrieve", signal });
      evidenceArtifactId = registered.evidenceArtifactId;
      evidenceRefs = registered.evidenceRefs;
    }
    await record("retrieve", "retrieve");
  }

  // A fully empty authorized scope answers without invoking the model: no facts to ground on.
  if (!bundle.items.length) {
    const answer: QaAnswer = {
      status: "insufficient-evidence",
      text: "当前范围内没有检索到可用资料，无法基于证据回答。可以调整选择的范围或换一种问法。",
      citations: [],
    };
    await ports.stage({ answer, attempt: input.attempt, signal });
    return {
      status: "insufficient-evidence",
      answer,
      evidenceRefs: [],
      usage: { modelCalls, inputTokens, outputTokens, retrievalCalls, evidenceItems: 0 },
      steps,
    };
  }

  // Committed staged result: deliver after re-authorization, never regenerate.
  let answer: QaAnswer;
  if (input.resume?.staged) {
    answer = input.resume.staged.answer;
    steps.push({ stepId: "generate", name: "generate" });
  } else {
    const artifactId = evidenceArtifactId!;
    let feedback: string | undefined;
    for (let round = 0; ; round++) {
      if (round > input.retrieval.maxRepairRounds) throw new QaFlowError("INVALID_CITATION");
      const generated = await ports.generate({
        question: input.question,
        query,
        history: input.history,
        evidence: bundle,
        evidenceArtifactId: artifactId,
        repairFeedback: feedback,
        signal,
      });
      modelCalls++;
      inputTokens += generated.inputTokens;
      outputTokens += generated.outputTokens;
      if (!Value.Check(QaAnswerOutputSchema, generated.output)) {
        feedback = "输出不符合结构要求：status/text/citations 必须齐全且长度受限。";
        continue;
      }
      const output = generated.output;
      if (output.status === "insufficient-evidence") {
        answer = { status: "insufficient-evidence", text: output.text, citations: [] };
        break;
      }
      const citations: Citation[] = [];
      let invalid = false;
      for (const [index, citation] of output.citations.entries()) {
        const resolved = resolveCitation(citation, bundle, artifactId, index);
        if (!resolved) {
          invalid = true;
          break;
        }
        citations.push(resolved);
      }
      if (invalid || citations.length === 0) {
        feedback = "引用必须使用已登记的 evidenceId，且 quote 逐字来自证据文本；请修正后重新提交。";
        continue;
      }
      answer = { status: "answered", text: output.text, citations, evidenceArtifactId: artifactId };
      break;
    }
    await record("generate", "generate");
    await ports.stage({ answer, attempt: input.attempt, signal });
  }

  // Delivery boundary always re-checks current authorization over everything handed to the model.
  if (!(await ports.verifyEvidence({ bundle, signal }))) throw new QaFlowError("ACCESS_REVOKED");
  await record("validate", "validate");
  await record("stage", "stage");
  return {
    status: answer.status,
    answer,
    evidenceArtifactId,
    evidenceRefs,
    usage: {
      modelCalls,
      inputTokens,
      outputTokens,
      retrievalCalls,
      evidenceItems: bundle.items.length,
    },
    steps,
  };
}
