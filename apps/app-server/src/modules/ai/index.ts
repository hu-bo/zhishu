import type { Database } from "../../../database/index.js";
import { AiService } from "./ai.service.js";
import { ConversationEventBus } from "./event-stream.js";

/**
 * The ai module is the shared product infrastructure only: conversation/message/Run/artifact/
 * event transactions, leases, idempotency, budgets and configuration assembly. It does not
 * choose user intent and never drives an execution engine; qa and writing modules compose it.
 */
export interface AiInfra {
  service: AiService;
  bus: ConversationEventBus;
  start(): void;
  stop(): Promise<void>;
}

export function createAiInfra(
  db: Database,
  log: (event: string, meta: Record<string, unknown>) => void,
): AiInfra {
  const bus = new ConversationEventBus();
  const service = new AiService(db, log, (key) => bus.wake(key));
  let timer: NodeJS.Timeout | undefined;
  return {
    service,
    bus,
    start() {
      const maintain = async () => {
        try {
          await service.maintain();
        } catch (error) {
          log("ai_maintain_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };
      void maintain();
      timer = setInterval(() => void maintain(), 3_600_000);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
    },
  };
}

export { AiService } from "./ai.service.js";
export { AiRepository } from "./ai.repository.js";
export type { ConversationOwner, CreateConversationCommand } from "./ai.service.js";
export * from "./ai.types.js";
export * from "./event-stream.js";
