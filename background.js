const ALARM_NAME = "po18-check";
const DEFAULT_INTERVAL_MINUTES = 120;
let isCheckingInProgress = false;

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const ICONS = {
  error: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'><rect fill='%23F13392' width='48' height='48'/><text x='24' y='32' text-anchor='middle' fill='white' font-size='28' font-weight='bold'>!<​/text></svg>",
  success: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'><rect fill='%2327ae60' width='48' height='48'/><text x='24' y='32' text-anchor='middle' fill='white' font-size='32' font-weight='bold'>✓<​/text></svg>",
  loginExpired: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'><rect fill='%23e74c3c' width='48' height='48'/><circle cx='24' cy='14' r='4' fill='white'/><path d='M24 20 L24 32' stroke='white' stroke-width='3' stroke-linecap='round'/></svg>",
  newChapter: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'><rect fill='%2327ae60' width='48' height='48'/><circle cx='24' cy='24' r='14' fill='white' opacity='0.2'/><path d='M18 24 L22 28 L30 20' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'/></svg>",
};

chrome.runtime.onInstalled.addListener(async () => {
  setupAlarm();
  updateBadge();
  await migrateOldData();
  chrome.contextMenus.create({
    id: "add-po18-book",
    title: "加入 PO18 書籍追蹤",
    contexts: ["page"],
    documentUrlPatterns: ["*://www.po18.tw/books/*", "*://members.po18.tw/books/*"],
  });
});

async function migrateOldData() {
  const { novels = [] } = await chrome.storage.local.get(["novels"]);
  const migrated = novels.map((n) => ({ ...n, hasUnread: n.hasUnread ?? false }));
  if (migrated.length > 0) {
    const unreadCount = migrated.filter((n) => n.hasUnread === true).length;
    await chrome.storage.local.set({ novels: migrated, unreadCount });
  }
}

chrome.runtime.onStartup.addListener(async () => {
  setupAlarm();
  updateBadge();
  await migrateOldData();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "add-po18-book") {
    try {
      const novel = await fetchNovelInfoFromUrl(tab.url);
      const { novels = [] } = await chrome.storage.local.get("novels");

      if (novels.some((n) => n.url === novel.url)) {
        await showNotification(`context-menu-error-${Date.now()}`, {
          type: "basic",
          iconUrl: ICONS.error,
          title: "PO18 追更小幫手",
          message: `《${escapeHtml(novel.title)}》已在追蹤清單中`,
          priority: 1,
        });
        return;
      }

      novels.push(novel);
      await chrome.storage.local.set({ novels });

      await showNotification(`context-menu-success-${Date.now()}`, {
        type: "basic",
        iconUrl: ICONS.success,
        title: "PO18 追更小幫手",
        message: `已加入追蹤：《${escapeHtml(novel.title)}》`,
        priority: 1,
      });
    } catch (err) {
      const errorMsg = err.message || "發生未知錯誤，請重試";
      await showNotification(`context-menu-error-${Date.now()}`, {
        type: "basic",
        iconUrl: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'><rect fill='%23F13392' width='48' height='48'/><text x='24' y='32' text-anchor='middle' fill='white' font-size='28' font-weight='bold'>!<​/text></svg>",
        title: "PO18 追更小幫手",
        message: `無法加入追蹤：${escapeHtml(errorMsg)}`,
        priority: 1,
      });
    }
  }
});

async function showNotification(id, options) {
  const { notificationsDisabledUntil = null } = await chrome.storage.local.get("notificationsDisabledUntil");
  const isCurrentlyDisabled = notificationsDisabledUntil && notificationsDisabledUntil > Date.now();

  if (!isCurrentlyDisabled) {
    chrome.notifications.create(id, options);
  }

  if (notificationsDisabledUntil && notificationsDisabledUntil <= Date.now()) {
    await chrome.storage.local.set({ notificationsDisabledUntil: null });
  }
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.unreadCount) {
    updateBadge();
  }
});

