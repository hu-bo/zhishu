/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DocumentData,
  DocumentMetadata,
  DocumentBlock,
  VersionRecord,
  ACLPrincipal,
  CommentThread,
  KnowledgeSource,
  Workspace,
  WorkspaceFolder,
  MentionNotification,
  CurrentUser,
  WorkbenchView,
  WorkbenchSortField,
  SortDirection,
} from '../types/document';

const STORAGE_KEYS = {
  DOCUMENTS: 'zhishu_documents_v3',
  VERSIONS: 'zhishu_versions_v3',
  COMMENTS: 'zhishu_comments_v3',
  KNOWLEDGE: 'zhishu_knowledge_v3',
  WORKSPACES: 'zhishu_workspaces_v3',
  NOTIFICATIONS: 'zhishu_notifications_v3',
  USER: 'zhishu_current_user_v3',
  IDEMPOTENCY: 'zhishu_idempotency_cache',
};

export const MOCK_USERS: Record<'owner' | 'editor' | 'viewer', CurrentUser> = {
  owner: {
    id: 'usr_lin_01',
    name: '林修文 (文档负责人)',
    email: 'xiuwen.lin@zhishu.internal',
    role: 'owner',
    avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=120&q=80',
    token: 'mock_bearer_token_owner_zhishu_9981',
  },
  editor: {
    id: 'usr_chen_02',
    name: '陈若冰 (协作作者)',
    email: 'ruobing.chen@zhishu.internal',
    role: 'editor',
    avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=120&q=80',
    token: 'mock_bearer_token_editor_zhishu_4521',
  },
  viewer: {
    id: 'usr_zhang_03',
    name: '张宇昂 (只读审核员)',
    email: 'yuang.zhang@zhishu.internal',
    role: 'viewer',
    avatar: 'https://images.unsplash.com/photo-1492562080023-ab3db95bfbce?auto=format&fit=crop&w=120&q=80',
    token: 'mock_bearer_token_viewer_zhishu_1104',
  },
};

const INITIAL_WORKSPACES: Workspace[] = [
  {
    id: 'ws-tech',
    name: '技术工程空间',
    icon: '💻',
    description: '涵盖架构白皮书、协同协议、服务网格与高可用规范。',
    createdAt: '2026-03-15T09:00:00.000Z',
    memberCount: 28,
    folders: [
      { id: 'fld_arch', spaceId: 'ws-tech', name: '01_核心架构与方案', parentId: null, icon: '📁' },
      { id: 'fld_collab', spaceId: 'ws-tech', name: '02_协同引擎与CRDT', parentId: null, icon: '⚡' },
      { id: 'fld_infra', spaceId: 'ws-tech', name: '03_基础设施与S3存储', parentId: null, icon: '📦' },
    ],
    pages: [
      { id: 'doc-001', title: '知书产品技术白皮书与协同架构设计', parentId: null, folderId: 'fld_arch', icon: '📘' },
      { id: 'doc-002', title: '微服务架构重构迁移方案与实施路线', parentId: null, folderId: 'fld_arch', icon: '⚙️' },
      { id: 'doc-005', title: '旧版运维审计日志系统归档记录', parentId: null, folderId: 'fld_infra', icon: '📦' },
    ],
  },
  {
    id: 'ws-product',
    name: '产品规划空间',
    icon: '🧭',
    description: '知书产品路线图、PRD、用户画像及端到端体验度量。',
    createdAt: '2026-04-10T10:30:00.000Z',
    memberCount: 15,
    folders: [
      { id: 'fld_ux', spaceId: 'ws-product', name: '01_用户体验与无障碍设计', parentId: null, icon: '🎨' },
      { id: 'fld_roadmap', spaceId: 'ws-product', name: '02_产品路线图与发布计划', parentId: null, icon: '🚀' },
    ],
    pages: [
      { id: 'doc-004', title: '2026 Q3 移动端体验专项复盘与度量', parentId: null, folderId: 'fld_ux', icon: '📱' },
    ],
  },
  {
    id: 'ws-security',
    name: '安全合规中心',
    icon: '🛡️',
    description: 'RBAC/ACL 规范、数据隔离与安全合规制度。',
    createdAt: '2026-05-02T14:15:00.000Z',
    memberCount: 12,
    folders: [
      { id: 'fld_acl', spaceId: 'ws-security', name: '01_权限与主体策略', parentId: null, icon: '🔒' },
      { id: 'fld_compliance', spaceId: 'ws-security', name: '02_合规审计流水', parentId: null, icon: '📋' },
    ],
    pages: [
      { id: 'doc-003', title: '企业级多租户权限系统 (RBAC/ACL) 规范', parentId: null, folderId: 'fld_acl', icon: '🛡️' },
    ],
  },
];

