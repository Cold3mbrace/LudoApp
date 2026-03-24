import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const app = express();
const PORT = Number(process.env.PORT || 8787);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
const STEAM_WEB_API_KEY = process.env.STEAM_WEB_API_KEY || "";

const DATA_DIR = path.join(process.cwd(), "..", ".ludo-data");
const USERS_DIR = path.join(DATA_DIR, "users");
const PRICES_DIR = path.join(DATA_DIR, "prices");
const NEWS_DIR = path.join(DATA_DIR, "news");
const REF_INDEX_PATH = path.join(DATA_DIR, "referral-index.json");
const TICKETS_PATH = path.join(DATA_DIR, "tickets.json");
const SERVER_ADMIN_IDS = new Set([793655800, 1069618912]);

const PRICE_TTL_MS = 1000 * 60 * 60 * 6;
const PRICE_HISTORY_MIN_INTERVAL_MS = 1000 * 60 * 60 * 12;
const INVENTORY_TTL_MS = 1000 * 60 * 12;
const NEWS_TTL_MS = 1000 * 60 * 30;
const WEEK_MS = 1000 * 60 * 60 * 24 * 7;
const PRICE_REFRESH_BATCH_LIMIT = 8;
const PRICE_FETCH_DELAY_MS = 900;
const MARKET_429_COOLDOWN_MS = 1000 * 60 * 20;

let marketCooldownUntil = 0;


