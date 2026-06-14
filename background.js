const ALARM_NAME = "po18-check";
const DEFAULT_INTERVAL_MINUTES = 120;

const ICONS = {
  error: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'><rect fill='%23F13392' width='48' height='48'/><text x='24' y='32' text-anchor='middle' fill='white' font-size='28' font-weight='bold'>!<​/text></svg>",
  success: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'><rect fill='%2327ae60' width='48' height='48'/><text x='24' y='32' text-anchor='middle' fill='white' font-size='32' font-weight='bold'>✓<​/text></svg>",
  loginExpired: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'><rect fill='%23e74c3c' width='48' height='48'/><circle cx='24' cy='14' r='4' fill='white'/><path d='M24 20 L24 32' stroke='white' stroke-width='3' stroke-linecap='round'/></svg>",
  newChapter: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'><rect fill='%2327ae60' width='48' height='48'/><circle cx='24' cy='24' r='14' fill='white' opacity='0.2'/><path d='M18 24 L22 28 L30 20' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'/></svg>",
};

chrome.runtime.onInstalled.addListener(() => {
  setupAlarm();
  updateBadge();
  chrome.contextMenus.create({
    id: "add-po18-book",
    title: "加入 PO18 書籍追蹤",
    contexts: ["page"],
    documentUrlPatterns: ["*://www.po18.tw/books/*", "*://members.po18.tw/books/*"],
  });
});

chrome.runtime.onStartup.addListener(() => {
  setupAlarm();
  updateBadge();
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
          message: `《${novel.title}》已在追蹤清單中`,
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
        message: `已加入追蹤：《${novel.title}》`,
        priority: 1,
      });
    } catch (err) {
      await showNotification(`context-menu-error-${Date.now()}`, {
        type: "basic",
        iconUrl: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'><rect fill='%23F13392' width='48' height='48'/><text x='24' y='32' text-anchor='middle' fill='white' font-size='28' font-weight='bold'>!<​/text></svg>",
        title: "PO18 追更小幫手",
        message: `無法加入追蹤：${err.message}`,
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

async function updateBadge() {
  const { unreadCount = 0 } = await chrome.storage.local.get("unreadCount");
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "MANUAL_CHECK") {
    sendResponse({ ok: true });
    chrome.storage.local.set({ isChecking: true, checkLog: "[開始檢查...]" });
    checkAllNovels()
      .then(() => {
        chrome.storage.local.set({ isChecking: false, checkLog: "[檢查完成]" });
      })
      .catch((err) => {
        const errorMsg = `[錯誤] ${err.message}`;
        chrome.storage.local.set({ isChecking: false, checkLog: errorMsg });
      });
    return false;
  }

  if (message.type === "GET_CHECK_LOG") {
    chrome.storage.local.get("checkLog", ({ checkLog }) => {
      sendResponse({ log: checkLog || "" });
    });
    return true;
  }

  if (message.type === "UPDATE_INTERVAL") {
    chrome.storage.local.set({ intervalMinutes: message.minutes }, () => {
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

async function checkAllNovels() {
  try {
    const { novels = [] } = await chrome.storage.local.get("novels");
    await chrome.storage.local.set({ checkLog: `找到 ${novels.length} 本小說...` });

    const lastCheckTime = Date.now();

    if (novels.length > 0) {
      for (let i = 0; i < novels.length; i++) {
        const novel = novels[i];
        await chrome.storage.local.set({ checkLog: `檢查中 (${i + 1}/${novels.length}): ${novel.title}...` });
        const result = await checkNovel(novel, novels);
          if (result === "LOGIN_EXPIRED") {
          await chrome.storage.local.set({ checkLog: "登入已過期，停止檢查" });
          break;
        }
      }
    } else await chrome.storage.local.set({ checkLog: "沒有追蹤的小說" });

    await chrome.storage.local.set({ lastCheckTime });
  } catch (err) {
    await chrome.storage.local.set({ checkLog: `檢查失敗: ${err.message}` });
    throw err;
  }
}

async function checkNovel(novel, allNovels) {
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
    if (err.name === "AbortError") {
      console.error(`[PO18] fetch 逾時（10s）：${novel.url}`);
    } else {
      console.error(`[PO18] fetch 失敗：${novel.url}`, err.message);
    }
    return;
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
  if (!parsed) {
    return;
  }

  const { latestChapter, latestChapterLabel } = parsed;

  const hasNewChapter = latestChapter && latestChapter !== novel.lastChapter;

  if (hasNewChapter) {
    await showNotification(`update-${novel.url}`, {
      type: "basic",
      iconUrl: ICONS.newChapter,
      title: `《${novel.title}》有新章節！`,
      message: `最新章節：${latestChapterLabel ?? "（新章節）"}`,
      priority: 2,
    });
  }

  const { unreadCount = 0 } = await chrome.storage.local.get("unreadCount");
  const updatedNovels = allNovels.map((n) =>
    n.url === novel.url
      ? { ...n, lastChapter: latestChapter, lastChapterLabel: latestChapterLabel }
      : n
  );
  await chrome.storage.local.set({
    novels: updatedNovels,
    unreadCount: hasNewChapter ? unreadCount + 1 : unreadCount,
  });
  updateBadge();
}

async function fetchNovelInfoFromUrl(url) {
  const res = await fetch(url, { credentials: "include" });
  const html = await res.text();

  if (
    res.url.includes("members.po18.tw/apps/login.php") ||
    html.includes("請先登入") ||
    html.includes('type="password"')
  ) {
    throw new Error("PO18 登入憑證已過期");
  }

  const titleMatch = html.match(/<h1[^>]*class="book_name"[^>]*>([^<]+)<\/h1>/);
  const title = titleMatch ? titleMatch[1].trim() : "未知書名";

  const newChapterMatch = html.match(/<div[^>]*class="new_chapter"[^>]*>([\s\S]*?)<\/div>/);
  if (!newChapterMatch) {
    throw new Error("無法解析最新章節");
  }

  const chapterTextMatch = html.match(/<h4[^>]*>([^<]+)<\/h4>/);
  const lastChapterLabel = chapterTextMatch ? chapterTextMatch[1].trim() : null;

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

  let lastChapter = null;
  const hrefMatch = html.match(/href="([^"]*\/articles\/[^"]*)"/);
  if (hrefMatch) {
    lastChapter = hrefMatch[1];
  } else if (lastChapterLabel && dateText) {
    lastChapter = `${lastChapterLabel}|${dateText}`; // 付費章節備選
  }

  if (!lastChapter) {
    throw new Error("無法取得章節資訊");
  }

  return { url, title, lastChapter, lastChapterLabel, addedAt: Date.now() };
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
    latestChapter = `${chapterText}|${dateText}`; // 付費章節備選
  }

  if (!latestChapter) {
    return null;
  }

  return { title, latestChapter, latestChapterLabel: chapterText };
}
