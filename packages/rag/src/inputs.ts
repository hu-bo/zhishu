import type { DocumentSnapshot } from "@zhishu/document-contracts";

export type RagDocumentSource =
  | DocumentSnapshot
  | {
      format: "markdown" | "html" | "csv";
      sourceId: string;
      content: string;
      title?: string;
      /** CSV only; defaults to comma and a header row. Duplicate headers remain distinct columns. */
      delimiter?: string;
      hasHeader?: boolean;
    };

/** Bind credentials, tenant boundaries, authorization and provider-specific calls in the application. */
export interface ImageStorage {
  uploadImage(input: {
    sourceId: string;
    bytes: Uint8Array;
    mediaType: string;
    fileName: string;
    sha256: string;
    signal: AbortSignal;
  }): Promise<{ url: string }>;
  /** Required for assetId, external URLs and relative paths. The package never fetches these itself. */
  readImage?(input: {
    sourceId: string;
    reference: string;
    assetId?: string;
    signal: AbortSignal;
  }): Promise<{ bytes: Uint8Array; mediaType?: string }>;
}
export interface DocumentParseOptions {
  imageStorage?: ImageStorage;
  signal?: AbortSignal;
  limits?: {
    maxInputBytes?: number;
    maxImageBytes?: number;
    maxTotalImageBytes?: number;
    maxImages?: number;
    maxRows?: number;
    maxColumns?: number;
  };
}

export interface UploadedImage {
  sha256: string;
  url: string;
  mediaType: string;
  byteLength: number;
}

export interface NormalizedBlock {
  id: string;
  kind: "text" | "code" | "table" | "image";
  locatorKind: "block" | "section";
  titlePath: string[];
  text: string;
}
export interface NormalizedDocument {
  sourceId: string;
  blocks: NormalizedBlock[];
  images: UploadedImage[];
}

export const parseLimits = (options: DocumentParseOptions) => {
  const limits = {
    maxInputBytes: 16 * 1024 * 1024,
    maxImageBytes: 10 * 1024 * 1024,
    maxTotalImageBytes: 50 * 1024 * 1024,
    maxImages: 256,
    maxRows: 20_000,
    maxColumns: 256,
    ...options.limits,
  };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("INVALID_PARSE_LIMITS");
  }
  return limits;
};
