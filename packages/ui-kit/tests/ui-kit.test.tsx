/**
 * C2 (#155) — smoke tests proving the promoted primitives are consumable from
 * the @metis/ui-kit package entry point.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  Button,
  Badge,
  Alert,
  AlertTitle,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableRow,
  cn,
} from "../src/index";
import { buttonVariants } from "../src/components/button";

describe("@metis/ui-kit barrel", () => {
  it("re-exports the cn helper", () => {
    expect(cn("a", false && "b", "c")).toContain("a");
    expect(cn("a", "c")).toContain("c");
  });

  it("renders the Button primitive", () => {
    render(<Button>Click</Button>);
    expect(screen.getByRole("button", { name: "Click" })).toBeInTheDocument();
  });

  it("Button exposes a visible keyboard focus ring (A2 #150)", () => {
    render(<Button>Focus</Button>);
    const btn = screen.getByRole("button", { name: "Focus" });
    expect(btn.className).toContain("focus-visible:ring-2");
    expect(btn.className).toContain("focus-visible:ring-ring");
  });

  it("icon Button guards its hit target against flex collapse (WCAG 2.2 SC 2.5.8, #150)", () => {
    const cls = buttonVariants({ size: "icon" });
    // shrink-0 prevents a crowded flex row from compressing the target, and the
    // min-h/min-w floor keeps it from collapsing below the 24px AA minimum.
    expect(cls).toContain("shrink-0");
    expect(cls).toContain("min-h-10");
    expect(cls).toContain("min-w-10");
  });

  it("renders the Badge primitive", () => {
    render(<Badge>New</Badge>);
    expect(screen.getByText("New")).toBeInTheDocument();
  });

  it("renders the Alert primitive with role=alert", () => {
    render(
      <Alert variant="info">
        <AlertTitle>Note</AlertTitle>
      </Alert>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Note");
  });

  it("renders Skeleton and Table primitives", () => {
    render(
      <>
        <Skeleton className="h-4 w-4" data-testid="sk" />
        <Table>
          <TableBody>
            <TableRow>
              <TableCell>cell</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </>,
    );
    expect(screen.getByTestId("sk")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "cell" })).toBeInTheDocument();
  });
});
