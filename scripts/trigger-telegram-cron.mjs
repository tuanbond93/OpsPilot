const secret = (process.env.CRON_SECRET || process.env.opspilot_cron_secret)?.trim();
if (!secret) throw new Error("The production cron secret is not available in the selected environment.");

const response = await fetch("https://opspilot-tau-lyart.vercel.app/api/cron/telegram-followup-pilot", {
  method: "POST",
  headers: { Authorization: `Bearer ${secret}` },
});
const body = await response.json();
if (!response.ok) throw new Error(`Cron returned HTTP ${response.status}: ${body.error || "unknown error"}`);
process.stdout.write(JSON.stringify(body, null, 2));
