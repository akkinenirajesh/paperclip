export const config = {
  telegramBotToken: env("TELEGRAM_BOT_TOKEN"),
  databaseUrl: env("DATABASE_URL", "postgres://paperclip:paperclip@db:5432/paperclip"),
  paperclipApiUrl: env("PAPERCLIP_API_URL", "http://server:3100"),
  paperclipPublicUrl: env("PAPERCLIP_PUBLIC_URL", "https://paperclip.primeform.in"),
  openrouterApiKey: env("OPENROUTER_API_KEY"),
  aiModel: env("AI_MODEL", "stepfun/step-3.5-flash:free"),
  pollIntervalMs: Number(env("POLL_INTERVAL_MS", "5000")),
};

function env(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}
