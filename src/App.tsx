// APP PATCH: вставь в src/App.tsx

// 1) Обнови declare global блок
declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        ready?: () => void;
        expand?: () => void;
        initData?: string;
        initDataUnsafe?: {
          user?: {
            id?: number;
            username?: string;
            first_name?: string;
            last_name?: string;
            photo_url?: string;
          };
          start_param?: string;
        };
      };
    };
  }
}

// 2) Добавь рядом с createGuestKey/readStartParam
function getTelegramWebAppUser() {
  const tg = window.Telegram?.WebApp;
  const user = tg?.initDataUnsafe?.user;
  if (user?.id) {
    return {
      id: Number(user.id),
      username: user.username || "",
      first_name: user.first_name || "",
      last_name: user.last_name || "",
      photo_url: user.photo_url || "",
      start_param: tg?.initDataUnsafe?.start_param || "",
      initData: tg?.initData || "",
    };
  }
  return null;
}

async function waitForTelegramUser(timeoutMs = 3000, stepMs = 150) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = getTelegramWebAppUser();
    if (found?.id) return found;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return null;
}

// 3) Замени useEffect, который сейчас один раз читает initDataUnsafe.user, на это:
useEffect(() => {
  let cancelled = false;

  async function bootTelegram() {
    window.Telegram?.WebApp?.ready?.();
    window.Telegram?.WebApp?.expand?.();

    const telegramUser = await waitForTelegramUser();
    if (cancelled) return;

    const nextUserKey = telegramUser?.id ? `tg-${telegramUser.id}` : createGuestKey();
    setUserKey(nextUserKey);
    setTgUserId(telegramUser?.id ?? null);

    if (telegramUser?.id) {
      const fullName = [telegramUser.first_name, telegramUser.last_name].filter(Boolean).join(" ").trim();
      setTgIdentity({
        name: fullName || telegramUser.username || "Telegram user",
        handle: telegramUser.username ? `@${telegramUser.username}` : "Telegram",
        avatar: telegramUser.photo_url || null,
      });

      if (apiBase) {
        fetch(`${apiBase}/api/me`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            telegramUser: {
              id: telegramUser.id,
              username: telegramUser.username || "",
              first_name: telegramUser.first_name || "",
              last_name: telegramUser.last_name || "",
              photo_url: telegramUser.photo_url || "",
            },
            startParam: telegramUser.start_param || "",
            initData: telegramUser.initData || "",
          }),
        })
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => {
            if (!data || cancelled) return;

            if (data.identity) {
              setTgIdentity({
                name: data.identity.name || "Telegram user",
                handle: data.identity.handle || "Telegram",
                avatar: data.identity.avatar || null,
              });
            }

            if (typeof data.telegramId === "number") {
              setTgUserId(data.telegramId);
              setUserKey(`tg-${data.telegramId}`);
            }

            if (data.profileState) {
              setProfileState((current) => ({
                ...current,
                ...data.profileState,
                settings: {
                  ...current.settings,
                  ...(data.profileState.settings || {}),
                  quietHours: {
                    ...current.settings.quietHours,
                    ...(data.profileState.settings?.quietHours || {}),
                  },
                },
                daily: { ...current.daily, ...(data.profileState.daily || {}) },
                referral: { ...current.referral, ...(data.profileState.referral || {}) },
                steam: { ...current.steam, ...(data.profileState.steam || {}) },
              }));

              if (data.profileState.steam?.input) setSteamInput(data.profileState.steam.input);
              if (data.profileState.steam?.steamid) {
                setSteamConnected(true);
                setSteamId(String(data.profileState.steam.steamid || ""));
                setSteamName(data.profileState.steam.personaname || "Steam player");
                setSteamAvatar(data.profileState.steam.avatarfull || null);
              }
            }
          })
          .catch(() => {});
      }
    }
  }

  bootTelegram();
  return () => {
    cancelled = true;
  };
}, [apiBase]);

// 4) Добавь этот useMemo рядом с userIdentity / профилем
const isAdmin = useMemo(() => {
  return tgUserId ? ADMIN_IDS.has(tgUserId) : false;
}, [tgUserId]);

// 5) Там, где у тебя рисуется плитка/секция админки в профиле, показывай её только если isAdmin.
// Пример:
{isAdmin ? (
  <MenuTile
    title="Админка"
    value="тикеты и очередь"
    active={profileSection === "admin"}
    onClick={() => setProfileSection("admin")}
    tone="border-rose-300/30 bg-rose-400/10"
  />
) : null}

// 6) И сам блок admin тоже заверни в isAdmin
{profileSection === "admin" && isAdmin ? (
  <Section title="Админка">
    <div className="text-sm text-neutral-300">Тут будет очередь тикетов и быстрые действия администратора.</div>
  </Section>
) : null}
