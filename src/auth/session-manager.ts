/**
 * Session token refresh — pre-refactor version.
 *
 * Bug: refreshToken() has no single-flight protection. Every concurrent caller
 * issues its own HTTP refresh for the same session, so a 401 storm produces N
 * overlapping refreshes per session, the last writer wins, and every earlier
 * response is already stale. That is the 401 loop seen in production under
 * concurrency.
 */

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export class SessionManager {
  private readonly tokens = new Map<string, TokenPair>();

  constructor(private readonly endpoint: string = "/auth/refresh") {}

  getToken(sessionId: string): TokenPair | undefined {
    return this.tokens.get(sessionId);
  }

  /**
   * Refresh every listed session in parallel.
   *
   * NOTE: this is the call site that triggers the loop — Promise.all over an
   * array of refresh requests with no mutex means duplicate in-flight refreshes
   * for the same session id.
   */
  async refreshAll(sessionIds: string[]): Promise<TokenPair[]> {
    return Promise.all(sessionIds.map((id) => this.refreshToken(id)));
  }

  /**
   * Refresh one session. No coalescing: two calls for the same session id in
   * the same tick both go to the network.
   */
  async refreshToken(sessionId: string): Promise<TokenPair> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });

    if (!res.ok) {
      throw new Error(`refresh failed: ${res.status}`);
    }

    const body = (await res.json()) as {
      accessToken?: string;
      refreshToken?: string;
      expiresIn?: number;
    };

    if (!body.accessToken || !body.refreshToken) {
      throw new Error("refresh failed: incomplete token pair");
    }

    const pair: TokenPair = {
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      expiresAt: Date.now() + (body.expiresIn ?? 3600) * 1000,
    };

    this.tokens.set(sessionId, pair);
    return pair;
  }
}
