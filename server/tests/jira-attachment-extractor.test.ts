/**
 * Jira Attachment Extractor — unit tests.
 * Epic #658 / Issues #659, #660, #661.
 */
import { describe, expect, it, vi } from "vitest";
import { MAX_PDF_PAGES } from "@metis/shared";
import type { JiraClient } from "../../src/lib/connectors/jira/jira-client.js";
import type { AIProvider, ChatResponse } from "../../src/lib/ai/types.js";
import {
  extractAttachments,
  renderAttachmentMarkdown,
  MAX_ATTACHMENT_SIZE,
  type AttachmentMeta,
  type AttachmentExtraction,
} from "../../src/lib/connectors/jira/attachment-extractor.js";

// ---- Mocks -----------------------------------------------------------------

/**
 * The page count is a module-level knob so a single test can hand this route an over-cap
 * document (#1279). `getInfo` exists because `extractPdf` now consults the shared
 * `MAX_PDF_PAGES` bound before extracting any text.
 */
const { mockPdfPageCount } = vi.hoisted(() => ({ mockPdfPageCount: { value: 1 } }));

vi.mock("pdf-parse", () => {
  class MockPDFParse {
    constructor(_options: unknown) {}
    async getInfo() {
      return { numPages: mockPdfPageCount.value };
    }
    async getText() {
      return {
        text: "PDF extracted text content",
        pages: [{ num: 1, text: "PDF extracted text content" }],
        total: 1,
      };
    }
    async destroy() {}
  }
  return { PDFParse: MockPDFParse };
});

vi.mock("mammoth", () => ({
  default: {
    extractRawText: vi.fn(async () => ({
      value: "DOCX extracted raw text content",
      messages: [],
    })),
  },
}));

vi.mock("exceljs", () => {
  const mockWorksheet = {
    name: "Sheet1",
    eachRow: vi.fn((_opts: unknown, cb: (row: { values: (string | number | null)[] }) => void) => {
      // exceljs row.values is 1-indexed (index 0 is undefined)
      cb({ values: [undefined as unknown as null, "Name", "Value"] });
      cb({ values: [undefined as unknown as null, "Alpha", "100"] });
      cb({ values: [undefined as unknown as null, "Beta", "200"] });
    }),
  };
  class MockWorkbook {
    xlsx = { load: vi.fn(async () => {}) };
    eachSheet(cb: (ws: typeof mockWorksheet) => void) {
      cb(mockWorksheet);
    }
  }
  return {
    default: {
      Workbook: MockWorkbook,
    },
  };
});

function createMockClient(contentMap: Record<string, Buffer | Error> = {}): JiraClient {
  return {
    testConnection: vi.fn(),
    getServerInfo: vi.fn(),
    listProjects: vi.fn(),
    searchIssues: vi.fn(),
    getIssue: vi.fn(),
    createIssue: vi.fn(),
    searchIssuesAll: vi.fn(),
    fetchRaw: vi.fn(async (url: string) => {
      const entry = contentMap[url];
      if (entry instanceof Error) throw entry;
      const buf = entry ?? Buffer.from("default content");
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(buf));
          controller.close();
        },
      });
      return {
        body: stream,
        contentType: "application/octet-stream",
        contentLength: buf.length,
      };
    }),
  } as unknown as JiraClient;
}

function createMockAIProvider(response = "A diagram showing system architecture"): AIProvider {
  return {
    key: "offline-stub",
    model: "test-model",
    offline: true,
    chat: vi.fn(
      async (): Promise<ChatResponse> => ({
        content: response,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        model: "test-model",
        provider: "offline-stub",
      }),
    ),
    stream: vi.fn(),
    embed: vi.fn(),
    models: vi.fn(async () => ["test-model"]),
    ping: vi.fn(async () => true),
  } as unknown as AIProvider;
}

// ---- Tests -----------------------------------------------------------------

