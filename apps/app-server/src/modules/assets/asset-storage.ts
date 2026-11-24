import { Client } from "minio";
import type { AppConfig } from "../../config.js";

/** What a stored object reports back; `completeUpload` compares these to its own upload session. */
export type StoredObject = {
  size: number;
  mediaType: string;
  /** `x-amz-meta-sha256` as written by the uploader, empty when the object carries none. */
  sha256: string;
};

/** A read URL plus its validity; `expiresAt: null` means the URL never expires. */
export type AssetReadUrl = {
  url: string;
  expiresAt: string | null;
};

/** SigV4 caps a presigned URL at seven days, so a longer request is clamped rather than honored. */
const MAX_SIGNED_URL_TTL_SECONDS = 604_800;

function createClient(
  config: AppConfig,
  endpoint: string,
  credentials: { accessKey: string; secretKey: string },
): Client {
  const url = new URL(endpoint);
  const useSSL = url.protocol === "https:";
  const defaultPort = useSSL ? 443 : 80;
  return new Client({
    endPoint: url.hostname,
    port: url.port ? Number(url.port) : defaultPort,
    useSSL,
    // Unset here means the client asks the bucket for its region and caches it. A wrong pinned
    // region breaks both API calls and presigned URLs, so only set it when it is known.
    region: config.ASSET_STORAGE_REGION,
    accessKey: credentials.accessKey,
    secretKey: credentials.secretKey,
    // MinIO defaults to path-style requests, which is what we need: the public endpoint has no
    // per-bucket subdomain, so every browser-facing URL must resolve through the same host.
  });
}

function contentDisposition(fileName: string, disposition: "inline" | "attachment"): string {
  const fallback = fileName
    .replace(/[\r\n"\\]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_")
    .slice(0, 150);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

// `statObject` keeps the response headers it recognises and strips the `x-amz-meta-` prefix from
// user metadata, so a header lookup can come back missing when the object was written elsewhere.
function headerValue(metaData: Record<string, unknown>, key: string): string {
  const value = metaData[key];
  return typeof value === "string" ? value : "";
}

/**
 * A region redirect reaches us through two fields minio-js fills from the response, not the error
 * name: `amzBucketRegion` from the `x-amz-bucket-region` header (the only channel a HEAD has, since
 * its body is dropped) and `region` from an XML error body. The library's own redirect handling
 * looks for `error.name` + `error.Region`, neither of which its parser ever sets, so it never fires.
 */
function redirectRegion(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  const fromHeader =
    "amzBucketRegion" in error && typeof error.amzBucketRegion === "string"
      ? error.amzBucketRegion
      : "";
  const fromBody = "region" in error && typeof error.region === "string" ? error.region : "";
  const candidate = fromHeader === code ? "" : fromHeader || (fromBody !== code ? fromBody : "");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(candidate)) return null;
  // An unlabelled 400 that still names a bucket region counts: the answer is authoritative either way.
  return code === "" || code === "AuthorizationHeaderMalformed" ? candidate : null;
}

// MinIO reports an S3 error code plus message, but a non-S3 answer (proxy, TLS mismatch) leaves the
// message empty, so boot logs would say nothing about why the storage check failed.
function describeStorageError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code =
    "code" in error && typeof error.code === "string" && error.code ? error.code : error.name;
  return `${code}: ${error.message || "no message"}`;
}

export class AssetObjectStorage {
  private readonly endpoint: string;
  private readonly bucket: string;
  private readonly publicBaseUrl: string;
  private readonly client: Client;
  private readonly signer: Client;

  constructor(private readonly config: AppConfig) {
    const endpoint = config.ASSET_STORAGE_ENDPOINT;
    const accessKey = config.ASSET_STORAGE_ACCESS_KEY_ID;
    const secretKey = config.ASSET_STORAGE_SECRET_ACCESS_KEY;
    if (!endpoint || !accessKey || !secretKey) {
      throw new Error("Private object storage is not configured");
    }
    const credentials = { accessKey, secretKey };
    const publicEndpoint = config.ASSET_STORAGE_PUBLIC_ENDPOINT ?? endpoint;
    this.endpoint = endpoint;
    this.bucket = config.ASSET_STORAGE_BUCKET;
    this.publicBaseUrl = publicEndpoint.replace(/\/+$/, "");
    this.client = createClient(config, endpoint, credentials);
    this.signer = createClient(config, publicEndpoint, credentials);
  }

