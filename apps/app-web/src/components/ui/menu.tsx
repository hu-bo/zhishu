import * as React from 'react';
import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { cn } from '@/lib/cn';

function Menu({ children }: { children: React.ReactNode }) {
  return <MenuPrimitive.Root>{children}</MenuPrimitive.Root>;
}

function MenuTrigger({
  render,
  ...props
}: MenuPrimitive.Trigger.Props & { render?: React.ReactElement }) {
  return <MenuPrimitive.Trigger render={render} {...props} />;
}

function MenuContent({
  className,
  side = 'bottom',
  align = 'start',
  sideOffset = 6,
  ...props
}: MenuPrimitive.Popup.Props & {
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
}) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner side={side} align={align} sideOffset={sideOffset} className="z-50">
        <MenuPrimitive.Popup
          {...props}
          className={cn(
            'min-w-44 origin-[var(--transform-origin)] rounded-xl border border-border bg-card p-1 text-sm text-foreground shadow-lg shadow-foreground/5 outline-none',
            'data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
            'transition-[scale,opacity] duration-150 motion-reduce:transition-none',
            className,
          )}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function MenuItem({
  className,
  variant = 'default',
  ...props
}: MenuPrimitive.Item.Props & { variant?: 'default' | 'destructive' }) {
  return (
    <MenuPrimitive.Item
      {...props}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm outline-none transition-colors duration-150',
        'data-[highlighted]:bg-muted data-[highlighted]:text-foreground',
        variant === 'destructive' &&
          'text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
    />
  );
}

function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator {...props} className={cn('-mx-1 my-1 h-px bg-border/80', className)} />
  );
}

function MenuLabel({ className, ...props }: MenuPrimitive.GroupLabel.Props) {
  return (
    <MenuPrimitive.GroupLabel
      {...props}
      className={cn('px-2.5 pb-1 pt-1.5 text-xs font-medium text-muted-foreground', className)}
    />
  );
}

export { Menu, MenuTrigger, MenuContent, MenuItem, MenuSeparator, MenuLabel };
