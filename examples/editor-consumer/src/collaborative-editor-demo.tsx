import { useEffect, useState } from "react";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { createTiptapCollaborationExtension } from "@zhishu/editor-collaboration/tiptap";
import { HocuspocusCollaborationSession } from "@zhishu/editor-collaboration/hocuspocus";
import type { CollaborationSessionInfo } from "@zhishu/editor-collaboration";
import { EditorProvider, useEditorCollaborationStatus } from "@zhishu/editor-react";
import { EditorShell } from "@zhishu/editor-ui";
import * as Y from "yjs";

const apiBaseUrl = window.location.origin;

type LoginResponse = { accessToken: string };
type CreatedDocument = { id: string; generationId: string };
type CollaborativeDemoSession = {
  documentId: string;
  generationId: string;
  document: Y.Doc;
  session: HocuspocusCollaborationSession;
  extension: ReturnType<typeof createTiptapCollaborationExtension>;
};

async function requestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(new URL(path, apiBaseUrl), {
    ...options,
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`);
  return (await response.json()) as T;
}

function SessionStatus() {
  const status = useEditorCollaborationStatus();
  if (!status) return null;
  return (
    <output data-testid="collaboration-status" aria-live="polite">
      {status.connection}/{status.sync}/{status.persistence ?? "unknown"} · durableSeq{" "}
      {status.durableSeq ?? 0}
    </output>
  );
}

export function CollaborativeEditorDemo() {
  const [demo, setDemo] = useState<CollaborativeDemoSession | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    let document: Y.Doc | undefined;
    let session: HocuspocusCollaborationSession | undefined;
    void (async () => {
      try {
        const login = await requestJson<LoginResponse>("/api/auth/mock/login", { method: "POST" });
        if (!active) return;
        const authorization = { authorization: `Bearer ${login.accessToken}` };
        const created = await requestJson<CreatedDocument>("/api/documents", {
          method: "POST",
          headers: authorization,
          body: JSON.stringify({ title: "Tiptap React 协同结构验收" }),
        });
        if (!active) return;
        const createSession = () =>
          requestJson<CollaborationSessionInfo>(
            `/api/documents/${created.id}/collaboration-session`,
            {
              method: "POST",
              headers: authorization,
              body: JSON.stringify({ schemaVersion: 1, extensions: [] }),
            },
          );
        const info = await createSession();
        if (!active) return;
        document = new Y.Doc();
        session = new HocuspocusCollaborationSession({
          document,
          session: info,
          refreshSession: createSession,
        });
        await session.waitUntilSynced();
        if (!active) return;
        setDemo({
          documentId: created.id,
          generationId: info.generationId,
          document,
          session,
          extension: createTiptapCollaborationExtension(document),
        });
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "协同会话初始化失败");
      }
    })();
    return () => {
      active = false;
      session?.destroy();
      document?.destroy();
    };
  }, []);

  useEffect(() => {
    document.title = "Tiptap React 协同结构验收";
  }, []);

  if (error) return <main role="alert">协同会话启动失败：{error}</main>;
  if (!demo) return <main aria-busy="true">正在创建并同步协同文档…</main>;

  return (
    <main className="playground" data-document-id={demo.documentId}>
      <header className="page-heading">
        <p className="eyebrow">构建产物公开 API 消费验收</p>
        <h1>Tiptap / React 协同结构操作</h1>
        <p>先输入一段正文，再从 Block 操作菜单复制；操作应经服务端提交并获得持久化回执。</p>
      </header>
      <EditorProvider
        instanceKey={`${demo.documentId}:${demo.generationId}`}
        options={{
          documentId: demo.documentId,
          generationId: demo.generationId,
          collaborative: true,
          extensions: [demo.extension],
          collaborationStructure: {
            mode: "disabled",
            isRemoteTransaction: (transaction) =>
              Boolean(
                (transaction.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)
                  ?.isChangeOrigin,
              ),
          },
        }}
        collaboration={demo.session}
      >
        <EditorShell
          ariaLabel="真实 Tiptap React 协同编辑器"
          surfaceLabel="协同文档正文"
          surfaceClassName="editor-surface"
          title={<SessionStatus />}
          blockMenu
        />
      </EditorProvider>
    </main>
  );
}
