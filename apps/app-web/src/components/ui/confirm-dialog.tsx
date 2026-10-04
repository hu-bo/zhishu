import { useState, type ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import { Modal, ModalBody, ModalFooter, ModalHeader, ModalHeading } from '@heroui/react';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/api/api-error';

/**
 * Self-contained confirm modal built on HeroUI's `Modal` compound. The wrapper
 * preserves the Base UI–style `ConfirmDialog` contract:
 *
 * - `destructive` switches the confirm button to the danger variant.
 * - `onConfirm` may resolve to `false` to block the dialog from closing
 *   (used by destructive flows that need to surface a server error inline).
 * - `error` is shown as a static alert line above the action row.
 * - `children` render between the description and the footer (e.g. an
 *   impact summary) so callers don't have to wrap the dialog themselves.
 */
export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  error?: string | null;
  children?: ReactNode;
  onConfirm: () => boolean | void | Promise<boolean | void>;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive = false,
  error,
  children,
  onConfirm,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const [unexpectedError, setUnexpectedError] = useState<string | null>(null);

  const confirm = async () => {
    if (pending) return;
    setPending(true);
    setUnexpectedError(null);
    try {
      const shouldClose = await onConfirm();
      if (shouldClose !== false) onOpenChange(false);
    } catch (cause) {
      setUnexpectedError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  const alertMessage = error ?? unexpectedError;

  return (
    <Modal
      isOpen={open}
      onOpenChange={(next) => {
        // Don't allow closing while a confirm handler is running.
        if (!pending || next) onOpenChange(next);
      }}
    >
      <Modal.Backdrop variant="opaque" className="bg-overlay/50">
        <Modal.Container placement="auto" size="md">
          <Modal.Dialog className="sm:max-w-md">
            <ModalHeader>
              <ModalHeading className="text-base leading-none font-medium">{title}</ModalHeading>
              <p className="mt-2 text-sm text-muted-foreground">{description}</p>
            </ModalHeader>
            <ModalBody className="space-y-3">
              {children}
              {alertMessage && (
                <p role="alert" className="text-sm text-danger">
                  {alertMessage}
                </p>
              )}
            </ModalBody>
            <ModalFooter className="flex-row justify-end gap-2">
              <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button
                variant={destructive ? 'destructive' : 'default'}
                disabled={pending}
                onClick={() => void confirm()}
              >
                {pending && <LoaderCircle className="animate-spin" aria-hidden="true" />}
                {pending ? '处理中…' : confirmLabel}
              </Button>
            </ModalFooter>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
