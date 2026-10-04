import type { ReactNode } from 'react';
import { Button as HeroUIButton, type ButtonProps as HeroUIButtonProps } from '@heroui/react';
import { buttonVariants } from '@heroui/styles';
import { cn } from '@/lib/cn';

/**
 * Theme-aware wrapper around HeroUI v3 `Button` that keeps a Base UI–style
 * surface (`variant` + `size` + `onClick` + `data-slot="button"`).
 *
 * Variants:
 *   default → primary  ·  secondary → secondary
 *   ghost   → ghost    ·  outline   → outline
 *   destructive → danger ·  link → tertiary + underline
 *
 * Sizes:
 *   default → md · xs → sm · sm → sm · lg → lg
 *   icon/icon-xs/icon-sm/icon-lg → isIconOnly + matching sm/md/lg
 *
 * Migration notes:
 *   - `onClick` is forwarded to HeroUI's `onPress` so feature code keeps
 *     working without touching every call site. The wrapper accepts a
 *     permissive signature (Base UI / native MouseEvent) and casts to the
 *     HeroUI PressEvent at the boundary.
 *   - `disabled` (Base UI / native button) is forwarded as `isDisabled`.
 *   - `title` (tooltip) is forwarded as the native HTML attribute.
 *   - `Button` already has `data-slot="button"` baked in via HeroUI.
 */

export type ButtonVariant = 'default' | 'outline' | 'secondary' | 'ghost' | 'destructive' | 'link';

export type ButtonSize =
  'default' | 'xs' | 'sm' | 'lg' | 'icon' | 'icon-xs' | 'icon-sm' | 'icon-lg';

// We intentionally relax the `onClick` signature so legacy call sites that
// type it as `(event: MouseEvent<HTMLButtonElement>) => void` keep working.
// HeroUI's underlying button is a React Aria Pressable, which types its
// `onPress` against `FocusableElement` (broader than HTMLButtonElement).
// At runtime the dispatched element is still the rendered `<button>` so
// the call sites that rely on it being a button keep working.
export interface ButtonProps extends Omit<
  HeroUIButtonProps,
  'variant' | 'isIconOnly' | 'onPress' | 'children' | 'onClick' | 'size'
> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children?: ReactNode;
  /** Base UI / native button alias for `isDisabled`. */
  disabled?: boolean;
  /** Native HTML tooltip. */
  title?: string;
  /** Base UI / native click handler (forwarded to HeroUI's `onPress`). */
  onClick?: (event: unknown) => void;
}

function mapVariant(variant: ButtonVariant): HeroUIButtonProps['variant'] {
  switch (variant) {
    case 'outline':
      return 'outline';
    case 'secondary':
      return 'secondary';
    case 'ghost':
      return 'ghost';
    case 'destructive':
      return 'danger';
    case 'link':
      return 'tertiary';
    case 'default':
    default:
      return 'primary';
  }
}

function resolveSize(size: ButtonSize): {
  size: NonNullable<HeroUIButtonProps['size']>;
  isIconOnly: boolean;
} {
  switch (size) {
    case 'xs':
      return { size: 'sm', isIconOnly: false };
    case 'sm':
      return { size: 'sm', isIconOnly: false };
    case 'lg':
      return { size: 'lg', isIconOnly: false };
    case 'icon-xs':
      return { size: 'sm', isIconOnly: true };
    case 'icon-sm':
      return { size: 'sm', isIconOnly: true };
    case 'icon':
      return { size: 'md', isIconOnly: true };
    case 'icon-lg':
      return { size: 'lg', isIconOnly: true };
    case 'default':
    default:
      return { size: 'md', isIconOnly: false };
  }
}

const linkClass = 'text-accent underline-offset-4 hover:underline';

// Re-export the HeroUI tailwind-variants helper so call sites that previously
// used the CVA-based `buttonVariants({ variant: 'outline' })` (for applying
// button styling to non-button elements like `<Link>`) keep compiling.
export { buttonVariants };

export function Button({
  variant = 'default',
  size = 'default',
  className,
  onClick,
  disabled,
  isDisabled,
  title,
  children,
  ...rest
}: ButtonProps) {
  const heroVariant = mapVariant(variant);
  const { size: heroSize, isIconOnly } = resolveSize(size);
  // HeroUI's `Button` props intentionally strip native HTML button
  // attributes like `title`, but React Aria's underlying button does pass
  // `title` through to the DOM at runtime. Cast so the type checker accepts
  // the prop without requiring call sites to drop their tooltips.
  const buttonProps = {
    'data-slot': 'button',
    variant: heroVariant,
    size: heroSize,
    isIconOnly,
    isDisabled: disabled ?? isDisabled,
    title,
    className: cn(variant === 'link' && linkClass, className),
    onPress: onClick as HeroUIButtonProps['onPress'],
    ...rest,
  };
  return <HeroUIButton {...(buttonProps as unknown as HeroUIButtonProps)}>{children}</HeroUIButton>;
}
