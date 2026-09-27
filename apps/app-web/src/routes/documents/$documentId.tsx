import { useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, FileText, LoaderCircle } from 'lucide-react';
import { getDocument, updateDocumentMetadata } from '@/api/generated/app-api';
import { errorMessage } from '@/api/api-error';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DocumentCollaborationEditor,
  type DocumentCollaborationSnapshot,
} from './-document-collaboration-editor';

export const Route = createFileRoute('/documents/$documentId')({
  component: DocumentPage,
});

function DocumentPage() {
  const { documentId } = Route.useParams();
  const queryClient = useQueryClient();
  const document = useQuery({
    queryKey: ['document', documentId],
    queryFn: () => getDocument(documentId),
  });
  const [title, setTitle] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [collaborationSnapshot, setCollaborationSnapshot] =
    useState<DocumentCollaborationSnapshot | null>(null);

  const saveTitle = async () => {
    if (!document.data) return;
    const nextTitle = title?.trim();
    if (!nextTitle || nextTitle === document.data.title) {
      setTitle(null);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await updateDocumentMetadata(documentId, {
        title: nextTitle,
        metadataRevision: document.data.metadataRevision,
      });
      setTitle(null);
      queryClient.setQueryData(['document', documentId], updated);
      await queryClient.invalidateQueries({ queryKey: ['documents'] });
    } catch (error) {
      setSaveError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  if (document.isPending) {
    return (
      <div
        role="status"
        className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground"
      >
        <LoaderCircle size={17} className="animate-spin" aria-hidden="true" />
        正在打开文档…
      </div>
    );
  }
  if (document.isError) {
    return (
      <div role="alert" className="rounded-2xl border bg-card px-6 py-12 text-center">
        <h1 className="text-xl font-semibold">无法打开这篇文档</h1>
        <p className="mt-3 text-sm text-muted-foreground">{errorMessage(document.error)}</p>
        <Link
          to="/documents"
          search={{ view: 'recent', sort: 'recent', direction: 'desc', limit: 20, offset: 0 }}
          className={buttonVariants({ variant: 'outline', className: 'mt-5' })}
        >
          <ArrowLeft aria-hidden="true" /> 返回文档列表
        </Link>
      </div>
    );
  }

  const value = title ?? document.data.title;
  const currentCollaborationSnapshot =
    collaborationSnapshot?.documentId === documentId ? collaborationSnapshot : null;
  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <Link
        to="/documents"
        search={{ view: 'recent', sort: 'recent', direction: 'desc', limit: 20, offset: 0 }}
        className="inline-flex items-center gap-2 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
      >
        <ArrowLeft size={16} aria-hidden="true" /> 所有文档
      </Link>
      <section className="rounded-2xl border bg-card p-6 shadow-sm shadow-foreground/[0.02] sm:p-8">
        <div className="flex items-start gap-4">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-secondary text-primary">
            <FileText size={22} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <label className="sr-only" htmlFor="document-title">
              文档标题
            </label>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Input
                id="document-title"
                maxLength={200}
                className="h-11 text-lg font-semibold"
                value={value}
                onChange={(event) => setTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void saveTitle();
                  }
                }}
                onBlur={() => {
                  if (title !== null) void saveTitle();
                }}
                aria-describedby={saveError ? 'title-error' : undefined}
              />
              <Button
                className="h-11 sm:w-28"
                variant="outline"
                disabled={
                  saving || title === null || !title.trim() || title.trim() === document.data.title
                }
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void saveTitle()}
              >
                {saving ? (
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                ) : (
                  <Check aria-hidden="true" />
                )}
                保存标题
              </Button>
            </div>
            {saveError && (
              <p id="title-error" role="alert" className="mt-2 text-sm text-destructive">
                {saveError}
              </p>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              更新于{' '}
              {new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
                new Date(document.data.updatedAt),
              )}
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border bg-card p-6 sm:p-8">
        <h2 className="text-lg font-semibold">文档状态</h2>
        <dl className="mt-5 grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted-foreground">持久化更新</dt>
            <dd className="mt-1 font-medium">
              {(currentCollaborationSnapshot?.durableSeq ?? document.data.durableSeq) === 0
                ? '尚无正文更新'
                : `已确认 ${currentCollaborationSnapshot?.durableSeq ?? document.data.durableSeq} 次更新`}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">文档代次</dt>
            <dd className="mt-1 truncate font-mono text-sm">
              {currentCollaborationSnapshot?.generationId ?? document.data.generationId}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">内容 Schema</dt>
            <dd className="mt-1 font-medium">
              v{currentCollaborationSnapshot?.schemaVersion ?? document.data.schemaVersion}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">扩展</dt>
            <dd className="mt-1 font-medium">
              {(currentCollaborationSnapshot?.extensions ?? document.data.extensions).length
                ? (currentCollaborationSnapshot?.extensions ?? document.data.extensions)
                    .map((item) => item.name)
                    .join('、')
                : '基础内容'}
            </dd>
          </div>
        </dl>
      </section>

      <DocumentCollaborationEditor
        document={document.data}
        onStatusChange={setCollaborationSnapshot}
      />
    </div>
  );
}
