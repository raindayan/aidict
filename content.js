// content.js - DeepSeek 专用适配器
//
// ⚠️ 已弃用：本文件（DOM 抓取方案）已从 manifest.json 中移除，
// 不再注入页面。当前改用网络拦截方案 interceptor.js
// （主世界包装 fetch/XHR，拦截 /api/v0/chat/completion 获取对话记录）。
// 此文件仅作历史参考，可安全删除。
(function() {
  'use strict';

  // ---------- 配置 ----------
  const CONFIG = {
    // DeepSeek 的选择器（基于最新 DOM 结构）
    selectors: {
      // 消息容器（父级）
      messageContainer: '.ds-virtual-list-visible-items',
      // 用户消息
      userMessage: '.ds-collapsible-text',
      // AI 消息
      aiMessage: '.ds-assistant-message-main-content',
      // 消息内容文本（DeepSeek 用 .markdown-body 或直接 textContent）
      contentArea: '.markdown-body, .message-content, .prose'
    },
    // 发送按钮识别（基于观察到的 class 特征）
    sendButton: {
      // 发送按钮上稳定存在的特征 class
      markerClasses: ['ds-button--icon-relative-m', 'ds-button--circle'],
      // 禁用状态追加的 class（发送按钮变为可用时会被移除）
      disabledClass: 'ds-button--disabled'
    },
    // 防抖延迟（毫秒）
    debounceDelay: 300,
    // 会话超时（毫秒），超过此间隔视为新会话
    sessionTimeout: 30 * 60 * 1000,
    // 发送按钮重新绑定检查间隔（处理 SPA 切换 / 按钮重建）
    buttonCheckInterval: 2000
  };

  // ---------- 状态 ----------
  let lastMessageHash = '';
  let lastActivityTime = Date.now();
  let currentSessionId = generateSessionId();
  let isProcessing = false;

  // 对话 DOM 监听器（由发送动作触发启动）
  let messageObserver = null;
  // 当前绑定的发送按钮及其 class 监听器
  let sendButton = null;
  let sendButtonObserver = null;
  // 定时器句柄（用于扩展上下文失效时清理）
  let urlCheckTimer = null;
  let buttonCheckTimer = null;

  // ---------- 工具函数 ----------
  function generateSessionId() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).substr(2, 6);
  }

  // 简单哈希（用于去重）
  function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return 'h' + Math.abs(hash).toString(36);
  }

  // 获取对话标题（从页面左上角或侧边栏）
  function getConversationTitle() {
    // 尝试从侧边栏获取当前对话标题
    const titleEl = document.querySelector('.conversation-title, .chat-title, [class*="conversation-title"]');
    if (titleEl) return titleEl.textContent.trim();
    
    // 后备方案：从 URL 或 localStorage 获取
    const urlMatch = window.location.pathname.match(/\/c\/([a-zA-Z0-9_-]+)/);
    if (urlMatch) return '对话-' + urlMatch[1].slice(0, 8);
    
    return '未命名对话';
  }

  // 判断扩展上下文是否仍然有效（扩展被重载/卸载后 chrome.runtime.id 会变为 undefined）
  function isExtensionContextValid() {
    return typeof chrome !== 'undefined' &&
           !!chrome.runtime &&
           !!chrome.runtime.id;
  }

  // 扩展上下文失效时清理所有监听与定时器，避免持续报 "Extension context invalidated"
  function ensureContextValid() {
    if (isExtensionContextValid()) return true;
    console.warn('⚠️ 扩展上下文已失效（扩展可能已被重新加载），已停止所有监听');
    if (messageObserver) { messageObserver.disconnect(); messageObserver = null; }
    if (sendButtonObserver) { sendButtonObserver.disconnect(); sendButtonObserver = null; }
    if (urlCheckTimer) { clearInterval(urlCheckTimer); urlCheckTimer = null; }
    if (buttonCheckTimer) { clearInterval(buttonCheckTimer); buttonCheckTimer = null; }
    return false;
  }

  // ---------- 核心抓取逻辑 ----------
  function extractConversationPair() {
    if (isProcessing) return;
    isProcessing = true;

    try {
      // 1. 获取所有用户消息和 AI 消息
      const userEls = document.querySelectorAll(CONFIG.selectors.userMessage);
      const aiEls = document.querySelectorAll(CONFIG.selectors.aiMessage);

      if (userEls.length === 0 || aiEls.length === 0) {
        isProcessing = false;
        return;
      }

      // 2. 取最后一对（最新的对话）
      const lastUser = userEls[userEls.length - 1];
      const lastAI = aiEls[aiEls.length - 1];

      // 提取文本内容（DeepSeek 可能用 .markdown-body 包裹）
      const getUserText = (el) => {
        const contentEl = el.querySelector(CONFIG.selectors.contentArea);
        return (contentEl ? contentEl.textContent : el.textContent).trim();
      };

      const userText = getUserText(lastUser);
      const aiText = getUserText(lastAI);

      if (!userText || !aiText || userText.length < 1 || aiText.length < 1) {
        isProcessing = false;
        return;
      }

      // 3. 去重检查
      const hash = simpleHash(userText + aiText);
      if (hash === lastMessageHash) {
        isProcessing = false;
        return;
      }
      lastMessageHash = hash;

      // 4. 判断是否为新会话（超时或 URL 变化）
      const now = Date.now();
      if (now - lastActivityTime > CONFIG.sessionTimeout) {
        currentSessionId = generateSessionId();
      }
      lastActivityTime = now;

      // 5. 构建数据对象
      const conversationData = {
        id: hash,
        sessionId: currentSessionId,
        title: getConversationTitle(),
        user: userText,
        assistant: aiText,
        timestamp: now,
        url: window.location.href,
        // 提取消息数量作为元数据
        messageCount: userEls.length
      };

      // 6. 发送给 background 存储
      if (!isExtensionContextValid()) {
        console.warn('⚠️ 扩展上下文已失效，跳过本次记录');
        isProcessing = false;
        return;
      }
      chrome.runtime.sendMessage({
        type: 'SAVE_CONVERSATION',
        data: conversationData
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('发送消息失败:', chrome.runtime.lastError);
        } else {
          console.log('✅ 已记录对话:', userText.slice(0, 30) + '...');
        }
        isProcessing = false;
      });

    } catch (error) {
      console.error('提取对话失败:', error);
      isProcessing = false;
    }
  }

  // ---------- 监听 DOM 变化 ----------
  let debounceTimer = null;
  function handleDOMChange() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      extractConversationPair();
      debounceTimer = null;
    }, CONFIG.debounceDelay);
  }

  // ---------- 发送按钮识别与监听 ----------
  // 查找发送按钮（通过其特征 class，如 ds-button--icon-relative-m）
  function findSendButton() {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const cls = typeof btn.className === 'string' ? btn.className : '';
      if (CONFIG.sendButton.markerClasses.every(c => cls.includes(c))) {
        return btn;
      }
    }
    return null;
  }

  // 发送按钮是否为禁用状态（包含 ds-button--disabled）
  function isSendButtonDisabled(btn) {
    const cls = typeof btn.className === 'string' ? btn.className : '';
    return cls.includes(CONFIG.sendButton.disabledClass);
  }

  // 绑定发送按钮：监听点击 + class 变化
  function startSendButtonWatcher(btn) {
    if (sendButtonObserver) {
      sendButtonObserver.disconnect();
      sendButtonObserver = null;
    }
    sendButton = btn;
    let wasDisabled = isSendButtonDisabled(btn);
    console.log('🔘 已绑定发送按钮，初始禁用状态 =', wasDisabled);

    // 点击发送按钮
    btn.addEventListener('click', () => {
      console.log('📤 检测到点击发送按钮');
      onSendTriggered();
    });

    // 监听 class 变化（关键：ds-button--disabled 的增删）
    sendButtonObserver = new MutationObserver(() => {
      const isDisabled = isSendButtonDisabled(btn);
      if (isDisabled === wasDisabled) return;
      wasDisabled = isDisabled;
      if (isDisabled) {
        // 启用 -> 禁用：消息已发出（输入框被清空）
        console.log('📤 发送按钮变为禁用（消息已发送）');
        onSendTriggered();
      } else {
        // 禁用 -> 启用：用户已输入内容，准备发送
        console.log('✍️ 发送按钮变为可用（用户准备发送）');
        onUserReadyToSend();
      }
    });
    sendButtonObserver.observe(btn, { attributes: true, attributeFilter: ['class'] });
  }

  // 定期确保发送按钮已绑定（处理 SPA 切换 / 按钮重建）
  function ensureSendButtonWatcher() {
    const btn = findSendButton();
    if (!btn) return;
    if (!sendButton || !sendButton.isConnected) {
      startSendButtonWatcher(btn);
    }
  }

  // 用户触发了发送 → 启动 DOM 监听并立即抓取一次
  function onSendTriggered() {
    startMessageObserver();
    handleDOMChange();
  }

  // 用户输入内容、按钮变为可用 → 提前启动监听，确保不遗漏新消息
  function onUserReadyToSend() {
    startMessageObserver();
  }

  // 判断当前焦点是否在聊天输入框（用于回车发送检测）
  function isChatInputFocused() {
    const el = document.activeElement;
    if (!el) return false;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return true;
    return el.isContentEditable === true;
  }

  // ---------- 消息 DOM 监听 ----------
  // 启动对话 DOM 变化监听（幂等，只启动一次；由发送动作触发启动）
  function startMessageObserver() {
    if (messageObserver) return;
    console.log('👀 对话 DOM 监听已启动');
    
    const targetNode = document.querySelector(CONFIG.selectors.messageContainer) || document.body;
    
    messageObserver = new MutationObserver((mutations) => {
      // 检测是否有新的消息节点添加
      let hasNewMessage = false;
      for (const mutation of mutations) {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              // 检查是否包含消息特征
              if (node.matches && (node.matches(CONFIG.selectors.userMessage) || 
                  node.matches(CONFIG.selectors.aiMessage) ||
                  node.querySelector && (node.querySelector(CONFIG.selectors.userMessage) || 
                                       node.querySelector(CONFIG.selectors.aiMessage)))) {
                hasNewMessage = true;
                break;
              }
            }
          }
        }
        if (hasNewMessage) break;
      }
      
      if (hasNewMessage) {
        handleDOMChange();
      }
    });

    messageObserver.observe(targetNode, {
      childList: true,
      subtree: true
    });
  }

  // ---------- 监听页面 URL 变化（SPA 路由切换）----------
  let lastUrl = window.location.href;
  function checkUrlChange() {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      // URL 变化时重置会话 ID
      currentSessionId = generateSessionId();
      lastMessageHash = '';
      console.log('🔄 检测到页面切换，重置会话');
    }
  }

  // ---------- 初始化 ----------
  function init() {
    console.log('初始化');

    // 1. 绑定发送按钮：通过按钮 class 变化（ds-button--disabled 增删）决定是否监听 DOM
    ensureSendButtonWatcher();
    buttonCheckTimer = setInterval(() => {
      if (!ensureContextValid()) return;
      ensureSendButtonWatcher();
    }, CONFIG.buttonCheckInterval);

    // 2. 监听回车发送（焦点在聊天输入框时）
    document.addEventListener('keydown', (e) => {
      if (!isExtensionContextValid()) return;
      if (e.key === 'Enter' && !e.shiftKey && isChatInputFocused()) {
        console.log('📤 检测到回车发送');
        onSendTriggered();
      }
    });

    // 3. 监听 URL 变化（SPA）
    urlCheckTimer = setInterval(() => {
      if (!ensureContextValid()) return;
      checkUrlChange();
    }, 1000);

    // 4. 额外：监听 DeepSeek 的流式输出结束（通过检测"停止生成"按钮消失）
    const stopBtnObserver = new MutationObserver(() => {
      const stopBtn = document.querySelector('[class*="stop"], button[aria-label*="stop"]');
      if (!stopBtn && messageObserver) {
        // 停止按钮消失，说明 AI 回复完成，触发一次抓取
        handleDOMChange();
      }
    });
    // 稍后启动，等 DOM 稳定
    setTimeout(() => {
      const target = document.body;
      if (target) {
        stopBtnObserver.observe(target, { childList: true, subtree: true });
      }
    }, 3000);

    console.log('🚀 DeepSeek 复盘助手已初始化（用户发送消息后开始记录）');
  }

  // 启动
  init();

})();