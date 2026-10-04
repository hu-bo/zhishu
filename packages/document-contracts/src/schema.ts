import { Type, type Static } from "@sinclair/typebox";

export const LEGACY_DOCUMENT_SCHEMA_VERSION = 1 as const;
export const TASK_LIST_DOCUMENT_SCHEMA_VERSION = 2 as const;
export const TABLE_DOCUMENT_SCHEMA_VERSION = 3 as const;
export const TEXT_FORMATS_DOCUMENT_SCHEMA_VERSION = 4 as const;
export const CALLOUT_DOCUMENT_SCHEMA_VERSION = 5 as const;
export const CURRENT_DOCUMENT_SCHEMA_VERSION = CALLOUT_DOCUMENT_SCHEMA_VERSION;
export const SUPPORTED_DOCUMENT_SCHEMA_VERSIONS = [
  LEGACY_DOCUMENT_SCHEMA_VERSION,
  TASK_LIST_DOCUMENT_SCHEMA_VERSION,
  TABLE_DOCUMENT_SCHEMA_VERSION,
  TEXT_FORMATS_DOCUMENT_SCHEMA_VERSION,
  CALLOUT_DOCUMENT_SCHEMA_VERSION,
] as const;

export const HIGHLIGHT_COLORS = ["yellow", "green", "blue", "pink", "purple"] as const;
export const TEXT_ALIGNMENTS = ["left", "center", "right"] as const;
export const CALLOUT_THEMES = ["info", "tip", "warning", "success", "danger"] as const;
export const CALLOUT_THEME_LABELS: Record<(typeof CALLOUT_THEMES)[number], string> = {
  info: "信息",
  tip: "提示",
  warning: "警告",
  success: "成功",
  danger: "危险",
};
export const DOCUMENT_STATUSES = ["todo", "in-progress", "in-review", "done", "blocked"] as const;
export const DOCUMENT_STATUS_LABELS: Record<(typeof DOCUMENT_STATUSES)[number], string> = {
  todo: "待办",
  "in-progress": "进行中",
  "in-review": "评审中",
  done: "已完成",
  blocked: "阻塞",
};

const blockId = Type.String({
  pattern: "^block_[A-Za-z0-9_-]{1,64}$",
  description: "Stable identity for an addressable block.",
});

