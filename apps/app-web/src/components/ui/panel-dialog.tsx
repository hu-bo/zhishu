import type { ReactNode } from 'react';
import { Modal, ModalBody } from '@heroui/react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/cn';

/**
 * Mobile-first bottom-sheet dialog used by 知书 for panels such as Share,
 * Import/Export, Metadata and Document Info. The legacy Base UI version
 * resized itself via breakpoint-specific classes; we keep the same
 * responsive classes on top of HeroUI's Modal.
 */
export function PanelDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Modal.Backdrop variant="opaque" className="bg-overlay/50">
        <Modal.Container
          placement="bottom"
          size="lg"
          className={cn(
            'sm:max-w-4xl',
            // On mobile, bottom-sheet: stretch full width.
            'max-sm:!items-end max-sm:!justify-end',
          )}
        >
          <Modal.Dialog
            className={cn(
              'gap-4 p-4 sm:max-w-4xl',
              'max-sm:!rounded-b-none max-sm:!rounded-t-2xl max-sm:!translate-y-0',
              'max-sm:!top-auto max-sm:!bottom-0 max-sm:!left-0 max-sm:!max-h-[85dvh] max-sm:!w-full',
              'max-sm:!overflow-y-auto max-sm:!border max-sm:!border-b-0',
              'max-sm:!pb-[max(1rem,env(safe-area-inset-bottom))]',
            )}
          >
            <DialogHeader>
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-2">
                  <DialogTitle>{title}</DialogTitle>
                  <DialogDescription>{description}</DialogDescription>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`关闭${title}`}
                  title={`关闭${title}`}
                  onClick={() => onOpenChange(false)}
                >
                  <X aria-hidden="true" />
                </Button>
              </div>
            </DialogHeader>
            <ModalBody className="space-y-6">{children}</ModalBody>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Dialog>
  );
}
