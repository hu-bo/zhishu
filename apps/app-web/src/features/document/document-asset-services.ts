import type { EditorHostServices } from '@zhishu/editor-react';
import { ApiError } from '@/api/api-error';
import { apiFetch } from '@/api/transport';

type AssetUploadSession = {
  assetId: string;
  fileName: string;
  mediaType: string;
  uploadUrl: string;
  completePath: string;
};

type PendingAssetUpload = { idempotencyKey: string; session?: AssetUploadSession };

// The digest is declared by the uploader and echoed back by the bucket: `PUT` carries it as
// `x-amz-meta-sha256`, `/complete` re-reads it from the object so a stale or swapped object cannot
// be confirmed. Subtle crypto needs a secure context (https or localhost).
async function sha256Hex(file: File): Promise<string> {
  if (!crypto.subtle) {
    throw new Error('当前页面不是安全上下文，无法计算文件摘要；请改用 https 或 localhost 访问。');
  }
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createDocumentAssetServices(documentId: string): {
  hostServices: EditorHostServices;
  dispose: () => void;
} {
  const pendingUploads = new Map<File, PendingAssetUpload>();
  let disposed = false;

  const cancelSession = (session: AssetUploadSession) =>
    apiFetch(`/api/asset-uploads/${encodeURIComponent(session.assetId)}`, {
      method: 'DELETE',
    }).catch(() => undefined);

  const hostServices: EditorHostServices = {
    requestUpload: async (file, signal) => {
      let pending = pendingUploads.get(file);
      if (!pending) {
        pending = { idempotencyKey: crypto.randomUUID() };
        pendingUploads.set(file, pending);
      }

      let session = pending.session;
      try {
        if (!session) {
          session = await apiFetch<AssetUploadSession>(
            `/api/documents/${encodeURIComponent(documentId)}/asset-uploads`,
            {
              method: 'POST',
              signal,
              headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': pending.idempotencyKey,
              },
              body: JSON.stringify({
                fileName: file.name,
                mediaType: file.type,
                size: file.size,
              }),
            },
          );
          pending.session = session;
        }

        const sha256 = await sha256Hex(file);
        // Bytes go straight to the bucket, so this is a plain fetch without the API credentials.
        const uploaded = await fetch(session.uploadUrl, {
          method: 'PUT',
          signal,
          body: file,
          headers: { 'x-amz-meta-sha256': sha256 },
        });
        if (!uploaded.ok) {
          throw new Error(`附件直传失败（${uploaded.status}），请检查对象存储跨域与证书配置。`);
        }

        const completed = await apiFetch<{
          assetId: string;
          fileName: string;
          mediaType: string;
        }>(session.completePath, {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sha256 }),
        });

        pendingUploads.delete(file);
        return completed;
      } catch (error) {
        // A dropped direct upload leaves the session open: retrying re-PUTs the same object key.
        const canResume =
          error instanceof TypeError ||
          (error instanceof ApiError && (error.status === 0 || error.status === 503));
        if (!canResume || disposed) {
          pendingUploads.delete(file);
          if (session) await cancelSession(session);
        }
        throw error;
      }
    },
    cancelUpload: async (file) => {
      const pending = pendingUploads.get(file);
      pendingUploads.delete(file);
      if (pending?.session) await cancelSession(pending.session);
    },
    resolveAssetURL: async (assetId, signal) => {
      const access = await apiFetch<{ url: string }>(
        `/api/assets/${encodeURIComponent(assetId)}/access`,
        { signal },
      );
      return access.url;
    },
  };

  return {
    hostServices,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const pending of pendingUploads.values()) {
        if (pending.session) void cancelSession(pending.session);
      }
      pendingUploads.clear();
    },
  };
}
