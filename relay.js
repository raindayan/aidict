// relay.js - 隔离世界内容脚本（中继）
// 接收主世界 interceptor.js 通过 window.postMessage 发来的对话数据，
// 校验来源后调用 chrome.runtime 转发给 background 存入 IndexedDB。
(function () {
  'use strict';

  const BRIDGE_KEY = '__DEEPSEEK_EXT_RELAY__';

  // 判断扩展上下文是否有效（扩展被重载后 chrome.runtime.id 变为 undefined）
  function extensionValid() {
    try {
      return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
    } catch (e) {
      return false;
    }
  }

  window.addEventListener('message', (event) => {
    // 只接收同窗口（主世界）发来的消息，避免其他页面/iframe 干扰
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== BRIDGE_KEY) return;

    if (msg.type === 'SAVE_CONVERSATION' && msg.data) {
      if (!extensionValid()) {
        console.warn('[DeepSeek中继] 扩展上下文已失效，请刷新 DeepSeek 页面后重试');
        return;
      }
      try {
        chrome.runtime.sendMessage({ type: 'SAVE_CONVERSATION', data: msg.data }, () => {
          void chrome.runtime.lastError;
        });
      } catch (e) {
        console.warn('[DeepSeek中继] 发送失败:', e);
      }
    }
  });

  console.log('[DeepSeek中继] 已就绪');
})();