const INITIAL_DOCUMENTS: DocumentData[] = [
  {
    metadata: {
      id: 'doc-001',
      title: '知书产品技术白皮书与协同架构设计',
      emoji: '📘',
      tags: ['协同内核', '架构设计', 'M2基线'],
      mode: 'collaborative',
      metadataRevision: 1,
      snapshotRevision: 1,
      durableSeq: 24,
      generation: 'gen-001',
      createdAt: '2026-09-20T10:00:00.000Z',
      updatedAt: '2026-10-02T16:45:00.000Z',
      deletedAt: null,
      isStarred: true,
      isArchived: false,
      ownerId: 'usr_lin_01',
      ownerName: '林修文',
      canManage: true,
      canEdit: true,
      spaceId: 'ws-tech',
      spaceName: '技术工程空间',
      folderId: 'fld_arch',
      folderName: '01_核心架构与方案',
      summary: '双模式（实时协同/普通快照）底层架构、durable ack持久化机制与宿主适配器设计规范。',
    },
    blocks: [
      {
        id: 'blk-title',
        type: 'heading',
        headingLevel: 1,
        text: '知书产品技术白皮书与协同架构设计',
      },
      {
        id: 'blk-intro',
        type: 'paragraph',
        text: '知书（Zhishu）作为独立文档产品与企业知识平台，通过六个核心 packages 组合构建。新建文档时可显式选择实时协同或普通快照模式。协同模式下编辑页分别展示连接、同步和 durable ack 持久化状态；普通模式使用独立 JSON 快照编辑器和显式修订保存。',
      },
      {
        id: 'blk-callout-1',
        type: 'callout',
        calloutVariant: 'info',
        calloutContent: '提示：协同模式采用 Hocuspocus/Yjs 协议，每一次变更获得 durable ack 递增序号；历史版本恢复会 Fork 产生新的 generation 代次。',
      },
      {
        id: 'blk-h2-1',
        type: 'heading',
        headingLevel: 2,
        text: '1. 宿主适配器与资产管理规范',
      },
      {
        id: 'blk-para-asset',
        type: 'paragraph',
        text: '普通快照与协同文档共用 -document-asset-services.ts 提供的文档级宿主适配器：上传会话、幂等重试、取消清理和短时 URL 解析从同一处实现；正文只写稳定 assetId 与媒体信息，授权 URL 留在 DOM 状态中。',
      },
      {
        id: 'blk-img-1',
        type: 'image',
        assetId: 'ast_sys_arch_001',
        imageAlt: '知书双模式协同流与快照持久化时序拓扑图',
        imageWidth: '100%',
        imageHeight: 'auto',
        signedAuthUrl: 'https://images.unsplash.com/photo-1558494949-ef010cbdcc31?auto=format&fit=crop&w=1200&q=80',
      },
      {
        id: 'blk-h2-2',
        type: 'heading',
        headingLevel: 2,
        text: '2. 协同协议代码段与 durable ack',
      },
      {
        id: 'blk-para-code',
        type: 'paragraph',
        text: '编辑器历史预览复用只读 EditorProvider，并挂载 EditorCodeBlockView；语言选择禁用，代码复制在历史与当前正文中始终可用：',
      },
      {
        id: 'blk-code-1',
        type: 'code',
        codeLanguage: 'typescript',
        codeContent: `export interface CollabSyncState {
  durableSeq: number;        // 持久化序号 (如 2 -> 24)
  generation: string;        // 代次标识 (恢复历史后分配新代次)
  connection: 'connected' | 'connecting' | 'disconnected';
  syncStatus: 'synced' | 'syncing' | 'pending';
  canManage: boolean;
}`,
      },
      {
        id: 'blk-h2-3',
        type: 'heading',
        headingLevel: 2,
        text: '3. 核心指标与功能交付对照表',
      },
      {
        id: 'blk-tbl-1',
        type: 'table',
        tableHeaders: ['特性模块', '普通快照模式', '实时协同模式', '状态'],
        tableRows: [
          ['正文结构', 'JSON Snapshot', 'Yjs CRDT Doc', '已验收'],
          ['版本恢复', '递增 snapshotRevision', '恢复至新 generation', '已验证'],
          ['附件上传', '同一上传会话幂等重试', '短时签名URL授权', '已验证'],
          ['差异比对', '按 Block 历史逐行比对', '只读独立实例比对', '已支持'],
        ],
      },
      {
        id: 'blk-pdf-1',
        type: 'pdf',
        assetId: 'ast_spec_pdf_01',
        pdfFilename: 'Zhishu_Architecture_RFC_0017.pdf',
        pdfFileSize: '2.4 MB',
        pdfPageCount: 16,
        signedAuthUrl: 'https://storage.zhishu.internal/auth-assets/ast_spec_pdf_01/Zhishu_Architecture_RFC_0017.pdf?signed=mock_token_8871',
      },
    ],
  },
  {
    metadata: {
      id: 'doc-002',
      title: '微服务架构重构迁移方案与实施路线',
      emoji: '⚙️',
      tags: ['后端改造', '快照文档', '高优先级'],
      mode: 'snapshot',
      metadataRevision: 1,
      snapshotRevision: 4,
      durableSeq: 0,
      generation: 'none',
      createdAt: '2026-09-22T08:30:00.000Z',
      updatedAt: '2026-10-01T11:20:00.000Z',
      deletedAt: null,
      isStarred: true,
      isArchived: false,
      ownerId: 'usr_lin_01',
      ownerName: '林修文',
      canManage: true,
      canEdit: true,
      spaceId: 'ws-tech',
      spaceName: '技术工程空间',
      folderId: 'fld_arch',
      folderName: '01_核心架构与方案',
      summary: '采用快照模式的独立文档，包含数据库分库分表路线与服务网格 Istio 灰度方案。',
    },
    blocks: [
      {
        id: 'blk-title-2',
        type: 'heading',
        headingLevel: 1,
        text: '微服务架构重构迁移方案与实施路线',
      },
      {
        id: 'blk-p1-2',
        type: 'paragraph',
        text: '本文档使用普通快照模式维护，每次保存提交显式 snapshotRevision。支持并发冲突拦截与草稿离线暂存。',
      },
      {
        id: 'blk-h2-tasks',
        type: 'heading',
        headingLevel: 2,
        text: '关键里程碑任务清单',
      },
      {
        id: 'blk-tasks-1',
        type: 'task-list',
        taskItems: [
          { id: 't1', text: '完成 PostgreSQL 0017 快照版本迁移脚本编写与回滚测试', completed: true },
          { id: 't2', text: '配置单节点 Garage 本地 S3 端点并跑通存储异常重试', completed: true },
          { id: 't3', text: '压测 Hocuspocus 在 200 并发协同编辑下的 durable ack 延迟', completed: false },
          { id: 't4', text: '上线基于 Orval 生成的 OpenAPI 客户端与漂移检查', completed: true },
        ],
      },
    ],
  },
  {
    metadata: {
      id: 'doc-003',
      title: '企业级多租户权限系统 (RBAC/ACL) 规范',
      emoji: '🛡️',
      tags: ['安全规范', 'ACL', '合规'],
      mode: 'collaborative',
      metadataRevision: 1,
      snapshotRevision: 1,
      durableSeq: 12,
      generation: 'gen-002',
      createdAt: '2026-09-25T14:00:00.000Z',
      updatedAt: '2026-09-30T17:10:00.000Z',
      deletedAt: null,
      isStarred: false,
      isArchived: false,
      ownerId: 'usr_chen_02',
      ownerName: '陈若冰',
      canManage: false,
      canEdit: true,
      spaceId: 'ws-security',
      spaceName: '安全合规中心',
      folderId: 'fld_acl',
      folderName: '01_权限与主体策略',
      summary: '详细界定工作区、空间及单个文档级别的主体授权与能力继承逻辑。',
    },
    blocks: [
      {
        id: 'blk-title-3',
        type: 'heading',
        headingLevel: 1,
        text: '企业级多租户权限系统 (RBAC/ACL) 规范',
      },
      {
        id: 'blk-p1-3',
        type: 'paragraph',
        text: '所有者可在文档页按主体 ID 查看、授予、更新和撤销 ACL；本地已验授权、更新、有效能力展示与撤销。',
      },
    ],
  },
  {
    metadata: {
      id: 'doc-004',
      title: '2026 Q3 移动端体验专项复盘与度量',
      emoji: '📱',
      tags: ['移动端', '体验专项', '复盘'],
      mode: 'snapshot',
      metadataRevision: 2,
      snapshotRevision: 2,
      durableSeq: 0,
      generation: 'none',
      createdAt: '2026-09-28T09:15:00.000Z',
      updatedAt: '2026-10-02T14:30:00.000Z',
      deletedAt: null,
      isStarred: true,
      isArchived: false,
      ownerId: 'usr_lin_01',
      ownerName: '林修文',
      canManage: true,
      canEdit: true,
      spaceId: 'ws-product',
      spaceName: '产品规划空间',
      folderId: 'fld_ux',
      folderName: '01_用户体验与无障碍设计',
      summary: '窄屏抽屉化导航、320px 无横向滚动、触控靶心与可访问性专项成果。',
    },
    blocks: [
      {
        id: 'blk-title-4',
        type: 'heading',
        headingLevel: 1,
        text: '2026 Q3 移动端体验专项复盘与度量',
      },
      {
        id: 'blk-p1-4',
        type: 'paragraph',
        text: '针对窄屏基础编辑目标，桌面 288px 导航与大纲在小屏自动折叠为 Dialog 抽屉，关闭后焦点精准返回触发按钮。',
      },
    ],
  },
  {
    metadata: {
      id: 'doc-005',
      title: '旧版运维审计日志系统归档记录',
      emoji: '📦',
      tags: ['历史归档', '审计'],
      mode: 'snapshot',
      metadataRevision: 1,
      snapshotRevision: 1,
      durableSeq: 0,
      generation: 'none',
      createdAt: '2026-08-10T11:00:00.000Z',
      updatedAt: '2026-08-20T10:00:00.000Z',
      deletedAt: null,
      isStarred: false,
      isArchived: true,
      ownerId: 'usr_lin_01',
      ownerName: '林修文',
      canManage: true,
      canEdit: false,
      spaceId: 'ws-tech',
      spaceName: '技术工程空间',
      folderId: 'fld_infra',
      folderName: '03_基础设施与S3存储',
      summary: '已归档只读日志规范文档，仅保留查看和导出能力。',
    },
    blocks: [
      {
        id: 'blk-title-5',
        type: 'heading',
        headingLevel: 1,
        text: '旧版运维审计日志系统归档记录',
      },
      {
        id: 'blk-p1-5',
        type: 'paragraph',
        text: '此文档已于 2026 年 8 月归档。归档文档默认呈只读状态。',
      },
    ],
  },
  {
    metadata: {
      id: 'doc-006',
      title: '待清理临时接口测试文档',
      emoji: '🗑️',
      tags: ['临时测试'],
      mode: 'snapshot',
      metadataRevision: 1,
      snapshotRevision: 1,
      durableSeq: 0,
      generation: 'none',
      createdAt: '2026-09-12T15:00:00.000Z',
      updatedAt: '2026-09-15T16:00:00.000Z',
      deletedAt: '2026-09-29T10:30:00.000Z',
      isStarred: false,
      isArchived: false,
      ownerId: 'usr_lin_01',
      ownerName: '林修文',
      canManage: true,
      canEdit: false,
      spaceId: null,
      summary: '已移入回收站的草稿文档，保留恢复与永久删除入口。',
    },
    blocks: [
      {
        id: 'blk-title-6',
        type: 'heading',
        headingLevel: 1,
        text: '待清理临时接口测试文档',
      },
      {
        id: 'blk-p1-6',
        type: 'paragraph',
        text: '该文档位于回收站中，所有者可恢复或执行永久删除。',
      },
    ],
  },
];

