import type { DocumentSnapshot, SnapshotCompatibilityOptions } from "@zhishu/document-contracts";
import type {
  AssistantPluginId,
  AssistantRunContext,
  DocumentVersion,
  EvidenceArtifactResolver,
  WritingRequest,
  EvidenceBundle,
} from "@zhishu/ai-contracts";

/**
 * Pure writing input. The application owns the thread and run identities; the proposal
 * payload never copies them. This type must stay free of DSH, LangChain and database
 * references so the compiler sub-entry can be consumed independently.
 */
export interface WritingInput {
  /** Stable per-conversation thread identity used for deterministic Block IDs. */
  threadId: string;
  /** Run identity: proposal content binds to it externally, never inside the payload. */
  runId: string;
  /** Target baseline captured in the Run context at admission. */
  document: DocumentVersion;
  baseStructureRevision: number;
  request: WritingRequest;
  snapshot: DocumentSnapshot & { generationId: string; durableSeq: number };
  evidence?: EvidenceBundle;
  prompt: { id: string; version: string; systemInstruction: string };
  /** Only the currently allowed turns; the host rebuilds this after any revision change. */
  history?: { role: "user" | "assistant"; content: string }[];
}

/**
 * Free draft input for a user-accepted create-draft Run. There is no target document yet;
 * the compiled content becomes the initial body of the document created at binding time.
 */
export interface DraftInput {
  threadId: string;
  runId: string;
  title?: string;
  prompt: { id: string; version: string; systemInstruction: string };
}

export interface CompilerOptions {
  compatibility?: SnapshotCompatibilityOptions;
  researchAvailable?: boolean;
  webAvailable?: boolean;
  /** Resolves an evidenceId to its committed artifact id; citations must carry it. */
  artifactResolver?: EvidenceArtifactResolver;
}

/**
 * Typed turn access for plugin installers. The runtime owns the accepted run context;
 * plugins re-check their own capability on every execution, never trust installation alone.
 */
export interface PluginTurnAccess {
  readonly conversationId: string;
  currentTurn():
    | {
        runId: string;
        attempt: number;
        contextRevision: number;
        context: AssistantRunContext;
      }
    | undefined;
}

/** Effective run context or a fail-closed error; tools must not run without an accepted turn. */
export function requireTurnContext(
  access: PluginTurnAccess,
  plugin: AssistantPluginId,
): AssistantRunContext {
  const turn = access.currentTurn();
  if (!turn) throw new Error("NO_ACTIVE_RUN");
  if (!turn.context.plugins.includes(plugin)) throw new Error("PLUGIN_DISABLED");
  return turn.context;
}
