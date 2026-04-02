'use strict';

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.url || tab.url.startsWith('chrome') || tab.url.startsWith('edge') || tab.url.startsWith('about')) return;

  try {
    // まずtoggleメッセージを送信（content scriptが既にある場合）
    await chrome.tabs.sendMessage(tab.id, { action: "toggle" });
  } catch {
    // content scriptが未注入 → 手動注入してからスクリーンショット
    try {
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ["styles.css"]
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"]
      });
      setTimeout(async () => {
        try {
          await chrome.tabs.sendMessage(tab.id, { action: "toggle" });
        } catch {}
      }, 200);
    } catch {
      // 注入不可能なページ
    }
  }
});

// content scriptからのスクリーンショットリクエスト
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'captureTab' && sender.tab) {
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' })
      .then(dataUrl => sendResponse({ dataUrl }))
      .catch(() => sendResponse({ error: true }));
    return true; // 非同期レスポンス
  }
});
