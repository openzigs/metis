/**
 * Tests for the Test Management Connections page (Issue #871 UI surface).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "p1" }),
}));

const { api } = vi.hoisted(() => ({
  api: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    test: vi.fn(),
  },
}));

vi.mock("@/lib/test-management-api", () => ({
  testManagementApi: api,
}));

import ConnectionsPage from "@/app/(authed)/projects/[id]/test-coverage/connections/page";

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ConnectionsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.values(api).forEach((m) => (m as ReturnType<typeof vi.fn>).mockReset());
  api.list.mockResolvedValue([]);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("TestManagementConnectionsPage", () => {
  it("renders empty state when no connections exist", async () => {
    renderPage();
    expect(await screen.findByTestId("tmc-empty")).toBeInTheDocument();
    expect(screen.getByTestId("tmc-add")).toBeInTheDocument();
  });

  it("toggling kind hides/shows the right credential fields", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("tmc-add"));

    // Default kind is testrail
    expect(screen.getByTestId("tmc-email")).toBeInTheDocument();
    expect(screen.getByTestId("tmc-apiKey")).toBeInTheDocument();
    expect(screen.queryByTestId("tmc-clientId")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tmc-bearerToken")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByTestId("tmc-kind"), "xray");
    expect(screen.getByTestId("tmc-clientId")).toBeInTheDocument();
    expect(screen.getByTestId("tmc-clientSecret")).toBeInTheDocument();
    expect(screen.queryByTestId("tmc-email")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tmc-bearerToken")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByTestId("tmc-kind"), "zephyr");
    expect(screen.getByTestId("tmc-bearerToken")).toBeInTheDocument();
    expect(screen.queryByTestId("tmc-clientId")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tmc-email")).not.toBeInTheDocument();
  });

  it("submitting calls create with kind-specific auth payload", async () => {
    api.create.mockResolvedValue({ id: "c1" });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("tmc-add"));

    await user.type(screen.getByTestId("tmc-label"), "Prod TR");
    await user.type(screen.getByTestId("tmc-baseUrl"), "https://example.testrail.io");
    await user.type(screen.getByTestId("tmc-email"), "u@x.com");
    await user.type(screen.getByTestId("tmc-apiKey"), "secret");
    await user.click(screen.getByTestId("tmc-submit"));

    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
    expect(api.create).toHaveBeenLastCalledWith("p1", {
      label: "Prod TR",
      kind: "testrail",
      baseUrl: "https://example.testrail.io",
      auth: { kind: "testrail", email: "u@x.com", apiKey: "secret" },
    });
  });

  // SC 3.3.3 (#663). The TestRail login email shows an ADVISORY "did you mean…"
  // hint for a domain typo but must NOT block submission of a well-formed
  // address — the entered value is still sent as typed.
  it("shows an advisory email hint for a domain typo but still submits (#663)", async () => {
    api.create.mockResolvedValue({ id: "c1" });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("tmc-add"));

    await user.type(screen.getByTestId("tmc-label"), "Prod TR");
    await user.type(screen.getByTestId("tmc-baseUrl"), "https://example.testrail.io");
    await user.type(screen.getByTestId("tmc-email"), "user@gmial.com");
    await user.type(screen.getByTestId("tmc-apiKey"), "secret");
    expect(await screen.findByTestId("tmc-email-hint")).toHaveTextContent(
      /did you mean “user@gmail\.com”/i,
    );

    await user.click(screen.getByTestId("tmc-submit"));
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
    expect(api.create).toHaveBeenLastCalledWith("p1", {
      label: "Prod TR",
      kind: "testrail",
      baseUrl: "https://example.testrail.io",
      auth: { kind: "testrail", email: "user@gmial.com", apiKey: "secret" },
    });
  });

  // Also verify a valid-but-uncommon domain (mail.com) is accepted with NO
  // advisory hint suppressing submission (SC 3.3.3 advisory-not-blocking).
  it("accepts a valid-but-uncommon TestRail email domain without blocking (#663)", async () => {
    api.create.mockResolvedValue({ id: "c1" });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("tmc-add"));

    await user.type(screen.getByTestId("tmc-label"), "Prod TR");
    await user.type(screen.getByTestId("tmc-baseUrl"), "https://example.testrail.io");
    await user.type(screen.getByTestId("tmc-email"), "user@mail.com");
    await user.type(screen.getByTestId("tmc-apiKey"), "secret");
    await user.click(screen.getByTestId("tmc-submit"));

    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
    expect(api.create).toHaveBeenLastCalledWith("p1", {
      label: "Prod TR",
      kind: "testrail",
      baseUrl: "https://example.testrail.io",
      auth: { kind: "testrail", email: "user@mail.com", apiKey: "secret" },
    });
  });

  // WCAG 2.1 SC 1.3.5 Identify Input Purpose (#659). The TestRail credential
  // Email field collects information ABOUT THE USER (the person's email used to
  // authenticate), so it carries the H98 `email` purpose token. The sibling
  // credential fields (base URL, label, API key) are NOT user info and must
  // correctly OMIT autocomplete so a browser never autofills identity data into
  // a service-connection secret.
  it("labels the TestRail email input with autocomplete=email and omits it on non-user fields", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("tmc-add"));

    // User-info credential → correct H98 purpose token.
    expect(screen.getByTestId("tmc-email")).toHaveAttribute("autocomplete", "email");

    // Non-user-info fields → autocomplete must be absent (not slapped on).
    expect(screen.getByTestId("tmc-label")).not.toHaveAttribute("autocomplete");
    expect(screen.getByTestId("tmc-baseUrl")).not.toHaveAttribute("autocomplete");
    expect(screen.getByTestId("tmc-apiKey")).not.toHaveAttribute("autocomplete");
  });

  it("shows validation error when required fields are missing", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("tmc-add"));
    await user.click(screen.getByTestId("tmc-submit"));
    expect(await screen.findByTestId("tmc-form-error")).toBeInTheDocument();
    expect(api.create).not.toHaveBeenCalled();
  });

  it("lists rows, runs Test, and surfaces the result", async () => {
    api.list.mockResolvedValue([
      {
        id: "c1",
        projectId: "p1",
        label: "Prod TR",
        kind: "testrail",
        baseUrl: "https://example.testrail.io",
        authConfig: { email: "u@x.com", apiKey: "${vault:tr-c1-apikey}" },
        proxyConfig: null,
        tlsConfig: null,
        status: "untested",
        errorMessage: null,
        lastTestedAt: null,
        createdById: "u1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    api.test.mockResolvedValue({ ok: true, latencyMs: 42 });

    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByTestId("tmc-row-c1")).toBeInTheDocument();
    expect(screen.getByTestId("tmc-row-label-c1")).toHaveTextContent("Prod TR");

    await user.click(screen.getByTestId("tmc-test-c1"));
    await waitFor(() => expect(api.test).toHaveBeenCalledWith("c1"));
    expect(await screen.findByTestId("tmc-test-result-c1")).toHaveTextContent("OK");
  });

  it("delete confirms and calls remove", async () => {
    api.list.mockResolvedValue([
      {
        id: "c1",
        projectId: "p1",
        label: "Prod TR",
        kind: "testrail",
        baseUrl: "https://example.testrail.io",
        authConfig: {},
        proxyConfig: null,
        tlsConfig: null,
        status: "untested",
        errorMessage: null,
        lastTestedAt: null,
        createdById: "u1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    api.remove.mockResolvedValue(undefined);

    const user = userEvent.setup();
    renderPage();

    const del = await screen.findByTestId("tmc-delete-c1");
    await user.click(del);
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith("c1"));
  });

  it("validates xray-specific required fields", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("tmc-add"));
    await user.selectOptions(screen.getByTestId("tmc-kind"), "xray");
    await user.type(screen.getByTestId("tmc-label"), "L");
    await user.type(screen.getByTestId("tmc-baseUrl"), "https://x.example.com");
    await user.click(screen.getByTestId("tmc-submit"));
    expect(await screen.findByTestId("tmc-form-error")).toHaveTextContent("Xray");
    expect(api.create).not.toHaveBeenCalled();
  });

  it("validates zephyr-specific required fields", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("tmc-add"));
    await user.selectOptions(screen.getByTestId("tmc-kind"), "zephyr");
    await user.type(screen.getByTestId("tmc-label"), "L");
    await user.type(screen.getByTestId("tmc-baseUrl"), "https://z.example.com");
    await user.click(screen.getByTestId("tmc-submit"));
    expect(await screen.findByTestId("tmc-form-error")).toHaveTextContent("Zephyr");
  });

  it("surfaces create errors in the form-error region", async () => {
    api.create.mockRejectedValue(new Error("server boom"));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("tmc-add"));
    await user.type(screen.getByTestId("tmc-label"), "X");
    await user.type(screen.getByTestId("tmc-baseUrl"), "https://x.testrail.io");
    await user.type(screen.getByTestId("tmc-email"), "u@x.com");
    await user.type(screen.getByTestId("tmc-apiKey"), "k");
    await user.click(screen.getByTestId("tmc-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("tmc-form-error")).toHaveTextContent("server boom"),
    );
  });

  it("surfaces Test connection failures", async () => {
    api.list.mockResolvedValue([
      {
        id: "c1",
        projectId: "p1",
        label: "Bad",
        kind: "testrail",
        baseUrl: "https://example.testrail.io",
        authConfig: {},
        proxyConfig: null,
        tlsConfig: null,
        status: "error",
        errorMessage: "auth failed",
        lastTestedAt: null,
        createdById: "u1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    api.test.mockResolvedValue({
      ok: false,
      latencyMs: 12,
      errorMessage: "401 Unauthorized",
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("tmc-test-c1"));
    await waitFor(() => expect(screen.getByTestId("tmc-test-result-c1")).toHaveTextContent("401"));
  });

  it("hides Add form on Cancel", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("tmc-add"));
    expect(screen.getByTestId("tmc-add-form")).toBeInTheDocument();
    await user.click(screen.getByTestId("tmc-cancel"));
    expect(screen.queryByTestId("tmc-add-form")).not.toBeInTheDocument();
  });

  it("renders the back-to-test-coverage link", async () => {
    renderPage();
    const link = await screen.findByTestId("tmc-back-to-coverage");
    expect(link).toHaveAttribute("href", "/projects/p1/test-coverage");
  });

  it("does not call remove if user cancels the confirm dialog", async () => {
    vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    api.list.mockResolvedValue([
      {
        id: "c1",
        projectId: "p1",
        label: "X",
        kind: "testrail",
        baseUrl: "https://x.testrail.io",
        authConfig: {},
        proxyConfig: null,
        tlsConfig: null,
        status: "untested",
        errorMessage: null,
        lastTestedAt: null,
        createdById: "u1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("tmc-delete-c1"));
    expect(api.remove).not.toHaveBeenCalled();
  });

  it("captures network errors from Test via onError", async () => {
    api.list.mockResolvedValue([
      {
        id: "c1",
        projectId: "p1",
        label: "X",
        kind: "testrail",
        baseUrl: "https://x.testrail.io",
        authConfig: {},
        proxyConfig: null,
        tlsConfig: null,
        status: "untested",
        errorMessage: null,
        lastTestedAt: null,
        createdById: "u1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    api.test.mockRejectedValueOnce(new Error("network down"));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("tmc-test-c1"));
    await waitFor(() =>
      expect(screen.getByTestId("tmc-test-result-c1")).toHaveTextContent("network down"),
    );
  });

  it("shows the last persisted errorMessage on a row when no fresh test result exists", async () => {
    api.list.mockResolvedValue([
      {
        id: "c1",
        projectId: "p1",
        label: "Stale",
        kind: "testrail",
        baseUrl: "https://x.testrail.io",
        authConfig: {},
        proxyConfig: null,
        tlsConfig: null,
        status: "error",
        errorMessage: "stale: 500",
        lastTestedAt: new Date().toISOString(),
        createdById: "u1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText(/stale: 500/)).toBeInTheDocument());
  });
});
