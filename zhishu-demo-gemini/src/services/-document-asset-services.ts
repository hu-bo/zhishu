/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * -document-asset-services.ts
 * 
 * 文档级宿主适配器：
 * 普通快照与协同文档共用该服务。
 * 上传会话、幂等重试、取消清理和短时 URL 解析从同一处实现；
 * 正文只写稳定 assetId 与媒体信息，授权 URL 留在 DOM 状态中。
 */

export interface AssetUploadSession {
  sessionId: string;
  assetId: string;
  filename: string;
  mimeType: string;
  fileSize: number;
  status: 'idle' | 'uploading' | 'failed' | 'success' | 'cancelled';
  progress: number;
  retryCount: number;
  error?: string;
  signedUrl?: string;
  expiresAt?: number;
}

export interface UploadOptions {
  injectFailureFirst?: boolean;
  rejectMimeTypes?: string[];
}

class DocumentAssetService {
  private sessions: Map<string, AssetUploadSession> = new Map();
  private authUrlCache: Map<string, { url: string; expiresAt: number }> = new Map();

  /**
   * 创建上传会话 (支持幂等性重试)
   */
  public createUploadSession(
    file: { name: string; type: string; size: number },
    existingSessionId?: string
  ): AssetUploadSession {
    if (existingSessionId && this.sessions.has(existingSessionId)) {
      const existing = this.sessions.get(existingSessionId)!;
      // 重用会话，重置错误
      existing.status = 'idle';
      existing.progress = 0;
      existing.error = undefined;
      existing.retryCount += 1;
      return existing;
    }

    const sessionId = existingSessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const assetId = `ast_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    
    const session: AssetUploadSession = {
      sessionId,
      assetId,
      filename: file.name,
      mimeType: file.type || 'application/octet-stream',
      fileSize: file.size,
      status: 'idle',
      progress: 0,
      retryCount: 0,
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * 执行上传：模拟存储网关往返，支持 MIME 校验，首次注入拒绝与重试
   */
  public async uploadAsset(
    sessionId: string,
    fileData: string | Blob,
    options?: UploadOptions,
    onProgress?: (progress: number) => void
  ): Promise<{ assetId: string; signedAuthUrl: string }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Upload session [${sessionId}] not found`);
    }

    // 检查 MIME 类型校验
    const allowedImageMimes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'];
    const allowedPdfMimes = ['application/pdf'];
    const isImage = allowedImageMimes.includes(session.mimeType);
    const isPdf = allowedPdfMimes.includes(session.mimeType);

    if (!isImage && !isPdf) {
      session.status = 'failed';
      session.error = `不支持的文件类型: ${session.mimeType}。仅支持常见图片或 PDF。`;
      throw new Error(session.error);
    }

    // 故障注入测试 (如验收规范中所述)
    if (options?.injectFailureFirst && session.retryCount === 0) {
      session.status = 'failed';
      session.error = '存储网关连接暂时中断 (503 Service Unavailable)，请点击重试';
      throw new Error(session.error);
    }

    session.status = 'uploading';
    session.error = undefined;

    // 模拟上传分片进度
    for (let p = 20; p <= 100; p += 25) {
      const current = this.sessions.get(sessionId);
      if (!current || (current.status as string) === 'cancelled') {
        throw new Error('上传已取消');
      }
      session.progress = p;
      if (onProgress) onProgress(p);
      await new Promise((r) => setTimeout(r, 60));
    }

    // 生成短时授权签名 URL (15分钟有效期)
    const expiresAt = Date.now() + 15 * 60 * 1000;
    let signedAuthUrl = '';

    if (typeof fileData === 'string' && fileData.startsWith('data:')) {
      signedAuthUrl = fileData;
    } else {
      // 模拟生成的短时授权 URL
      signedAuthUrl = isPdf 
        ? `https://storage.zhishu.internal/auth-assets/${session.assetId}/${encodeURIComponent(session.filename)}?token=signed_${Date.now()}`
        : `https://images.unsplash.com/photo-1557804506-669a67965ba0?auto=format&fit=crop&w=1200&q=80`;
    }

    session.status = 'success';
    session.signedUrl = signedAuthUrl;
    session.expiresAt = expiresAt;

    this.authUrlCache.set(session.assetId, {
      url: signedAuthUrl,
      expiresAt,
    });

    return {
      assetId: session.assetId,
      signedAuthUrl,
    };
  }

  /**
   * 取消上传并清理未完成会话
   */
  public cancelUpload(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = 'cancelled';
      session.progress = 0;
      this.sessions.delete(sessionId);
    }
  }

  /**
   * 解析资产短时授权 URL (如过期则自动续签)
   */
  public resolveSignedAuthUrl(assetId: string, fallbackUrl?: string): string {
    const cached = this.authUrlCache.get(assetId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.url;
    }

    // 若过期或初次访问，刷新短时 URL 并缓存在 DOM 状态使用
    const refreshedUrl = fallbackUrl || `https://storage.zhishu.internal/auth-assets/${assetId}?refreshedToken=${Date.now()}`;
    this.authUrlCache.set(assetId, {
      url: refreshedUrl,
      expiresAt: Date.now() + 15 * 60 * 1000,
    });

    return refreshedUrl;
  }
}

export const documentAssetService = new DocumentAssetService();
