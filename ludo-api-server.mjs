import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";

const { Pool } = pg;

const app = express();
const PORT = Number(process.env.PORT || 8787);
const HOST = "0.0.0.0";
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
const STEAM_WEB_API_KEY = process.env.STEAM_WEB_API_KEY || "";
const ADMIN_IDS = new Set([793655800, 1069618912]);

const DATA_DIR = process.env.LUDO_DATA_DIR || path.join(process.cwd(), ".ludo-data");
const USERS_DIR = path.join(DATA_DIR, "users");
const PRICES_DIR = path.join(DATA_DIR, "prices");
const NEWS_DIR = path.join(DATA_DIR, "news");
const ITEMS_DIR = path.join(DATA_DIR, "items");
const REF_INDEX_PATH = path.join(DATA_DIR, "referral-index.json");
const TICKETS_PATH = path.join(DATA_DIR, "tickets.json");
const WEEKLY_GOALS_PATH = path.join(DATA_DIR, "weekly-goals.json");
const ACTIVITY_PATH = path.join(DATA_DIR, "activity.json");
const DATABASE_URL = process.env.DATABASE_URL || "";

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required. Add your Neon connection string in Render env.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

async function initDb() {
  await pool.query(`
    create table if not exists kv_store (
      namespace text not null,
      key text not null,
      value text not null,
      updated_at bigint not null,
      primary key (namespace, key)
    );
  `);
  await pool.query(`
    create index if not exists idx_kv_store_namespace_updated_at
      on kv_store(namespace, updated_at desc);
  `);
}

