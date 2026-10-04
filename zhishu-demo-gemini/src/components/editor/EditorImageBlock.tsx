/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import {
  Image as ImageIcon,
  Settings2,
  RefreshCw,
  XCircle,
  AlertCircle,
  Check,
  ShieldCheck,
} from 'lucide-react';
import { documentAssetService } from '../../services/-document-asset-services.ts';

interface EditorImageBlockProps {
  assetId?: string;
  imageAlt?: string;
  imageWidth?: number | string;
  imageHeight?: number | string;
  signedAuthUrl?: string;
  isReadOnly?: boolean;
  onUpdateProps?: (props: {
    imageAlt?: string;
    imageWidth?: string;
    imageHeight?: string;
  }) => void;
  onDeleteBlock?: () => void;
}

export const EditorImageBlock: React.FC<EditorImageBlockProps> = ({
  assetId,
  imageAlt = '图片',
  imageWidth = '100%',
  imageHeight = 'auto',
  signedAuthUrl,
  isReadOnly = false,
  onUpdateProps,
  onDeleteBlock,
}) => {
  const [isSelected, setIsSelected] = useState(false);
  const [isEditingProps, setIsEditingProps] = useState(false);
  const [altText, setAltText] = useState(imageAlt);
  const [widthInput, setWidthInput] = useState(String(imageWidth || '100%'));
  const [heightInput, setHeightInput] = useState(String(imageHeight || 'auto'));
  const [validationError, setValidationError] = useState<string | null>(null);

  // Resolved signed auth URL (short-lived URL kept in DOM state)
  const [resolvedUrl, setResolvedUrl] = useState<string>(() => {
    if (assetId) {
      return documentAssetService.resolveSignedAuthUrl(assetId, signedAuthUrl);
    }
    return signedAuthUrl || '';
  });

  const [hasImageError, setHasImageError] = useState(false);

  useEffect(() => {
    if (assetId) {
      const url = documentAssetService.resolveSignedAuthUrl(assetId, signedAuthUrl);
      setResolvedUrl(url);
    }
  }, [assetId, signedAuthUrl]);

  // Handle Dimension Validation (Illegal sizes rejected)
  const handleSaveProperties = (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);

    // Validate width
    const trimmedWidth = widthInput.trim();
    const isValidWidth =
      trimmedWidth === 'auto' ||
      trimmedWidth === '100%' ||
      /^([0-9]{1,4})(px|%|vw)?$/.test(trimmedWidth);

    if (!isValidWidth) {
      setValidationError('非法宽度尺寸！支持数字加 px、% 或 auto (如 600px, 80%, auto)');
      return;
    }

    // Validate height
    const trimmedHeight = heightInput.trim();
    const isValidHeight =
      trimmedHeight === 'auto' ||
      /^([0-9]{1,4})(px|%|vh)?$/.test(trimmedHeight);

    if (!isValidHeight) {
      setValidationError('非法高度尺寸！支持数字加 px、% 或 auto');
      return;
    }

    onUpdateProps?.({
      imageAlt: altText.trim(),
      imageWidth: trimmedWidth,
      imageHeight: trimmedHeight,
    });
    setIsEditingProps(false);
  };

  return (
    <div
      onClick={() => !isReadOnly && setIsSelected(true)}
      onBlur={() => setIsSelected(false)}
      className={`my-4 relative group rounded-lg border transition-all max-w-full ${
        isSelected && !isReadOnly
          ? 'ring-2 ring-indigo-500 border-indigo-400 bg-indigo-50/20'
          : 'border-slate-200 dark:border-slate-800'
      }`}
    >
      {/* 320px responsive container without horizontal overflow */}
      <div className="p-2 sm:p-3 overflow-hidden flex flex-col items-center">
        {hasImageError ? (
          <div className="w-full py-8 px-4 bg-slate-100 dark:bg-slate-800/80 rounded-lg flex flex-col items-center justify-center text-center text-slate-500 space-y-2">
            <ImageIcon className="w-8 h-8 text-slate-400" />
            <div className="text-xs font-medium">签名授权已过期或图片资源暂不可达</div>
            <button
              onClick={() => {
                if (assetId) {
                  const url = documentAssetService.resolveSignedAuthUrl(assetId, signedAuthUrl);
                  setResolvedUrl(url);
                  setHasImageError(false);
                }
              }}
              className="flex items-center gap-1.5 px-3 py-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md text-xs hover:bg-slate-50"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>刷新短时授权并重试</span>
            </button>
          </div>
        ) : (
          <img
            src={resolvedUrl}
            alt={altText}
            onError={() => setHasImageError(true)}
            style={{
              width: widthInput === 'auto' ? 'auto' : widthInput,
              height: heightInput === 'auto' ? 'auto' : heightInput,
              maxWidth: '100%',
              objectFit: 'contain',
            }}
            className="rounded-md shadow-xs transition-transform max-w-full h-auto"
          />
        )}

        {/* Caption & Asset Auth Badge */}
        <div className="w-full flex items-center justify-between mt-2 pt-1.5 border-t border-slate-100 dark:border-slate-800/60 text-[11px] text-slate-500 dark:text-slate-400">
          <span className="italic truncate max-w-[70%]">
            {altText || '无替代说明 (Alt)'}
          </span>
          <div className="flex items-center gap-1 text-[10px] text-indigo-600 dark:text-indigo-400">
            <ShieldCheck className="w-3 h-3" />
            <span className="font-mono">{assetId || 'ast_local'} (DOM签名授权)</span>
          </div>
        </div>
      </div>

      {/* Floating Toolbar on Hover/Selected */}
      {!isReadOnly && (
        <div className="absolute top-2 right-2 flex items-center gap-1 bg-white/90 dark:bg-slate-900/90 backdrop-blur-xs p-1 rounded-lg border border-slate-200 dark:border-slate-700 opacity-90 sm:opacity-0 group-hover:opacity-100 transition-opacity shadow-sm">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setIsEditingProps(!isEditingProps);
            }}
            className="p-1 text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 rounded"
            title="编辑替代文本与宽高尺寸"
          >
            <Settings2 className="w-3.5 h-3.5" />
          </button>
          {onDeleteBlock && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDeleteBlock();
              }}
              className="p-1 text-slate-400 hover:text-rose-600 rounded"
              title="删除图片块"
            >
              <XCircle className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}

      {/* Inline Dimension & Alt Editor Modal/Drawer */}
      {isEditingProps && !isReadOnly && (
        <div className="p-3 bg-slate-50 dark:bg-slate-800/90 border-t border-slate-200 dark:border-slate-700 animate-in fade-in duration-100">
          <form onSubmit={handleSaveProperties} className="space-y-2">
            <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
              图片属性设置 (已校验 320px 无溢出)
            </div>

            {validationError && (
              <div className="flex items-center gap-1.5 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 p-1.5 rounded-md border border-rose-200 dark:border-rose-900">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>{validationError}</span>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div>
                <label className="text-[11px] text-slate-500">替代文本 (Alt)：</label>
                <input
                  type="text"
                  value={altText}
                  onChange={(e) => setAltText(e.target.value)}
                  className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="text-[11px] text-slate-500">宽度 (Width)：</label>
                <input
                  type="text"
                  placeholder="100% 或 600px"
                  value={widthInput}
                  onChange={(e) => setWidthInput(e.target.value)}
                  className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="text-[11px] text-slate-500">高度 (Height)：</label>
                <input
                  type="text"
                  placeholder="auto 或 400px"
                  value={heightInput}
                  onChange={(e) => setHeightInput(e.target.value)}
                  className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setIsEditingProps(false)}
                className="px-2.5 py-1 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-200 rounded"
              >
                取消
              </button>
              <button
                type="submit"
                className="flex items-center gap-1 px-3 py-1 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded shadow-xs"
              >
                <Check className="w-3.5 h-3.5" />
                <span>保存属性写入 DOM/JSON</span>
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
