import { forwardRef, type ChangeEvent, type ReactNode } from 'react';
import { Input as HeroInput, Label, TextField } from '@heroui/react';
import { cn } from '@/lib/cn';

/**
 * HeroUI v3 TextField / Input 封装。
 *
 * - `Field` 负责 label / invalid / disabled 状态，传给 `TextField`。
 * - `FieldInput` 仅承载输入框本体；图标由调用方在 children 处自己拼，
 *   避免在 HeroUI Input 不支持 startContent 时还需额外适配。
 * - 通过 `forwardRef` 暴露底层 input，方便自动聚焦。
 */

interface FieldProps {
  className?: string;
  isRequired?: boolean;
  isInvalid?: boolean;
  isDisabled?: boolean;
  name?: string;
  children?: ReactNode;
}

export function Field({
  className,
  isRequired,
  isInvalid,
  isDisabled,
  name,
  children,
}: FieldProps) {
  return (
    <TextField
      data-slot="field"
      className={cn('flex flex-col gap-1.5', className)}
      isRequired={isRequired}
      isInvalid={isInvalid}
      isDisabled={isDisabled}
      name={name}
    >
      {children}
    </TextField>
  );
}

export interface FieldLabelProps {
  className?: string;
  children?: ReactNode;
  htmlFor?: string;
}

export function FieldLabel({ className, children, htmlFor }: FieldLabelProps) {
  return (
    <Label htmlFor={htmlFor} className={cn('text-xs font-medium text-foreground', className)}>
      {children}
    </Label>
  );
}

interface FieldInputProps {
  id?: string;
  className?: string;
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  type?: 'text' | 'search' | 'email' | 'url' | 'password';
  /** 前置图标等内容，会渲染在 input 左侧。 */
  startAdornment?: ReactNode;
  /** 后置图标等内容，会渲染在 input 右侧。 */
  endAdornment?: ReactNode;
  'aria-label'?: string;
}

export const FieldInput = forwardRef<HTMLInputElement, FieldInputProps>(function FieldInput(
  {
    id,
    className,
    value,
    onChange,
    placeholder,
    disabled,
    autoFocus,
    type = 'text',
    startAdornment,
    endAdornment,
    ...rest
  },
  ref,
) {
  return (
    <div
      className={cn(
        'flex h-10 w-full items-center gap-2 rounded-lg border border-input bg-card px-3 text-sm transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/10',
        disabled && 'opacity-60',
      )}
      data-disabled={disabled || undefined}
    >
      {startAdornment && (
        <span className="flex shrink-0 items-center text-muted-foreground">{startAdornment}</span>
      )}
      <HeroInput
        id={id}
        ref={ref}
        value={value ?? ''}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange?.(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        type={type}
        aria-label={rest['aria-label']}
        className={cn(
          'h-full min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 shadow-none ring-0 focus-visible:ring-0',
          className,
        )}
      />
      {endAdornment && (
        <span className="flex shrink-0 items-center text-muted-foreground">{endAdornment}</span>
      )}
    </div>
  );
});