function storageTargetFromPath(filePath) {
  const rel = path.relative(DATA_DIR, filePath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const normalized = rel.split(path.sep).join("/");

  if (normalized === "referral-index.json") return { namespace: "meta", key: "referral-index" };
  if (normalized === "tickets.json") return { namespace: "meta", key: "tickets" };
  if (normalized === "weekly-goals.json") return { namespace: "meta", key: "weekly-goals" };
  if (normalized === "activity.json") return { namespace: "meta", key: "activity" };

  const dirMappings = [
    ["users/", "users"],
    ["prices/", "prices"],
    ["news/", "news"],
    ["items/", "items"],
  ];

  for (const [prefix, namespace] of dirMappings) {
    if (normalized.startsWith(prefix) && normalized.endsWith(".json")) {
      return {
        namespace,
        key: normalized.slice(prefix.length, -5),
      };
    }
  }

  return null;
}

async function listNamespaceKeys(namespace) {
  const { rows } = await pool.query(
    `select key from kv_store where namespace = $1 order by key asc`,
    [namespace]
  );
  return rows.map((row) => String(row.key || ""));
}

async function migrateFileIntoPostgres(filePath) {
  const target = storageTargetFromPath(filePath);
  if (!target) return;

  const existing = await pool.query(
    `select 1 from kv_store where namespace = $1 and key = $2 limit 1`,
    [target.namespace, target.key]
  );
  if (existing.rowCount) return;

  try {
    const raw = await fs.readFile(filePath, "utf-8");
    JSON.parse(raw);
    await pool.query(
      `
        insert into kv_store (namespace, key, value, updated_at)
        values ($1, $2, $3, $4)
        on conflict(namespace, key) do update set
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
      [target.namespace, target.key, raw, Date.now()]
    );
  } catch {
    // ignore broken or missing legacy files
  }
}

async function migrateLegacyJsonToPostgres() {
  const metaFiles = [REF_INDEX_PATH, TICKETS_PATH, WEEKLY_GOALS_PATH, ACTIVITY_PATH];
  for (const filePath of metaFiles) {
    await migrateFileIntoPostgres(filePath);
  }

  const dirs = [USERS_DIR, PRICES_DIR, NEWS_DIR, ITEMS_DIR];
  for (const dir of dirs) {
    const names = await fs.readdir(dir).catch(() => []);
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      await migrateFileIntoPostgres(path.join(dir, name));
    }
  }
}

const PRICE_TTL_MS = 1000 * 60 * 60 * 6;
const PRICE_HISTORY_MIN_INTERVAL_MS = 1000 * 60 * 60 * 12;
const INVENTORY_TTL_MS = 1000 * 60 * 12;
const INVENTORY_FORCE_COOLDOWN_MS = 1000 * 45;
const INVENTORY_RATE_LIMIT_BACKOFF_MS = 1000 * 60 * 5;
const NEWS_TTL_MS = 1000 * 60 * 20;
const WEEK_MS = 1000 * 60 * 60 * 24 * 7;
const PASS_SEASON_KEY = "LUDO_S1_BETA";

const inventoryInflight = new Map();

app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => {
  res.send("LUDO API is running");
});

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson(filePath, fallback) {
  const target = storageTargetFromPath(filePath);
  if (target) {
    try {
      const { rows } = await pool.query(
        `select value from kv_store where namespace = $1 and key = $2 limit 1`,
        [target.namespace, target.key]
      );
      return rows[0] ? JSON.parse(rows[0].value) : fallback;
    } catch {
      return fallback;
    }
  }

  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, data) {
  const target = storageTargetFromPath(filePath);
  if (target) {
    await pool.query(
      `
        insert into kv_store (namespace, key, value, updated_at)
        values ($1, $2, $3, $4)
        on conflict(namespace, key) do update set
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
      [target.namespace, target.key, JSON.stringify(data, null, 2), Date.now()]
    );
    return;
  }

  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
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

function defaultPassState() {
  return {
    seasonKey: PASS_SEASON_KEY,
    premium: false,
    xp: 0,
    claimedRewards: [],
    dailyDate: todayStr(),
    completedDailyKeys: [],
    completedOnceKeys: [],
  };
}

function mergePassState(pass = null) {
  const base = defaultPassState();
  const next = {
    ...base,
    ...(pass || {}),
    claimedRewards: Array.isArray(pass?.claimedRewards) ? pass.claimedRewards.slice(0, 100) : base.claimedRewards,
    completedDailyKeys: Array.isArray(pass?.completedDailyKeys) ? pass.completedDailyKeys.slice(0, 40) : base.completedDailyKeys,
    completedOnceKeys: Array.isArray(pass?.completedOnceKeys) ? pass.completedOnceKeys.slice(0, 100) : base.completedOnceKeys,
  };

  if (next.seasonKey !== PASS_SEASON_KEY) {
    return {
      ...base,
      premium: Boolean(pass?.premium),
    };
  }

  if (next.dailyDate !== todayStr()) {
    next.dailyDate = todayStr();
    next.completedDailyKeys = [];
  }

  next.xp = Math.max(0, Number(next.xp || 0));
  return next;
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
      verifiedAt: null,
    },
    steam: {
      input: "",
      steamid: "",
      personaname: "",
      avatarfull: null,
    },
    pass: defaultPassState(),
    telegram: {
      id: null,
      username: "",
      firstName: "",
      lastName: "",
      photoUrl: null,
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
      verifiedAt: typeof incoming?.referral?.verifiedAt === "number" || incoming?.referral?.verifiedAt === null
        ? incoming.referral.verifiedAt
        : base.referral.verifiedAt,
    },
    steam: {
      input: typeof incoming?.steam?.input === "string" ? incoming.steam.input : base.steam.input,
      steamid: typeof incoming?.steam?.steamid === "string" ? incoming.steam.steamid : base.steam.steamid,
      personaname: typeof incoming?.steam?.personaname === "string" ? incoming.steam.personaname : base.steam.personaname,
      avatarfull: typeof incoming?.steam?.avatarfull === "string" || incoming?.steam?.avatarfull === null
        ? incoming.steam.avatarfull
        : base.steam.avatarfull,
    },
    pass: mergePassState(incoming?.pass || base.pass),
    telegram: {
      id: Number.isFinite(Number(incoming?.telegram?.id)) ? Number(incoming.telegram.id) : base.telegram.id,
      username: typeof incoming?.telegram?.username === "string" ? incoming.telegram.username : base.telegram.username,
      firstName: typeof incoming?.telegram?.firstName === "string" ? incoming.telegram.firstName : base.telegram.firstName,
      lastName: typeof incoming?.telegram?.lastName === "string" ? incoming.telegram.lastName : base.telegram.lastName,
      photoUrl: typeof incoming?.telegram?.photoUrl === "string" || incoming?.telegram?.photoUrl === null
        ? incoming.telegram.photoUrl
        : base.telegram.photoUrl,
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

function buildTelegramKey(tgUserId) {
  return `tg-${tgUserId}`;
}

function normalizeTelegramIdentity(payload = {}) {
  const tgUserId = Number(payload?.tgUserId || payload?.telegramId || payload?.id || 0);
  if (!Number.isFinite(tgUserId) || tgUserId <= 0) return null;
  return {
    id: tgUserId,
    username: String(payload?.username || "").trim(),
    firstName: String(payload?.firstName || payload?.first_name || "").trim(),
    lastName: String(payload?.lastName || payload?.last_name || "").trim(),
    photoUrl: String(payload?.photoUrl || payload?.photo_url || "").trim() || null,
  };
}

function telegramIdentityView(telegram = {}) {
  const fullName = [telegram?.firstName, telegram?.lastName].filter(Boolean).join(" ").trim();
  return {
    name: fullName || telegram?.username || "Telegram user",
    handle: telegram?.username ? `@${telegram.username}` : "Telegram",
    avatar: telegram?.photoUrl || null,
  };
}

async function readActivityLog() {
  return readJson(ACTIVITY_PATH, { users: {}, daily: {} });
}

async function writeActivityLog(payload) {
  await writeJson(ACTIVITY_PATH, payload || { users: {}, daily: {} });
}

async function recordUserActivity(key, tgUserId = null) {
  if (!key) return null;
  const log = await readActivityLog();
  const now = Date.now();
  const today = todayStr();

  const current = log.users?.[key] || {
    key,
    tgUserId: tgUserId || null,
    firstSeenAt: now,
    lastSeenAt: 0,
    visits: 0,
  };

  current.tgUserId = Number.isFinite(Number(tgUserId)) && Number(tgUserId) > 0 ? Number(tgUserId) : current.tgUserId || null;
  current.lastSeenAt = now;
  current.visits = Number(current.visits || 0) + 1;
  log.users[key] = current;

  const bucket = log.daily?.[today] || { users: [] };
  const userSet = new Set(Array.isArray(bucket.users) ? bucket.users : []);
  userSet.add(key);
  bucket.users = Array.from(userSet);
  log.daily[today] = bucket;

  const minKeep = Date.now() - 1000 * 60 * 60 * 24 * 45;
  for (const [dateKey, value] of Object.entries(log.daily || {})) {
    const ts = parseDateMaybe(dateKey);
    const keep = ts && ts >= minKeep;
    if (!keep) delete log.daily[dateKey];
    else if (!Array.isArray(value?.users)) log.daily[dateKey] = { users: [] };
  }

  await writeActivityLog(log);
  return current;
}

async function finalizeReferralForUser(userOrKey) {
  const user = typeof userOrKey === "string" ? await readUserState(userOrKey) : userOrKey;
  if (!user?.key || !user?.referral?.attachedRefCode || user?.referral?.verifiedAt) {
    return user;
  }

  const referrerKey = await findKeyByReferralCode(user.referral.attachedRefCode);
  if (!referrerKey || referrerKey === user.key) {
    return user;
  }

  const referrer = await readUserState(referrerKey);
  referrer.referral.verified = Number(referrer.referral.verified || 0) + 1;
  referrer.referral.points = Number(referrer.referral.points || 0) + 1;
  user.referral.verifiedAt = Date.now();

  await writeUserState(referrerKey, referrer);
  return writeUserState(user.key, user);
}

function isAdminId(value) {
  const id = Number(value || 0);
  return Number.isFinite(id) && ADMIN_IDS.has(id);
}

function normalizeTicketStatus(value) {
  return String(value || "open").trim().toLowerCase() === "done" ? "done" : "open";
}

async function readTickets() {
  const raw = await readJson(TICKETS_PATH, []);
  return Array.isArray(raw) ? raw : [];
}

async function writeTickets(items) {
  await writeJson(TICKETS_PATH, Array.isArray(items) ? items : []);
}


function startOfWeekIso(date = new Date()) {
  const current = new Date(date);
  const day = current.getUTCDay() || 7;
  current.setUTCHours(0, 0, 0, 0);
  current.setUTCDate(current.getUTCDate() - day + 1);
  return current.toISOString().slice(0, 10);
}

function formatWeekTitle(weekKey) {
  const start = new Date(`${weekKey}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) return "Цели недели";
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  const startLabel = start.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
  const endLabel = end.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
  return `Неделя ${startLabel}–${endLabel}`;
}

function normalizeWeekKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return startOfWeekIso();
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return startOfWeekIso();
  return startOfWeekIso(parsed);
}

function defaultWeeklyGoalsItems(weekKey) {
  const now = Date.now();
  return [
    {
      id: `seed-${weekKey}-kostya-1`,
      text: "Добить стабильность инвентаря и проверить, что 429 не роняет экран.",
      assignee: "Костя",
      done: false,
      createdAt: now,
      updatedAt: now,
      updatedBy: null,
      updatedByName: "LUDO",
    },
    {
      id: `seed-${weekKey}-kostya-2`,
      text: "Проверить главную, PASS и радар после деплоя без новых багов.",
      assignee: "Костя",
      done: false,
      createdAt: now,
      updatedAt: now,
      updatedBy: null,
      updatedByName: "LUDO",
    },
    {
      id: `seed-${weekKey}-maksim-1`,
      text: "Закрыть свой кусок по проекту и отписаться по результату в админке, а не исчезать.",
      assignee: "Максим",
      done: false,
      createdAt: now,
      updatedAt: now,
      updatedBy: null,
      updatedByName: "LUDO",
    },
    {
      id: `seed-${weekKey}-maksim-2`,
      text: "Проверить тикеты и отметить, что реально сделано за неделю.",
      assignee: "Максим",
      done: false,
      createdAt: now,
      updatedAt: now,
      updatedBy: null,
      updatedByName: "LUDO",
    },
  ];
}

function normalizeGoalsItems(items) {
  return (Array.isArray(items) ? items : []).map((goal) => ({
    id: String(goal?.id || crypto.randomUUID()),
    text: String(goal?.text || "").slice(0, 240),
    done: Boolean(goal?.done),
    assignee: goal?.assignee ? String(goal.assignee).slice(0, 40) : null,
    createdAt: Number(goal?.createdAt || Date.now()),
    updatedAt: Number(goal?.updatedAt || Date.now()),
    updatedBy: goal?.updatedBy == null ? null : Number(goal.updatedBy),
    updatedByName: goal?.updatedByName ? String(goal.updatedByName).slice(0, 80) : null,
  })).filter((goal) => goal.text);
}

function normalizeWeeklyGoalsStore(raw) {
  if (raw && raw.weeks && typeof raw.weeks === "object") {
    const weeks = Object.fromEntries(
      Object.entries(raw.weeks).map(([weekKey, payload]) => {
        const normalizedWeek = normalizeWeekKey(weekKey);
        return [normalizedWeek, {
          weekKey: normalizedWeek,
          title: String(payload?.title || formatWeekTitle(normalizedWeek)),
          items: normalizeGoalsItems(payload?.items),
        }];
      })
    );
    return { weeks };
  }

  if (raw && (raw.weekKey || raw.items)) {
    const weekKey = normalizeWeekKey(raw.weekKey);
    return {
      weeks: {
        [weekKey]: {
          weekKey,
          title: String(raw?.title || formatWeekTitle(weekKey)),
          items: normalizeGoalsItems(raw?.items),
        },
      },
    };
  }

  return { weeks: {} };
}

async function readWeeklyGoals(weekKeyInput) {
  const weekKey = normalizeWeekKey(weekKeyInput);
  const raw = await readJson(WEEKLY_GOALS_PATH, null);
  const store = normalizeWeeklyGoalsStore(raw);
  let week = store.weeks[weekKey];
  if (!week) {
    week = {
      weekKey,
      title: formatWeekTitle(weekKey),
      items: weekKey === startOfWeekIso() ? defaultWeeklyGoalsItems(weekKey) : [],
    };
    store.weeks[weekKey] = week;
    await writeJson(WEEKLY_GOALS_PATH, store);
  }
  return week;
}

async function writeWeeklyGoals(payload) {
  const weekKey = normalizeWeekKey(payload?.weekKey);
  const raw = await readJson(WEEKLY_GOALS_PATH, null);
  const store = normalizeWeeklyGoalsStore(raw);
  const next = {
    weekKey,
    title: String(payload?.title || formatWeekTitle(weekKey)),
    items: normalizeGoalsItems(payload?.items),
  };
  store.weeks[weekKey] = next;
  await writeJson(WEEKLY_GOALS_PATH, store);
  return next;
}

async function getItemMetaByHashName(marketHashName) {
  const hash = String(marketHashName || "").trim();
  if (!hash) return null;

  const cachePath = path.join(ITEMS_DIR, `${fileSafe(hash)}.json`);
  const cached = await readJson(cachePath, null);
  if (cached?.updatedAt && Date.now() - cached.updatedAt < 1000 * 60 * 60 * 24 * 7 && cached?.item) {
    return cached.item;
  }

  const url =
    "https://steamcommunity.com/market/search/render/?" +
    new URLSearchParams({
      query: hash,
      appid: "730",
      norender: "1",
      count: "12",
      start: "0",
    });

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 LUDO-app",
        Accept: "application/json, text/plain, */*",
      },
    });
    if (!response.ok) throw new Error(`market_search_${response.status}`);
    const data = await response.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    const exact = results.find((item) => String(item?.hash_name || item?.asset_description?.market_hash_name || "").toLowerCase() === hash.toLowerCase())
      || results.find((item) => String(item?.name || item?.hash_name || "").toLowerCase().includes(hash.toLowerCase()));

    const item = exact
      ? {
          marketHashName: String(exact.hash_name || exact?.asset_description?.market_hash_name || hash),
          name: String(exact.name || exact.hash_name || hash),
          type: String(exact?.asset_description?.type || exact.type || "CS2 item"),
          iconUrl: exact?.asset_description?.icon_url
            ? `https://community.cloudflare.steamstatic.com/economy/image/${exact.asset_description.icon_url}/256fx256f`
            : null,
          descriptionText: Array.isArray(exact?.asset_description?.descriptions)
            ? exact.asset_description.descriptions.map((entry) => stripHtml(entry?.value || "")).filter(Boolean).join(" · ")
            : "",
        }
      : {
          marketHashName: hash,
          name: hash,
          type: "CS2 item",
          iconUrl: null,
          descriptionText: "",
        };

    await writeJson(cachePath, { updatedAt: Date.now(), item });
    return item;
  } catch {
    if (cached?.item) return cached.item;
    return {
      marketHashName: hash,
      name: hash,
      type: "CS2 item",
      iconUrl: null,
      descriptionText: "",
    };
  }
}

async function buildMarketWatchItem(marketHashName) {
  const meta = await getItemMetaByHashName(marketHashName);
  const priceMeta = await getPriceSnapshot(meta?.marketHashName || marketHashName);
  return {
    id: `watch-${fileSafe(meta?.marketHashName || marketHashName)}`,
    marketHashName: meta?.marketHashName || marketHashName,
    name: meta?.name || marketHashName,
    type: meta?.type || "CS2 item",
    iconUrl: meta?.iconUrl || null,
    tradable: true,
    marketable: true,
    quantity: 1,
    price: Number(priceMeta?.price || 0),
    totalValue: Number(priceMeta?.price || 0),
    deltaPct: Number(priceMeta?.deltaPct || 0),
    history: Array.isArray(priceMeta?.history) ? priceMeta.history : [],
    note: "Предмет из watchlist",
    descriptionText: meta?.descriptionText || "",
  };
}

async function searchSteamMarketItems(query, limit = 8) {
  const q = String(query || "").trim();
  if (!q) return [];

  const url =
    "https://steamcommunity.com/market/search/render/?" +
    new URLSearchParams({
      query: q,
      appid: "730",
      norender: "1",
      count: String(Math.min(12, Math.max(1, limit))),
      start: "0",
    });

  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 LUDO-app",
      Accept: "application/json, text/plain, */*",
    },
  });

  if (!response.ok) {
    throw new Error(`Steam market search failed: ${response.status}`);
  }

  const data = await response.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  const items = [];

  for (const result of results.slice(0, limit)) {
    const marketHashName = String(result?.hash_name || result?.asset_description?.market_hash_name || result?.name || "").trim();
    if (!marketHashName) continue;
    const priceMeta = await getPriceSnapshot(marketHashName);
    items.push({
      id: `market-search-${fileSafe(marketHashName)}`,
      marketHashName,
      name: String(result?.name || marketHashName),
      type: String(result?.asset_description?.type || result?.type || "CS2 item"),
      iconUrl: result?.asset_description?.icon_url
        ? `https://community.cloudflare.steamstatic.com/economy/image/${result.asset_description.icon_url}/256fx256f`
        : null,
      tradable: true,
      marketable: true,
      quantity: 1,
      price: Number(priceMeta?.price || 0),
      totalValue: Number(priceMeta?.price || 0),
      deltaPct: Number(priceMeta?.deltaPct || 0),
      history: Array.isArray(priceMeta?.history) ? priceMeta.history : [],
      note: "Предмет из поиска Steam Market",
      descriptionText: Array.isArray(result?.asset_description?.descriptions)
        ? result.asset_description.descriptions.map((entry) => stripHtml(entry?.value || "")).filter(Boolean).join(" · ")
        : "",
    });
    await sleep(120);
  }

  return items;
}

