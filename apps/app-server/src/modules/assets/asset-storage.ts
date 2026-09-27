import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { AppConfig } from "../../config.js";

function createClient(config: AppConfig, endpoint: string): S3Client {
  return new S3Client({
    region: config.ASSET_STORAGE_REGION,
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.ASSET_STORAGE_ACCESS_KEY_ID!,
      secretAccessKey: config.ASSET_STORAGE_SECRET_ACCESS_KEY!,
    },
  });
}

function isMissingBucket(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    candidate.name === "NotFound" ||
    candidate.name === "NoSuchBucket" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

function contentDisposition(fileName: string, disposition: "inline" | "attachment"): string {
  const fallback = fileName
    .replace(/[\r\n"\\]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_")
    .slice(0, 150);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export class AssetObjectStorage {
  private readonly client: S3Client;
  private readonly signer: S3Client;

  constructor(private readonly config: AppConfig) {
    if (
      !config.ASSET_STORAGE_ENDPOINT ||
      !config.ASSET_STORAGE_ACCESS_KEY_ID ||
      !config.ASSET_STORAGE_SECRET_ACCESS_KEY
    ) {
      throw new Error("Private object storage is not configured");
    }
    this.client = createClient(config, config.ASSET_STORAGE_ENDPOINT);
    this.signer = createClient(
      config,
      config.ASSET_STORAGE_PUBLIC_ENDPOINT ?? config.ASSET_STORAGE_ENDPOINT,
    );
  }

  async initialize(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.config.ASSET_STORAGE_BUCKET }));
    } catch (error) {
      if (!this.config.ASSET_STORAGE_AUTO_CREATE_BUCKET || !isMissingBucket(error)) throw error;
      await this.client.send(new CreateBucketCommand({ Bucket: this.config.ASSET_STORAGE_BUCKET }));
    }
  }

  async put(input: {
    objectKey: string;
    bytes: Buffer;
    mediaType: string;
    sha256: string;
  }): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.ASSET_STORAGE_BUCKET,
        Key: input.objectKey,
        Body: input.bytes,
        ContentLength: input.bytes.byteLength,
        ContentType: input.mediaType,
        Metadata: { sha256: input.sha256 },
      }),
    );
  }

  async head(objectKey: string) {
    return this.client.send(
      new HeadObjectCommand({ Bucket: this.config.ASSET_STORAGE_BUCKET, Key: objectKey }),
    );
  }

  async delete(objectKey: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.ASSET_STORAGE_BUCKET, Key: objectKey }),
    );
  }

  async createReadUrl(input: {
    objectKey: string;
    fileName: string;
    mediaType: string;
    expiresIn: number;
  }): Promise<string> {
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.config.ASSET_STORAGE_BUCKET,
        Key: input.objectKey,
        ResponseContentDisposition: contentDisposition(
          input.fileName,
          input.mediaType.startsWith("image/") ? "inline" : "attachment",
        ),
        ResponseContentType: input.mediaType,
        ResponseCacheControl: "private, no-store",
      }),
      { expiresIn: input.expiresIn },
    );
  }

  close(): void {
    if (this.signer !== this.client) this.signer.destroy();
    this.client.destroy();
  }
}
