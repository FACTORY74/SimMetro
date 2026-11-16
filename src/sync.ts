/** Revisions are ordered only within one server process. Retire old sessions to
 * prevent delayed responses from switching the client back after a restart. */
export class StateCursor {
  session: string | null = null;
  revision: number | null = null;
  private retired = new Set<string>();

  accept(next: { session: string; revision: number }): boolean {
    if (this.retired.has(next.session)) return false;
    if (next.session === this.session && this.revision !== null && next.revision <= this.revision) return false;
    if (this.session !== null && this.session !== next.session) this.retired.add(this.session);
    this.session = next.session;
    this.revision = next.revision;
    return true;
  }

  matches(next: { session: string; revision: number }): boolean {
    return next.session === this.session && next.revision === this.revision;
  }

  query(): string {
    return this.session === null ? "" : `?since=${this.revision}&session=${encodeURIComponent(this.session)}`;
  }
}

/** Retry transient failures even if the city's traffic revision stays fixed. */
export function retryUntilSuccess<T>(request: (signal: AbortSignal) => Promise<T>,
  accept: (value: T) => void, delay = 1200): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = async () => {
    try {
      const value = await request(controller.signal);
      if (!controller.signal.aborted) accept(value);
    } catch {
      if (!controller.signal.aborted) timer = setTimeout(attempt, delay);
    }
  };
  void attempt();
  return () => { controller.abort(); clearTimeout(timer); };
}
