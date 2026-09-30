"use client";

import { Fragment } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { projectsApi } from "@/lib/projects-api";
import { pageCrumbs } from "@/lib/breadcrumb-trail";
import { cn } from "@/lib/utils";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { WorkspaceSwitcher } from "./workspace-switcher";
import { ProjectSwitcher } from "./project-switcher";

/**
 * N7 (#152) — consolidate the former dual header switchers into a single
 * breadcrumb hierarchy: Workspace › Project. Each of those crumbs is itself a
 * switcher menu. Degrades to workspace-only when no project context exists.
 *
 * #271 — the trail continues to the page: Workspace › Project › Section ›
 * Page (`lib/breadcrumb-trail.ts`). Only the last crumb is the current page
 * (`aria-current="page"`); the switchers never are. Below `sm` the crumbs
 * between the switchers and the current page are hidden to fit the header.
 *
 * #529 — below `sm` the trail is the header's full-width last row (the header
 * wraps), and the current-page crumb does not shrink: the switchers truncate
 * their labels first, so the page name stays readable at phone width.
 */
export function Breadcrumbs() {
  const pathname = usePathname() ?? "";
  const projects = useQuery({
    queryKey: ["projects", "switcher"],
    queryFn: () => projectsApi.list({ limit: 50 }),
    staleTime: 30_000,
  });

  const hasProjects = (projects.data?.items.length ?? 0) > 0;
  const onProjectPath = /^\/projects\/[^/]+/.test(pathname);
  const showProject = hasProjects || onProjectPath;
  const crumbs = pageCrumbs(pathname);

  return (
    <Breadcrumb
      data-testid="header-breadcrumb"
      className="order-last min-w-0 basis-full sm:order-none sm:basis-auto"
    >
      <BreadcrumbList>
        <BreadcrumbItem>
          <WorkspaceSwitcher />
        </BreadcrumbItem>
        {showProject ? (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <ProjectSwitcher />
            </BreadcrumbItem>
          </>
        ) : null}
        {crumbs.map((crumb, i) => {
          const isLast = i === crumbs.length - 1;
          const narrow = isLast ? "shrink-0" : "hidden sm:inline-flex";
          return (
            <Fragment key={`${i}-${crumb.label}`}>
              <BreadcrumbSeparator className={isLast ? "shrink-0" : "hidden sm:block"} />
              <BreadcrumbItem className={cn("max-w-[12rem]", narrow)}>
                {isLast ? (
                  <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                ) : crumb.href ? (
                  <BreadcrumbLink asChild>
                    <Link href={crumb.href}>{crumb.label}</Link>
                  </BreadcrumbLink>
                ) : (
                  <span className="truncate">{crumb.label}</span>
                )}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
