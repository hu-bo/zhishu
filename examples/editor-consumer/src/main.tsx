import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Extension, type Extensions } from "@tiptap/core";
import { Plugin, type Transaction } from "@tiptap/pm/state";
import { createEditor, createEditorSchema } from "@zhishu/editor-core";
import {
  exportDocumentHtml,
  exportPlainText,
  importDocumentHtml,
  importPlainText,
} from "@zhishu/editor-core/conversions";
import {
  createBlockId,
  validateDocumentContent,
  type DocumentContent,
} from "@zhishu/document-contracts";
import {
  EditorBlockMenu,
  defaultEditorNodeViews,
  EditorShell,
  EditorToolbar,
} from "@zhishu/editor-ui";
import {
  EditorProvider,
  EditorSurface,
  useEditorEvents,
  useEditorInstance,
  useEditorSelector,
  type EditorHostServices,
} from "@zhishu/editor-react";
import "@zhishu/editor-ui/styles.css";
import { CollaborativeEditorDemo } from "./collaborative-editor-demo.js";
import { LifecycleDemo } from "./lifecycle-demo.js";
import { reactImageNodeViewExtension } from "./react-node-view-demo.js";
import { visualReviewContent } from "./visual-review-content.js";
import { createKnowledgePresets } from "@zhishu/document-contracts/examples";
import "./style.css";

const consumerParagraphNodeView = Extension.create({
  name: "consumerParagraphNodeView",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          nodeViews: {
            paragraph: (node) => {
              const dom = document.createElement("p");
              const contentDOM = document.createElement("span");
              dom.dataset.consumerNodeView = "paragraph";
              dom.dataset.blockId = String(node.attrs.blockId ?? "");
              dom.append(contentDOM);
              let currentNode = node;

              return {
                dom,
                contentDOM,
                update(nextNode) {
                  if (nextNode.type !== currentNode.type) return false;
                  currentNode = nextNode;
                  dom.dataset.blockId = String(nextNode.attrs.blockId ?? "");
                  return true;
                },
              };
            },
          },
        },
      }),
    ];
  },
});

const secondContent: DocumentContent = {
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { blockId: "block_second_title", level: 2 },
      content: [{ type: "text", text: "第二个编辑器" }],
    },
    {
      type: "taskItem",
      attrs: { blockId: "block_second_task", checked: false },
      content: [{ type: "text", text: "准备版本发布" }],
    },
    { type: "paragraph", attrs: { blockId: "block_second_body" } },
    {
      type: "image",
      attrs: {
        blockId: "block_second_image",
        assetId: "asset_second_image_preview",
        mediaType: "image/png",
        alt: "大尺寸图片占位，用于检查深色主题与正文宽度约束",
        width: 2400,
        height: 1600,
      },
    },
  ],
};

const rejectVisualReviewAsset: NonNullable<EditorHostServices["resolveAssetURL"]> = async () => {
  throw new Error("视觉验收样例未连接附件存储。");
};