async function updateBadge() {
  const data = await chrome.storage.local.get("unreadCount");
  const unreadCount = data.unreadCount ?? 0;
  if (unreadCount > 0) {
    chrome.action.setBadgeText({ text: String(unreadCount) });
    chrome.action.setBadgeBackgroundColor({ color: "#c0392b" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

async function setupAlarm(forceRecreate = false) {
  const { intervalMinutes = DEFAULT_INTERVAL_MINUTES } = await chrome.storage.local.get("intervalMinutes");
  const existing = await chrome.alarms.get(ALARM_NAME);

  if (forceRecreate && existing) {
    await chrome.alarms.clear(ALARM_NAME);
  }

  if (forceRecreate || !existing) {
    chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: intervalMinutes,
      periodInMinutes: intervalMinutes,
    });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    checkAllNovels();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 驗證 message 來自擴展內部，不接受外部來源
  if (sender.url && !sender.url.startsWith(chrome.runtime.getURL(""))) {
    return false;
  }

  if (message.type === "MANUAL_CHECK") {
    sendResponse({ ok: true });
    performCheckWithUI();
    return false;
  }

  if (message.type === "MARK_AS_READ") {
    (async () => {
      const { novels = [] } = await chrome.storage.local.get("novels");
      const updated = novels.map((n) => (n.url === message.url ? { ...n, hasUnread: false } : n));
      const unreadCount = updated.filter((n) => n.hasUnread === true).length;
      await chrome.storage.local.set({ novels: updated, unreadCount });
      updateBadge();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === "GET_CHECK_LOG") {
    chrome.storage.local.get("checkLog", ({ checkLog }) => {
      sendResponse({ log: checkLog || "" });
    });
    return true;
  }

  if (message.type === "UPDATE_INTERVAL") {
    const minutes = Number(message.minutes);
    if (!Number.isInteger(minutes) || minutes < 1) {
      sendResponse({ error: "無效的檢查間隔" });
      return false;
    }
    chrome.storage.local.set({ intervalMinutes: minutes }, () => {
      setupAlarm(true).then(() => sendResponse({ ok: true }));
    });
    return true;
  }
});

const PO18_LOGIN_URL = "https://members.po18.tw/apps/login.php";

chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId === "login-expired") {
    chrome.tabs.create({ url: PO18_LOGIN_URL });
    chrome.notifications.clear("login-expired");
  }
});

async function performCheckWithUI() {
  await chrome.storage.local.set({ isChecking: true, checkLog: "[開始檢查...]" });
  try {
    await checkAllNovels();
    await chrome.storage.local.set({ isChecking: false, checkLog: "[檢查完成]" });
  } catch (err) {
    const errorMsg = `[錯誤] ${err.message}`;
    await chrome.storage.local.set({ isChecking: false, checkLog: errorMsg });
  }
}

async function checkAllNovels() {
  if (isCheckingInProgress) return;

  isCheckingInProgress = true;
  try {
    let { novels = [] } = await chrome.storage.local.get(["novels"]);

    if (novels.length === 0) {
      await chrome.storage.local.set({ checkLog: "沒有追蹤的小說" });
      return;
    }

    novels = novels.map((n) => ({ ...n, hasUnread: n.hasUnread ?? false }));

    await chrome.storage.local.set({ checkLog: `並行檢查 ${novels.length} 本小說...` });

    const results = await Promise.all(novels.map((novel) => checkNovel(novel)));

    if (results.includes("LOGIN_EXPIRED")) {
      await chrome.storage.local.set({ checkLog: "登入已過期，停止檢查" });
      return;
    }

    let updatedNovels = [...novels];

    for (const result of results) {
      if (!result || !result.novelUpdate) continue;
      const { novelUpdate, hasNewChapter } = result;
      const idx = updatedNovels.findIndex((n) => n.url === novelUpdate.url);
      if (idx !== -1) {
        updatedNovels[idx] = novelUpdate;
        updatedNovels[idx].hasUnread = hasNewChapter === true;
      }
    }

    const unreadCount = updatedNovels.filter((n) => n.hasUnread === true).length;

    await chrome.storage.local.set({
      novels: updatedNovels,
      unreadCount,
      lastCheckTime: Date.now(),
    });
    updateBadge();
    chrome.runtime.sendMessage({ type: "REFRESH_UI" }).catch(() => {});
  } catch (err) {
    await chrome.storage.local.set({ checkLog: `檢查失敗: ${err.message}` });
    throw err;
  } finally {
    isCheckingInProgress = false;
  }
}

async function checkNovel(novel) {
  let html;
  let res;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    res = await fetch(novel.url, {
      credentials: "include",
      signal: controller.signal,
    });
    html = await res.text();
  } catch (err) {
    return {};
  } finally {
    clearTimeout(timeoutId);
  }

  if (isLoginPage(res.url, html)) {
    await showNotification("login-expired", {
      type: "basic",
      iconUrl: ICONS.loginExpired,
      title: "PO18 追更小幫手",
      message: "登入憑證已過期，點擊此通知前往重新登入。",
      priority: 2,
      requireInteraction: true,
    });
    return "LOGIN_EXPIRED";
  }

  const parsed = parseNovelPage(html);
  if (!parsed) return {};

  const { latestChapter, latestChapterLabel, currentChapter } = parsed;
  const hasNewChapter = latestChapter && latestChapter !== novel.lastChapter;

  if (hasNewChapter) {
    const notificationId = `update-${novel.url.split("/").pop()}-${Date.now()}`;
    await showNotification(notificationId, {
      type: "basic",
      iconUrl: ICONS.newChapter,
      title: `《${escapeHtml(novel.title)}》有新章節！`,
      message: `最新章節：${escapeHtml(latestChapterLabel ?? "（新章節）")}`,
      priority: 2,
    });
  }

  return {
    novelUpdate: { ...novel, lastChapter: latestChapter, lastChapterLabel: latestChapterLabel, currentChapter },
    hasNewChapter,
  };
}

