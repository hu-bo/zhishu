import { z } from "zod";
export const workspaceIdSchema = z.string().regex(/^ws_[A-Za-z0-9_-]{1,64}$/);
export const catalogIdSchema = z.string().regex(/^cat_[A-Za-z0-9_-]{1,64}$/);
export const documentIdSchema = z.string().regex(/^doc_[A-Za-z0-9_-]{1,64}$/);
export const emojiIconSchema = z
  .string()
  .trim()
  .max(32)
  .refine((value) => {
    const graphemes = [...new Intl.Segmenter("zh", { granularity: "grapheme" }).segment(value)];
    return (
      graphemes.length === 1 &&
      /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(value)
    );
  }, "请选择一个 Emoji 图标")
  .nullable();

export const documentParamsSchema = z.object({ documentId: documentIdSchema }).strict();
export const workspaceParamsSchema = z.object({ workspaceId: workspaceIdSchema }).strict();
