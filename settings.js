const intervalSelect = document.getElementById("interval-select");
const dndOptions = document.getElementById("dnd-options");
const dndStatus = document.getElementById("dnd-status");
const dndCloseBtn = document.getElementById("dnd-close-btn");
const statusMsg = document.getElementById("status-msg");
const exportBtn = document.getElementById("export-btn");
const importBtn = document.getElementById("import-btn");
const importFile = document.getElementById("import-file");
const novelCount = document.getElementById("novel-count");

document.addEventListener("DOMContentLoaded", async () => {
  const { intervalMinutes = 120, notificationsDisabledUntil = null, novels = [] } = await chrome.storage.local.get([
    "intervalMinutes",
    "notificationsDisabledUntil",
    "novels",
  ]);

  intervalSelect.value = String(intervalMinutes);

  const now = Date.now();
  const isCurrentlyDisabled = notificationsDisabledUntil && notificationsDisabledUntil > now;
  updateDndUI(isCurrentlyDisabled, notificationsDisabledUntil);

  updateNovelCount(novels.length);
  updateExportImportBtns(novels.length > 0);
});

intervalSelect.addEventListener("change", async () => {
  const minutes = Number(intervalSelect.value);
  const validIntervals = [60, 120, 240, 480, 720, 1440];

  if (!validIntervals.includes(minutes)) {
    showStatus("無效的檢查間隔", "error");
    return;
  }

  await chrome.storage.local.set({ intervalMinutes: minutes });
  chrome.runtime.sendMessage({ type: "UPDATE_INTERVAL", minutes });
  showStatus(`已更新：每 ${minutes >= 60 ? minutes / 60 + " 小時" : minutes + " 分鐘"} 自動檢查一次`);
});

function updateDndUI(isEnabled, disabledUntil) {
  const timeBtns = document.querySelectorAll(".dnd-time-btn");
  const dndSetting = document.querySelector(".dnd-setting");

  if (isEnabled) {
    dndCloseBtn.style.display = "block";
    const minutesLeft = Math.ceil((disabledUntil - Date.now()) / 60000);
    dndStatus.textContent = `進行中 (${minutesLeft}分鐘後關閉)`;
    timeBtns.forEach(btn => btn.style.display = "none");
    dndSetting.classList.add("active");
  } else {
    dndCloseBtn.style.display = "none";
    dndStatus.textContent = "";
    timeBtns.forEach(btn => btn.style.display = "block");
    dndSetting.classList.remove("active");
  }
}

document.querySelectorAll(".dnd-time-btn").forEach(btn => {
  btn.addEventListener("click", async () => {
    const minutes = Number(btn.dataset.minutes);
    const validDndMinutes = [60, 120, 240, 480, 720, 1440];

    if (!Number.isInteger(minutes) || !validDndMinutes.includes(minutes)) {
      showStatus("無效的時間設置", "error");
      return;
    }

    const disabledUntil = Date.now() + minutes * 60000;
    await chrome.storage.local.set({ notificationsDisabledUntil: disabledUntil });
    updateDndUI(true, disabledUntil);
  });
});

dndCloseBtn.addEventListener("click", async () => {
  await chrome.storage.local.set({ notificationsDisabledUntil: null });
  updateDndUI(false);
});

function updateNovelCount(count) {
  novelCount.textContent = `${count} 本`;
}

function updateExportImportBtns(hasNovels) {
  exportBtn.disabled = !hasNovels;
  importBtn.disabled = false;
}

exportBtn.addEventListener("click", async () => {
  const { novels = [] } = await chrome.storage.local.get("novels");
  if (novels.length === 0) {
    showStatus("無追蹤小說可匯出", "error");
    return;
  }

  const data = {
    version: 1,
    exportDate: new Date().toISOString(),
    novels: novels,
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `po18-novels-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showStatus("匯出成功", "success");
});

importBtn.addEventListener("click", () => {
  importFile.click();
});

function isValidNovel(novel) {
  return (
    typeof novel.url === 'string' &&
    isValidPo18Url(novel.url) &&
    typeof novel.title === 'string' &&
    novel.title.length > 0
  );
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

importFile.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);

    if (!Array.isArray(data.novels)) {
      throw new Error("無效的檔案格式");
    }

    const { novels = [] } = await chrome.storage.local.get("novels");
    const existingUrls = new Set(novels.map(n => n.url));

    let importCount = 0;
    for (const novel of data.novels) {
      if (!isValidNovel(novel)) {
        throw new Error("檔案中包含無效的小說資料");
      }
      if (!existingUrls.has(novel.url)) {
        novels.push(novel);
        importCount++;
      }
    }

    await chrome.storage.local.set({ novels });
    updateNovelCount(novels.length);
    updateExportImportBtns(novels.length > 0);

    showStatus(`匯入成功：新增 ${importCount} 本小說`, "success");
  } catch (err) {
    showStatus(`匯入失敗：${err.message}`, "error");
  }

  importFile.value = "";
});

function showStatus(msg, type = "success") {
  statusMsg.textContent = msg;
  statusMsg.style.color = type === "success" ? "#27ae60" : "#F13392";
  statusMsg.style.background = type === "success" ? "#f0f8f0" : "#fee";
  statusMsg.classList.add("show");
  setTimeout(() => {
    statusMsg.classList.remove("show");
  }, 3000);
}
