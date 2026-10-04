import type { EditorHostServices } from '@zhishu/editor-react';
import { ApiError } from '@/api/api-error';
import { apiFetch } from '@/api/transport';

type AssetUploadSession = {
  assetId: string;
  fileName: string;
  mediaType: string;
  uploadPath: string;
  completePath: string;
};

type PendingAssetUpload = { idempotencyKey: string; session?: AssetUploadSession };

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

        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 32_768) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
        }
        await apiFetch(session.uploadPath, {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataBase64: btoa(binary) }),
        });
        const uploaded = await apiFetch<{
          assetId: string;
          fileName: string;
          mediaType: string;
        }>(session.completePath, { method: 'POST', signal });

        pendingUploads.delete(file);
        return uploaded;
      } catch (error) {
        const canResume = error instanceof ApiError && (error.status === 0 || error.status === 503);
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
