// SERVER PATCH: вставь в ludo-api-server.mjs

// 1) Добавь рядом с константами
const ADMIN_IDS = new Set([793655800, 1069618912]);

function tgUserKeyFromId(id) {
  return `tg-${Number(id)}`;
}

function normalizeTelegramIdentity(raw = {}) {
  const id = Number(raw?.id || 0);
  if (!id) return null;
  return {
    id,
    username: String(raw?.username || ""),
    first_name: String(raw?.first_name || ""),
    last_name: String(raw?.last_name || ""),
    photo_url: raw?.photo_url ? String(raw.photo_url) : null,
  };
}

function displayNameFromTelegram(user) {
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(" ").trim();
  return name || user?.username || "Telegram user";
}

// 2) Добавь helpers для users dir
const USERS_DIR = path.join(DATA_DIR, "users");

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function readJsonSafe(filePath, fallback) {
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJsonSafe(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.promises.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function userProfilePathByKey(key) {
  return path.join(USERS_DIR, `${String(key)}.json`);
}

async function readUserProfile(key) {
  const fallback = {
    key,
    telegram: null,
    savedNewsIds: [],
    watchlist: [],
    settings: {
      notifications: true,
      quietHours: { enabled: true, start: "23:00", end: "09:00" },
      dailyReminder: true,
    },
    daily: {
      streak: 0,
      lastCheckinDate: null,
      reminderEnabled: true,
      lastReward: null,
    },
    referral: {
      code: "",
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
  };
  return readJsonSafe(userProfilePathByKey(key), fallback);
}

async function writeUserProfile(key, profile) {
  await writeJsonSafe(userProfilePathByKey(key), { ...profile, key });
}

// 3) Добавь новый endpoint /api/me
app.post("/api/me", async (req, res) => {
  try {
    const telegramUser = normalizeTelegramIdentity(req.body?.telegramUser || {});
    if (!telegramUser?.id) {
      return res.status(400).json({ error: "telegram_user_required" });
    }

    const key = tgUserKeyFromId(telegramUser.id);
    const existing = await readUserProfile(key);

    const referralCode =
      existing?.referral?.code ||
      `LUDO${telegramUser.id.toString(16).toUpperCase()}`;

    const profileState = {
      ...existing,
      key,
      telegram: telegramUser,
      referral: {
        ...(existing.referral || {}),
        code: referralCode,
      },
    };

    await writeUserProfile(key, profileState);

    return res.json({
      ok: true,
      telegramId: telegramUser.id,
      isAdmin: ADMIN_IDS.has(telegramUser.id),
      key,
      identity: {
        name: displayNameFromTelegram(telegramUser),
        handle: telegramUser.username ? `@${telegramUser.username}` : "Telegram",
        avatar: telegramUser.photo_url || null,
      },
      profileState,
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "me_failed",
    });
  }
});

// 4) Подправь GET /api/profile-state так, чтобы он читал tg-user профили как обычные
// если такого endpoint у тебя уже нет — пропусти.
// Важно: он должен читать profile по key без guest-only логики.

// 5) Подправь POST /api/profile-state так, чтобы он сохранял состояние в users/<key>.json
// Пример:
app.post("/api/profile-state", async (req, res) => {
  try {
    const key = String(req.body?.key || "").trim();
    if (!key) return res.status(400).json({ error: "key_required" });

    const current = await readUserProfile(key);
    const next = {
      ...current,
      ...req.body,
      key,
      settings: {
        ...current.settings,
        ...(req.body?.settings || {}),
        quietHours: {
          ...current.settings?.quietHours,
          ...(req.body?.settings?.quietHours || {}),
        },
      },
      daily: { ...current.daily, ...(req.body?.daily || {}) },
      referral: { ...current.referral, ...(req.body?.referral || {}) },
      steam: { ...current.steam, ...(req.body?.steam || {}) },
    };

    await writeUserProfile(key, next);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "profile_state_failed" });
  }
});

app.get("/api/profile-state", async (req, res) => {
  try {
    const key = String(req.query?.key || "").trim();
    if (!key) return res.status(400).json({ error: "key_required" });
    const profile = await readUserProfile(key);
    res.json(profile);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "profile_state_read_failed" });
  }
});

// 6) В /api/steam/inventory после успешного чтения инвентаря допиши сохранение steam в профиль пользователя
// Прямо после того как вычислил steamid / personaname / avatarfull:
if (key) {
  const profile = await readUserProfile(String(key));
  profile.steam = {
    ...(profile.steam || {}),
    input: String(req.query?.profile || ""),
    steamid: String(steamid || ""),
    personaname: personaname || profile?.steam?.personaname || "",
    avatarfull: profileData?.avatarfull || profile?.steam?.avatarfull || null,
  };
  await writeUserProfile(String(key), profile);
}
