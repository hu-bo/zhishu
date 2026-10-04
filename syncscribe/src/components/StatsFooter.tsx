import React from 'react';
import { Clock, Type, AlignJustify, ShieldCheck, Zap } from 'lucide-react';
import { DocumentStats } from '../utils/exportUtils';

interface StatsFooterProps {
  stats: DocumentStats;
  roomName: string;
  peerCount: number;
  syncStatus: 'connected' | 'connecting' | 'disconnected';
  onOpenSlashPalette: () => void;
}

export const StatsFooter: React.FC<StatsFooterProps> = ({
  stats,
  roomName,
  peerCount,
  syncStatus,
  onOpenSlashPalette,
}) => {
  return (
    <footer className="border-t border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-900/90 backdrop-blur-xs px-4 py-2 text-xs text-slate-500 dark:text-slate-400 select-none">
      <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3">
        {/* Left: Document Metrics */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5" title="Word Count">
            <Type className="w-3.5 h-3.5 text-slate-400" />
            <span className="font-semibold text-slate-700 dark:text-slate-300">
              {stats.words.toLocaleString()}
            </span>
            <span>words</span>
          </div>

          <div className="w-px h-3.5 bg-slate-200 dark:bg-slate-700" />

          <div className="flex items-center gap-1.5" title="Character Count">
            <AlignJustify className="w-3.5 h-3.5 text-slate-400" />
            <span className="font-semibold text-slate-700 dark:text-slate-300">
              {stats.characters.toLocaleString()}
            </span>
            <span>characters</span>
          </div>

          <div className="w-px h-3.5 bg-slate-200 dark:bg-slate-700" />

          <div className="flex items-center gap-1.5" title="Estimated Reading Time">
            <Clock className="w-3.5 h-3.5 text-slate-400" />
            <span className="font-semibold text-slate-700 dark:text-slate-300">
              {stats.readingTimeMinutes}
            </span>
            <span>min read</span>
          </div>
        </div>

        {/* Center: Slash command quick helper */}
        <div className="hidden md:flex items-center gap-2">
          <button
            type="button"
            onClick={onOpenSlashPalette}
            className="flex items-center gap-1 text-[11px] text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
          >
            <span>Type</span>
            <kbd className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 font-mono font-bold text-[10px]">
              /
            </kbd>
            <span>for custom callouts, badges, code & headings</span>
          </button>
        </div>

        {/* Right: Real-time synchronization state */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span
              className={`w-2 h-2 rounded-full ${
                syncStatus === 'connected'
                  ? 'bg-emerald-500'
                  : syncStatus === 'connecting'
                  ? 'bg-amber-500'
                  : 'bg-rose-500'
              }`}
            />
            <span className="font-medium text-[11px]">
              {syncStatus === 'connected' ? 'CRDT Synced' : syncStatus}
            </span>
          </div>

          <div className="w-px h-3.5 bg-slate-200 dark:bg-slate-700" />

          <div className="flex items-center gap-1 text-[11px] text-slate-400">
            <ShieldCheck className="w-3.5 h-3.5 text-indigo-500" />
            <span>Room: {roomName}</span>
          </div>
        </div>
      </div>
    </footer>
  );
};
