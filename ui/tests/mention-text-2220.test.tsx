/**
 * #2220 — an `@mention` in a comment or a discussion message renders as a
 * mention, and never by parsing the message as HTML.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { renderMentions, splitMentions } from "@/lib/mention-text";
import { ChatMarkdown } from "@/components/chat/chat-markdown";

describe("splitMentions", () => {
  it("finds handles at the start, after spaces and punctuation", () => {
    expect(splitMentions("@ana and (@bo.b), thanks @AI.")).toEqual([
      { mention: "ana" },
      { text: " and (" },
      { mention: "bo.b" },
      { text: "), thanks " },
      { mention: "AI" },
      { text: "." },
    ]);
  });

  it("leaves an email address, a lone @ and plain text alone", () => {
    expect(splitMentions("mail ana@example.com @ now")).toEqual([
      { text: "mail ana@example.com @ now" },
    ]);
    expect(splitMentions("")).toEqual([]);
  });
});

describe("renderMentions", () => {
  it("marks each handle as a mention and keeps markup as text", () => {
    const { container } = render(<p>{renderMentions("Hi @priya <img src=x onerror=alert(1)>")}</p>);
    const chip = container.querySelector("[data-mention]");
    expect(chip).toHaveAttribute("data-mention", "priya");
    expect(chip).toHaveTextContent("@priya");
    expect(container.querySelector("img")).toBeNull();
    expect(container).toHaveTextContent("<img src=x onerror=alert(1)>");
  });
});

describe("ChatMarkdown with mentions", () => {
  it("marks handles in prose but not inside code or links, and only when asked", () => {
    const content = "Ping @ana about `@notme` and [@link](https://example.com).";
    const { container, rerender } = render(<ChatMarkdown content={content} mentions />);
    const chips = [...container.querySelectorAll("[data-mention]")];
    expect(chips.map((c) => c.getAttribute("data-mention"))).toEqual(["ana"]);
    expect(container.querySelector("code")).toHaveTextContent("@notme");

    rerender(<ChatMarkdown content={content} />);
    expect(container.querySelector("[data-mention]")).toBeNull();
  });
});
