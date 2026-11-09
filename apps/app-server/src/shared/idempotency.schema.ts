import { z } from "zod";

export const idempotencyKeyHeadersSchema = z
  .object({
    "idempotency-key": z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._~-]+$/)
      .optional(),
  })
  .passthrough();
