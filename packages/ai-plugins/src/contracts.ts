import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
export const manifests = Object.freeze([
  { id: "writing", version: "1", artifactKind: "authoring-proposal", schemaVersion: 1 },
  { id: "research", version: "1", artifactKind: "research-report", schemaVersion: 1 },
  { id: "image", version: "1", artifactKind: "image", schemaVersion: 1 },
]);
export const ImageAssetSchema = Type.Object({
  assetId: Type.String(),
  mime: Type.Union([
    Type.Literal("image/png"),
    Type.Literal("image/jpeg"),
    Type.Literal("image/webp"),
  ]),
  width: Type.Integer({ minimum: 1 }),
  height: Type.Integer({ minimum: 1 }),
});
export type ImageAsset = Static<typeof ImageAssetSchema>;
export const ImageJobSchema = Type.Union([
  Type.Object({
    id: Type.String(),
    status: Type.Union([Type.Literal("pending"), Type.Literal("unknown"), Type.Literal("failed")]),
    code: Type.Optional(Type.String()),
  }),
  Type.Object({
    id: Type.String(),
    status: Type.Literal("ready"),
    assets: Type.Array(ImageAssetSchema, { minItems: 1, maxItems: 1 }),
  }),
]);
export type ImageJob = Static<typeof ImageJobSchema>;
export const isImageJob = (value: unknown): value is ImageJob => Value.Check(ImageJobSchema, value);
