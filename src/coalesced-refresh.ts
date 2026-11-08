/**
 * An Adapter's refresh, safe to call concurrently: a call during a pass
 * shares it and asks for at most one more pass, which `stopped` cancels.
 */
export class CoalescedRefresh {
  private inflight: Promise<void> | null = null;
  private rerun = false;

  constructor(
    private readonly pass: () => Promise<void>,
    private readonly stopped: () => boolean = () => false,
  ) {}

  get running(): boolean {
    return this.inflight !== null;
  }

  run(): Promise<void> {
    if (this.inflight) {
      this.rerun = true;
      return this.inflight;
    }
    this.inflight = (async () => {
      do {
        this.rerun = false;
        await this.pass();
      } while (this.rerun && !this.stopped());
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Settles when the running pass, if any, has. */
  async idle(): Promise<void> {
    await this.inflight;
  }
}
