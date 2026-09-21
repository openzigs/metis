/**
 * Minimal email-sender abstraction for FinOps alerts + chargeback reports
 * (Epic #47 / Issue #50, reused by #52).
 *
 * The codebase had no existing SMTP/nodemailer sender. Rather than couple the
 * alert engine to a heavy mail dependency, this exposes a tiny `EmailSender`
 * interface with two transports:
 *
 *   - `SmtpEmailSender` — lazily imports `nodemailer` and sends via SMTP.
 *     Configured entirely from env (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
 *     `SMTP_PASS`, `SMTP_FROM`, `SMTP_SECURE`). Construction validates that a
 *     host is configured; real network use is gated behind that env.
 *   - `LogEmailSender` — the default no-op fallback that logs the intent.
 *     Used in dev/test and whenever SMTP is not configured, so an unconfigured
 *     deployment degrades gracefully instead of throwing.
 *
 * `resolveEmailSender()` returns the SMTP sender when `SMTP_HOST` is set,
 * otherwise the log sender. Secrets (SMTP_PASS) are never logged.
 *
 * #614 — this module is a pure transport and holds NO preference logic: the
 * per-user notification-preference check for alert emails happens at the
 * dispatch call site (dispatcher.ts) via `shouldNotifyEmailRecipient`, so
 * every send that reaches `EmailSender.send` has already been authorized.
 */
import { createChildLogger } from "../../logger.js";

const log = createChildLogger("finops-email-sender");

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain-text body. */
  text: string;
  /** Optional HTML body. */
  html?: string;
  /** Optional attachments (e.g. a chargeback PDF). */
  attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>;
}

export interface EmailSendResult {
  ok: boolean;
  error?: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<EmailSendResult>;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

/** Read SMTP config from env. Returns null when no host is configured. */
export function loadSmtpConfig(env: NodeJS.ProcessEnv = process.env): SmtpConfig | null {
  const host = env.SMTP_HOST;
  if (!host) return null;
  // N2: fail closed when a host is configured but no sender address is. A
  // silent `metis-finops@localhost` default would be rejected by most relays
  // and masks a misconfiguration; require an explicit SMTP_FROM instead.
  const from = env.SMTP_FROM?.trim();
  if (!from) {
    throw new Error("SMTP_HOST is set but SMTP_FROM is missing — refusing to send from a default");
  }
  return {
    host,
    port: env.SMTP_PORT ? Number(env.SMTP_PORT) : 587,
    secure: env.SMTP_SECURE === "true",
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from,
  };
}

/** No-op sender that logs the intent. Default when SMTP is not configured. */
export class LogEmailSender implements EmailSender {
  async send(message: EmailMessage): Promise<EmailSendResult> {
    log.info("email (log transport — SMTP not configured)", {
      to: message.to,
      subject: message.subject,
      attachments: message.attachments?.length ?? 0,
    });
    return { ok: true };
  }
}

/** SMTP sender backed by a lazily-imported nodemailer transport. */
export class SmtpEmailSender implements EmailSender {
  private readonly config: SmtpConfig;
  // The transporter is created lazily on first send so importing this module
  // never requires nodemailer to be installed (tests use the log sender).
  private transporter: unknown = null;

  constructor(config: SmtpConfig) {
    this.config = config;
  }

  private async getTransporter(): Promise<{
    sendMail(opts: Record<string, unknown>): Promise<unknown>;
  }> {
    if (this.transporter) {
      return this.transporter as { sendMail(opts: Record<string, unknown>): Promise<unknown> };
    }
    const nodemailer = (await import("nodemailer")) as unknown as {
      createTransport(opts: Record<string, unknown>): {
        sendMail(opts: Record<string, unknown>): Promise<unknown>;
      };
    };
    const auth =
      this.config.user && this.config.pass
        ? { user: this.config.user, pass: this.config.pass }
        : undefined;
    this.transporter = nodemailer.createTransport({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth,
    });
    return this.transporter as { sendMail(opts: Record<string, unknown>): Promise<unknown> };
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    try {
      const transporter = await this.getTransporter();
      await transporter.sendMail({
        from: this.config.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        attachments: message.attachments,
      });
      return { ok: true };
    } catch (err) {
      // Never log SMTP_PASS — only the recipient + error message.
      log.warn("smtp send failed", { to: message.to, error: (err as Error).message });
      return { ok: false, error: (err as Error).message };
    }
  }
}

/**
 * Resolve the active email sender: SMTP when configured, else the log sender.
 */
export function resolveEmailSender(env: NodeJS.ProcessEnv = process.env): EmailSender {
  const config = loadSmtpConfig(env);
  return config ? new SmtpEmailSender(config) : new LogEmailSender();
}
