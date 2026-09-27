/**
 * #268 — accessible primitives: Tabs (APG roving focus), Dialog (focus trap,
 * Escape, focus return), AlertDialog (replaces `window.confirm`).
 * #267 — semantic status Badge / Alert variants read from tokens, not the raw
 * Tailwind palette.
 *
 * Every test here was written to fail against the pre-change ui-kit: the old
 * hand-rolled Tabs had no key handler and no `aria-controls`, and there was no
 * AlertDialog export and no success/warning/info Badge variant.
 */
import * as React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  ConfirmDialog,
  Badge,
  Alert,
  badgeVariantClasses,
} from "../src/index";

function ThreeTabs(props: { onValueChange?: (v: string) => void }) {
  return (
    <Tabs defaultValue="one" onValueChange={props.onValueChange}>
      <TabsList aria-label="Sections">
        <TabsTrigger value="one">One</TabsTrigger>
        <TabsTrigger value="two">Two</TabsTrigger>
        <TabsTrigger value="three">Three</TabsTrigger>
      </TabsList>
      <TabsContent value="one">Panel one</TabsContent>
      <TabsContent value="two">Panel two</TabsContent>
      <TabsContent value="three">Panel three</TabsContent>
    </Tabs>
  );
}

describe("Tabs (#268, APG Tabs pattern)", () => {
  it("ArrowRight / ArrowLeft move focus AND selection, wrapping at the ends", async () => {
    const user = userEvent.setup();
    render(<ThreeTabs />);
    const [one, two, three] = screen.getAllByRole("tab");

    await user.click(one);
    expect(one).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    expect(two).toHaveFocus();
    expect(two).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Panel two");

    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(one).toHaveFocus(); // wrapped past "three"

    await user.keyboard("{ArrowLeft}");
    expect(three).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Panel three");
  });

  it("Home / End jump to the first / last tab", async () => {
    const user = userEvent.setup();
    render(<ThreeTabs />);
    const [one, , three] = screen.getAllByRole("tab");
    await user.click(one);
    await user.keyboard("{End}");
    expect(three).toHaveFocus();
    await user.keyboard("{Home}");
    expect(one).toHaveFocus();
  });

  it("the tablist is ONE tab stop: Tab enters on the selected tab, the next Tab leaves", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Before</button>
        <Tabs defaultValue="two">
          <TabsList aria-label="Sections">
            <TabsTrigger value="one">One</TabsTrigger>
            <TabsTrigger value="two">Two</TabsTrigger>
            <TabsTrigger value="three">Three</TabsTrigger>
          </TabsList>
          <TabsContent value="one">Panel one</TabsContent>
          <TabsContent value="two">Panel two</TabsContent>
          <TabsContent value="three">Panel three</TabsContent>
        </Tabs>
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Before" }));
    await user.tab();
    expect(screen.getByRole("tab", { name: "Two" })).toHaveFocus();
    await user.tab();
    // Not "Three": the unselected tabs are reachable only with the arrow keys.
    expect(screen.getByRole("tabpanel")).toHaveFocus();
  });

  it("links each tab to its panel with aria-controls / aria-labelledby", () => {
    render(<ThreeTabs />);
    const tab = screen.getByRole("tab", { name: "One" });
    const panel = screen.getByRole("tabpanel");
    expect(tab.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.getAttribute("aria-labelledby")).toBe(tab.id);
    expect(screen.getByRole("tablist")).toHaveAccessibleName("Sections");
  });

  it("supports a controlled value via value + onValueChange", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    function Controlled() {
      const [v, setV] = React.useState("a");
      return (
        <Tabs
          value={v}
          onValueChange={(next) => {
            onValueChange(next);
            setV(next);
          }}
        >
          <TabsList>
            <TabsTrigger value="a">A</TabsTrigger>
            <TabsTrigger value="b">B</TabsTrigger>
          </TabsList>
          <TabsContent value="a">Alpha</TabsContent>
          <TabsContent value="b">Beta</TabsContent>
        </Tabs>
      );
    }
    render(<Controlled />);
    await user.click(screen.getByRole("tab", { name: "B" }));
    expect(onValueChange).toHaveBeenCalledWith("b");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Beta");
  });
});

