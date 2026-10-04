import { createKnowledgePresets } from "@zhishu/document-contracts/examples";
import type { Principal } from "../identity/identity.types.js";
import type { KnowledgeRepository } from "./knowledge.repository.js";
import type {
  CreateWorkspaceInput,
  KnowledgeMoveInput,
  KnowledgeSearchInput,
} from "./knowledge.schema.js";

export class KnowledgeService {
  constructor(
    private readonly repository: KnowledgeRepository,
    private readonly maxDocuments: number,
  ) {}
  listWorkspaces(principal: Principal) {
    return this.repository.listWorkspaces(principal);
  }
  createWorkspace(principal: Principal, input: CreateWorkspaceInput) {
    return this.repository.createWorkspace(principal, input);
  }
  move(principal: Principal, documentId: string, input: KnowledgeMoveInput) {
    return this.repository.move(principal, documentId, input);
  }
  search(principal: Principal, input: KnowledgeSearchInput) {
    return this.repository.search(principal, input);
  }
  initializePresets(principal: Principal, workspaceId: string) {
    return this.repository.initializePresets(
      principal,
      workspaceId,
      createKnowledgePresets(),
      this.maxDocuments,
    );
  }
}
