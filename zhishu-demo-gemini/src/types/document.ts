/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type DocumentMode = 'collaborative' | 'snapshot';

export type InlineStyle = 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'link';

export interface InlineSpan {
  text: string;
  styles?: InlineStyle[];
  linkUrl?: string;
}

export type BlockType = 
  | 'heading' 
  | 'paragraph' 
  | 'bullet-list' 
  | 'ordered-list' 
  | 'task-list' 
  | 'code' 
  | 'table' 
  | 'callout' 
  | 'image' 
  | 'pdf';

export interface TaskItem {
  id: string;
  text: string;
  completed: boolean;
}

export interface DocumentBlock {
  id: string;
  type: BlockType;
  headingLevel?: 1 | 2 | 3;
  text?: string;
  spans?: InlineSpan[];
  listItems?: string[];
  taskItems?: TaskItem[];
  codeLanguage?: string;
  codeContent?: string;
  tableHeaders?: string[];
  tableRows?: string[][];
  calloutVariant?: 'info' | 'warning' | 'tip' | 'quote';
  calloutContent?: string;
  // Asset properties
  assetId?: string;
  imageAlt?: string;
  imageWidth?: number | string;
  imageHeight?: number | string;
  signedAuthUrl?: string;
  pdfFilename?: string;
  pdfFileSize?: string;
  pdfPageCount?: number;
}

export interface DocumentMetadata {
  id: string;
  title: string;
  emoji: string;
  tags: string[];
  mode: DocumentMode;
  metadataRevision: number;
  snapshotRevision: number; // for snapshot mode
  durableSeq: number; // for collaborative mode
  generation: string; // for collaborative mode, e.g. gen-001
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  isStarred: boolean;
  isArchived: boolean;
  ownerId: string;
  ownerName: string;
  canManage: boolean;
  canEdit: boolean;
  spaceId: string | null;
  spaceName?: string;
  folderId?: string | null;
  folderName?: string;
  summary: string;
}

export interface DocumentData {
  metadata: DocumentMetadata;
  blocks: DocumentBlock[];
}

export interface VersionRecord {
  id: string;
  documentId: string;
  versionType: 'auto' | 'named';
  name: string;
  snapshotRevision?: number;
  durableSeq?: number;
  generation?: string;
  createdAt: string;
  author: {
    id: string;
    name: string;
    avatar: string;
  };
  changeSummary: string;
  blocks: DocumentBlock[];
}

export interface ACLPrincipal {
  id: string;
  name: string;
  type: 'user' | 'group';
  role: 'owner' | 'editor' | 'viewer';
  avatar?: string;
  effectiveCapabilities: {
    canEdit: boolean;
    canComment: boolean;
    canManage: boolean;
    canShare: boolean;
  };
}

export interface CommentItem {
  id: string;
  author: {
    id: string;
    name: string;
    avatar: string;
  };
  content: string;
  createdAt: string;
  mentions?: string[];
}

export interface CommentThread {
  id: string;
  documentId: string;
  blockId: string | null;
  quotedText?: string;
  status: 'open' | 'resolved';
  isTargetInvalidated?: boolean;
  createdAt: string;
  comments: CommentItem[];
}

export interface KnowledgeSource {
  id: string;
  title: string;
  spaceId: string;
  spaceName?: string;
  documentCount: number;
  indexStatus: 'ready' | 'indexing' | 'failed';
  lastSyncedAt: string;
  errorMessage?: string;
  snippetSummary: string;
}

export interface WorkspaceFolder {
  id: string;
  spaceId: string;
  name: string;
  parentId: string | null;
  icon?: string;
}

export interface Workspace {
  id: string;
  name: string;
  icon: string;
  description: string;
  createdAt: string;
  memberCount: number;
  folders: WorkspaceFolder[];
  pages: {
    id: string;
    title: string;
    parentId: string | null;
    folderId?: string | null;
    icon?: string;
  }[];
}

export interface MentionNotification {
  id: string;
  recipientId: string;
  author: {
    id: string;
    name: string;
    avatar: string;
  };
  documentId: string;
  documentTitle: string;
  commentId: string;
  commentContent: string;
  quotedText?: string;
  createdAt: string;
  isRead: boolean;
}

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  role: 'owner' | 'editor' | 'viewer';
  avatar: string;
  token: string;
}

export type WorkbenchView = 'relevant' | 'recent' | 'my' | 'all' | 'starred' | 'archived' | 'trash';
export type WorkbenchSortField = 'updatedAt' | 'title' | 'createdAt';
export type SortDirection = 'asc' | 'desc';
