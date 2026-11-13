/**
 * #2343 — a job the analyst started ends in ONE toast and ONE bell item that
 * name it and land on the result, wherever they are in the app: success,
 * failure and "waiting for review"; no duplicate on a re-delivery, a reconnect
 * hydrate, or with a second tab; and the job's own `job:lifecycle` toast is
 * rewritten in place rather than joined by a second.
 *
 * The real store, mappers and toast module run; the socket, the API and
 * sonner are stand-ins.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { JobLifecycleEvent, JobNotificationEvent } from "@metis/shared";
import { makeWrapper } from "./test-utils";
import { createFakeSocket, type FakeSocket } from "./helpers/fake-socket";

const toastIds = vi.hoisted(() => ({ next: 0 }));
vi.mock("sonner", () => {
  const show = () => vi.fn(() => `t-${++toastIds.next}`);
  return { toast: { success: show(), error: show(), warning: show() } };
});

let socket: FakeSocket;
vi.mock("@/lib/socket-client", () => ({
  closeSocket: vi.fn(),
  useSocket: () => socket,
}));

const mockApiFetch = vi.fn();
vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch: (...args: unknown[]) => mockApiFetch(...args) };
});

import { toast } from "sonner";
import { NotificationsDrawer } from "@/components/notifications/notifications-drawer";
import {
  _resetNotificationStoreForTests,
  getNotificationStore,
  jobEventToNotification,
} from "@/lib/notifications";
import {
  CROSS_TAB_CLAIM_PREFIX,
  __resetTerminalToastsForTests,
  fireJobNotificationToast,
  fireTerminalToast,
  setTerminalToastNavigator,
} from "@/lib/terminal-toast";

function jobEvent(over: Partial<JobNotificationEvent> = {}): JobNotificationEvent {
  return {
    notificationId: "n-job-1",
    kind: "job_completed",
    jobKind: "analysis",
    jobId: "an-1",
    projectId: "p-1",
    subject: "Checkout redesign",
    title: 'Change request "Checkout redesign" is ready',
    message: "Questions waiting (3): open the change request to answer them.",
    href: "/projects/p-1/analysis?analysisId=an-1",
    ts: 1,
    ...over,
  };
}

const lifecycle = (over: Partial<JobLifecycleEvent> = {}): JobLifecycleEvent => ({
  kind: "analysis",
  jobId: "an-1",
  projectId: "p-1",
  status: "completed",
  message: "Analysis complete",
  ts: 1,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  toastIds.next = 0;
  __resetTerminalToastsForTests();
  _resetNotificationStoreForTests();
  socket = createFakeSocket();
  mockApiFetch.mockResolvedValue({ notifications: [] });
});

function renderDrawer() {
  const Wrapper = makeWrapper({});
  return render(
    <Wrapper>
      <NotificationsDrawer />
    </Wrapper>,
  );
}

describe("job notifications in the drawer (#2343)", () => {
  it("one completion: one bell item that lands on the change request, and one toast", async () => {
    renderDrawer();
    act(() => socket.fire("job:notification", jobEvent()));
    act(() => socket.fire("job:notification", jobEvent())); // re-delivery
    expect(getNotificationStore().list()).toHaveLength(1);
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith(
      'Change request "Checkout redesign" is ready',
      expect.objectContaining({
        description: "Questions waiting (3): open the change request to answer them.",
        action: expect.objectContaining({ label: "Open" }),
      }),
    );

    fireEvent.click(screen.getByTestId("notifications-bell"));
    const item = await screen.findByTestId("notification-n-job-1");
    expect(item).toHaveTextContent('Change request "Checkout redesign" is ready');
    expect(item.querySelector("a")).toHaveAttribute(
      "href",
      "/projects/p-1/analysis?analysisId=an-1",
    );
  });

  it("a reconnect hydrate merges the saved row by id: still one bell item", async () => {
    renderDrawer();
    act(() => socket.fire("job:notification", jobEvent()));
    getNotificationStore().hydrate([
      {
        id: "n-job-1",
        type: "job_completed",
        title: 'Change request "Checkout redesign" is ready',
        message: "m",
        href: "/projects/p-1/analysis?analysisId=an-1",
        read: false,
        createdAt: new Date().toISOString(),
      },
    ]);
    expect(getNotificationStore().list()).toHaveLength(1);
  });

  it("a failure says so in plain words, as an error toast and a warning bell item", () => {
    renderDrawer();
    act(() =>
      socket.fire(
        "job:notification",
        jobEvent({
          kind: "job_failed",
          title: 'Change request "Checkout redesign" failed',
          message: "The analysis failed. Open the change request to see why and start it again.",
        }),
      ),
    );
    expect(toast.error).toHaveBeenCalledWith(
      'Change request "Checkout redesign" failed',
      expect.objectContaining({ description: expect.stringMatching(/failed/) }),
    );
    expect(getNotificationStore().list()[0]).toMatchObject({ level: "warn", source: "job_failed" });
  });

  it("a document held in quarantine is a warning that lands on the quarantine queue", () => {
    const draft = jobEventToNotification(
      jobEvent({
        kind: "job_awaiting_review",
        jobKind: "document-ingest",
        href: "/projects/p-1/settings#quarantine",
      }),
    );
    expect(draft).toMatchObject({ level: "warn", href: "/projects/p-1/settings#quarantine" });
    fireJobNotificationToast(jobEvent({ kind: "job_awaiting_review", jobId: "d-1" }));
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });
});

describe("fireJobNotificationToast (#2343)", () => {
  it("rewrites the job's lifecycle toast in place instead of adding a second", () => {
    expect(fireTerminalToast(lifecycle())).toBe(true);
    expect(toast.success).toHaveBeenCalledWith("Analysis complete");
    expect(fireJobNotificationToast(jobEvent())).toBe(true);
    expect(toast.success).toHaveBeenCalledTimes(2);
    expect(toast.success).toHaveBeenLastCalledWith(
      'Change request "Checkout redesign" is ready',
      expect.objectContaining({ id: "t-1" }),
    );
  });

  it("the Open action navigates through the registered router", () => {
    const go = vi.fn();
    setTerminalToastNavigator(go);
    fireJobNotificationToast(jobEvent());
    const options = vi.mocked(toast.success).mock.calls[0][1] as unknown as {
      action: { onClick: () => void };
    };
    options.action.onClick();
    expect(go).toHaveBeenCalledWith("/projects/p-1/analysis?analysisId=an-1");
  });

  it("offers no action for a link that is not a same-origin path", () => {
    fireJobNotificationToast(jobEvent({ href: "//evil.example/x" }));
    const options = vi.mocked(toast.success).mock.calls[0][1] as Record<string, unknown>;
    expect(options.action).toBeUndefined();
  });

  it("a second tab stays quiet: the first tab's claim is shared through localStorage", () => {
    window.localStorage.setItem(`${CROSS_TAB_CLAIM_PREFIX}an-1`, String(Date.now()));
    expect(fireJobNotificationToast(jobEvent())).toBe(false);
    // The lifecycle path claims across tabs too (a job this tab has not seen).
    window.localStorage.setItem(`${CROSS_TAB_CLAIM_PREFIX}an-2`, String(Date.now()));
    expect(fireTerminalToast(lifecycle({ jobId: "an-2" }))).toBe(false);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("an old claim has expired: a regeneration on the same id toasts again", () => {
    window.localStorage.setItem(`${CROSS_TAB_CLAIM_PREFIX}doc-1`, String(Date.now() - 11 * 60_000));
    expect(fireJobNotificationToast(jobEvent({ jobId: "doc-1" }))).toBe(true);
  });

  it("a job already toasted without a toast id (a stale replay) is not shown again", () => {
    expect(fireTerminalToast(lifecycle({ replayAgeMs: 10 * 60_000 }))).toBe(false);
    expect(fireJobNotificationToast(jobEvent())).toBe(false);
    expect(fireJobNotificationToast(null)).toBe(false);
  });
});
