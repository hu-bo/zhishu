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
  open?: boolean;
  isOpen?: boolean;
  onOpenChange: (open: boolean) => void;
  children?: ReactNode;
  /** Base UI Dialog equivalent: forwarded to React Aria's Modal. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Base UI Dialog equivalent: forwarded to React Aria's Modal. */
  finalFocus?: RefObject<HTMLElement | null>;
}

function Dialog({ open, isOpen, onOpenChange, children, initialFocus, finalFocus }: DialogProps) {
  return (
    <DialogContext.Provider value={{ initialFocus, finalFocus }}>
      <Modal isOpen={isOpen ?? open ?? false} onOpenChange={onOpenChange}>
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
  return (
    <Modal.Backdrop variant="blur" className={cn('bg-backdrop backdrop-blur-sm', className)} />
  );
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
    <Modal.Backdrop variant="blur" className="bg-backdrop backdrop-blur-sm">
      <Modal.Container
        size="md"
        placement="auto"
        className="w-full sm:w-full sm:max-w-none sm:p-6"
        // HeroUI's ModalContainer types omit React Aria's `initialFocus` /
        // `finalFocus` even though the container's underlying RAC Modal
        // accepts them at runtime. Pass them as part of `className`-style
        // props via a loose object cast so the type checker is happy.
        {...({ initialFocus, finalFocus } as object)}
      >
        <Modal.Dialog className={cn('zhishu-dialog max-w-xl gap-5 p-5 sm:p-6', className)}>
          {children}
          {showCloseButton && (
            <ModalCloseTrigger
              aria-label="关闭"
              className="bg-transparent text-muted-foreground hover:bg-secondary hover:text-foreground"
            />
          )}
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
    <ModalHeader
      {...(props as object)}
      data-slot="dialog-header"
      className={cn('flex flex-col gap-2 pr-7', className)}
    >
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
      data-slot="dialog-footer"
      className={cn(
        'm-0 flex flex-col-reverse gap-2 border-t border-border/70 bg-transparent px-0 pb-0 pt-5 sm:flex-row sm:justify-end',
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
      className={cn('text-lg leading-7 font-semibold tracking-tight', className)}
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
    <Description
      {...(props as object)}
      className={cn('text-[13px] leading-6 text-muted-foreground', className)}
    >
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
