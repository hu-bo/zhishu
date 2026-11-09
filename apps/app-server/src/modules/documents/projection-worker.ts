import { DocumentProjectionRepository } from "./document-projection.repository.js";

const IDLE_POLL_INTERVAL_MS = 1_000;
const BUSY_POLL_INTERVAL_MS = 100;
const MAX_JOBS_PER_TICK = 10;

export class DocumentProjectionWorker {
  private stopped = true;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly repository: DocumentProjectionRepository,
    private readonly logFailure: (error: unknown) => void,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    this.running = this.processBatch();
    await this.running;
    this.running = undefined;
    if (this.stopped) return;
    this.timer = setTimeout(
      () => void this.tick(),
      this.lastBatchHadWork ? BUSY_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS,
    );
    this.timer.unref();
  }

  private lastBatchHadWork = false;

  private async processBatch(): Promise<void> {
    this.lastBatchHadWork = false;
    for (let processed = 0; processed < MAX_JOBS_PER_TICK && !this.stopped; processed += 1) {
      try {
        const job = await this.repository.claimProjectionJob();
        if (!job) return;
        this.lastBatchHadWork = true;
        try {
          await this.repository.processProjectionJob(job);
        } catch (error) {
          this.logFailure(error);
          await this.repository.failProjectionJob(job);
        }
      } catch (error) {
        this.logFailure(error);
        return;
      }
    }
  }
}
