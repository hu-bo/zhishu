import { Extension } from '@tiptap/core';
import { defaultSelectionBuilder, yCursorPlugin } from '@tiptap/y-tiptap';

export interface CollaborationCursorOptions {
  provider: any;
  user: {
    name: string | null;
    color: string | null;
    [key: string]: any;
  };
  render?: (user: Record<string, any>, clientId: number) => HTMLElement;
  selectionRender?: (user: Record<string, any>, clientId: number) => any;
  onUpdate?: () => void;
}

const awarenessStatesToArray = (states: Map<number, any>) => {
  return Array.from(states.entries()).map(([key, value]) => {
    return {
      clientId: key,
      ...value.user,
    };
  });
};

export const CollaborationCursor = Extension.create<CollaborationCursorOptions>({
  name: 'collaborationCursor',
  priority: 999,

  addOptions() {
    return {
      provider: null,
      user: {
        name: null,
        color: null,
      },
      render: (user: Record<string, any>) => {
        const cursor = document.createElement('span');
        cursor.classList.add('collaboration-cursor__caret');
        cursor.setAttribute('style', `border-color: ${user.color || '#3b82f6'}`);

        const label = document.createElement('div');
        label.classList.add('collaboration-cursor__label');
        label.setAttribute('style', `background-color: ${user.color || '#3b82f6'}`);
        label.insertBefore(document.createTextNode(user.name || 'Anonymous'), null);

        cursor.insertBefore(label, null);
        return cursor;
      },
      selectionRender: defaultSelectionBuilder,
      onUpdate: () => null,
    };
  },

  onCreate() {
    if (!this.options.provider) {
      throw new Error('The "provider" option is required for the CollaborationCursor extension');
    }
  },

  addStorage() {
    return {
      users: [] as any[],
    };
  },



  addProseMirrorPlugins() {
    if (!this.options.provider || !this.options.provider.awareness) {
      return [];
    }

    const awareness = this.options.provider.awareness;
    awareness.setLocalStateField('user', this.options.user);
    this.storage.users = awarenessStatesToArray(awareness.states);
    awareness.on('update', () => {
      this.storage.users = awarenessStatesToArray(awareness.states);
    });

    return [
      yCursorPlugin(
        awareness,
        {
          cursorBuilder: this.options.render,
          selectionBuilder: this.options.selectionRender,
        }
      ),
    ];
  },
});

export default CollaborationCursor;
