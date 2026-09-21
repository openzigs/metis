/**
 * #1296 — the human half of the AGPL-3.0 §13 network source offer.
 *
 * §13 obliges a network-served version to *prominently offer* remote users the
 * Corresponding Source of the running version. The FSF's own application notes name
 * the expected shape: a "Source" link in the interface. This footer is that link, and
 * these arms hold the properties that make it discharge the obligation rather than
 * decorate the page:
 *
 *   * it renders the offer **before and without** any network call succeeding — a
 *     §13 affordance that disappears when the API is down is not an offer;
 *   * when `/api/source` answers, it **upgrades** to name the running commit, because
 *     "the source of the running version" is the thing §13 actually asks for;
 *   * every URL it renders is re-derived through `parseSourceOffer`, so a hostile or
 *     malformed response cannot become the `href`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { buildSourceOffer } from "@metis/shared";

import { SourceOfferFooter } from "./source-offer-footer";

const FULL_SHA = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";
const REPO = "https://github.com/openzigs/metis";

/** A response body identical to what `server/src/routes/source.ts` serves. */
function servedOffer(env: Record<string, string | undefined>): unknown {
  return JSON.parse(JSON.stringify(buildSourceOffer(env)));
}

function mockFetchOnce(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const fetchMock = vi.fn(async (_input: unknown) => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SourceOfferFooter — the offer survives a dead API", () => {
  it("names the licence and offers a source link when the fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    render(<SourceOfferFooter />);

    expect(screen.getByTestId("source-offer-footer")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /AGPL-3\.0-only/ })).toHaveAttribute(
      "href",
      "https://www.gnu.org/licenses/agpl-3.0.html",
    );
    const source = screen.getByTestId("source-offer-link");
    expect(source).toHaveAttribute("href", REPO);
  });

  it("offers a source link when the endpoint answers non-2xx", async () => {
    mockFetchOnce({ error: "nope" }, { ok: false, status: 503 });
    render(<SourceOfferFooter />);
    await waitFor(() => {
      expect(screen.getByTestId("source-offer-link")).toHaveAttribute("href", REPO);
    });
  });

  it("offers a source link when the endpoint answers unparseable JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token <");
        },
      })),
    );
    render(<SourceOfferFooter />);
    await waitFor(() => {
      expect(screen.getByTestId("source-offer-link")).toHaveAttribute("href", REPO);
    });
  });

  it("says plainly that the running commit is unidentified rather than implying it is known", () => {
    mockFetchOnce(servedOffer({}));
    render(<SourceOfferFooter />);
    expect(screen.getByTestId("source-offer-link")).toHaveAccessibleName(
      /source code.*commit is not identified/i,
    );
  });
});