function extractReadableArticleText(html = "") {
  const cleaned = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");

  const candidates = [
    cleaned.match(/<article[\s\S]*?<\/article>/i)?.[0] || "",
    cleaned.match(/<main[\s\S]*?<\/main>/i)?.[0] || "",
    cleaned.match(/<div[^>]+class=["'][^"']*(article|content|news|post|story|body)[^"']*["'][\s\S]*?<\/div>/i)?.[0] || "",
    cleaned,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const text = stripHtml(candidate).replace(/\n{3,}/g, "\n\n").trim();
    if (text.length >= 280) {
      return text.slice(0, 24000);
    }
  }

  return stripHtml(cleaned).slice(0, 24000);
}

async function fetchFullArticle(url) {
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target)) {
    throw new Error("Нужен полный URL статьи.");
  }

  const cachePath = path.join(NEWS_DIR, `article-${fileSafe(crypto.createHash("sha1").update(target).digest("hex"))}.json`);
  const cached = await readJson(cachePath, null);
  if (cached?.updatedAt && Date.now() - cached.updatedAt < 1000 * 60 * 60 * 12 && cached?.body) {
    return cached;
  }

  const html = await fetchText(target);
  const title = decodeHtml(extractMetaContent(html, "og:title") || stripHtml(html.match(/<title>(.*?)<\/title>/i)?.[1] || ""));
  const description = decodeHtml(extractMetaContent(html, "og:description"));
  const body = extractReadableArticleText(html);
  const payload = {
    url: target,
    title,
    body: body.length >= 280 ? body : [description, body].filter(Boolean).join("\n\n").trim() || description || title,
    imageUrl: extractMetaContent(html, "og:image") || extractFirstImage(html, target) || null,
    updatedAt: Date.now(),
  };
  await writeJson(cachePath, payload);
  return payload;
}

