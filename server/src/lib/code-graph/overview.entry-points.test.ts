/**
 * #1371 — Project Overview presentation defects.
 *
 * Two server-side halves, both falsifiable against `main`:
 *  - `stripDocMarkup` did not exist, so `composeSummary` spliced raw Javadoc
 *    (`<p>`, `<ol>`, `@param`, `@throws`) straight into user-facing prose.
 *  - `isJavaEntryPoint` did not exist, so entry-point detection matched only
 *    JS/Go/Python file patterns and every Java project reported "0 entry points"
 *    — including a Spring Boot WAR with a dispatcher servlet and Quartz jobs.
 */
import { describe, it, expect } from "vitest";
import { composeSummary, isJavaEntryPoint, stripDocMarkup } from "./overview.js";

describe("stripDocMarkup (#1371)", () => {
  it("removes block Javadoc tags and everything after them", () => {
    const body =
      "Send a shipment request to WMS. @param shipments the shipment request @throws WmsClientException on failure";
    expect(stripDocMarkup(body).trim()).toBe("Send a shipment request to WMS.");
  });

  it("removes HTML tags but keeps their text content", () => {
    const body = "Requests are chunked. <ol> <li>Each organization is sent as a POST</li> </ol>";
    const out = stripDocMarkup(body).replace(/\s+/g, " ").trim();
    expect(out).toBe("Requests are chunked. Each organization is sent as a POST");
    expect(out).not.toContain("<");
  });

  it("collapses inline {@code …} and {@link …} to their payload", () => {
    expect(stripDocMarkup("Returns {@code null} when {@link WmsClient#send} fails.").trim()).toBe(
      "Returns null when WmsClient#send fails.",
    );
  });

  it("strips the leading Javadoc asterisk column", () => {
    const body = ["* Sends a job.", "* Retries twice."].join("\n");
    expect(stripDocMarkup(body).replace(/\s+/g, " ").trim()).toBe("Sends a job. Retries twice.");
  });

  it("does not eat Java generics, which are prose here not markup", () => {
    expect(stripDocMarkup("Accepts a List<String> of ids.")).toBe("Accepts a List<String> of ids.");
  });

  it("leaves ordinary prose byte-identical", () => {
    const prose = "The reconciliation job runs nightly at 02:00 UTC.";
    expect(stripDocMarkup(prose)).toBe(prose);
  });

  it("composeSummary emits no raw Javadoc from a rationale body", () => {
    const summary = composeSummary(
      "**OrderBatch** is indexed with 860 symbols across 7895 edges.",
      [
        {
          body: "Send a shipment request to WMS. <p> Requests are chunked. <ol> <li>Each organization is sent as a separate POST</li> </ol> @param jobs the request @throws WmsClientException on failure",
        },
      ],
      500,
    );
    expect(summary).not.toContain("<p>");
    expect(summary).not.toContain("<ol>");
    expect(summary).not.toContain("<li>");
    expect(summary).not.toContain("@param");
    expect(summary).not.toContain("@throws");
    expect(summary).toContain("Send a shipment request to WMS.");
  });
});

describe("isJavaEntryPoint (#1371)", () => {
  const java = (filePath: string, qualifiedName: string) => ({
    filePath,
    qualifiedName,
    language: "java",
  });

  it("recognises a public static void main method", () => {
    expect(
      isJavaEntryPoint(
        java(
          "src/main/java/com/acme/Bootstrap.java",
          "src/main/java/com/acme/Bootstrap.java::Bootstrap.main",
        ),
      ),
    ).toBe(true);
  });

  it("recognises a @SpringBootApplication class by its conventional file name", () => {
    expect(
      isJavaEntryPoint(
        java(
          "src/main/java/com/acme/OrderBatchApplication.java",
          "src/main/java/com/acme/OrderBatchApplication.java::OrderBatchApplication.run",
        ),
      ),
    ).toBe(true);
  });

  it("recognises a WebApplicationInitializer", () => {
    expect(
      isJavaEntryPoint(
        java(
          "src/main/java/com/acme/WebInitializer.java",
          "src/main/java/com/acme/WebInitializer.java::WebInitializer.onStartup",
        ),
      ),
    ).toBe(true);
  });

  it("recognises a registered servlet", () => {
    expect(
      isJavaEntryPoint(
        java(
          "src/main/java/com/acme/DispatcherServlet.java",
          "src/main/java/com/acme/DispatcherServlet.java::DispatcherServlet.doGet",
        ),
      ),
    ).toBe(true);
  });

  it("does not claim an ordinary Java service class", () => {
    expect(
      isJavaEntryPoint(
        java(
          "src/main/java/com/acme/QuoteService.java",
          "src/main/java/com/acme/QuoteService.java::QuoteService.submit",
        ),
      ),
    ).toBe(false);
  });

  it("does not fire for non-Java languages, so existing behaviour is unchanged", () => {
    expect(
      isJavaEntryPoint({
        filePath: "src/main/java/com/acme/Main.java",
        qualifiedName: "x::Main.main",
        language: "ts",
      }),
    ).toBe(false);
  });

  it("prefers an explicit name field over parsing the qualified name", () => {
    expect(
      isJavaEntryPoint({
        name: "main",
        filePath: "src/main/java/com/acme/Anything.java",
        qualifiedName: "opaque",
        language: "java",
      }),
    ).toBe(true);
  });
});
