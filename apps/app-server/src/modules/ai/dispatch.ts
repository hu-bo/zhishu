/**
 * Shared claim/dispatch lifecycle for the assistant flow. It polls the shared store for
 * queued Runs with bounded backoff and kick semantics; centralizing the controller/timer
 * lifecycle keeps admission and execution from drifting. There is exactly one product loop.
 */
export class DispatchLoop {
  private controller?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;

  constructor(
    private readonly drain: () => Promise<boolean>,
    private readonly log: (event: string, meta: Record<string, unknown>) => void,
    private readonly name: string,
  ) {}

  start(): void {
    if (this.controller) return;
    this.controller = new AbortController();
    const loop = async (): Promise<void> => {
      while (this.controller && !this.controller.signal.aborted) {
        const processed = await this.drain().catch((error: unknown) => {
          this.log(`${this.name}_dispatch_failed`, {
            error: error instanceof Error ? error.message : String(error),
          });
          return false;
        });
        await new Promise((resolve) => setTimeout(resolve, processed ? 50 : 400));
      }
    };
    this.running = loop();
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  /** Nudge an immediate drain after admitting work; the loop keeps polling regardless. */
  kick(): void {
    if (!this.controller) return;
    this.timer = setTimeout(
      () =>
        void this.drain().catch((error: unknown) => {
          this.log(`${this.name}_kick_failed`, {
            error: error instanceof Error ? error.message : String(error),
          });
        }),
      50,
    );
    this.timer.unref();
  }
}
