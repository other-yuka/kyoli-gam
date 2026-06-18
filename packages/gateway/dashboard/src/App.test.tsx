// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, dashboardTestIds } from "./App";

const account = {
  id: "acct_codex_1",
  provider: "codex",
  kind: "oauth",
  name: "Codex Primary",
  enabled: true,
  credentialKeys: ["refreshToken"],
  metadata: {
    planType: "plus",
    email: "codex@example.com",
    cachedUsage: {
      five_hour: { utilization: 35, resets_at: "2026-05-15T05:00:00.000Z" },
      seven_day: { utilization: 52, resets_at: "2026-05-16T00:00:00.000Z" },
      seven_day_sonnet: null,
    },
    cachedUsageAt: "2026-05-15T00:00:00.000Z",
  },
  failureCount: 0,
  createdAt: "2026-05-15T00:00:00.000Z",
  updatedAt: "2026-05-15T00:00:00.000Z",
};

const defaultResponses = {
  health: { ok: true, service: "kyoli-gam", mode: "gateway", port: 2021 },
  status: {
    object: "account_status",
    data: [{
      provider: "codex",
      total: 1,
      ready: 1,
      rate_limited: 0,
      quota_exceeded: 0,
      auth_cooldown: 0,
      disabled: 0,
      reauth_required: 0,
      failed: 0,
    }],
  },
  accounts: { object: "list", data: [account] },
  logs: {
    object: "request_log_group_list",
    data: [{
      requestId: "req_1",
      provider: "codex",
      route: "/v1/responses",
      model: "openai/gpt-5.3-codex",
      sessionKey: "session_1",
      accountIds: ["acct_codex_1"],
      startedAt: "2026-05-15T00:00:00.000Z",
      completedAt: "2026-05-15T00:00:02.000Z",
      finalStatus: 200,
      retryCount: 0,
      events: [{
        id: 1,
        requestId: "req_1",
        provider: "codex",
        route: "/v1/responses",
        model: "openai/gpt-5.3-codex",
        sessionKey: "session_1",
        accountId: "acct_codex_1",
        eventType: "response",
        status: 200,
        createdAt: "2026-05-15T00:00:02.000Z",
      }],
    }],
  },
  sessions: {
    object: "list",
    data: [{
      key: "sticky:codex:session_1",
      provider: "codex",
      kind: "codex_session",
      sessionKey: "session_1",
      accountId: "acct_codex_1",
      createdAt: "2026-05-15T00:00:00.000Z",
      updatedAt: "2026-05-15T00:00:02.000Z",
    }],
  },
};

