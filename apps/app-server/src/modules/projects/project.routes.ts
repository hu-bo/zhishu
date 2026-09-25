import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { ProjectService } from "./project.service.js";
import {
  createProjectBodySchema,
  errorResponseSchema,
  paginationQuerySchema,
  projectListSchema,
  projectParamsSchema,
  projectSchema,
  updateProjectBodySchema,
} from "./project.schema.js";

const responseProject = (project: {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  ...project,
  createdAt: project.createdAt.toISOString(),
  updatedAt: project.updatedAt.toISOString(),
});

export async function projectRoutes(app: FastifyInstance, service: ProjectService): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get(
    "/",
    {
      schema: {
        operationId: "listProjects",
        tags: ["projects"],
        querystring: paginationQuerySchema,
        response: { 200: projectListSchema },
      },
    },
    async (request) => ({ items: (await service.list(request.query.limit)).map(responseProject) }),
  );
  typed.post(
    "/",
    {
      schema: {
        operationId: "createProject",
        tags: ["projects"],
        body: createProjectBodySchema,
        response: { 201: projectSchema, 400: errorResponseSchema },
      },
    },
    async (request, reply) =>
      reply.code(201).send(responseProject(await service.create(request.body))),
  );
  typed.get(
    "/:id",
    {
      schema: {
        operationId: "getProject",
        tags: ["projects"],
        params: projectParamsSchema,
        response: { 200: projectSchema, 400: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request) => responseProject(await service.get(request.params.id)),
  );
  typed.patch(
    "/:id",
    {
      schema: {
        operationId: "updateProject",
        tags: ["projects"],
        params: projectParamsSchema,
        body: updateProjectBodySchema,
        response: { 200: projectSchema, 400: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request) => responseProject(await service.update(request.params.id, request.body)),
  );
  typed.delete(
    "/:id",
    {
      schema: {
        operationId: "deleteProject",
        tags: ["projects"],
        params: projectParamsSchema,
        response: { 204: z.null(), 400: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      await service.delete(request.params.id);
      return reply.code(204).send(null);
    },
  );
}
