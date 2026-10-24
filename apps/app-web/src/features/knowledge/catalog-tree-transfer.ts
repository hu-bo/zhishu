import { createContext, useContext, useState, type DragEvent } from 'react';

export type CatalogDragItem =
  { kind: 'catalog'; id: string } | { kind: 'document'; id: string; metadataRevision: number };
export type CatalogDropTarget = {
  catalogId: string;
  beforeDocumentId?: string;
  parentCatalogId?: string;
  beforeCatalogId?: string;
};
export const CatalogTreeTransferContext = createContext<{
  busy: boolean;
  dragged: CatalogDragItem | null;
  start: (item: CatalogDragItem | null) => void;
  drop: (target: CatalogDropTarget) => void;
} | null>(null);

export function useCatalogDropTarget(target: CatalogDropTarget, item?: CatalogDragItem) {
  const transfer = useContext(CatalogTreeTransferContext);
  const [hover, setHover] = useState(false);
  const allowed = !!transfer?.dragged && !transfer.busy && transfer.dragged.id !== item?.id;
  return {
    hover,
    props: {
      draggable: !!item && !transfer?.busy,
      onDragStart: (event: DragEvent<HTMLElement>) => {
        if (!item || !transfer || transfer.busy) {
          event.preventDefault();
          return;
        }
        event.stopPropagation();
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('application/x-zhishu-directory', JSON.stringify(item));
        transfer.start(item);
      },
      onDragEnd: () => {
        transfer?.start(null);
        setHover(false);
      },
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!allowed) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        setHover(true);
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          setHover(false);
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        if (!allowed) return;
        event.preventDefault();
        event.stopPropagation();
        setHover(false);
        const rect = event.currentTarget.getBoundingClientRect();
        const beforeCatalog =
          transfer?.dragged?.kind === 'catalog' &&
          target.beforeCatalogId &&
          target.parentCatalogId &&
          event.clientY < rect.top + rect.height / 3;
        transfer?.drop(
          beforeCatalog
            ? { catalogId: target.parentCatalogId!, beforeCatalogId: target.beforeCatalogId }
            : { catalogId: target.catalogId, beforeDocumentId: target.beforeDocumentId },
        );
      },
    },
  };
}
