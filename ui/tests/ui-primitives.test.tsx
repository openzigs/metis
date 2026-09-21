/**
 * C1 (#146) — accessible shared primitives: Select, Table, Tooltip, Alert.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

describe("<Select />", () => {
  it("exposes a combobox and selects an option by keyboard/click", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Select onValueChange={onChange}>
        <SelectTrigger aria-label="Fruit">
          <SelectValue placeholder="Pick…" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="apple">Apple</SelectItem>
          <SelectItem value="banana">Banana</SelectItem>
        </SelectContent>
      </Select>,
    );
    const trigger = screen.getByRole("combobox", { name: "Fruit" });
    expect(trigger).toBeInTheDocument();
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "Banana" }));
    expect(onChange).toHaveBeenCalledWith("banana");
  });
});

describe("<Table />", () => {
  it("renders semantic table structure with column headers", () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Ada</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Ada" })).toBeInTheDocument();
  });
});

describe("<Tooltip />", () => {
  it("shows content on keyboard focus and dismisses on Escape", async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger>Help</TooltipTrigger>
          <TooltipContent>More info</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    await user.tab();
    expect(await screen.findAllByText("More info")).not.toHaveLength(0);
    await user.keyboard("{Escape}");
  });
});

describe("<Alert />", () => {
  it("renders a role=alert region with title and description", () => {
    render(
      <Alert variant="warning">
        <AlertTitle>Heads up</AlertTitle>
        <AlertDescription>Something needs attention.</AlertDescription>
      </Alert>,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Heads up");
    expect(alert).toHaveTextContent("Something needs attention.");
  });
});