const inlineMark = Type.Union([
  Type.Object({ type: Type.Literal("bold") }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("italic") }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("strike") }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("underline") }, { additionalProperties: false }),
  Type.Object(
    {
      type: Type.Literal("highlight"),
      attrs: Type.Object(
        { color: Type.Union(HIGHLIGHT_COLORS.map((color) => Type.Literal(color))) },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object({ type: Type.Literal("code") }, { additionalProperties: false }),
  Type.Object(
    {
      type: Type.Literal("link"),
      attrs: Type.Object(
        {
          href: Type.String({
            pattern: "^(https?:\\/\\/|mailto:)[^\\s]+$",
            maxLength: 2048,
          }),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      // Retained for v1-v3 content; normalizeDocumentContent upgrades it to Tiptap's attrs shape.
      type: Type.Literal("link"),
      href: Type.String({
        pattern: "^(https?:\\/\\/|mailto:)[^\\s]+$",
        maxLength: 2048,
      }),
    },
    { additionalProperties: false },
  ),
]);

const textNode = Type.Object(
  {
    type: Type.Literal("text"),
    text: Type.String({ minLength: 1, maxLength: 100_000 }),
    marks: Type.Optional(Type.Array(inlineMark, { maxItems: 16 })),
  },
  { additionalProperties: false },
);

const hardBreakNode = Type.Object(
  { type: Type.Literal("hardBreak") },
  { additionalProperties: false },
);
const statusTagNode = Type.Object(
  {
    type: Type.Literal("statusTag"),
    attrs: Type.Object(
      { status: Type.Union(DOCUMENT_STATUSES.map((status) => Type.Literal(status))) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const inlineNode = Type.Union([textNode, hardBreakNode, statusTagNode]);
const blockAttrs = Type.Object({ blockId }, { additionalProperties: false });
const textAlignment = Type.Optional(
  Type.Union(TEXT_ALIGNMENTS.map((alignment) => Type.Literal(alignment))),
);
const paragraphNodeSchema = Type.Object(
  {
    type: Type.Literal("paragraph"),
    attrs: Type.Object({ blockId, align: textAlignment }, { additionalProperties: false }),
    content: Type.Optional(Type.Array(inlineNode, { maxItems: 100_000 })),
  },
  { additionalProperties: false },
);
const taskItemAttrs = Type.Object(
  { blockId, checked: Type.Optional(Type.Boolean({ default: false })) },
  { additionalProperties: false },
);
const taskItemNodeSchema = Type.Object(
  {
    type: Type.Literal("taskItem"),
    attrs: taskItemAttrs,
    content: Type.Optional(Type.Array(inlineNode, { maxItems: 100_000 })),
  },
  { additionalProperties: false },
);
export const TaskListSchema = Type.Recursive(
  (taskList) =>
    Type.Object(
      {
        type: Type.Literal("taskList"),
        attrs: blockAttrs,
        content: Type.Array(Type.Union([taskItemNodeSchema, taskList]), {
          minItems: 1,
          maxItems: 10_000,
        }),
      },
      { additionalProperties: false },
    ),
  { $id: "TaskList" },
);
const assetReferenceProperties = {
  assetId: Type.String({ pattern: "^asset_[A-Za-z0-9_-]{1,64}$" }),
  mediaType: Type.String({
    pattern: "^[a-z][a-z0-9.+-]{0,62}/[a-z0-9][a-z0-9.+-]{0,62}$",
  }),
  alt: Type.String({ maxLength: 1_000 }),
  width: Type.Optional(Type.Integer({ minimum: 1, maximum: 32_768 })),
  height: Type.Optional(Type.Integer({ minimum: 1, maximum: 32_768 })),
};

export const AssetReferenceSchema = Type.Object(assetReferenceProperties, {
  $id: "AssetReference",
  additionalProperties: false,
  description:
    "Stable asset identity and accessible presentation metadata; never a URL, upload token, or storage key.",
});

const tableCellAttrs = Type.Object(
  {
    colspan: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 1 })),
    rowspan: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 1 })),
    colwidth: Type.Optional(
      Type.Union([
        Type.Null(),
        Type.Array(Type.Union([Type.Null(), Type.Integer({ minimum: 1, maximum: 32_768 })]), {
          minItems: 1,
          maxItems: 20,
        }),
      ]),
    ),
    align: Type.Optional(
      Type.Union([
        Type.Literal("left"),
        Type.Literal("center"),
        Type.Literal("right"),
        Type.Null(),
      ]),
    ),
  },
  { additionalProperties: false },
);
const tableCellContent = Type.Array(paragraphNodeSchema, { minItems: 1, maxItems: 100 });
export const TableCellSchema = Type.Object(
  {
    type: Type.Literal("tableCell"),
    attrs: Type.Optional(tableCellAttrs),
    content: tableCellContent,
  },
  { $id: "TableCell", additionalProperties: false },
);
export const TableHeaderSchema = Type.Object(
  {
    type: Type.Literal("tableHeader"),
    attrs: Type.Optional(tableCellAttrs),
    content: tableCellContent,
  },
  { $id: "TableHeader", additionalProperties: false },
);
export const TableRowSchema = Type.Object(
  {
    type: Type.Literal("tableRow"),
    content: Type.Array(Type.Union([Type.Ref(TableCellSchema), Type.Ref(TableHeaderSchema)]), {
      minItems: 1,
      maxItems: 20,
    }),
  },
  { $id: "TableRow", additionalProperties: false },
);
export const TableSchema = Type.Object(
  {
    type: Type.Literal("table"),
    attrs: blockAttrs,
    content: Type.Array(Type.Ref(TableRowSchema), { minItems: 1, maxItems: 100 }),
  },
  {
    $id: "Table",
    additionalProperties: false,
    description: "A rectangular table with paragraph-only cells and bounded row/column spans.",
  },
);

export const DocumentBlockSchema = Type.Recursive(
  (self) =>
    Type.Union([
      paragraphNodeSchema,
      Type.Object(
        {
          type: Type.Literal("callout"),
          attrs: Type.Object(
            { blockId, theme: Type.Union(CALLOUT_THEMES.map((theme) => Type.Literal(theme))) },
            { additionalProperties: false },
          ),
          content: Type.Array(self, { minItems: 1, maxItems: 10_000 }),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          type: Type.Literal("heading"),
          attrs: Type.Object(
            {
              blockId,
              level: Type.Optional(Type.Integer({ minimum: 1, maximum: 6, default: 1 })),
              align: textAlignment,
            },
            { additionalProperties: false },
          ),
          content: Type.Optional(Type.Array(inlineNode, { maxItems: 100_000 })),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          type: Type.Literal("blockquote"),
          attrs: blockAttrs,
          content: Type.Array(self, { maxItems: 10_000 }),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          type: Type.Literal("bulletList"),
          attrs: blockAttrs,
          content: Type.Array(
            Type.Object(
              {
                type: Type.Literal("listItem"),
                attrs: blockAttrs,
                content: Type.Array(self, { minItems: 1, maxItems: 10_000 }),
              },
              { additionalProperties: false },
            ),
            { minItems: 1, maxItems: 10_000 },
          ),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          type: Type.Literal("orderedList"),
          attrs: Type.Object(
            {
              blockId,
              start: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000, default: 1 })),
            },
            { additionalProperties: false },
          ),
          content: Type.Array(
            Type.Object(
              {
                type: Type.Literal("listItem"),
                attrs: blockAttrs,
                content: Type.Array(self, { minItems: 1, maxItems: 10_000 }),
              },
              { additionalProperties: false },
            ),
            { minItems: 1, maxItems: 10_000 },
          ),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          type: Type.Literal("codeBlock"),
          attrs: Type.Object(
            {
              blockId,
              language: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_+-]{1,32}$" })),
            },
            { additionalProperties: false },
          ),
          content: Type.Optional(Type.Array(textNode, { maxItems: 100_000 })),
        },
        { additionalProperties: false },
      ),
      TaskListSchema,
      taskItemNodeSchema,
      Type.Ref(TableSchema),
      Type.Object(
        {
          type: Type.Literal("horizontalRule"),
          attrs: Type.Object(
            {
              blockId,
              label: Type.Optional(Type.String({ maxLength: 80 })),
            },
            { additionalProperties: false },
          ),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          type: Type.Literal("image"),
          attrs: Type.Object(
            {
              blockId,
              ...assetReferenceProperties,
              mediaType: Type.Union([
                Type.Literal("image/jpeg"),
                Type.Literal("image/png"),
                Type.Literal("image/webp"),
              ]),
            },
            { additionalProperties: false },
          ),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          type: Type.Literal("pdfAttachment"),
          attrs: Type.Object(
            {
              blockId,
              assetId: assetReferenceProperties.assetId,
              mediaType: Type.Literal("application/pdf"),
              fileName: Type.String({ minLength: 1, maxLength: 255 }),
            },
            { additionalProperties: false },
          ),
        },
        { additionalProperties: false },
      ),
    ]),
  { $id: "DocumentBlock" },
);

