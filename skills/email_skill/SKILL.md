# email_skill
Purpose: Send emails via SMTP with security hardening. Configure SMTP credentials in Skill Secrets on the Setup page.
Call name: "email_skill"
Actions:
- send: Send an email. Args: { action: "send", to: ["user@example.com"], subject: "Alert", body: "Message text", html?: "<p>HTML</p>", cc?: ["other@example.com"], bcc?: ["hidden@example.com"], attachments?: ["report.pdf"] }
- verify: Test SMTP connection without sending. Args: { action: "verify" }
Security features:
- Header injection protection: rejects \r\n in subject, from, to, cc, bcc
- Domain allowlist: optional EMAIL_DOMAIN_ALLOWLIST restricts recipient domains
- Rate limiting: EMAIL_RATE_LIMIT (default: 20/hour) prevents abuse
- Safe attachments: files must be in output/ or sandbox/, allowed extensions only (.txt, .csv, .json, .xml, .pdf, .png, .jpg, .jpeg, .gif, .webp, .html, .md, .log, .zip), 10MB max
- Retry with backoff: retries transient 4xx/timeout errors (up to 2 retries), fails fast on 5xx/auth errors
- transport.verify(): validates SMTP connection before attempting send
Limits: 20 recipients max, 500 char subject, 100KB body, 10MB per attachment
Secrets required (configure in Setup > Skill Secrets):
- SMTP_HOST: SMTP server (e.g. smtp.gmail.com)
- SMTP_PORT: Port (587 for TLS, 465 for SSL)
- SMTP_USER: Login email
- SMTP_PASS: Password or app password
- SMTP_FROM: (optional) From address, defaults to SMTP_USER
- EMAIL_DOMAIN_ALLOWLIST: (optional) Comma-separated allowed recipient domains
- EMAIL_RATE_LIMIT: (optional) Max emails per hour (default: 20, 0 = unlimited)
Returns: JSON with { status, action, messageId, accepted, rejected, response, recipientCount, hasAttachments, elapsedMs }
Error response includes: { errorCategory, errorCode } — categories: config, injection, policy, rate_limit, validation, attachment, permanent_failure, transient_failure, network
