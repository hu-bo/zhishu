import { z } from "zod";
import { pluginRecordOf, type PluginRecord, type TurnEndReason } from "@deepseek-ai/dsh-session";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
export interface NativeChatState {
  currentTurn: number;
  inputs: Record<string, number>;
  turns: Record<string, { text: string; hasTools: boolean; reason?: TurnEndReason }>;
  records: PluginRecord[];
}
declare module "@deepseek-ai/dsh-session-projection" {
  interface SessionProjectionStateMap {
    zhishuChat: NativeChatState;
  }
}
/** Official incremental projection seam owns history reads and replay. */
export const chatProjection: ProjectionDefinition<"zhishuChat"> = {
  key: "zhishuChat",
  stateVersion: 1,
  stateSchema: z.object({
    currentTurn: z.number().int(),
    inputs: z.record(z.string(), z.number().int()),
    turns: z.record(
      z.string(),
      z.object({
        text: z.string(),
        hasTools: z.boolean(),
        reason: z.custom<TurnEndReason>().optional(),
      }),
    ),
    records: z.array(z.custom<PluginRecord>()),
  }),
  init: () => ({ currentTurn: 0, inputs: {}, turns: {}, records: [] }),
  apply(state, event) {
    const record = pluginRecordOf(event);
    if (record) return { ...state, records: [...state.records, record] };
    if (event.type === "turn/start")
      return {
        ...state,
        currentTurn: event.data.turn,
        turns: { ...state.turns, [event.data.turn]: { text: "", hasTools: false } },
      };
    if (event.type === "user/message")
      return { ...state, inputs: { ...state.inputs, [event.data.id]: state.currentTurn } };
    if (
      event.type === "assistant/message" ||
      event.type === "tool/call" ||
      event.type === "turn/end"
    ) {
      const turn = event.data.turn,
        previous = state.turns[turn] ?? { text: "", hasTools: false };
      const current =
        event.type === "assistant/message"
          ? {
              ...previous,
              text: [
                previous.text,
                ...event.data.message.content.filter((b) => b.type === "text").map((b) => b.text),
              ]
                .filter(Boolean)
                .join("\n\n"),
            }
          : event.type === "tool/call"
            ? { ...previous, hasTools: true }
            : { ...previous, reason: event.data.reason };
      return { ...state, turns: { ...state.turns, [turn]: current } };
    }
    return state;
  },
};
