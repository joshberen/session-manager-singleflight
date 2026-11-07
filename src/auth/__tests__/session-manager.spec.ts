import { SessionManager, type RefreshTransport } from "../session-manager";

/**
 * Minimal JSON response shape the manager expects from the refresh endpoint.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("SessionManager.refreshToken single-flight", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("collapses two concurrent refreshes into one HTTP request (sequential resolution)", async () => {
    let resolveFirst!: (value: string) => void;
    const fetchMock = jest.spyOn(global, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFirst = (token: string) =>
            resolve(jsonResponse({ accessToken: token }));
        }) as Promise<Response>,
    );

    const manager = new SessionManager();
    const first = manager.refreshToken("sess-A");
    const second = manager.refreshToken("sess-A");

    // Both callers are waiting on the same underlying request.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFirst("token-1");
    await expect(first).resolves.toBe("token-1");
    await expect(second).resolves.toBe("token-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A later refresh after the flight settles must issue a new request.
    fetchMock.mockResolvedValueOnce(jsonResponse({ accessToken: "token-2" }));
    await expect(manager.refreshToken("sess-A")).resolves.toBe("token-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("propagates the first failure to every waiter without retrying", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(jsonResponse({ error: "invalid_grant" }, 401));

    const manager = new SessionManager();
    const first = manager.refreshToken("sess-B");
    const second = manager.refreshToken("sess-B");

    await expect(first).rejects.toThrow(/refresh failed: 401/);
    await expect(second).rejects.toThrow(/refresh failed: 401/);

    // The rejection state was reused: exactly one HTTP call, no retry storm.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("hands every waiter the identical token instance", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(jsonResponse({ accessToken: "shared-token" }));

    const manager = new SessionManager();
    const waiters = [
      manager.refreshToken("sess-C"),
      manager.refreshToken("sess-C"),
      manager.refreshToken("sess-C"),
    ];
    const tokens = await Promise.all(waiters);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tokens[0]).toBe(tokens[1]);
    expect(tokens[1]).toBe(tokens[2]);
  });

  it("keeps different sessions isolated", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockImplementation((_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        return Promise.resolve(
          jsonResponse({ accessToken: `token-for-${body.sessionId}` }),
        );
      });

    const manager = new SessionManager();
    const [a, b] = await Promise.all([
      manager.refreshToken("sess-X"),
      manager.refreshToken("sess-Y"),
    ]);

    expect(a).toBe("token-for-sess-X");
    expect(b).toBe("token-for-sess-Y");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not drop a newer in-flight request when an older flight settles late", async () => {
    let resolveOld!: (value: string) => void;
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveOld = (token: string) =>
              resolve(jsonResponse({ accessToken: token }));
          }) as Promise<Response>,
      )
      .mockResolvedValueOnce(jsonResponse({ accessToken: "token-new" }));

    const manager = new SessionManager();
    const oldFlight = manager.refreshToken("sess-D");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Simulate the bookkeeping edge: the tracked entry is replaced while the
    // first request is still open (e.g. an explicit invalidation from a
    // caller). The late settle must not delete the replacement.
    const replacement = Promise.resolve("replacement");
    (manager as unknown as { inflight: Map<string, Promise<string>> }).inflight.set(
      "sess-D",
      replacement,
    );

    resolveOld("token-old");
    await expect(oldFlight).resolves.toBe("token-old");
    expect(
      (manager as unknown as { inflight: Map<string, Promise<string>> }).inflight.get(
        "sess-D",
      ),
    ).toBe(replacement);

    await expect(manager.refreshToken("sess-D")).resolves.toBe("replacement");

    // Once the replacement is cleared, the next call issues a fresh request.
    (manager as unknown as { inflight: Map<string, Promise<string>> }).inflight.delete(
      "sess-D",
    );
    await expect(manager.refreshToken("sess-D")).resolves.toBe("token-new");
  });

  it("rejects when the refresh response carries no accessToken", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ ok: true }));

    const manager = new SessionManager();
    await expect(manager.refreshToken("sess-F")).rejects.toThrow(
      /no accessToken in response/,
    );
  });

  it("reports in-flight refreshes for diagnostics", async () => {
    let release!: (value: Response) => void;
    jest.spyOn(global, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }) as Promise<Response>,
    );

    const manager = new SessionManager();
    expect(manager.inFlightCount).toBe(0);
    const flight = manager.refreshToken("sess-G");
    expect(manager.inFlightCount).toBe(1);

    release(jsonResponse({ accessToken: "done" }));
    await expect(flight).resolves.toBe("done");
    expect(manager.inFlightCount).toBe(0);
  });

  it("uses the injected transport instead of global fetch when provided", async () => {
    const fetchMock = jest.spyOn(global, "fetch");
    const transport: RefreshTransport = jest.fn(async () => "from-transport");

    const manager = new SessionManager({ transport });
    await expect(manager.refreshToken("sess-E")).resolves.toBe("from-transport");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