describe("attachment-extractor", () => {
  describe("extractAttachments — text files (#659)", () => {
    it("extracts UTF-8 text from text/plain attachment", async () => {
      const content = Buffer.from("Hello, world! This is a requirements doc.");
      const client = createMockClient({
        "https://jira.example.com/attachment/1": content,
      });
      const attachments: AttachmentMeta[] = [
        {
          filename: "requirements.txt",
          mimeType: "text/plain",
          size: content.length,
          content: "https://jira.example.com/attachment/1",
        },
      ];

      const results = await extractAttachments({ client, attachments });

      expect(results).toHaveLength(1);
      expect(results[0].filename).toBe("requirements.txt");
      expect(results[0].method).toBe("text");
      expect(results[0].text).toBe("Hello, world! This is a requirements doc.");
    });

    it("extracts application/json as text", async () => {
      const content = Buffer.from('{"key": "value"}');
      const client = createMockClient({
        "https://jira.example.com/attachment/2": content,
      });
      const attachments: AttachmentMeta[] = [
        {
          filename: "config.json",
          mimeType: "application/json",
          size: content.length,
          content: "https://jira.example.com/attachment/2",
        },
      ];

      const results = await extractAttachments({ client, attachments });

      expect(results[0].method).toBe("text");
      expect(results[0].text).toBe('{"key": "value"}');
    });

    it("extracts CSV files (text/csv)", async () => {
      const content = Buffer.from("name,value\nalpha,100\nbeta,200");
      const client = createMockClient({
        "https://jira.example.com/attachment/3": content,
      });
      const attachments: AttachmentMeta[] = [
        {
          filename: "data.csv",
          mimeType: "text/csv",
          size: content.length,
          content: "https://jira.example.com/attachment/3",
        },
      ];

      const results = await extractAttachments({ client, attachments });

      expect(results[0].method).toBe("text");
      expect(results[0].text).toContain("name,value");
    });

    it("falls back to extension-based detection for generic mimeType", async () => {
      const content = Buffer.from("log entry 1\nlog entry 2");
      const client = createMockClient({
        "https://jira.example.com/attachment/4": content,
      });
      const attachments: AttachmentMeta[] = [
        {
          filename: "server.log",
          mimeType: "application/octet-stream",
          size: content.length,
          content: "https://jira.example.com/attachment/4",
        },
      ];

      const results = await extractAttachments({ client, attachments });

      expect(results[0].method).toBe("text");
      expect(results[0].text).toContain("log entry 1");
    });
  });

  describe("extractAttachments — image description (#660)", () => {
    it("describes image via AI provider", async () => {
      const imageBuffer = Buffer.from("fake-png-data");
      const client = createMockClient({
        "https://jira.example.com/attachment/img1": imageBuffer,
      });
      const aiProvider = createMockAIProvider("A UML class diagram showing User and Role entities");
      const attachments: AttachmentMeta[] = [
        {
          filename: "diagram.png",
          mimeType: "image/png",
          size: imageBuffer.length,
          content: "https://jira.example.com/attachment/img1",
        },
      ];

      const results = await extractAttachments({ client, attachments, aiProvider });

      expect(results[0].method).toBe("image-description");
      expect(results[0].text).toBe("A UML class diagram showing User and Role entities");
      expect(aiProvider.chat).toHaveBeenCalledTimes(1);

      // Verify multimodal content blocks (#660)
      const chatCall = (aiProvider.chat as ReturnType<typeof vi.fn>).mock.calls[0];
      const messages = chatCall[0] as Array<{ role: string; content: unknown }>;
      const userMsg = messages.find((m) => m.role === "user");
      expect(Array.isArray(userMsg?.content)).toBe(true);
      const parts = userMsg!.content as Array<{
        type: string;
        text?: string;
        image_url?: { url: string };
      }>;
      expect(parts).toHaveLength(2);
      expect(parts[0].type).toBe("text");
      expect(parts[1].type).toBe("image_url");
      expect(parts[1].image_url?.url).toMatch(/^data:image\/png;base64,/);
    });

    it("skips image when no AI provider is configured", async () => {
      const client = createMockClient({});
      const attachments: AttachmentMeta[] = [
        {
          filename: "screenshot.png",
          mimeType: "image/png",
          size: 1000,
          content: "https://jira.example.com/attachment/img2",
        },
      ];

      const results = await extractAttachments({ client, attachments });

      expect(results[0].method).toBe("skipped");
      expect(results[0].skipReason).toContain("No AI provider");
    });

    it("handles AI provider failure gracefully", async () => {
      const imageBuffer = Buffer.from("fake-png-data");
      const client = createMockClient({
        "https://jira.example.com/attachment/img3": imageBuffer,
      });
      const aiProvider = createMockAIProvider();
      (aiProvider.chat as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Model unavailable"),
      );
      const attachments: AttachmentMeta[] = [
        {
          filename: "broken.png",
          mimeType: "image/png",
          size: imageBuffer.length,
          content: "https://jira.example.com/attachment/img3",
        },
      ];

      const results = await extractAttachments({ client, attachments, aiProvider });

      expect(results[0].method).toBe("skipped");
      expect(results[0].skipReason).toContain("Extraction failed");
    });
  });

  describe("extractAttachments — PDF/DOCX/XLSX (#661)", () => {
    it("extracts text from PDF", async () => {
      const pdfBuffer = Buffer.from("fake-pdf-content");
      const client = createMockClient({
        "https://jira.example.com/attachment/pdf1": pdfBuffer,
      });
      const attachments: AttachmentMeta[] = [
        {
          filename: "spec.pdf",
          mimeType: "application/pdf",
          size: pdfBuffer.length,
          content: "https://jira.example.com/attachment/pdf1",
        },
      ];

      const results = await extractAttachments({ client, attachments });

      expect(results[0].method).toBe("pdf");
      expect(results[0].text).toContain("PDF extracted text content");
    });

    /**
     * #1279 — this is the second route that ends in PDF text extraction and it had no
     * page bound at all, only Jira's self-reported `meta.size`. It shares the cap with
     * `documents/parsers.ts` via `exceedsPdfPageCap`; the boundary itself is pinned
     * one page either side in `parsers-content-routing.test.ts`.
     */
    it("skips a PDF attachment that exceeds MAX_PDF_PAGES instead of extracting it", async () => {
      const pdfBuffer = Buffer.from("fake-pdf-content");
      const client = createMockClient({
        "https://jira.example.com/attachment/huge-pdf": pdfBuffer,
      });
      const attachments: AttachmentMeta[] = [
        {
          filename: "enormous.pdf",
          mimeType: "application/pdf",
          // Comfortably inside MAX_ATTACHMENT_SIZE: the byte cap is not what refuses this.
          size: pdfBuffer.length,
          content: "https://jira.example.com/attachment/huge-pdf",
        },
      ];

      mockPdfPageCount.value = MAX_PDF_PAGES + 1;
      try {
        const results = await extractAttachments({ client, attachments });

        expect(results[0].method).toBe("skipped");
        expect(results[0].text).toBe("");
        expect(results[0].skipReason).toContain(`${MAX_PDF_PAGES}-page limit`);
      } finally {
        mockPdfPageCount.value = 1;
      }
    });

    it("extracts markdown from DOCX", async () => {
      const docxBuffer = Buffer.from("fake-docx-content");
      const client = createMockClient({
        "https://jira.example.com/attachment/doc1": docxBuffer,
      });
      const attachments: AttachmentMeta[] = [
        {
          filename: "requirements.docx",
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          size: docxBuffer.length,
          content: "https://jira.example.com/attachment/doc1",
        },
      ];

      const results = await extractAttachments({ client, attachments });

      expect(results[0].method).toBe("docx");
      expect(results[0].text).toContain("DOCX extracted raw text content");
    });

    it("extracts tables from XLSX", async () => {
      const xlsxBuffer = Buffer.from("fake-xlsx-content");
      const client = createMockClient({
        "https://jira.example.com/attachment/xls1": xlsxBuffer,
      });
      const attachments: AttachmentMeta[] = [
        {
          filename: "data.xlsx",
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          size: xlsxBuffer.length,
          content: "https://jira.example.com/attachment/xls1",
        },
      ];

      const results = await extractAttachments({ client, attachments });

      expect(results[0].method).toBe("xlsx");
      expect(results[0].text).toContain("Sheet: Sheet1");
      expect(results[0].text).toContain("| Name | Value |");
    });
  });

  describe("extractAttachments — size/skip logic", () => {
    it("skips attachments exceeding 5MB", async () => {
      const client = createMockClient({});
      const attachments: AttachmentMeta[] = [
        {
          filename: "huge.pdf",
          mimeType: "application/pdf",
          size: MAX_ATTACHMENT_SIZE + 1,
          content: "https://jira.example.com/attachment/big",
        },
      ];

      const results = await extractAttachments({ client, attachments });

      expect(results[0].method).toBe("skipped");
      expect(results[0].skipReason).toContain("5MB limit");
    });

    it("skips unknown MIME types", async () => {
      const client = createMockClient({});
      const attachments: AttachmentMeta[] = [
        {
          filename: "binary.exe",
          mimeType: "application/x-executable",
          size: 1000,
          content: "https://jira.example.com/attachment/exe",
        },
      ];

      const results = await extractAttachments({ client, attachments });

      expect(results[0].method).toBe("skipped");
      expect(results[0].skipReason).toContain("Unsupported MIME type");
    });

    it("handles download failure gracefully", async () => {
      const client = createMockClient({
        "https://jira.example.com/attachment/fail": new Error("Connection refused"),
      });
      const attachments: AttachmentMeta[] = [
        {
          filename: "readme.txt",
          mimeType: "text/plain",
          size: 100,
          content: "https://jira.example.com/attachment/fail",
        },
      ];

      const results = await extractAttachments({ client, attachments });

      expect(results[0].method).toBe("skipped");
      expect(results[0].skipReason).toContain("Extraction failed");
    });

    it("processes multiple attachments in sequence", async () => {
      const txtContent = Buffer.from("hello");
      const pdfContent = Buffer.from("pdf-bytes");
      const client = createMockClient({
        "https://jira.example.com/a/1": txtContent,
        "https://jira.example.com/a/2": pdfContent,
      });
      const attachments: AttachmentMeta[] = [
        {
          filename: "notes.txt",
          mimeType: "text/plain",
          size: txtContent.length,
          content: "https://jira.example.com/a/1",
        },
        {
          filename: "spec.pdf",
          mimeType: "application/pdf",
          size: pdfContent.length,
          content: "https://jira.example.com/a/2",
        },
        {
          filename: "big.bin",
          mimeType: "application/octet-stream",
          size: MAX_ATTACHMENT_SIZE + 100,
          content: "https://jira.example.com/a/3",
        },
      ];

      const results = await extractAttachments({ client, attachments });

      expect(results).toHaveLength(3);
      expect(results[0].method).toBe("text");
      expect(results[1].method).toBe("pdf");
      expect(results[2].method).toBe("skipped");
    });
  });

  describe("renderAttachmentMarkdown", () => {
    it("renders text attachment as markdown section", () => {
      const extractions: AttachmentExtraction[] = [
        { filename: "notes.txt", text: "Some notes here", method: "text" },
      ];
      const md = renderAttachmentMarkdown(extractions);
      expect(md).toContain("## Attachment: notes.txt");
      expect(md).toContain("Some notes here");
    });

    it("adds (image description) suffix for images", () => {
      const extractions: AttachmentExtraction[] = [
        { filename: "diagram.png", text: "A system diagram", method: "image-description" },
      ];
      const md = renderAttachmentMarkdown(extractions);
      expect(md).toContain("## Attachment: diagram.png (image description)");
      expect(md).toContain("A system diagram");
    });

    it("skips entries with no text or skipped method", () => {
      const extractions: AttachmentExtraction[] = [
        { filename: "big.bin", text: "", method: "skipped", skipReason: "Too large" },
        { filename: "good.txt", text: "content", method: "text" },
      ];
      const md = renderAttachmentMarkdown(extractions);
      expect(md).not.toContain("big.bin");
      expect(md).toContain("good.txt");
    });

    it("returns empty string when all are skipped", () => {
      const extractions: AttachmentExtraction[] = [
        { filename: "a.bin", text: "", method: "skipped" },
      ];
      const md = renderAttachmentMarkdown(extractions);
      expect(md).toBe("");
    });

    it("renders multiple attachments in order", () => {
      const extractions: AttachmentExtraction[] = [
        { filename: "a.txt", text: "first", method: "text" },
        { filename: "b.pdf", text: "second", method: "pdf" },
      ];
      const md = renderAttachmentMarkdown(extractions);
      const aIdx = md.indexOf("a.txt");
      const bIdx = md.indexOf("b.pdf");
      expect(aIdx).toBeLessThan(bIdx);
    });
  });
});
