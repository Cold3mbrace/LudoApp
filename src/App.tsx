import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Bell,
  BellOff,
  Bookmark,
  BookmarkCheck,
  CheckCircle2,
  Clock3,
  Copy,
  ExternalLink,
  FolderOpen,
  Gift,
  HelpCircle,
  Link2,
  Loader2,
  MessageCircle,
  Newspaper,
  Radar,
  RefreshCw,
  Search,
  Share2,
  User,
  Users,
  Wallet,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        ready?: () => void;
        expand?: () => void;
        openTelegramLink?: (url: string) => void;
        openLink?: (url: string) => void;
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

type TabId = "feed" | "inventory" | "radar" | "item" | "profile";
type FeedFilter = "Все новости" | "Апдейты" | "Киберспорт" | "Рынок" | "Мир игр";
type RangeId = "day" | "week" | "month" | "year";
type ProfileSectionId = "settings" | "daily" | "referral" | "saved" | "steam" | "faq" | "admin" | "tickets";
type ItemKind = "Все" | "Скины" | "Кейсы" | "Наклейки" | "Капсулы" | "Ножи" | "Перчатки" | "Другое";

type FeedItem = {
  id: string;
  category: "Апдейты" | "Киберспорт" | "Рынок" | "Мир игр";
  title: string;
  body: string;
  url?: string | null;
  createdAt: number;
  source: string;
  imageUrl?: string | null;
  expandable?: boolean;
};

type Ticket = {
  id: string;
  status: string;
  createdAt: number;
  updatedAt?: number;
  message: string;
  source?: {
    type?: string;
    id?: string | null;
    title?: string;
    url?: string | null;
  };
  reporter?: {
    name?: string;
    handle?: string | null;
    userId?: number | null;
  };
};

type HistoryPoint = { ts: number; value: number };

type InventoryItem = {
  id: string;
  marketHashName: string;
  name: string;
  type: string;
  iconUrl: string | null;
  tradable: boolean;
  marketable: boolean;
  quantity: number;
  price: number;
  totalValue: number;
  deltaPct: number;
  history: HistoryPoint[];
  note: string;
  descriptionText: string;
};

type ProfileState = {
  key: string;
  savedNewsIds: string[];
  watchlist: string[];
  settings: {
    notifications: boolean;
    quietHours: {
      enabled: boolean;
      start: string;
      end: string;
    };
    dailyReminder: boolean;
  };
  daily: {
    streak: number;
    lastCheckinDate: string | null;
    reminderEnabled: boolean;
    lastReward: string | null;
  };
  referral: {
    code: string;
    clicks: number;
    verified: number;
    points: number;
    attachedRefCode: string | null;
    attachedAt: number | null;
  };
  steam: {
    input: string;
    steamid: string;
    personaname: string;
    avatarfull: string | null;
  };
};

type UserIdentity = {
  name: string;
  handle?: string;
  avatar?: string | null;
};

type MeResponse = {
  key: string;
  state?: ProfileState;
  identity?: UserIdentity;
  tgUserId?: number | null;
  isAdmin?: boolean;
};

const tabs: Array<{ id: TabId; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: "feed", label: "Лента", icon: Newspaper },
  { id: "inventory", label: "Инвентарь", icon: Wallet },
  { id: "radar", label: "Радар", icon: Radar },
  { id: "item", label: "Предмет", icon: Search },
  { id: "profile", label: "Профиль", icon: User },
];

const itemKinds: ItemKind[] = ["Все", "Скины", "Кейсы", "Наклейки", "Капсулы", "Ножи", "Перчатки", "Другое"];
const ADMIN_IDS = new Set([793655800, 1069618912]);
const SUPPORT_LINK = "https://t.me/ludodropz";
const COMMUNITY_LINK = "https://t.me/ludoinv_chat";

const defaultProfileState = (key: string): ProfileState => ({
  key,
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
});

