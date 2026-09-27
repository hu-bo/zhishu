import { Type, type Static } from "@sinclair/typebox";

const blockId = Type.String({
  pattern: "^block_[A-Za-z0-9_-]{1,64}$",
  description: "Stable identity for an addressable block.",
});

const inlineMark = Type.Union([
  Type.Object({ type: Type.Literal("bold") }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("italic") }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("strike") }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("code") }, { additionalProperties: false }),
  Type.Object(
    {
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
const inlineNode = Type.Union([textNode, hardBreakNode]);
const blockAttrs = Type.Object({ blockId }, { additionalProperties: false });
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

export const DocumentBlockSchema = Type.Recursive(
  (self) =>
    Type.Union([
      Type.Object(
        {
          type: Type.Literal("paragraph"),
          attrs: blockAttrs,
          content: Type.Optional(Type.Array(inlineNode, { maxItems: 100_000 })),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          type: Type.Literal("heading"),
          attrs: Type.Object(
            { blockId, level: Type.Optional(Type.Integer({ minimum: 1, maximum: 6, default: 1 })) },
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
      Type.Object(
        { type: Type.Literal("horizontalRule"), attrs: blockAttrs },
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
    description: "Version 1 structured document content.",
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
    description: "Generation-bound text selection encoded as opaque Yjs relative positions.",
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
export type Anchor = Static<typeof AnchorSchema>;
export type ExtensionRequirement = Static<typeof ExtensionRequirementSchema>;
export type CollaborationPresence = Static<typeof CollaborationPresenceSchema>;
export type OperationBatch = Static<typeof OperationBatchSchema>;
export type DocumentOperation = Static<typeof OperationSchema>;

export const documentContractJsonSchemas = [
  DocumentContentSchema,
  DocumentBlockSchema,
  DocumentSnapshotSchema,
  CollaborationPresenceSchema,
  AssetReferenceSchema,
  AnchorSchema,
  OperationBatchSchema,
] as const;
