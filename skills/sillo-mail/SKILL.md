---
name: sillo-mail
title: Mail
description: >-
  Sending email from Sillo: setup_mail and MailConfig (SMTP env, Gmail/SendGrid presets), send_email, Jinja templates, attachments, EmailResult, suppress_send, queued jobs.
intents:
  - send a welcome email after registration
  - send a password reset email
  - send this email in the background
  - configure SMTP
  - email the invoice as a PDF attachment
  - don't send real emails in tests
capabilities: [mail]
related: [sillo-queues, sillo-auth, sillo-testing, sillo-application]
requires: [sillo]
sillo: ">=1.0.0 <2.0.0"
packages: ["sillo-framework", "sillo-framework[mail] for templates (jinja2)"]
symbols:
  - sillo.mail.MailConfig
  - sillo.mail.Mail
  - sillo.mail.setup_mail
  - sillo.mail.get_mail_client
  - sillo.mail.current_mail
  - sillo.mail.send_email
  - sillo.mail.MailClient.send_email
  - sillo.mail.MailClient.send_template_email
  - sillo.mail.MailClient.send_message
  - sillo.mail.EmailMessage
  - sillo.mail.EmailResult
  - sillo.mail.MailConfig.for_gmail
  - sillo.mail.MailConfig.for_sendgrid
probes:
  - mail_suppress_send_returns_result_and_never_raises
  - mail_start_connects_eagerly_so_unreachable_smtp_fails_startup
sources:
  - core:sillo/mail/client.py
  - core:sillo/mail/config.py
  - core:sillo/mail/context.py
  - core:sillo/mail/models.py
  - docs:v1.0/guides/services/mail.mdx
status: stable
---

## When

Any outgoing email. Anything triggered by a user action that the user should not wait
for (welcome, receipts, resets) combines this with `sillo-queues`.

## Inspect first

- Existing mail wiring (`setup_mail` / `app.install(Mail(...))`) and templates directory.
- Mail settings in `.env.example` (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`,
  `SMTP_PASSWORD`, `MAIL_DEFAULT_FROM`, …) — never read `.env` itself.
- Whether a queue is wired; if not, decide with the user whether to add one.

## How

```python
from sillo.mail import MailConfig, setup_mail

mail = setup_mail(app, MailConfig())          # every field reads an env var (below)
# MailConfig.for_gmail(user, app_password), .for_outlook(...), .for_sendgrid(api_key)
```

Environment: `SMTP_HOST`, `SMTP_PORT` (465 ⇒ SSL, 587 ⇒ STARTTLS), `SMTP_USERNAME`,
`SMTP_PASSWORD`, `SMTP_USE_TLS`, `SMTP_USE_SSL`, `MAIL_DEFAULT_FROM`,
`MAIL_DEFAULT_REPLY_TO`, `MAIL_TEMPLATE_DIR`, `MAIL_SUPPRESS_SEND`, `SMTP_TIMEOUT`.

Sending — anywhere in the app:

```python
from sillo.mail import current_mail, get_mail_client

mail = get_mail_client(ctx)          # in a handler; current_mail() in jobs and scripts
result = await mail.send_email(
    to=user.email,
    subject="Welcome to Acme",
    body="Thanks for signing up.",
    html_body="<h1>Welcome</h1>",
)
if not result.success:
    logger.error("welcome email failed: %s", result.error)
```

`send_email` **returns** an `EmailResult` (`success`, `error`, `message_id`) instead of
raising. Templates (`sillo-framework[mail]`): `MailConfig(template_directory="templates/mail")`
then `await mail.send_template_email(to=..., subject=..., template_name="welcome", context={...})`.
Attachments: build an `EmailMessage(to=[...], subject=...)`,
`message.add_attachment("invoice.pdf", pdf_bytes, content_type="application/pdf")`,
`await mail.send_message(message)`.

**In the background** — send from a job and raise on failure so it is retried:

```python
from sillo.mail import current_mail
from sillo.work.queue import Job, QRetryMiddleware

class SendWelcomeEmail(Job):
    middleware = [QRetryMiddleware(max_attempts=5, base_delay=5.0)]

    def __init__(self, user_id: int):
        super().__init__()
        self.user_id = user_id

    async def handle(self):
        user = await User.get(id=self.user_id)
        result = await current_mail().send_email(to=user.email, subject="Welcome",
                                                  body=f"Hi {user.username}!")
        if not result.success:
            raise RuntimeError(result.error)
```

The worker process must also run `setup_mail` (it imports the app, so wiring in the
bootstrap is enough) — see `sillo-queues`.

## Compose

`sillo-queues` for delivery off the request path; `sillo-auth` for signup/reset flows;
`sillo-security` (`URLSafeTimedSerializer`) for reset/verification links.

## Verify

`MailConfig(suppress_send=True)` (or `MAIL_SUPPRESS_SEND=true`) in tests: sends succeed
with `provider_response == {"suppressed": True}` and nothing leaves the machine. Assert on
the result or on what your code passed to `send_email`. Locally, point SMTP at a catcher
such as Mailpit.

## Avoid

- Ignoring the returned `EmailResult` — a failed send looks like success unless you
  check `result.success`.
- Sending inline in a request handler for user-facing flows; queue it.
- An unreachable SMTP server at startup: the mail client connects when the app starts,
  so the app will not boot. Use `suppress_send` where there is no SMTP (tests, CI,
  preview environments).
- User-controlled newlines in subjects (header injection); strip them.