function money(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function timeAgoRu(timestamp?: number) {
  if (!timestamp) return "сейчас";
  const diffMs = Date.now() - timestamp * 1000;
  const diffMin = Math.max(1, Math.round(diffMs / 60000));
  if (diffMin < 60) return `${diffMin} мин назад`;
  const diffHours = Math.round(diffMin / 60);
  if (diffHours < 24) return `${diffHours} ч назад`;
  const diffDays = Math.round(diffHours / 24);
  return `${diffDays} дн назад`;
}

function deltaClass(delta: number) {
  return delta >= 0 ? "text-emerald-300" : "text-rose-300";
}

function deltaLabel(delta: number) {
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta.toFixed(2)}%`;
}

function sectionTone(category: FeedItem["category"]) {
  if (category === "Рынок") return "bg-emerald-500/15 text-emerald-200 border-emerald-400/20";
  if (category === "Киберспорт") return "bg-fuchsia-500/15 text-fuchsia-200 border-fuchsia-400/20";
  if (category === "Мир игр") return "bg-violet-500/15 text-violet-200 border-violet-400/20";
  return "bg-cyan-500/15 text-cyan-200 border-cyan-400/20";
}

function toneForFilter(filter: FeedFilter) {
  if (filter === "Все новости") return "border-amber-300/30 bg-amber-400/15 text-amber-100";
  if (filter === "Апдейты") return "border-cyan-300/30 bg-cyan-400/15 text-cyan-100";
  if (filter === "Киберспорт") return "border-fuchsia-300/30 bg-fuchsia-400/15 text-fuchsia-100";
  if (filter === "Мир игр") return "border-violet-300/30 bg-violet-400/15 text-violet-100";
  return "border-emerald-300/30 bg-emerald-400/15 text-emerald-100";
}

function toneForKind(kind: ItemKind) {
  if (kind === "Все") return "border-white/10 bg-white/5 text-white/90";
  if (kind === "Скины") return "border-cyan-300/30 bg-cyan-400/15 text-cyan-100";
  if (kind === "Кейсы") return "border-amber-300/30 bg-amber-400/15 text-amber-100";
  if (kind === "Наклейки") return "border-fuchsia-300/30 bg-fuchsia-400/15 text-fuchsia-100";
  if (kind === "Капсулы") return "border-violet-300/30 bg-violet-400/15 text-violet-100";
  if (kind === "Ножи") return "border-rose-300/30 bg-rose-400/15 text-rose-100";
  if (kind === "Перчатки") return "border-emerald-300/30 bg-emerald-400/15 text-emerald-100";
  return "border-white/10 bg-white/5 text-white/80";
}

function classifyItemKind(item: Pick<InventoryItem, "name" | "type" | "marketHashName">): ItemKind {
  const hay = `${item.name} ${item.type} ${item.marketHashName}`.toLowerCase();
  if (hay.includes("case") || hay.includes("container") || hay.includes("weapon case")) return "Кейсы";
  if (hay.includes("capsule")) return "Капсулы";
  if (hay.includes("sticker") || hay.includes("patch") || hay.includes("graffiti")) return "Наклейки";
  if (hay.includes("gloves") || hay.includes("hand wraps") || hay.includes("driver gloves") || hay.includes("sport gloves") || hay.includes("specialist gloves") || hay.includes("moto gloves") || hay.includes("hydra gloves")) return "Перчатки";
  if (hay.includes("knife") || hay.includes("bayonet") || hay.includes("karambit") || hay.includes("butterfly") || hay.includes("dagger") || hay.includes("talon") || hay.includes("ursus") || hay.includes("stiletto") || hay.includes("falchion") || hay.includes("bowie") || item.name.includes("★")) return "Ножи";
  if (hay.includes("field-tested") || hay.includes("factory new") || hay.includes("minimal wear") || hay.includes("battle-scarred") || hay.includes("well-worn") || hay.includes("weapon") || hay.includes("rifle") || hay.includes("pistol") || hay.includes("sniper") || hay.includes("shotgun") || hay.includes("smg")) return "Скины";
  return "Другое";
}

function historyRangeLabel(range: RangeId) {
  if (range === "day") return "День";
  if (range === "week") return "Неделя";
  if (range === "month") return "Месяц";
  return "Год";
}

function formatAxisLabel(ts: number, range: RangeId) {
  const date = new Date(ts);
  if (range === "day") return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (range === "week") return date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
  if (range === "month") return date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
  return date.toLocaleDateString("ru-RU", { month: "short", year: "2-digit" });
}

function filterHistory(points: HistoryPoint[], range: RangeId) {
  const now = Date.now();
  const ms = {
    day: 1000 * 60 * 60 * 24,
    week: 1000 * 60 * 60 * 24 * 7,
    month: 1000 * 60 * 60 * 24 * 30,
    year: 1000 * 60 * 60 * 24 * 365,
  }[range];
  const filtered = points.filter((point) => point.ts >= now - ms);
  return filtered.length >= 2 ? filtered : points.slice(-8);
}

function buildSvgPolyline(points: HistoryPoint[], width = 100, height = 48) {
  if (points.length < 2) return "";
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const xStep = width / Math.max(1, points.length - 1);
  return points
    .map((point, index) => {
      const x = index * xStep;
      const ratio = max === min ? 0.5 : (point.value - min) / (max - min);
      const y = height - ratio * height;
      return `${x},${y}`;
    })
    .join(" ");
}

function initials(name: string) {
  const clean = name.trim();
  if (!clean) return "L";
  return clean
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("");
}

function loadLocalState(key: string): ProfileState {
  try {
    const raw = localStorage.getItem(`ludo-state-${key}`);
    if (!raw) return defaultProfileState(key);
    const parsed = JSON.parse(raw);
    return {
      ...defaultProfileState(key),
      ...parsed,
      settings: {
        ...defaultProfileState(key).settings,
        ...parsed.settings,
        quietHours: {
          ...defaultProfileState(key).settings.quietHours,
          ...(parsed.settings?.quietHours || {}),
        },
      },
      daily: { ...defaultProfileState(key).daily, ...(parsed.daily || {}) },
      referral: { ...defaultProfileState(key).referral, ...(parsed.referral || {}) },
      steam: { ...defaultProfileState(key).steam, ...(parsed.steam || {}) },
    };
  } catch {
    return defaultProfileState(key);
  }
}

function saveLocalState(key: string, state: ProfileState) {
  localStorage.setItem(`ludo-state-${key}`, JSON.stringify(state));
}


function normalizeFeedFingerprint(value: string) {
  return String(value || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-zа-яё0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function feedDedupeKey(item: FeedItem) {
  if (item.url) {
    return `url:${item.url.split("#")[0].replace(/[?&](utm_[^=&]+|ref|source)=[^&]+/gi, "").replace(/[?&]$/, "")}`;
  }
  const title = normalizeFeedFingerprint(item.title);
  const body = normalizeFeedFingerprint(item.body).slice(0, 180);
  return `text:${title}::${body}`;
}

function dedupeFeedItems(items: FeedItem[]) {
  const map = new Map<string, FeedItem>();
  for (const item of items) {
    const key = feedDedupeKey(item);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, item);
      continue;
    }
    const existingScore = (existing.imageUrl ? 1 : 0) + Math.min(existing.body.length, 800) / 800 + existing.createdAt / 10_000_000_000;
    const nextScore = (item.imageUrl ? 1 : 0) + Math.min(item.body.length, 800) / 800 + item.createdAt / 10_000_000_000;
    if (nextScore > existingScore) map.set(key, item);
  }
  return [...map.values()].sort((a, b) => b.createdAt - a.createdAt);
}

function loadFeedCache(kind: "updates" | "esports" | "games") {
  try {
    const raw = localStorage.getItem(`ludo-feed-v7-${kind}`);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveFeedCache(kind: "updates" | "esports" | "games", items: FeedItem[]) {
  localStorage.setItem(`ludo-feed-v7-${kind}`, JSON.stringify(items));
}

function createGuestKey() {
  const existing = localStorage.getItem("ludo-guest-key");
  if (existing) return existing;
  const next = `guest-${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem("ludo-guest-key", next);
  return next;
}

function readStartParam() {
  const tgStart = window.Telegram?.WebApp?.initDataUnsafe?.start_param;
  if (tgStart) return tgStart;
  const params = new URLSearchParams(window.location.search);
  return params.get("startapp") || params.get("startattach") || params.get("ref") || "";
}

function AppShell({ children, bottomNav }: { children: React.ReactNode; bottomNav: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-[#07050E] text-white">
      <div className="mx-auto min-h-screen w-full max-w-md bg-gradient-to-b from-[#0B0817] via-[#0F0B1A] to-[#080611]">{children}</div>
      <div className="fixed bottom-0 left-1/2 z-50 w-full max-w-md -translate-x-1/2 border-t border-white/10 bg-[#0A0716]/96 px-2 py-2 backdrop-blur-xl">
        {bottomNav}
      </div>
    </main>
  );
}

function Section({ title, action, children, className = "" }: { title: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <Card className={`rounded-[1.5rem] border border-white/10 bg-white/5 shadow-[0_10px_30px_rgba(0,0,0,0.22)] ${className}`}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base text-white">{title}</CardTitle>
          {action}
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function UserPill({ identity }: { identity: UserIdentity }) {
  return (
    <div className="flex w-full max-w-full sm:max-w-[220px] sm:w-[220px] shrink-0 items-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-3 py-2">
      {identity.avatar ? (
        <img src={identity.avatar} alt={identity.name} className="h-10 w-10 rounded-full object-cover" />
      ) : (
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-sm font-semibold text-white">{initials(identity.name)}</div>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-white">{identity.name}</div>
        <div className="truncate text-xs text-neutral-400">{identity.handle || "LUDO profile"}</div>
      </div>
    </div>
  );
}

function MenuTile({ title, value, active, onClick, tone }: { title: string; value: string; active: boolean; onClick: () => void; tone: string }) {
  return (
    <button onClick={onClick} className={`min-w-0 w-full rounded-2xl border p-4 text-left transition ${active ? tone : "border-white/10 bg-black/20 hover:bg-white/10"}`}>
      <div className="truncate text-sm font-semibold text-white">{title}</div>
      <div className="mt-1 truncate text-xs text-neutral-400">{value}</div>
    </button>
  );
}

export default function App() {
  const apiBase = ((import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_API_BASE_URL || "").replace(/\/$/, "");
  const contentRef = useRef<HTMLDivElement | null>(null);

  const [tgIdentity, setTgIdentity] = useState<UserIdentity | null>(null);
  const [tgUserId, setTgUserId] = useState<number | null>(null);
  const [userKey, setUserKey] = useState("guest");
  const [profileState, setProfileState] = useState<ProfileState>(() => defaultProfileState("guest"));
  const [profileStateLoaded, setProfileStateLoaded] = useState(false);
  const [backendHydrated, setBackendHydrated] = useState(false);
  const [profileSection, setProfileSection] = useState<ProfileSectionId>("settings");

  const [activeTab, setActiveTab] = useState<TabId>("feed");
  const [feedFilter, setFeedFilter] = useState<FeedFilter>("Все новости");
  const [savedOnly, setSavedOnly] = useState(false);
  const [updatesFeed, setUpdatesFeed] = useState<FeedItem[]>(() => loadFeedCache("updates"));
  const [esportsFeed, setEsportsFeed] = useState<FeedItem[]>(() => loadFeedCache("esports"));
  const [gamesFeed, setGamesFeed] = useState<FeedItem[]>(() => loadFeedCache("games"));
  const [newsLoading, setNewsLoading] = useState(false);
  const [newsStatus, setNewsStatus] = useState("");
  const [expandedNewsIds, setExpandedNewsIds] = useState<string[]>([]);
  const [fullArticleMap, setFullArticleMap] = useState<Record<string, string>>({});
  const [articleLoadingId, setArticleLoadingId] = useState<string | null>(null);

  const [steamInput, setSteamInput] = useState("");
  const [steamLoading, setSteamLoading] = useState(false);
  const [steamError, setSteamError] = useState("");
  const [steamConnected, setSteamConnected] = useState(false);
  const [steamId, setSteamId] = useState("");
  const [steamName, setSteamName] = useState("LUDO Player");
  const [steamAvatar, setSteamAvatar] = useState<string | null>(null);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [inventorySearch, setInventorySearch] = useState("");
  const [inventoryKindFilter, setInventoryKindFilter] = useState<ItemKind>("Все");
  const [watchlistSearch, setWatchlistSearch] = useState("");
  const [watchlistKindFilter, setWatchlistKindFilter] = useState<ItemKind>("Все");
  const [inventoryStatus, setInventoryStatus] = useState("Steam ещё не подключён.");
  const [totalValue, setTotalValue] = useState(0);

  const [selectedItemHash, setSelectedItemHash] = useState("");
  const [historyRange, setHistoryRange] = useState<RangeId>("week");
  const [selectedHistory, setSelectedHistory] = useState<HistoryPoint[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [translatedDescription, setTranslatedDescription] = useState("");
  const [dailyMessage, setDailyMessage] = useState("");
  const [ticketDialogOpen, setTicketDialogOpen] = useState(false);
  const [ticketDraft, setTicketDraft] = useState("");
  const [ticketSending, setTicketSending] = useState(false);
  const [ticketSubmitStatus, setTicketSubmitStatus] = useState("");
  const [ticketContext, setTicketContext] = useState<{ title: string; url?: string | null; sourceType: string; sourceId?: string | null } | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [ticketsLoading, setTicketsLoading] = useState(false);


  const userIdentity = useMemo<UserIdentity>(() => {
    if (tgIdentity) return tgIdentity;
    return {
      name: steamName || "LUDO Player",
      handle: steamConnected ? "Steam connected" : "Guest mode",
      avatar: steamAvatar,
    };
  }, [tgIdentity, steamName, steamConnected, steamAvatar]);

  const isAdmin = Boolean(tgUserId && ADMIN_IDS.has(tgUserId));

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      window.Telegram?.WebApp?.ready?.();
      window.Telegram?.WebApp?.expand?.();

      const telegramUser = window.Telegram?.WebApp?.initDataUnsafe?.user;
      const fallbackKey = createGuestKey();
      const nextTgUserId = typeof telegramUser?.id === "number" ? telegramUser.id : null;
      const fullName = [telegramUser?.first_name, telegramUser?.last_name].filter(Boolean).join(" ").trim();

      if (nextTgUserId) {
        setTgUserId(nextTgUserId);
        setTgIdentity({
          name: fullName || telegramUser?.username || "Telegram user",
          handle: telegramUser?.username ? `@${telegramUser.username}` : "Telegram",
          avatar: telegramUser?.photo_url || null,
        });
      }

      if (!apiBase || !nextTgUserId) {
        if (!cancelled) setUserKey(nextTgUserId ? `tg-${nextTgUserId}` : fallbackKey);
        return;
      }

      try {
        const meUrl = `${apiBase}/api/me?tgUserId=${encodeURIComponent(String(nextTgUserId))}&username=${encodeURIComponent(telegramUser?.username || "")}&firstName=${encodeURIComponent(telegramUser?.first_name || "")}&lastName=${encodeURIComponent(telegramUser?.last_name || "")}&photoUrl=${encodeURIComponent(telegramUser?.photo_url || "")}`;
        const response = await fetch(meUrl);
        const data = (await response.json().catch(() => null)) as MeResponse | null;
        if (cancelled) return;
        setUserKey(data?.key || `tg-${nextTgUserId}`);
        if (data?.tgUserId) setTgUserId(data.tgUserId);
        if (data?.identity) setTgIdentity(data.identity);
      } catch {
        if (!cancelled) setUserKey(`tg-${nextTgUserId}`);
      }
    }

    bootstrap();
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  useEffect(() => {
    if (!userKey) return;
    const local = loadLocalState(userKey);
    setBackendHydrated(false);
    setProfileState(local);
    setProfileStateLoaded(true);
    setSteamInput(local.steam.input || "");
    setSteamId(local.steam.steamid || "");
    setSteamName(local.steam.personaname || "LUDO Player");
    setSteamAvatar(local.steam.avatarfull || null);
    setSteamConnected(Boolean(local.steam.steamid));
  }, [userKey]);

  const loadBackendState = useCallback(async () => {
    if (!userKey) return;
    if (!apiBase) {
      setBackendHydrated(true);
      return;
    }
    try {
      const endpoint = tgUserId
        ? `${apiBase}/api/me?tgUserId=${encodeURIComponent(String(tgUserId))}`
        : `${apiBase}/api/profile-state?key=${encodeURIComponent(userKey)}`;
      const response = await fetch(endpoint);
      if (!response.ok) {
        setBackendHydrated(true);
        return;
      }
      const data = await response.json();
      const remoteState = data?.state || data;
      const merged: ProfileState = {
        ...defaultProfileState(userKey),
        ...remoteState,
        settings: {
          ...defaultProfileState(userKey).settings,
          ...(remoteState?.settings || {}),
          quietHours: {
            ...defaultProfileState(userKey).settings.quietHours,
            ...(remoteState?.settings?.quietHours || {}),
          },
        },
        daily: { ...defaultProfileState(userKey).daily, ...(remoteState?.daily || {}) },
        referral: { ...defaultProfileState(userKey).referral, ...(remoteState?.referral || {}) },
        steam: { ...defaultProfileState(userKey).steam, ...(remoteState?.steam || {}) },
      };
      setProfileState(merged);
      if (merged.steam.input) setSteamInput(merged.steam.input);
      setSteamConnected(Boolean(merged.steam.steamid));
      setSteamId(merged.steam.steamid || "");
      setSteamName(merged.steam.personaname || "Steam player");
      setSteamAvatar(merged.steam.avatarfull || null);
      if (data?.identity && !tgIdentity) setTgIdentity(data.identity);
    } catch {
      // ignore, keep local copy
    } finally {
      setBackendHydrated(true);
    }
  }, [apiBase, userKey, tgUserId, tgIdentity]);

  useEffect(() => {
    loadBackendState();
  }, [loadBackendState]);

  useEffect(() => {
    if (!profileStateLoaded || !backendHydrated || !userKey) return;
    saveLocalState(userKey, profileState);
    if (!apiBase) return;
    const timer = setTimeout(() => {
      fetch(`${apiBase}/api/profile-state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...profileState, key: userKey, tgUserId, tgIdentity }),
      }).catch(() => {});
    }, 350);
    return () => clearTimeout(timer);
  }, [apiBase, profileState, profileStateLoaded, backendHydrated, userKey, tgUserId, tgIdentity]);

  useEffect(() => {
    if (!apiBase || !userKey) return;
    const startParam = readStartParam();
    if (!startParam) return;
    fetch(`${apiBase}/api/referral/attach`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: userKey, startParam }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.state) {
          setProfileState((current) => ({ ...current, referral: { ...current.referral, ...(data.state.referral || {}) } }));
        }
      })
      .catch(() => {});
  }, [apiBase, userKey]);

  const refreshNews = useCallback(async () => {
    if (!apiBase) return;
    try {
      setNewsLoading(true);
      setNewsStatus("Тяну полную ленту за последние 7 дней...");
      const response = await fetch(`${apiBase}/api/news`);
      if (!response.ok) throw new Error(`news_${response.status}`);
      const data = await response.json();
      const updates = dedupeFeedItems(Array.isArray(data?.updates) ? data.updates : []);
      const esports = dedupeFeedItems(Array.isArray(data?.esports) ? data.esports : []);
      const games = dedupeFeedItems(Array.isArray(data?.games) ? data.games : []);
      setUpdatesFeed(updates);
      setEsportsFeed(esports);
      setGamesFeed(games);
      setNewsStatus("");
    } catch {
      setNewsStatus("Не получилось обновить ленту. Оставил сохранённую недельную ленту.");
    } finally {
      setNewsLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    refreshNews();
  }, [refreshNews]);

  useEffect(() => {
    saveFeedCache("updates", updatesFeed);
  }, [updatesFeed]);

  useEffect(() => {
    saveFeedCache("esports", esportsFeed);
  }, [esportsFeed]);

  useEffect(() => {
    saveFeedCache("games", gamesFeed);
  }, [gamesFeed]);

  const connectSteam = useCallback(async (force = false, customInput?: string) => {
    const cleanInput = (customInput || steamInput).trim();
    if (!cleanInput || !apiBase) {
      setSteamError("Вставь ссылку на профиль Steam.");
      return;
    }
    try {
      setSteamLoading(true);
      setSteamError("");
      setInventoryStatus("Подключаю Steam и считаю инвентарь...");
      const endpoint = `${apiBase}/api/steam/inventory?profile=${encodeURIComponent(cleanInput)}&key=${encodeURIComponent(userKey)}${force ? "&force=1" : ""}`;
      const response = await fetch(endpoint);
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || `inventory_${response.status}`);
      const items: InventoryItem[] = Array.isArray(data?.items) ? data.items : [];
      setInventory(items);
      setTotalValue(Number(data?.totalValue || 0));
      setSteamConnected(true);
      setSteamId(String(data?.steamid || ""));
      setSteamName(data?.personaname || data?.profile?.personaname || "Steam player");
      setSteamAvatar(data?.profile?.avatarfull || null);
      const marketableCount = Number(data?.marketableCount || items.filter((item) => item.marketable).length || 0);
      const pricedCount = Number(data?.pricedCount || items.filter((item) => item.price > 0).length || 0);
      setInventoryStatus(`Steam подключен. Позиций: ${items.length}. Оценено ${pricedCount} из ${marketableCount || items.length}. Сумма: ${money(Number(data?.totalValue || 0))}.`);
      setProfileState((current) => ({
        ...current,
        steam: {
          input: cleanInput,
          steamid: String(data?.steamid || ""),
          personaname: data?.personaname || data?.profile?.personaname || "Steam player",
          avatarfull: data?.profile?.avatarfull || null,
        },
      }));
      setSteamInput(cleanInput);
      if (items.length) setSelectedItemHash(items[0].marketHashName);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Не удалось подключить Steam.";
      setSteamError(message);
      setInventoryStatus(message);
    } finally {
      setSteamLoading(false);
    }
  }, [apiBase, steamInput, userKey]);

  useEffect(() => {
    if (!apiBase || !backendHydrated || inventory.length > 0 || steamLoading) return;
    const remembered = profileState.steam.input || steamInput;
    if (!remembered) return;
    connectSteam(false, remembered);
  }, [apiBase, backendHydrated, profileState.steam.input, steamInput, inventory.length, steamLoading, connectSteam]);

  const refreshInventory = useCallback(async () => {
    await connectSteam(true);
  }, [connectSteam]);

  useEffect(() => {
    if (!selectedItemHash || !apiBase) return;
    let cancelled = false;
    const selected = inventory.find((item) => item.marketHashName === selectedItemHash);
    if (!selected) return;
    async function run() {
      setHistoryLoading(true);
      try {
        const response = await fetch(`${apiBase}/api/steam/item-history?marketHashName=${encodeURIComponent(selected.marketHashName)}`);
        const data = await response.json();
        if (!cancelled) setSelectedHistory(Array.isArray(data?.history) ? data.history : selected.history || []);
      } catch {
        if (!cancelled) setSelectedHistory(selected.history || []);
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [apiBase, inventory, selectedItemHash]);

  const selectedItem = useMemo(() => inventory.find((item) => item.marketHashName === selectedItemHash) || inventory[0] || null, [inventory, selectedItemHash]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!selectedItem?.descriptionText) {
        setTranslatedDescription("");
        return;
      }
      if (/[А-Яа-яЁё]/.test(selectedItem.descriptionText)) {
        setTranslatedDescription(selectedItem.descriptionText);
        return;
      }
      try {
        const response = await fetch(`${apiBase}/api/translate?text=${encodeURIComponent(selectedItem.descriptionText)}`);
        const data = await response.json();
        if (!cancelled) setTranslatedDescription(data?.translated || selectedItem.descriptionText);
      } catch {
        if (!cancelled) setTranslatedDescription(selectedItem.descriptionText);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [apiBase, selectedItem?.descriptionText]);

  const inventorySignals = useMemo<FeedItem[]>(() => {
    const watchSet = new Set(profileState.watchlist);
    return inventory
      .filter((item) => item.marketable && item.price > 0)
      .filter((item) => watchSet.has(item.marketHashName) || Math.abs(item.deltaPct) >= 2.5)
      .sort((a, b) => Number(watchSet.has(b.marketHashName)) - Number(watchSet.has(a.marketHashName)) || Math.abs(b.deltaPct) - Math.abs(a.deltaPct) || b.totalValue - a.totalValue)
      .slice(0, 12)
      .map((item) => ({
        id: `market-${item.marketHashName}`,
        category: "Рынок",
        title: item.name,
        body: `Рынок: ${money(item.price)} · ${deltaLabel(item.deltaPct)} · ${watchSet.has(item.marketHashName) ? "в watchlist" : "движение выше нормы"}`,
        createdAt: Math.floor(Date.now() / 1000),
        source: "LUDO Market",
        url: item.marketable ? `https://steamcommunity.com/market/listings/730/${encodeURIComponent(item.marketHashName)}` : null,
        imageUrl: item.iconUrl,
      }));
  }, [inventory, profileState.watchlist]);

  const feedItems = useMemo(() => {
    const combinedNews = dedupeFeedItems([...updatesFeed, ...esportsFeed, ...gamesFeed]);
    const source = feedFilter === "Рынок"
      ? inventorySignals
      : feedFilter === "Все новости"
        ? combinedNews
        : combinedNews.filter((item) => item.category === feedFilter);
    return savedOnly ? source.filter((item) => profileState.savedNewsIds.includes(item.id)) : source;
  }, [updatesFeed, esportsFeed, gamesFeed, inventorySignals, feedFilter, savedOnly, profileState.savedNewsIds]);

  const filteredInventory = useMemo(() => {
    const q = inventorySearch.trim().toLowerCase();
    return inventory
      .filter((item) => inventoryKindFilter === "Все" || classifyItemKind(item) === inventoryKindFilter)
      .filter((item) => !q || item.name.toLowerCase().includes(q) || item.marketHashName.toLowerCase().includes(q));
  }, [inventory, inventorySearch, inventoryKindFilter]);

  const alerts = useMemo(() => {
    const q = watchlistSearch.trim().toLowerCase();
    return inventory
      .filter((item) => profileState.watchlist.includes(item.marketHashName) || Math.abs(item.deltaPct) >= 0.5)
      .filter((item) => watchlistKindFilter === "Все" || classifyItemKind(item) === watchlistKindFilter)
      .filter((item) => !q || item.name.toLowerCase().includes(q) || item.marketHashName.toLowerCase().includes(q));
  }, [inventory, profileState.watchlist, watchlistSearch, watchlistKindFilter]);

  const rangeHistory = useMemo(() => filterHistory(selectedHistory, historyRange), [selectedHistory, historyRange]);
  const historyPolyline = useMemo(() => buildSvgPolyline(rangeHistory), [rangeHistory]);

  const isExpandedNews = useCallback((id: string) => expandedNewsIds.includes(id), [expandedNewsIds]);
  const canExpandNews = useCallback((item: FeedItem) => Boolean(item?.url), []);

  const toggleExpandNews = useCallback(async (item: FeedItem) => {
    const alreadyExpanded = expandedNewsIds.includes(item.id);
    if (alreadyExpanded) {
      setExpandedNewsIds((current) => current.filter((id) => id !== item.id));
      return;
    }

    setExpandedNewsIds((current) => (current.includes(item.id) ? current : [...current, item.id]));
    if (fullArticleMap[item.id] || !item.url || !apiBase) return;

    try {
      setArticleLoadingId(item.id);
      const response = await fetch(`${apiBase}/api/news/article?url=${encodeURIComponent(item.url)}`);
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || `article_${response.status}`);
      const fullBody = String(data?.body || "").trim();
      if (fullBody) {
        setFullArticleMap((current) => ({ ...current, [item.id]: fullBody }));
      }
    } catch {
      // leave preview body as-is
    } finally {
      setArticleLoadingId((current) => (current === item.id ? null : current));
    }
  }, [expandedNewsIds, fullArticleMap, apiBase]);

  const previewTextForNews = useCallback((item: FeedItem) => {
    const fullBody = fullArticleMap[item.id];
    const base = String(fullBody || item.body || "").trim();
    if (isExpandedNews(item.id)) return base;
    if (base.length <= 520) return base;
    return `${base.slice(0, 520).trimEnd()}…`;
  }, [fullArticleMap, isExpandedNews]);

  const hasMoreNewsBody = useCallback((item: FeedItem) => {
    const base = String(fullArticleMap[item.id] || item.body || "").trim();
    return canExpandNews(item) || base.length > 520;
  }, [fullArticleMap]);

  const isSaved = useCallback((id: string) => profileState.savedNewsIds.includes(id), [profileState.savedNewsIds]);

  const toggleSavedNews = useCallback((id: string) => {
    setProfileState((current) => ({
      ...current,
      savedNewsIds: current.savedNewsIds.includes(id)
        ? current.savedNewsIds.filter((item) => item !== id)
        : [id, ...current.savedNewsIds],
    }));
  }, []);

  const toggleWatchlist = useCallback((marketHashName: string) => {
    setProfileState((current) => ({
      ...current,
      watchlist: current.watchlist.includes(marketHashName)
        ? current.watchlist.filter((item) => item !== marketHashName)
        : [marketHashName, ...current.watchlist],
    }));
  }, []);

  const toggleNotifications = useCallback(() => {
    setProfileState((current) => ({ ...current, settings: { ...current.settings, notifications: !current.settings.notifications } }));
  }, []);

  const toggleDailyReminder = useCallback(() => {
    setProfileState((current) => ({
      ...current,
      settings: { ...current.settings, dailyReminder: !current.settings.dailyReminder },
      daily: { ...current.daily, reminderEnabled: !current.daily.reminderEnabled },
    }));
  }, []);

  const updateQuiet = useCallback((field: "enabled" | "start" | "end", value: boolean | string) => {
    setProfileState((current) => ({
      ...current,
      settings: {
        ...current.settings,
        quietHours: { ...current.settings.quietHours, [field]: value },
      },
    }));
  }, []);

  const openItem = useCallback((item: InventoryItem) => {
    setSelectedItemHash(item.marketHashName);
    setActiveTab("item");
    contentRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const doDailyCheckin = useCallback(async () => {
    if (!apiBase) return;
    try {
      const response = await fetch(`${apiBase}/api/daily-checkin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: userKey }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "daily_checkin");
      setProfileState((current) => ({ ...current, daily: { ...current.daily, ...(data.daily || {}) } }));
      setDailyMessage(data?.message || "Отметка засчитана.");
    } catch (error) {
      setDailyMessage(error instanceof Error ? error.message : "Не удалось отметить ежедневку.");
    }
  }, [apiBase, userKey]);

  const copyReferral = useCallback(async () => {
    const code = profileState.referral.code || "";
    if (!code) return;
    const url = `${window.location.origin}${window.location.pathname}?ref=${encodeURIComponent(code)}`;
    try {
      await navigator.clipboard.writeText(url);
      setDailyMessage("Реферальная ссылка скопирована.");
    } catch {
      setDailyMessage(url);
    }
  }, [profileState.referral.code]);

  const fetchTickets = useCallback(async () => {
    if (!apiBase || !isAdmin || !tgUserId) return;
    try {
      setTicketsLoading(true);
      const response = await fetch(`${apiBase}/api/tickets?adminId=${tgUserId}`);
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "tickets_fetch");
      setTickets(Array.isArray(data?.items) ? data.items : []);
    } catch {
      setTickets([]);
    } finally {
      setTicketsLoading(false);
    }
  }, [apiBase, isAdmin, tgUserId]);

  useEffect(() => {
    if (profileSection === "tickets" && isAdmin) {
      fetchTickets();
    }
  }, [profileSection, isAdmin, fetchTickets]);

  const openTicketDialog = useCallback((context?: { title?: string; url?: string | null; sourceType?: string; sourceId?: string | null }) => {
    setTicketContext({
      title: context?.title || "Сообщение о проблеме",
      url: context?.url || null,
      sourceType: context?.sourceType || activeTab,
      sourceId: context?.sourceId || null,
    });
    setTicketDraft("");
    setTicketSubmitStatus("");
    setTicketDialogOpen(true);
  }, [activeTab]);

  const submitTicket = useCallback(async () => {
    if (!apiBase) {
      setTicketSubmitStatus("Нет подключения к API.");
      return;
    }
    const message = ticketDraft.trim();
    if (!message) {
      setTicketSubmitStatus("Опиши проблему перед отправкой.");
      return;
    }

    try {
      setTicketSending(true);
      setTicketSubmitStatus("");
      const response = await fetch(`${apiBase}/api/tickets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: userKey,
          reporterName: userIdentity.name,
          reporterHandle: userIdentity.handle || "",
          reporterUserId: tgUserId,
          title: ticketContext?.title || "Сообщение о проблеме",
          url: ticketContext?.url || "",
          sourceType: ticketContext?.sourceType || activeTab,
          sourceId: ticketContext?.sourceId || "",
          message,
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "ticket_submit");
      setTicketSubmitStatus("Отправлено. Спасибо, это попадёт в тикеты.");
      setTicketDraft("");
      if (isAdmin) fetchTickets();
      setTimeout(() => setTicketDialogOpen(false), 700);
    } catch (error) {
      setTicketSubmitStatus(error instanceof Error ? error.message : "Не удалось отправить тикет.");
    } finally {
      setTicketSending(false);
    }
  }, [apiBase, ticketDraft, userKey, userIdentity.name, userIdentity.handle, tgUserId, ticketContext, activeTab, isAdmin, fetchTickets]);

  const updateTicketStatus = useCallback(async (id: string, status: string) => {
    if (!apiBase || !isAdmin || !tgUserId) return;
    try {
      const response = await fetch(`${apiBase}/api/tickets/${encodeURIComponent(id)}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminId: tgUserId, status }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "ticket_status");
      setTickets((current) => current.map((ticket) => ticket.id === id ? { ...ticket, status } : ticket));
    } catch {
      // ignore
    }
  }, [apiBase, isAdmin, tgUserId]);

  const shareNews = useCallback((item: FeedItem) => {
    const link = item.url || window.location.href;
    const compactBody = String(item.body || "").replace(/\s+/g, " ").trim();
    const excerpt = compactBody.slice(0, 220);
    const text = `${item.title}${excerpt ? `\n\n${excerpt}${compactBody.length > 220 ? "…" : ""}` : ""}`;
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;

    if (window.Telegram?.WebApp?.openTelegramLink) {
      window.Telegram.WebApp.openTelegramLink(shareUrl);
      return;
    }

    if (navigator.share) {
      navigator.share({ title: item.title, text, url: link }).catch(() => {});
      return;
    }

    window.open(shareUrl, "_blank", "noopener,noreferrer");
  }, []);

  const goTab = useCallback((tab: TabId) => {
    setActiveTab(tab);
    contentRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const titleByTab = {
    feed: "Новости и сигналы",
    inventory: "Инвентарь",
    radar: "Watchlist и алерты",
    item: "Карточка предмета",
    profile: "Профиль",
  }[activeTab];

  return (
    <AppShell
      bottomNav={
        <div className="rounded-[1.9rem] border border-white/10 bg-white/10 p-2 shadow-[0_10px_40px_rgba(5,8,20,0.45)] backdrop-blur-2xl supports-[backdrop-filter]:bg-white/8">
          <div className="grid grid-cols-5 gap-1.5">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => goTab(tab.id)}
                  className={`relative flex flex-col items-center justify-center overflow-hidden rounded-[1.25rem] px-1 py-2.5 text-[11px] transition-all duration-300 ${
                    active
                      ? "border border-white/20 bg-gradient-to-br from-white/35 via-cyan-300/20 to-fuchsia-400/20 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_10px_24px_rgba(17,24,39,0.28)] backdrop-blur-xl"
                      : "border border-transparent text-neutral-300 hover:border-white/10 hover:bg-white/8 hover:text-white"
                  }`}
                >
                  <span className={`pointer-events-none absolute inset-0 opacity-0 transition ${active ? "opacity-100" : ""} bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.24),transparent_55%)]`} />
                  <Icon className={`relative mb-1 h-4 w-4 transition-transform duration-300 ${active ? "scale-110" : ""}`} />
                  <span className="relative truncate">{tab.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      }
    >
      <div className="sticky top-0 z-40 border-b border-white/10 bg-[#0B0817]/92 px-4 py-4 backdrop-blur-xl">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-[0.22em] text-cyan-200/70">LUDO // CS2 Intel</div>
            <div className="mt-1 text-2xl font-bold text-white">{titleByTab}</div>
          </div>
          <UserPill identity={userIdentity} />
        </div>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-neutral-400">
            {activeTab === "feed" && (newsLoading ? "Обновляю ленту..." : newsStatus)}
            {activeTab === "inventory" && inventoryStatus}
            {activeTab === "radar" && "Следи за тем, что реально важно: свой watchlist и заметные движения."}
            {activeTab === "item" && (selectedItem ? selectedItem.name : "Сначала выбери предмет из инвентаря.")}
          </div>
          {activeTab === "feed" ? (
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon" onClick={refreshNews} className="rounded-2xl border border-white/10 bg-white/5 text-white hover:bg-white/10" title="Обновить ленту">
                <RefreshCw className={`h-4 w-4 ${newsLoading ? "animate-spin" : ""}`} />
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setSavedOnly((value) => !value);
                  setFeedFilter("Все новости");
                }}
                className="rounded-2xl border border-white/10 bg-white/5 px-3 text-white hover:bg-white/10"
              >
                <FolderOpen className="mr-2 h-4 w-4" />
                {savedOnly ? "Все" : "Сохранённое"}
              </Button>
            </div>
          ) : null}
        </div>
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={activeTab}
          ref={contentRef}
          className="min-h-[calc(100vh-80px)] overflow-y-auto px-4 pb-28 pt-4"
          initial={{ opacity: 0, y: 18, filter: "blur(10px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={{ opacity: 0, y: -12, filter: "blur(8px)" }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        >
        {activeTab === "feed" && (
          <div className="space-y-4">
            {!savedOnly && inventorySignals.length > 0 ? (
              <Section title="Мой инвентарь" className="border-cyan-400/20 bg-gradient-to-br from-cyan-500/10 to-fuchsia-500/10">
                <div className="space-y-3">
                  {inventorySignals.slice(0, 3).map((item) => {
                    const found = inventory.find((entry) => entry.name === item.title || entry.marketHashName === item.title);
                    return (
                      <button key={item.id} onClick={() => (found ? openItem(found) : goTab("inventory"))} className="flex w-full items-center gap-3 rounded-2xl border border-white/10 bg-black/20 p-3 text-left transition hover:bg-white/10">
                        {item.imageUrl ? <img src={item.imageUrl} alt={item.title} className="h-16 w-16 rounded-2xl object-cover" /> : <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white/10 text-xs text-neutral-400">item</div>}
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-semibold text-white">{item.title}</div>
                          <div className="mt-1 text-xs text-neutral-400">{item.body}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </Section>
            ) : null}

            <div className="flex gap-2 overflow-x-auto pb-1">
              {(["Все новости", "Апдейты", "Киберспорт", "Рынок", "Мир игр"] as FeedFilter[]).map((filter) => (
                <button
                  key={filter}
                  onClick={() => {
                    setSavedOnly(false);
                    setFeedFilter(filter);
                  }}
                  className={`rounded-full border px-4 py-2 text-sm whitespace-nowrap transition ${!savedOnly && feedFilter === filter ? toneForFilter(filter) : "border-white/10 bg-white/5 text-white/80"}`}
                >
                  {filter}
                </button>
              ))}
            </div>

            {feedItems.length === 0 ? (
              <Section title={savedOnly ? "Сохранённое пусто" : "Пока пусто"}>
                <div className="text-sm text-neutral-300">Здесь будет полная недельная лента: апдейты, киберспорт, мир игр и рыночные сигналы.</div>
              </Section>
            ) : (
              feedItems.map((item) => (
                <Card key={item.id} className="overflow-hidden rounded-[1.6rem] border border-white/10 bg-gradient-to-br from-[#11101D] via-[#101A29] to-[#15111F] shadow-[0_10px_40px_rgba(0,0,0,0.22)]">
                  {item.imageUrl ? <img src={item.imageUrl} alt={item.title} loading="lazy" className="h-56 w-full object-cover" /> : null}
                  <CardContent className="p-5">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <Badge className={`rounded-full border ${sectionTone(item.category)}`}>{item.category}</Badge>
                      <div className="text-xs text-neutral-500">{timeAgoRu(item.createdAt)}</div>
                    </div>
                    <div className="text-xl font-bold leading-tight text-white">{item.title}</div>
                    <div className="mt-3 whitespace-pre-line text-sm leading-6 text-neutral-300">{previewTextForNews(item)}</div>
                    <div className="mt-4 flex flex-wrap gap-2">
                      {hasMoreNewsBody(item) ? (
                        <Button
                          variant="ghost"
                          onClick={() => toggleExpandNews(item)}
                          className="rounded-2xl border border-white/10 bg-white/10 text-white hover:bg-white/15"
                        >
                          {articleLoadingId === item.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                          {isExpandedNews(item.id) ? "Свернуть" : "Читать далее"}
                        </Button>
                      ) : null}
                      <Button onClick={() => toggleSavedNews(item.id)} className={`rounded-2xl ${isSaved(item.id) ? "bg-fuchsia-500 text-white hover:bg-fuchsia-400" : "bg-white text-[#0A0716] hover:bg-neutral-100"}`}>
                        {isSaved(item.id) ? <BookmarkCheck className="mr-2 h-4 w-4" /> : <Bookmark className="mr-2 h-4 w-4" />}
                        {isSaved(item.id) ? "Сохранено" : "Сохранить"}
                      </Button>
                      <Button variant="ghost" onClick={() => shareNews(item)} className="rounded-2xl border border-white/10 bg-white/10 text-white hover:bg-white/15">
                        Поделиться <Share2 className="ml-2 h-4 w-4" />
                      </Button>
                      <Button variant="ghost" onClick={() => openTicketDialog({ title: item.title, url: item.url || null, sourceType: "news", sourceId: item.id })} className="rounded-2xl border border-rose-300/20 bg-rose-400/10 text-rose-100 hover:bg-rose-400/15">
                        Сообщить о проблеме <MessageCircle className="ml-2 h-4 w-4" />
                      </Button>
                      {item.url ? (
                        <Button variant="ghost" onClick={() => window.open(item.url || "", "_blank", "noopener,noreferrer")} className="rounded-2xl border border-white/10 bg-white/10 text-white hover:bg-white/15">
                          Перейти к новости <ExternalLink className="ml-2 h-4 w-4" />
                        </Button>
                      ) : null}
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        )}

        {activeTab === "inventory" && (
          <div className="space-y-4">
            <Section
              title="Подключение Steam"
              action={<Button variant="ghost" size="icon" onClick={refreshInventory} disabled={steamLoading} className="rounded-2xl border border-white/10 bg-white/5 text-white hover:bg-white/10"><RefreshCw className={`h-4 w-4 ${steamLoading ? "animate-spin" : ""}`} /></Button>}
            >
              <div className="space-y-3">
                <Input value={steamInput} onChange={(event) => setSteamInput(event.target.value)} placeholder="https://steamcommunity.com/id/..." className="rounded-2xl border-white/10 bg-white/5 text-white placeholder:text-neutral-500" />
                <div className="flex gap-2">
                  <Button onClick={() => connectSteam(false)} disabled={steamLoading} className="rounded-2xl bg-white text-[#0A0716] hover:bg-neutral-100">
                    {steamLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
                    Подключить Steam
                  </Button>
                  <Button onClick={refreshInventory} disabled={steamLoading} className="rounded-2xl border border-white/10 bg-white/10 text-white hover:bg-white/15">Пересчитать</Button>
                </div>
                {steamError ? <div className="rounded-2xl border border-rose-400/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{steamError}</div> : null}
              </div>
            </Section>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Card className="rounded-[1.4rem] border border-cyan-400/20 bg-gradient-to-br from-cyan-500/10 to-cyan-400/5"><CardContent className="p-4"><div className="text-xs text-neutral-500">Оценка инвентаря</div><div className="mt-1 text-xl font-semibold text-white">{money(totalValue)}</div></CardContent></Card>
              <Card className="rounded-[1.4rem] border border-fuchsia-400/20 bg-gradient-to-br from-fuchsia-500/10 to-fuchsia-400/5"><CardContent className="p-4"><div className="text-xs text-neutral-500">Позиции</div><div className="mt-1 text-xl font-semibold text-white">{inventory.length}</div></CardContent></Card>
            </div>

            <Section title="Все позиции">
              <div className="mb-3 flex items-center gap-2 rounded-2xl border border-white/10 bg-black/20 px-4 py-3">
                <Search className="h-4 w-4 text-neutral-500" />
                <input value={inventorySearch} onChange={(event) => setInventorySearch(event.target.value)} placeholder="Найти предмет" className="w-full bg-transparent text-sm text-white outline-none placeholder:text-neutral-500" />
              </div>
              <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
                {itemKinds.map((kind) => (
                  <button key={kind} onClick={() => setInventoryKindFilter(kind)} className={`rounded-full border px-4 py-2 text-sm whitespace-nowrap ${inventoryKindFilter === kind ? toneForKind(kind) : "border-white/10 bg-white/5 text-white/80"}`}>{kind}</button>
                ))}
              </div>
              <div className="space-y-3">
                {filteredInventory.length === 0 ? <div className="rounded-2xl border border-dashed border-white/10 p-4 text-sm text-neutral-400">Пока пусто. Подключи Steam или поменяй фильтр.</div> : filteredInventory.map((item) => (
                  <button key={item.id} onClick={() => openItem(item)} className="flex w-full items-center gap-3 rounded-2xl border border-white/10 bg-black/20 p-3 text-left transition hover:bg-white/10">
                    {item.iconUrl ? <img src={item.iconUrl} alt={item.name} className="h-14 w-14 rounded-xl object-cover" /> : <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-white/10 text-xs text-neutral-400">skin</div>}
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold text-white">{item.name}</div>
                      <div className="mt-1 truncate text-xs text-neutral-400">{item.type} · {classifyItemKind(item)}</div>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-neutral-400">
                        <span>{money(item.price)}</span>
                        <span className={deltaClass(item.deltaPct)}>{deltaLabel(item.deltaPct)}</span>
                        <span>x{item.quantity}</span>
                      </div>
                    </div>
                    <Button onClick={(event) => { event.stopPropagation(); toggleWatchlist(item.marketHashName); }} className="rounded-2xl border border-white/10 bg-white/10 text-white hover:bg-white/15">{profileState.watchlist.includes(item.marketHashName) ? "Убрать" : "+ Watch"}</Button>
                  </button>
                ))}
              </div>
            </Section>
          </div>
        )}

        {activeTab === "radar" && (
          <div className="space-y-4">
            <Section title="Watchlist" className="border-fuchsia-400/20 bg-gradient-to-br from-fuchsia-500/10 to-cyan-500/10">
              <div className="mb-3 flex items-center gap-2 rounded-2xl border border-white/10 bg-black/20 px-4 py-3">
                <Search className="h-4 w-4 text-neutral-500" />
                <input value={watchlistSearch} onChange={(event) => setWatchlistSearch(event.target.value)} placeholder="Найти предмет в watchlist" className="w-full bg-transparent text-sm text-white outline-none placeholder:text-neutral-500" />
              </div>
              <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
                {itemKinds.map((kind) => (
                  <button key={kind} onClick={() => setWatchlistKindFilter(kind)} className={`rounded-full border px-4 py-2 text-sm whitespace-nowrap ${watchlistKindFilter === kind ? toneForKind(kind) : "border-white/10 bg-white/5 text-white/80"}`}>{kind}</button>
                ))}
              </div>
              {alerts.length === 0 ? <div className="rounded-2xl border border-dashed border-white/10 p-4 text-sm text-neutral-400">Пока тихо. Добавь предметы в watchlist из инвентаря.</div> : <div className="space-y-3">{alerts.map((item) => (
                <div key={item.marketHashName} className="rounded-2xl border border-white/10 bg-black/20 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold text-white">{item.name}</div>
                      <div className="mt-1 text-sm text-neutral-400">{money(item.price)} · {deltaLabel(item.deltaPct)} · {classifyItemKind(item)}</div>
                    </div>
                    <Badge className={`rounded-full border-0 ${Math.abs(item.deltaPct) >= 3 ? "bg-rose-500/20 text-rose-200" : "bg-cyan-500/20 text-cyan-200"}`}>{Math.abs(item.deltaPct) >= 3 ? "🔥 двигается" : "👀 watch"}</Badge>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button onClick={() => openItem(item)} className="rounded-2xl bg-white text-[#0A0716] hover:bg-neutral-100">Открыть предмет</Button>
                    <Button onClick={() => { goTab("inventory"); setInventorySearch(item.name); }} className="rounded-2xl border border-white/10 bg-white/10 text-white hover:bg-white/15">Показать в инвентаре</Button>
                    <Button onClick={() => toggleWatchlist(item.marketHashName)} className="rounded-2xl border border-white/10 bg-white/10 text-white hover:bg-white/15">{profileState.watchlist.includes(item.marketHashName) ? "Убрать" : "В watchlist"}</Button>
                  </div>
                </div>
              ))}</div>}
            </Section>
          </div>
        )}

        {activeTab === "item" && (
          <div className="space-y-4">
            {!selectedItem ? <Section title="Пока пусто"><div className="text-sm text-neutral-400">Сначала выбери предмет из инвентаря.</div></Section> : (
              <>
                <Section title={selectedItem.name}>
                  <div className="flex items-start gap-4">
                    {selectedItem.iconUrl ? <img src={selectedItem.iconUrl} alt={selectedItem.name} className="h-24 w-24 rounded-2xl object-cover" /> : <div className="flex h-24 w-24 items-center justify-center rounded-2xl bg-white/10 text-neutral-400">skin</div>}
                    <div className="flex-1">
                      <div className="grid grid-cols-2 gap-3 text-sm text-neutral-300">
                        <div className="rounded-2xl border border-white/10 bg-black/20 p-3"><div className="text-neutral-500">Рынок</div><div className="mt-1 font-semibold text-white">{money(selectedItem.price)}</div></div>
                        <div className="rounded-2xl border border-white/10 bg-black/20 p-3"><div className="text-neutral-500">Изменение</div><div className={`mt-1 font-semibold ${deltaClass(selectedItem.deltaPct)}`}>{deltaLabel(selectedItem.deltaPct)}</div></div>
                        <div className="rounded-2xl border border-white/10 bg-black/20 p-3"><div className="text-neutral-500">Количество</div><div className="mt-1 font-semibold text-white">x{selectedItem.quantity}</div></div>
                        <div className="rounded-2xl border border-white/10 bg-black/20 p-3"><div className="text-neutral-500">Сумма позиции</div><div className="mt-1 font-semibold text-white">{money(selectedItem.totalValue)}</div></div>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button onClick={() => toggleWatchlist(selectedItem.marketHashName)} className="rounded-2xl bg-white text-[#0A0716] hover:bg-neutral-100">{profileState.watchlist.includes(selectedItem.marketHashName) ? "Убрать из watchlist" : "В watchlist"}</Button>
                        {selectedItem.marketable ? <Button variant="ghost" onClick={() => window.open(`https://steamcommunity.com/market/listings/730/${encodeURIComponent(selectedItem.marketHashName)}`, "_blank", "noopener,noreferrer")} className="rounded-2xl border border-white/10 bg-white/10 text-white hover:bg-white/15">Открыть рынок <ExternalLink className="ml-2 h-4 w-4" /></Button> : null}
                      </div>
                    </div>
                  </div>
                </Section>

                <Section title="График цены">
                  <div className="mb-3 flex gap-2 overflow-x-auto">
                    {(["day", "week", "month", "year"] as RangeId[]).map((range) => (
                      <button key={range} onClick={() => setHistoryRange(range)} className={`rounded-full px-4 py-2 text-sm whitespace-nowrap ${historyRange === range ? "bg-white text-[#0A0716]" : "border border-white/10 bg-white/5 text-white/80"}`}>{historyRangeLabel(range)}</button>
                    ))}
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                    {historyLoading ? <div className="flex h-40 items-center justify-center text-neutral-400"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Гружу историю...</div> : rangeHistory.length < 2 ? <div className="flex h-40 flex-col items-center justify-center text-center text-sm text-neutral-400">Истории пока мало.<span className="mt-2 max-w-[260px] text-neutral-500">После следующих синков тут появится нормальная линия с датами.</span></div> : <><svg viewBox="0 0 100 48" className="h-40 w-full"><polyline fill="none" stroke="url(#ludoLine)" strokeWidth="2.5" points={historyPolyline} /><defs><linearGradient id="ludoLine" x1="0" x2="1" y1="0" y2="0"><stop offset="0%" stopColor="#22d3ee" /><stop offset="100%" stopColor="#d946ef" /></linearGradient></defs></svg><div className="mt-3 flex items-center justify-between text-xs text-neutral-500"><span>{formatAxisLabel(rangeHistory[0].ts, historyRange)}</span><span>{formatAxisLabel(rangeHistory[Math.max(0, Math.floor(rangeHistory.length / 2))].ts, historyRange)}</span><span>{formatAxisLabel(rangeHistory[rangeHistory.length - 1].ts, historyRange)}</span></div></>}
                  </div>
                </Section>

                {selectedItem.descriptionText ? <Section title="Описание"><div className="rounded-2xl border border-white/10 bg-black/20 p-3 text-sm leading-6 text-neutral-300">{translatedDescription || selectedItem.descriptionText}</div></Section> : null}
              </>
            )}
          </div>
        )}

        {activeTab === "profile" && (
          <div className="space-y-4">
            <Section title="Профиль">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
                  <UserPill identity={userIdentity} />
                  <div className="min-w-0 text-sm text-neutral-400">Steam: {steamConnected ? "подключён" : "не подключён"}<br />Ключ профиля: <span className="break-all">{userKey}</span></div>
                </div>
              </div>
            </Section>

            <div className="grid grid-cols-2 gap-3">
              <MenuTile title="Настройки" value={profileState.settings.notifications ? "уведомления вкл" : "уведомления выкл"} active={profileSection === "settings"} onClick={() => setProfileSection("settings")} tone="border-cyan-300/30 bg-cyan-400/10" />
              <MenuTile title="Ежедневка" value={`стрик ${profileState.daily.streak}/7`} active={profileSection === "daily"} onClick={() => setProfileSection("daily")} tone="border-amber-300/30 bg-amber-400/10" />
              <MenuTile title="Рефералка" value={`${profileState.referral.verified} подтвержд.`} active={profileSection === "referral"} onClick={() => setProfileSection("referral")} tone="border-fuchsia-300/30 bg-fuchsia-400/10" />
              <MenuTile title="FAQ" value="вопросы и помощь" active={profileSection === "faq"} onClick={() => setProfileSection("faq")} tone="border-emerald-300/30 bg-emerald-400/10" />
              <MenuTile title="Сохранённое" value={`${profileState.savedNewsIds.length} материалов`} active={profileSection === "saved"} onClick={() => setProfileSection("saved")} tone="border-violet-300/30 bg-violet-400/10" />
              <MenuTile title="Steam" value={steamConnected ? steamName || "подключён" : "не подключён"} active={profileSection === "steam"} onClick={() => setProfileSection("steam")} tone="border-white/20 bg-white/10" />
              {isAdmin ? <><MenuTile title="Админка" value="сводка" active={profileSection === "admin"} onClick={() => setProfileSection("admin")} tone="border-rose-300/30 bg-rose-400/10" /><MenuTile title="Тикеты" value={ticketsLoading ? "загрузка..." : `${tickets.filter((ticket) => ticket.status !== "done").length} открыто`} active={profileSection === "tickets"} onClick={() => setProfileSection("tickets")} tone="border-orange-300/30 bg-orange-400/10" /></> : null}
            </div>

            {profileSection === "settings" && (
              <Section title="Настройки">
                <div className="space-y-3">
                  <button onClick={toggleNotifications} className="flex w-full items-center justify-between rounded-2xl border border-white/10 bg-black/20 p-4 text-left transition hover:bg-white/10">
                    <div><div className="font-semibold text-white">Уведомления</div></div>
                    <Badge className={`rounded-full border-0 ${profileState.settings.notifications ? "bg-cyan-500/20 text-cyan-200" : "bg-white/10 text-white"}`}>{profileState.settings.notifications ? <Bell className="mr-2 h-4 w-4" /> : <BellOff className="mr-2 h-4 w-4" />}{profileState.settings.notifications ? "Активны" : "Выключены"}</Badge>
                  </button>
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div><div className="font-semibold text-white">Тихие часы</div></div>
                      <label className="flex items-center gap-2 text-sm text-neutral-300"><input type="checkbox" checked={profileState.settings.quietHours.enabled} onChange={(e) => updateQuiet("enabled", e.target.checked)} /> Вкл</label>
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-3">
                      <label className="text-sm text-neutral-400">С<input type="time" value={profileState.settings.quietHours.start} onChange={(e) => updateQuiet("start", e.target.value)} className="mt-2 w-full rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-white outline-none" /></label>
                      <label className="text-sm text-neutral-400">До<input type="time" value={profileState.settings.quietHours.end} onChange={(e) => updateQuiet("end", e.target.value)} className="mt-2 w-full rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-white outline-none" /></label>
                    </div>
                    <div className="mt-3 inline-flex items-center rounded-full border border-white/10 bg-white/5 px-3 py-2 text-sm text-neutral-300"><Clock3 className="mr-2 h-4 w-4" />{profileState.settings.quietHours.enabled ? `${profileState.settings.quietHours.start} — ${profileState.settings.quietHours.end}` : "Выключены"}</div>
                  </div>
                </div>
              </Section>
            )}

            {profileSection === "daily" && (
              <Section title="Ежедневная отметка">
                <div className="grid grid-cols-2 gap-3 text-sm text-neutral-300">
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-3"><div className="text-neutral-500">Текущий стрик</div><div className="mt-1 font-semibold text-white">{profileState.daily.streak}/7</div></div>
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-3"><div className="text-neutral-500">Сегодня</div><div className="mt-1 font-semibold text-white">{profileState.daily.lastCheckinDate === todayStr() ? "✅ отмечено" : "❌ ещё нет"}</div></div>
                </div>
                <div className="mt-3 space-y-3">
                  <button onClick={toggleDailyReminder} className="flex w-full items-center justify-between rounded-2xl border border-white/10 bg-black/20 p-4 text-left transition hover:bg-white/10">
                    <div><div className="font-semibold text-white">Напоминалка по ежедневке</div></div>
                    <Badge className={`rounded-full border-0 ${profileState.daily.reminderEnabled ? "bg-cyan-500/20 text-cyan-200" : "bg-white/10 text-white"}`}>{profileState.daily.reminderEnabled ? "Вкл" : "Выкл"}</Badge>
                  </button>
                  <Button onClick={doDailyCheckin} className="w-full rounded-2xl bg-white text-[#0A0716] hover:bg-neutral-100"><Gift className="mr-2 h-4 w-4" />Отметиться сегодня</Button>
                  {dailyMessage ? <div className="rounded-2xl border border-white/10 bg-black/20 p-3 text-sm text-neutral-300">{dailyMessage}</div> : null}
                  {profileState.daily.lastReward ? <div className="rounded-2xl border border-emerald-400/20 bg-emerald-500/10 p-3 text-sm text-emerald-200">Последняя награда: {profileState.daily.lastReward}</div> : null}
                </div>
              </Section>
            )}

            {profileSection === "referral" && (
              <Section title="Реферальная система">
                <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                  <div className="text-xs text-neutral-500">Реферальный код</div>
                  <div className="mt-1 text-lg font-semibold text-white">{profileState.referral.code || "генерирую..."}</div>
                  <div className="mt-3 grid grid-cols-3 gap-3 text-sm text-neutral-300">
                    <div className="rounded-2xl border border-white/10 bg-white/5 p-3"><div className="text-neutral-500">Клики</div><div className="mt-1 font-semibold text-white">{profileState.referral.clicks}</div></div>
                    <div className="rounded-2xl border border-white/10 bg-white/5 p-3"><div className="text-neutral-500">Подтвержд.</div><div className="mt-1 font-semibold text-white">{profileState.referral.verified}</div></div>
                    <div className="rounded-2xl border border-white/10 bg-white/5 p-3"><div className="text-neutral-500">Очки</div><div className="mt-1 font-semibold text-white">{profileState.referral.points}</div></div>
                  </div>
                  <div className="mt-3 flex gap-2">
                    <Button onClick={copyReferral} className="rounded-2xl bg-white text-[#0A0716] hover:bg-neutral-100"><Copy className="mr-2 h-4 w-4" />Скопировать ссылку</Button>
                    <div className="inline-flex items-center rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-neutral-300"><Link2 className="mr-2 h-4 w-4" />ref={profileState.referral.code}</div>
                  </div>
                </div>
              </Section>
            )}

            {profileSection === "saved" && (
              <Section title="Сохранённое">
                <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-neutral-300">Сейчас сохранено материалов: <span className="font-semibold text-white">{profileState.savedNewsIds.length}</span></div>
                <div className="mt-3 flex gap-2">
                  <Button onClick={() => { setActiveTab("feed"); setSavedOnly(true); setFeedFilter("Все новости"); contentRef.current?.scrollTo({ top: 0, behavior: "smooth" }); }} className="rounded-2xl bg-white text-[#0A0716] hover:bg-neutral-100">Открыть сохранённое</Button>
                  <Button onClick={() => { setActiveTab("radar"); contentRef.current?.scrollTo({ top: 0, behavior: "smooth" }); }} className="rounded-2xl border border-white/10 bg-white/10 text-white hover:bg-white/15">Открыть watchlist</Button>
                </div>
              </Section>
            )}

            {profileSection === "steam" && (
              <Section title="Steam">
                <div className="space-y-3">
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-neutral-300">{steamConnected ? <>Подключён профиль <span className="font-semibold text-white">{steamName}</span><br />SteamID: <span className="font-semibold text-white">{steamId || "—"}</span></> : "Steam ещё не подключён."}</div>
                  <Button onClick={refreshInventory} className="w-full rounded-2xl border border-white/10 bg-white/10 text-white hover:bg-white/15"><RefreshCw className="mr-2 h-4 w-4" />Обновить профиль Steam</Button>
                </div>
              </Section>
            )}

            {profileSection === "faq" && (
              <Section title="FAQ">
                <div className="space-y-3 text-sm text-neutral-300">
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-4"><div className="font-semibold text-white">Как подключить Steam?</div><div className="mt-2">Вставь обычную ссылку на профиль Steam. Искать SteamID64 вручную не нужно.</div></div>
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-4"><div className="font-semibold text-white">Где искать сохранённое?</div><div className="mt-2">В разделе «Сохранённое» внутри профиля или через кнопку сверху в ленте.</div></div>
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-4"><div className="font-semibold text-white">Что делает watchlist?</div><div className="mt-2">Собирает интересные тебе предметы в отдельный радар, чтобы было куда возвращаться каждый день.</div></div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <Button onClick={() => window.open(SUPPORT_LINK, "_blank", "noopener,noreferrer")} className="rounded-2xl bg-white text-[#0A0716] hover:bg-neutral-100"><MessageCircle className="mr-2 h-4 w-4" />Поддержка</Button>
                    <Button onClick={() => window.open(COMMUNITY_LINK, "_blank", "noopener,noreferrer")} className="rounded-2xl border border-white/10 bg-white/10 text-white hover:bg-white/15"><Users className="mr-2 h-4 w-4" />Комьюнити</Button>
                    <Button onClick={() => openTicketDialog({ title: "Проблема в приложении", sourceType: "app" })} className="rounded-2xl border border-rose-300/20 bg-rose-400/10 text-rose-100 hover:bg-rose-400/15"><MessageCircle className="mr-2 h-4 w-4" />Сообщить о проблеме</Button>
                  </div>
                </div>
              </Section>
            )}

            {profileSection === "admin" && isAdmin && (
              <Section title="Админка">
                <div className="grid grid-cols-3 gap-3 text-sm text-neutral-300">
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-3"><div className="text-neutral-500">Постов</div><div className="mt-1 font-semibold text-white">{updatesFeed.length + esportsFeed.length + gamesFeed.length}</div></div>
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-3"><div className="text-neutral-500">Watchlist</div><div className="mt-1 font-semibold text-white">{profileState.watchlist.length}</div></div>
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-3"><div className="text-neutral-500">Тикеты</div><div className="mt-1 font-semibold text-white">{tickets.filter((ticket) => ticket.status !== "done").length}</div></div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button onClick={() => setProfileSection("tickets")} className="rounded-2xl bg-white text-[#0A0716] hover:bg-neutral-100">Открыть тикеты</Button>
                  <Button onClick={() => fetchTickets()} className="rounded-2xl border border-white/10 bg-white/10 text-white hover:bg-white/15">Обновить тикеты</Button>
                  <Button onClick={() => window.open(SUPPORT_LINK, "_blank", "noopener,noreferrer")} className="rounded-2xl border border-white/10 bg-white/10 text-white hover:bg-white/15">Связь</Button>
                </div>
              </Section>
            )}

            {profileSection === "tickets" && isAdmin && (
              <Section title="Тикеты">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="text-sm text-neutral-400">Здесь лежат жалобы и баг-репорты от пользователей.</div>
                  <Button onClick={() => fetchTickets()} className="rounded-2xl border border-white/10 bg-white/10 text-white hover:bg-white/15">Обновить</Button>
                </div>
                <div className="space-y-3">
                  {ticketsLoading ? <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-neutral-400">Загружаю тикеты…</div> : null}
                  {!ticketsLoading && tickets.length === 0 ? <div className="rounded-2xl border border-dashed border-white/10 p-4 text-sm text-neutral-400">Тикетов пока нет.</div> : null}
                  {tickets.map((ticket) => (
                    <div key={ticket.id} className="rounded-2xl border border-white/10 bg-black/20 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-semibold text-white">{ticket.source?.title || "Сообщение о проблеме"}</div>
                          <div className="mt-1 text-xs text-neutral-500">{timeAgoRu(Math.floor((ticket.createdAt || Date.now()) / 1000))} · {ticket.reporter?.name || "Пользователь"}{ticket.reporter?.handle ? ` (${ticket.reporter.handle})` : ""}</div>
                        </div>
                        <Badge className={`rounded-full border ${ticket.status === "done" ? "border-emerald-300/30 bg-emerald-400/10 text-emerald-100" : "border-amber-300/30 bg-amber-400/10 text-amber-100"}`}>{ticket.status === "done" ? "Решён" : "Открыт"}</Badge>
                      </div>
                      <div className="mt-3 whitespace-pre-line text-sm leading-6 text-neutral-300">{ticket.message}</div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {ticket.source?.url ? <Button onClick={() => window.open(ticket.source?.url || "", "_blank", "noopener,noreferrer")} className="rounded-2xl border border-white/10 bg-white/10 text-white hover:bg-white/15">Открыть источник</Button> : null}
                        {ticket.status !== "done" ? <Button onClick={() => updateTicketStatus(ticket.id, "done")} className="rounded-2xl bg-white text-[#0A0716] hover:bg-neutral-100">Пометить решённым</Button> : <Button onClick={() => updateTicketStatus(ticket.id, "open")} className="rounded-2xl border border-white/10 bg-white/10 text-white hover:bg-white/15">Вернуть в открытые</Button>}
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </div>
        )}
        </motion.div>
      </AnimatePresence>
      {ticketDialogOpen ? (
        <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/55 p-4 backdrop-blur-sm sm:items-center">
          <div className="w-full max-w-md rounded-[1.8rem] border border-white/10 bg-[#0E0A18]/95 p-5 shadow-[0_30px_80px_rgba(0,0,0,0.5)]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold text-white">Сообщить о проблеме</div>
                <div className="mt-1 text-sm text-neutral-400">{ticketContext?.title || "Приложение LUDO"}</div>
              </div>
              <button onClick={() => setTicketDialogOpen(false)} className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-sm text-neutral-300 hover:bg-white/10">Закрыть</button>
            </div>
            <div className="mt-4 space-y-3">
              <textarea
                value={ticketDraft}
                onChange={(event) => setTicketDraft(event.target.value)}
                placeholder="Что именно сломалось, где это произошло и что ты ожидал увидеть?"
                className="min-h-[140px] w-full rounded-[1.25rem] border border-white/10 bg-black/20 px-4 py-3 text-sm text-white outline-none placeholder:text-neutral-500"
              />
              {ticketSubmitStatus ? <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-neutral-300">{ticketSubmitStatus}</div> : null}
              <div className="flex flex-wrap gap-2">
                <Button onClick={submitTicket} disabled={ticketSending} className="rounded-2xl bg-white text-[#0A0716] hover:bg-neutral-100">
                  {ticketSending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <MessageCircle className="mr-2 h-4 w-4" />}
                  Отправить
                </Button>
                <Button onClick={() => setTicketDialogOpen(false)} className="rounded-2xl border border-white/10 bg-white/10 text-white hover:bg-white/15">Отмена</Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}