const INITIAL_VERSIONS: VersionRecord[] = [
  {
    id: 'ver-001',
    documentId: 'doc-001',
    versionType: 'named',
    name: 'v1.0 架构初版评审快照',
    durableSeq: 10,
    generation: 'gen-001',
    createdAt: '2026-09-28T14:20:00.000Z',
    author: {
      id: 'usr_lin_01',
      name: '林修文',
      avatar: MOCK_USERS.owner.avatar,
    },
    changeSummary: '完成协同服务接口草案与宿主适配器基础设计。',
    blocks: [
      {
        id: 'blk-title',
        type: 'heading',
        headingLevel: 1,
        text: '知书产品技术白皮书与协同架构设计 (v1.0 草案)',
      },
      {
        id: 'blk-intro',
        type: 'paragraph',
        text: '知书初步草案：仅支持基础协同模式与单一本地存储。',
      },
      {
        id: 'blk-code-1',
        type: 'code',
        codeLanguage: 'typescript',
        codeContent: `// 早期初始草案
export interface SimpleDoc {
  id: string;
  seq: number;
}`,
      },
    ],
  },
  {
    id: 'ver-002',
    documentId: 'doc-001',
    versionType: 'named',
    name: 'v1.1 M2 中期里程碑确认版',
    durableSeq: 20,
    generation: 'gen-001',
    createdAt: '2026-10-01T10:00:00.000Z',
    author: {
      id: 'usr_chen_02',
      name: '陈若冰',
      avatar: MOCK_USERS.editor.avatar,
    },
    changeSummary: '增补图片短时授权与 PDF 附件协同插入 durable ack 验证。',
    blocks: INITIAL_DOCUMENTS[0].blocks,
  },
  {
    id: 'ver-003',
    documentId: 'doc-002',
    versionType: 'named',
    name: '快照版本 rev 2 (归档基准)',
    snapshotRevision: 2,
    createdAt: '2026-09-26T17:00:00.000Z',
    author: {
      id: 'usr_lin_01',
      name: '林修文',
      avatar: MOCK_USERS.owner.avatar,
    },
    changeSummary: '初始完成任务清单拆解。',
    blocks: INITIAL_DOCUMENTS[1].blocks.slice(0, 3),
  },
];

