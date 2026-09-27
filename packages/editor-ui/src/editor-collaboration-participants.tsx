import type { CSSProperties } from "react";
import type { EditorCollaborationPresence } from "@zhishu/editor-react";

export interface EditorCollaborationParticipantsProps {
  participants: readonly EditorCollaborationPresence[];
  label?: string;
  className?: string;
}

export function EditorCollaborationParticipants({
  participants,
  label = "协同参与者",
  className,
}: EditorCollaborationParticipantsProps) {
  if (participants.length === 0) return null;
  const visible = participants.slice(0, 5);
  const remaining = participants.length - visible.length;

  return (
    <div
      className={
        className
          ? `zhishu-collaboration-participants ${className}`
          : "zhishu-collaboration-participants"
      }
      role="group"
      aria-label={label}
    >
      {visible.map((participant) => (
        <span
          key={participant.clientId}
          className="zhishu-collaboration-participant"
          data-local={participant.local ? "true" : undefined}
          style={{ "--zhishu-presence-color": participant.color } as CSSProperties}
        >
          {participant.displayName}
          {participant.local ? "（你）" : ""}
        </span>
      ))}
      {remaining > 0 && (
        <span
          className="zhishu-collaboration-participant-more"
          aria-label={`还有 ${remaining} 位参与者`}
        >
          +{remaining}
        </span>
      )}
    </div>
  );
}
