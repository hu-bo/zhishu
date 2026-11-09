import { z } from "zod";
import { pluginRecordOf, type PluginRecord, type TurnEndReason } from "@deepseek-ai/dsh-session";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
export interface NativeChatState {
  currentTurn: number;
  inputs: Record<string, number>;
  pending: { "next-turn": string[]; "next-step": string[] };
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
  stateVersion: 2,
  stateSchema: z.object({
    currentTurn: z.number().int(),
    inputs: z.record(z.string(), z.number().int()),
    pending: z.object({ "next-turn": z.array(z.string()), "next-step": z.array(z.string()) }),
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
  init: () => ({
    currentTurn: 0,
    inputs: {},
    pending: { "next-turn": [], "next-step": [] },
    turns: {},
    records: [],
  }),
  apply(state, event) {
    const record = pluginRecordOf(event);
    if (record) return { ...state, records: [...state.records, record] };
    if (event.type === "agent/inbox/spliced") {
      const { target, start, removedCount = 0, inserted, outcome } = event.data;
      const pending = [...state.pending[target]];
      const removed = pending.splice(start, removedCount, ...inserted.map((m) => m.id));
      // A rejected/pre-request step need not append user/message. Its claimed input
      // still belongs to the enclosing turn, including during crash reconciliation.
      const inputs = { ...state.inputs };
      if (outcome !== "canceled")
        for (const messageId of removed) inputs[messageId] = state.currentTurn;
      return { ...state, inputs, pending: { ...state.pending, [target]: pending } };
    }
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
