/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  CheckSquare,
  Code2,
  Table as TableIcon,
  Quote,
  Image as ImageIcon,
  FileUp,
  Undo2,
  Redo2,
  UploadCloud,
  AlertCircle,
  RefreshCw,
  X,
} from 'lucide-react';
import { BlockType } from '../../types/document';
import { documentAssetService, AssetUploadSession } from '../../services/-document-asset-services.ts';

interface EditorToolbarProps {
  onInsertBlock: (type: BlockType, extra?: any) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export const EditorToolbar: React.FC<EditorToolbarProps> = ({
  onInsertBlock,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
}) => {
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [uploadType, setUploadType] = useState<'image' | 'pdf'>('image');
  const [activeSession, setActiveSession] = useState<AssetUploadSession | null>(null);
  const [injectFailure, setInjectFailure] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  const startUploadSimulation = async (isRetry = false) => {
    setIsUploading(true);
    try {
      const mockFile =
        uploadType === 'image'
          ? { name: 'architecture_diagram.png', type: 'image/png', size: 1024 * 450 }
          : { name: 'spec_document.pdf', type: 'application/pdf', size: 1024 * 1024 * 2 };

      const session = documentAssetService.createUploadSession(
        mockFile,
        isRetry ? activeSession?.sessionId : undefined
      );
      setActiveSession({ ...session });

      const result = await documentAssetService.uploadAsset(
        session.sessionId,
        uploadType === 'image'
          ? 'https://images.unsplash.com/photo-1558494949-ef010cbdcc31?auto=format&fit=crop&w=1200&q=80'
          : 'https://storage.zhishu.internal/auth-assets/ast_pdf_01.pdf',
        { injectFailureFirst: injectFailure },
        (progress) => {
          setActiveSession((prev) => (prev ? { ...prev, progress } : null));
        }
      );

      // Successfully uploaded! Insert into editor
      if (uploadType === 'image') {
        onInsertBlock('image', {
          assetId: result.assetId,
          imageAlt: '已上传系统架构拓扑图',
          imageWidth: '100%',
          imageHeight: 'auto',
          signedAuthUrl: result.signedAuthUrl,
        });
      } else {
        onInsertBlock('pdf', {
          assetId: result.assetId,
          pdfFilename: '知书系统架构规范_v2.pdf',
          pdfFileSize: '2.0 MB',
          pdfPageCount: 8,
          signedAuthUrl: result.signedAuthUrl,
        });
      }

      setUploadModalOpen(false);
      setActiveSession(null);
    } catch (err: any) {
      if (activeSession) {
        setActiveSession((prev) =>
          prev
            ? {
                ...prev,
                status: 'failed',
                error: err.message || '上传失败',
              }
            : null
        );
      }
    } finally {
      setIsUploading(false);
    }
  };

  const handleCancelSession = () => {
    if (activeSession) {
      documentAssetService.cancelUpload(activeSession.sessionId);
    }
    setActiveSession(null);
    setUploadModalOpen(false);
  };

  return (
    <>
      <div className="sticky top-14 z-10 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xs border-b border-slate-200 dark:border-slate-800 px-4 py-1.5 flex items-center justify-between gap-1 overflow-x-auto">
        <div className="flex items-center gap-1">
          {/* Undo / Redo */}
          <button
            type="button"
            disabled={!canUndo}
            onClick={onUndo}
            className="p-1.5 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md disabled:opacity-30 transition-colors"
            title="撤销 (Ctrl+Z)"
          >
            <Undo2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            disabled={!canRedo}
            onClick={onRedo}
            className="p-1.5 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md disabled:opacity-30 transition-colors"
            title="重做 (Ctrl+Y)"
          >
            <Redo2 className="w-3.5 h-3.5" />
          </button>

          <div className="w-px h-4 bg-slate-200 dark:bg-slate-800 mx-1" />

          {/* Heading Levels */}
          <button
            type="button"
            onClick={() => onInsertBlock('heading', { headingLevel: 1 })}
            className="p-1.5 text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors"
            title="插入 1 级标题"
          >
            <Heading1 className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => onInsertBlock('heading', { headingLevel: 2 })}
            className="p-1.5 text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors"
            title="插入 2 级标题"
          >
            <Heading2 className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => onInsertBlock('heading', { headingLevel: 3 })}
            className="p-1.5 text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors"
            title="插入 3 级标题"
          >
            <Heading3 className="w-4 h-4" />
          </button>

          <div className="w-px h-4 bg-slate-200 dark:bg-slate-800 mx-1" />