const INITIAL_COMMENTS: CommentThread[] = [
  {
    id: 'cmt-001',
    documentId: 'doc-001',
    blockId: 'blk-para-asset',
    quotedText: '正文只写稳定 assetId 与媒体信息，授权 URL 留在 DOM 状态中',
    status: 'open',
    isTargetInvalidated: false,
    createdAt: '2026-10-02T10:15:00.000Z',
    comments: [
      {
        id: 'c1',
        author: {
          id: 'usr_chen_02',
          name: '陈若冰',
          avatar: MOCK_USERS.editor.avatar,
        },
        content: '@林修文 这个设计有效避免了短时签名过期导致正文产生脏写，非常赞同。',
        createdAt: '2026-10-02T10:15:00.000Z',
        mentions: ['usr_lin_01'],
      },
      {
        id: 'c2',
        author: {
          id: 'usr_lin_01',
          name: '林修文',
          avatar: MOCK_USERS.owner.avatar,
        },
        content: '是的，且通过宿主适配器统一管理重试与取消，避免悬挂对象。',
        createdAt: '2026-10-02T10:25:00.000Z',
      },
    ],
  },
];

const INITIAL_NOTIFICATIONS: MentionNotification[] = [
  {
    id: 'notif-001',
    recipientId: 'usr_lin_01',
    author: {
      id: 'usr_chen_02',
      name: '陈若冰',
      avatar: MOCK_USERS.editor.avatar,
    },
    documentId: 'doc-001',
    documentTitle: '知书产品技术白皮书与协同架构设计',
    commentId: 'c1',
    commentContent: '@林修文 这个设计有效避免了短时签名过期导致正文产生脏写，非常赞同。',
    quotedText: '正文只写稳定 assetId 与媒体信息，授权 URL 留在 DOM 状态中',
    createdAt: '2026-10-02T10:15:00.000Z',
    isRead: false,
  },
  {
    id: 'notif-002',
    recipientId: 'usr_lin_01',
    author: {
      id: 'usr_zhang_03',
      name: '张宇昂',
      avatar: MOCK_USERS.viewer.avatar,
    },
    documentId: 'doc-003',
    documentTitle: '企业级多租户权限系统 (RBAC/ACL) 规范',
    commentId: 'c3',
    commentContent: '@林修文 请确认该文档中的所有者越权策略是否需要补充二次确认规则。',
    quotedText: '所有者可在文档页按主体 ID 查看、授予、更新和撤销 ACL',
    createdAt: '2026-10-02T16:20:00.000Z',
    isRead: false,
  },
];

const INITIAL_ACL: Record<string, ACLPrincipal[]> = {
  'doc-001': [
    {
      id: 'usr_lin_01',
      name: '林修文 (所有者)',
      type: 'user',
      role: 'owner',
      avatar: MOCK_USERS.owner.avatar,
      effectiveCapabilities: {
        canEdit: true,
        canComment: true,
        canManage: true,
        canShare: true,
      },
    },
    {
      id: 'usr_chen_02',
      name: '陈若冰 (协作作者)',
      type: 'user',
      role: 'editor',
      avatar: MOCK_USERS.editor.avatar,
      effectiveCapabilities: {
        canEdit: true,
        canComment: true,
        canManage: false,
        canShare: false,
      },
    },
    {
      id: 'usr_zhang_03',
      name: '张宇昂 (只读审计员)',
      type: 'user',
      role: 'viewer',
      avatar: MOCK_USERS.viewer.avatar,
      effectiveCapabilities: {
        canEdit: false,
        canComment: true,
        canManage: false,
        canShare: false,
      },
    },
    {
      id: 'grp_arch_team',
      name: '架构委员会核心工作组',
      type: 'group',
      role: 'editor',
      effectiveCapabilities: {
        canEdit: true,
        canComment: true,
        canManage: false,
        canShare: false,
      },
    },
  ],
  'doc-003': [
    {
      id: 'usr_chen_02',
      name: '陈若冰 (所有者)',
      type: 'user',
      role: 'owner',
      avatar: MOCK_USERS.editor.avatar,
      effectiveCapabilities: { canEdit: true, canComment: true, canManage: true, canShare: true },
    },
    {
      id: 'usr_lin_01',
      name: '林修文 (特邀协作者)',
      type: 'user',
      role: 'editor',
      avatar: MOCK_USERS.owner.avatar,
      effectiveCapabilities: { canEdit: true, canComment: true, canManage: false, canShare: false },
    },
  ],
};

const INITIAL_KNOWLEDGE: KnowledgeSource[] = [
  {
    id: 'ks-01',
    title: '知书内核协同与 CRDT 规约库',
    spaceId: 'ws-tech',
    spaceName: '技术工程空间',
    documentCount: 14,
    indexStatus: 'ready',
    lastSyncedAt: '2026-10-02T15:30:00.000Z',
    snippetSummary: '包含 Yjs CRDT 数据模型、durable ack 提交协议、短时资产签名与离线重放规约。',
  },
  {
    id: 'ks-02',
    title: '企业多租户与微服务实施库',
    spaceId: 'ws-tech',
    spaceName: '技术工程空间',
    documentCount: 26,
    indexStatus: 'ready',
    lastSyncedAt: '2026-10-01T12:00:00.000Z',
    snippetSummary: '服务拆分、PostgreSQL 0017 快照迁移规范、Garage 本地 S3 端点对接方案。',
  },
  {
    id: 'ks-03',
    title: '移动端窄屏交互规范库 (M2)',
    spaceId: 'ws-product',
    spaceName: '产品规划空间',
    documentCount: 8,
    indexStatus: 'indexing',
    lastSyncedAt: '2026-10-03T02:00:00.000Z',
    snippetSummary: '320px 无溢出适配、Dialog 抽屉按键焦点还原、无横向滚动规约。',
  },
];

class StorageService {
  private currentUser: CurrentUser = MOCK_USERS.owner;
  private idempotencyCache: Set<string> = new Set();

  constructor() {
    this.initData();
  }

