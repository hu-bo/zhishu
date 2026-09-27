import type { EditorCollaborationSession } from "@zhishu/editor-react";
import type { HocuspocusCollaborationSession } from "@zhishu/editor-collaboration/hocuspocus";

/** Compile-time check that the concrete Provider session can be handed to EditorProvider. */
export function asEditorCollaborationSession(
  session: HocuspocusCollaborationSession,
): EditorCollaborationSession {
  return session;
}
