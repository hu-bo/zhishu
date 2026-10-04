import type { DocumentContent, ExtensionRequirement } from '@zhishu/document-contracts';
export function downloadLocalDraft(input: {
  title: string;
  schemaVersion: number;
  extensions: ExtensionRequirement[];
  content: DocumentContent;
}) {
  const blob = new Blob(
    [
      JSON.stringify(
        {
          format: 'zhishu.document',
          formatVersion: 1,
          title: input.title,
          schemaVersion: input.schemaVersion,
          extensions: input.extensions,
          content: input.content,
        },
        null,
        2,
      ),
    ],
    { type: 'application/json;charset=utf-8' },
  );
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${input.title.replace(/[<>:"/\\|?*\p{Cc}]/gu, '_').slice(0, 100) || '本机草稿'}.zhishu.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
