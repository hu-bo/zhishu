import { useEffect, useRef, useState } from "react";
import { createEditorSchema, type EditorController } from "@zhishu/editor-core";
import { prosemirrorJSONToYDoc, ySyncPluginKey } from "@tiptap/y-tiptap";
import { createTiptapCollaborationExtension } from "@zhishu/editor-collaboration/tiptap";
import * as Y from "yjs";
import type { DocumentContent } from "@zhishu/document-contracts";
import {
  EditorProvider,
  EditorSurface,
  useEditorInstance,
  useEditorSelector,
  type EditorHostServices,
  type EditorCollaborationSession,
  type EditorInstanceContextValue,
} from "@zhishu/editor-react";
import { defaultEditorNodeViews, EditorShell } from "@zhishu/editor-ui";
import { reactImageNodeViewExtension } from "./react-node-view-demo.js";

interface PendingUpload {
  signal: AbortSignal;
  complete: () => void;
}

interface LifecycleDemoState {
  instances: Map<
    string,
    { controller: EditorController; store: EditorInstanceContextValue["store"] }
  >;
  uploads: PendingUpload[];
  assetSignals: AbortSignal[];
  canceledUploads: number;
  canceledDocumentIds: string[];
  destroyedControllers: number;
  sessionSubscriptions: number;
  errors: string[];
  renders: { statistics: number; formatting: number };
}

declare global {
  interface Window {
    zhishuLifecycleDemo: LifecycleDemoState;
  }
}

const measurements: LifecycleDemoState = {
  instances: new Map(),
  uploads: [],
  assetSignals: [],
  canceledUploads: 0,
  canceledDocumentIds: [],
  destroyedControllers: 0,
  sessionSubscriptions: 0,
  errors: [],
  renders: { statistics: 0, formatting: 0 },
};
window.zhishuLifecycleDemo = measurements;

const content: DocumentContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      attrs: { blockId: "block_lifecycle_first" },
      content: [
        { type: "text", text: "加粗文字", marks: [{ type: "bold" }] },
        { type: "text", text: "和普通文字" },
      ],
    },
    {
      type: "codeBlock",
      attrs: { blockId: "block_lifecycle_code", language: "typescript" },
      content: [{ type: "text", text: "const document = '知书';" }],
    },
    {
      type: "image",
      attrs: {
        blockId: "block_lifecycle_image",
        assetId: "asset_lifecycle_image",
        mediaType: "image/png",
        alt: "用于局部错误恢复的示例图片",
      },
    },
    {
      type: "pdfAttachment",
      attrs: {
        blockId: "block_lifecycle_pdf",
        assetId: "asset_lifecycle_pdf",
        mediaType: "application/pdf",
        fileName: "lifecycle.pdf",
      },
    },
    {
      type: "paragraph",
      attrs: { blockId: "block_lifecycle_last" },
      content: [{ type: "text", text: "附件在上传开始时的末尾块之后插入。" }],
    },
  ],
};