const conversionContent: DocumentContent = {
  type: "doc",
  content: [
    {
      type: "taskList",
      attrs: { blockId: "block_conversion_tasks" },
      content: [
        {
          type: "taskItem",
          attrs: { blockId: "block_conversion_parent", checked: false },
          content: [{ type: "text", text: "准备版本发布" }],
        },
        {
          type: "taskList",
          attrs: { blockId: "block_conversion_subtasks" },
          content: [
            {
              type: "taskItem",
              attrs: { blockId: "block_conversion_changelog", checked: true },
              content: [{ type: "text", text: "检查更新日志" }],
            },
            {
              type: "taskList",
              attrs: { blockId: "block_conversion_checks" },
              content: [
                {
                  type: "taskItem",
                  attrs: { blockId: "block_conversion_announcement", checked: false },
                  content: [{ type: "text", text: "确认发布公告" }],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const blockCommandContent: DocumentContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      attrs: { blockId: "block_commands_first" },
      content: [{ type: "text", text: "Alpha Beta" }],
    },
    {
      type: "paragraph",
      attrs: { blockId: "block_commands_second" },
      content: [{ type: "text", text: "第二个段落" }],
    },
    {
      type: "bulletList",
      attrs: { blockId: "block_commands_list" },
      content: [
        {
          type: "listItem",
          attrs: { blockId: "block_commands_item_one" },
          content: [
            {
              type: "paragraph",
              attrs: { blockId: "block_commands_item_one_text" },
              content: [{ type: "text", text: "父级条目" }],
            },
          ],
        },
        {
          type: "listItem",
          attrs: { blockId: "block_commands_item_two" },
          content: [
            {
              type: "paragraph",
              attrs: { blockId: "block_commands_item_two_text" },
              content: [{ type: "text", text: "可缩进条目" }],
            },
          ],
        },
      ],
    },
  ],
};

const exampleRemoteTransactionMeta = "zhishu-example-remote";
const collaborationStructurePolicy = {
  mode: "disabled" as const,
  isRemoteTransaction: (transaction: Transaction) =>
    transaction.getMeta(exampleRemoteTransactionMeta) === true,
};
const collaborativeStructureContent: DocumentContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      attrs: { blockId: "block_guard_first" },
      content: [{ type: "text", text: "可以编辑文本；本地结构变化会被拦截。" }],
    },
    {
      type: "paragraph",
      attrs: { blockId: "block_guard_second" },
      content: [{ type: "text", text: "Block 操作菜单中的结构动作已禁用。" }],
    },
  ],
};

function FormattingControls({
  onToggleEditable,
  onToggleLoading,
  onLoadSaved,
  loadFeedback,
  instanceRevision,
  documentId,
  loading,
}: {
  onToggleEditable: () => void;
  onToggleLoading: () => void;
  onLoadSaved: () => void;
  loadFeedback: string;
  instanceRevision: number;
  documentId: string;
  loading: boolean;
}) {
  const { controller } = useEditorInstance();
  const editable = useEditorSelector((state) => state.isEditable);
  const [updates, setUpdates] = useState(0);
  const [lastOrigin, setLastOrigin] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    setUpdates(0);
    setLastOrigin(null);
    setSavedAt(null);
  }, [instanceRevision]);

  useEditorEvents((event) => {
    if (event.docChanged) {
      setUpdates((value) => value + 1);
      setLastOrigin(event.origin ?? "未标记");
    }
  });

  return (
    <div className="toolbar" aria-label="格式工具">
      <button type="button" aria-pressed={!editable} onClick={onToggleEditable}>
        {editable ? "进入只读" : "恢复编辑"}
      </button>
      <button type="button" onClick={onToggleLoading}>
        {loading ? "完成加载" : "重新加载"}
      </button>
      <button type="button" onClick={onLoadSaved}>
        恢复 JSON
      </button>
      <button
        type="button"
        disabled={!controller}
        onClick={() => {
          if (!controller) return;
          localStorage.setItem(
            `zhishu-example:${documentId}`,
            JSON.stringify(controller.getSnapshot()),
          );
          setSavedAt(new Date().toLocaleTimeString());
        }}
      >
        保存 JSON
      </button>
      <EditorToolbar />
      <span className="update-count" aria-live="polite">
        本地变更 {updates} · 来源 {lastOrigin ?? "—"} · {savedAt ? `已保存 ${savedAt}` : "尚未保存"}
        {loadFeedback ? ` · ${loadFeedback}` : ""}
      </span>
    </div>
  );
}

function EditorCard({
  title,
  documentId,
  content,
  extensions,
  theme = "light",
  assetResolver,
  simulatedUploads = false,
}: {
  title: string;
  documentId: string;
  content: DocumentContent;
  extensions?: Extensions;
  theme?: "light" | "dark";
  assetResolver?: EditorHostServices["resolveAssetURL"];
  simulatedUploads?: boolean;
}) {
  const [editable, setEditable] = useState(true);
  const [loading, setLoading] = useState(false);
  const [currentContent, setCurrentContent] = useState(content);
  const [contentRevision, setContentRevision] = useState(0);
  const [loadFeedback, setLoadFeedback] = useState("");
  const uploadAttemptsRef = useRef(0);

  const hostServices: EditorHostServices = {
    confirmExternalLink: (href) => window.confirm(`即将打开外部链接：\n${href}\n\n是否继续？`),
    openExternalLink: (href) => {
      window.open(href, "_blank", "noopener,noreferrer");
    },
    ...(assetResolver ? { resolveAssetURL: assetResolver } : {}),
    ...(simulatedUploads
      ? {
          requestUpload: async (file: File, signal: AbortSignal) => {
            const attempt = ++uploadAttemptsRef.current;
            await new Promise<void>((resolve, reject) => {
              const timer = window.setTimeout(() => {
                signal.removeEventListener("abort", onAbort);
                resolve();
              }, 900);
              const onAbort = () => {
                window.clearTimeout(timer);
                signal.removeEventListener("abort", onAbort);
                reject(new DOMException("示例上传已取消。", "AbortError"));
              };
              signal.addEventListener("abort", onAbort, { once: true });
              if (signal.aborted) onAbort();
            });
            if (attempt === 1) {
              throw new Error("本地示例：模拟首次上传失败，可重试或取消。");
            }
            return {
              assetId: `asset_demo_upload_${attempt}`,
              fileName: file.name,
              mediaType: file.type || "image/png",
            };
          },
          cancelUpload: (file: File) => setLoadFeedback(`已取消附件 ${file.name}`),
        }
      : {}),
  };

  const loadSavedContent = () => {
    const saved = localStorage.getItem(`zhishu-example:${documentId}`);
    if (!saved) {
      setLoadFeedback("没有可恢复的 JSON");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(saved);
    } catch {
      setLoadFeedback("保存的 JSON 格式无效");
      return;
    }
    const validation = validateDocumentContent(parsed);
    if (!validation.success) {
      setLoadFeedback("保存的 JSON 不符合文档合约");
      return;
    }

    setCurrentContent(validation.data);
    setContentRevision((value) => value + 1);
    setLoadFeedback("JSON 已恢复");
  };

  return (
    <EditorProvider
      instanceKey={`${documentId}:${contentRevision}`}
      options={{ documentId, content: currentContent, ...(extensions ? { extensions } : {}) }}
      nodeViews={defaultEditorNodeViews}
      loading={loading}
      editable={editable}
      readOnlyReason={editable ? undefined : "演示只读模式"}
      hostServices={hostServices}
    >
      <EditorShell
        className={`editor-card${theme === "dark" ? " editor-card--dark" : ""}`}
        ariaLabel={`${title}编辑器`}
        surfaceLabel={`${title}正文`}
        surfaceClassName="editor-surface"
        outline
        outlinePlacement="end"
        contentMaxWidth={896}
        statisticsFooter
        stickyToolbar
        find
        selectionMenu
        blockMenu
        linkEditor
        slashMenu
        outlineLabel={`${title}大纲`}
        title={
          <div>
            <h2>{title}</h2>
            <p>实例 ID：{documentId}</p>
          </div>
        }
        toolbar={
          <FormattingControls
            onToggleEditable={() => setEditable((value) => !value)}
            onToggleLoading={() => setLoading((value) => !value)}
            onLoadSaved={loadSavedContent}
            loadFeedback={loadFeedback}
            instanceRevision={contentRevision}
            documentId={documentId}
            loading={loading}
          />
        }
      />
    </EditorProvider>
  );
}

function EditorMountDemo() {
  const firstHostRef = useRef<HTMLDivElement>(null);
  const secondHostRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<ReturnType<typeof createEditor> | null>(null);
  const [activeHost, setActiveHost] = useState<0 | 1>(0);
  const [status, setStatus] = useState("正在初始化直接挂载实例");

  useEffect(() => {
    const firstHost = firstHostRef.current;
    if (!firstHost) return;

    const controller = createEditor({
      element: firstHost,
      documentId: "doc_mount_demo",
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { blockId: "block_mount_demo" },
            content: [{ type: "text", text: "切换挂载容器时，这段内容会保留。" }],
          },
        ],
      },
    });
    controller.setAriaLabel("直接挂载示例正文");
    controllerRef.current = controller;
    setStatus("已挂载到容器 1");

    const unsubscribe = controller.subscribe((event) => {
      if (event.docChanged) setStatus(`正文已更新 · 来源 ${event.origin ?? "未标记"}`);
    });
    return () => {
      unsubscribe();
      controller.destroy();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, []);

  const switchHost = () => {
    const controller = controllerRef.current;
    const nextHostIndex = activeHost === 0 ? 1 : 0;
    const nextHost = nextHostIndex === 0 ? firstHostRef.current : secondHostRef.current;
    if (!controller || !nextHost) return;

    try {
      controller.mount(nextHost);
      setActiveHost(nextHostIndex);
      setStatus(`已挂载到容器 ${nextHostIndex + 1}`);
    } catch {
      setStatus("容器切换失败");
    }
  };

  return (
    <section className="mount-demo" aria-labelledby="mount-demo-title">
      <div className="mount-demo-header">
        <div>
          <h2 id="mount-demo-title">Core 容器切换</h2>
          <p>演示 createEditor 的 DOM 挂载、跨容器重挂和销毁。</p>
        </div>
        <button type="button" onClick={switchHost} disabled={!controllerRef.current}>
          切换挂载容器
        </button>
      </div>
      <p className="mount-demo-status" aria-live="polite">
        {status}
      </p>
      <div className="mount-demo-host" hidden={activeHost !== 0} ref={firstHostRef} />
      <div className="mount-demo-host" hidden={activeHost !== 1} ref={secondHostRef} />
    </section>
  );
}

