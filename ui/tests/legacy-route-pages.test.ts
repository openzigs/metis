/**
 * #31 — the retired routes are real pages that redirect to their one home.
 * `redirect()` is replaced with a spy: the real one throws NEXT_REDIRECT.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const redirect = vi.fn();
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));

import AdminRedirect from "@/app/(authed)/admin/[[...slug]]/page";
import AgentsRedirect from "@/app/(authed)/agents/page";
import SkillsRedirect from "@/app/(authed)/skills/page";
import SettingsAgentsRedirect from "@/app/(authed)/settings/agents/page";
import ProjectUsageRedirect from "@/app/(authed)/projects/[id]/usage/page";
import WorkspaceFinopsRedirect from "@/app/(authed)/workspaces/[id]/finops/page";

const query = (q: Record<string, string> = {}) => Promise.resolve(q);

beforeEach(() => redirect.mockClear());

describe("retired route pages (#31)", () => {
  it("sends /admin to Settings", async () => {
    await AdminRedirect({ params: Promise.resolve({}), searchParams: query() });
    expect(redirect).toHaveBeenCalledWith("/settings");
  });

  it("sends each /admin section to its Settings section", async () => {
    await AdminRedirect({
      params: Promise.resolve({ slug: ["workspaces", "ws 1", "settings"] }),
      searchParams: query(),
    });
    expect(redirect).toHaveBeenCalledWith("/settings/workspaces/ws%201");
  });

  it("sends Admin → Usage to the All-projects scope, keeping the query", async () => {
    await AdminRedirect({
      params: Promise.resolve({ slug: ["usage"] }),
      searchParams: query({ range: "7d" }),
    });
    expect(redirect).toHaveBeenCalledWith("/settings/usage?scope=platform&range=7d");
  });

  it.each([
    ["/agents", AgentsRedirect, "/library?tab=agents"],
    ["/skills", SkillsRedirect, "/library?tab=skills"],
    ["/settings/agents", SettingsAgentsRedirect, "/library?tab=agents"],
  ] as const)("sends %s to the Library", async (_path, Page, target) => {
    await Page({ searchParams: query() });
    expect(redirect).toHaveBeenCalledWith(target);
  });

  it("sends a project's usage to the Project scope of Usage & cost", async () => {
    await ProjectUsageRedirect({ params: Promise.resolve({ id: "p1" }), searchParams: query() });
    expect(redirect).toHaveBeenCalledWith("/settings/usage?scope=project&projectId=p1");
  });

  it("sends a workspace's FinOps to the Workspace scope of Usage & cost", async () => {
    await WorkspaceFinopsRedirect({
      params: Promise.resolve({ id: "ws-1" }),
      searchParams: query(),
    });
    expect(redirect).toHaveBeenCalledWith("/settings/usage?scope=workspace&workspaceId=ws-1");
  });
});