          {/* Lists */}
          <button
            type="button"
            onClick={() => onInsertBlock('bullet-list')}
            className="p-1.5 text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors"
            title="无序列表"
          >
            <List className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => onInsertBlock('ordered-list')}
            className="p-1.5 text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors"
            title="有序列表"
          >
            <ListOrdered className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => onInsertBlock('task-list')}
            className="p-1.5 text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors"
            title="待办任务清单"
          >
            <CheckSquare className="w-4 h-4" />
          </button>

          <div className="w-px h-4 bg-slate-200 dark:bg-slate-800 mx-1" />

          {/* Code, Table, Callout */}
          <button
            type="button"
            onClick={() => onInsertBlock('code')}
            className="p-1.5 text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors"
            title="插入代码块 (EditorCodeBlockView)"
          >
            <Code2 className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => onInsertBlock('table')}
            className="p-1.5 text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors"
            title="插入表格"
          >
            <TableIcon className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => onInsertBlock('callout')}
            className="p-1.5 text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors"
            title="插入引用提示块"
          >
            <Quote className="w-4 h-4" />
          </button>

          <div className="w-px h-4 bg-slate-200 dark:bg-slate-800 mx-1" />

          {/* Asset uploads via host adapter */}
          <button
            type="button"
            onClick={() => {
              setUploadType('image');
              setUploadModalOpen(true);
            }}
            className="flex items-center gap-1 px-2 py-1 text-xs text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors"
            title="上传图片 (短时鉴权URL)"
          >
            <ImageIcon className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">插入图片</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setUploadType('pdf');
              setUploadModalOpen(true);
            }}
            className="flex items-center gap-1 px-2 py-1 text-xs text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors"
            title="上传 PDF 附件"
          >
            <FileUp className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">插入 PDF</span>
          </button>
        </div>
      </div>

      {/* Asset Upload Host Adapter Modal (Supporting session idempotency, retry, cancellation, fault injection) */}
      {uploadModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-xs p-4 animate-in fade-in duration-150">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center gap-2">
                <UploadCloud className="w-4 h-4 text-indigo-600" />
                <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                  宿主资产适配器上传会话 (-document-asset-services)
                </h3>
              </div>
              <button
                onClick={handleCancelSession}
                className="text-slate-400 hover:text-slate-600 p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <p className="text-xs text-slate-500 leading-relaxed">
                正文只写入稳定的 assetId 与媒体参数，真实的授权短时 URL 保留在 DOM 状态中。系统已内置幂等重试、取消清理和短时 URL 续签机制。
              </p>

              {/* Fault injection checkbox for browser testing */}
              <div className="p-2.5 bg-slate-50 dark:bg-slate-800/60 rounded-lg border border-slate-200 dark:border-slate-700 flex items-center justify-between">
                <div className="text-xs text-slate-700 dark:text-slate-300">
                  <div className="font-medium">故障注入验收开关：</div>
                  <div className="text-[11px] text-slate-400">模拟存储服务首次 503 拒绝以测试会话重试</div>
                </div>
                <input
                  type="checkbox"
                  checked={injectFailure}
                  onChange={(e) => setInjectFailure(e.target.checked)}
                  className="rounded text-indigo-600 focus:ring-indigo-500 w-4 h-4"
                />
              </div>

              {/* Progress & Error status */}
              {activeSession && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-slate-700 dark:text-slate-300">
                      {activeSession.filename}
                    </span>
                    <span className="font-mono text-slate-500">{activeSession.progress}%</span>
                  </div>

                  <div className="w-full bg-slate-200 dark:bg-slate-700 h-1.5 rounded-full overflow-hidden">
                    <div
                      className="bg-indigo-600 h-full transition-all duration-150"
                      style={{ width: `${activeSession.progress}%` }}
                    />
                  </div>

                  {activeSession.status === 'failed' && (
                    <div className="p-2.5 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg flex items-start gap-2 text-xs text-rose-600 dark:text-rose-400">
                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                      <div>
                        <div className="font-semibold">上传受阻：</div>
                        <div className="text-[11px]">{activeSession.error}</div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="px-5 py-3 bg-slate-50 dark:bg-slate-800/40 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
              <button
                type="button"
                onClick={handleCancelSession}
                className="px-3 py-1.5 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-200 rounded-lg"
              >
                取消上传并清理会话
              </button>

              {activeSession?.status === 'failed' ? (
                <button
                  type="button"
                  onClick={() => startUploadSimulation(true)}
                  className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg shadow-xs"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>复用同一会话重试</span>
                </button>
              ) : (
                <button
                  type="button"
                  disabled={isUploading}
                  onClick={() => startUploadSimulation(false)}
                  className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg shadow-xs disabled:opacity-50"
                >
                  {isUploading && (
                    <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  )}
                  <span>开始上传写入</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
