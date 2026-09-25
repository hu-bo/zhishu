import { DomainError } from "../../shared/domain-error.js";
import type { CreateProjectInput, UpdateProjectInput } from "./project.schema.js";
import type { Project, ProjectRepository } from "./project.repository.js";

export class ProjectService {
  constructor(private readonly repository: ProjectRepository) {}

  create(input: CreateProjectInput): Promise<Project> {
    return this.repository.create(input);
  }

  async get(id: string): Promise<Project> {
    const project = await this.repository.findById(id);
    if (!project) throw new DomainError("NOT_FOUND", "Project not found");
    return project;
  }

  list(limit: number): Promise<Project[]> {
    return this.repository.list(limit);
  }

  async update(id: string, input: UpdateProjectInput): Promise<Project> {
    const project = await this.repository.update(id, input);
    if (!project) throw new DomainError("NOT_FOUND", "Project not found");
    return project;
  }

  async delete(id: string): Promise<void> {
    if (!(await this.repository.delete(id)))
      throw new DomainError("NOT_FOUND", "Project not found");
  }
}
