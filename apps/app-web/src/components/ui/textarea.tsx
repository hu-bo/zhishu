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
      className={cn('text-sm md:text-sm', className)}
      {...props}
    />
  );
});