function ConversionDemo() {
  const [html, setHtml] = useState("");
  const [report, setReport] = useState("尚未运行格式转换");
  const [schema] = useState(() => createEditorSchema());

  const exportHtml = () => {
    const result = exportDocumentHtml(conversionContent, schema);
    const imported = result.success ? importDocumentHtml(result.value, schema) : result;
    setReport(
      JSON.stringify({
        exported: result.report,
        htmlRoundTrip: imported.success ? imported.report : imported.error,
        taskTreePreserved: imported.success && imported.value.content[0]?.type === "taskList",
      }),
    );
    if (result.success) setHtml(result.value);
  };

  const importUnsafeHtml = () => {
    const result = importDocumentHtml(
      '<p>安全<strong>内容</strong> <a href="javascript:alert(1)">危险链接</a><script>window.__zhishuUnsafeHtmlRan=true</script><img alt="图片替代文字" src="x" onerror="window.__zhishuUnsafeHtmlRan=true"></p><div data-type="taskList"><div data-type="taskItem" data-checked="false"><input type="checkbox" disabled><span data-task-content>准备版本发布</span></div><div data-type="taskList"><div data-type="taskItem" data-checked="true"><input type="checkbox" checked disabled><span data-task-content>检查更新日志</span></div></div></div>',
      schema,
    );
    setReport(
      JSON.stringify({
        success: result.success,
        report: result.report,
        taskTreePreserved:
          result.success && result.value.content.some((block) => block.type === "taskList"),
      }),
    );
    if (result.success) setHtml(JSON.stringify(result.value, null, 2));
  };

  const checkPlainText = () => {
    const exported = exportPlainText(conversionContent);
    const imported = exported.success ? importPlainText(exported.value) : exported;
    setReport(
      JSON.stringify({
        exported: exported.report,
        plainText: exported.success ? exported.value : exported.error.message,
        imported: imported.report,
        roundTrip: imported.success ? imported.value.content.length : imported.error.message,
      }),
    );
  };

  return (
    <section className="conversion-demo" aria-labelledby="conversion-demo-title">
      <div className="mount-demo-header">
        <div>
          <h2 id="conversion-demo-title">格式转换与安全报告</h2>
          <p>JSON 主格式无损；HTML 按基础 Schema 净化，纯文本报告结构损失。</p>
        </div>
      </div>
      <div className="retry-demo-actions">
        <button type="button" onClick={exportHtml}>
          导出基础 HTML
        </button>
        <button type="button" onClick={importUnsafeHtml}>
          清理测试 HTML
        </button>
        <button type="button" onClick={checkPlainText}>
          检查纯文本往返
        </button>
      </div>
      <label className="conversion-output">
        转换结果
        <textarea aria-label="格式转换结果" readOnly value={html} />
      </label>
      <p className="mount-demo-status" role="status">
        {report}
      </p>
    </section>
  );
}