async function getAdminSummary() {
  const [tickets, activity] = await Promise.all([readTickets(), readActivityLog()]);
  const userKeys = (await listNamespaceKeys("users")).filter((key) => !(key.startsWith("steam-") && key.endsWith("-inventory")));
  const totalUsers = userKeys.length;
  const today = todayStr();
  const activeToday = Array.isArray(activity?.daily?.[today]?.users) ? activity.daily[today].users.length : 0;

  const last7 = new Set();
  const start = Date.now() - 1000 * 60 * 60 * 24 * 6;
  for (const [dateKey, bucket] of Object.entries(activity?.daily || {})) {
    const ts = parseDateMaybe(dateKey);
    if (!ts || ts < start) continue;
    for (const key of Array.isArray(bucket?.users) ? bucket.users : []) {
      last7.add(key);
    }
  }

  let referralClicks = 0;
  let referralVerified = 0;
  let watchlistItems = 0;
  let steamConnected = 0;
  let premiumPassUsers = 0;
  for (const key of userKeys.slice(0, 20000)) {
    const state = await readUserState(key);
    referralClicks += Number(state?.referral?.clicks || 0);
    referralVerified += Number(state?.referral?.verified || 0);
    watchlistItems += Array.isArray(state?.watchlist) ? state.watchlist.length : 0;
    if (state?.steam?.steamid) steamConnected += 1;
    if (Boolean(state?.pass?.premium)) premiumPassUsers += 1;
  }

  const openTickets = tickets.filter((ticket) => normalizeTicketStatus(ticket?.status) !== 'done').length;
  return {
    totalUsers,
    activeToday,
    active7d: last7.size,
    referralClicks,
    referralVerified,
    totalTickets: tickets.length,
    openTickets,
    watchlistItems,
    steamConnected,
    premiumPassUsers,
  };
}

async function upsertTelegramProfile(payload = {}) {
  const telegram = normalizeTelegramIdentity(payload);
  if (!telegram) throw new Error("Передай tgUserId");
  const key = buildTelegramKey(telegram.id);
  const current = await readUserState(key);
  const next = {
    ...current,
    key,
    telegram,
  };
  const saved = await writeUserState(key, next);
  await recordUserActivity(key, telegram.id);
  const finalized = await finalizeReferralForUser(saved);
  return {
    key,
    state: finalized,
    tgUserId: telegram.id,
    identity: telegramIdentityView(telegram),
    isAdmin: ADMIN_IDS.has(telegram.id),
  };
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

async function getInventoryInternal(steamId, { force = false } = {}) {
  const cachePath = inventoryCachePath(steamId);
  const cached = await readJson(cachePath, null);
  const now = Date.now();
  const cacheAge = cached?.updatedAt ? now - Number(cached.updatedAt || 0) : Number.POSITIVE_INFINITY;

  if (cached?.rateLimitedUntil && now < Number(cached.rateLimitedUntil) && cached?.payload) {
    return { payload: cached.payload, cache: cached, cached: true, stale: true, rateLimited: true };
  }

  if (cached?.updatedAt && cacheAge < INVENTORY_TTL_MS) {
    return { payload: cached.payload, cache: cached, cached: true, stale: false, rateLimited: false };
  }

  if (force && cached?.updatedAt && cacheAge < INVENTORY_FORCE_COOLDOWN_MS) {
    return { payload: cached.payload, cache: cached, cached: true, stale: false, rateLimited: false };
  }

  const counts = [2000, 1000, 500, 200];
  let lastError = null;
  let rateLimited = false;

  for (const count of counts) {
    try {
      const payload = await fetchInventoryOnce(steamId, count);
      const nextCache = {
        ...(cached || {}),
        updatedAt: Date.now(),
        payload,
        rateLimitedUntil: null,
        lastError: null,
      };
      await writeJson(cachePath, nextCache);
      return { payload, cache: nextCache, cached: false, stale: false, rateLimited: false };
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes("429")) {
        rateLimited = true;
        const nextCache = {
          ...(cached || {}),
          rateLimitedUntil: Date.now() + INVENTORY_RATE_LIMIT_BACKOFF_MS,
          lastError: message,
        };
        await writeJson(cachePath, nextCache);

        if (cached?.payload) {
          return {
            payload: cached.payload,
            cache: { ...cached, ...nextCache },
            cached: true,
            stale: true,
            rateLimited: true,
          };
        }
        break;
      }

      console.warn(`[inventory] steamId=${steamId} count=${count} -> ${message}`);
    }
  }

  if (cached?.payload) {
    return { payload: cached.payload, cache: cached, cached: true, stale: true, rateLimited };
  }

  throw lastError || new Error("Не удалось загрузить Steam inventory.");
}

