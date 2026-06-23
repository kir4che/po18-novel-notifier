const urlInput = document.getElementById("url-input");
const addBtn = document.getElementById("add-btn");
const checkBtn = document.getElementById("check-btn");
const loginBtn = document.getElementById("login-btn");
const statusMsg = document.getElementById("status-msg");
const novelList = document.getElementById("novel-list");
const loginStatusText = document.getElementById("login-status-text");
const lastCheckTimeEl = document.getElementById("last-check-time");
const settingsBtn = document.getElementById("settings-btn");
const footerRow = document.querySelector(".footer-row");

document.addEventListener("DOMContentLoaded", async () => {
  const { isChecking = false } = await chrome.storage.local.get(["isChecking"]);

  await updateLoginStatus();
  await updateLastCheckTime();
  await renderList();
  await syncUnreadCount();
  urlInput.focus();
  updateAddBtnState();
  if (isChecking) {
    const loggedIn = await checkIsLoggedIn();
    updateCheckBtnState(true, loggedIn);
    statusMsg.innerHTML = '<span class="spinner"></span>背景檢查中，有更新將跳出通知…';
    statusMsg.className = "";
  }
});

window.addEventListener("focus", async () => {
  await updateLoginStatus();
  await renderList();
});
setInterval(updateLoginStatus, 5000);

urlInput.addEventListener("input", updateAddBtnState);

function updateAddBtnState() {
  addBtn.disabled = urlInput.value.trim() === "";
}

async function checkIsLoggedIn() {
  const [byUrlWww, byUrlMembers, byDomain, byDomainDot] = await Promise.all([
    chrome.cookies.getAll({ url: "https://www.po18.tw/" }),
    chrome.cookies.getAll({ url: "https://members.po18.tw/" }),
    chrome.cookies.getAll({ domain: "po18.tw" }),
    chrome.cookies.getAll({ domain: ".po18.tw" }),
  ]);

  const all = [...byUrlWww, ...byUrlMembers, ...byDomain, ...byDomainDot];
  const AUTH_COOKIES = ["authtoken2", "authtoken3", "authtoken4", "authtoken5"];
  return AUTH_COOKIES.some((name) => all.some((c) => c.name === name));
}

async function updateLoginStatus() {
  const loggedIn = await checkIsLoggedIn();
  loginStatusText.textContent = loggedIn ? "已登入" : "尚未登入";
  loginBtn.classList.toggle("login-btn-hidden", loggedIn);
  const statusIcon = document.getElementById("status-icon");
  if (statusIcon) {
    statusIcon.textContent = loggedIn ? "✓" : "✕";
  }
  updateCheckBtnState(checkBtn.textContent === "檢查中…", loggedIn);
}

async function updateLastCheckTime() {
  const { lastCheckTime = null } = await chrome.storage.local.get("lastCheckTime");
  if (!lastCheckTime) {
    lastCheckTimeEl.textContent = "尚未檢查";
    return;
  }
  const relativeTime = getRelativeTime(lastCheckTime);
  lastCheckTimeEl.textContent = `最後檢查：${relativeTime}`;
}

function getRelativeTime(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return "剛剛";
  if (minutes < 60) return `${minutes}分鐘前`;
  if (hours < 24) return `${hours}小時前`;
  return `${days}天前`;
}

function updateCheckBtnState(checking = false, loggedIn = true) {
  checkBtn.disabled = checking || !loggedIn;
  checkBtn.textContent = checking ? "檢查中…" : "立即檢查";
}

settingsBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
});

addBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();

  if (!isValidPo18Url(url)) {
    showStatus(getPo18UrlError(url), "error");
    return;
  }

  addBtn.disabled = true;
  showStatus("正在讀取書籍資訊…");

  try {
    const novel = await fetchNovelInfo(url);
    await saveNovel(novel);
    urlInput.value = "";
    showStatus(`已加入追蹤：《${escapeHtml(novel.title)}》`, "success");
    await renderList();
  } catch (err) {
    const errorMsg = err.message || "發生未知錯誤，請重試";
    showStatus(escapeHtml(errorMsg), "error");
  } finally {
    addBtn.disabled = false;
  }
});

loginBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "https://members.po18.tw/apps/login.php" });
  window.addEventListener("focus", async () => {
    await updateLoginStatus();
    const loggedIn = await checkIsLoggedIn();
    if (loggedIn) {
      updateCheckBtnState(true, true);
      statusMsg.innerHTML = '<span class="spinner"></span>登入成功，開始檢查更新…';
      statusMsg.className = "";
      chrome.runtime.sendMessage({ type: "MANUAL_CHECK" });
    }
  }, { once: true });
});

checkBtn.addEventListener("click", async () => {
  const loggedIn = await checkIsLoggedIn();
  updateCheckBtnState(true, loggedIn);
  statusMsg.innerHTML = '<span class="spinner"></span>背景檢查中，有更新將跳出通知…';
  statusMsg.className = "";
  chrome.runtime.sendMessage({ type: "MANUAL_CHECK" });
  setTimeout(async () => {
    if (checkBtn.textContent === "檢查中…") {
      const loggedIn = await checkIsLoggedIn();
      updateCheckBtnState(false, loggedIn);
      showStatus("檢查逾時，已停止等待。", "error");
    }
  }, 60000);
});

chrome.storage.onChanged.addListener(async (changes) => {
  if (changes.checkLog) {
    statusMsg.textContent = changes.checkLog.newValue || "";
    statusMsg.className = "";
  }
  if (changes.lastCheckTime) {
    updateLastCheckTime();
    if (checkBtn.textContent === "檢查中…") {
      const loggedIn = await checkIsLoggedIn();
      updateCheckBtnState(false, loggedIn);
    }
  }
  if (changes.novels || changes.novelssWithUnread || changes.unreadCount) {
    await renderList();
  }
});