describe("SourceOfferFooter — upgrading to the running commit", () => {
  it("fetches the offer from /api/source", async () => {
    const fetchMock = mockFetchOnce(servedOffer({ METIS_SOURCE_COMMIT: FULL_SHA }));
    render(<SourceOfferFooter />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/source");
  });

  it("names the running commit and links to its tree once the offer arrives", async () => {
    mockFetchOnce(servedOffer({ METIS_SOURCE_COMMIT: FULL_SHA }));
    render(<SourceOfferFooter />);

    const link = await screen.findByTestId("source-offer-link");
    await waitFor(() => {
      expect(link).toHaveAttribute("href", `${REPO}/tree/${FULL_SHA}`);
    });
    expect(link).toHaveTextContent("0a1b2c3");
  });

  it("offers the source archive of the running commit as well as its tree", async () => {
    mockFetchOnce(servedOffer({ METIS_SOURCE_COMMIT: FULL_SHA }));
    render(<SourceOfferFooter />);
    const archive = await screen.findByTestId("source-offer-archive-link");
    expect(archive).toHaveAttribute("href", `${REPO}/archive/${FULL_SHA}.tar.gz`);
  });

  it("offers no archive link while the commit is unknown, rather than a broken one", async () => {
    mockFetchOnce(servedOffer({}));
    render(<SourceOfferFooter />);
    await waitFor(() => expect(screen.getByTestId("source-offer-link")).toBeInTheDocument());
    expect(screen.queryByTestId("source-offer-archive-link")).not.toBeInTheDocument();
  });

  it("follows a fork's repository so a modified deployment offers ITS source", async () => {
    mockFetchOnce(
      servedOffer({
        METIS_SOURCE_COMMIT: FULL_SHA,
        METIS_SOURCE_REPOSITORY_URL: "https://git.example.com/fork/metis",
      }),
    );
    render(<SourceOfferFooter />);
    await waitFor(() => {
      expect(screen.getByTestId("source-offer-link")).toHaveAttribute(
        "href",
        `https://git.example.com/fork/metis/tree/${FULL_SHA}`,
      );
    });
  });
});

describe("SourceOfferFooter — a response is not trusted as a link", () => {
  it("refuses a javascript: sourceUrl the response supplied", async () => {
    mockFetchOnce({
      license: "AGPL-3.0-only",
      repositoryUrl: REPO,
      commit: FULL_SHA,
      sourceUrl: "javascript:alert(1)",
      commitUrl: "javascript:alert(2)",
      archiveUrl: "javascript:alert(3)",
    });
    render(<SourceOfferFooter />);

    const link = await screen.findByTestId("source-offer-link");
    await waitFor(() => {
      expect(link).toHaveAttribute("href", `${REPO}/tree/${FULL_SHA}`);
    });
    for (const anchor of screen.getAllByRole("link")) {
      expect(anchor.getAttribute("href") ?? "").toMatch(/^https:\/\//);
    }
  });

  it("refuses a non-https repositoryUrl the response supplied", async () => {
    mockFetchOnce({ repositoryUrl: "http://evil.example/metis", commit: FULL_SHA });
    render(<SourceOfferFooter />);
    await waitFor(() => {
      expect(screen.getByTestId("source-offer-link")).toHaveAttribute(
        "href",
        `${REPO}/tree/${FULL_SHA}`,
      );
    });
  });

  it("refuses a commit that is not a sha rather than putting it in the URL", async () => {
    mockFetchOnce({ repositoryUrl: REPO, commit: '../../../etc/passwd" onmouseover="x' });
    render(<SourceOfferFooter />);
    await waitFor(() => {
      expect(screen.getByTestId("source-offer-link")).toHaveAttribute("href", REPO);
    });
    expect(screen.getByTestId("source-offer-footer").innerHTML).not.toContain("onmouseover");
  });

  it("keeps the built-in offer when the response is not an object at all", async () => {
    mockFetchOnce("not an offer");
    render(<SourceOfferFooter />);
    await waitFor(() => {
      expect(screen.getByTestId("source-offer-link")).toHaveAttribute("href", REPO);
    });
  });

  // Reverse tabnabbing (OWASP): these links leave the application, so the opened
  // document must not get a handle on this window.
  it("opens external links without handing them window.opener", async () => {
    mockFetchOnce(servedOffer({ METIS_SOURCE_COMMIT: FULL_SHA }));
    render(<SourceOfferFooter />);
    await screen.findByTestId("source-offer-archive-link");
    for (const anchor of screen.getAllByRole("link")) {
      expect(anchor).toHaveAttribute("target", "_blank");
      expect(anchor.getAttribute("rel") ?? "").toContain("noopener");
      expect(anchor.getAttribute("rel") ?? "").toContain("noreferrer");
    }
  });
});

describe("SourceOfferFooter — accessibility", () => {
  it("is a landmark a screen-reader user can jump to", () => {
    mockFetchOnce(servedOffer({}));
    render(<SourceOfferFooter />);
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });

  it("gives each link a distinguishable accessible name", async () => {
    mockFetchOnce(servedOffer({ METIS_SOURCE_COMMIT: FULL_SHA }));
    render(<SourceOfferFooter />);
    await screen.findByTestId("source-offer-archive-link");

    const names = screen.getAllByRole("link").map((a) => a.textContent ?? "");
    expect(new Set(names).size).toBe(names.length);
  });
});
