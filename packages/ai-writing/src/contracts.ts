import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/**
 * Browser-safe writing contracts: capability manifests, image job DTOs and the pure web
 * research port shapes. No DSH, LangChain or Node imports may appear in this entry.
 */

export const manifests = Object.freeze([
  { id: "writing", version: "1", artifactKind: "proposal", schemaVersion: 1 },
  { id: "platform-research", version: "1", artifactKind: "evidence", schemaVersion: 1 },
  { id: "web-research", version: "1", artifactKind: "evidence", schemaVersion: 1 },
  { id: "image", version: "1", artifactKind: "image", schemaVersion: 1 },
]);

export const ImageAssetSchema = Type.Object(
  {
    assetId: Type.String({ minLength: 1, maxLength: 160 }),
    mime: Type.Union([
      Type.Literal("image/png"),
      Type.Literal("image/jpeg"),
      Type.Literal("image/webp"),
    ]),
    width: Type.Integer({ minimum: 1 }),
    height: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type ImageAsset = Static<typeof ImageAssetSchema>;
export const ImageJobSchema = Type.Union([
  Type.Object(
    {
      id: Type.String({ minLength: 1, maxLength: 160 }),
      status: Type.Union([
        Type.Literal("pending"),
        Type.Literal("unknown"),
        Type.Literal("failed"),
      ]),
      code: Type.Optional(Type.String({ maxLength: 80 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      id: Type.String({ minLength: 1, maxLength: 160 }),
      status: Type.Literal("ready"),
      assets: Type.Array(ImageAssetSchema, { minItems: 1, maxItems: 1 }),
    },
    { additionalProperties: false },
  ),
]);
export type ImageJob = Static<typeof ImageJobSchema>;
export const isImageJob = (value: unknown): value is ImageJob => Value.Check(ImageJobSchema, value);

/** Image artifacts reference the controlled job/asset identities only. */
export const ImageArtifactPayloadSchema = Type.Object(
  {
    jobId: Type.String({ minLength: 1, maxLength: 160 }),
    assetId: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
    status: Type.Union([
      Type.Literal("pending"),
      Type.Literal("unknown"),
      Type.Literal("ready"),
      Type.Literal("failed"),
    ]),
  },
  { additionalProperties: false },
);
export type ImageArtifactPayload = Static<typeof ImageArtifactPayloadSchema>;

/**
 * Web research port implemented by the application (Tavily adapter). The writing package
 * never sees credentials; requests carry only the search terms and permitted context.
 */
export interface WebSearchCandidate {
  title: string;
  url: string;
  content: string;
  publishedAt?: string;
  score?: number;
}
export interface WebExtractResult {
  url: string;
  extracted?: string;
  base64Image?: undefined;
  error?: string;
}
export interface WebSearchOutcome {
  candidates: readonly WebSearchCandidate[];
  requestId?: string;
  creditsUsed?: number;
}
export interface WebExtractOutcome {
  results: readonly WebExtractResult[];
  requestId?: string;
  creditsUsed?: number;
}
export interface WebSearchPort {
  search(input: {
    query: string;
    maxResults: number;
    allowedDomains?: readonly string[];
    blockedDomains?: readonly string[];
    timeRange?: "day" | "week" | "month" | "year";
    signal: AbortSignal;
  }): Promise<WebSearchOutcome>;
  read(input: {
    urls: readonly string[];
    maxCharsPerUrl: number;
    signal: AbortSignal;
  }): Promise<WebExtractOutcome>;
}

/** Failure semantics surfaced by the web tools; a provider fault is never "no results". */
export type WebToolFailureCode =
  | "NOT_CONFIGURED"
  | "AUTH_FAILED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "NETWORK"
  | "EMPTY_RESULTS"
  | "EXTRACT_FAILED"
  | "BUDGET_EXCEEDED";
export class WebToolError extends Error {
  constructor(readonly code: WebToolFailureCode) {
    super(code);
    this.name = "WebToolError";
  }
}
