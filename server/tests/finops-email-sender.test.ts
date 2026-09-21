/**
 * Unit tests for the FinOps email-sender abstraction (Epic #47 / Issue #50).
 * No real SMTP — the SMTP transporter is exercised via a stubbed nodemailer
 * import-shaped object injected through the public surface; the log sender is
 * the default fallback.
 */
import { describe, expect, it, vi } from "vitest";
import {
  LogEmailSender,
  SmtpEmailSender,
  loadSmtpConfig,
  resolveEmailSender,
} from "../src/lib/finops/channels/email-sender.js";

describe("loadSmtpConfig", () => {
  it("returns null when SMTP_HOST is unset", () => {
    expect(loadSmtpConfig({})).toBeNull();
  });

  it("parses host/port/secure/from from env", () => {
    const cfg = loadSmtpConfig({
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "465",
      SMTP_SECURE: "true",
      SMTP_USER: "u",
      SMTP_PASS: "p",
      SMTP_FROM: "alerts@example.com",
    });
    expect(cfg).toEqual({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      user: "u",
      pass: "p",
      from: "alerts@example.com",
    });
  });

  it("defaults port to 587 when SMTP_FROM is provided", () => {
    const cfg = loadSmtpConfig({ SMTP_HOST: "smtp.example.com", SMTP_FROM: "a@b.com" });
    expect(cfg?.port).toBe(587);
    expect(cfg?.secure).toBe(false);
    expect(cfg?.from).toBe("a@b.com");
  });

  it("fails closed when SMTP_HOST is set but SMTP_FROM is missing (N2)", () => {
    expect(() => loadSmtpConfig({ SMTP_HOST: "smtp.example.com" })).toThrow(/SMTP_FROM is missing/);
    // Blank/whitespace-only is also rejected.
    expect(() => loadSmtpConfig({ SMTP_HOST: "smtp.example.com", SMTP_FROM: "  " })).toThrow(
      /SMTP_FROM is missing/,
    );
  });
});

describe("resolveEmailSender", () => {
  it("returns the log sender when SMTP is not configured", () => {
    expect(resolveEmailSender({})).toBeInstanceOf(LogEmailSender);
  });

  it("returns the SMTP sender when configured", () => {
    expect(
      resolveEmailSender({ SMTP_HOST: "smtp.example.com", SMTP_FROM: "alerts@example.com" }),
    ).toBeInstanceOf(SmtpEmailSender);
  });
});

describe("LogEmailSender", () => {
  it("always succeeds (graceful degradation)", async () => {
    const r = await new LogEmailSender().send({ to: "a@b.com", subject: "x", text: "y" });
    expect(r.ok).toBe(true);
  });
});

describe("SmtpEmailSender", () => {
  it("calls sendMail with the configured from + message fields", async () => {
    const sendMail = vi.fn(async () => ({ messageId: "1" }));
    const sender = new SmtpEmailSender({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      from: "alerts@example.com",
    });
    // Inject a fake transporter (avoids importing real nodemailer).
    (sender as unknown as { transporter: unknown }).transporter = { sendMail };

    const r = await sender.send({
      to: "owner@acme.com",
      subject: "Budget alert",
      text: "body",
    });
    expect(r.ok).toBe(true);
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: "alerts@example.com", to: "owner@acme.com" }),
    );
  });

  it("returns ok:false (not throw) when the transport errors", async () => {
    const sendMail = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const sender = new SmtpEmailSender({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      from: "alerts@example.com",
    });
    (sender as unknown as { transporter: unknown }).transporter = { sendMail };
    const r = await sender.send({ to: "x@y.com", subject: "s", text: "t" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/connection refused/);
  });
});
