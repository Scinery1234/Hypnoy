// Transactional email through Resend (https://resend.com), when RESEND_API_KEY
// and MAIL_FROM are set. Without them, send() does nothing and returns false,
// so the site works the same, just without the "your reading is ready" email.
// RESEND_API_BASE points it at a fake server in tests.
export function createMailer(env = process.env) {
  const key = env.RESEND_API_KEY, from = env.MAIL_FROM;
  if (!key || !from) return { enabled: false, async send() { return false; } };
  const base = (env.RESEND_API_BASE || "https://api.resend.com").replace(/\/+$/, "");
  return {
    enabled: true,
    async send({ to, subject, text, html }) {
      const res = await fetch(base + "/emails", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject, text, html }),
      });
      if (!res.ok) throw new Error("mail failed: " + res.status + " " + (await res.text()).slice(0, 200));
      return true;
    },
  };
}