app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json({ limit: "1mb" }));

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, data) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function hostFromUrl(value = "") {
  try {
    return new URL(String(value || "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isTrustedFullArticleHost(value = "") {
  const host = hostFromUrl(value).replace(/^www\./, "");
  return [
    "steamcommunity.com",
    "counter-strike.net",
    "blog.counter-strike.net",
    "store.steampowered.com",
    "stopgame.ru",
    "playground.ru",
    "cybersport.ru",
  ].some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function ticketId() {
  return `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeAdminId(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

async function readTickets() {
  const raw = await readJson(TICKETS_PATH, { items: [] });
  return Array.isArray(raw?.items) ? raw.items : [];
}

async function writeTickets(items) {
  await writeJson(TICKETS_PATH, { items });
  return items;
}

function compactText(value = "", max = 2000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function fileSafe(value = "") {
  return encodeURIComponent(String(value || "")).replace(/%/g, "_").slice(0, 180) || "item";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayStr() {
  return new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString().slice(0, 10);
}

function parseDateMaybe(value) {
  const ts = Date.parse(value || "");
  return Number.isFinite(ts) ? ts : null;
}

function stripHtml(value = "") {
  return String(value || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/\[img\][\s\S]*?\[\/img\]/gi, " ")
    .replace(/\[\/?(p|h\d|list|\*|quote|code|b|i|u|url)[^\]]*\]/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function decodeHtml(value = "") {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

const ARTICLE_JUNK_PATTERNS = [
  /получайте\s+бонусы\s+за\s+активность/i,
  /скачивайте\s+файлы\s+без\s+ожидания/i,
  /подписывайтесь\s+на\s+любимые\s+игры/i,
  /пожалуйста[,\s]+введите\s+ваш\s+e-?mail/i,
  /процедур[ауы]\s+восстановлен/i,
  /проверочн(?:ый|ым)\s+код/i,
  /не\s+получили\s+письмо/i,
  /повторная\s+отправка\s+письма/i,
  /папк[ау]\s+со\s+спамом/i,
  /правильн(?:о|ый)\s+ли\s+указан\s+адрес/i,
  /соглашаетесь\s+с\s+правилами/i,
  /политик[а-я\s]+конфиденциальности/i,
  /чтобы\s+зарегистрироваться/i,
  /чтобы\s+начать\s+процедуру\s+восстановления/i,
  /ваш\s+e-?mail[:\s]/i,
  /under_text_money/i,
  /max-height\s*:/i,
  /max-width\s*:/i,
  /@media\s*\(/i,
  /все\s+наши\s+новости\s+в\s+телеграм\s+канале/i,
  /лучшие\s+комментарии/i,
  /предыдущая/i,
  /следующая/i,
  /мой\s+статус/i,
  /моя\s+оценка/i,
  /очистить/i,
];

function removeArticleJunk(value = "") {
  const text = String(value || "");
  const parts = text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !ARTICLE_JUNK_PATTERNS.some((pattern) => pattern.test(part)));

  return parts
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isArticleMostlyJunk(value = "") {
  const text = String(value || "").trim();
  if (!text) return true;

  const hits = ARTICLE_JUNK_PATTERNS.filter((pattern) => pattern.test(text)).length;
  if (hits >= 2) return true;

  const lowered = text.toLowerCase();
  const emailLike =
    (lowered.match(/e-?mail/g) || []).length +
    (lowered.match(/восстановлен/g) || []).length +
    (lowered.match(/письм/g) || []).length;

  return emailLike >= 3;
}

const CYBERSPORT_JUNK_PATTERNS = [
  /спецпроекты/i,
  /киберкалендар/i,
  /наш\s+тг/i,
  /главные\s+новости/i,
  /прошедшие\s+live/i,
  /будущие/i,
  /все\s+матчи/i,
  /материалы\s+по\s+теме/i,
  /рубрики/i,
  /реклама\s*18\+/i,
  /лучшие\s+комментарии/i,
  /комментарии$/i,
  /предыдущая/i,
  /следующая/i,
  /участвовать/i,
  /забрать/i,
  /перейти/i,
];

function isCybersportBoilerplate(value = "") {
  const text = compactText(String(value || ""));
  if (!text) return true;
  const hits = CYBERSPORT_JUNK_PATTERNS.filter((pattern) => pattern.test(text)).length;
  return hits >= 2 || text.length < 40;
}

function sanitizePreviewBody(value = "", fallback = "") {
  const cleaned = cleanupArticleText(String(value || ""))
    .replace(/\s*Читай также[\s\S]*$/i, " ")
    .replace(/\s*Материалы по теме[\s\S]*$/i, " ")
    .replace(/\s*Лучшие комментарии[\s\S]*$/i, " ")
    .trim();

  if (!cleaned || isArticleMostlyJunk(cleaned) || isCybersportBoilerplate(cleaned)) {
    return fallback.trim();
  }

  return compactText(cleaned).slice(0, 420).trim();
}


function cleanNewsUrl(value = "") {
  return String(value || "")
    .split("#")[0]
    .replace(/[?&](utm_[^=&]+|ref|source)=[^&]+/gi, "")
    .replace(/[?&]$/, "")
    .trim();
}

function normalizeNewsFingerprint(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-zа-яё0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function newsKey(item = {}) {
  if (item.url) return `url:${cleanNewsUrl(item.url)}`;
  const title = normalizeNewsFingerprint(item.title || "");
  const body = normalizeNewsFingerprint(item.body || "").slice(0, 180);
  return `text:${title}::${body}`;
}

function clipNewsWeek(items = []) {
  const limitTs = Math.floor((Date.now() - WEEK_MS) / 1000);
  return items
    .filter((item) => Number(item?.createdAt || 0) >= limitTs)
    .sort((a, b) => Number(b?.createdAt || 0) - Number(a?.createdAt || 0));
}

function dedupeNewsItems(items = []) {
  const map = new Map();
  for (const item of items) {
    if (!item) continue;
    const key = newsKey(item);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, item);
      continue;
    }
    const existingScore = (existing.imageUrl ? 1 : 0) + Math.min(String(existing.body || "").length, 1200) / 1200 + Number(existing.createdAt || 0) / 10_000_000_000;
    const nextScore = (item.imageUrl ? 1 : 0) + Math.min(String(item.body || "").length, 1200) / 1200 + Number(item.createdAt || 0) / 10_000_000_000;
    if (nextScore > existingScore) map.set(key, item);
  }
  return clipNewsWeek([...map.values()]);
}

const newsJobs = new Map();

async function runNewsJob(key, worker) {
  if (newsJobs.has(key)) return newsJobs.get(key);
  const job = Promise.resolve()
    .then(worker)
    .finally(() => newsJobs.delete(key));
  newsJobs.set(key, job);
  return job;
}

function hasCyrillic(value = "") {
  return /[А-Яа-яЁё]/.test(value);
}

function chunkText(text, maxLen = 3000) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf("\n", maxLen);
    if (cut < maxLen * 0.4) cut = rest.lastIndexOf(". ", maxLen);
    if (cut < maxLen * 0.4) cut = maxLen;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

async function translateTextToRu(text = "") {
  const clean = String(text || "").trim();
  if (!clean) return "";
  if (hasCyrillic(clean)) return clean;

  const chunks = chunkText(clean, 2500);
  const translated = [];

  for (const chunk of chunks) {
    try {
      const url =
        "https://translate.googleapis.com/translate_a/single?" +
        new URLSearchParams({
          client: "gtx",
          sl: "auto",
          tl: "ru",
          dt: "t",
          q: chunk,
        });

      const response = await fetch(url, {
        headers: { "User-Agent": "LUDO-app local dev server" },
      });

      if (!response.ok) {
        translated.push(chunk);
        continue;
      }

      const data = await response.json();
      const sentence = Array.isArray(data?.[0])
        ? data[0].map((part) => (Array.isArray(part) ? part[0] : "")).join("")
        : chunk;

      translated.push(sentence || chunk);
      await sleep(120);
    } catch {
      translated.push(chunk);
    }
  }

  return translated.join(" ").replace(/\s{2,}/g, " ").trim();
}

function defaultUserState(key) {
  return {
    key,
    savedNewsIds: [],
    watchlist: [],
    settings: {
      notifications: true,
      quietHours: {
        enabled: true,
        start: "23:00",
        end: "09:00",
      },
      dailyReminder: true,
    },
    daily: {
      streak: 0,
      lastCheckinDate: null,
      reminderEnabled: true,
      lastReward: null,
    },
    referral: {
      code: buildReferralCode(key),
      clicks: 0,
      verified: 0,
      points: 0,
      attachedRefCode: null,
      attachedAt: null,
    },
    steam: {
      input: "",
      steamid: "",
      personaname: "",
      avatarfull: null,
    },
    updatedAt: 0,
  };
}

function mergeUserState(current, incoming) {
  const base = current || defaultUserState(incoming?.key || "guest");
  return {
    key: incoming?.key || base.key,
    savedNewsIds: Array.isArray(incoming?.savedNewsIds) ? incoming.savedNewsIds.slice(0, 300) : base.savedNewsIds,
    watchlist: Array.isArray(incoming?.watchlist) ? incoming.watchlist.slice(0, 300) : base.watchlist,
    settings: {
      notifications: typeof incoming?.settings?.notifications === "boolean" ? incoming.settings.notifications : base.settings.notifications,
      quietHours: {
        enabled: typeof incoming?.settings?.quietHours?.enabled === "boolean"
          ? incoming.settings.quietHours.enabled
          : base.settings.quietHours.enabled,
        start: typeof incoming?.settings?.quietHours?.start === "string" && incoming.settings.quietHours.start
          ? incoming.settings.quietHours.start
          : base.settings.quietHours.start,
        end: typeof incoming?.settings?.quietHours?.end === "string" && incoming.settings.quietHours.end
          ? incoming.settings.quietHours.end
          : base.settings.quietHours.end,
      },
      dailyReminder: typeof incoming?.settings?.dailyReminder === "boolean"
        ? incoming.settings.dailyReminder
        : base.settings.dailyReminder,
    },
    daily: {
      streak: Number.isFinite(Number(incoming?.daily?.streak)) ? Number(incoming.daily.streak) : base.daily.streak,
      lastCheckinDate: typeof incoming?.daily?.lastCheckinDate === "string" || incoming?.daily?.lastCheckinDate === null
        ? incoming.daily.lastCheckinDate
        : base.daily.lastCheckinDate,
      reminderEnabled: typeof incoming?.daily?.reminderEnabled === "boolean"
        ? incoming.daily.reminderEnabled
        : base.daily.reminderEnabled,
      lastReward: typeof incoming?.daily?.lastReward === "string" || incoming?.daily?.lastReward === null
        ? incoming.daily.lastReward
        : base.daily.lastReward,
    },
    referral: {
      code: typeof incoming?.referral?.code === "string" && incoming.referral.code
        ? incoming.referral.code
        : base.referral.code,
      clicks: Number.isFinite(Number(incoming?.referral?.clicks)) ? Number(incoming.referral.clicks) : base.referral.clicks,
      verified: Number.isFinite(Number(incoming?.referral?.verified)) ? Number(incoming.referral.verified) : base.referral.verified,
      points: Number.isFinite(Number(incoming?.referral?.points)) ? Number(incoming.referral.points) : base.referral.points,
      attachedRefCode: typeof incoming?.referral?.attachedRefCode === "string" || incoming?.referral?.attachedRefCode === null
        ? incoming.referral.attachedRefCode
        : base.referral.attachedRefCode,
      attachedAt: typeof incoming?.referral?.attachedAt === "number" || incoming?.referral?.attachedAt === null
        ? incoming.referral.attachedAt
        : base.referral.attachedAt,
    },
    steam: {
      input: typeof incoming?.steam?.input === "string" ? incoming.steam.input : base.steam.input,
      steamid: typeof incoming?.steam?.steamid === "string" ? incoming.steam.steamid : base.steam.steamid,
      personaname: typeof incoming?.steam?.personaname === "string" ? incoming.steam.personaname : base.steam.personaname,
      avatarfull: typeof incoming?.steam?.avatarfull === "string" || incoming?.steam?.avatarfull === null
        ? incoming.steam.avatarfull
        : base.steam.avatarfull,
    },
    updatedAt: Date.now(),
  };
}

function buildReferralCode(key) {
  const short = crypto.createHash("sha1").update(String(key || "guest")).digest("hex").slice(0, 8).toUpperCase();
  return `LUDO${short}`;
}

function userStatePath(key) {
  return path.join(USERS_DIR, `${fileSafe(key)}.json`);
}

async function readUserState(key) {
  const fallback = defaultUserState(key);
  const raw = await readJson(userStatePath(key), fallback);
  const merged = mergeUserState(fallback, raw);
  if (!raw?.referral?.code) {
    await writeUserState(key, merged);
  }
  return merged;
}

async function writeUserState(key, incoming) {
  const current = await readJson(userStatePath(key), defaultUserState(key));
  const merged = mergeUserState(current, { ...incoming, key });
  await writeJson(userStatePath(key), merged);
  await upsertReferralIndex(key, merged.referral.code);
  return merged;
}

async function readReferralIndex() {
  return readJson(REF_INDEX_PATH, {});
}

async function upsertReferralIndex(key, code) {
  if (!code) return;
  const index = await readReferralIndex();
  index[code] = key;
  await writeJson(REF_INDEX_PATH, index);
}

async function findKeyByReferralCode(code) {
  if (!code) return null;
  const index = await readReferralIndex();
  return typeof index?.[code] === "string" ? index[code] : null;
}

function normalizeSteamInput(value = "") {
  let input = String(value || "").trim();

  if (!input) {
    throw new Error("Вставь ссылку на профиль Steam.");
  }

  if (/^steamcommunity\.com\//i.test(input)) {
    input = `https://${input}`;
  }

  if (/^(id|profiles)\//i.test(input)) {
    input = `https://steamcommunity.com/${input}`;
  }

  const rawIdMatch = input.match(/^(\d{17})$/);
  if (rawIdMatch) {
    return {
      type: "steamid64",
      steamId: rawIdMatch[1],
      profileUrl: `https://steamcommunity.com/profiles/${rawIdMatch[1]}`,
    };
  }

  const profileMatch = input.match(/steamcommunity\.com\/profiles\/(\d{17})/i);
  if (profileMatch) {
    return {
      type: "profiles",
      steamId: profileMatch[1],
      profileUrl: `https://steamcommunity.com/profiles/${profileMatch[1]}`,
    };
  }

  const vanityMatch = input.match(/steamcommunity\.com\/id\/([^/?#]+)/i);
  if (vanityMatch) {
    return {
      type: "vanity",
      vanity: vanityMatch[1],
      profileUrl: `https://steamcommunity.com/id/${vanityMatch[1]}`,
    };
  }

  throw new Error("Не понял ссылку. Вставь обычную ссылку на Steam-профиль.");
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 LUDO-app",
      Accept: "text/html,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status}`);
  }
  return response.text();
}



const ARTICLE_TAIL_MARKERS = [
  /^Читай также\b/im,
  /^Все наши новости в телеграм канале\b/im,
  /^Наши новости в телеграм канале\b/im,
  /^Предыдущая\b/im,
  /^Следующая\b/im,
  /^Платформы\b/im,
  /^Теги\b/im,
  /^Дата выхода\b/im,
  /^Мой статус\b/im,
  /^Уведомления\b/im,
  /^Моя оценка\b/im,
  /^Лучшие комментарии\b/im,
  /^Главные новости\b/im,
  /^Материалы по теме\b/im,
  /^Спецпроекты\b/im,
  /^Рубрики\b/im,
  /^Комментарии\b/im,
];

function trimArticleTail(value = "") {
  const text = String(value || "");
  let cut = text.length;
  for (const pattern of ARTICLE_TAIL_MARKERS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match && typeof match.index === "number") {
      cut = Math.min(cut, match.index);
    }
  }
  return text.slice(0, cut).trim();
}

function extractExactArticleBlock(html = "", url = "") {
  const source = String(html || "");
  const host = hostFromUrl(url).replace(/^www\./, "");

  const pick = (regex) => {
    const match = source.match(regex);
    if (!match) return "";
    const body = cleanupArticleText(match[1] || "");
    const trimmed = trimArticleTail(body);
    return isArticleMostlyJunk(trimmed) ? "" : trimmed;
  };

  if (host.endsWith("playground.ru")) {
    return (
      pick(/<div[^>]+class=["'][^"']*\barticle-content\b[^"']*\bjs-post-item-content\b[^"']*\bjs-redirect\b[^"']*["'][^>]*>([\s\S]*?)<\/article>/i) ||
      pick(/<div[^>]+class=["'][^"']*\barticle-content\b[^"']*["'][^>]*>([\s\S]*?)<div[^>]+class=["'][^"']*\barticle-content-prefooter\b[^"']*["']/i)
    );
  }

  if (host.endsWith("cybersport.ru")) {
    return (
      pick(/<div[^>]+class=["'][^"']*\barticle-content\b[^"']*["'][^>]*>([\s\S]*?)<\/article>/i) ||
      pick(/<div[^>]+class=["'][^"']*\bmaterial-content\b[^"']*["'][^>]*>([\s\S]*?)<\/article>/i) ||
      pick(/<div[^>]+class=["'][^"']*\bnews-content\b[^"']*["'][^>]*>([\s\S]*?)<\/article>/i)
    );
  }

  if (host.endsWith("stopgame.ru")) {
    return (
      pick(/<div[^>]+class=["'][^"']*\barticle-content\b[^"']*["'][^>]*>([\s\S]*?)<\/article>/i) ||
      pick(/<div[^>]+class=["'][^"']*\btext-article\b[^"']*["'][^>]*>([\s\S]*?)<\/article>/i) ||
      pick(/<div[^>]+class=["'][^"']*\bmaterial-page__content\b[^"']*["'][^>]*>([\s\S]*?)<\/article>/i)
    );
  }

  return "";
}

function cleanupArticleText(value = "") {
  const cleaned = removeArticleJunk(
    stripHtml(String(value || ""))
      .replace(/Читать далее/gi, " ")
      .replace(/Источник:.*$/gim, " ")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\s*\.[\w-]+\s*\{[^}]*\}\s*$/gim, " ")
      .replace(/^\s*@media[^{]+\{[^}]*\}\s*$/gim, " ")
  );

  return trimArticleTail(cleaned).trim();
}

function extractArticleText(html = "", url = "") {
  const exact = extractExactArticleBlock(html, url);
  if (exact && exact.length >= 180) {
    return exact;
  }

  const candidates = [];

  const pushMatches = (regex) => {
    for (const match of String(html || "").matchAll(regex)) {
      const text = trimArticleTail(cleanupArticleText(match[1] || ""));
      if (text && text.length > 120 && !isArticleMostlyJunk(text)) candidates.push(text);
    }
  };

  if (/playground\.ru/i.test(url)) {
    pushMatches(/<div[^>]+class=["'][^"']*(?:article-content|news-text|content-block|story-content)[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi);
  }

  if (/stopgame\.ru/i.test(url)) {
    pushMatches(/<div[^>]+class=["'][^"']*(?:article-content|text-article|news-detail|material-page__content)[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi);
  }

  if (/cybersport\.ru/i.test(url)) {
    pushMatches(/<div[^>]+class=["'][^"']*(?:article-content|news-content|material-content)[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi);
  }

  pushMatches(/<article[^>]*>([\s\S]*?)<\/article>/gi);

  const paragraphMatches = [...String(html || "").matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => trimArticleTail(cleanupArticleText(match[1] || "")))
    .filter((part) => part.length > 40 && !isArticleMostlyJunk(part));
  if (paragraphMatches.length >= 3) {
    candidates.push(trimArticleTail(paragraphMatches.join("\n\n")));
  }

  const best = candidates
    .map((item) => item.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0] || "";

  return best.length >= 180 ? best : "";
}

function extractFirstImage(html = "", fallbackBase = "") {
  const bbcodeMatch = html.match(/\[img\]([^\[]+)\[\/img\]/i);
  let src = bbcodeMatch?.[1] || html.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] || "";
  if (!src) return null;
  src = src.trim();
  if (src.startsWith("//")) return `https:${src}`;
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith("/")) {
    try {
      const base = new URL(fallbackBase || "https://store.steampowered.com");
      return `${base.origin}${src}`;
    } catch {
      return `https://store.steampowered.com${src}`;
    }
  }
  return src;
}

function parseSteamXml(xml = "", profileUrl = "") {
  const steamId = xml.match(/<steamID64>(\d{17})<\/steamID64>/i)?.[1] || "";
  const personaname = decodeHtml(xml.match(/<steamID><!\[CDATA\[(.*?)\]\]><\/steamID>/i)?.[1] || "");
  const avatarfull = decodeHtml(xml.match(/<avatarFull><!\[CDATA\[(.*?)\]\]><\/avatarFull>/i)?.[1] || "");

  if (!steamId) return null;

  return {
    steamId,
    profile: {
      steamid: steamId,
      personaname: personaname || "Steam player",
      avatarfull: avatarfull || null,
      profileurl: profileUrl || `https://steamcommunity.com/profiles/${steamId}`,
    },
  };
}

function parseSteamHtml(html = "", profileUrl = "") {
  const steamId =
    html.match(/g_steamID\s*=\s*"(\d{17})"/i)?.[1] ||
    html.match(/"steamid"\s*:\s*"(\d{17})"/i)?.[1] ||
    html.match(/profiles\/(\d{17})/i)?.[1] ||
    "";

  const personaname = decodeHtml(
    html.match(/class="actual_persona_name"[^>]*>(.*?)<\/span>/i)?.[1] ||
      html.match(/<title>\s*(.*?)\s*:: Steam Community/i)?.[1] ||
      ""
  );

  const avatarfull =
    html.match(/property="og:image" content="([^"]+)"/i)?.[1] ||
    html.match(/playerAvatarAutoSizeInner[^>]*>\s*<img[^>]+src="([^"]+)"/i)?.[1] ||
    null;

  if (!steamId) return null;

  return {
    steamId,
    profile: {
      steamid: steamId,
      personaname: personaname || "Steam player",
      avatarfull,
      profileurl: profileUrl || `https://steamcommunity.com/profiles/${steamId}`,
    },
  };
}

async function scrapeSteamProfile(profileUrl) {
  const xmlUrl = profileUrl.includes("?") ? `${profileUrl}&xml=1` : `${profileUrl}/?xml=1`;

  try {
    const xml = await fetchText(xmlUrl);
    const parsedXml = parseSteamXml(xml, profileUrl);
    if (parsedXml?.steamId) return parsedXml;
  } catch {}

  const html = await fetchText(profileUrl);
  const parsedHtml = parseSteamHtml(html, profileUrl);
  if (parsedHtml?.steamId) return parsedHtml;

  throw new Error("Не удалось вытащить Steam-профиль по ссылке.");
}

async function resolveSteamProfile(input) {
  const normalized = normalizeSteamInput(input);

  if (normalized.steamId) {
    const scraped = await scrapeSteamProfile(normalized.profileUrl);
    return {
      steamId: normalized.steamId,
      profileUrl: normalized.profileUrl,
      profile: scraped?.profile || null,
    };
  }

  if (normalized.type === "vanity") {
    if (STEAM_WEB_API_KEY) {
      try {
        const url =
          "https://partner.steam-api.com/ISteamUser/ResolveVanityURL/v1/?" +
          new URLSearchParams({
            key: STEAM_WEB_API_KEY,
            vanityurl: normalized.vanity,
            format: "json",
          });
        const response = await fetch(url);
        if (response.ok) {
          const data = await response.json();
          const steamId = data?.response?.steamid;
          if (steamId) {
            const profile = await scrapeSteamProfile(`https://steamcommunity.com/profiles/${steamId}`);
            return {
              steamId,
              profileUrl: `https://steamcommunity.com/profiles/${steamId}`,
              profile: profile?.profile || null,
            };
          }
        }
      } catch {}
    }

    const scraped = await scrapeSteamProfile(normalized.profileUrl);
    return {
      steamId: scraped.steamId,
      profileUrl: normalized.profileUrl,
      profile: scraped.profile,
    };
  }

  throw new Error("Не удалось разобрать Steam-профиль.");
}

async function getPlayerSummary(steamId, fallbackUrl = "") {
  if (STEAM_WEB_API_KEY) {
    try {
      const url =
        "https://partner.steam-api.com/ISteamUser/GetPlayerSummaries/v2/?" +
        new URLSearchParams({
          key: STEAM_WEB_API_KEY,
          steamids: steamId,
          format: "json",
        });
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        const player = data?.response?.players?.[0] || null;
        if (player) return player;
      }
    } catch {}
  }

  if (fallbackUrl) {
    try {
      const scraped = await scrapeSteamProfile(fallbackUrl);
      return scraped.profile;
    } catch {}
  }

  return null;
}

async function fetchInventoryOnce(steamId, count) {
  const url = `https://steamcommunity.com/inventory/${steamId}/730/2?l=english&count=${count}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "LUDO-app local dev server",
      Accept: "application/json, text/plain, */*",
    },
  });

  if (!response.ok) {
    throw new Error(`Steam inventory failed: ${response.status}`);
  }

  const text = await response.text();
  if (!text || text.trim() === "" || text.trim() === "null") {
    throw new Error("Steam вернул null вместо inventory.");
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Steam вернул не-JSON ответ по inventory.");
  }

  if (!data || data.success !== 1) {
    throw new Error(data?.error || "Steam вернул неуспешный inventory payload.");
  }

  return data;
}

function inventoryCachePath(steamId) {
  return path.join(USERS_DIR, `steam-${fileSafe(steamId)}-inventory.json`);
}

async function getInventory(steamId, { force = false } = {}) {
  const cachePath = inventoryCachePath(steamId);
  const cached = await readJson(cachePath, null);
  if (!force && cached?.updatedAt && Date.now() - cached.updatedAt < INVENTORY_TTL_MS) {
    return { payload: cached.payload, cached: true, stale: false };
  }

  const counts = [2000, 1000, 500, 200];
  let lastError = null;

  for (const count of counts) {
    try {
      const payload = await fetchInventoryOnce(steamId, count);
      await writeJson(cachePath, { updatedAt: Date.now(), payload });
      return { payload, cached: false, stale: false };
    } catch (error) {
      lastError = error;
      console.warn(`[inventory] steamId=${steamId} count=${count} -> ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (cached?.payload) {
    return { payload: cached.payload, cached: true, stale: true };
  }

  throw lastError || new Error("Не удалось загрузить Steam inventory.");
}


function isMarketCoolingDown() {
  return Date.now() < marketCooldownUntil;
}

function activateMarketCooldown() {
  marketCooldownUntil = Date.now() + MARKET_429_COOLDOWN_MS;
}

function computePricePayloadFromCache(cached, marketHashName) {
  const history = Array.isArray(cached?.history) ? cached.history : [];
  const last = history[history.length - 1];
  const prev = history[history.length - 2];
  const deltaPct = last && prev && prev.value > 0 ? ((last.value - prev.value) / prev.value) * 100 : 0;
  return {
    marketHashName,
    price: Number(cached?.lastValue || 0),
    history,
    deltaPct,
    cached: true,
    stale: true,
  };
}

async function readPriceCache(marketHashName) {
  const filePath = path.join(PRICES_DIR, `${fileSafe(marketHashName)}.json`);
  return readJson(filePath, null);
}

function parsePriceString(value) {
  if (!value) return 0;
  let clean = String(value).replace(/[^\d,.\-]/g, "");
  if (!clean) return 0;

  const hasComma = clean.includes(",");
  const hasDot = clean.includes(".");

  if (hasComma && hasDot) {
    if (clean.lastIndexOf(",") > clean.lastIndexOf(".")) {
      clean = clean.replace(/\./g, "").replace(",", ".");
    } else {
      clean = clean.replace(/,/g, "");
    }
  } else if (hasComma && !hasDot) {
    clean = clean.replace(",", ".");
  }

  const numeric = Number(clean);
  return Number.isFinite(numeric) ? numeric : 0;
}

async function upsertPriceHistory(marketHashName, value) {
  const filePath = path.join(PRICES_DIR, `${fileSafe(marketHashName)}.json`);
  const current = await readJson(filePath, {
    marketHashName,
    lastValue: 0,
    updatedAt: 0,
    history: [],
  });

  const next = {
    marketHashName,
    lastValue: value,
    updatedAt: Date.now(),
    history: Array.isArray(current.history) ? current.history : [],
  };

  const lastPoint = next.history[next.history.length - 1];
  if (!lastPoint || Math.abs(lastPoint.value - value) >= 0.01 || Date.now() - lastPoint.ts > PRICE_HISTORY_MIN_INTERVAL_MS) {
    next.history.push({ ts: Date.now(), value });
    next.history = next.history.slice(-500);
  }

  await writeJson(filePath, next);
  return next;
}

async function getPriceSnapshot(marketHashName) {
  const cached = await readPriceCache(marketHashName);

  if (cached?.updatedAt && Date.now() - cached.updatedAt < PRICE_TTL_MS) {
    const history = Array.isArray(cached.history) ? cached.history : [];
    const last = history[history.length - 1];
    const prev = history[history.length - 2];
    const deltaPct = last && prev && prev.value > 0 ? ((last.value - prev.value) / prev.value) * 100 : 0;
    return {
      marketHashName,
      price: Number(cached.lastValue || 0),
      history,
      deltaPct,
      cached: true,
      stale: false,
    };
  }

  if (isMarketCoolingDown()) {
    if (cached) return computePricePayloadFromCache(cached, marketHashName);
    return { marketHashName, price: 0, history: [], deltaPct: 0, cached: false, stale: true, skipped: "cooldown" };
  }

  const url =
    "https://steamcommunity.com/market/priceoverview/?" +
    new URLSearchParams({
      appid: "730",
      currency: "1",
      country: "US",
      market_hash_name: marketHashName,
    });

  const response = await fetch(url, {
    headers: {
      "User-Agent": "LUDO-app local dev server",
      Accept: "application/json, text/plain, */*",
    },
  });

  if (response.status === 429) {
    activateMarketCooldown();
    if (cached) return computePricePayloadFromCache(cached, marketHashName);
    return { marketHashName, price: 0, history: [], deltaPct: 0, cached: false, stale: true, skipped: "rate_limited" };
  }

  if (!response.ok) {
    if (cached) return computePricePayloadFromCache(cached, marketHashName);
    throw new Error(`Steam market price failed: ${response.status}`);
  }

  const data = await response.json();
  if (!data?.success) {
    if (cached) return computePricePayloadFromCache(cached, marketHashName);
    return { marketHashName, price: 0, history: [], deltaPct: 0, cached: false, stale: true };
  }

  const parsed = parsePriceString(data.lowest_price) || parsePriceString(data.median_price) || 0;
  const historyRecord = await upsertPriceHistory(marketHashName, parsed);
  const history = Array.isArray(historyRecord.history) ? historyRecord.history : [];
  const last = history[history.length - 1];
  const prev = history[history.length - 2];
  const deltaPct = last && prev && prev.value > 0 ? ((last.value - prev.value) / prev.value) * 100 : 0;
  await sleep(PRICE_FETCH_DELAY_MS);

  return {
    marketHashName,
    price: parsed,
    history,
    deltaPct,
    cached: false,
    stale: false,
  };
}

async function mapWithConcurrency(items, worker, concurrency = 3) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index], index);
    }
  }

  const workers = new Array(Math.min(concurrency, items.length)).fill(0).map(() => run());
  await Promise.all(workers);
  return results;
}

function buildInventoryItems(payload, priceMap = {}) {
  const descriptions = new Map(
    (payload.descriptions || []).map((description) => [
      `${description.classid}_${description.instanceid}`,
      description,
    ])
  );

  const items = (payload.assets || []).map((asset, index) => {
    const description = descriptions.get(`${asset.classid}_${asset.instanceid}`);
    const marketHashName = description?.market_hash_name || description?.name || `Item ${index + 1}`;
    const priceMeta = priceMap[marketHashName] || { price: 0, history: [], deltaPct: 0 };
    const quantity = Number(asset.amount || 1) || 1;

    return {
      id: asset.assetid || `${marketHashName}-${index}`,
      marketHashName,
      name: description?.market_hash_name || description?.name || `Предмет #${index + 1}`,
      type: description?.type || "Steam item",
      iconUrl: description?.icon_url
        ? `https://community.cloudflare.steamstatic.com/economy/image/${description.icon_url}/256fx256f`
        : null,
      tradable: Boolean(description?.tradable),
      marketable: Boolean(description?.marketable),
      quantity,
      price: Number(priceMeta.price || 0),
      totalValue: Number(priceMeta.price || 0) * quantity,
      deltaPct: Number(priceMeta.deltaPct || 0),
      history: Array.isArray(priceMeta.history) ? priceMeta.history : [],
      note: description?.type || "Предмет из Steam-инвентаря",
      descriptionText: Array.isArray(description?.descriptions)
        ? description.descriptions
            .map((entry) => stripHtml(entry?.value || ""))
            .filter(Boolean)
            .join(" · ")
        : "",
    };
  });


  return items.sort((a, b) => b.totalValue - a.totalValue || a.name.localeCompare(b.name));
}

function buildPriceRefreshPlan(descriptions = []) {
  const seen = new Set();
  const names = [];

  for (const entry of descriptions) {
    const name = entry?.market_hash_name || entry?.name;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    if (entry?.marketable !== 1 && entry?.marketable !== true) continue;
    names.push(name);
  }

  return names;
}

async function resolvePriceMap(uniqueNames = []) {
  const priceMap = {};
  const refreshTargets = [];

  for (const name of uniqueNames) {
    const cached = await readPriceCache(name);
    if (cached) {
      priceMap[name] = computePricePayloadFromCache(cached, name);
      const isFresh = cached?.updatedAt && Date.now() - cached.updatedAt < PRICE_TTL_MS;
      if (!isFresh) refreshTargets.push(name);
      continue;
    }
    refreshTargets.push(name);
  }

  const batch = isMarketCoolingDown()
    ? []
    : refreshTargets.slice(0, PRICE_REFRESH_BATCH_LIMIT);

  const refreshed = await mapWithConcurrency(
    batch,
    async (name) => {
      try {
        return [name, await getPriceSnapshot(name)];
      } catch (error) {
        console.warn("[price]", name, error instanceof Error ? error.message : String(error));
        return [name, priceMap[name] || { marketHashName: name, price: 0, history: [], deltaPct: 0, stale: true }];
      }
    },
    1
  );

  for (const [name, payload] of refreshed) {
    priceMap[name] = payload;
  }

  for (const name of uniqueNames) {
    if (!priceMap[name]) {
      priceMap[name] = { marketHashName: name, price: 0, history: [], deltaPct: 0, stale: true };
    }
  }

  return priceMap;
}

async function refreshSteamNewsFull() {
  const cachePath = path.join(NEWS_DIR, "steam-news-ru-week.json");
  const previous = await readJson(cachePath, { updatedAt: 0, items: [] });

  const url =
    "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?" +
    new URLSearchParams({
      appid: "730",
      count: "100",
      maxlength: "0",
      format: "json",
    });

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Steam news failed: ${response.status}`);
  }

  const data = await response.json();
  const items = Array.isArray(data?.appnews?.newsitems) ? data.appnews.newsitems : [];
  const limitTs = Math.floor((Date.now() - WEEK_MS) / 1000);
  const nextItems = [];

  for (const item of items) {
    const createdAt = Number(item?.date || Math.floor(Date.now() / 1000));
    if (createdAt < limitTs) continue;

    const title = stripHtml(item?.title || "");
    const body = stripHtml(item?.contents || "");
    const titleRu = await translateTextToRu(title);
    const bodyRu = await translateTextToRu(body);
    let imageUrl = extractFirstImage(String(item?.contents || ""), item?.url || "https://store.steampowered.com");
    if (!imageUrl && item?.url) {
      try {
        const articleHtml = await fetchText(String(item.url));
        imageUrl = extractMetaContent(articleHtml, "og:image") || extractFirstImage(articleHtml, String(item.url));
      } catch {}
    }

    nextItems.push({
      id: String(item?.gid || `news-${nextItems.length + 1}`),
      category: "Апдейты",
      source: item?.feedlabel || "Steam News",
      title: titleRu || title,
      body: bodyRu || body,
      url: item?.url || null,
      imageUrl,
      createdAt,
      expandable: Boolean(item?.url),
    });

    await sleep(100);
  }

  const merged = dedupeNewsItems([...(previous?.items || []), ...nextItems]);
  await writeJson(cachePath, { updatedAt: Date.now(), items: merged });
  return merged;
}

async function getSteamNewsFull() {
  const cachePath = path.join(NEWS_DIR, "steam-news-ru-week.json");
  const cached = await readJson(cachePath, { updatedAt: 0, items: [] });
  const ready = dedupeNewsItems(cached?.items || []);

  if (ready.length && cached?.updatedAt && Date.now() - cached.updatedAt < NEWS_TTL_MS) {
    return ready;
  }

  if (ready.length) {
    runNewsJob("steam-news", refreshSteamNewsFull).catch(() => {});
    return ready;
  }

  return runNewsJob("steam-news", refreshSteamNewsFull);
}

function extractMetaContent(html = "", key = "") {
  return (
    html.match(new RegExp(`<meta[^>]+property=["']${key}["'][^>]+content=["']([^"']+)["']`, "i"))?.[1] ||
    html.match(new RegExp(`<meta[^>]+name=["']${key}["'][^>]+content=["']([^"']+)["']`, "i"))?.[1] ||
    ""
  );
}

async function refreshCybersportItems() {
  const cachePath = path.join(NEWS_DIR, "esports-cs2-week.json");
  const previous = await readJson(cachePath, { updatedAt: 0, items: [] });

  try {
    const listPages = [
      "https://www.cybersport.ru/tags/cs2",
      "https://www.cybersport.ru/tags/cs2news-cs2",
    ];

    const pages = await Promise.all(
      listPages.map((url) =>
        fetch(url, { headers: { "User-Agent": "Mozilla/5.0 LUDO-app" } })
          .then((res) => (res.ok ? res.text() : ""))
          .catch(() => "")
      )
    );

    const seen = new Set();
    const urls = [];
    for (const html of pages) {
      const matches = [...html.matchAll(/href=["'](\/tags\/cs2(?:news-cs2)?\/[^"']+|\/news\/[^"']+)["']/gi)];
      for (const match of matches) {
        const href = match[1] || "";
        const absoluteUrl = href.startsWith("http") ? href : `https://www.cybersport.ru${href}`;
        if (seen.has(absoluteUrl)) continue;
        seen.add(absoluteUrl);
        urls.push(absoluteUrl);
        if (urls.length >= 16) break;
      }
      if (urls.length >= 16) break;
    }

    const articles = [];
    for (const articleUrl of urls) {
      try {
        const articleHtml = await fetchText(articleUrl);
        const title = decodeHtml(
          extractMetaContent(articleHtml, "og:title") ||
          stripHtml(articleHtml.match(/<title>(.*?)<\/title>/i)?.[1] || "")
        );
        const description = sanitizePreviewBody(
          decodeHtml(
            extractMetaContent(articleHtml, "og:description") ||
            extractMetaContent(articleHtml, "description") ||
            [...articleHtml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
              .map((match) => stripHtml(match[1] || ""))
              .filter((value) => value && value.length > 70)
              .slice(0, 2)
              .join("\n\n")
          ),
          "Короткая новость из мира киберспорта по CS2. Открой источник, если хочешь детали."
        );
        const imageUrl = extractMetaContent(articleHtml, "og:image") || null;
        const published =
          extractMetaContent(articleHtml, "article:published_time") ||
          extractMetaContent(articleHtml, "og:updated_time") ||
          articleHtml.match(/"datePublished"\s*:\s*"([^"]+)"/i)?.[1] ||
          "";
        const createdAt = published ? Math.floor((parseDateMaybe(published) || Date.now()) / 1000) : Math.floor(Date.now() / 1000);
        if (createdAt < Math.floor((Date.now() - WEEK_MS) / 1000)) continue;
        if (!title) continue;

        articles.push({
          id: `esports-${fileSafe(articleUrl)}`,
          category: "Киберспорт",
          source: "Cybersport.ru",
          title,
          body: description || "Материал по CS2 из киберспорта. Открой карточку и перейди к оригиналу, если хочешь полный разбор.",
          url: articleUrl,
          imageUrl,
          createdAt,
          expandable: Boolean(articleUrl),
        });
        await sleep(100);
      } catch (error) {
        console.warn("[esports:article]", articleUrl, error instanceof Error ? error.message : String(error));
      }
    }

    const merged = dedupeNewsItems([...(previous?.items || []), ...articles]);
    await writeJson(cachePath, { updatedAt: Date.now(), items: merged });
    return merged;
  } catch (error) {
    console.warn("[esports]", error instanceof Error ? error.message : String(error));
    return dedupeNewsItems(previous?.items || []);
  }
}
async function getCybersportItems() {
  const cachePath = path.join(NEWS_DIR, "esports-cs2-week.json");
  const cached = await readJson(cachePath, { updatedAt: 0, items: [] });
  const ready = dedupeNewsItems(cached?.items || []);

  if (ready.length && cached?.updatedAt && Date.now() - cached.updatedAt < NEWS_TTL_MS) {
    return ready;
  }

  if (ready.length) {
    runNewsJob("esports-news", refreshCybersportItems).catch(() => {});
    return ready;
  }

  return runNewsJob("esports-news", refreshCybersportItems);
}



function parseRssItems(xml = "", source = "", category = "Мир игр") {
  const items = [];
  const rawItems = [...String(xml || "").matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];

  for (const match of rawItems) {
    const block = match[1] || "";

    const pick = (tag) =>
      block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, "i"))?.[1] ||
      block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1] ||
      "";

    const title = decodeHtml(stripHtml(pick("title")));
    const url = decodeHtml(pick("link")).trim();
    const body = sanitizePreviewBody(
      decodeHtml(stripHtml(pick("description"))),
      "Короткий анонс новости. Открой источник, если хочешь детали."
    );
    const pubDate = decodeHtml(pick("pubDate")).trim();
    const createdAt = pubDate ? Math.floor((parseDateMaybe(pubDate) || Date.now()) / 1000) : Math.floor(Date.now() / 1000);

    let imageUrl =
      decodeHtml(
        block.match(/<enclosure[^>]+url="([^"]+)"/i)?.[1] ||
        block.match(/<media:content[^>]+url="([^"]+)"/i)?.[1] ||
        block.match(/<media:thumbnail[^>]+url="([^"]+)"/i)?.[1] ||
        ""
      ) || null;

    if (!imageUrl) {
      imageUrl = extractFirstImage(block) || null;
    }

    if (!title || !url) continue;
    if (createdAt < Math.floor((Date.now() - WEEK_MS) / 1000)) continue;

    items.push({
      id: `${category === "Мир игр" ? "games" : "news"}-${fileSafe(url)}`,
      category,
      source,
      title,
      body: body || "Игровая новость недели. Открой источник, если хочешь полный материал.",
      url,
      imageUrl,
      createdAt,
      expandable: Boolean(url),
    });
  }

  return items;
}


async function refreshGameWorldItems() {
  const cachePath = path.join(NEWS_DIR, "games-world-week.json");
  const previous = await readJson(cachePath, { updatedAt: 0, items: [] });

  try {
    const feeds = [
      {
        source: "StopGame.ru",
        url: "https://rss.stopgame.ru/rss_news.xml",
      },
      {
        source: "PlayGround.ru",
        url: "https://www.playground.ru/rss/news.xml",
      },
      {
        source: "PlayGround.ru",
        url: "https://www.playground.ru/rss/articles.xml",
      },
    ];

    const allItems = [];

    for (const feed of feeds) {
      try {
        const xml = await fetchText(feed.url);
        const parsed = parseRssItems(xml, feed.source, "Мир игр")
          .filter((item) => {
            const low = `${item.title} ${item.body} ${item.url}`.toLowerCase();
            return !low.includes("counter-strike 2") && !low.includes("counter strike 2") && !low.includes("cs2");
          });
        allItems.push(...parsed);
        await sleep(120);
      } catch (error) {
        console.warn("[games:feed]", feed.url, error instanceof Error ? error.message : String(error));
      }
    }

    const merged = dedupeNewsItems([...(previous?.items || []), ...allItems]);
    await writeJson(cachePath, { updatedAt: Date.now(), items: merged });
    return merged;
  } catch (error) {
    console.warn("[games]", error instanceof Error ? error.message : String(error));
    return dedupeNewsItems(previous?.items || []);
  }
}

async function getGameWorldItems() {
  const cachePath = path.join(NEWS_DIR, "games-world-week.json");
  const cached = await readJson(cachePath, { updatedAt: 0, items: [] });
  const ready = dedupeNewsItems(cached?.items || []);

  if (ready.length && cached?.updatedAt && Date.now() - cached.updatedAt < NEWS_TTL_MS) {
    return ready;
  }

  if (ready.length) {
    runNewsJob("games-world-news", refreshGameWorldItems).catch(() => {});
    return ready;
  }

  return runNewsJob("games-world-news", refreshGameWorldItems);
}

function mapInventoryError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("null вместо inventory") ||
    message.includes("Steam inventory failed: 400") ||
    message.includes("Steam inventory failed: 403")
  ) {
    return "Steam не отдал инвентарь. Такое бывает из-за настроек приватности, лимитов Steam или временной недоступности.";
  }
  return message;
}

function randomDailyReward() {
  const roll = Math.random();
  if (roll < 0.78) return "Промышленное";
  if (roll < 0.99) return "Армейское";
  return "Запрещённое";
}

async function attachReferral(key, startParam) {
  const code = String(startParam || "")
    .trim()
    .replace(/^ref[_:-]?/i, "")
    .toUpperCase();
  if (!code) return null;

  const user = await readUserState(key);
  if (user.referral.code === code || user.referral.attachedRefCode === code) {
    return user.referral;
  }

  const referrerKey = await findKeyByReferralCode(code);
  if (!referrerKey || referrerKey === key) {
    return user.referral;
  }

  const referrer = await readUserState(referrerKey);
  referrer.referral.clicks += 1;
  referrer.referral.verified += 1;
  referrer.referral.points += 1;
  user.referral.attachedRefCode = code;
  user.referral.attachedAt = Date.now();

  await writeUserState(referrerKey, referrer);
  const savedUser = await writeUserState(key, user);
  return savedUser.referral;
}

app.get("/api/health", async (_req, res) => {
  await Promise.all([ensureDir(DATA_DIR), ensureDir(USERS_DIR), ensureDir(PRICES_DIR), ensureDir(NEWS_DIR)]);
  res.json({
    ok: true,
    frontendOrigin: FRONTEND_ORIGIN,
    hasSteamKey: Boolean(STEAM_WEB_API_KEY),
    dataDir: DATA_DIR,
  });
});

app.get("/api/news", async (_req, res) => {
  try {
    const [updatesRaw, esportsRaw, gamesRaw] = await Promise.all([
      getSteamNewsFull(),
      getCybersportItems(),
      getGameWorldItems(),
    ]);

    const updates = dedupeNewsItems(updatesRaw);
    const usedKeys = new Set(updates.map((item) => newsKey(item)));

    const esports = dedupeNewsItems(esportsRaw).filter((item) => !usedKeys.has(newsKey(item)));
    esports.forEach((item) => usedKeys.add(newsKey(item)));

    const games = dedupeNewsItems(gamesRaw).filter((item) => !usedKeys.has(newsKey(item)));

    res.json({ updates, esports, games, windowDays: 7, cached: true });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Не удалось загрузить новости.",
    });
  }
});

app.get("/api/news/article", async (req, res) => {
  try {
    const url = String(req.query.url || "").trim();
    if (!url || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: "Нужен корректный url." });
    }

    const trusted = isTrustedFullArticleHost(url);
    const html = await fetchText(url);
    let body = extractArticleText(html, url);

    if (!body || isArticleMostlyJunk(body) || body.length < 180) {
      body = cleanupArticleText(
        extractMetaContent(html, "og:description") ||
        extractMetaContent(html, "description")
      );
    }

    if (isArticleMostlyJunk(body)) {
      body = "";
    }

    res.json({ body: body || "", trusted, exactBlock: Boolean(body) });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Не удалось загрузить полный текст новости.",
    });
  }
});

app.get("/api/steam/resolve", async (req, res) => {
  try {
    const profile = String(req.query.profile || "");
    const resolved = await resolveSteamProfile(profile);
    const summary = await getPlayerSummary(resolved.steamId, resolved.profileUrl);
    res.json({
      steamid: resolved.steamId,
      profile: summary || resolved.profile,
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Не удалось зарезолвить Steam-профиль.",
    });
  }
});

app.get("/api/steam/inventory", async (req, res) => {
  try {
    await Promise.all([ensureDir(DATA_DIR), ensureDir(USERS_DIR), ensureDir(PRICES_DIR), ensureDir(NEWS_DIR)]);

    const profileInput = String(req.query.profile || "");
    const key = String(req.query.key || "guest");
    const force = String(req.query.force || "") === "1";

    const resolved = await resolveSteamProfile(profileInput);
    const summary = await getPlayerSummary(resolved.steamId, resolved.profileUrl);
    const inventoryResult = await getInventory(resolved.steamId, { force });
    const inventoryPayload = inventoryResult.payload;

    const descriptions = Array.isArray(inventoryPayload?.descriptions) ? inventoryPayload.descriptions : [];
    const uniqueNames = buildPriceRefreshPlan(descriptions);
    const priceMap = await resolvePriceMap(uniqueNames);
    const items = buildInventoryItems(inventoryPayload, priceMap);
    const totalValue = items.reduce((sum, item) => sum + item.totalValue, 0);

    await writeJson(inventoryCachePath(resolved.steamId), {
      updatedAt: Date.now(),
      payload: inventoryPayload,
      items,
      totalValue,
      personaname: summary?.personaname || resolved.profile?.personaname || null,
      profile: summary || resolved.profile || null,
    });

    const user = await readUserState(key);
    user.steam = {
      input: profileInput,
      steamid: resolved.steamId,
      personaname: summary?.personaname || resolved.profile?.personaname || "Steam player",
      avatarfull: summary?.avatarfull || resolved.profile?.avatarfull || null,
    };
    await writeUserState(key, user);

    res.json({
      steamid: resolved.steamId,
      personaname: summary?.personaname || resolved.profile?.personaname || null,
      profile: summary || resolved.profile,
      totalValue,
      items,
      updatedAt: Date.now(),
      cached: inventoryResult.cached,
      stale: inventoryResult.stale,
    });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    console.error("[inventory:error]", rawMessage);
    res.status(400).json({
      error: mapInventoryError(error),
      rawError: rawMessage,
    });
  }
});

app.get("/api/steam/item-history", async (req, res) => {
  try {
    const marketHashName = String(req.query.marketHashName || "").trim();
    if (!marketHashName) {
      throw new Error("Передай marketHashName");
    }

    const filePath = path.join(PRICES_DIR, `${fileSafe(marketHashName)}.json`);
    const priceFile = await readJson(filePath, {
      marketHashName,
      lastValue: 0,
      updatedAt: 0,
      history: [],
    });

    res.json({
      marketHashName,
      updatedAt: priceFile.updatedAt || 0,
      history: Array.isArray(priceFile.history) ? priceFile.history : [],
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Не удалось получить историю предмета.",
    });
  }
});

app.post("/api/tickets", async (req, res) => {
  try {
    const reporterKey = compactText(req.body?.key || "guest", 120) || "guest";
    const reporterName = compactText(req.body?.reporterName || "Пользователь", 120) || "Пользователь";
    const reporterHandle = compactText(req.body?.reporterHandle || "", 120) || null;
    const reporterUserId = normalizeAdminId(req.body?.reporterUserId);
    const title = compactText(req.body?.title || "Сообщение о проблеме", 240) || "Сообщение о проблеме";
    const url = compactText(req.body?.url || "", 500) || null;
    const sourceType = compactText(req.body?.sourceType || "app", 80) || "app";
    const sourceId = compactText(req.body?.sourceId || "", 200) || null;
    const message = compactText(req.body?.message || "", 3000);

    if (!message) {
      throw new Error("Опиши проблему перед отправкой.");
    }

    const items = await readTickets();
    const ticket = {
      id: ticketId(),
      status: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      reporter: {
        key: reporterKey,
        name: reporterName,
        handle: reporterHandle,
        userId: reporterUserId,
      },
      source: {
        type: sourceType,
        id: sourceId,
        title,
        url,
      },
      message,
    };

    items.unshift(ticket);
    await writeTickets(items);
    res.json({ ok: true, ticket });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Не удалось отправить тикет.",
    });
  }
});