function BlockCommandControls() {
  const { controller } = useEditorInstance();
  const [duplicateId, setDuplicateId] = useState<string>();
  const [duplicateListItemId, setDuplicateListItemId] = useState<string>();
  const [splitId, setSplitId] = useState<string>();
  const [status, setStatus] = useState("按 ID 执行单机 Block 操作");

  const recordResult = (result: ReturnType<NonNullable<typeof controller>["duplicateBlock"]>) => {
    setStatus(result.success ? `操作 ${result.operationId} 已应用` : result.error.message);
    return result;
  };

  return (
    <div className="block-command-actions">
      <button
        type="button"
        onClick={() => {
          if (!controller) return;
          const result = recordResult(controller.duplicateBlock("block_commands_first"));
          if (result.success) setDuplicateId(result.createdBlockIds[0]);
        }}
      >
        复制段落
      </button>
      <button
        type="button"
        disabled={!controller || Boolean(duplicateListItemId)}
        onClick={() => {
          if (!controller) return;
          const result = recordResult(controller.duplicateBlock("block_commands_item_two"));
          if (result.success) setDuplicateListItemId(result.createdBlockIds[0]);
        }}
      >
        复制嵌套列表项
      </button>
      <button
        type="button"
        disabled={!controller || !duplicateListItemId}
        onClick={() => {
          if (!controller || !duplicateListItemId) return;
          const result = recordResult(controller.deleteBlock(duplicateListItemId));
          if (result.success) setDuplicateListItemId(undefined);
        }}
      >
        删除嵌套副本
      </button>
      <button
        type="button"
        disabled={!controller || Boolean(splitId)}
        onClick={() => {
          if (!controller) return;
          const result = recordResult(controller.splitBlock("block_commands_first", 6));
          if (result.success) setSplitId(result.createdBlockIds[0]);
        }}
      >
        在空格处拆分
      </button>
      <button
        type="button"
        disabled={!controller || !splitId}
        onClick={() => {
          if (!controller || !splitId) return;
          const result = recordResult(controller.mergeBlocks("block_commands_first", splitId));
          if (result.success) setSplitId(undefined);
        }}
      >
        合并拆分段落
      </button>
      <button
        type="button"
        onClick={() => {
          if (!controller) return;
          recordResult(
            controller.moveBlock("block_commands_second", null, {
              beforeBlockId: "block_commands_first",
            }),
          );
        }}
      >
        上移第二段
      </button>
      <button
        type="button"
        onClick={() => {
          if (!controller) return;
          recordResult(controller.changeBlockType("block_commands_first", "heading", { level: 2 }));
        }}
      >
        转为二级标题
      </button>
      <button
        type="button"
        disabled={!controller || !duplicateId}
        onClick={() => {
          if (!controller || !duplicateId) return;
          const result = recordResult(controller.deleteBlock(duplicateId));
          if (result.success) setDuplicateId(undefined);
        }}
      >
        删除副本
      </button>
      <button
        type="button"
        onClick={() => {
          if (!controller) return;
          setStatus(
            controller.indentListItem("block_commands_item_two")
              ? "列表项已缩进"
              : "当前列表结构不支持缩进",
          );
        }}
      >
        缩进列表项
      </button>
      <button
        type="button"
        onClick={() => {
          if (!controller) return;
          setStatus(
            controller.outdentListItem("block_commands_item_two")
              ? "列表项已取消缩进"
              : "当前列表结构不支持取消缩进",
          );
        }}
      >
        取消缩进
      </button>
      <span role="status">{status}</span>
    </div>
  );
}

