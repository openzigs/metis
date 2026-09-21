/**
 * WCAG 2.1 SC 1.3.5 Identify Input Purpose (#659) — Jira connection page.
 *
 * The Jira connection form's user field is the person's Atlassian login: their
 * account email on Jira Cloud, their username on Data Center. It must carry the
 * matching H98 autocomplete purpose token, switching with the edition. The
 * sibling token field is a service credential (API token / PAT), not the user's
 * identity, and must OMIT autocomplete so a browser never autofills identity
 * data into a secret.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
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
    listProjects: vi.fn(),
    search: vi.fn(),
    getIssue: vi.fn(),
  },
}));

vi.mock("@/lib/jira-api", () => ({
  jiraApi: api,
}));

import JiraPage from "@/app/(authed)/projects/[id]/jira/page";

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <JiraPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.values(api).forEach((m) => (m as ReturnType<typeof vi.fn>).mockReset());
  api.list.mockResolvedValue([]);
});

describe("JiraPage autocomplete purpose tokens", () => {
  it("tags the login field by edition and omits the token on the secret", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByTestId("add-jira-connection"));

    // Default edition is Cloud → the login field is the person's email.
    const userInput = screen.getByLabelText("Email");
    expect(userInput).toHaveAttribute("autocomplete", "email");

    // The API token is a service secret → autocomplete must be absent.
    expect(screen.getByLabelText("API Token")).not.toHaveAttribute("autocomplete");

    // Switch to Data Center → the login field becomes a username.
    await user.selectOptions(screen.getByLabelText("Edition"), "datacenter");
    expect(screen.getByLabelText("Username")).toHaveAttribute("autocomplete", "username");
  });
});
