import { useEffect, useRef, type CSSProperties } from "react";
import type { EditorCollaborationPresence } from "@zhishu/editor-react";

export interface EditorCollaborationParticipantsProps {
  participants: readonly EditorCollaborationPresence[];
  label?: string;
  showCount?: boolean;
  className?: string;
}

export function EditorCollaborationParticipants({
  participants,
  label = "协同参与者",
  showCount = true,
  className,
}: EditorCollaborationParticipantsProps) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const details = detailsRef.current;
      if (
        details?.open &&
        event.target instanceof globalThis.Node &&
        !details.contains(event.target)
      )
        details.open = false;
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);
  if (participants.length === 0) return null;
  const visible = participants.slice(0, 5);
  const remaining = participants.length - visible.length;

  return (
    <details
      ref={detailsRef}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.nativeEvent.isComposing || !event.currentTarget.open)
          return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.open = false;
        event.currentTarget.querySelector("summary")?.focus();
      }}
      className={
        className
          ? `zhishu-collaboration-participants ${className}`
          : "zhishu-collaboration-participants"
      }
    >
      <summary aria-label={`${label}，共 ${participants.length} 位`}>
        <span className="zhishu-collaboration-avatar-stack" aria-hidden="true">
          {visible.map((participant) => (
            <span
              key={participant.clientId}
              className="zhishu-collaboration-avatar"
              data-local={participant.local ? "true" : undefined}
              style={{ "--zhishu-presence-color": participant.color } as CSSProperties}
              title={participant.displayName}
            >
              {participant.displayName.trim().slice(0, 1) || "?"}
            </span>
          ))}
          {remaining > 0 && (
            <span className="zhishu-collaboration-participant-more">+{remaining}</span>
          )}
        </span>
        {showCount && (
          <span className="zhishu-collaboration-participants-count">
            {participants.length} 位在线
          </span>
        )}
      </summary>
    </details>
  );
}