function BlockCommandDemo() {
  return (
    <section className="block-command-demo" aria-labelledby="block-command-demo-title">
      <div className="mount-demo-header">
        <div>
          <h2 id="block-command-demo-title">Block 操作</h2>
          <p>通过稳定 Block ID 执行复制、拆分、合并、移动、缩进、转换和删除。</p>
        </div>
      </div>
      <EditorProvider options={{ documentId: "doc_block_commands", content: blockCommandContent }}>
        <BlockCommandControls />
        <EditorBlockMenu />
        <EditorSurface ariaLabel="Block 操作示例正文" className="block-command-surface" />
      </EditorProvider>
    </section>
  );
}

function CollaborativeStructureDemo() {
  const { controller } = useEditorInstance();
  const [status, setStatus] = useState("本地 Block 结构操作关闭；文本和标记仍可编辑。");

  const tryLocalMove = () => {
    if (!controller) return;
    const result = controller.moveBlock("block_guard_first", null, {
      afterBlockId: "block_guard_second",
    });
    setStatus(result.success ? "错误：本地移动被放行" : `本地移动已拒绝：${result.error.code}`);
  };

  const simulateRemoteInsert = () => {
    if (!controller) return;
    const paragraph = controller.editor.schema.nodes.paragraph.create(
      { blockId: createBlockId() },
      controller.editor.schema.text("来自适配器标记的远端结构事务"),
    );
    const transaction = controller.editor.state.tr
      .insert(controller.editor.state.doc.content.size, paragraph)
      .setMeta(exampleRemoteTransactionMeta, true);
    controller.editor.view.dispatch(transaction);
    setStatus("已模拟放行一条适配器标记的远端事务；这不是 Yjs 双端验收。");
  };

  return (
    <section className="block-command-demo" aria-labelledby="collaborative-structure-title">
      <div className="mount-demo-header">
        <div>
          <h2 id="collaborative-structure-title">协同结构操作安全门原型</h2>
          <p>演示协同模式的本地结构安全门：文本和标记可编辑，结构变化须由适配器提交。</p>
        </div>
      </div>
      <div className="block-command-controls">
        <button type="button" disabled={!controller} onClick={tryLocalMove}>
          尝试本地移动
        </button>
        <button type="button" disabled={!controller} onClick={simulateRemoteInsert}>
          模拟远端事务
        </button>
        <span role="status">{status}</span>
      </div>
      <EditorBlockMenu />
      <EditorSurface ariaLabel="协同结构安全门原型正文" className="block-command-surface" />
    </section>
  );
}

