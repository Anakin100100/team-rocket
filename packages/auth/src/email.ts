import { Resend } from "resend";

export interface EmailConfig {
  RESEND_API_KEY: string;
  EMAIL_FROM: string;
}

interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const HTML_ESCAPE_PATTERN = /[&<>"']/gu;

// Names and organization names are user-controlled, so escape them before
// they reach an HTML body.
const escapeHtml = (value: string) =>
  value.replaceAll(HTML_ESCAPE_PATTERN, (char) => HTML_ESCAPES[char] ?? char);

const layout = (heading: string, body: string, action: string, url: string) =>
  `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f6f6f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111">
    <table role="presentation" width="100%" style="max-width:480px;margin:0 auto;background:#fff;padding:32px;border-radius:8px">
      <tr><td>
        <h1 style="margin:0 0 16px;font-size:20px">${heading}</h1>
        <p style="margin:0 0 24px;font-size:15px;line-height:1.5">${body}</p>
        <a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 18px;background:#111;color:#fff;text-decoration:none;border-radius:6px;font-size:15px">${action}</a>
        <p style="margin:24px 0 0;font-size:13px;line-height:1.5;color:#666">If the button doesn't work, open this link:<br><a href="${escapeHtml(url)}" style="color:#666;word-break:break-all">${escapeHtml(url)}</a></p>
      </td></tr>
    </table>
  </body>
</html>`;

export const verificationEmail = (to: string, url: string): EmailMessage => ({
  to,
  subject: "Verify your email address",
  html: layout(
    "Verify your email",
    "Confirm this is your email address to finish setting up your account.",
    "Verify email",
    url
  ),
  text: `Confirm this is your email address to finish setting up your account:\n\n${url}`,
});

export const resetPasswordEmail = (to: string, url: string): EmailMessage => ({
  to,
  subject: "Reset your password",
  html: layout(
    "Reset your password",
    "Someone asked to reset the password for this account. If that wasn't you, you can ignore this email.",
    "Choose a new password",
    url
  ),
  text: `Someone asked to reset the password for this account. If that wasn't you, you can ignore this email.\n\nChoose a new password:\n\n${url}`,
});

export const invitationEmail = ({
  to,
  inviterName,
  organizationName,
  url,
  isNewUser,
}: {
  to: string;
  inviterName: string;
  organizationName: string;
  url: string;
  isNewUser: boolean;
}): EmailMessage => {
  const nextStep = isNewUser
    ? "Create your account with this email address to join."
    : "Sign in to accept the invitation.";
  const action = isNewUser ? "Create account and join" : "Accept invitation";

  return {
    to,
    subject: `${inviterName} invited you to join ${organizationName}`,
    html: layout(
      `Join ${escapeHtml(organizationName)}`,
      `${escapeHtml(inviterName)} invited you to join <strong>${escapeHtml(organizationName)}</strong>. ${nextStep}`,
      action,
      url
    ),
    text: `${inviterName} invited you to join ${organizationName}. ${nextStep}\n\n${action}:\n\n${url}`,
  };
};

export const createEmailSender = (config: EmailConfig) => {
  const resend = new Resend(config.RESEND_API_KEY);

  return async (message: EmailMessage) => {
    // The SDK reports failures in `error` instead of throwing.
    const { error } = await resend.emails.send({
      from: config.EMAIL_FROM,
      ...message,
    });
    if (error) {
      throw new Error(`Failed to send "${message.subject}": ${error.message}`);
    }
  };
};
