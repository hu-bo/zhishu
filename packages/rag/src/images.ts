import { createHash } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import type { DocumentParseOptions, UploadedImage } from "./inputs.js";
import { parseLimits } from "./inputs.js";

export function validateImageUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("INVALID_IMAGE_URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    value.length > 8_192 ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error("INVALID_IMAGE_URL");
  return url.href;
}

/** One owner and cache per parse; no process-wide cache can cross a tenant boundary. */
export function createImageProcessor(sourceId: string, options: DocumentParseOptions) {
  const signal = options.signal ?? new AbortController().signal,
    limits = parseLimits(options);
  const byReference = new Map<string, UploadedImage>(),
    byDigest = new Map<string, UploadedImage>();
  let imageCount = 0,
    totalBytes = 0;
  return {
    get images(): UploadedImage[] {
      return [...byDigest.values()];
    },
    async replace(reference: string, assetId?: string): Promise<string> {
      signal.throwIfAborted();
      if (++imageCount > limits.maxImages) throw new Error("IMAGE_LIMIT_EXCEEDED");
      const key = createHash("sha256")
        .update(JSON.stringify([reference, assetId]))
        .digest("hex");
      const cached = byReference.get(key);
      if (cached) return cached.url;
      if (!options.imageStorage) {
        if (assetId || !/^https?:\/\//i.test(reference)) throw new Error("IMAGE_STORAGE_REQUIRED");
        return validateImageUrl(reference);
      }
      let bytes: Uint8Array, declaredType: string | undefined;
      if (reference.startsWith("data:")) {
        const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/]*={0,2})$/i.exec(reference);
        if (!match || !match[2] || match[2].length % 4 !== 0) throw new Error("INVALID_IMAGE_DATA");
        if (
          (match[2].length / 4) * 3 -
            (match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0) >
          limits.maxImageBytes
        )
          throw new Error("IMAGE_TOO_LARGE");
        bytes = Buffer.from(match[2], "base64");
        declaredType = match[1]!.toLowerCase();
      } else {
        if (!options.imageStorage.readImage) throw new Error("IMAGE_READER_REQUIRED");
        let image: Awaited<ReturnType<NonNullable<typeof options.imageStorage.readImage>>>;
        try {
          image = await options.imageStorage.readImage({ sourceId, reference, assetId, signal });
        } catch {
          signal.throwIfAborted();
          throw new Error("IMAGE_READ_FAILED");
        }
        bytes = image.bytes;
        declaredType = image.mediaType?.toLowerCase();
      }
      signal.throwIfAborted();
      if (
        !(bytes instanceof Uint8Array) ||
        !bytes.byteLength ||
        bytes.byteLength > limits.maxImageBytes
      )
        throw new Error("IMAGE_TOO_LARGE");
      let detected: Awaited<ReturnType<typeof fileTypeFromBuffer>>;
      try {
        detected = await fileTypeFromBuffer(bytes);
      } catch {
        throw new Error("INVALID_IMAGE_MEDIA_TYPE");
      }
      if (!detected?.mime.startsWith("image/") || (declaredType && declaredType !== detected.mime))
        throw new Error("INVALID_IMAGE_MEDIA_TYPE");
      const sha256 = createHash("sha256").update(bytes).digest("hex"),
        previous = byDigest.get(sha256);
      if (previous) {
        byReference.set(key, previous);
        return previous.url;
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > limits.maxTotalImageBytes) throw new Error("IMAGE_BYTES_EXCEEDED");
      let uploaded: { url: string };
      signal.throwIfAborted();
      try {
        uploaded = await options.imageStorage.uploadImage({
          sourceId,
          bytes,
          mediaType: detected.mime,
          fileName: `${sha256}.${detected.ext}`,
          sha256,
          signal,
        });
      } catch {
        signal.throwIfAborted();
        throw new Error("IMAGE_UPLOAD_FAILED");
      }
      signal.throwIfAborted();
      const image: UploadedImage = {
        sha256,
        url: validateImageUrl(uploaded.url),
        mediaType: detected.mime,
        byteLength: bytes.byteLength,
      };
      byDigest.set(sha256, image);
      byReference.set(key, image);
      return image.url;
    },
  };
}