async function fetchNovelInfoFromUrl(url) {
  const res = await fetch(url, { credentials: "include" });
  const html = await res.text();

  if (isLoginPage(res.url, html)) {
    throw new Error("PO18 登入憑證已過期");
  }

  const parsed = parseNovelPage(html);
  if (!parsed) {
    throw new Error("無法取得章節資訊");
  }

  const { title, latestChapter, latestChapterLabel, currentChapter } = parsed;
  return { url, title, lastChapter: latestChapter, lastChapterLabel: latestChapterLabel, currentChapter, addedAt: Date.now(), hasUnread: false };
}

function isLoginPage(finalUrl, html) {
  if (finalUrl.includes("members.po18.tw/apps/login.php")) return true;
  return html.includes("請先登入") || html.includes('type="password"');
}

function parseNovelPage(html) {
  const titleMatch = html.match(/<h1[^>]*class="book_name"[^>]*>([^<]+)<\/h1>/);
  const title = titleMatch ? titleMatch[1].trim() : "未知書名";

  const chapterTextMatch = html.match(/<h4[^>]*>([^<]+)<\/h4>/);
  const chapterText = chapterTextMatch ? chapterTextMatch[1].trim() : null;

  let dateText = null;
  const dateFullMatch = html.match(/<div[^>]*class="date"[^>]*>([^<]*(?:<[^>]*>[^<]*)*)<\/div>/);
  if (dateFullMatch) {
    const dateContent = dateFullMatch[1];
    const dateFormatMatch = dateContent.match(/(\d{4}-\d{2}-\d{2})/);
    if (dateFormatMatch) {
      dateText = dateFormatMatch[1];
    } else {
      dateText = dateContent.replace(/<[^>]*>/g, "").trim();
    }
  }

  let latestChapter = null;
  const hrefMatch = html.match(/href="([^"]*\/articles\/[^"]*)"/);
  if (hrefMatch) {
    latestChapter = hrefMatch[1];
  } else if (chapterText && dateText) {
    latestChapter = `${chapterText}|${dateText}`;
  }

  if (!latestChapter) {
    return null;
  }

  const statusMatch = html.match(/class="statu"[^>]*>[^<]*<span[^>]*>\(目前(\d+)章回\)/);
  let currentChapter = null;
  let finalLabel = chapterText;
  if (statusMatch) {
    currentChapter = parseInt(statusMatch[1], 10);
    if (finalLabel && currentChapter) {
      finalLabel = `${finalLabel}（${currentChapter}）`;
    }
  }

  return { title: title || "未知書名", latestChapter, latestChapterLabel: finalLabel, currentChapter };
}