async function getInventory(steamId, options = {}) {
  if (inventoryInflight.has(steamId)) {
    return inventoryInflight.get(steamId);
  }

  const task = getInventoryInternal(steamId, options)
    .finally(() => {
      inventoryInflight.delete(steamId);
    });

  inventoryInflight.set(steamId, task);
  return task;
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

function normalizeMarketSearchText(value = "") {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[★™®©]/g, " ")
    .replace(/StatTrak\s*/gi, "stattrak ")
    .replace(/Souvenir\s*/gi, "souvenir ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function marketSearchVariants(marketHashName) {
  const raw = String(marketHashName || "").trim();
  const variants = new Set([raw]);

  const add = (value) => {
    const next = String(value || "").replace(/\s+/g, " ").trim();
    if (next) variants.add(next);
  };

  const noStar = raw.replace(/^★\s*/u, "").trim();
  const noMarks = raw.replace(/[™®©]/g, "").trim();
  const noStarNoMarks = noStar.replace(/[™®©]/g, "").trim();
  const noStatTrak = noStarNoMarks.replace(/StatTrak\s*/gi, "").trim();
  const noSouvenir = noStarNoMarks.replace(/Souvenir\s*/gi, "").trim();
  const noWear = noStarNoMarks.replace(/\s*\((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)\s*/gi, "").trim();
  const noPhase = noWear
    .replace(/Phase\s*[1-4]/gi, "")
    .replace(/(Emerald|Ruby|Sapphire|Black Pearl)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const skinOnly = noPhase.split("|").map((part) => part.trim()).filter(Boolean);
  const knifeModel = skinOnly[0] || "";
  const finishName = skinOnly[1] || "";

  [noStar, noMarks, noStarNoMarks, noStatTrak, noSouvenir, noWear, noPhase].forEach(add);
  if (knifeModel && finishName) {
    add(`${knifeModel} | ${finishName}`);
    add(`${knifeModel} ${finishName}`);
  }
  if (knifeModel) add(knifeModel);
  if (finishName) add(finishName);

  return Array.from(variants).slice(0, 12);
}

function scoreMarketResult(result, target) {
  const names = [result?.hash_name, result?.asset_description?.market_hash_name, result?.name]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  if (names.length === 0) return -1;

  const normalizedTarget = normalizeMarketSearchText(target);
  const targetWithoutWear = normalizedTarget.replace(/\s*\((factory new|minimal wear|field-tested|well-worn|battle-scarred)\)\s*/gi, "").trim();
  const targetWithoutPhase = targetWithoutWear.replace(/phase\s*[1-4]/gi, "").replace(/(emerald|ruby|sapphire|black pearl)/gi, "").replace(/\s+/g, " ").trim();
  const targetParts = targetWithoutPhase.split("|").map((part) => part.trim()).filter(Boolean);
  const wearMatch = normalizedTarget.match(/\(([^)]+)\)/);
  let best = -1;

  for (const candidateName of names) {
    const normalizedCandidate = normalizeMarketSearchText(candidateName);
    const candidateWithoutWear = normalizedCandidate.replace(/\s*\((factory new|minimal wear|field-tested|well-worn|battle-scarred)\)\s*/gi, "").trim();
    const candidateWithoutPhase = candidateWithoutWear.replace(/phase\s*[1-4]/gi, "").replace(/(emerald|ruby|sapphire|black pearl)/gi, "").replace(/\s+/g, " ").trim();
    let score = 0;

    if (normalizedCandidate === normalizedTarget) score += 100;
    if (candidateWithoutWear === targetWithoutWear) score += 40;
    if (candidateWithoutPhase === targetWithoutPhase) score += 35;
    if (normalizedCandidate.replace(/^stattrak\s+/i, "") === normalizedTarget.replace(/^stattrak\s+/i, "")) score += 20;
    if (normalizedCandidate.includes(normalizedTarget) || normalizedTarget.includes(normalizedCandidate)) score += 12;
    if (candidateWithoutPhase.includes(targetWithoutPhase) || targetWithoutPhase.includes(candidateWithoutPhase)) score += 10;

    for (const part of targetParts) {
      if (part && candidateWithoutPhase.includes(part)) score += 10;
    }

    if (wearMatch && normalizedCandidate.includes(`(${normalizeMarketSearchText(wearMatch[1])})`)) score += 10;
    if (/knife|bayonet|karambit|butterfly|talon|ursus|skeleton|stiletto|kukri|falchion|daggers|dagger|m9/i.test(candidateName)) score += 8;

    best = Math.max(best, score);
  }

  return best;
}

async function getPriceSnapshot(marketHashName) {
  const filePath = path.join(PRICES_DIR, `${fileSafe(marketHashName)}.json`);
  const cached = await readJson(filePath, null);

  const buildCachedResponse = () => {
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
    };
  };

  const cachedPrice = Number(cached?.lastValue || 0);
  const cachedFresh = Boolean(cached?.updatedAt) && Date.now() - Number(cached.updatedAt || 0) < PRICE_TTL_MS;

  if (cachedFresh && cachedPrice > 0) {
    return buildCachedResponse();
  }

  const fetchSearchFallbackPrice = async () => {
    const variants = marketSearchVariants(marketHashName);

    for (const query of variants) {
      const searchUrl =
        "https://steamcommunity.com/market/search/render/?" +
        new URLSearchParams({
          query,
          appid: "730",
          norender: "1",
          count: "100",
          start: "0",
          search_descriptions: "0",
          sort_column: "name",
          sort_dir: "asc",
        });

      const searchResponse = await fetch(searchUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 LUDO-app",
          Accept: "application/json, text/plain, */*",
          Referer: "https://steamcommunity.com/market/search?appid=730",
        },
      });

      if (!searchResponse.ok) {
        throw new Error(`Steam market search failed: ${searchResponse.status}`);
      }

      const searchData = await searchResponse.json();
      const results = Array.isArray(searchData?.results) ? searchData.results : [];
      const ranked = results
        .map((item) => ({ item, score: scoreMarketResult(item, marketHashName) }))
        .filter((entry) => entry.score >= 10)
        .sort((a, b) => b.score - a.score);

      const exact = ranked[0]?.item;
      if (!exact) continue;

      const candidateHashName = String(exact?.hash_name || exact?.asset_description?.market_hash_name || "").trim();
      if (candidateHashName) {
        try {
          const candidateOverviewUrl =
            "https://steamcommunity.com/market/priceoverview/?" +
            new URLSearchParams({
              appid: "730",
              currency: "1",
              country: "US",
              market_hash_name: candidateHashName,
            });
          const candidateOverviewResponse = await fetch(candidateOverviewUrl, {
            headers: {
              "User-Agent": "LUDO-app local dev server",
              Accept: "application/json, text/plain, */*",
            },
          });
          if (candidateOverviewResponse.ok) {
            const candidateOverviewData = await candidateOverviewResponse.json();
            if (candidateOverviewData?.success) {
              const candidateParsed = parsePriceString(candidateOverviewData.lowest_price) || parsePriceString(candidateOverviewData.median_price) || 0;
              if (candidateParsed > 0) return candidateParsed;
            }
          }
        } catch {
          // ignore and continue to text/raw search result price
        }
      }

      const textPrice =
        parsePriceString(exact?.sell_price_text) ||
        parsePriceString(exact?.sale_price_text) ||
        parsePriceString(exact?.normal_price_text) ||
        parsePriceString(exact?.median_price_text);

      if (textPrice > 0) return textPrice;

      for (const field of ["sell_price", "sale_price", "normal_price"]) {
        const raw = exact?.[field];
        if (typeof raw === "number" && raw > 0) {
          return raw / 100;
        }
      }
    }

    return 0;
  };

  let parsed = 0;

  try {
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

    if (response.ok) {
      const data = await response.json();
      if (data?.success) {
        parsed = parsePriceString(data.lowest_price) || parsePriceString(data.median_price) || 0;
      }
    } else if (cachedPrice > 0) {
      return buildCachedResponse();
    }
  } catch {
    if (cachedPrice > 0) {
      return buildCachedResponse();
    }
  }

  if (parsed <= 0) {
    try {
      parsed = await fetchSearchFallbackPrice();
    } catch {
      // ignore: fallback to cached/zero below
    }
  }

  if (parsed > 0) {
    const historyRecord = await upsertPriceHistory(marketHashName, parsed);
    const history = Array.isArray(historyRecord.history) ? historyRecord.history : [];
    const last = history[history.length - 1];
    const prev = history[history.length - 2];
    const deltaPct = last && prev && prev.value > 0 ? ((last.value - prev.value) / prev.value) * 100 : 0;
    await sleep(150);

    return {
      marketHashName,
      price: parsed,
      history,
      deltaPct,
      cached: false,
    };
  }

  if (cachedPrice > 0) {
    return buildCachedResponse();
  }

  return { marketHashName, price: 0, history: [], deltaPct: 0, cached: false };
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


function newsKey(item = {}) {
  return `${String(item.url || "").trim().toLowerCase()}::${String(item.title || "").trim().toLowerCase()}`;
}

function dedupeNewsItems(items = []) {
  const seen = new Set();
  return (Array.isArray(items) ? items : [])
    .filter(Boolean)
    .filter((item) => {
      const key = newsKey(item);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => Number(b?.createdAt || 0) - Number(a?.createdAt || 0));
}


function parseRssItems(xml = "", source = "RSS", category = "Мир игр") {
  const items = [];
  const blocks = String(xml || "").match(/<item\b[\s\S]*?<\/item>/gi) || [];

  for (const block of blocks) {
    const title = decodeHtml(stripHtml(block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || ""));
    const url = decodeHtml(block.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || "");
    let body =
      decodeHtml(stripHtml(block.match(/<description>([\s\S]*?)<\/description>/i)?.[1] || "")) ||
      decodeHtml(stripHtml(block.match(/<content:encoded>([\s\S]*?)<\/content:encoded>/i)?.[1] || ""));
    const pubDateRaw =
      decodeHtml(block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] || "") ||
      decodeHtml(block.match(/<dc:date>([\s\S]*?)<\/dc:date>/i)?.[1] || "");
    const createdAt = pubDateRaw
      ? Math.floor((parseDateMaybe(pubDateRaw) || Date.now()) / 1000)
      : Math.floor(Date.now() / 1000);

    let imageUrl =
      decodeHtml(block.match(/<enclosure[^>]+url="([^"]+)"/i)?.[1] || "") ||
      decodeHtml(block.match(/<media:content[^>]+url="([^"]+)"/i)?.[1] || "") ||
      decodeHtml(block.match(/<media:thumbnail[^>]+url="([^"]+)"/i)?.[1] || "") ||
      null;

    if (!imageUrl) {
      imageUrl = extractFirstImage(block, url) || null;
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
      expandable: true,
    });
  }

  return items;
}

