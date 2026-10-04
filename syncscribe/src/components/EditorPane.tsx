import React, { useEffect, useState, useMemo, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import { CollaborationCursor } from '../extensions/CollaborationCursor';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Highlight from '@tiptap/extension-highlight';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import TextAlign from '@tiptap/extension-text-align';
import Placeholder from '@tiptap/extension-placeholder';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

import { Callout } from '../extensions/Callout';
import { StatusBadge } from '../extensions/StatusBadge';
import { CustomCodeBlock } from '../extensions/CustomCodeBlock';
import { CollaboratorMention } from '../extensions/CollaboratorMention';
import { DividerWithLabel } from '../extensions/DividerWithLabel';
import { TopToolbar } from './TopToolbar';
import { BubbleMenuFloating } from './BubbleMenuFloating';
import { SlashCommandPalette } from './SlashCommandPalette';
import { Collaborator } from '../types/collab';
import { PRESET_DOCUMENTS } from '../templates/presetTemplates';
import { calculateStats, DocumentStats } from '../utils/exportUtils';
import { PresenceUser } from './PresenceHeader';
import { OutlineItem } from '../types/knowledge';

interface EditorPaneProps {
  roomName: string;
  user: Collaborator;
  paneLabel?: string;
  paneColor?: string;
  isSecondary?: boolean;
  isReadOnly?: boolean;
  viewMode?: 'edit' | 'read' | 'split';
  onStatsChange?: (stats: DocumentStats) => void;
  onOutlineChange?: (outline: OutlineItem[]) => void;
  onPeersChange?: (peers: PresenceUser[]) => void;
  onSyncStatusChange?: (status: 'connected' | 'connecting' | 'disconnected') => void;
  onEditorReady?: (editor: any) => void;
}

export const EditorPane: React.FC<EditorPaneProps> = ({
  roomName,
  user,
  paneLabel,
  paneColor,
  isSecondary = false,
  isReadOnly = false,
  viewMode = 'edit',
  onStatsChange,
  onOutlineChange,
  onPeersChange,
  onSyncStatusChange,
  onEditorReady,
}) => {
  const [slashPaletteOpen, setSlashPaletteOpen] = useState(false);
  const [paletteCoords, setPaletteCoords] = useState<{ top: number; left: number } | null>(null);
  const [syncStatus, setSyncStatus] = useState<'connected' | 'connecting' | 'disconnected'>('connecting');

  // Create isolated Y.Doc and WebSocket provider per editor pane and room
  const { ydoc, provider } = useMemo(() => {
    const doc = new Y.Doc();
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/ws`;
    const wsProvider = new WebsocketProvider(wsUrl, roomName, doc, {
      connect: true,
    });
    return { ydoc: doc, provider: wsProvider };
  }, [roomName]);

  // Set user awareness state
  useEffect(() => {
    if (!provider || !provider.awareness) return;

    provider.awareness.setLocalStateField('user', {
      id: user.id,
      name: user.name,
      color: user.color,
      role: user.role,
    });

    const handleStatus = (event: { status: 'connected' | 'connecting' | 'disconnected' }) => {
      setSyncStatus(event.status);
      onSyncStatusChange?.(event.status);
    };

    const handleAwarenessChange = () => {
      if (!onPeersChange) return;
      const states = provider.awareness.getStates();
      const currentClientId = provider.awareness.clientID;
      const peerList: PresenceUser[] = [];

      states.forEach((state, clientId) => {
        if (clientId !== currentClientId && state.user) {
          peerList.push({
            id: state.user.id || `peer-${clientId}`,
            name: state.user.name || 'Anonymous Peer',
            color: state.user.color || '#6366f1',
            role: state.user.role,
            clientId,
          });
        }
      });
      onPeersChange(peerList);
    };

    provider.on('status', handleStatus);
    provider.awareness.on('change', handleAwarenessChange);

    return () => {
      provider.off('status', handleStatus);
      provider.awareness.off('change', handleAwarenessChange);
    };
  }, [provider, user, onSyncStatusChange, onPeersChange]);

  // Cleanup provider on unmount
  useEffect(() => {
    return () => {
      provider.destroy();
      ydoc.destroy();
    };
  }, [provider, ydoc]);

  const extractOutline = (ed: any) => {
    if (!onOutlineChange) return;
    const items: OutlineItem[] = [];
    ed.state.doc.descendants((node: any) => {
      if (node.type.name === 'heading') {
        items.push({
          id: node.textContent.toLowerCase().replace(/[^\w\s-]/g, '').replace(/[\s_-]+/g, '-'),
          level: node.attrs.level,
          text: node.textContent,
        });
      }
    });
    onOutlineChange(items);
  };

  const editor = useEditor({
    immediatelyRender: false,
    editable: !isReadOnly,
    extensions: [
      StarterKit.configure({
        undoRedo: false, // Handled by Yjs Collaboration
        codeBlock: false, // Handled by CustomCodeBlock
      }),
      Collaboration.configure({
        document: ydoc,
        field: 'default',
      }),
      CollaborationCursor.configure({
        provider: provider,
        user: {
          name: user.name,
          color: user.color,
        },
      }),
      TaskList,
      TaskItem.configure({
        nested: true,
      }),
      Highlight.configure({
        multicolor: true,
      }),
      Underline,
      Link.configure({
        openOnClick: false,
        HTMLAttributes: {
          class: 'text-indigo-600 dark:text-indigo-400 underline underline-offset-2 cursor-pointer',
        },
      }),
      TextAlign.configure({
        types: ['heading', 'paragraph'],
      }),
      Placeholder.configure({
        placeholder: 'Write your knowledge article, or type / for commands...',
      }),
      Callout,
      StatusBadge,
      CustomCodeBlock,
      CollaboratorMention,
      DividerWithLabel,
    ],
    editorProps: {
      attributes: {
        class:
          'tiptap prose prose-slate dark:prose-invert max-w-none focus:outline-none min-h-[500px] px-6 py-6 font-sans text-slate-800 dark:text-slate-200 text-sm md:text-base leading-relaxed',
      },
      handleKeyDown: (view, event) => {
        if (!isReadOnly && event.key === '/' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
          const { selection } = view.state;
          const coords = view.coordsAtPos(selection.from);
          setPaletteCoords({ top: coords.bottom + 8, left: coords.left });
          setSlashPaletteOpen(true);
        }
        return false;
      },
    },
    onUpdate: ({ editor: ed }) => {
      if (onStatsChange) {
        const text = ed.getText();
        onStatsChange(calculateStats(text));
      }
      extractOutline(ed);
    },
  });

  // Toggle editable when isReadOnly changes
  useEffect(() => {
    if (editor) {
      editor.setEditable(!isReadOnly);
    }
  }, [editor, isReadOnly]);

  // Notify parent of editor instance
  useEffect(() => {
    if (editor && onEditorReady) {
      onEditorReady(editor);
    }
  }, [editor, onEditorReady]);

  // Pre-seed template document if empty once synced
  useEffect(() => {
    if (!editor || !provider) return;

    let hasSeeded = false;

    const checkAndSeed = () => {
      if (hasSeeded) return;
      const fragment = ydoc.getXmlFragment('default');
      // If the document is blank and we have a template for this room
      if (fragment.length === 0) {
        const template = PRESET_DOCUMENTS[roomName];
        if (template) {
          hasSeeded = true;
          editor.commands.setContent(template);
          if (onStatsChange) {
            onStatsChange(calculateStats(editor.getText()));
          }
          extractOutline(editor);
        }
      } else {
        hasSeeded = true;
        if (onStatsChange) {
          onStatsChange(calculateStats(editor.getText()));
        }
        extractOutline(editor);
      }
    };

    if (provider.synced) {
      checkAndSeed();
    } else {
      provider.once('sync', checkAndSeed);
    }
  }, [editor, provider, roomName, ydoc, onStatsChange]);

  const showToolbar = !isReadOnly && viewMode !== 'read';

  return (
    <div className="flex flex-col h-full bg-white dark:bg-slate-900 rounded-2xl shadow-xs border border-slate-200 dark:border-slate-800 overflow-hidden relative">
      {/* Pane Header Badge if split view */}
      {paneLabel && (
        <div className="flex items-center justify-between px-4 py-2 border-b border-slate-100 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-850 select-none">
          <div className="flex items-center gap-2">
            <span
              className="w-2.5 h-2.5 rounded-full"
              style={{ backgroundColor: paneColor || user.color }}
            />
            <span className="text-xs font-bold text-slate-800 dark:text-slate-100">
              {paneLabel}
            </span>
            <span className="text-[11px] text-slate-400">
              ({user.name} · {user.role})
            </span>
          </div>

          <div className="flex items-center gap-2">
            {isSecondary && (
              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-purple-100 dark:bg-purple-950 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800">
                Live Test Peer
              </span>
            )}
            <div className="flex items-center gap-1 text-[11px] text-slate-400">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  syncStatus === 'connected' ? 'bg-emerald-500' : 'bg-amber-500'
                }`}
              />
              <span className="capitalize">{syncStatus}</span>
            </div>
          </div>
        </div>
      )}

      {/* Top Toolbar (only shown in edit mode) */}
      {showToolbar && (
        <TopToolbar
          editor={editor}
          onOpenSlashPalette={() => {
            setPaletteCoords(null);
            setSlashPaletteOpen(true);
          }}
        />
      )}

      {/* Floating Selection Bubble Menu */}
      {showToolbar && <BubbleMenuFloating editor={editor} />}

      {/* Slash Command Palette */}
      {showToolbar && (
        <SlashCommandPalette
          editor={editor}
          isOpen={slashPaletteOpen}
          onClose={() => setSlashPaletteOpen(false)}
          position={paletteCoords}
        />
      )}

      {/* Editor Content Area */}
      <div className="flex-1 overflow-y-auto cursor-text bg-slate-50/20 dark:bg-slate-900/40">
        <div className="max-w-4xl mx-auto py-4">
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  );
};
