/**
 * Tests for the DB connector wizard — Epic #701 / Issue #705.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const getMock = vi.fn();
const testMock = vi.fn();
const provisionMock = vi.fn();

vi.mock("@/lib/connectors-api", () => ({
  suggestedConnectorsApi: {
    get: (...args: unknown[]) => getMock(...args),
    test: (...args: unknown[]) => testMock(...args),
    provision: (...args: unknown[]) => provisionMock(...args),
  },
}));

import { DbConnectorWizard } from "@/components/connectors/db-connector-wizard";
import type { SuggestedConnector } from "@/lib/connectors-api";

const suggestion: SuggestedConnector = {
  id: "sug_1",
  projectId: "proj_1",
  driverType: "postgresql",
  host: "db.example.com",
  port: 5432,
  database: "appdb",
  status: "pending",
  confidence: "high",
  sourceFile: ".env.development",
  lineNumber: 3,
  username: "appuser",
  devCredsDetected: true,
  credentialSourceFile: ".env.development",
  hasStoredPassword: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const detail = {
  ...suggestion,
  password: "s3cret",
};

function renderWizard(overrides: Partial<React.ComponentProps<typeof DbConnectorWizard>> = {}) {
  const onOpenChange = vi.fn();
  const onProvisioned = vi.fn();
  const utils = render(
    <DbConnectorWizard
      projectId="proj_1"
      suggestion={suggestion}
      open
      onOpenChange={onOpenChange}
      onProvisioned={onProvisioned}
      {...overrides}
    />,
  );
  return { ...utils, onOpenChange, onProvisioned };
}

/**
 * Click the single visible "Next" button once it is ENABLED.
 *
 * The review and configure steps disable Next while `loadingDetail` is true
 * (db-connector-wizard.tsx). Waiting only for `getMock` to have been *called*
 * confirms the async detail fetch started, not that it resolved — so a click
 * fired then lands on a still-disabled button and is a no-op, leaving the
 * wizard stuck on the current step. That race was the source of intermittent
 * "Unable to find ... Password / Run test" failures in CI. Gating the click on
 * the button actually being enabled makes the advance deterministic.
 */
async function clickNext() {
  const next = screen.getByRole("button", { name: "Next" }) as HTMLButtonElement;
  await waitFor(() => expect(next.disabled).toBe(false));
  fireEvent.click(next);
}

beforeEach(() => {
  getMock.mockReset();
  testMock.mockReset();
  provisionMock.mockReset();
  getMock.mockResolvedValue(detail);
});

describe("DbConnectorWizard", () => {
  it("renders review step with discovered details", async () => {
    renderWizard();
    expect(screen.getByTestId("wizard-review")).toBeDefined();
    expect(screen.getByText("postgresql")).toBeDefined();
    expect(screen.getByText("db.example.com:5432")).toBeDefined();
  });

  it("loads detail and pre-fills the configure step", async () => {
    renderWizard();
    await waitFor(() => expect(getMock).toHaveBeenCalledWith("proj_1", "sug_1"));
    await clickNext();
    expect(await screen.findByTestId("wizard-configure")).toBeDefined();
    const host = (await screen.findByLabelText("Host")) as HTMLInputElement;
    const password = (await screen.findByLabelText("Password")) as HTMLInputElement;
    expect(host.value).toBe("db.example.com");
    expect(password.value).toBe("s3cret");
    expect(password.type).toBe("password");
  });

  it("toggles password visibility via the eye button", async () => {
    renderWizard();
    await clickNext(); // → configure
    const password = (await screen.findByLabelText("Password")) as HTMLInputElement;
    expect(password.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(password.type).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(password.type).toBe("password");
  });

  it("does not advance to provision when the test fails", async () => {
    testMock.mockResolvedValue({ ok: false, errorMessage: "timeout" });
    renderWizard();
    await clickNext(); // → configure
    await clickNext(); // → test
    fireEvent.click(await screen.findByRole("button", { name: "Run test" }));
    await waitFor(() => expect(testMock).toHaveBeenCalled());
    // The error message renders in a state update AFTER the test call resolves,
    // so query for it with findBy (retries) rather than a synchronous getByText
    // — the latter races on slower runners (flaked on the Linux/WSL2 runner).
    expect(await screen.findByText(/timeout/)).toBeDefined();
    expect(screen.getByTestId("wizard-test")).toBeDefined();
    expect(screen.queryByTestId("wizard-provision")).toBeNull();
  });

  it("advances to provision on test success and provisions on click", async () => {
    testMock.mockResolvedValue({ ok: true, latencyMs: 12 });
    provisionMock.mockResolvedValue({ connectorId: "db_42" });
    const { onOpenChange, onProvisioned } = renderWizard();
    await clickNext(); // → configure
    await clickNext(); // → test
    fireEvent.click(await screen.findByRole("button", { name: "Run test" }));
    await waitFor(() => expect(screen.getByTestId("wizard-provision")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Provision" }));
    await waitFor(() => expect(provisionMock).toHaveBeenCalled());
    expect(onProvisioned).toHaveBeenCalledWith("db_42");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("surfaces a provision error and stays on the provision step", async () => {
    testMock.mockResolvedValue({ ok: true, latencyMs: 5 });
    provisionMock.mockRejectedValue(new Error("vault rotate failed"));
    renderWizard();
    await clickNext(); // → configure
    await clickNext(); // → test
    fireEvent.click(await screen.findByRole("button", { name: "Run test" }));
    await waitFor(() => expect(screen.getByTestId("wizard-provision")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Provision" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("vault rotate"));
    expect(screen.getByTestId("wizard-provision")).toBeDefined();
  });
});