app.get("/api/tickets", async (req, res) => {
  try {
    const adminId = normalizeAdminId(req.query.adminId);
    if (!adminId || !SERVER_ADMIN_IDS.has(adminId)) {
      return res.status(403).json({ error: "Доступ запрещён." });
    }

    const status = compactText(req.query.status || "", 40);
    let items = await readTickets();
    if (status) {
      items = items.filter((ticket) => ticket.status === status);
    }
    items.sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));
    res.json({ items });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Не удалось загрузить тикеты.",
    });
  }
});

app.post("/api/tickets/:id/status", async (req, res) => {
  try {
    const adminId = normalizeAdminId(req.body?.adminId);
    if (!adminId || !SERVER_ADMIN_IDS.has(adminId)) {
      return res.status(403).json({ error: "Доступ запрещён." });
    }

    const id = compactText(req.params.id || "", 120);
    const status = compactText(req.body?.status || "open", 40) || "open";
    if (!id) throw new Error("Нужен id тикета.");

    const items = await readTickets();
    const next = items.map((ticket) => ticket.id === id ? { ...ticket, status, updatedAt: Date.now() } : ticket);
    await writeTickets(next);
    const updated = next.find((ticket) => ticket.id === id) || null;
    res.json({ ok: true, ticket: updated });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Не удалось обновить тикет.",
    });
  }
});

