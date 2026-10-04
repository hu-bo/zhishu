import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { updateDocumentMetadata } from '@/api/generated/app-api';
import type { GetDocument200 } from '@/api/generated/models';
import { errorMessage } from '@/api/api-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const tagColors = {
  slate: 'bg-slate-500/10 text-slate-600 dark:text-slate-300',
  indigo: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-300',
  violet: 'bg-violet-500/10 text-violet-600 dark:text-violet-300',
  green: 'bg-green-500/10 text-green-700 dark:text-green-300',
  amber: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  rose: 'bg-rose-500/10 text-rose-600 dark:text-rose-300',
} as const;
type TagColor = keyof typeof tagColors;

const tagColorLabels: Record<TagColor, string> = {
  slate: '灰',
  indigo: '蓝',
  violet: '紫',
  green: '绿',
  amber: '黄',
  rose: '红',
};

const tagColorDots: Record<TagColor, string> = {
  slate: 'bg-slate-500',
  indigo: 'bg-indigo-500',
  violet: 'bg-violet-500',
  green: 'bg-green-500',
  amber: 'bg-amber-500',
  rose: 'bg-rose-500',
};

export function DocumentMetadata({
  document,
  editable,
}: {
  document: GetDocument200;
  editable: boolean;
}) {
  const queryClient = useQueryClient();
  const [icon, setIcon] = useState(document.icon ?? '');
  const [tags, setTags] = useState(document.tags);
  const [label, setLabel] = useState('');
  const [color, setColor] = useState<TagColor>('indigo');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await updateDocumentMetadata(document.id, {
        icon: icon.trim() || null,
        tags,
        metadataRevision: document.metadataRevision,
      });
      queryClient.setQueryData(['document', document.id], updated);
      await queryClient.invalidateQueries({ queryKey: ['documents'] });
      await queryClient.invalidateQueries({ queryKey: ['catalog-children'] });
      await queryClient.invalidateQueries({ queryKey: ['knowledge-search'] });
      setNotice('文档信息已保存。');
    } catch (cause) {
      setError(errorMessage(cause));
      // Refresh the base revision without replacing the user's metadata draft.
      await queryClient.invalidateQueries({ queryKey: ['document', document.id] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="rounded-xl border bg-card px-4 py-3 text-sm">
      <summary className="cursor-pointer font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
        文档信息{' '}
        {document.tags.length > 0 && (
          <span className="ml-2 text-xs text-muted-foreground">{document.tags.length} 个标签</span>
        )}
      </summary>
      <div className="mt-4 space-y-4">
        <p className="text-xs text-muted-foreground">
          创建者：{document.createdBy} · 创建于{' '}
          {new Date(document.createdAt).toLocaleDateString('zh-CN')}
        </p>
        <div className="flex flex-wrap gap-2" aria-label="文档标签">
          {(editable ? tags : document.tags).map((tag) => (
            <span
              key={tag.label}
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs ${tagColors[tag.color]}`}
            >
              {tag.label}
              {editable && (
                <button
                  type="button"
                  className="rounded px-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  disabled={busy}
                  aria-label={`移除标签 ${tag.label}`}
                  onClick={() =>
                    setTags((current) => current.filter((item) => item.label !== tag.label))
                  }
                >
                  ×
                </button>
              )}
            </span>
          ))}
          {!document.tags.length && !editable && (
            <span className="text-muted-foreground">暂无标签</span>
          )}
        </div>
        {editable && (
          <>
            <div className="flex flex-wrap items-end gap-2">
              <label className="space-y-1 text-xs">
                Emoji 图标
                <Input
                  aria-label="Emoji 图标"
                  className="w-24"
                  maxLength={32}
                  value={icon}
                  disabled={busy}
                  onChange={(event) => setIcon(event.target.value)}
                />
              </label>
              <label className="min-w-0 flex-1 space-y-1 text-xs">
                标签名称
                <Input
                  aria-label="新标签名称"
                  maxLength={24}
                  value={label}
                  disabled={busy}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </label>
              <div className="space-y-1 text-xs">
                <span id="tag-color-label">颜色</span>
                <Select
                  value={color}
                  onValueChange={(value) => {
                    if (value) setColor(value);
                  }}
                  items={tagColorLabels}
                >
                  <SelectTrigger
                    aria-labelledby="tag-color-label"
                    className="h-9 w-24"
                    disabled={busy}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(tagColors) as TagColor[]).map((key) => (
                      <SelectItem key={key} value={key}>
                        <span
                          className={`size-2.5 rounded-full ${tagColorDots[key]}`}
                          aria-hidden="true"
                        />
                        {tagColorLabels[key]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                variant="outline"
                disabled={
                  busy ||
                  !label.trim() ||
                  tags.length >= 12 ||
                  tags.some((tag) => tag.label === label.trim())
                }
                onClick={() => {
                  setTags((current) => [...current, { label: label.trim(), color }]);
                  setLabel('');
                }}
              >
                添加标签
              </Button>
            </div>
            <Button disabled={busy} onClick={() => void save()}>
              {busy ? '正在保存…' : '保存图标与标签'}
            </Button>
          </>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error} 可保留当前输入后重新保存。
          </p>
        )}
        {notice && (
          <p role="status" className="text-muted-foreground">
            {notice}
          </p>
        )}
      </div>
    </details>
  );
}
