import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { createEditorSchema, normalizeTiptapDocumentJSON } from "@zhishu/editor-core/schema";
import type { DocumentContent } from "@zhishu/document-contracts";
import { DomainError } from "../../shared/domain-error.js";
import {
  emptyStructureState,
  projectContentUpdateToStructure,
  writeStoredStructureState,
} from "./structure-operations.js";

export function readDocumentContent(document: Y.Doc): Record<string, unknown> {
  const content = normalizeTiptapDocumentJSON(yDocToProsemirrorJSON(document, "content")) as Record<
    string,
    unknown
  >;
  return content.content === undefined ? { ...content, content: [] } : content;
}

/** Every new generation starts with matching editor content and structural state. */
export function createCollaborationStateFromContent(content: DocumentContent): Uint8Array {
  const document = prosemirrorJSONToYDoc(createEditorSchema(), content, "content");
  try {
    const structure = projectContentUpdateToStructure(
      emptyStructureState(),
      { type: "doc", content: [] },
      content,
    );
    if (!structure.success)
      throw new DomainError("CONFLICT", "The document structure cannot be initialized safely");
    writeStoredStructureState(document, structure.state, "document-state-initialization");
    return Y.encodeStateAsUpdate(document);
  } finally {
    document.destroy();
  }
}
