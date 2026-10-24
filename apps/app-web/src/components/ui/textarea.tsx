import type { ComponentProps } from 'react';
import { forwardRef } from 'react';
import { TextArea as HeroUITextArea } from '@heroui/react';
import { cn } from '@/lib/cn';

/**
 * HeroUI v3 `TextArea` is used wherever 知书 needs a multi-line text field.
 * React Aria underneath provides the same accessibility guarantees as
 * `Input` (IME handling, focus management, invalid state announcements).
 */

export type TextareaProps = ComponentProps<typeof HeroUITextArea>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, ...props },
  ref,
) {
  return (
    <HeroUITextArea
      ref={ref}
      data-slot="textarea"
      className={cn(
        'min-h-24 w-full min-w-0 resize-y rounded-lg border border-input bg-card px-3 py-2.5 text-sm leading-6 shadow-none placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/10 disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
});
