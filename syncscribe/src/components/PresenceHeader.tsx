import React, { useState } from 'react';
import {
  Users,
  Share2,
  Download,
  Split,
  Settings,
  Sparkles,
  Check,
  ChevronDown,
  Layers,
  Printer,
  FileCode,
  FileText,
  FileJson,
  PlusCircle,
  ExternalLink,
} from 'lucide-react';
import { Collaborator, PRESET_ROOMS } from '../types/collab';

export interface PresenceUser {
  id: string;
  name: string;
  color: string;
  role?: string;
  clientId: number;
}

interface PresenceHeaderProps {
  currentRoom: string;
  onSelectRoom: (roomId: string) => void;
  currentUser: Collaborator;
  onUpdateUser: (user: Collaborator) => void;
  peers: PresenceUser[];
  isSplitView: boolean;
  onToggleSplitView: () => void;
  onExportMarkdown: () => void;
  onExportHTML: () => void;
  onExportJSON: () => void;
  onPrint: () => void;
  syncStatus: 'connected' | 'connecting' | 'disconnected';
}

export const PresenceHeader: React.FC<PresenceHeaderProps> = ({
  currentRoom,
  onSelectRoom,
  currentUser,
  onUpdateUser,
  peers,
  isSplitView,
  onToggleSplitView,
  onExportMarkdown,
  onExportHTML,
  onExportJSON,
  onPrint,
  syncStatus,
}) => {
  const [roomDropdownOpen, setRoomDropdownOpen] = useState(false);
  const [customRoomInput, setCustomRoomInput] = useState('');
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [exportDropdownOpen, setExportDropdownOpen] = useState(false);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [copiedShare, setCopiedShare] = useState(false);

  const currentPreset = PRESET_ROOMS.find((r) => r.id === currentRoom);

  const handleShareLink = () => {
    const url = new URL(window.location.href);
    url.searchParams.set('room', currentRoom);
    navigator.clipboard.writeText(url.toString()).then(() => {
      setCopiedShare(true);
      setTimeout(() => setCopiedShare(false), 2500);
    });
  };

  const handleJoinCustomRoom = () => {
    const trimmed = customRoomInput.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    if (trimmed) {
      onSelectRoom(trimmed);
      setCustomRoomInput('');
      setShowCustomInput(false);
      setRoomDropdownOpen(false);
    }
  };

  return (
    <header className="sticky top-0 z-30 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 px-4 py-2.5 transition-colors">
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
        {/* Left: Brand & Room Picker */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-linear-to-tr from-indigo-600 via-indigo-500 to-purple-500 flex items-center justify-center text-white shadow-md shadow-indigo-500/20">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="font-bold text-slate-900 dark:text-slate-100 text-sm tracking-tight">
                  SyncScribe
                </span>
                <span className="text-[10px] font-semibold uppercase px-1.5 py-0.2 rounded bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800">
                  CRDT Yjs
                </span>
              </div>
            </div>
          </div>

          <div className="h-5 w-px bg-slate-200 dark:bg-slate-700 hidden sm:block" />

          {/* Room Selector Dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setRoomDropdownOpen(!roomDropdownOpen)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200/80 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-800 dark:text-slate-200 transition-all cursor-pointer"
            >
              <Layers className="w-3.5 h-3.5 text-indigo-500" />
              <span className="max-w-[130px] sm:max-w-[200px] truncate">
                {currentPreset ? currentPreset.title : `Room: ${currentRoom}`}
              </span>
              <ChevronDown className="w-3.5 h-3.5 opacity-60 ml-0.5" />
            </button>

            {roomDropdownOpen && (
              <div
                className="absolute left-0 mt-2 w-72 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl p-2 z-50 animate-in fade-in zoom-in-95 duration-100"
                onMouseLeave={() => setRoomDropdownOpen(false)}
              >
                <div className="px-3 py-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                  Preset Collaborative Rooms
                </div>

                <div className="space-y-1 mb-2">
                  {PRESET_ROOMS.map((room) => {
                    const isSelected = room.id === currentRoom;
                    return (
                      <button
                        key={room.id}
                        type="button"
                        onClick={() => {
                          onSelectRoom(room.id);
                          setRoomDropdownOpen(false);
                        }}
                        className={`w-full text-left p-2 rounded-xl transition-all ${
                          isSelected
                            ? 'bg-indigo-50 dark:bg-indigo-950/50 border border-indigo-200 dark:border-indigo-800 text-indigo-900 dark:text-indigo-200'
                            : 'hover:bg-slate-50 dark:hover:bg-slate-800/60 text-slate-700 dark:text-slate-300'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold truncate">{room.title}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">
                            {room.badge}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-400 line-clamp-1 mt-0.5">
                          {room.description}
                        </p>
                      </button>
                    );
                  })}
                </div>

                {/* Custom room creator */}
                <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
                  {showCustomInput ? (
                    <div className="p-1 space-y-2">
                      <input
                        type="text"
                        placeholder="Enter room name..."
                        value={customRoomInput}
                        onChange={(e) => setCustomRoomInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleJoinCustomRoom();
                          if (e.key === 'Escape') setShowCustomInput(false);
                        }}
                        className="w-full text-xs px-2.5 py-1.5 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-100 outline-none"
                        autoFocus
                      />
                      <div className="flex justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => setShowCustomInput(false)}
                          className="px-2 py-1 text-xs text-slate-500 hover:text-slate-700"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={handleJoinCustomRoom}
                          className="px-2.5 py-1 text-xs font-semibold bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
                        >
                          Join Room
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setShowCustomInput(true)}
                      className="w-full flex items-center justify-center gap-1.5 py-1.5 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 rounded-xl transition-colors"
                    >
                      <PlusCircle className="w-3.5 h-3.5" />
                      <span>Create or Join Custom Room</span>
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Middle: Connected Teammates (Presence Awareness) */}
        <div className="flex items-center gap-2">
          {/* Real-time sync ping indicator */}
          <div className="hidden lg:flex items-center gap-1.5 px-2 py-1 rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs">
            <span className="relative flex h-2 w-2">
              <span
                className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                  syncStatus === 'connected'
                    ? 'bg-emerald-500'
                    : syncStatus === 'connecting'
                    ? 'bg-amber-500'
                    : 'bg-rose-500'
                }`}
              />
              <span
                className={`relative inline-flex rounded-full h-2 w-2 ${
                  syncStatus === 'connected'
                    ? 'bg-emerald-500'
                    : syncStatus === 'connecting'
                    ? 'bg-amber-500'
                    : 'bg-rose-500'
                }`}
              />
            </span>
            <span className="text-[11px] font-medium text-slate-600 dark:text-slate-300 capitalize">
              {syncStatus}
            </span>
          </div>

          {/* Active Collaborator Avatars */}
          <div className="flex items-center -space-x-2 overflow-hidden py-1 px-1">
            {/* You */}
            <div
              className="relative group cursor-pointer"
              onClick={() => setProfileModalOpen(true)}
              title={`You: ${currentUser.name} (${currentUser.role})`}
            >
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[10px] font-bold border-2 border-white dark:border-slate-900 shadow-sm transition-transform group-hover:scale-110"
                style={{ backgroundColor: currentUser.color }}
              >
                {currentUser.avatarText || currentUser.name.slice(0, 2).toUpperCase()}
              </div>
              <span className="absolute bottom-0 right-0 w-2 h-2 rounded-full bg-emerald-500 ring-1 ring-white dark:ring-slate-900" />
            </div>

            {/* Remote Peers */}
            {peers.map((peer) => (
              <div
                key={peer.clientId}
                className="relative group transition-transform hover:scale-110 hover:z-20 cursor-pointer"
                title={`${peer.name} ${peer.role ? `(${peer.role})` : ''} - Online`}
              >
                <div
                  className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[10px] font-bold border-2 border-white dark:border-slate-900 shadow-sm"
                  style={{ backgroundColor: peer.color }}
                >
                  {peer.name.slice(0, 2).toUpperCase()}
                </div>
                <span className="absolute bottom-0 right-0 w-2 h-2 rounded-full bg-emerald-500 ring-1 ring-white dark:ring-slate-900" />
              </div>
            ))}
          </div>

          <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 hidden sm:inline">
            {peers.length + 1} online
          </div>
        </div>

        {/* Right: Actions (Split Test Mode, Share, Export, Profile) */}
        <div className="flex items-center gap-1.5 sm:gap-2">
          {/* Split Screen Test Mode Toggle */}
          <button
            type="button"
            onClick={onToggleSplitView}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all shadow-2xs ${
              isSplitView
                ? 'bg-purple-600 text-white shadow-purple-500/20 ring-2 ring-purple-400'
                : 'bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700'
            }`}
            title="Toggle Split-Screen Peer Collaboration Testing Mode"
          >
            <Split className="w-3.5 h-3.5" />
            <span className="hidden md:inline">
              {isSplitView ? 'Exit Split View' : 'Split-Screen Test'}
            </span>
            <span className="md:hidden">Split</span>
            {isSplitView && (
              <span className="w-2 h-2 rounded-full bg-emerald-300 animate-pulse" />
            )}
          </button>

          {/* Share Link */}
          <button
            type="button"
            onClick={handleShareLink}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200/80 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold border border-slate-200 dark:border-slate-700 transition-colors"
            title="Copy sharable room link"
          >
            {copiedShare ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-500" />
                <span className="hidden sm:inline text-emerald-600 dark:text-emerald-400">Copied!</span>
              </>
            ) : (
              <>
                <Share2 className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Share</span>
              </>
            )}
          </button>

          {/* Export Dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setExportDropdownOpen(!exportDropdownOpen)}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200/80 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold border border-slate-200 dark:border-slate-700 transition-colors cursor-pointer"
              title="Export Document"
            >
              <Download className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Export</span>
              <ChevronDown className="w-3 h-3 opacity-60" />
            </button>

            {exportDropdownOpen && (
              <div
                className="absolute right-0 mt-2 w-48 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl p-1.5 z-50 animate-in fade-in zoom-in-95 duration-100"
                onMouseLeave={() => setExportDropdownOpen(false)}
              >
                <div className="px-3 py-1 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                  Export As
                </div>
                <button
                  type="button"
                  onClick={() => {
                    onExportMarkdown();
                    setExportDropdownOpen(false);
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-left text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl transition-colors"
                >
                  <FileText className="w-4 h-4 text-blue-500" />
                  <div>
                    <div className="font-semibold">Markdown (.md)</div>
                    <div className="text-[10px] text-slate-400">Standard GitHub flavor</div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onExportHTML();
                    setExportDropdownOpen(false);
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-left text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl transition-colors"
                >
                  <FileCode className="w-4 h-4 text-emerald-500" />
                  <div>
                    <div className="font-semibold">Clean HTML (.html)</div>
                    <div className="text-[10px] text-slate-400">Standalone web document</div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onExportJSON();
                    setExportDropdownOpen(false);
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-left text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl transition-colors"
                >
                  <FileJson className="w-4 h-4 text-amber-500" />
                  <div>
                    <div className="font-semibold">Tiptap JSON (.json)</div>
                    <div className="text-[10px] text-slate-400">Abstract syntax tree</div>
                  </div>
                </button>
                <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
                <button
                  type="button"
                  onClick={() => {
                    onPrint();
                    setExportDropdownOpen(false);
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-left text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl transition-colors"
                >
                  <Printer className="w-4 h-4 text-purple-500" />
                  <div>
                    <div className="font-semibold">Print / Save as PDF</div>
                    <div className="text-[10px] text-slate-400">Browser print layout</div>
                  </div>
                </button>
              </div>
            )}
          </div>

          {/* Profile Switcher Trigger */}
          <button
            type="button"
            onClick={() => setProfileModalOpen(true)}
            className="p-1.5 rounded-xl text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            title="Edit Collaborator Profile"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Profile Settings Modal */}
      {profileModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-2xs"
          onClick={() => setProfileModalOpen(false)}
        >
          <div
            className="w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 p-6 animate-in fade-in zoom-in-95 duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center gap-2">
                <Users className="w-5 h-5 text-indigo-600" />
                <h3 className="font-bold text-slate-900 dark:text-slate-100 text-base">
                  Collaborator Profile
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setProfileModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 text-sm font-semibold"
              >
                ✕
              </button>
            </div>

            <div className="py-4 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-wider mb-1.5">
                  Display Name
                </label>
                <input
                  type="text"
                  value={currentUser.name}
                  onChange={(e) =>
                    onUpdateUser({
                      ...currentUser,
                      name: e.target.value,
                      avatarText: e.target.value.slice(0, 2).toUpperCase(),
                    })
                  }
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-wider mb-1.5">
                  Role / Title
                </label>
                <input
                  type="text"
                  value={currentUser.role}
                  onChange={(e) => onUpdateUser({ ...currentUser, role: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-wider mb-2">
                  Cursor & Avatar Color
                </label>
                <div className="flex items-center gap-2">
                  {[
                    '#3b82f6', // blue
                    '#10b981', // emerald
                    '#8b5cf6', // purple
                    '#f59e0b', // amber
                    '#ec4899', // pink
                    '#06b6d4', // cyan
                    '#f97316', // orange
                    '#ef4444', // red
                  ].map((color) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => onUpdateUser({ ...currentUser, color })}
                      className={`w-7 h-7 rounded-full transition-transform cursor-pointer ${
                        currentUser.color === color
                          ? 'ring-4 ring-indigo-200 dark:ring-indigo-900 scale-110 shadow-sm'
                          : 'hover:scale-105'
                      }`}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
              </div>
            </div>

            <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex justify-end">
              <button
                type="button"
                onClick={() => setProfileModalOpen(false)}
                className="px-4 py-2 text-xs font-semibold bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
};