async function fetchGameWorldItems() {
  const cachePath = path.join(NEWS_DIR, "games-world-week.json");
  const cached = await readJson(cachePath, null);
  if (cached?.updatedAt && Date.now() - cached.updatedAt < NEWS_TTL_MS && Array.isArray(cached.items) && cached.items.length > 0) {
    return cached.items;
  }

  try {
    const feeds = [
      { source: "StopGame.ru", url: "https://rss.stopgame.ru/rss_news.xml" },
      { source: "PlayGround.ru", url: "https://www.playground.ru/rss/news.xml" },
      { source: "PlayGround.ru", url: "https://www.playground.ru/rss/articles.xml" },
    ];

    const allItems = [];
    for (const feed of feeds) {
      try {
        const xml = await fetchText(feed.url);
        const parsed = parseRssItems(xml, feed.source, "Мир игр").filter((item) => {
          const low = `${item.title} ${item.body} ${item.url}`.toLowerCase();
          return !low.includes("counter-strike 2") && !low.includes("counter strike 2") && !low.includes("cs2");
        });
        allItems.push(...parsed);
        await sleep(120);
      } catch (error) {
        console.warn("[games:feed]", feed.url, error instanceof Error ? error.message : String(error));
      }
    }

    const merged = dedupeNewsItems(allItems);
    if (merged.length === 0 && Array.isArray(cached?.items) && cached.items.length > 0) {
      return dedupeNewsItems(cached.items);
    }
    await writeJson(cachePath, { updatedAt: Date.now(), items: merged });
    return merged;
  } catch (error) {
    console.warn("[games]", error instanceof Error ? error.message : String(error));
    return Array.isArray(cached?.items) ? dedupeNewsItems(cached.items) : [];
  }
}


async function fetchSteamNewsFull() {
  const cachePath = path.join(NEWS_DIR, "steam-news-ru-week.json");
  const cached = await readJson(cachePath, null);
  if (cached?.updatedAt && Date.now() - cached.updatedAt < NEWS_TTL_MS && Array.isArray(cached.items) && cached.items.length > 0) {
    return cached.items;
  }

  const url =
    "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?" +
    new URLSearchParams({
      appid: "730",
      count: "80",
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
    });

    await sleep(120);
  }

  const sorted = nextItems.sort((a, b) => b.createdAt - a.createdAt);
  if (sorted.length === 0 && Array.isArray(cached?.items) && cached.items.length > 0) {
    return cached.items;
  }
  await writeJson(cachePath, { updatedAt: Date.now(), items: sorted });
  return sorted;
}

function extractMetaContent(html = "", key = "") {
  return (
    html.match(new RegExp(`<meta[^>]+property=["']${key}["'][^>]+content=["']([^"']+)["']`, "i"))?.[1] ||
    html.match(new RegExp(`<meta[^>]+name=["']${key}["'][^>]+content=["']([^"']+)["']`, "i"))?.[1] ||
    ""
  );
}

async function fetchCybersportItems() {
  const cachePath = path.join(NEWS_DIR, "esports-cs2-week.json");
  const cached = await readJson(cachePath, null);
  if (cached?.updatedAt && Date.now() - cached.updatedAt < NEWS_TTL_MS && Array.isArray(cached.items) && cached.items.length > 0) {
    return cached.items;
  }

  try {
    const response = await fetch("https://www.cybersport.ru/tags/cs2", {
      headers: { "User-Agent": "Mozilla/5.0 LUDO-app" },
    });

    if (!response.ok) throw new Error(`cybersport_${response.status}`);
    const html = await response.text();

    const urlMatches = [...html.matchAll(/href=["'](\/tags\/cs2\/news\/[^"']+|\/news\/[^"']+)["']/gi)];
    const seen = new Set();
    const urls = [];
    for (const match of urlMatches) {
      const href = match[1] || "";
      const absoluteUrl = href.startsWith("http") ? href : `https://www.cybersport.ru${href}`;
      if (seen.has(absoluteUrl)) continue;
      seen.add(absoluteUrl);
      urls.push(absoluteUrl);
      if (urls.length >= 12) break;
    }

    const articles = [];
    for (const articleUrl of urls) {
      try {
        const articleHtml = await fetchText(articleUrl);
        const title = decodeHtml(extractMetaContent(articleHtml, "og:title") || stripHtml(articleHtml.match(/<title>(.*?)<\/title>/i)?.[1] || ""));
        const description = decodeHtml(extractMetaContent(articleHtml, "og:description"));
        const imageUrl = extractMetaContent(articleHtml, "og:image") || null;
        const published = extractMetaContent(articleHtml, "article:published_time") || extractMetaContent(articleHtml, "og:updated_time");
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
        });
        await sleep(120);
      } catch (error) {
        console.warn("[esports:article]", articleUrl, error instanceof Error ? error.message : String(error));
      }
    }

    const sorted = articles.sort((a, b) => b.createdAt - a.createdAt);
    if (sorted.length === 0 && Array.isArray(cached?.items) && cached.items.length > 0) {
      return cached.items;
    }
    await writeJson(cachePath, { updatedAt: Date.now(), items: sorted });
    return sorted;
  } catch (error) {
    console.warn("[esports]", error instanceof Error ? error.message : String(error));
    return [];
  }
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
  if (user.referral.attachedRefCode) {
    return user.referral;
  }

  const referrerKey = await findKeyByReferralCode(code);
  if (!referrerKey || referrerKey === key) {
    return user.referral;
  }

  const referrer = await readUserState(referrerKey);
  referrer.referral.clicks = Number(referrer.referral.clicks || 0) + 1;
  user.referral.attachedRefCode = code;
  user.referral.attachedAt = Date.now();

  await writeUserState(referrerKey, referrer);
  const savedUser = await writeUserState(key, user);
  const finalizedUser = await finalizeReferralForUser(savedUser);
  return finalizedUser.referral;
}

app.get("/api/translate", async (req, res) => {
  try {
    const textValue = String(req.query.text || "").trim();
    if (!textValue) throw new Error("Передай text");
    const translated = await translateTextToRu(textValue);
    res.json({ ok: true, translated });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Не удалось перевести текст.",
    });
  }
});

app.get("/api/news/article", async (req, res) => {
  try {
    const url = String(req.query.url || "").trim();
    if (!url) throw new Error("Передай url");
    const article = await fetchFullArticle(url);
    res.json({ ok: true, ...article });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Не удалось загрузить статью.",
    });
  }
});

app.get("/api/market/search", async (req, res) => {
  try {
    const query = String(req.query.q || req.query.query || "").trim();
    const limit = Math.min(10, Math.max(1, Number(req.query.limit || 6) || 6));
    if (!query) throw new Error("Передай поисковый запрос.");
    const items = await searchSteamMarketItems(query, limit);
    res.json({ ok: true, items });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Не удалось найти предметы на рынке.",
    });
  }
});

app.get("/api/watchlist/details", async (req, res) => {
  try {
    const key = String(req.query.key || "").trim();
    if (!key) throw new Error("Передай key");
    const state = await readUserState(key);
    const names = Array.from(new Set(Array.isArray(state.watchlist) ? state.watchlist.map((item) => String(item || "").trim()).filter(Boolean) : []));
    const items = await mapWithConcurrency(names, async (marketHashName) => buildMarketWatchItem(marketHashName), 2);
    res.json({ ok: true, items: items.filter(Boolean) });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Не удалось собрать watchlist.",
    });
  }
});

