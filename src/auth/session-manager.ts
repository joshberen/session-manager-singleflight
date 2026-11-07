/**
 * Session token refresh with single-flight (request coalescing) semantics.
 *
 * Problem this replaces: `Promise.all(users.map(u => refreshToken(u.id)))`
 * fired one HTTP refresh per concurrent caller. On a 401 storm every request
 * handler refreshed the same session independently, the last writer won, and
 * the earlier responses were already stale — the classic 401 refresh loop.
 *
 * Fix: at most one refresh request is in flight per session id. Concurrent
 * callers within the same event loop tick await the same Promise, so they all
 * receive one token and one HTTP round trip is spent.
 */

export type RefreshTransport = (sessionId: string) => Promise<string>;

export interface SessionManagerOptions {
  /** Override the HTTP layer (used by tests and by non-fetch runtimes). */
  transport?: RefreshTransport;
  /** Endpoint hit by the default transport. */
  endpoint?: string;
}

export class SessionManager {
  /** sessionId -> the in-flight refresh for that session. */
  private readonly inflight = new Map<string, Promise<string>>();

  private readonly transport: RefreshTransport;

  constructor(options: SessionManagerOptions = {}) {
    const endpoint = options.endpoint ?? "/auth/refresh";
    this.transport =
      options.transport ??
      (async (sessionId: string) => {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId }),
        });
        if (!res.ok) {
          throw new Error(`refresh failed: ${res.status}`);
        }
        const body = (await res.json()) as { accessToken?: string };
        if (!body.accessToken) {
          throw new Error("refresh failed: no accessToken in response");
        }
        return body.accessToken;
      });
  }

  /**
   * Refresh the access token for `sessionId`, joining an existing in-flight
   * refresh instead of starting a second one.
   */
  refreshToken(sessionId: string): Promise<string> {
    const existing = this.inflight.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }

    const attempt = this.transport(sessionId);

    // Track the wrapped promise so waiters share both resolution and rejection.
    const tracked: Promise<string> = attempt.finally(() => {
      // Only clear the slot if it still holds THIS flight. A newer refresh may
      // have replaced it while we were waiting, and deleting unconditionally
      // would drop that newer request's bookkeeping.
      if (this.inflight.get(sessionId) === tracked) {
        this.inflight.delete(sessionId);
      }
    });

    this.inflight.set(sessionId, tracked);
    return tracked;
  }

  /** Number of refreshes currently in flight — diagnostics only. */
  get inFlightCount(): number {
    return this.inflight.size;
  }
}
