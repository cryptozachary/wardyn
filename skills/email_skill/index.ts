import { createTransport } from "nodemailer";
import { getSkillSecret } from "../../src/security/skillSecrets.js";

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["send"],
      description: "Email action",
    },
    to: { type: "string", description: "Recipient email address (required for send)" },
    subject: { type: "string", description: "Email subject (required for send)" },
    body: { type: "string", description: "Email body text (required for send)" },
    html: { type: "string", description: "Optional HTML body (overrides body if provided)" },
    cc: { type: "string", description: "CC recipients (comma-separated)" },
  },
  required: ["action"],
};

export const secrets = {
  SMTP_HOST: { description: "SMTP server hostname (e.g. smtp.gmail.com)", required: true },
  SMTP_PORT: { description: "SMTP port (e.g. 587 for TLS, 465 for SSL)", required: true },
  SMTP_USER: { description: "SMTP username / email address", required: true },
  SMTP_PASS: { description: "SMTP password or app-specific password", required: true },
  SMTP_FROM: { description: "From address (defaults to SMTP_USER if not set)", required: false },
};

/* ────────────────────── execute ────────────────────── */

export async function execute(args: any): Promise<string> {
  const start = Date.now();
  const { action } = args;

  try {
    switch (action) {
      case "send": {
        const { to, subject, body, html, cc } = args;
        if (!to) throw new Error("to is required");
        if (!subject) throw new Error("subject is required");
        if (!body && !html) throw new Error("body or html is required");

        // Validate email format loosely
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.split(",")[0].trim())) {
          throw new Error("Invalid email address format");
        }

        const host = getSkillSecret("email_skill", "SMTP_HOST");
        const port = getSkillSecret("email_skill", "SMTP_PORT");
        const user = getSkillSecret("email_skill", "SMTP_USER");
        const pass = getSkillSecret("email_skill", "SMTP_PASS");
        const from = getSkillSecret("email_skill", "SMTP_FROM") || user;

        if (!host || !user || !pass) {
          throw new Error("Email not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS in Skill Secrets on the Setup page.");
        }

        const portNum = parseInt(port, 10) || 587;
        const transport = createTransport({
          host,
          port: portNum,
          secure: portNum === 465,
          auth: { user, pass },
          connectionTimeout: 10000,
          socketTimeout: 10000,
        });

        const info = await transport.sendMail({
          from,
          to,
          cc: cc || undefined,
          subject,
          text: body || undefined,
          html: html || undefined,
        });

        return JSON.stringify({
          status: "ok",
          action: "send",
          messageId: info.messageId,
          to,
          subject,
          elapsedMs: Date.now() - start,
        });
      }

      default:
        throw new Error(`Unknown action: ${action}. Available: send`);
    }
  } catch (err: any) {
    return JSON.stringify({ status: "error", action, error: err.message, elapsedMs: Date.now() - start });
  }
}
