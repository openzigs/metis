/**
 * #763 — the import form takes a vault secret, not only a pasted token.
 *
 * The #706 walkthrough could not run GitHub import: the form's only credential
 * was a plaintext "API token" input, and leaving it blank was refused even for a
 * public repository. The form now defaults to the same `${vault:label}` picker
 * the connector forms use, keeps pasting as an explicit alternative, and lets a
 * GitHub preview run with no credential at all (showing the server's warning).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeWrapper } from "./test-utils";

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useParams: () => ({ id: "proj-1" }),
    usePathname: () => "/projects/proj-1/import",
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
  };
});
vi.mock("@/lib/import-api", () => ({
  importApi: {
    listSources: vi.fn(),
    preview: vi.fn(),
    createSource: vi.fn(),
    runSource: vi.fn(),
    setSync: vi.fn(),
    deleteSource: vi.fn(),
  },
}));
vi.mock("@/hooks/use-import-progress", () => ({ useImportProgress: () => null }));
vi.mock("@/lib/vault-api", () => ({ vaultApi: { list: vi.fn() } }));

import { importApi } from "@/lib/import-api";
import { vaultApi } from "@/lib/vault-api";
import ImportPage from "@/app/(authed)/projects/[id]/import/page";

const preview = importApi.preview as unknown as ReturnType<typeof vi.fn>;
const createSource = importApi.createSource as unknown as ReturnType<typeof vi.fn>;

function renderPage() {
  const Wrapper = makeWrapper({ withAuth: false });
  render(
    <Wrapper>
      <ImportPage />
    </Wrapper>,
  );
}

async function fillGithubFilter(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Owner / org"), "miniflux");
  await user.type(screen.getByLabelText("Repository"), "v2");
}

beforeEach(() => {
  vi.mocked(importApi.listSources).mockResolvedValue([]);
  preview.mockReset();
  createSource.mockReset();
  vi.mocked(vaultApi.list).mockResolvedValue({
    items: [{ id: "v1", label: "github-flux-v2-sandbox", description: "" }],
  } as never);
});

describe("Import page — vault secret credential (#763)", () => {
  it("defaults to the vault picker and shows no plaintext token field", async () => {
    renderPage();
    expect(await screen.findByRole("radio", { name: "Vault secret" })).toBeChecked();
    expect(screen.queryByLabelText("API token")).not.toBeInTheDocument();
    expect(screen.getByText(/optional for a public repository/i)).toBeInTheDocument();
  });

  it("previews with the chosen vault secret as secretRef and no token", async () => {
    preview.mockResolvedValue({ source: "github", count: 0, sample: [], warnings: [] });
    const user = userEvent.setup();
    renderPage();
    await fillGithubFilter(user);
    await user.click(screen.getByRole("combobox", { name: "Vault secret" }));
    await user.click(await screen.findByRole("option", { name: /github-flux-v2-sandbox/ }));
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(preview).toHaveBeenCalled());
    const body = preview.mock.calls[0][1];
    expect(body.secretRef).toBe("${vault:github-flux-v2-sandbox}");
    expect(body.token).toBeUndefined();
  });

  it("sends a pasted token only when the user chooses to paste one", async () => {
    createSource.mockResolvedValue({ source: { id: "s" }, run: { id: "r" } });
    const user = userEvent.setup();
    renderPage();
    await fillGithubFilter(user);
    await user.click(screen.getByRole("radio", { name: "Paste a token" }));
    await user.type(screen.getByLabelText("API token"), "ghp_pasted");
    await user.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(createSource).toHaveBeenCalled());
    const body = createSource.mock.calls[0][1];
    expect(body.token).toBe("ghp_pasted");
    expect(body.secretRef).toBeUndefined();
  });

  it("previews a public repo with no credential and shows the server's warning", async () => {
    preview.mockResolvedValue({
      source: "github",
      count: 3,
      sample: [],
      warnings: ["No credential supplied: GitHub was read anonymously."],
    });
    const user = userEvent.setup();
    renderPage();
    await fillGithubFilter(user);
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/GitHub was read anonymously/);
    const body = preview.mock.calls[0][1];
    expect(body.secretRef).toBeUndefined();
    expect(body.token).toBeUndefined();
  });

  it("does not offer a credential for Jira, which reuses its stored connection", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.selectOptions(screen.getByLabelText("Source"), "jira");
    expect(screen.queryByRole("radio", { name: "Vault secret" })).not.toBeInTheDocument();
  });
});
