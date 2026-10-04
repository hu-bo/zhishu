import type { ComponentProps } from 'react';
import { forwardRef } from 'react';
import { Input as HeroUIInput } from '@heroui/react';
import { cn } from '@/lib/cn';

/**
 * HeroUI v3 `Input` is the foundation for all text fields in 知书. It is built
 * on React Aria, which gives us IME composition handling, invalid state
 * announcements, and focus management for free. This thin wrapper preserves
 * the Base UI–style call surface (`ref`, native `<input>` props,
 * `data-slot="input"`) so feature code keeps working unchanged.
 */

export type InputProps = ComponentProps<typeof HeroUIInput>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <HeroUIInput
      ref={ref}
      data-slot="input"
      className={cn('h-8 text-sm md:text-sm', className)}
      {...props}
    />
  );
});