async function fetchNovelInfo(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  let res;
  try {
    res = await fetch(url, { credentials: "include", signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("讀取逾時，請檢查網路連接或稍後重試。");
    }
    throw new Error("讀取失敗，請檢查網路連接。");
  } finally {
    clearTimeout(timeoutId);
  }
  const html = await res.text();

  if (
    res.url.includes("members.po18.tw/apps/login.php") ||
    html.includes("請先登入") ||
    html.includes('type="password"')
  ) {
    throw new Error("PO18 登入憑證已過期，請先登入 PO18 後再試。");
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  const title = doc.querySelector("h1.book_name")?.textContent?.trim() || "未知書名";

  const newChapterSection = doc.querySelector(".new_chapter");
  if (!newChapterSection) {
    throw new Error("無法解析最新章節，請確認網址是否為書籍頁面。");
  }

  const lastChapterLabel = newChapterSection.querySelector("h4")?.textContent?.trim() || null;
  const dateText = newChapterSection.querySelector(".date")?.textContent?.trim() || null;

  let lastChapter = newChapterSection.querySelector('a[href*="/articles/"]')?.getAttribute("href");

  if (!lastChapter) {
    lastChapter = newChapterSection.querySelector('a.btn_blue[href*="/articles/"]')?.getAttribute("href");
  }

  if (!lastChapter && lastChapterLabel && dateText) {
    lastChapter = `${lastChapterLabel}|${dateText}`; // 付費章節備選
  }

  if (!lastChapter) {
    throw new Error("無法取得章節資訊，請確認網址是否為書籍頁面。");
  }

  // 從 dd.statu 元素中提取目前章回數
  const statusEl = doc.querySelector("dd.statu");
  let currentChapter = null;
  if (statusEl) {
    const text = statusEl.textContent;
    const match = text.match(/(\d+)/);
    if (match) {
      currentChapter = parseInt(match[1], 10);
    }
  }

  let finalLabel = lastChapterLabel;
  if (finalLabel && currentChapter !== null) {
    finalLabel = `${finalLabel}（${currentChapter}）`;
  }

  return { url, title, lastChapter, lastChapterLabel: finalLabel, currentChapter, addedAt: Date.now(), hasUnread: false };
}

async function saveNovel(novel) {
  const { novels = [] } = await chrome.storage.local.get("novels");

  if (novels.some((n) => n.url === novel.url)) {
    throw new Error("此書籍已在追蹤清單中。");
  }

  novels.push(novel);
  await chrome.storage.local.set({ novels });
}

async function deleteNovel(url) {
  const { novels = [] } = await chrome.storage.local.get(["novels"]);
  const updatedNovels = novels.filter((n) => n.url !== url);
  const unreadCount = updatedNovels.filter((n) => n.hasUnread === true).length;
  await chrome.storage.local.set({
    novels: updatedNovels,
    unreadCount
  });
}

async function syncUnreadCount() {
  const { novels = [] } = await chrome.storage.local.get(["novels"]);
  const unreadCount = novels.filter((n) => n.hasUnread === true).length;
  await chrome.storage.local.set({ unreadCount });
}

async function renderList() {
  let { novels = [] } = await chrome.storage.local.get(["novels"]);

  const needsMigration = novels.some((n) => n.hasUnread === undefined);
  if (needsMigration) {
    novels = novels.map((n) => ({ ...n, hasUnread: n.hasUnread ?? false }));
    const unreadCount = novels.filter((n) => n.hasUnread === true).length;
    await chrome.storage.local.set({ novels, unreadCount });
  }

  novelList.innerHTML = "";

  if (novels.length === 0) {
    novelList.innerHTML = '<li class="empty-msg">尚無追蹤小說</li>';
    footerRow.style.display = "none";
    return;
  }

  footerRow.style.display = "flex";

  for (const novel of novels) {
    const li = document.createElement("li");
    li.className = "novel-item";
    const isUnread = novel.hasUnread === true;
    const chapterClass = isUnread ? 'class="novel-chapter unread"' : 'class="novel-chapter"';
    li.innerHTML = `
      <div class="novel-info">
        <a class="novel-title" href="${escapeHtml(novel.url)}" title="${escapeHtml(novel.title)}" target="_blank">${escapeHtml(novel.title)}</a>
        <div ${chapterClass} title="${escapeHtml(novel.lastChapterLabel ?? "")}">最新：${escapeHtml(novel.lastChapterLabel ?? "（未知章節）")}</div>
      </div>
      <button class="delete-btn" data-url="${escapeHtml(novel.url)}">刪除</button>
    `;

    li.querySelector(".novel-title").addEventListener("click", async (e) => {
      e.preventDefault();
      await chrome.runtime.sendMessage({ type: "MARK_AS_READ", url: novel.url });
      chrome.tabs.create({ url: novel.url });
    });

    li.querySelector(".delete-btn").addEventListener("click", async (e) => {
      const targetUrl = e.currentTarget.dataset.url;
      await deleteNovel(targetUrl);
      await renderList();
    });

    novelList.appendChild(li);
  }
}

function isValidPo18Url(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname.includes("po18.tw") &&
      parsed.pathname.includes("/books/") &&
      !parsed.pathname.includes("/articles/")
    );
  } catch {
    return false;
  }
}

function getPo18UrlError(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes("po18.tw")) return "請輸入 PO18 網址。";
    if (parsed.pathname.includes("/articles/")) return "請貼書籍頁面網址，而非章節網址。（移除網址中 /articles/ 之後的部分）";
    if (!parsed.pathname.includes("/books/")) return "請輸入有效的 PO18 書籍網址。";
  } catch {
    // ignore
  }
  return "請輸入有效的 PO18 書籍網址。";
}

function showStatus(msg, type = "") {
  statusMsg.textContent = msg;
  statusMsg.className = type;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "REFRESH_UI") {
    renderList().then(() => sendResponse({ ok: true }));
    return true;
  }
});

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
