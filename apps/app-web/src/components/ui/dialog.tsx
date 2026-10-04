import { createContext, useContext, type ReactNode, type RefObject } from 'react';
import {
  Description,
  Modal,
  ModalBody,
  ModalCloseTrigger,
  ModalFooter,
  ModalHeader,
  ModalHeading,
} from '@heroui/react';
import { cn } from '@/lib/cn';

/**
 * HeroUI v3 Modal compound wrapped to keep the Base UI–style
 * call surface (`Dialog` + `DialogHeader` / `DialogTitle` /
 * `DialogDescription` / `DialogContent` / `DialogFooter` / `DialogClose`).
 *
 * The wrapper normalizes `open` / `onOpenChange` (Base UI) to
 * `isOpen` / `onOpenChange` (HeroUI), keeps `data-slot="dialog-*"`
 * selectors intact, and renders the close button conditionally via
 * `showCloseButton` so existing feature code keeps compiling.
 *
 * `initialFocus` / `finalFocus` (Base UI Dialog convention) are forwarded
 * to HeroUI's `Modal.Container` (the React Aria `Modal` primitive) via a
 * small context. HeroUI's `Modal` root does not expose those props
 * directly, so they have to flow through the structure that renders the
 * container.
 *
 * The HeroUI default sizing (`sm`, `md`, `lg`) is a bit too narrow for
 * 知书's editor dialogs, so the wrapper forces a wider `max-w-xl`
 * baseline; callers can still override via `DialogContent`'s className.
 */

interface DialogContextValue {
  initialFocus?: RefObject<HTMLElement | null>;
  finalFocus?: RefObject<HTMLElement | null>;
}

const DialogContext = createContext<DialogContextValue>({});

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children?: ReactNode;
  /** Base UI Dialog equivalent: forwarded to React Aria's Modal. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Base UI Dialog equivalent: forwarded to React Aria's Modal. */
  finalFocus?: RefObject<HTMLElement | null>;
}

function Dialog({ open, onOpenChange, children, initialFocus, finalFocus }: DialogProps) {
  return (
    <DialogContext.Provider value={{ initialFocus, finalFocus }}>
      <Modal isOpen={open} onOpenChange={onOpenChange}>
        {children}
      </Modal>
    </DialogContext.Provider>
  );
}

function DialogTrigger({ children }: { children: ReactNode }) {
  return <Modal.Trigger>{children}</Modal.Trigger>;
}

function DialogPortal({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function DialogClose({
  children,
  className,
  ...props
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <ModalCloseTrigger className={cn(className)} {...(props as object)}>
      {children}
    </ModalCloseTrigger>
  );
}

function DialogOverlay({ className }: { className?: string }) {
  return <Modal.Backdrop variant="opaque" className={cn('bg-overlay/50', className)} />;
}

export interface DialogContentProps {
  className?: string;
  children?: ReactNode;
  /** When true (default) renders the HeroUI-provided close trigger inside. */
  showCloseButton?: boolean;
}

function DialogContent({ className, children, showCloseButton = true }: DialogContentProps) {
  const { initialFocus, finalFocus } = useContext(DialogContext);
  return (
    <Modal.Backdrop variant="opaque" className="bg-overlay/50">
      <Modal.Container
        size="md"
        placement="auto"
        className="sm:max-w-xl"
        // HeroUI's ModalContainer types omit React Aria's `initialFocus` /
        // `finalFocus` even though the container's underlying RAC Modal
        // accepts them at runtime. Pass them as part of `className`-style
        // props via a loose object cast so the type checker is happy.
        {...({ initialFocus, finalFocus } as object)}
      >
        <Modal.Dialog className={cn('gap-4 p-4 sm:max-w-xl', className)}>
          {children}
          {showCloseButton && <ModalCloseTrigger aria-label="关闭" />}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

// Re-export the Modal Body for backwards compatibility.
const DialogBody = ModalBody;

function DialogHeader({
  className,
  children,
  ...props
}: {
  className?: string;
  children?: ReactNode;
}) {
  return (
    <ModalHeader {...(props as object)} className={cn('flex flex-col gap-2', className)}>
      {children}
    </ModalHeader>
  );
}

function DialogFooter({
  className,
  children,
  ...props
}: {
  className?: string;
  children?: ReactNode;
  showCloseButton?: boolean;
}) {
  return (
    <ModalFooter
      {...(props as object)}
      className={cn(
        '-mx-4 -mb-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end',
        className,
      )}
    >
      {children}
    </ModalFooter>
  );
}

function DialogTitle({
  className,
  children,
  ...props
}: {
  className?: string;
  children?: ReactNode;
}) {
  return (
    <ModalHeading
      {...(props as object)}
      className={cn('text-base leading-none font-medium', className)}
    >
      {children}
    </ModalHeading>
  );
}

function DialogDescription({
  className,
  children,
  ...props
}: {
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Description {...(props as object)} className={cn('text-sm text-muted-foreground', className)}>
      {children}
    </Description>
  );
}

export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
  DialogBody,
};
