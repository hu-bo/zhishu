export interface Collaborator {
  id: string;
  name: string;
  color: string;
  role: string;
  avatarText?: string;
}

export type StatusType = 'IN_PROGRESS' | 'COMPLETED' | 'IN_REVIEW' | 'BLOCKED' | 'TO_DO';

export interface StatusConfig {
  label: string;
  bg: string;
  border: string;
  text: string;
  dot: string;
  pulseColor: string;
}

export const STATUS_CONFIGS: Record<StatusType, StatusConfig> = {
  IN_PROGRESS: {
    label: 'In Progress',
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/30',
    text: 'text-amber-700 dark:text-amber-300',
    dot: 'bg-amber-500',
    pulseColor: 'rgba(245, 158, 11, 0.4)',
  },
  COMPLETED: {
    label: 'Completed',
    bg: 'bg-emerald-500/10',
    border: 'border-emerald-500/30',
    text: 'text-emerald-700 dark:text-emerald-300',
    dot: 'bg-emerald-500',
    pulseColor: 'rgba(16, 185, 129, 0.4)',
  },
  IN_REVIEW: {
    label: 'In Review',
    bg: 'bg-blue-500/10',
    border: 'border-blue-500/30',
    text: 'text-blue-700 dark:text-blue-300',
    dot: 'bg-blue-500',
    pulseColor: 'rgba(59, 130, 246, 0.4)',
  },
  BLOCKED: {
    label: 'Blocked',
    bg: 'bg-rose-500/10',
    border: 'border-rose-500/30',
    text: 'text-rose-700 dark:text-rose-300',
    dot: 'bg-rose-500',
    pulseColor: 'rgba(244, 63, 94, 0.4)',
  },
  TO_DO: {
    label: 'To Do',
    bg: 'bg-slate-500/10',
    border: 'border-slate-500/30',
    text: 'text-slate-700 dark:text-slate-300',
    dot: 'bg-slate-400',
    pulseColor: 'rgba(148, 163, 184, 0.4)',
  },
};

export type CalloutTheme = 'info' | 'tip' | 'warning' | 'success' | 'danger';

export interface CalloutConfig {
  title: string;
  bg: string;
  border: string;
  iconBg: string;
  iconColor: string;
  accent: string;
}

export const CALLOUT_CONFIGS: Record<CalloutTheme, CalloutConfig> = {
  info: {
    title: 'Information',
    bg: 'bg-sky-50/70 dark:bg-sky-950/20',
    border: 'border-sky-300 dark:border-sky-800',
    iconBg: 'bg-sky-100 text-sky-700 dark:bg-sky-900/60 dark:text-sky-300',
    iconColor: 'text-sky-600 dark:text-sky-400',
    accent: '#0284c7',
  },
  tip: {
    title: 'Pro Tip',
    bg: 'bg-violet-50/70 dark:bg-violet-950/20',
    border: 'border-violet-300 dark:border-violet-800',
    iconBg: 'bg-violet-100 text-violet-700 dark:bg-violet-900/60 dark:text-violet-300',
    iconColor: 'text-violet-600 dark:text-violet-400',
    accent: '#7c3aed',
  },
  warning: {
    title: 'Attention Required',
    bg: 'bg-amber-50/70 dark:bg-amber-950/20',
    border: 'border-amber-300 dark:border-amber-800',
    iconBg: 'bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-300',
    iconColor: 'text-amber-600 dark:text-amber-400',
    accent: '#d97706',
  },
  success: {
    title: 'Resolution / Verified',
    bg: 'bg-emerald-50/70 dark:bg-emerald-950/20',
    border: 'border-emerald-300 dark:border-emerald-800',
    iconBg: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-300',
    iconColor: 'text-emerald-600 dark:text-emerald-400',
    accent: '#059669',
  },
  danger: {
    title: 'Critical Risk',
    bg: 'bg-rose-50/70 dark:bg-rose-950/20',
    border: 'border-rose-300 dark:border-rose-800',
    iconBg: 'bg-rose-100 text-rose-700 dark:bg-rose-900/60 dark:text-rose-300',
    iconColor: 'text-rose-600 dark:text-rose-400',
    accent: '#e11d48',
  },
};

export const PRESET_COLLABORATORS: Collaborator[] = [
  { id: 'usr-alex', name: 'Alex Chen', color: '#3b82f6', role: 'Staff Architect', avatarText: 'AC' },
  { id: 'usr-sarah', name: 'Sarah Miller', color: '#10b981', role: 'Principal Engineer', avatarText: 'SM' },
  { id: 'usr-elena', name: 'Elena Rostova', color: '#8b5cf6', role: 'Product Lead', avatarText: 'ER' },
  { id: 'usr-devon', name: 'Devon Vance', color: '#f59e0b', role: 'Infrastructure SRE', avatarText: 'DV' },
  { id: 'usr-maya', name: 'Maya Patel', color: '#ec4899', role: 'Security Engineer', avatarText: 'MP' },
];

export const PRESET_ROOMS = [
  {
    id: 'engineering-rfc',
    title: 'Engineering RFC: Event Mesh v2.4',
    category: 'Architecture',
    description: 'High-throughput distributed event broker specification and multi-region failover.',
    badge: 'Active RFC',
  },
  {
    id: 'product-roadmap',
    title: 'Product Roadmap: Horizon 2027',
    category: 'Product Strategy',
    description: 'Strategic themes, quarterly deliverables, and client feedback integration.',
    badge: 'Q4 Planning',
  },
  {
    id: 'sprint-retro',
    title: 'Sprint 42 Retrospective',
    category: 'Agile Team',
    description: 'What went well, what could be improved, and prioritized team commitments.',
    badge: 'Bi-Weekly',
  },
];
