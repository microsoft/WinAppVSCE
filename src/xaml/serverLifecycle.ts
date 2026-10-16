export class ServerLifecycle {
  private queue: Promise<void> = Promise.resolve();

  isDisposing = false;

  reset(): void {
    this.isDisposing = false;
  }

  beginDisposal(): void {
    this.isDisposing = true;
  }

  runExclusive(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }
}
