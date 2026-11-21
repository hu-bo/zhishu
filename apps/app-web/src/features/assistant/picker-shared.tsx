import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/cn';

/** Shared Popover skin for toolbar pickers (opens upward, clamped to the viewport). */
export const pickerPopoverClass =
  'z-50 w-80 max-w-[calc(100vw-1.5rem)] rounded-xl border border-border bg-popover p-1.5 shadow-[var(--overlay-shadow)]';

/** Card action buttons follow the 32px toolbar scale, matching the 12.5px card text. */
export const CARD_BUTTON_CLASS = 'h-8 gap-1.5 px-3 text-[12.5px]';

const TRIGGER_ICON_TONE = {
  default: 'text-muted',
  narrowed: 'text-accent',
  warn: 'text-warning',
} as const satisfies Record<'default' | 'narrowed' | 'warn', string>;

const TRIGGER_TEXT_TONE = {
  default: 'text-muted hover:text-foreground',
  narrowed: 'text-muted hover:text-foreground',
  warn: 'text-warning hover:text-warning',
} as const satisfies Record<'default' | 'narrowed' | 'warn', string>;

/** Compact icon + value + chevron toolbar trigger; `open` rotates the chevron. */
export function PickerTrigger({
  icon: Icon,
  label,
  ariaLabel,
  open,
  tone = 'default',
}: {
  icon: LucideIcon;
  label: string;
  ariaLabel: string;
  open: boolean;
  tone?: 'default' | 'narrowed' | 'warn';
}) {
  return (
    <Button
      variant="ghost"
      size="xs"
      className={cn(
        'h-8 max-w-52 gap-1.5 px-2 text-[12.5px] font-normal',
        open ? 'bg-accent-soft text-accent-soft-foreground' : TRIGGER_TEXT_TONE[tone],
      )}
      title={ariaLabel}
      aria-label={ariaLabel}
    >
      <Icon className={cn('size-4 shrink-0', TRIGGER_ICON_TONE[tone])} />
      <span className="max-w-40 truncate">{label}</span>
      <ChevronDown
        className={cn('size-3.5 shrink-0 opacity-60 transition-transform', open && 'rotate-180')}
        aria-hidden="true"
      />
    </Button>
  );
}

/** Single-choice check indicator. */
export function RadioTick({ active }: { active: boolean }) {
  return (
    <span className="flex w-4 shrink-0 items-center justify-center text-accent" aria-hidden="true">
      {active && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path
            d="m4.5 12.5 5 5 10-11"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </span>
  );
}

/** Multiple-choice checkbox indicator. */
export function CheckTick({ active }: { active: boolean }) {
  return (
    <span
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-[5px] border',
        active ? 'border-transparent bg-accent text-accent-foreground' : 'border-border bg-surface',
      )}
      aria-hidden="true"
    >
      {active && (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
          <path
            d="m4.5 12.5 5 5 10-11"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </span>
  );
}

/** Muted server-authority note at the bottom of a picker. */
export function PickerNote({ children }: { children: ReactNode }) {
  return (
    <p className="mt-1 border-t border-dashed border-border px-2 pt-1.5 pb-0.5 text-[11px] leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}
