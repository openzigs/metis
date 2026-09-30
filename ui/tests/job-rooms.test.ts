/**
 * #430 — `job:{id}` room membership is reference-counted on the client, so one
 * follower leaving does not cut off another follower of the same job.
 */
import { describe, it, expect, vi } from "vitest";
import { joinJobRoom } from "@/lib/job-rooms";

const fakeSocket = () => ({ emit: vi.fn() });
type Fake = ReturnType<typeof fakeSocket>;
const join = (s: Fake, jobId: string) => joinJobRoom(s as never, jobId);

describe("joinJobRoom", () => {
  it("subscribes on every join so each follower gets the replay", () => {
    const s = fakeSocket();
    join(s, "j1");
    join(s, "j1");
    expect(s.emit).toHaveBeenCalledTimes(2);
    expect(s.emit).toHaveBeenNthCalledWith(2, "subscribe:job", { jobId: "j1" });
  });

  it("leaves the room only when the last follower releases", () => {
    const s = fakeSocket();
    const a = join(s, "j1");
    const b = join(s, "j1");
    a();
    expect(s.emit).not.toHaveBeenCalledWith("unsubscribe:job", expect.anything());
    b();
    expect(s.emit).toHaveBeenCalledWith("unsubscribe:job", { jobId: "j1" });
  });

  it("counts a double release once", () => {
    const s = fakeSocket();
    const a = join(s, "j1");
    join(s, "j1");
    a();
    a();
    expect(s.emit).not.toHaveBeenCalledWith("unsubscribe:job", expect.anything());
  });

  it("counts each job and each socket separately", () => {
    const s1 = fakeSocket();
    const s2 = fakeSocket();
    join(s1, "j1");
    const other = join(s1, "j2");
    const elsewhere = join(s2, "j1");
    other();
    elsewhere();
    expect(s1.emit).toHaveBeenCalledWith("unsubscribe:job", { jobId: "j2" });
    expect(s1.emit).not.toHaveBeenCalledWith("unsubscribe:job", { jobId: "j1" });
    expect(s2.emit).toHaveBeenCalledWith("unsubscribe:job", { jobId: "j1" });
  });

  it("subscribes afresh after the room was fully released", () => {
    const s = fakeSocket();
    join(s, "j1")();
    const again = join(s, "j1");
    again();
    expect(s.emit.mock.calls.filter(([e]) => e === "unsubscribe:job")).toHaveLength(2);
  });
});