describe("Dialog (#268 — focus trap, Escape, focus return)", () => {
  function Harness({ onOpenChange }: { onOpenChange?: (o: boolean) => void }) {
    const [open, setOpen] = React.useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open
        </button>
        <Dialog
          open={open}
          onOpenChange={(o) => {
            onOpenChange?.(o);
            setOpen(o);
          }}
        >
          <DialogContent>
            <DialogTitle>Title</DialogTitle>
            <DialogDescription>Body</DialogDescription>
            <button type="button">Inside</button>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  it("traps Tab inside the dialog and closes on Escape, returning focus", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open" });
    await user.click(opener);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName("Title");
    for (let i = 0; i < 4; i += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("the built-in close button has an accessible name", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeInTheDocument();
  });
});

describe("AlertDialog (#268 — replaces window.confirm)", () => {
  function Confirm({ onConfirm }: { onConfirm: () => void }) {
    return (
      <AlertDialog defaultOpen>
        <AlertDialogContent>
          <AlertDialogTitle>Delete thing?</AlertDialogTitle>
          <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Delete</AlertDialogAction>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  it("renders role=alertdialog with a name and a description", async () => {
    render(<Confirm onConfirm={() => {}} />);
    const dlg = await screen.findByRole("alertdialog");
    expect(dlg).toHaveAccessibleName("Delete thing?");
    expect(dlg).toHaveAccessibleDescription("This cannot be undone.");
  });

  it("focuses Cancel first, so Enter never destroys by accident", async () => {
    render(<Confirm onConfirm={() => {}} />);
    await screen.findByRole("alertdialog");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("Escape dismisses without confirming", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Confirm onConfirm={onConfirm} />);
    await screen.findByRole("alertdialog");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("the action confirms and closes", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Confirm onConfirm={onConfirm} />);
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("the action is styled as destructive via the token", async () => {
    render(<Confirm onConfirm={() => {}} />);
    const action = await screen.findByRole("button", { name: "Delete" });
    expect(action.className).toContain("bg-destructive");
  });
});

describe("status variants read semantic tokens (#267)", () => {
  const PALETTE =
    /\b(?:bg|text|border)-(?:red|orange|amber|yellow|green|emerald|blue|sky|zinc|gray|slate)-\d{2,3}\b/;

  it.each(["success", "warning", "info"] as const)("Badge %s uses its own token", (variant) => {
    render(<Badge variant={variant}>{variant}</Badge>);
    const cls = screen.getByText(variant).className;
    expect(cls).toContain(`text-${variant}`);
    expect(cls).toContain(`bg-${variant}-muted`);
    expect(cls).not.toMatch(PALETTE);
    expect(badgeVariantClasses(variant)).toContain(`text-${variant}`);
  });

  it.each(["success", "warning", "info"] as const)("Alert %s uses its own token", (variant) => {
    render(<Alert variant={variant}>msg</Alert>);
    const cls = screen.getByRole("alert").className;
    expect(cls).toContain(`text-${variant}`);
    expect(cls).toContain(`bg-${variant}-muted`);
    expect(cls).not.toMatch(PALETTE);
  });
});

describe("ConfirmDialog (#268 — the window.confirm replacement)", () => {
  it("opens from its trigger, confirms, and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        title="Delete agent?"
        description="Delete agent researcher?"
        confirmLabel="Delete"
        onConfirm={onConfirm}
        trigger={<button type="button">Delete researcher</button>}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Delete researcher" });
    await user.click(trigger);
    const dlg = await screen.findByRole("alertdialog");
    expect(dlg).toHaveAccessibleName("Delete agent?");
    expect(dlg).toHaveAccessibleDescription("Delete agent researcher?");
    await user.click(within(dlg).getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("Cancel does not confirm", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        title="Delete?"
        onConfirm={onConfirm}
        trigger={<button type="button">Open</button>}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("can be controlled without a trigger, with a non-destructive action", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Restrict?"
        confirmLabel="Continue"
        confirmVariant="default"
        onConfirm={onConfirm}
      />,
    );
    const action = await screen.findByRole("button", { name: "Continue" });
    expect(action.className).not.toContain("bg-destructive");
    expect(action.className).toContain("bg-primary");
    await user.click(action);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
