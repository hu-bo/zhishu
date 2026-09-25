import type { FastifyInstance } from "fastify";
import { createProjectRepository } from "./project.repository.js";
import { projectRoutes } from "./project.routes.js";
import { ProjectService } from "./project.service.js";

export async function projectsModule(app: FastifyInstance): Promise<void> {
  const service = new ProjectService(createProjectRepository(app.db));
  await app.register(async (scope) => projectRoutes(scope, service), { prefix: "/projects" });
}
