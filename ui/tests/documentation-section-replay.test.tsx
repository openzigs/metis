/**
 * #510 — a section completed during a socket outage appears on the
 * Documentation page after reconnect, without a refetch.
 *
 * Renders the page's real `DocListProgress` over the real `useJobLifecycle` /
 * `useDocSectionProgress` hooks and `joinJobRoom`, against a fake socket whose
 * "server" behaves like `server/src/lib/socket/server.ts`: it delivers to the
 * `job:{id}` room only while the socket is in it, a disconnect drops the room,
 * and `subscribe:job` replays the latest state of each section.
 */
import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { DocSectionProgressEvent } from "@metis/shared";
import { makeWrapper } from "./test-utils";

vi.mock("next/navigation", () => ({
  useParams: vi.fn(() => ({ id: "proj_test" })),
}));

vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(),
  ApiError: class extends Error {},
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/components/markdown-previewer", () => ({
  MarkdownPreviewer: () => null,
}));

type Handler = (data: unknown) => void;

/** A fake socket plus the slice of the server's room + replay behaviour it needs. */
function makeSocketAndServer() {
  const handlers = new Map<string, Set<Handler>>();
  const fire = (name: string, data: unknown) => handlers.get(name)?.forEach((fn) => fn(data));
  const rooms = new Set<string>();
  const remembered = new Map<string, DocSectionProgressEvent>();

  const socket = {
    connected: true,
    on: vi.fn((name: string, fn: Handler) => {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(fn);
    }),
    off: vi.fn((name: string, fn: Handler) => {
      handlers.get(name)?.delete(fn);
    }),
    emit: vi.fn((name: string, payload: { jobId: string }) => {
      if (!socket.connected) return;
      if (name === "subscribe:job") {
        rooms.add(payload.jobId);
        for (const s of remembered.values()) {
          if (s.jobId === payload.jobId) fire("job:doc-section", s);
        }
      }
      if (name === "unsubscribe:job") rooms.delete(payload.jobId);
    }),
  };

  const server = {
    /** `jobEvents.docSection`: remember, then deliver to the room if joined. */
    docSection(event: DocSectionProgressEvent) {
      remembered.set(`${event.jobId}/${event.section}`, event);
      if (rooms.has(event.jobId)) fire("job:doc-section", event);
    },
    drop() {
      rooms.clear();
      socket.connected = false;
      fire("disconnect", "transport close");
    },
    reconnect() {
      socket.connected = true;
      fire("connect", undefined);
    },
  };
  return { socket, server };
}

let current = makeSocketAndServer();

vi.mock("@/lib/socket-client", () => ({
  useSocket: () => current.socket,
}));

import { apiFetch } from "@/lib/api-client";
import { DocListProgress } from "@/app/(authed)/projects/[id]/documentation/page";

const section = (name: string, index: number): DocSectionProgressEvent => ({
  jobId: "doc-1",
  projectId: "proj_test",
  section: name,
  status: "done",
  index,
  total: 2,
  ts: index,
});

describe("Documentation list progress across a socket outage (#510)", () => {
  it("shows a section completed during the outage after reconnect, with no refetch", () => {
    current = makeSocketAndServer();
    const { server } = current;
    const Wrapper = makeWrapper({ withAuth: false });
    render(
      <Wrapper>
        <DocListProgress docId="doc-1" />
      </Wrapper>,
    );

    act(() => server.docSection(section("Overview", 1)));
    const counter = screen.getByTestId("doc-list-progress-counter-doc-1");
    expect(counter.textContent).toBe("1 of 2 sections");

    // The second section finishes while the socket is down: nobody is in the room.
    act(() => server.drop());
    act(() => server.docSection(section("Risks", 2)));
    expect(counter.textContent).toBe("1 of 2 sections");

    // The reconnect re-joins the room and the server replays the sections.
    act(() => server.reconnect());
    expect(counter.textContent).toBe("2 of 2 sections");
    expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
  });
});
