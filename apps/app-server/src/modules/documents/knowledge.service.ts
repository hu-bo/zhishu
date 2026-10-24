import { createKnowledgePresets } from "@zhishu/document-contracts/examples";
import type { Principal } from "../identity/identity.types.js";
import type { KnowledgeRepository } from "./knowledge.repository.js";
import type {
  CreateWorkspaceInput,
  UpdateWorkspaceInput,
  KnowledgeMoveInput,
  KnowledgeSearchInput,
  SetWorkspaceMemberInput,
} from "./knowledge.schema.js";

export class KnowledgeService {
  constructor(
    private readonly repository: KnowledgeRepository,
    private readonly maxDocuments: number,
  ) {}
  listWorkspaces(principal: Principal) {
    return this.repository.listWorkspaces(principal);
  }
  createWorkspace(principal: Principal, input: CreateWorkspaceInput, idempotencyKey?: string) {
    return this.repository.createWorkspace(principal, input, idempotencyKey);
  }
  updateWorkspace(principal: Principal, workspaceId: string, input: UpdateWorkspaceInput) {
    return this.repository.updateWorkspace(principal, workspaceId, input);
  }
  listMembers(principal: Principal, workspaceId: string) {
    return this.repository.listMembers(principal, workspaceId);
  }
  setMember(
    principal: Principal,
    workspaceId: string,
    identityId: string,
    input: SetWorkspaceMemberInput,
  ) {
    return this.repository.setMember(principal, workspaceId, identityId, input);
  }
  removeMember(principal: Principal, workspaceId: string, identityId: string) {
    return this.repository.removeMember(principal, workspaceId, identityId);
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