describe("Kyoli dashboard", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", createFetchMock());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the admin token prompt after a 401 admin response", async () => {
    vi.stubGlobal("fetch", createFetchMock({ unauthorized: true }));

    render(<App />);

    expect(await screen.findByTestId(dashboardTestIds.tokenPrompt)).toBeTruthy();
    expect(screen.getByLabelText("Admin token")).toBeTruthy();
  });

  it("renders provider summaries and account rows from admin data", async () => {
    render(<App />);

    expect(await screen.findByText("Command center")).toBeTruthy();
    expect(await screen.findByText("Traffic is ready to route")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Usage" })).toBeNull();
    expect(screen.getByText("Request signal")).toBeTruthy();
    expect(screen.getByText("Account pool health")).toBeTruthy();
    expect(screen.getByText("Quota coverage")).toBeTruthy();
    expect(screen.getByText("Account controls")).toBeTruthy();
    expect(screen.getAllByText("Codex")[0]).toBeTruthy();
    expect((await screen.findAllByText("Codex Primary")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("plus")[0]).toBeTruthy();
    expect(screen.getAllByText("65% left").length).toBeGreaterThan(0);
    expect(screen.getAllByText("48% left").length).toBeGreaterThan(0);
    expect(screen.getAllByText("/v1/responses").length).toBeGreaterThan(0);
    expect(screen.getByText("Codex follow-up")).toBeTruthy();
    expect(screen.getByText("Pinned account")).toBeTruthy();
  });

  it("shows all quota accounts with missing snapshot coverage", async () => {
    const responses = structuredClone(defaultResponses);
    const missingAccount = structuredClone(account) as typeof account & { metadata: Record<string, unknown> };
    missingAccount.id = "acct_codex_missing";
    missingAccount.name = "Codex Missing";
    const missingMetadata = missingAccount.metadata as Record<string, unknown>;
    delete missingMetadata.cachedUsage;
    delete missingMetadata.cachedUsageAt;
    responses.accounts.data = [
      ...Array.from({ length: 8 }, (_, index) => ({
        ...account,
        id: `acct_codex_quota_${index + 1}`,
        name: `Codex Quota ${index + 1}`,
        metadata: {
          ...account.metadata,
          cachedUsage: {
            five_hour: { utilization: 92, resets_at: "2026-05-15T05:00:00.000Z" },
            seven_day: { utilization: 20, resets_at: "2026-05-16T00:00:00.000Z" },
            seven_day_sonnet: null,
          },
          cachedUsageAt: "2026-05-15T00:00:00.000Z",
        },
      })),
      missingAccount,
    ];
    vi.stubGlobal("fetch", createFetchMock({ responses }));

    render(<App />);

    const heading = await screen.findByText("Quota coverage");
    const panel = heading.closest("article");
    expect(panel).toBeTruthy();
    expect(within(panel!).getByText("8/9")).toBeTruthy();
    expect(within(panel!).getByText("Quota 8")).toBeTruthy();
    expect(within(panel!).getAllByText("Missing").length).toBeGreaterThan(0);
    expect(within(panel!).getByText("No snapshot")).toBeTruthy();
  });

  it("uses a readable request label when stored logs are missing the route", async () => {
    const responses = structuredClone(defaultResponses);
    delete (responses.logs.data[0] as { route?: string }).route;
    delete (responses.logs.data[0].events[0] as { route?: string }).route;
    vi.stubGlobal("fetch", createFetchMock({ responses }));

    render(<App />);

    expect((await screen.findAllByText("Codex responses")).length).toBeGreaterThan(0);
    expect(screen.queryByText("unknown route")).toBeNull();
  });

  it("inherits the displayed model for Codex session follow-up logs", async () => {
    const responses = structuredClone(defaultResponses);
    responses.logs.data = [
      {
        requestId: "req_follow_up",
        provider: "codex",
        route: "/backend-api/codex/responses",
        sessionKey: "session_1",
        accountIds: ["acct_codex_1"],
        startedAt: "2026-05-15T00:00:03.000Z",
        completedAt: "2026-05-15T00:00:04.000Z",
        finalStatus: 200,
        retryCount: 0,
        events: [{
          id: 2,
          requestId: "req_follow_up",
          provider: "codex",
          route: "/backend-api/codex/responses",
          sessionKey: "session_1",
          accountId: "acct_codex_1",
          eventType: "response",
          status: 200,
          createdAt: "2026-05-15T00:00:04.000Z",
        }],
      },
      {
        ...responses.logs.data[0],
        model: "gpt-5.5",
        startedAt: "2026-05-15T00:00:00.000Z",
        completedAt: "2026-05-15T00:00:01.000Z",
      },
    ] as typeof responses.logs.data;
    vi.stubGlobal("fetch", createFetchMock({ responses }));

    render(<App />);

    expect((await screen.findAllByText("gpt-5.5")).length).toBeGreaterThan(0);
    expect(screen.queryByText("backend response sync")).toBeNull();
  });

  it("does not render metadata trace messages as request errors", async () => {
    const responses = structuredClone(defaultResponses);
    responses.logs.data = [{
      ...responses.logs.data[0],
      requestId: "req_ws",
      route: "/backend-api/codex/responses",
      model: "gpt-5.5",
      finalStatus: 101,
      events: [{
        id: 2,
        requestId: "req_ws",
        provider: "codex",
        route: "/backend-api/codex/responses",
        model: "gpt-5.5",
        sessionKey: "session_1",
        accountId: "acct_codex_1",
        eventType: "metadata",
        message: "WebSocket response.create model discovered after account selection.",
        createdAt: "2026-05-15T00:00:01.000Z",
      }],
    }] as unknown as typeof responses.logs.data;
    vi.stubGlobal("fetch", createFetchMock({ responses }));

    render(<App />);

    expect((await screen.findAllByText("gpt-5.5")).length).toBeGreaterThan(0);
    expect(screen.queryByText("WebSocket response.create model discovered after account selection.")).toBeNull();
  });

  it("opens the command palette with the keyboard shortcut and filters commands", async () => {
    render(<App />);
    await screen.findAllByText("Codex Primary");

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const dialog = screen.getByRole("dialog", { name: "Command palette" });
    expect(dialog).toBeTruthy();

    await userEvent.type(screen.getByLabelText("Search commands"), "Accounts");
    expect(within(dialog).getByRole("button", { name: /Accounts/i })).toBeTruthy();
  });

  it("runs account actions from the command palette after confirmation", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<App />);
    await screen.findAllByText("Codex Primary");

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await userEvent.type(screen.getByLabelText("Search commands"), "Pause Codex");
    await userEvent.click(await screen.findByRole("button", { name: /Pause Codex Primary/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/admin/accounts/acct_codex_1/pause",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("redeems Codex reset credits from the account table after confirmation", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<App />);
    await screen.findAllByText("Codex Primary");

    await userEvent.click(screen.getByRole("button", { name: "Redeem Codex reset credit" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/admin/accounts/acct_codex_1/codex-reset",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });
});

function createFetchMock(options: { unauthorized?: boolean; responses?: typeof defaultResponses } = {}) {
  const responses = options.responses ?? defaultResponses;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.pathname
        : input.url;
    const path = url.startsWith("http") ? new URL(url).pathname : url.split("?")[0] ?? url;

    if (options.unauthorized && path.startsWith("/admin/")) {
      return Response.json({ error: { message: "Admin API requires a valid bearer token." } }, { status: 401 });
    }
    if (path === "/health") return Response.json(responses.health);
    if (path === "/admin/accounts/status") return Response.json(responses.status);
    if (path === "/admin/accounts") return Response.json(responses.accounts);
    if (path === "/admin/request-logs") return Response.json(responses.logs);
    if (path === "/admin/sticky-sessions") return Response.json(responses.sessions);
    if (path === "/admin/accounts/acct_codex_1/pause" && init?.method === "POST") {
      return Response.json({ ...account, enabled: false });
    }
    if (path === "/admin/accounts/acct_codex_1/codex-reset" && init?.method === "POST") {
      return Response.json({
        object: "codex_reset_credit_redemption",
        account,
        consumed: true,
        credit: { id: "RateLimitResetCredit_test", status: "redeemed" },
        result: { code: "reset", windows_reset: 1 },
        usage_refresh: { ok: true },
      });
    }
    return Response.json({ error: { message: `Unhandled ${path}` } }, { status: 404 });
  });
}
