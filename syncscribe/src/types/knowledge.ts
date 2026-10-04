import { StatusType } from './collab';

export interface Workspace {
  id: string;
  name: string;
  icon: string;
  description: string;
  badge: string;
  color: string;
}

export interface WikiDocument {
  id: string;
  workspaceId: string;
  title: string;
  icon: string;
  category: string;
  parentId?: string | null;
  tags: string[];
  status: StatusType;
  updatedAt: string;
  author: string;
  isStarred?: boolean;
  description?: string;
  initialContent?: string;
}

export interface OutlineItem {
  id: string;
  level: number;
  text: string;
}

export const WORKSPACES: Workspace[] = [
  {
    id: 'ws-engineering',
    name: 'Engineering Hub',
    icon: '🏢',
    description: 'Technical architecture, specifications, RFCs, and infrastructure runbooks.',
    badge: 'Tech Org',
    color: '#3b82f6',
  },
  {
    id: 'ws-product',
    name: 'Product Wiki',
    icon: '🚀',
    description: 'Product requirements, quarterly roadmaps, design tokens, and user research.',
    badge: 'Strategy',
    color: '#8b5cf6',
  },
  {
    id: 'ws-team',
    name: 'Team Handbook',
    icon: '🏛️',
    description: 'Agile sprints, team retrospectives, onboarding guidelines, and culture.',
    badge: 'Operations',
    color: '#10b981',
  },
  {
    id: 'ws-notes',
    name: 'Personal Vault',
    icon: '📚',
    description: 'Daily scratchpads, research notes, meeting logs, and quick reminders.',
    badge: 'Private',
    color: '#f59e0b',
  },
];
