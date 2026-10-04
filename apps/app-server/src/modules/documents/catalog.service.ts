import type { Principal } from "../identity/identity.types.js";
import type { CatalogRepository } from "./catalog.repository.js";
import type { CreateCatalogInput, MoveCatalogInput, UpdateCatalogInput } from "./catalog.schema.js";

export class CatalogService {
  constructor(private readonly repository: CatalogRepository) {}

  listChildren(principal: Principal, workspaceId: string, catalogId: string) {
    return this.repository.listChildren(principal, workspaceId, catalogId);
  }

  create(
    principal: Principal,
    workspaceId: string,
    input: CreateCatalogInput,
    idempotencyKey?: string,
  ) {
    return this.repository.create(principal, workspaceId, input, idempotencyKey);
  }

  update(principal: Principal, catalogId: string, input: UpdateCatalogInput) {
    return this.repository.update(principal, catalogId, input);
  }

  move(principal: Principal, catalogId: string, input: MoveCatalogInput) {
    return this.repository.move(principal, catalogId, input);
  }

  deletionImpact(principal: Principal, catalogId: string) {
    return this.repository.deletionImpact(principal, catalogId);
  }

  delete(principal: Principal, catalogId: string) {
    return this.repository.delete(principal, catalogId);
  }

  locate(principal: Principal, documentId: string) {
    return this.repository.locate(principal, documentId);
  }
}
