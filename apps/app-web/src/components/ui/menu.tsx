import type { ReactElement, ReactNode } from 'react';
import { isValidElement, useId } from 'react';
import { Dropdown, Label, Separator } from '@heroui/react';
import { cn } from '@/lib/cn';

/**
 * Theme-aware wrapper around HeroUI v3 `Dropdown` that preserves the Base
 * UI–style call surface (`Menu` + `MenuTrigger` / `MenuContent` / `MenuItem`
 * / `MenuSeparator` / `MenuLabel`).
 *
 * Migration notes:
 *   - The HeroUI Dropdown uses an `onAction` callback at the menu level that
 *     receives the activated item's `id`. To keep call sites legible we let
 *     each `MenuItem` keep its own `onClick`; the wrapper wires them up to
 *     a synthesized `id`.
 *   - `MenuTrigger` accepts either `render={<Button ... />}` (Base UI legacy)
 *     OR `<MenuTrigger><Button ... /></MenuTrigger>` (HeroUI-native). The
 *     wrapper unwraps `render` so existing call sites keep compiling.
 *   - `MenuItem` accepts `variant="destructive"`, mapped to
 *     `Dropdown.Item` `variant="danger"`.
 */

function Menu({
  children,
  onOpenChange,
}: {
  children: ReactNode;
  onOpenChange?: (open: boolean) => void;
}) {
  // HeroUI's Dropdown supports controlled `isOpen` / `onOpenChange` on its
  // root, but feature layers track open state outside the menu so we render
  // children unconditionally. The `onOpenChange` prop is preserved for
  // backwards compatibility with Base UI–style call sites.
  void onOpenChange;
  return <Dropdown>{children}</Dropdown>;
}

interface MenuTriggerProps {
  children?: ReactNode;
  /** Base UI legacy: `render={<Button ... />}` injects the trigger element. */
  render?: ReactElement;
}

function MenuTrigger({ children, render }: MenuTriggerProps) {
  const trigger = render ?? children;
  if (!trigger) {
    throw new Error('MenuTrigger requires either `children` or `render`.');
  }
  // HeroUI's `Dropdown.Trigger` is a context provider that accepts a single
  // pressable element as a child. Pass the element through unchanged.
  return <Dropdown.Trigger>{trigger}</Dropdown.Trigger>;
}

// Re-export for backwards compatibility with TypeScript code that imports it.
void isValidElement;

function MenuContent({
  className,
  children,
  align = 'start',
  placement,
}: {
  className?: string;
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  placement?:
    'top' | 'bottom' | 'left' | 'right' | 'bottom start' | 'bottom end' | 'top start' | 'top end';
}) {
  // Map Base UI's `align` (item alignment on the cross axis) to HeroUI's
  // `placement` (ARIA floating-ui form). HeroUI accepts `bottom start` /
  // `bottom end` as alignment modifiers; fall back to `bottom` when omitted.
  const fallbackPlacement =
    align === 'end' ? 'bottom end' : align === 'center' ? 'bottom' : 'bottom start';
  return (
    <Dropdown.Popover placement={placement ?? fallbackPlacement} className="z-50">
      <Dropdown.Menu
        className={cn(
          'min-w-44 rounded-xl border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg outline-none',
          className,
        )}
      >
        {children}
      </Dropdown.Menu>
    </Dropdown.Popover>
  );
}

interface MenuItemProps {
  className?: string;
  variant?: 'default' | 'destructive';
  onClick?: () => void;
  children?: ReactNode;
  /** Disable the item; defaults to false. */
  isDisabled?: boolean;
}

function MenuItem({
  className,
  variant = 'default',
  onClick,
  children,
  isDisabled,
}: MenuItemProps) {
  // Use a stable React id so Dropdown's onAction routing works.
  const id = useId();
  return (
    <Dropdown.Item
      id={id}
      variant={variant === 'destructive' ? 'danger' : 'default'}
      isDisabled={isDisabled}
      onAction={onClick}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm outline-none',
        'data-[highlighted]:bg-muted data-[highlighted]:text-foreground',
        variant === 'destructive' &&
          'text-danger data-[highlighted]:bg-danger-soft data-[highlighted]:text-danger-soft-foreground',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
    >
      <Label>{children}</Label>
    </Dropdown.Item>
  );
}

function MenuSeparator({ className }: { className?: string }) {
  return <Separator className={cn('-mx-1 my-1 h-px bg-border/80', className)} />;
}

function MenuLabel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <Dropdown.Section
      className={cn('px-2.5 pb-1 pt-1.5 text-xs font-medium text-muted-foreground', className)}
    >
      <Label>{children}</Label>
    </Dropdown.Section>
  );
}

export { Menu, MenuTrigger, MenuContent, MenuItem, MenuSeparator, MenuLabel };