app.get("/api/tickets", async (req, res) => {
  try {
    const adminId = Number(req.query.adminId || 0);
    if (!isAdminId(adminId)) {
      res.status(403).json({ error: "Нет доступа." });
      return;
    }
    const items = (await readTickets()).sort((a, b) => Number(b?.createdAt || 0) - Number(a?.createdAt || 0));
    res.json({ ok: true, items });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Не удалось получить тикеты.",
    });
  }
});

app.post("/api/tickets", async (req, res) => {
  try {
    const key = String(req.body?.key || "").trim() || "guest";
    const message = String(req.body?.message || "").trim();
    if (!message) throw new Error("Опиши проблему перед отправкой.");

    const items = await readTickets();
    const ticket = {
      id: crypto.randomUUID(),
      status: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      message,
      source: {
        type: String(req.body?.sourceType || "app"),
        id: req.body?.sourceId ? String(req.body.sourceId) : null,
        title: String(req.body?.title || "Сообщение о проблеме"),
        url: req.body?.url ? String(req.body.url) : null,
      },
      reporter: {
        name: String(req.body?.reporterName || "Пользователь"),
        handle: req.body?.reporterHandle ? String(req.body.reporterHandle) : null,
        userId: Number.isFinite(Number(req.body?.reporterUserId)) ? Number(req.body.reporterUserId) : null,
      },
      key,
    };
    items.unshift(ticket);
    await writeTickets(items.slice(0, 5000));
    if (Number.isFinite(Number(req.body?.reporterUserId)) && Number(req.body?.reporterUserId) > 0) {
      await recordUserActivity(key, Number(req.body.reporterUserId));
    }
    res.json({ ok: true, item: ticket });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Не удалось создать тикет.",
    });
  }
});

app.post("/api/tickets/:id/status", async (req, res) => {
  try {
    const adminId = Number(req.body?.adminId || 0);
    if (!isAdminId(adminId)) {
      res.status(403).json({ error: "Нет доступа." });
      return;
    }
    const id = String(req.params?.id || "").trim();
    const status = normalizeTicketStatus(req.body?.status);
    const items = await readTickets();
    const next = items.map((ticket) => ticket?.id === id ? { ...ticket, status, updatedAt: Date.now() } : ticket);
    await writeTickets(next);
    const item = next.find((ticket) => ticket?.id === id) || null;
    res.json({ ok: true, item });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Не удалось обновить тикет.",
    });
  }
});


app.get("/api/admin/goals", async (req, res) => {
  try {
    const adminId = Number(req.query.adminId || 0);
    if (!isAdminId(adminId)) {
      res.status(403).json({ error: "Нет доступа." });
      return;
    }
    const weekKey = String(req.query.weekKey || "");
    const goals = await readWeeklyGoals(weekKey);
    res.json({ ok: true, ...goals });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Не удалось получить цели недели.",
    });
  }
});

app.post("/api/admin/goals", async (req, res) => {
  try {
    const adminId = Number(req.body?.adminId || 0);
    if (!isAdminId(adminId)) {
      res.status(403).json({ error: "Нет доступа." });
      return;
    }
    const text = String(req.body?.text || "").trim();
    const weekKey = String(req.body?.weekKey || "");
    const assigneeRaw = String(req.body?.assignee || "").trim();
    const actorName = String(req.body?.actorName || "").trim();
    if (!text) throw new Error("Напиши цель перед добавлением.");

    const current = await readWeeklyGoals(weekKey);
    const item = {
      id: crypto.randomUUID(),
      text: text.slice(0, 240),
      assignee: assigneeRaw ? assigneeRaw.slice(0, 40) : null,
      done: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      updatedBy: adminId,
      updatedByName: actorName ? actorName.slice(0, 80) : null,
    };
    const next = await writeWeeklyGoals({
      ...current,
      weekKey: current.weekKey,
      items: [item, ...current.items].slice(0, 80),
    });
    res.json({ ok: true, ...next, item });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Не удалось добавить цель недели.",
    });
  }
});

app.post("/api/admin/goals/:id/toggle", async (req, res) => {
  try {
    const adminId = Number(req.body?.adminId || 0);
    if (!isAdminId(adminId)) {
      res.status(403).json({ error: "Нет доступа." });
      return;
    }
    const goalId = String(req.params?.id || "").trim();
    const weekKey = String(req.body?.weekKey || "");
    const actorName = String(req.body?.actorName || "").trim();
    const current = await readWeeklyGoals(weekKey);
    const items = current.items.map((goal) =>
      goal?.id === goalId
        ? { ...goal, done: !Boolean(goal?.done), updatedAt: Date.now(), updatedBy: adminId, updatedByName: actorName ? actorName.slice(0, 80) : (goal?.updatedByName || null) }
        : goal
    );
    const next = await writeWeeklyGoals({ ...current, weekKey: current.weekKey, items });
    const item = next.items.find((goal) => goal?.id === goalId) || null;
    res.json({ ok: true, ...next, item });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Не удалось обновить цель недели.",
    });
  }
});

app.delete("/api/admin/goals/:id", async (req, res) => {
  try {
    const adminId = Number(req.body?.adminId || req.query?.adminId || 0);
    if (!isAdminId(adminId)) {
      res.status(403).json({ error: "Нет доступа." });
      return;
    }
    const goalId = String(req.params?.id || "").trim();
    const weekKey = String(req.body?.weekKey || req.query?.weekKey || "");
    const current = await readWeeklyGoals(weekKey);
    const items = current.items.filter((goal) => goal?.id !== goalId);
    const next = await writeWeeklyGoals({ ...current, weekKey: current.weekKey, items });
    res.json({ ok: true, ...next });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Не удалось удалить цель недели.",
    });
  }
});

app.post("/api/activity/ping", async (req, res) => {
  try {
    const key = String(req.body?.key || "").trim() || "guest";
    const tgUserId = Number.isFinite(Number(req.body?.tgUserId)) ? Number(req.body.tgUserId) : null;
    const activeTab = String(req.body?.activeTab || "").trim() || null;
    const steamConnected = Boolean(req.body?.steamConnected);
    const watchlistSize = Number.isFinite(Number(req.body?.watchlistSize)) ? Number(req.body.watchlistSize) : null;

    const activity = await recordUserActivity(key, tgUserId);
    const state = await readUserState(key);
    const next = {
      ...state,
      updatedAt: Date.now(),
      meta: {
        ...(state?.meta || {}),
        lastActiveTab: activeTab,
        steamConnected,
        watchlistSize,
        lastPingAt: Date.now(),
      },
    };
    await writeUserState(key, next);

    res.json({ ok: true, activity });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Не удалось записать активность.",
    });
  }
});

app.get("/api/admin/summary", async (req, res) => {
  try {
    const adminId = Number(req.query.adminId || 0);
    if (!isAdminId(adminId)) {
      res.status(403).json({ error: "Нет доступа." });
      return;
    }
    const summary = await getAdminSummary();
    res.json({ ok: true, summary });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Не удалось собрать сводку.",
    });
  }
});

app.get("/api/health", async (_req, res) => {
  await Promise.all([ensureDir(DATA_DIR), ensureDir(USERS_DIR), ensureDir(PRICES_DIR), ensureDir(NEWS_DIR), ensureDir(ITEMS_DIR)]);
  res.json({
    ok: true,
    frontendOrigin: FRONTEND_ORIGIN,
    hasSteamKey: Boolean(STEAM_WEB_API_KEY),
    dataDir: DATA_DIR,
    passSeason: PASS_SEASON_KEY,
  });
});