export const DocumentContentSchema = Type.Object(
  {
    type: Type.Literal("doc"),
    content: Type.Array(Type.Ref(DocumentBlockSchema), { maxItems: 20_000 }),
  },
  {
    $id: "DocumentContent",
    $schema: "https://json-schema.org/draft/2020-12/schema",
    additionalProperties: false,
    description: "Version 5 structured document content.",
  },
);

export const ExtensionRequirementSchema = Type.Object(
  {
    name: Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" }),
    version: Type.String({ pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[A-Za-z0-9.-]+)?$" }),
    required: Type.Boolean({ default: true }),
  },
  { additionalProperties: false },
);

const relativePositionToken = Type.String({
  pattern: "^[A-Za-z0-9_-]{1,1024}$",
});

export const CollaborationPresenceSchema = Type.Object(
  {
    protocolVersion: Type.Literal(1),
    displayName: Type.String({ minLength: 1, maxLength: 80 }),
    color: Type.String({ pattern: "^#[0-9A-Fa-f]{6}$" }),
    selection: Type.Optional(
      Type.Object(
        { anchor: relativePositionToken, head: relativePositionToken },
        { additionalProperties: false },
      ),
    ),
  },
  {
    $id: "CollaborationPresence",
    additionalProperties: false,
    description:
      "Ephemeral, untrusted awareness data. Selection positions are opaque generation-local Yjs relative positions.",
  },
);

const documentSnapshotProperties = {
  documentId: Type.String({ pattern: "^doc_[A-Za-z0-9_-]{1,64}$" }),
  schemaVersion: Type.Integer({ minimum: 1, default: 1 }),
  extensions: Type.Array(ExtensionRequirementSchema, { maxItems: 128, default: [] }),
  snapshotRevision: Type.Integer({ minimum: 1 }),
  content: Type.Ref(DocumentContentSchema),
};

export const DocumentSnapshotSchema = Type.Union(
  [
    Type.Object(documentSnapshotProperties, { additionalProperties: false }),
    Type.Object(
      {
        ...documentSnapshotProperties,
        generationId: Type.String({ pattern: "^gen_[A-Za-z0-9_-]{1,64}$" }),
        durableSeq: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  ],
  {
    $id: "DocumentSnapshot",
    description:
      "A versioned snapshot. Collaborative snapshots bind generationId and durableSeq as a pair.",
  },
);

export const AnchorSchema = Type.Object(
  {
    documentId: Type.String({ pattern: "^doc_[A-Za-z0-9_-]{1,64}$" }),
    generationId: Type.String({ pattern: "^gen_[A-Za-z0-9_-]{1,64}$" }),
    anchorVersion: Type.Literal(1),
    encoding: Type.Literal("yjs-relative-position-v1"),
    startBlockId: blockId,
    endBlockId: blockId,
    positionRevision: Type.Optional(Type.Integer({ minimum: 0 })),
    startPosition: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    endPosition: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    startOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    endOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    startBlockLength: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    selectedTextLength: Type.Optional(
      Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    ),
    start: Type.String({
      minLength: 4,
      maxLength: 8_192,
      pattern: "^[A-Za-z0-9+/]+={0,2}$",
    }),
    end: Type.String({
      minLength: 4,
      maxLength: 8_192,
      pattern: "^[A-Za-z0-9+/]+={0,2}$",
    }),
  },
  {
    $id: "Anchor",
    additionalProperties: false,
    description:
      "Generation-bound selection encoded as opaque Yjs relative positions with optional same-editor position mapping hints.",
  },
);

const operationPrecondition = Type.Object(
  {
    blockId,
    contentHash: Type.Optional(Type.String({ pattern: "^sha256:[a-fA-F0-9]{64}$" })),
  },
  { additionalProperties: false },
);
const relativePosition = {
  beforeBlockId: Type.Optional(blockId),
  afterBlockId: Type.Optional(blockId),
};
const operationTarget = { targetBlockId: blockId };
const insertBlockOperation = Type.Object(
  {
    type: Type.Literal("insert-block"),
    parentBlockId: Type.Union([blockId, Type.Null()]),
    ...relativePosition,
    block: Type.Ref(DocumentBlockSchema),
  },
  { additionalProperties: false },
);
const deleteBlockOperation = Type.Object(
  { type: Type.Literal("delete-block"), ...operationTarget },
  { additionalProperties: false },
);
const replaceBlockOperation = Type.Object(
  {
    type: Type.Literal("replace-block"),
    ...operationTarget,
    block: Type.Ref(DocumentBlockSchema),
  },
  { additionalProperties: false },
);
const wrapBlockOperation = Type.Object(
  {
    type: Type.Literal("wrap-block"),
    ...operationTarget,
    wrapper: Type.Union([
      Type.Ref(DocumentBlockSchema),
      Type.Object(
        {
          type: Type.Literal("callout"),
          attrs: Type.Object(
            { blockId, theme: Type.Union(CALLOUT_THEMES.map((theme) => Type.Literal(theme))) },
            { additionalProperties: false },
          ),
          content: Type.Array(Type.Ref(DocumentBlockSchema), { maxItems: 10_000 }),
        },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
);
const moveBlockOperation = Type.Object(
  {
    type: Type.Literal("move-block"),
    ...operationTarget,
    parentBlockId: Type.Union([blockId, Type.Null()]),
    ...relativePosition,
  },
  { additionalProperties: false },
);

export const OperationSchema = Type.Union([
  insertBlockOperation,
  deleteBlockOperation,
  replaceBlockOperation,
  wrapBlockOperation,
  moveBlockOperation,
]);

export const OperationBatchSchema = Type.Object(
  {
    operationId: Type.String({ pattern: "^op_[A-Za-z0-9_-]{1,64}$" }),
    documentId: Type.String({ pattern: "^doc_[A-Za-z0-9_-]{1,64}$" }),
    generationId: Type.Optional(Type.String({ pattern: "^gen_[A-Za-z0-9_-]{1,64}$" })),
    origin: Type.Union([
      Type.Literal("user"),
      Type.Literal("import"),
      Type.Literal("system"),
      Type.Literal("ai-accept"),
    ]),
    preconditions: Type.Optional(Type.Array(operationPrecondition, { maxItems: 1_000 })),
    operations: Type.Array(OperationSchema, { minItems: 1, maxItems: 256 }),
  },
  { $id: "OperationBatch", additionalProperties: false },
);

export type DocumentContent = Static<typeof DocumentContentSchema>;
export type DocumentBlock = Static<typeof DocumentBlockSchema>;
export type DocumentSnapshot = Static<typeof DocumentSnapshotSchema>;
export type AssetReference = Static<typeof AssetReferenceSchema>;
export type Table = Static<typeof TableSchema>;
export type TableRow = Static<typeof TableRowSchema>;
export type TableCell = Static<typeof TableCellSchema>;
export type TableHeader = Static<typeof TableHeaderSchema>;
export type Anchor = Static<typeof AnchorSchema>;
export type ExtensionRequirement = Static<typeof ExtensionRequirementSchema>;
export type CollaborationPresence = Static<typeof CollaborationPresenceSchema>;
export type OperationBatch = Static<typeof OperationBatchSchema>;
export type DocumentOperation = Static<typeof OperationSchema>;

export const documentContractJsonSchemas = [
  DocumentContentSchema,
  DocumentBlockSchema,
  TaskListSchema,
  TableSchema,
  TableRowSchema,
  TableCellSchema,
  TableHeaderSchema,
  DocumentSnapshotSchema,
  CollaborationPresenceSchema,
  AssetReferenceSchema,
  AnchorSchema,
  OperationBatchSchema,
] as const;
