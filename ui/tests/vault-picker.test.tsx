/**
 * VaultPicker — issue #23: expanding "Source Repository" in the Create project
 * dialog logged React's "Encountered two children with the same key" warning.
 *
 * With an empty vault the picker rendered TWO items whose value was the custom
 * sentinel (the disabled "No vault entries found" row and the real "Enter
 * custom ref…" row). Radix mirrors every item into a hidden native <select>
 * keyed by value whenever the trigger sits inside a <form>, so the two rows
 * collided on every render.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VaultPicker } from "@/components/connectors/vault-picker";
import { makeWrapper } from "./test-utils";

vi.mock("@/lib/vault-api", () => ({ vaultApi: { list: vi.fn() } }));

import { vaultApi } from "@/lib/vault-api";

const list = vaultApi.list as unknown as ReturnType<typeof vi.fn>;
let consoleError: MockInstance<typeof console.error>;

beforeEach(() => {
  list.mockReset();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => consoleError.mockRestore());

function duplicateKeyWarnings(): unknown[][] {
  return consoleError.mock.calls.filter((args) =>
    args.some((a) => typeof a === "string" && a.includes("same key")),
  );
}

function renderInForm(value = "", onChange = vi.fn()) {
  const Wrapper = makeWrapper({ withAuth: false });
  render(
    <Wrapper>
      <form>
        <VaultPicker id="repoSecret" value={value} onChange={onChange} />
      </form>
    </Wrapper>,
  );
  return onChange;
}

describe("VaultPicker", () => {
  it("renders no duplicate React keys when the vault is empty (#23)", async () => {
    list.mockResolvedValue({ items: [] });
    renderInForm();
    await waitFor(() => expect(list).toHaveBeenCalled());
    await userEvent.setup().click(screen.getByRole("combobox"));
    expect(await screen.findByText("No vault entries found")).toBeInTheDocument();
    expect(duplicateKeyWarnings()).toEqual([]);
  });

  it("still offers custom entry with an empty vault and reveals the free-text input", async () => {
    list.mockResolvedValue({ items: [] });
    const user = userEvent.setup();
    const onChange = renderInForm();
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Enter custom ref…" }));
    const input = await screen.findByPlaceholderText("${vault:my-label}");
    await user.type(input, "x");
    expect(onChange).toHaveBeenCalledWith("x");
    expect(duplicateKeyWarnings()).toEqual([]);
  });

  it("formats a chosen vault entry as a ${vault:label} reference", async () => {
    list.mockResolvedValue({
      items: [{ id: "v1", label: "gh-pat", description: "GitHub token" }],
    });
    const user = userEvent.setup();
    const onChange = renderInForm();
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: /gh-pat/ }));
    expect(onChange).toHaveBeenCalledWith("${vault:gh-pat}");
    expect(screen.queryByText("No vault entries found")).not.toBeInTheDocument();
    expect(duplicateKeyWarnings()).toEqual([]);
  });

  it("shows a known ${vault:label} value as the selected entry without the free-text input", async () => {
    list.mockResolvedValue({ items: [{ id: "v1", label: "gh-pat", description: null }] });
    renderInForm("${vault:gh-pat}");
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveTextContent("gh-pat"));
    expect(screen.queryByPlaceholderText("${vault:my-label}")).not.toBeInTheDocument();
  });

  it("shows an unknown value in the free-text input", async () => {
    list.mockResolvedValue({ items: [{ id: "v1", label: "gh-pat", description: null }] });
    renderInForm("${vault:other}");
    expect(await screen.findByPlaceholderText("${vault:my-label}")).toHaveValue("${vault:other}");
  });

  it("switches from custom entry back to a vault entry", async () => {
    list.mockResolvedValue({ items: [{ id: "v1", label: "gh-pat", description: null }] });
    const user = userEvent.setup();
    const onChange = renderInForm();
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Enter custom ref…" }));
    expect(await screen.findByPlaceholderText("${vault:my-label}")).toBeInTheDocument();
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: /gh-pat/ }));
    expect(onChange).toHaveBeenLastCalledWith("${vault:gh-pat}");
  });
});