app.get("/api/news", async (_req, res) => {
  try {
    const [updatesRaw, esportsRaw, gamesRaw] = await Promise.all([
      fetchSteamNewsFull(),
      fetchCybersportItems(),
      fetchGameWorldItems(),
    ]);

    const updates = dedupeNewsItems(updatesRaw);
    const used = new Set(updates.map((item) => newsKey(item)));

    const esports = dedupeNewsItems(esportsRaw).filter((item) => {
      const key = newsKey(item);
      if (!key || used.has(key)) return false;
      used.add(key);
      return true;
    });

    const games = dedupeNewsItems(gamesRaw).filter((item) => {
      const key = newsKey(item);
      return Boolean(key) && !used.has(key);
    });

    if (updates.length === 0 && esports.length === 0 && games.length === 0) {
      const [updatesCache, esportsCache, gamesCache] = await Promise.all([
        readJson(path.join(NEWS_DIR, "steam-news-ru-week.json"), { items: [] }),
        readJson(path.join(NEWS_DIR, "esports-cs2-week.json"), { items: [] }),
        readJson(path.join(NEWS_DIR, "games-world-week.json"), { items: [] }),
      ]);

      return res.json({
        updates: dedupeNewsItems(updatesCache.items || []),
        esports: dedupeNewsItems(esportsCache.items || []),
        games: dedupeNewsItems(gamesCache.items || []),
        windowDays: 7,
        cached: true,
      });
    }

    res.json({ updates, esports, games, windowDays: 7, cached: true });
  } catch (error) {
    console.warn("[api/news]", error instanceof Error ? error.message : String(error));
    const [updatesCache, esportsCache, gamesCache] = await Promise.all([
      readJson(path.join(NEWS_DIR, "steam-news-ru-week.json"), { items: [] }),
      readJson(path.join(NEWS_DIR, "esports-cs2-week.json"), { items: [] }),
      readJson(path.join(NEWS_DIR, "games-world-week.json"), { items: [] }),
    ]);

    res.json({
      updates: dedupeNewsItems(updatesCache.items || []),
      esports: dedupeNewsItems(esportsCache.items || []),
      games: dedupeNewsItems(gamesCache.items || []),
      windowDays: 7,
      cached: true,
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
    await Promise.all([ensureDir(DATA_DIR), ensureDir(USERS_DIR), ensureDir(PRICES_DIR), ensureDir(NEWS_DIR), ensureDir(ITEMS_DIR)]);

    const profileInput = String(req.query.profile || "");
    const key = String(req.query.key || "guest");
    const force = String(req.query.force || "") === "1";
    const telegram = normalizeTelegramIdentity(req.query);

    const resolved = await resolveSteamProfile(profileInput);
    const summary = await getPlayerSummary(resolved.steamId, resolved.profileUrl);
    const inventoryResult = await getInventory(resolved.steamId, { force });
    const inventoryPayload = inventoryResult.payload;

    let items = Array.isArray(inventoryResult?.cache?.items) ? inventoryResult.cache.items : [];
    let totalValue = Number(inventoryResult?.cache?.totalValue || 0);
    let marketableCount = items.filter((item) => item.marketable).length;
    let pricedCount = items.filter((item) => Number(item.price || 0) > 0).length;
    const hasReadyItems = Array.isArray(inventoryResult?.cache?.items) && inventoryResult.cache.items.length > 0;
    const hasBrokenValuationCache = hasReadyItems && marketableCount > 0 && pricedCount === 0;
    const shouldRebuildItems =
      !hasReadyItems ||
      (!inventoryResult.cached && !inventoryResult.stale) ||
      hasBrokenValuationCache;

    if (shouldRebuildItems) {
      const descriptions = Array.isArray(inventoryPayload?.descriptions) ? inventoryPayload.descriptions : [];
      const uniqueNames = [
        ...new Set(
          descriptions
            .filter((entry) => entry?.marketable && (entry?.market_hash_name || entry?.name))
            .map((entry) => entry?.market_hash_name || entry?.name)
        ),
      ].filter(Boolean);

      const pricedEntries = await mapWithConcurrency(
        uniqueNames,
        async (name) => {
          try {
            return [name, await getPriceSnapshot(name)];
          } catch (error) {
            console.warn("[price]", name, error instanceof Error ? error.message : String(error));
            return [name, { marketHashName: name, price: 0, history: [], deltaPct: 0 }];
          }
        },
        inventoryResult.rateLimited ? 1 : 2
      );

      const priceMap = Object.fromEntries(pricedEntries);
      items = buildInventoryItems(inventoryPayload, priceMap);
      totalValue = items.reduce((sum, item) => sum + item.totalValue, 0);
      marketableCount = items.filter((item) => item.marketable).length;
      pricedCount = items.filter((item) => item.price > 0).length;

      await writeJson(inventoryCachePath(resolved.steamId), {
        ...(inventoryResult.cache || {}),
        updatedAt: Date.now(),
        payload: inventoryPayload,
        items,
        totalValue,
        personaname: summary?.personaname || resolved.profile?.personaname || null,
        profile: summary || resolved.profile || null,
        rateLimitedUntil: null,
        lastError: null,
      });
    }

    const user = await readUserState(key);
    user.steam = {
      input: profileInput,
      steamid: resolved.steamId,
      personaname: summary?.personaname || resolved.profile?.personaname || "Steam player",
      avatarfull: summary?.avatarfull || resolved.profile?.avatarfull || null,
    };
    if (telegram) {
      user.telegram = telegram;
    }
    await writeUserState(key, user);

    res.json({
      steamid: resolved.steamId,
      personaname: summary?.personaname || resolved.profile?.personaname || null,
      profile: summary || resolved.profile,
      totalValue,
      items,
      pricedCount,
      marketableCount,
      updatedAt: Date.now(),
      cached: inventoryResult.cached,
      stale: inventoryResult.stale,
      rateLimited: inventoryResult.rateLimited,
      message: inventoryResult.rateLimited ? "Steam временно режет запросы, поэтому отдали последние сохранённые данные." : null,
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

app.get("/api/me", async (req, res) => {
  try {
    const me = await upsertTelegramProfile(req.query || {});
    res.json(me);
  } catch (error) {
    const key = String(req.query?.key || "guest").trim() || "guest";
    const state = await readUserState(key);
    res.json({
      key,
      state,
      tgUserId: null,
      identity: null,
      isAdmin: false,
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
    const incoming = { ...req.body };
    const telegram = normalizeTelegramIdentity({
      tgUserId: req.body?.tgUserId,
      username: req.body?.tgIdentity?.handle ? String(req.body.tgIdentity.handle).replace(/^@/, "") : req.body?.telegram?.username,
      firstName: req.body?.tgIdentity?.name || req.body?.telegram?.firstName,
      photoUrl: req.body?.tgIdentity?.avatar || req.body?.telegram?.photoUrl,
    });
    if (telegram) {
      incoming.telegram = telegram;
    }
    const state = await writeUserState(key, incoming);
    if (telegram?.id) {
      await recordUserActivity(key, telegram.id);
      const finalized = await finalizeReferralForUser(state);
      res.json(finalized);
      return;
    }
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
    await recordUserActivity(key, state?.telegram?.id || null);
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

await Promise.all([ensureDir(DATA_DIR), ensureDir(USERS_DIR), ensureDir(PRICES_DIR), ensureDir(NEWS_DIR), ensureDir(ITEMS_DIR)]);
await initDb();
await migrateLegacyJsonToPostgres();

app.listen(PORT, HOST, () => {
  console.log(`LUDO API listening on http://${HOST}:${PORT}`);
  console.log(`LUDO Postgres storage: connected`);
});