  /**
   * Runs one storage call and, if the server asks for a different signing region, adopts it and
   * retries once. The region a bucket reports is authoritative for both API calls and presigned
   * URLs, so it also replaces a configured value that turned out to be wrong.
   */
  private async withRegionRedirect<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const region = redirectRegion(error);
      if (!region) throw error;
      this.client.region = region;
      this.signer.region = region;
      return run();
    }
  }

  /**
   * Checks the bucket on boot. A wrong endpoint, credential or region surfaces here as an error;
   * only a confirmed missing bucket may be created here.
   */
  async initialize(): Promise<void> {
    let exists: boolean;
    try {
      exists = await this.withRegionRedirect(() => this.client.bucketExists(this.bucket));
    } catch (error) {
      throw new Error(
        `Asset storage is not usable at ${this.endpoint} (bucket ${this.bucket}): ${describeStorageError(error)}`,
        { cause: error },
      );
    }
    if (exists) return;
    if (!this.config.ASSET_STORAGE_AUTO_CREATE_BUCKET) {
      throw new Error(`Asset storage bucket ${this.bucket} does not exist`);
    }
    await this.withRegionRedirect(() => this.client.makeBucket(this.bucket));
  }

  /**
   * Signs a browser-side PUT for an upload session. The signature covers the host only, so the
   * uploader still chooses `Content-Type` and `x-amz-meta-sha256`; `completeUpload` reads both back
   * and rejects the object unless they match the session, which is what keeps a direct upload honest.
   */
  async createUploadUrl(input: { objectKey: string; expiresIn: number }): Promise<string> {
    return this.withRegionRedirect(() =>
      this.signer.presignedPutObject(this.bucket, input.objectKey, input.expiresIn),
    );
  }

  /** Reads the first bytes of an object, enough to match a media type against its magic number. */
  async readPrefix(objectKey: string, length: number): Promise<Buffer> {
    const stream = await this.withRegionRedirect(() =>
      this.client.getPartialObject(this.bucket, objectKey, 0, length),
    );
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  async put(input: {
    objectKey: string;
    bytes: Buffer;
    mediaType: string;
    sha256: string;
  }): Promise<void> {
    // `Content-Type` is a supported header and passes through; other keys become x-amz-meta-*.
    await this.withRegionRedirect(() =>
      this.client.putObject(this.bucket, input.objectKey, input.bytes, input.bytes.byteLength, {
        "Content-Type": input.mediaType,
        sha256: input.sha256,
      }),
    );
  }

  async head(objectKey: string): Promise<StoredObject> {
    const stat = await this.withRegionRedirect(() =>
      this.client.statObject(this.bucket, objectKey),
    );
    return {
      size: stat.size,
      mediaType: headerValue(stat.metaData, "content-type"),
      sha256: headerValue(stat.metaData, "sha256"),
    };
  }

  async delete(objectKey: string): Promise<void> {
    await this.withRegionRedirect(() => this.client.removeObject(this.bucket, objectKey));
  }

  /**
   * `expiresIn: 0` returns the unsigned object URL, which stays valid forever once the bucket
   * allows anonymous reads; a signed URL is capped at seven days by SigV4. Without a signature the
   * `response-*` overrides are unavailable, so a PDF opens inline instead of downloading.
   */
  async createReadUrl(input: {
    objectKey: string;
    fileName: string;
    mediaType: string;
    expiresIn: number;
  }): Promise<AssetReadUrl> {
    const encodedKey = input.objectKey
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    if (input.expiresIn <= 0) {
      return { url: `${this.publicBaseUrl}/${this.bucket}/${encodedKey}`, expiresAt: null };
    }
    const ttl = Math.min(input.expiresIn, MAX_SIGNED_URL_TTL_SECONDS);
    const url = await this.withRegionRedirect(() =>
      this.signer.presignedGetObject(this.bucket, input.objectKey, ttl, {
        "response-content-disposition": contentDisposition(
          input.fileName,
          input.mediaType.startsWith("image/") ? "inline" : "attachment",
        ),
        "response-content-type": input.mediaType,
        "response-cache-control": "private, no-store",
      }),
    );
    return { url, expiresAt: new Date(Date.now() + ttl * 1_000).toISOString() };
  }
}
