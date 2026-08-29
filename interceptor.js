// interceptor.js
// 在页面主世界（MAIN world）拦截 DeepSeek 聊天接口：
//   目标接口: https://chat.deepseek.com/api/v0/chat/completion
//   请求参数: prompt 字段为对话问题
//   响应类型: text/event-stream; charset=utf-8，数据形如 {"v":"..."}
// 通过包装 window.fetch / XMLHttpRequest 捕获请求与流式响应，
// 解析出用户问题与 AI 回答后，发送给 background 存入 IndexedDB。
(function () {
  'use strict';

  const TARGET = '/api/v0/chat/completion';

  // 与隔离世界内容脚本（relay.js）通信的标识
  const BRIDGE_KEY = '__DEEPSEEK_EXT_RELAY__';

  // ---------- 工具函数 ----------
  function isTargetUrl(url) {
    return typeof url === 'string' && url.indexOf(TARGET) !== -1;
  }

  function tryParse(str) {
    if (typeof str !== 'string' || !str) return null;
    try { return JSON.parse(str); } catch (e) { return null; }
  }

  // 简单哈希（用于去重）
  function simpleHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h = ((h << 5) - h) + c;
      h = h & h;
    }
    return 'n' + Math.abs(h).toString(36);
  }

  function genId() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  // 发送数据：主世界脚本拿不到 chrome.* API，改用 window.postMessage
  // 发给隔离世界的 relay.js，由它转发给 background。
  function postToRelay(data) {
    try {
      window.postMessage({
        source: BRIDGE_KEY,
        type: 'SAVE_CONVERSATION',
        data: data
      }, '*');
    } catch (e) {
      console.warn('[DeepSeek拦截] postMessage 失败:', e);
    }
  }

  // ---------- SSE 响应解析 ----------
  // 把一条 content 追加到收集对象
  function appendContent(collected, type, content) {
    if (type === 'thinking') {
      collected.thinking += content;
    } else {
      collected.text += content;
    }
  }

  // 收集一条 data: 载荷。载荷可能是：
  //   - 直接 JSON: {"type":"text","content":"..."}
  //   - 包裹 JSON: {"v":"..."}  （v 内是嵌套 SSE / JSON 字符串 / 纯文本）
  //   - 纯文本
  function collectPayload(payload, collected) {
    if (!payload || payload === '[DONE]') return;
    const obj = tryParse(payload);
    if (!obj) {
      collected.text += payload; // 非 JSON，按纯文本内容处理
      return;
    }
    // {"v":"..."} 包裹格式
    if (typeof obj.v === 'string' && obj.v.length > 0) {
      collectV(obj.v, collected);
      return;
    }
    if (typeof obj.content === 'string') {
      appendContent(collected, obj.type, obj.content);
    }
  }

  // 递归解析 v 字段
  function collectV(v, collected) {
    // 嵌套 SSE：形如 "data: {...}\n\ndata: {...}"
    if (v.indexOf('data:') === 0 || /\ndata:/.test(v)) {
      const blocks = v.split(/\n\n+/);
      for (const block of blocks) {
        for (const line of block.split('\n')) {
          const t = line.trim();
          if (t.indexOf('data:') !== 0) continue;
          collectPayload(t.slice(5).trim(), collected);
        }
      }
      return;
    }
    const inner = tryParse(v);
    if (inner) {
      if (typeof inner.v === 'string' && inner.v.length > 0) {
        collectV(inner.v, collected);
        return;
      }
      if (typeof inner.content === 'string') {
        appendContent(collected, inner.type, inner.content);
        return;
      }
    }
    collected.text += v; // 纯文本内容
  }

  // 解析整段 SSE 原始文本，返回 { thinking, text }
  function parseStream(raw) {
    const collected = { thinking: '', text: '' };
    if (!raw) return collected;
    const blocks = raw.split(/\n\n+/);
    for (const block of blocks) {
      for (const line of block.split('\n')) {
        const t = line.trim();
        if (t.indexOf('data:') !== 0) continue;
        collectPayload(t.slice(5).trim(), collected);
      }
    }
    return collected;
  }

  // ---------- 请求体解析 ----------
  function parseRequestBody(body) {
    if (typeof body === 'string') return tryParse(body);
    return null;
  }

  // ---------- 组装并保存 ----------
  function saveFromNetwork(requestInfo, raw) {
    const { thinking, text } = parseStream(raw);
    const prompt = requestInfo && typeof requestInfo.prompt === 'string'
      ? requestInfo.prompt.trim()
      : '';

    const assistant = text.trim() || thinking.trim();
    if (!prompt && !assistant) return;

    const now = Date.now();
    const chatSessionId = (requestInfo && requestInfo.chat_session_id) || genId();

    const data = {
      id: simpleHash(prompt + '\u0000' + assistant),
      sessionId: chatSessionId,
      title: (requestInfo && requestInfo.title) || (prompt ? prompt.slice(0, 30) : '未命名对话'),
      user: prompt,
      assistant: assistant,
      thinking: thinking.trim(),
      timestamp: now,
      url: location.href,
      messageCount: 1,
      source: 'network'
    };

    console.log('[DeepSeek拦截] 捕获对话:',
      prompt.slice(0, 30) + '... => ' + assistant.slice(0, 30) + '...');
    postToRelay(data);
  }

  // 读取响应流（不干扰页面自身对响应体的消费）
  function readStream(response, onDone) {
    try {
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let raw = '';
      function pump() {
        return reader.read().then(({ done, value }) => {
          if (done) {
            onDone(raw);
            return;
          }
          raw += decoder.decode(value, { stream: true });
          return pump();
        });
      }
      pump().catch(() => onDone(raw));
    } catch (e) {
      console.warn('[DeepSeek拦截] 读取响应流失败:', e);
    }
  }

  // ---------- fetch 拦截 ----------
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = async function (input, init) {
      let url = '';
      if (typeof input === 'string') {
        url = input;
      } else if (input && typeof input.url === 'string') {
        url = input.url;
      }

      const isTarget = isTargetUrl(url);
      let requestInfo = null;
      if (isTarget) {
        requestInfo = parseRequestBody(init && init.body);
      }

      const response = await origFetch.apply(this, arguments);

      if (isTarget && response && response.ok && response.body) {
        readStream(response.clone(), (raw) => saveFromNetwork(requestInfo, raw));
      }

      return response;
    };
  }

  // ---------- XHR 拦截 ----------
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__dsUrl = url;
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (isTargetUrl(this.__dsUrl)) {
      const requestInfo = parseRequestBody(body);
      const xhr = this;
      xhr.addEventListener('load', function () {
        let raw = '';
        if (xhr.responseType === '' || xhr.responseType === 'text') {
          raw = xhr.responseText || '';
        }
        saveFromNetwork(requestInfo, raw);
      });
    }
    return origSend.apply(this, arguments);
  };

  console.log('[DeepSeek拦截] 已就绪，监听接口:', TARGET);
})();