const host: EditorHostServices = {
  // Intentionally let completion arrive after abort to exercise an uncooperative host.
  requestUpload: (file, signal) =>
    new Promise((resolve) => {
      measurements.uploads.push({
        signal,
        complete: () =>
          resolve({
            assetId: "asset_lifecycle_uploaded",
            mediaType: file.type,
            fileName: file.name,
          }),
      });
    }),
  cancelUpload: () => {
    measurements.canceledUploads += 1;
  },
  resolveAssetURL: (_assetId, signal) => {
    measurements.assetSignals.push(signal);
    return new Promise((_resolve, reject) => {
      const abort = () => reject(new DOMException("示例读取已取消", "AbortError"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  },
  reportError: (error) => measurements.errors.push(error.message),
};

function StatisticsProbe() {
  const statistics = useEditorSelector((snapshot) => snapshot.statistics);
  measurements.renders.statistics += 1;
  return <output aria-label="统计订阅">字符 {statistics.characterCount}</output>;
}

function FormattingProbe({ field }: { field: "bold" | "italic" }) {
  const activity = useEditorSelector((snapshot) => snapshot.formatting[field]);
  measurements.renders.formatting += 1;
  return <output aria-label="动态格式订阅">{`${field}:${activity}`}</output>;
}

function InstanceProbe({ name }: { name: string }) {
  const { controller, store } = useEditorInstance();
  useEffect(() => {
    if (!controller) return;
    measurements.instances.set(name, { controller, store });
    return () => {
      if (measurements.instances.get(name)?.controller === controller)
        measurements.instances.delete(name);
      queueMicrotask(() => {
        if (controller.isDestroyed) measurements.destroyedControllers += 1;
      });
    };
  }, [controller, name, store]);
  return null;
}

function createMemoryPair() {
  const seed = prosemirrorJSONToYDoc(
    createEditorSchema(),
    {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { blockId: "block_memory_peer" },
          content: [{ type: "text", text: "本地双端同步文字" }],
        },
      ],
    },
    "content",
  );
  const documents = [new Y.Doc(), new Y.Doc()];
  for (const document of documents) Y.applyUpdate(document, Y.encodeStateAsUpdate(seed));
  seed.destroy();
  const forward = (update: Uint8Array, origin: unknown) => {
    if (origin !== "memory-peer") Y.applyUpdate(documents[1]!, update, "memory-peer");
  };
  const backward = (update: Uint8Array, origin: unknown) => {
    if (origin !== "memory-peer") Y.applyUpdate(documents[0]!, update, "memory-peer");
  };
  documents[0]!.on("update", forward);
  documents[1]!.on("update", backward);
  const sessions: EditorCollaborationSession[] = documents.map((document) => ({
    key: `memory:${document.clientID}`,
    readOnly: false,
    getStatus: () => ({ connection: "connected", sync: "current", persistence: "unknown" }),
    subscribe: () => {
      measurements.sessionSubscriptions += 1;
      return () => {
        measurements.sessionSubscriptions -= 1;
      };
    },
    waitUntilSynced: async () => {},
    createEditorExtensions: async () => [createTiptapCollaborationExtension(document)],
  }));
  return {
    sessions,
    destroy: () => {
      documents[0]!.off("update", forward);
      documents[1]!.off("update", backward);
      for (const document of documents) document.destroy();
    },
  };
}

function MemoryCollaborationDemo() {
  const [pair, setPair] = useState<ReturnType<typeof createMemoryPair> | null>(null);
  useEffect(() => {
    const current = createMemoryPair();
    setPair(current);
    return () => current.destroy();
  }, []);
  if (!pair) return null;
  return (
    <section>
      <h2>内存 Yjs 双端订阅</h2>
      <p>两个真实 Y.Doc 在内存中传递更新；此示例不连接服务器，也不代表服务端保存确认。</p>
      {pair.sessions.map((session, index) => (
        <EditorProvider
          key={session.key}
          collaboration={session}
          options={{
            documentId: "doc_memory_pair",
            collaborative: true,
            collaborationStructure: {
              mode: "disabled",
              isRemoteTransaction: (transaction) =>
                Boolean(
                  (transaction.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)
                    ?.isChangeOrigin,
                ),
            },
          }}
        >
          <InstanceProbe name={`peer-${index}`} />
          <EditorSurface ariaLabel={`内存协同正文 ${index + 1}`} />
        </EditorProvider>
      ))}
    </section>
  );
}

export function LifecycleDemo() {
  const [mounted, setMounted] = useState(true);
  const [documentIndex, setDocumentIndex] = useState(0);
  const [editable, setEditable] = useState(true);
  const [theme, setTheme] = useState(false);
  const [field, setField] = useState<"bold" | "italic">("bold");
  const [bare, setBare] = useState(false);
  const [peers, setPeers] = useState(false);
  const renderCount = useRef(0);
  renderCount.current += 1;
  return (
    <main className="playground" data-host-render-count={renderCount.current}>
      <header className="page-heading">
        <h1>生命周期与宿主边界</h1>
        <p>
          公开包双实例消费：切换订阅字段、文档、主题或只读状态，验证局部错误恢复。附件服务为可手动完成的本地模拟，不连接存储。
        </p>
      </header>
      <div className="toolbar">
        <button onClick={() => setMounted((value) => !value)}>
          {mounted ? "卸载实例" : "挂载实例"}
        </button>
        <button onClick={() => setDocumentIndex((value) => value + 1)}>切换文档</button>
        <button onClick={() => setEditable((value) => !value)}>切换只读</button>
        <button onClick={() => setTheme((value) => !value)}>切换主题</button>
        <button onClick={() => setField((value) => (value === "bold" ? "italic" : "bold"))}>
          切换订阅字段
        </button>
        <button onClick={() => setBare((value) => !value)}>切换默认 UI</button>
        <button onClick={() => measurements.uploads.at(-1)?.complete()}>完成模拟上传</button>
        <button onClick={() => setPeers((value) => !value)}>
          {peers ? "关闭内存协同" : "打开内存协同"}
        </button>
      </div>
      {mounted && (
        <div className="editor-grid">
          <section className={theme ? "editor-card editor-card--dark" : "editor-card"}>
            <EditorProvider
              options={{
                documentId: `doc_lifecycle_${documentIndex}`,
                content,
                extensions: [reactImageNodeViewExtension],
              }}
              editable={editable}
              readOnlyReason={editable ? undefined : "宿主只读模式"}
              hostServices={{
                ...host,
                cancelUpload: (file) => {
                  measurements.canceledDocumentIds.push(`doc_lifecycle_${documentIndex}`);
                  return host.cancelUpload?.(file);
                },
              }}
              nodeViews={defaultEditorNodeViews}
            >
              <InstanceProbe name="primary" />
              <FormattingProbe field={field} />
              <StatisticsProbe />
              {bare ? (
                <EditorSurface ariaLabel="无默认 UI 正文" />
              ) : (
                <EditorShell
                  ariaLabel="生命周期编辑器"
                  surfaceLabel="生命周期正文"
                  slashMenu
                  selectionMenu
                  linkEditor
                  outline
                  find
                  statisticsFooter
                />
              )}
            </EditorProvider>
          </section>
          <section className="editor-card">
            <EditorProvider options={{ documentId: "doc_lifecycle_secondary", content }}>
              <InstanceProbe name="secondary" />
              <EditorSurface ariaLabel="独立实例正文" />
            </EditorProvider>
          </section>
        </div>
      )}
      {peers && <MemoryCollaborationDemo />}
    </main>
  );
}
