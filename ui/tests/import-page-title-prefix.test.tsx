/**
 * #1006 — Miniflux marks feature requests with a `[Feature]:` title prefix, not
 * a label, so the GitHub import form needs a title-prefix filter.
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

function renderPage() {
  const Wrapper = makeWrapper({ withAuth: false });
  render(
    <Wrapper>
      <ImportPage />
    </Wrapper>,
  );
}

beforeEach(() => {
  vi.mocked(importApi.listSources).mockResolvedValue([]);
  preview.mockReset();
  preview.mockResolvedValue({ source: "github", count: 0, sample: [], warnings: [] });
  vi.mocked(vaultApi.list).mockResolvedValue({ items: [] } as never);
});

describe("Import page — GitHub title-prefix filter (#1006)", () => {
  it("sends the comma-separated prefixes as titlePrefixes", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText("Owner / org"), "miniflux");
    await user.type(screen.getByLabelText("Repository"), "v2");
    // userEvent treats `[` as a key descriptor; paste the literal text instead.
    await user.click(screen.getByLabelText(/Title starts with/));
    await user.paste("[Feature]:, [Proposal]");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(preview).toHaveBeenCalled());
    expect(preview.mock.calls[0][1].filter.titlePrefixes).toEqual(["[Feature]:", "[Proposal]"]);
  });

  it("omits titlePrefixes when the field is empty", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText("Owner / org"), "miniflux");
    await user.type(screen.getByLabelText("Repository"), "v2");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(preview).toHaveBeenCalled());
    expect(preview.mock.calls[0][1].filter).not.toHaveProperty("titlePrefixes");
  });
});
