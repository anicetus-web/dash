// Handoff copy: the original Altech portal hostname was replaced with a neutral placeholder.
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));

// Числовой env: битое значение (Number('abc') === NaN) НЕ должно течь в setTimeout/max_tokens.
// Пустое/неустановленное → дефолт; не-finite → дефолт с предупреждением.
function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn(`[config] ${name}="${raw}" не число, беру дефолт ${fallback}`);
    return fallback;
  }
  return n;
}

const DEMO_MODE = process.env.DEMO_MODE !== '0';

export const config = {
  // Метка сборки — видна в /api/diagnostics (health.build). Бампаем при каждом деплое, чтобы одним
  // взглядом убеждаться, что на проде именно новый код (а не старый из-за незавершённого деплоя).
  buildTag: process.env.BUILD_TAG || '2026-07-09-sync-stability',
  demoMode: DEMO_MODE,
  port: num('PORT', 3000),
  vibeApiKey: process.env.VIBE_API_KEY || '',
  vibeBaseUrl: process.env.VIBE_BASE || 'https://vibecode.bitrix24.tech/v1',
  dashboardSnapshotFile: process.env.DASHBOARD_SNAPSHOT_FILE || '',
  cacheFile: process.env.BI_CACHE_FILE || 'data/bi-cache.json',
  salesPlanFile: process.env.SALES_PLAN_FILE || 'data/sales-plans.json',
  dashboardSettingsFile: process.env.DASHBOARD_SETTINGS_FILE || 'data/dashboard-settings.json',
  aiReportFile: process.env.AI_REPORT_FILE || 'data/ai-reports.json',
  aiMetricsHistoryFile: process.env.AI_METRICS_HISTORY_FILE || 'data/ai-metrics-history.json',
  syncIntervalMs: num('BI_SYNC_INTERVAL_MS', 10 * 60 * 1000),
  syncLookbackDays: num('BI_SYNC_LOOKBACK_DAYS', 30),
  dashboardCacheTtlMs: num('DASHBOARD_CACHE_TTL_MS', 5 * 60 * 1000),
  aiEnabled: !DEMO_MODE && process.env.AI_INSIGHTS_ENABLED !== '0',
  aiModel: process.env.AI_MODEL || 'bitrix/openai/gpt-oss-120b',
  aiMaxTokens: num('AI_MAX_TOKENS', 4000),
  aiReportMaxTokens: num('AI_REPORT_MAX_TOKENS', 8000),
  aiTimeoutMs: num('AI_TIMEOUT_MS', 90000),
  aiInsightsTtlMs: num('AI_INSIGHTS_TTL_MS', 30 * 60 * 1000),
  aiReportsTtlMs: num('AI_REPORTS_TTL_MS', 30 * 60 * 1000),
  // Периодические отчёты: тот же провайдер-механизм, что и чат. По умолчанию — VibeCode-роутер (gpt-oss).
  // Чтобы отчёты делал Opus — AI_REPORT_PROVIDER=openai + AI_REPORT_MODEL (база/ключ наследуются от чата).
  aiReportProvider: process.env.AI_REPORT_PROVIDER || 'router',
  aiReportModel: process.env.AI_REPORT_MODEL || '',
  aiReportBaseUrl: process.env.AI_REPORT_BASE_URL || process.env.AI_CHAT_BASE_URL || '',
  aiReportApiKey: process.env.AI_REPORT_API_KEY || process.env.AI_CHAT_API_KEY || '',
  // «Глубокий разбор сделки» — тот же провайдер/модель, что и чат; больше токенов на стратегию и
  // больше таймаут (тяжёлый ответ на 6000 токенов дольше обычного чата).
  aiDealAnalysisMaxTokens: num('AI_DEAL_ANALYSIS_MAX_TOKENS', 6000),
  aiDealAnalysisTimeoutMs: num('AI_DEAL_ANALYSIS_TIMEOUT_MS', 120000),
  // Чат-вопросы по данным (Claude): провайдер — 'router' (VibeCode), 'anthropic' (api.anthropic.com)
  // или 'openai' (любой OpenAI-совместимый шлюз: polza.ai, OpenRouter и т.п. — Bearer + свой base URL).
  aiChatProvider: process.env.AI_CHAT_PROVIDER || 'router',
  aiChatModel: process.env.AI_CHAT_MODEL || 'anthropic/claude-sonnet-4.5',
  aiChatMaxTokens: num('AI_CHAT_MAX_TOKENS', 4000),
  aiChatTimeoutMs: num('AI_CHAT_TIMEOUT_MS', 60000),
  // Для провайдера 'openai' (OpenAI-совместимый шлюз):
  aiChatBaseUrl: process.env.AI_CHAT_BASE_URL || '',
  aiChatApiKey: process.env.AI_CHAT_API_KEY || '',
  // Путь баланса polza — по докам GET {base}/balance → { amount: "<рубли строкой>" }. Переопределяется через env.
  polzaBalancePath: process.env.POLZA_BALANCE_PATH || '/balance',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1',
  anthropicVersion: process.env.ANTHROPIC_VERSION || '2023-06-01',
  // Доставка отчётов: пусто = канал отключён (no-op).
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  bitrixWebhookUrl: process.env.BITRIX_WEBHOOK_URL || '',
  // Портал Битрикс для ссылок в карточку сделки: https://<portal>/crm/deal/details/<id>/
  bitrixPortalUrl: (process.env.BITRIX_PORTAL_URL || 'https://example.bitrix24.ru').replace(/\/+$/, '')
};

export const RUB = 'RUB';
export const DEAL_CATEGORY_2D_BIM = 78;

// Деградация конфигурации: без ключа VibeCode синк не запустится (см. scheduler.js),
// кэш останется пустым — приложение поднимается, но /ready честно отдаёт 503.
export const configDegraded = !config.vibeApiKey;