app.get("/api/profile-state", async (req, res) => {
  try {
    const key = String(req.query.key || "").trim();
    if (!key) throw new Error("Передай key");
    const state = await readUserState(key);
    res.json(state);
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Не удалось прочитать состояние профиля.",
    });
  }
});

app.post("/api/profile-state", async (req, res) => {
  try {
    const key = String(req.body?.key || "").trim();
    if (!key) throw new Error("Передай key");
    const state = await writeUserState(key, req.body);
    res.json(state);
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Не удалось сохранить состояние профиля.",
    });
  }
});

app.post("/api/daily-checkin", async (req, res) => {
  try {
    const key = String(req.body?.key || "").trim();
    if (!key) throw new Error("Передай key");

    const state = await readUserState(key);
    const today = todayStr();
    const last = state.daily.lastCheckinDate;

    if (last === today) {
      res.json({
        ok: true,
        alreadyChecked: true,
        daily: state.daily,
        message: "Сегодняшняя отметка уже забрана.",
      });
      return;
    }

    const newStreak = last === yesterdayStr() ? state.daily.streak + 1 : 1;
    state.daily.streak = newStreak;
    state.daily.lastCheckinDate = today;
    state.daily.lastReward = null;

    let reward = null;
    let message = `Отметка засчитана. Текущий стрик: ${newStreak}/7.`;

    if (newStreak >= 7) {
      reward = randomDailyReward();
      state.daily.streak = 0;
      state.daily.lastReward = reward;
      message = `7/7! Ты закрыл стрик и получил награду: ${reward}.`;
    }

    const saved = await writeUserState(key, state);
    res.json({
      ok: true,
      alreadyChecked: false,
      reward,
      daily: saved.daily,
      message,
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Не удалось отметить ежедневку.",
    });
  }
});

app.post("/api/referral/attach", async (req, res) => {
  try {
    const key = String(req.body?.key || "").trim();
    const startParam = String(req.body?.startParam || "").trim();
    if (!key) throw new Error("Передай key");

    const referral = await attachReferral(key, startParam);
    const state = await readUserState(key);
    res.json({ ok: true, referral: referral || state.referral, state });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Не удалось привязать рефералку.",
    });
  }
});

app.listen(PORT, async () => {
  await Promise.all([ensureDir(DATA_DIR), ensureDir(USERS_DIR), ensureDir(PRICES_DIR), ensureDir(NEWS_DIR)]);
  console.log(`LUDO API listening on http://localhost:${PORT}`);
});