  private initData() {
    if (!localStorage.getItem(STORAGE_KEYS.DOCUMENTS)) {
      localStorage.setItem(STORAGE_KEYS.DOCUMENTS, JSON.stringify(INITIAL_DOCUMENTS));
    }
    if (!localStorage.getItem(STORAGE_KEYS.VERSIONS)) {
      localStorage.setItem(STORAGE_KEYS.VERSIONS, JSON.stringify(INITIAL_VERSIONS));
    }
    if (!localStorage.getItem(STORAGE_KEYS.COMMENTS)) {
      localStorage.setItem(STORAGE_KEYS.COMMENTS, JSON.stringify(INITIAL_COMMENTS));
    }
    if (!localStorage.getItem(STORAGE_KEYS.WORKSPACES)) {
      localStorage.setItem(STORAGE_KEYS.WORKSPACES, JSON.stringify(INITIAL_WORKSPACES));
    }
    if (!localStorage.getItem(STORAGE_KEYS.KNOWLEDGE)) {
      localStorage.setItem(STORAGE_KEYS.KNOWLEDGE, JSON.stringify(INITIAL_KNOWLEDGE));
    }
    if (!localStorage.getItem(STORAGE_KEYS.NOTIFICATIONS)) {
      localStorage.setItem(STORAGE_KEYS.NOTIFICATIONS, JSON.stringify(INITIAL_NOTIFICATIONS));
    }
    const savedUser = sessionStorage.getItem(STORAGE_KEYS.USER);
    if (savedUser) {
      try {
        this.currentUser = JSON.parse(savedUser);
      } catch {
        this.currentUser = MOCK_USERS.owner;
      }
    }
  }

  // --- Current User & Dev Token Simulation ---
  public getCurrentUser(): CurrentUser {
    return this.currentUser;
  }

