import { Value } from "@sinclair/typebox/value";
import {
  AiEventSchema,
  ArtifactSchema,
  ConversationSchema,
  ConversationSnapshotSchema,
  MessageSchema,
  PreviewFrameSchema,
  ResyncFrameSchema,
  RunSchema,
  StreamFrameSchema,
  type AiEvent,
  type Artifact,
  type Conversation,
  type ConversationSnapshot,
  type Message,
  type PreviewFrame,
  type ResyncFrame,
  type Run,
  type StreamFrame,
} from "./session.js";
import {
  ApprovalDecisionSchema,
  BindTargetSchema,
  CreateDraftSchema,
  RetryRunCommandSchema,
  ReviewProposalSchema,
  SubmitMessageSchema,
  UpdateScopeSchema,
  type ApprovalDecision,
  type BindTarget,
  type CreateDraft,
  type RetryRunCommand,
  type ReviewProposal,
  type SubmitMessage,
  type UpdateScope,
} from "./commands.js";

export const isSubmitMessage = (value: unknown): value is SubmitMessage =>
  Value.Check(SubmitMessageSchema, value);
export const isUpdateScope = (value: unknown): value is UpdateScope =>
  Value.Check(UpdateScopeSchema, value);
export const isApprovalDecision = (value: unknown): value is ApprovalDecision =>
  Value.Check(ApprovalDecisionSchema, value);
export const isReviewProposal = (value: unknown): value is ReviewProposal =>
  Value.Check(ReviewProposalSchema, value);
export const isRetryRunCommand = (value: unknown): value is RetryRunCommand =>
  Value.Check(RetryRunCommandSchema, value);
export const isCreateDraft = (value: unknown): value is CreateDraft =>
  Value.Check(CreateDraftSchema, value);
export const isBindTarget = (value: unknown): value is BindTarget =>
  Value.Check(BindTargetSchema, value);
export const isAiEvent = (value: unknown): value is AiEvent => Value.Check(AiEventSchema, value);
export const isPreviewFrame = (value: unknown): value is PreviewFrame =>
  Value.Check(PreviewFrameSchema, value);
export const isResyncFrame = (value: unknown): value is ResyncFrame =>
  Value.Check(ResyncFrameSchema, value);
export const isStreamFrame = (value: unknown): value is StreamFrame =>
  Value.Check(StreamFrameSchema, value);
export const isConversationSnapshot = (value: unknown): value is ConversationSnapshot =>
  Value.Check(ConversationSnapshotSchema, value);
export const isConversation = (value: unknown): value is Conversation =>
  Value.Check(ConversationSchema, value);
export const isRun = (value: unknown): value is Run => Value.Check(RunSchema, value);
export const isMessage = (value: unknown): value is Message => Value.Check(MessageSchema, value);
export const isArtifact = (value: unknown): value is Artifact => Value.Check(ArtifactSchema, value);
