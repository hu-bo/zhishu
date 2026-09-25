import { z } from "zod";
import { errorResponseSchema } from "../../shared/error.schema.js";
import { paginationQuerySchema } from "../../shared/pagination.schema.js";

export const projectSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export const createProjectBodySchema = z
  .object({ name: z.string().trim().min(1).max(200) })
  .strict();
export const updateProjectBodySchema = createProjectBodySchema
  .partial()
  .refine((body) => Object.keys(body).length > 0, "At least one field must be supplied");
export const projectParamsSchema = z.object({ id: z.string().uuid() }).strict();
export const projectListSchema = z.object({ items: z.array(projectSchema) });
export { errorResponseSchema, paginationQuerySchema };
export type CreateProjectInput = z.infer<typeof createProjectBodySchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectBodySchema>;
