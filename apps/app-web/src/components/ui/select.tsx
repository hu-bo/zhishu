import type { Key, ReactNode } from 'react';
import { Children, createContext, isValidElement, useContext, useMemo } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import {
  Label,
  ListBox,
  ListBoxItem,
  ListBoxItemIndicator,
  Select as HeroSelect,
} from '@heroui/react';
import { cn } from '@/lib/cn';

/**
 * HeroUI v3 `Select` wrapper that preserves the Base UI–style call surface
 * (`Select` + `SelectTrigger` / `SelectValue` / `SelectContent` /
 * `SelectItem`). The underlying compound is `Select.Trigger` / `Select.Value` /
 * `Select.Indicator` / `Select.Popover` plus the `ListBox` / `ListBox.Item`
 * collection primitives.
 *
 * Migration notes:
 *   - Base UI's `value` / `onValueChange` are mapped onto HeroUI's
 *     `selectedKey` (`Key`) / `onSelectionChange` (`Key | null`).
 *   - `SelectItem` exposes a familiar `value` + `children` API; the wrapper
 *     forwards the children into `textValue` when the children are a single
 *     string so the ListBox can announce them, otherwise it uses the value.
 *   - The trigger renders a `ChevronDown` indicator via `Select.Indicator`.
 */

const SelectLabels = createContext<Record<string, string>>({});
interface SelectProps<T extends string> {
  value: T;
  onValueChange: (value: T | null) => void;
  disabled?: boolean;
  children?: ReactNode;
  /**
   * Accessible labels for items with icons or other rich children.
   */
  items?: Record<string, string>;
}

function Select<T extends string>({
  value,
  onValueChange,
  disabled,
  children,
  items = {},
}: SelectProps<T>) {
  const trigger = Children.toArray(children).find(
    (child) =>
      isValidElement<SelectTriggerProps>(child) &&
      (child.props.id || child.props['aria-label'] || child.props['aria-labelledby']),
  );
  const labelProps = isValidElement<SelectTriggerProps>(trigger) ? trigger.props : undefined;
  return (
    <SelectLabels.Provider value={items}>
      <HeroSelect
        data-slot="select"
        id={labelProps?.id}
        aria-label={labelProps?.['aria-label'] ? undefined : '选择选项'}
        aria-labelledby={labelProps?.['aria-labelledby']}
        isDisabled={disabled}
        selectedKey={value}
        onSelectionChange={(key: Key | null) => {
          onValueChange((key as T | null) ?? null);
        }}
      >
        {labelProps?.['aria-label'] && (
          <Label className="sr-only">{labelProps['aria-label']}</Label>
        )}
        {children}
      </HeroSelect>
    </SelectLabels.Provider>
  );
}

interface SelectTriggerProps {
  className?: string;
  children?: ReactNode;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}

function SelectTrigger({ className, children, disabled }: SelectTriggerProps) {
  return (
    <HeroSelect.Trigger
      data-slot="select-trigger"
      isDisabled={disabled}
      className={cn(
        'inline-flex h-10 min-w-0 shrink-0 items-center justify-between gap-2 rounded-lg border border-input bg-card px-3 text-[13px] font-normal whitespace-nowrap text-foreground shadow-none transition-colors outline-none select-none hover:bg-secondary disabled:pointer-events-none disabled:opacity-50 data-[open=true]:bg-secondary aria-invalid:border-destructive focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/10 [&_svg]:pointer-events-none [&_svg]:shrink-0',
        className,
      )}
    >
      {children}
      <HeroSelect.Indicator className="text-muted-foreground">
        <ChevronDown size={14} aria-hidden="true" />
      </HeroSelect.Indicator>
    </HeroSelect.Trigger>
  );
}

function SelectValue({ children }: { children?: ReactNode }) {
  // `Select.Value` falls back to the trigger's placeholder when no children
  // are provided. Existing call sites don't supply a placeholder, so the
  // value from the selected item (ListBoxItem textValue) is rendered.
  return <HeroSelect.Value data-slot="select-value">{children}</HeroSelect.Value>;
}

interface SelectContentProps {
  className?: string;
  children?: ReactNode;
}

function SelectContent({ className, children }: SelectContentProps) {
  return (
    <HeroSelect.Popover placement="bottom" className={cn('z-50', className)}>
      <ListBox className="max-h-72 min-w-(--trigger-width) overflow-y-auto rounded-xl border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg outline-none">
        {children}
      </ListBox>
    </HeroSelect.Popover>
  );
}

interface SelectItemProps {
  value: string;
  className?: string;
  children?: ReactNode;
}

function SelectItem({ value, className, children }: SelectItemProps) {
  const labels = useContext(SelectLabels);
  const textValue = labels[value] ?? (typeof children === 'string' ? children : value);
  // React Aria builds a hidden collection from these elements. Keep its
  // item props stable when only the label context's object identity changes.
  return useMemo(
    () => (
      <ListBoxItem
        id={value}
        textValue={textValue}
        data-slot="select-item"
        className={cn(
          'flex cursor-pointer items-center gap-2 rounded-lg py-1.5 pr-2 pl-2 text-sm outline-none select-none',
          'data-[focused=true]:bg-secondary data-[focused=true]:text-foreground',
          'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
          '[&_svg]:pointer-events-none [&_svg]:shrink-0',
          className,
        )}
      >
        <ListBoxItemIndicator className="flex size-4 items-center justify-center text-primary">
          <Check size={14} aria-hidden="true" />
        </ListBoxItemIndicator>
        <span className="flex min-w-0 flex-1 items-center gap-2 truncate">{children}</span>
      </ListBoxItem>
    ),
    [value, textValue, className, children],
  );
}

export { Select, SelectTrigger, SelectValue, SelectContent, SelectItem };
