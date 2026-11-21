import type { ReactNode } from "react";
import type { CardTone } from "./types.js";

export interface ActionCardBadge {
  text: string;
  /** Show a spinner instead of the static dot (in-flight states). */
  spinner?: boolean;
}

export interface ActionCardProps {
  tone: CardTone;
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  badge?: ActionCardBadge;
  time?: string;
  /** Key information rows (kv lists, step tracks, change lists). */
  children?: ReactNode;
  /** Primary/secondary action row; at most one primary action per card. */
  footer?: ReactNode;
  /** Small muted note under a dashed separator. */
  footnote?: ReactNode;
  /** Accessible name override for the card region. */
  label?: string;
  className?: string;
}

/**
 * Unified action-result card: icon tile, title, status badge, key info and actions.
 * Purely presentational — the host owns every state fact rendered here.
 */
export function ActionCard({
  tone,
  icon,
  title,
  subtitle,
  badge,
  time,
  children,
  footer,
  footnote,
  label,
  className = "",
}: ActionCardProps) {
  return (
    <section
      className={`zhishu-chat-card zhishu-chat-card--${tone} ${className}`}
      data-tone={tone}
      aria-label={label}
    >
      <header className="zhishu-chat-card__head">
        {icon && (
          <span className="zhishu-chat-card__icon" aria-hidden="true">
            {icon}
          </span>
        )}
        <span className="zhishu-chat-card__titles">
          <strong className="zhishu-chat-card__title">{title}</strong>
          {subtitle && <span className="zhishu-chat-card__subtitle">{subtitle}</span>}
        </span>
        {badge && (
          <span className={`zhishu-chat-card__badge zhishu-chat-card__badge--${tone}`}>
            {badge.spinner ? (
              <span className="zhishu-chat-spinner" aria-hidden="true" />
            ) : (
              <span className="zhishu-chat-card__dot" aria-hidden="true" />
            )}
            {badge.text}
          </span>
        )}
        {time && <span className="zhishu-chat-card__time">{time}</span>}
      </header>
      {children && <div className="zhishu-chat-card__body">{children}</div>}
      {footer && <div className="zhishu-chat-card__foot">{footer}</div>}
      {footnote && <p className="zhishu-chat-card__footnote">{footnote}</p>}
    </section>
  );
}