function CollaborativeStructureDemoRoot() {
  return (
    <EditorProvider
      options={{
        documentId: "doc_collaboration_structure_guard",
        content: collaborativeStructureContent,
        collaborationStructure: collaborationStructurePolicy,
      }}
    >
      <CollaborativeStructureDemo />
    </EditorProvider>
  );
}

function RetryStatus() {
  const { status } = useEditorInstance();
  return <span>状态：{status}</span>;
}

function InitializationRetryDemo() {
  const [shouldFail, setShouldFail] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [failureMessage, setFailureMessage] = useState("");
  const validContent: DocumentContent = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { blockId: "block_retry_demo" },
        content: [{ type: "text", text: "初始化恢复后，编辑器已就绪。" }],
      },
    ],
  };
  const invalidContent = {
    type: "doc",
    content: [{ type: "unsupported-node" }],
  };

  return (
    <section className="retry-demo" aria-labelledby="retry-demo-title">
      <div className="retry-demo-header">
        <div>
          <h2 id="retry-demo-title">初始化失败与恢复</h2>
          <p>注入无效文档触发错误，再恢复内容并重试。</p>
        </div>
      </div>
      <div className="retry-demo-actions">
        <button
          type="button"
          onClick={() => {
            setFailureMessage("");
            setShouldFail(true);
            setAttempt((value) => value + 1);
          }}
        >
          触发初始化错误
        </button>
        <button type="button" onClick={() => setShouldFail(false)}>
          修复输入并重试
        </button>
        {failureMessage && <span role="status">{failureMessage}</span>}
      </div>
      <EditorProvider
        instanceKey={`retry-demo:${attempt}`}
        options={{
          documentId: "doc_retry_demo",
          content: shouldFail ? invalidContent : validContent,
        }}
        hostServices={{ reportError: (error) => setFailureMessage(error.message) }}
      >
        <div className="retry-demo-content">
          <EditorSurface ariaLabel="初始化恢复示例正文" />
          <span className="retry-status" aria-live="polite">
            <RetryStatus />
          </span>
        </div>
      </EditorProvider>
    </section>
  );
}

function App() {
  const [presetIndex, setPresetIndex] = useState(-1);
  const presets = createKnowledgePresets();
  const selectedPreset = presets[presetIndex];
  return (
    <main className="playground">
      <header className="page-heading">
        <p className="eyebrow">公开包消费样例</p>
        <h1>嵌入式文档编辑器</h1>
        <p>
          组件从工作区公开入口导入；两个实例使用独立主题。第一个实例的附件上传由本地服务模拟，用于查看忙碌、失败、重试和取消反馈。
        </p>
      </header>
      <div className="editor-grid">
        <label>
          预设知识文档{" "}
          <select
            value={presetIndex}
            onChange={(event) => setPresetIndex(Number(event.target.value))}
          >
            <option value={-1}>视觉验收样本</option>
            {presets.map((preset, index) => (
              <option key={preset.id} value={index}>
                {preset.title}
              </option>
            ))}
          </select>
        </label>
        <EditorCard
          key={selectedPreset?.id ?? "visual-review"}
          title={selectedPreset?.title ?? "视觉验收样本"}
          documentId="doc_first"
          content={selectedPreset?.content ?? visualReviewContent}
          extensions={[consumerParagraphNodeView, reactImageNodeViewExtension]}
          simulatedUploads
        />
        <EditorCard
          title="会议记录"
          documentId="doc_second"
          content={secondContent}
          theme="dark"
          assetResolver={rejectVisualReviewAsset}
        />
      </div>
      <EditorMountDemo />
      <BlockCommandDemo />
      <CollaborativeStructureDemoRoot />
      <ConversionDemo />
      <InitializationRetryDemo />
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Example root is missing.");
createRoot(root).render(
  window.location.pathname === "/collaboration" ? (
    <CollaborativeEditorDemo />
  ) : window.location.pathname === "/lifecycle" ? (
    <StrictMode>
      <LifecycleDemo />
    </StrictMode>
  ) : (
    <StrictMode>
      <App />
    </StrictMode>
  ),
);