  public switchUser(role: 'owner' | 'editor' | 'viewer'): CurrentUser {
    this.currentUser = MOCK_USERS[role];
    sessionStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(this.currentUser));
    return this.currentUser;
  }

  // --- Documents Query & CRUD ---
  public getDocuments(filter: {
    view: WorkbenchView;
    search?: string;
    sort?: WorkbenchSortField;
    direction?: SortDirection;
    spaceId?: string;
    folderId?: string;
  }): DocumentMetadata[] {
    const raw = localStorage.getItem(STORAGE_KEYS.DOCUMENTS);
    let docs: DocumentData[] = raw ? JSON.parse(raw) : INITIAL_DOCUMENTS;

    // Filter by View
    if (filter.view === 'trash') {
      docs = docs.filter((d) => d.metadata.deletedAt !== null);
    } else {
      docs = docs.filter((d) => d.metadata.deletedAt === null);

      if (filter.view === 'relevant') {
        // 与我相关：我创建的、有ACL权限的、或被@提及的文档
        const notifs = this.getNotifications(this.currentUser.id);
        const mentionedDocIds = new Set(notifs.map((n) => n.documentId));

        docs = docs.filter((d) => {
          if (d.metadata.isArchived) return false;
          const isOwner = d.metadata.ownerId === this.currentUser.id;
          const hasAcl = this.getACL(d.metadata.id).some((p) => p.id === this.currentUser.id);
          const isMentioned = mentionedDocIds.has(d.metadata.id);
          return isOwner || hasAcl || isMentioned;
        });
      } else if (filter.view === 'starred') {
        docs = docs.filter((d) => d.metadata.isStarred && !d.metadata.isArchived);
      } else if (filter.view === 'archived') {
        docs = docs.filter((d) => d.metadata.isArchived);
      } else if (filter.view === 'my') {
        docs = docs.filter((d) => d.metadata.ownerId === this.currentUser.id && !d.metadata.isArchived);
      } else if (filter.view === 'recent' || filter.view === 'all') {
        docs = docs.filter((d) => !d.metadata.isArchived);
      }
    }

    // Filter by Space if provided
    if (filter.spaceId) {
      docs = docs.filter((d) => d.metadata.spaceId === filter.spaceId);
    }

    // Filter by Folder if provided
    if (filter.folderId) {
      docs = docs.filter((d) => d.metadata.folderId === filter.folderId);
    }

    // Filter by Search Keyword
    if (filter.search && filter.search.trim()) {
      const q = filter.search.toLowerCase().trim();
      docs = docs.filter((d) => {
        const titleMatch = d.metadata.title.toLowerCase().includes(q);
        const tagMatch = d.metadata.tags.some((t) => t.toLowerCase().includes(q));
        const summaryMatch = d.metadata.summary.toLowerCase().includes(q);
        const blockMatch = d.blocks.some((b) => (b.text || b.codeContent || '').toLowerCase().includes(q));
        return titleMatch || tagMatch || summaryMatch || blockMatch;
      });
    }

    // Sort
    const sortField = filter.sort || 'updatedAt';
    const direction = filter.direction || 'desc';

    docs.sort((a, b) => {
      let comparison = 0;
      if (sortField === 'title') {
        comparison = a.metadata.title.localeCompare(b.metadata.title, 'zh-Hans-CN');
      } else {
        const timeA = new Date(a.metadata[sortField]).getTime();
        const timeB = new Date(b.metadata[sortField]).getTime();
        comparison = timeA - timeB;
      }
      return direction === 'asc' ? comparison : -comparison;
    });

    // Populate dynamic canManage / canEdit based on current user role
    return docs.map((d) => {
      const isOwner = this.currentUser.role === 'owner' || d.metadata.ownerId === this.currentUser.id;
      const isViewer = this.currentUser.role === 'viewer';
      return {
        ...d.metadata,
        canManage: isOwner,
        canEdit: !isViewer && !d.metadata.isArchived && d.metadata.deletedAt === null,
      };
    });
  }

  public getDocumentById(id: string): DocumentData | null {
    const raw = localStorage.getItem(STORAGE_KEYS.DOCUMENTS);
    const docs: DocumentData[] = raw ? JSON.parse(raw) : INITIAL_DOCUMENTS;
    const doc = docs.find((d) => d.metadata.id === id);
    if (!doc) return null;

    const isOwner = this.currentUser.role === 'owner' || doc.metadata.ownerId === this.currentUser.id;
    const isViewer = this.currentUser.role === 'viewer';

    return {
      metadata: {
        ...doc.metadata,
        canManage: isOwner,
        canEdit: !isViewer && !doc.metadata.isArchived && doc.metadata.deletedAt === null,
      },
      blocks: doc.blocks,
    };
  }

  /**
   * 移动文档（指定目标空间与目标目录）
   */
  public moveDocument(
    docId: string,
    targetSpaceId: string | null,
    targetFolderId?: string | null
  ): DocumentData {
    const docs = this.getAllDocuments();
    const index = docs.findIndex((d) => d.metadata.id === docId);
    if (index === -1) throw new Error(`Document [${docId}] not found`);

    const doc = docs[index];
    const workspaces = this.getWorkspaces();
    const targetSpace = targetSpaceId ? workspaces.find((w) => w.id === targetSpaceId) : null;
    const targetFolder = targetSpace && targetFolderId
      ? targetSpace.folders.find((f) => f.id === targetFolderId)
      : null;

    doc.metadata.spaceId = targetSpaceId;
    doc.metadata.spaceName = targetSpace ? targetSpace.name : undefined;
    doc.metadata.folderId = targetFolderId || null;
    doc.metadata.folderName = targetFolder ? targetFolder.name : undefined;
    doc.metadata.updatedAt = new Date().toISOString();

    docs[index] = doc;
    this.saveAllDocuments(docs);
    return doc;
  }

  /**
   * 创建文档（支持 Idempotency-Key 幂等重试）
   */
  public createDocument(params: {
    title: string;
    mode: 'collaborative' | 'snapshot';
    emoji?: string;
    spaceId?: string | null;
    folderId?: string | null;
    template?: 'blank' | 'rfc' | 'meeting' | 'api';
    idempotencyKey?: string;
  }): DocumentData {
    if (params.idempotencyKey && this.idempotencyCache.has(params.idempotencyKey)) {
      const existingDocs = this.getAllDocuments();
      const matched = existingDocs.find((d) => d.metadata.title === params.title);
      if (matched) return matched;
    }

    if (params.idempotencyKey) {
      this.idempotencyCache.add(params.idempotencyKey);
    }

    const docId = `doc-${Date.now().toString(36)}`;
    const now = new Date().toISOString();

    const workspaces = this.getWorkspaces();
    const targetSpace = params.spaceId ? workspaces.find((w) => w.id === params.spaceId) : null;
    const targetFolder = targetSpace && params.folderId
      ? targetSpace.folders.find((f) => f.id === params.folderId)
      : null;

    let initialBlocks: DocumentBlock[] = [
      {
        id: `blk-${Date.now()}-h1`,
        type: 'heading',
        headingLevel: 1,
        text: params.title || '无标题文档',
      },
      {
        id: `blk-${Date.now()}-p1`,
        type: 'paragraph',
        text: '开始在此记录您的想法与工程架构设计...',
      },
    ];

    if (params.template === 'rfc') {
      initialBlocks = [
        { id: 'b1', type: 'heading', headingLevel: 1, text: params.title },
        { id: 'b2', type: 'callout', calloutVariant: 'info', calloutContent: 'RFC 目标：详细阐述技术设计方案与边界评估。' },
        { id: 'b3', type: 'heading', headingLevel: 2, text: '1. 背景与动机' },
        { id: 'b4', type: 'paragraph', text: '在此处描述当前系统面临的问题及重构必要性。' },
        { id: 'b5', type: 'heading', headingLevel: 2, text: '2. 核心架构设计' },
        { id: 'b6', type: 'code', codeLanguage: 'typescript', codeContent: '// 接口设计规约\ninterface SpecConfig {\n  version: string;\n}' },
      ];
    } else if (params.template === 'meeting') {
      initialBlocks = [
        { id: 'b1', type: 'heading', headingLevel: 1, text: `${params.title} - 会议纪要` },
        { id: 'b2', type: 'heading', headingLevel: 2, text: '参会成员与目标' },
        { id: 'b3', type: 'paragraph', text: '时间：2026-10-03 | 主持人：' + this.currentUser.name },
        { id: 'b4', type: 'heading', headingLevel: 2, text: '待办任务 (Action Items)' },
        { id: 'b5', type: 'task-list', taskItems: [
          { id: 't1', text: '跟进核心模块接口联调', completed: false },
          { id: 't2', text: '组织第二轮代码走查', completed: false },
        ]},
      ];
    }

    const newDoc: DocumentData = {
      metadata: {
        id: docId,
        title: params.title || '无标题文档',
        emoji: params.emoji || (params.mode === 'collaborative' ? '📘' : '📝'),
        tags: params.mode === 'collaborative' ? ['实时协同'] : ['快照文档'],
        mode: params.mode,
        metadataRevision: 1,
        snapshotRevision: 1,
        durableSeq: params.mode === 'collaborative' ? 1 : 0,
        generation: params.mode === 'collaborative' ? 'gen-001' : 'none',
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        isStarred: false,
        isArchived: false,
        ownerId: this.currentUser.id,
        ownerName: this.currentUser.name,
        canManage: true,
        canEdit: true,
        spaceId: params.spaceId || null,
        spaceName: targetSpace ? targetSpace.name : undefined,
        folderId: params.folderId || null,
        folderName: targetFolder ? targetFolder.name : undefined,
        summary: '新建文档，待丰富正文内容。',
      },
      blocks: initialBlocks,
    };

    const docs = this.getAllDocuments();
    docs.unshift(newDoc);
    this.saveAllDocuments(docs);

    // Initial auto version
    this.createVersionRecord({
      documentId: docId,
      versionType: 'auto',
      name: '初始创建自动快照',
      blocks: initialBlocks,
      changeSummary: '文档初始建立',
      snapshotRevision: 1,
      durableSeq: newDoc.metadata.durableSeq,
      generation: newDoc.metadata.generation,
    });

    return newDoc;
  }

  /**
   * 保存文档（支持快照修订号冲突校验与协同 durable ack 递增）
   */
  public saveDocument(
    id: string,
    payload: {
      blocks: DocumentBlock[];
      baseSnapshotRevision?: number;
      isCollabAck?: boolean;
    }
  ): { doc: DocumentData; conflict: boolean; message?: string } {
    const docs = this.getAllDocuments();
    const index = docs.findIndex((d) => d.metadata.id === id);
    if (index === -1) {
      throw new Error(`Document [${id}] not found`);
    }

    const doc = docs[index];

    // 快照并发冲突校验
    if (doc.metadata.mode === 'snapshot' && !payload.isCollabAck) {
      if (
        payload.baseSnapshotRevision !== undefined &&
        payload.baseSnapshotRevision !== doc.metadata.snapshotRevision
      ) {
        return {
          doc,
          conflict: true,
          message: `保存冲突！服务端当前修订号为 rev ${doc.metadata.snapshotRevision}，您提交的基础版本为 rev ${payload.baseSnapshotRevision}。已阻止覆盖，请先刷新或导出本地草稿。`,
        };
      }
      doc.metadata.snapshotRevision += 1;
    } else if (doc.metadata.mode === 'collaborative') {
      doc.metadata.durableSeq += 1;
    }

    doc.blocks = payload.blocks;
    doc.metadata.updatedAt = new Date().toISOString();
    
    // 更新摘要
    const firstP = payload.blocks.find((b) => b.type === 'paragraph' && b.text);
    if (firstP && firstP.text) {
      doc.metadata.summary = firstP.text.slice(0, 100);
    }

    docs[index] = doc;
    this.saveAllDocuments(docs);

    return { doc, conflict: false };
  }

  /**
   * 更新文档元数据 (带 metadataRevision 校验)
   */
  public updateMetadata(
    id: string,
    updates: Partial<DocumentMetadata> & { baseMetadataRevision?: number }
  ): { metadata: DocumentMetadata; conflict: boolean } {
    const docs = this.getAllDocuments();
    const index = docs.findIndex((d) => d.metadata.id === id);
    if (index === -1) throw new Error(`Document [${id}] not found`);

    const doc = docs[index];
    if (
      updates.baseMetadataRevision !== undefined &&
      updates.baseMetadataRevision !== doc.metadata.metadataRevision
    ) {
      return { metadata: doc.metadata, conflict: true };
    }

    Object.assign(doc.metadata, updates);
    doc.metadata.metadataRevision += 1;
    doc.metadata.updatedAt = new Date().toISOString();

    docs[index] = doc;
    this.saveAllDocuments(docs);
    return { metadata: doc.metadata, conflict: false };
  }

  // --- Document Actions (Star, Archive, Trash, Restore, Delete) ---
  public toggleStar(id: string): boolean {
    const docs = this.getAllDocuments();
    const doc = docs.find((d) => d.metadata.id === id);
    if (!doc) return false;
    doc.metadata.isStarred = !doc.metadata.isStarred;
    doc.metadata.updatedAt = new Date().toISOString();
    this.saveAllDocuments(docs);
    return doc.metadata.isStarred;
  }

  public toggleArchive(id: string): boolean {
    const docs = this.getAllDocuments();
    const doc = docs.find((d) => d.metadata.id === id);
    if (!doc) return false;
    doc.metadata.isArchived = !doc.metadata.isArchived;
    doc.metadata.updatedAt = new Date().toISOString();
    this.saveAllDocuments(docs);
    return doc.metadata.isArchived;
  }

  public moveToTrash(id: string): void {
    const docs = this.getAllDocuments();
    const doc = docs.find((d) => d.metadata.id === id);
    if (!doc) return;
    doc.metadata.deletedAt = new Date().toISOString();
    this.saveAllDocuments(docs);
  }

  public restoreFromTrash(id: string): void {
    const docs = this.getAllDocuments();
    const doc = docs.find((d) => d.metadata.id === id);
    if (!doc) return;
    doc.metadata.deletedAt = null;
    doc.metadata.updatedAt = new Date().toISOString();
    this.saveAllDocuments(docs);
  }

  public permanentlyDelete(id: string): boolean {
    const docs = this.getAllDocuments();
    const doc = docs.find((d) => d.metadata.id === id);
    if (!doc) return false;
    if (this.currentUser.role !== 'owner' && doc.metadata.ownerId !== this.currentUser.id) {
      throw new Error('权限不足：仅所有者 (Owner) 可执行永久删除操作');
    }
    const filtered = docs.filter((d) => d.metadata.id !== id);
    this.saveAllDocuments(filtered);
    return true;
  }

  // --- Versions & Restore ---
  public getVersions(documentId: string): VersionRecord[] {
    const raw = localStorage.getItem(STORAGE_KEYS.VERSIONS);
    const versions: VersionRecord[] = raw ? JSON.parse(raw) : INITIAL_VERSIONS;
    return versions
      .filter((v) => v.documentId === documentId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  public createVersionRecord(params: {
    documentId: string;
    versionType: 'auto' | 'named';
    name: string;
    blocks: DocumentBlock[];
    changeSummary: string;
    snapshotRevision?: number;
    durableSeq?: number;
    generation?: string;
  }): VersionRecord {
    const raw = localStorage.getItem(STORAGE_KEYS.VERSIONS);
    const versions: VersionRecord[] = raw ? JSON.parse(raw) : INITIAL_VERSIONS;

    const newRecord: VersionRecord = {
      id: `ver-${Date.now()}`,
      documentId: params.documentId,
      versionType: params.versionType,
      name: params.name,
      snapshotRevision: params.snapshotRevision,
      durableSeq: params.durableSeq,
      generation: params.generation,
      createdAt: new Date().toISOString(),
      author: {
        id: this.currentUser.id,
        name: this.currentUser.name,
        avatar: this.currentUser.avatar,
      },
      changeSummary: params.changeSummary,
      blocks: params.blocks,
    };

    versions.unshift(newRecord);
    localStorage.setItem(STORAGE_KEYS.VERSIONS, JSON.stringify(versions));
    return newRecord;
  }

  public restoreVersion(documentId: string, versionId: string): DocumentData {
    const versions = this.getVersions(documentId);
    const targetVersion = versions.find((v) => v.id === versionId);
    if (!targetVersion) throw new Error('Target version not found');

    const docs = this.getAllDocuments();
    const doc = docs.find((d) => d.metadata.id === documentId);
    if (!doc) throw new Error('Document not found');

    doc.blocks = JSON.parse(JSON.stringify(targetVersion.blocks));
    doc.metadata.updatedAt = new Date().toISOString();

    if (doc.metadata.mode === 'snapshot') {
      doc.metadata.snapshotRevision += 1;
    } else {
      const currentGenNum = parseInt(doc.metadata.generation.replace('gen-', '') || '1', 10);
      const nextGen = `gen-${String(currentGenNum + 1).padStart(3, '0')}`;
      doc.metadata.generation = nextGen;
      doc.metadata.durableSeq += 1;
    }

    this.saveAllDocuments(docs);

    this.createVersionRecord({
      documentId,
      versionType: 'auto',
      name: `恢复自 [${targetVersion.name}]`,
      blocks: doc.blocks,
      changeSummary: `确认恢复历史版本，${doc.metadata.mode === 'collaborative' ? `代次演进为 ${doc.metadata.generation}` : `快照修订号升至 rev ${doc.metadata.snapshotRevision}`}`,
      snapshotRevision: doc.metadata.snapshotRevision,
      durableSeq: doc.metadata.durableSeq,
      generation: doc.metadata.generation,
    });

    return doc;
  }

  // --- ACL Management ---
  public getACL(documentId: string): ACLPrincipal[] {
    const saved = localStorage.getItem(`zhishu_acl_${documentId}`);
    if (saved) return JSON.parse(saved);
    return INITIAL_ACL[documentId] || [
      {
        id: this.currentUser.id,
        name: this.currentUser.name,
        type: 'user',
        role: 'owner',
        avatar: this.currentUser.avatar,
        effectiveCapabilities: {
          canEdit: true,
          canComment: true,
          canManage: true,
          canShare: true,
        },
      },
    ];
  }

  public updateACL(documentId: string, acl: ACLPrincipal[]): void {
    localStorage.setItem(`zhishu_acl_${documentId}`, JSON.stringify(acl));
  }

  // --- Comments & Mentions ---
  public getComments(documentId: string): CommentThread[] {
    const raw = localStorage.getItem(STORAGE_KEYS.COMMENTS);
    const comments: CommentThread[] = raw ? JSON.parse(raw) : INITIAL_COMMENTS;
    return comments.filter((c) => c.documentId === documentId);
  }

  public addCommentThread(documentId: string, thread: {
    blockId: string | null;
    quotedText?: string;
    content: string;
    mentions?: string[];
  }): CommentThread {
    const raw = localStorage.getItem(STORAGE_KEYS.COMMENTS);
    const allComments: CommentThread[] = raw ? JSON.parse(raw) : INITIAL_COMMENTS;

    const commentId = `c-${Date.now()}`;
    const newThread: CommentThread = {
      id: `cmt-${Date.now()}`,
      documentId,
      blockId: thread.blockId,
      quotedText: thread.quotedText,
      status: 'open',
      isTargetInvalidated: false,
      createdAt: new Date().toISOString(),
      comments: [
        {
          id: commentId,
          author: {
            id: this.currentUser.id,
            name: this.currentUser.name,
            avatar: this.currentUser.avatar,
          },
          content: thread.content,
          createdAt: new Date().toISOString(),
          mentions: thread.mentions,
        },
      ],
    };

    allComments.unshift(newThread);
    localStorage.setItem(STORAGE_KEYS.COMMENTS, JSON.stringify(allComments));

    // If there are mentions, generate notification records for recipients
    if (thread.mentions && thread.mentions.length > 0) {
      const doc = this.getDocumentById(documentId);
      const docTitle = doc?.metadata.title || '知书文档';
      const allNotifs = this.getNotifications();

      thread.mentions.forEach((recipientId) => {
        allNotifs.unshift({
          id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          recipientId,
          author: {
            id: this.currentUser.id,
            name: this.currentUser.name,
            avatar: this.currentUser.avatar,
          },
          documentId,
          documentTitle: docTitle,
          commentId,
          commentContent: thread.content,
          quotedText: thread.quotedText,
          createdAt: new Date().toISOString(),
          isRead: false,
        });
      });

      localStorage.setItem(STORAGE_KEYS.NOTIFICATIONS, JSON.stringify(allNotifs));
    }

    return newThread;
  }

  public replyComment(threadId: string, content: string): void {
    const raw = localStorage.getItem(STORAGE_KEYS.COMMENTS);
    const allComments: CommentThread[] = raw ? JSON.parse(raw) : INITIAL_COMMENTS;
    const thread = allComments.find((t) => t.id === threadId);
    if (!thread) return;

    const commentId = `c-${Date.now()}`;
    thread.comments.push({
      id: commentId,
      author: {
        id: this.currentUser.id,
        name: this.currentUser.name,
        avatar: this.currentUser.avatar,
      },
      content,
      createdAt: new Date().toISOString(),
    });

    localStorage.setItem(STORAGE_KEYS.COMMENTS, JSON.stringify(allComments));
  }

  public toggleThreadStatus(threadId: string): void {
    const raw = localStorage.getItem(STORAGE_KEYS.COMMENTS);
    const allComments: CommentThread[] = raw ? JSON.parse(raw) : INITIAL_COMMENTS;
    const thread = allComments.find((t) => t.id === threadId);
    if (!thread) return;
    thread.status = thread.status === 'open' ? 'resolved' : 'open';
    localStorage.setItem(STORAGE_KEYS.COMMENTS, JSON.stringify(allComments));
  }

  // --- Notifications & @Mentions ---
  public getNotifications(userId?: string): MentionNotification[] {
    const raw = localStorage.getItem(STORAGE_KEYS.NOTIFICATIONS);
    const list: MentionNotification[] = raw ? JSON.parse(raw) : INITIAL_NOTIFICATIONS;
    if (userId) {
      return list.filter((n) => n.recipientId === userId);
    }
    return list;
  }

  public markNotificationAsRead(id: string): void {
    const list = this.getNotifications();
    const item = list.find((n) => n.id === id);
    if (item) {
      item.isRead = true;
      localStorage.setItem(STORAGE_KEYS.NOTIFICATIONS, JSON.stringify(list));
    }
  }

  public markAllNotificationsAsRead(userId: string): void {
    const list = this.getNotifications();
    list.forEach((n) => {
      if (n.recipientId === userId) n.isRead = true;
    });
    localStorage.setItem(STORAGE_KEYS.NOTIFICATIONS, JSON.stringify(list));
  }

  public getUnreadNotificationCount(userId: string): number {
    return this.getNotifications(userId).filter((n) => !n.isRead).length;
  }

  // --- Workspaces & Knowledge ---
  public getWorkspaces(): Workspace[] {
    const raw = localStorage.getItem(STORAGE_KEYS.WORKSPACES);
    return raw ? JSON.parse(raw) : INITIAL_WORKSPACES;
  }

  public getKnowledgeSources(spaceId?: string): KnowledgeSource[] {
    const raw = localStorage.getItem(STORAGE_KEYS.KNOWLEDGE);
    const list: KnowledgeSource[] = raw ? JSON.parse(raw) : INITIAL_KNOWLEDGE;
    if (spaceId) {
      return list.filter((k) => k.spaceId === spaceId);
    }
    return list;
  }

  // Helpers
  private getAllDocuments(): DocumentData[] {
    const raw = localStorage.getItem(STORAGE_KEYS.DOCUMENTS);
    return raw ? JSON.parse(raw) : INITIAL_DOCUMENTS;
  }

  private saveAllDocuments(docs: DocumentData[]): void {
    localStorage.setItem(STORAGE_KEYS.DOCUMENTS, JSON.stringify(docs));
  }
}

export const storageService = new StorageService();
