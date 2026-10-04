import type { GetDocument200 } from '@/api/generated/models';
import { PanelDialog } from '@/components/ui/panel-dialog';
import type { DocumentCollaborationSnapshot } from './document-collaboration-editor';

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '暂无' : dateTimeFormatter.format(date);
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words font-medium">{children}</dd>
    </div>
  );
}

/** Document metadata + technical state, moved out of the page body into a dialog. */
export function DocumentInfoDialog({
  open,
  onOpenChange,
  document,
  snapshot,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  document: GetDocument200;
  snapshot?: DocumentCollaborationSnapshot | null;
}) {
  const durableSeq = snapshot?.durableSeq ?? document.durableSeq;
  const generationId = snapshot?.generationId ?? document.generationId;
  const schemaVersion = snapshot?.schemaVersion ?? document.schemaVersion;
  const extensions = snapshot?.extensions ?? document.extensions;
  return (
    <PanelDialog
      open={open}
      onOpenChange={onOpenChange}
      title="文档详情"
      description="这篇文档的基本信息与内容技术状态。"
    >
      <div className="grid gap-8 sm:grid-cols-2">
        <dl className="space-y-4 text-sm">
          <Item label="创建者">{document.createdBy}</Item>
          <Item label="文档模式">
            {document.mode === 'standard' ? '普通快照 · 显式保存' : '实时协同 · 自动保存'}
          </Item>
          <Item label="创建时间">
            <time dateTime={document.createdAt}>{formatDateTime(document.createdAt)}</time>
          </Item>
          <Item label="最近更新">
            <time dateTime={document.updatedAt}>{formatDateTime(document.updatedAt)}</time>
          </Item>
          <Item label="管理权限">{document.canManage ? '可以管理文档' : '无管理权限'}</Item>
          <Item label="标签">
            {document.tags.map((tag) => tag.label).join(' · ') || '暂无标签'}
          </Item>
        </dl>
        <dl className="space-y-4 text-sm">
          <Item label="持久化更新">
            {durableSeq === 0 ? '尚无正文更新' : `已确认 ${durableSeq} 次更新`}
          </Item>
          <Item label="文档代次">
            <span className="font-mono text-xs">{generationId}</span>
          </Item>
          <Item label="内容 Schema">v{schemaVersion}</Item>
          <Item label="扩展">
            {extensions.length ? extensions.map((item) => item.name).join('、') : '基础内容'}
          </Item>
        </dl>
      </div>
    </PanelDialog>
  );
}
