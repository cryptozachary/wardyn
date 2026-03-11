# email_skill
Purpose: Send emails via SMTP. Configure SMTP credentials in Skill Secrets on the Setup page. Useful for alerts, reports, and automated notifications.
Call name: "email_skill"
Actions:
- send: Send an email. Args: { action: "send", to: "user@example.com", subject: "Alert", body: "Message text", html?: "<p>HTML</p>", cc?: "other@example.com" }
Secrets required (configure in Setup > Skill Secrets):
- SMTP_HOST: SMTP server (e.g. smtp.gmail.com)
- SMTP_PORT: Port (587 for TLS, 465 for SSL)
- SMTP_USER: Login email
- SMTP_PASS: Password or app password
- SMTP_FROM: (optional) From address, defaults to SMTP_USER
Returns: JSON with { status, action, messageId, to, subject, elapsedMs }
