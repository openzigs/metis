import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { renderInlineCode } from "@/lib/inline-code-text";

/**
 * Issue #985 (#3) — the inline-code tokenizer must render backtick spans as
 * `<code>` elements while treating everything else as inert text, including
 * adversarial input that never parses as HTML.
 */
describe("renderInlineCode", () => {
  it("renders plain text with no backticks unchanged", () => {
    const { container } = render(<p>{renderInlineCode("No code spans here.")}</p>);
    expect(container).toHaveTextContent("No code spans here.");
    expect(container.querySelector("code")).toBeNull();
  });

  it("renders a single backtick span as a <code> element", () => {
    const { container } = render(<p>{renderInlineCode("Touches the `orders` table.")}</p>);
    const code = container.querySelector("code");
    expect(code).not.toBeNull();
    expect(code).toHaveTextContent("orders");
    expect(container).toHaveTextContent("Touches the orders table.");
  });

  it("renders multiple backtick spans as separate <code> elements", () => {
    const { container } = render(
      <p>{renderInlineCode("Joins `orders` and `order_items` on order_id.")}</p>,
    );
    const codes = container.querySelectorAll("code");
    expect(codes).toHaveLength(2);
    expect(codes[0]).toHaveTextContent("orders");
    expect(codes[1]).toHaveTextContent("order_items");
  });

  // Adversarial: raw HTML/script injection, no backticks — must never become
  // a real DOM element. React only ever renders it as escaped text.
  it("renders an HTML/script injection attempt as inert text (no backticks)", () => {
    const payload = "<img src=x onerror=alert(1)>";
    const { container } = render(<p>{renderInlineCode(payload)}</p>);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container).toHaveTextContent(payload);
  });

  // Adversarial: the same injection attempt WRAPPED in backticks — must land
  // as the text content of a <code> element, never parsed as markup.
  it("renders an HTML/script injection attempt inside backticks as inert <code> text", () => {
    const payload = "<img src=x onerror=alert(1)>";
    const { container } = render(<p>{renderInlineCode(`` + "`" + payload + "`")}</p>);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    const code = container.querySelector("code");
    expect(code).not.toBeNull();
    expect(code).toHaveTextContent(payload);
  });

  it("leaves an unbalanced (single) backtick as literal text", () => {
    const { container } = render(<p>{renderInlineCode("The `orders table is broken")}</p>);
    expect(container.querySelector("code")).toBeNull();
    expect(container).toHaveTextContent("The `orders table is broken");
  });

  it("leaves an empty backtick pair as literal text (no code element)", () => {
    const { container } = render(<p>{renderInlineCode("Empty span: `` here.")}</p>);
    expect(container.querySelector("code")).toBeNull();
    expect(container).toHaveTextContent("Empty span: `` here.");
  });

  it("handles nested/adjacent backtick runs by re-pairing, without crashing or dropping content", () => {
    const { container } = render(<p>{renderInlineCode("`a `b` c`")}</p>);
    // With 3+ backtick runs the regex re-pairs adjacent backticks rather than
    // treating the whole span as one match, so the grouping is not naive
    // first-pair — but no exception is thrown and all characters survive as
    // text somewhere in the tree (nothing silently dropped).
    expect(container.textContent).toBe("a b c");
  });

  it("returns the original string when there is nothing to tokenize", () => {
    const nodes = renderInlineCode("plain");
    expect(nodes).toEqual(["plain"]);
  });
});
