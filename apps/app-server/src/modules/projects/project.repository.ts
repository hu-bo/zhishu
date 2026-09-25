import { projects, type Database } from "../../../database/index.js";
import { asc, desc, eq } from "drizzle-orm";

export type Project = { id: string; name: string; createdAt: Date; updatedAt: Date };
export interface ProjectRepository {
  create(input: { name: string }): Promise<Project>;
  findById(id: string): Promise<Project | undefined>;
  list(limit: number): Promise<Project[]>;
  update(id: string, input: { name?: string }): Promise<Project | undefined>;
  delete(id: string): Promise<boolean>;
}

export function createProjectRepository(db: Database): ProjectRepository {
  return {
    async create(input) {
      const [project] = await db.insert(projects).values(input).returning();
      return project;
    },
    async findById(id) {
      const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
      return project;
    },
    list(limit) {
      return db
        .select()
        .from(projects)
        .orderBy(desc(projects.createdAt), asc(projects.id))
        .limit(limit);
    },
    async update(id, input) {
      const [project] = await db
        .update(projects)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(projects.id, id))
        .returning();
      return project;
    },
    async delete(id) {
      const deleted = await db
        .delete(projects)
        .where(eq(projects.id, id))
        .returning({ id: projects.id });
      return deleted.length > 0;
    },
  };
}
