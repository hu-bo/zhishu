export { createBaseEditorExtensions } from "./extensions.js";
export { setReplacementPreview, scrollToReplacementPreview } from "./replacement-preview.js";
export type {
  EditorReplacementPreviewData,
  EditorReplacementPreviewActions,
} from "./replacement-preview.js";
export type { BaseEditorExtensionsOptions, EditorPlaceholderOptions } from "./extensions.js";
export type { RequestMathSource } from "./mathematics.js";
export { renderMathToHtml } from "./mathematics.js";
export { createEditor, EditorController, editorOperationMeta, editorOriginMeta } from "./editor.js";
export type {
  CreateEditorOptions,
  EditorCapability,
  EditorCommand,
  EditorTableCommand,
  HighlightColor,
  TextAlignment,
  CalloutTheme,
  DocumentStatus,
  EditorStructureAction,
  EditorTextMatch,
  EditorTransactionEvent,
  EditorTransactionListener,
  PreparedStructureOperation,
} from "./editor.js";
export {
  createEmptyDocumentContent,
  createEditorSchema,
  validateContentForEditor,
} from "./schema.js";
export type { EditorContentValidationResult, EditorSchemaOptions } from "./schema.js";
export type { EditorLimitExceededReason, IndexedBlock } from "./index-plugin.js";
export {
  exportDocumentHtml,
  exportDocumentMarkdown,
  exportStandaloneDocumentHtml,
  exportDocumentJson,
  exportPlainText,
  importDocumentHtml,
  importDocumentJson,
  importPlainText,
} from "./conversions.js";
export type { ConversionIssue, ConversionReport, ConversionResult } from "./conversions.js";
export { calculateDocumentStatistics } from "./statistics.js";
export type { DocumentStatistics, DocumentStatisticsOptions } from "./statistics.js";
export {
  CALLOUT_THEMES,
  CALLOUT_THEME_LABELS,
  DOCUMENT_STATUSES,
  DOCUMENT_STATUS_LABELS,
  MAX_LATEX_LENGTH,
} from "@zhishu/document-contracts";
export type { DocumentMention } from "@zhishu/document-contracts";
