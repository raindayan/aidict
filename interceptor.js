// interceptor.js
// 通用网络拦截层（在页面主世界 MAIN world 运行）。
// 统一包装 window.fetch / XMLHttpRequest，按请求 URL 路由到平台适配器，
// 由适配器解析出对话数据，再通过 window.postMessage 桥接给隔离世界的 relay.js。
//
// 新增平台时：只需在 adapters/ 目录下新增一个适配器文件，
// 并在 manifest.json 的 matches 与 js 数组里注册即可，本文件无需改动。
(function () {
  'use strict';

  // 与隔离世界内容脚本（relay.js）通信的标识
  const BRIDGE_KEY = '__CHAT_CAPTURE_RELAY__';
  // 暴露给适配器文件使用的全局命名空间（主世界共享 window）
  const NAMESPACE = '__CHAT_CAPTURE__';

  // ---------- 适配器注册表 ----------
  const adapters = [];

  function registerAdapter(adapter) {
    if (adapter && typeof adapter.matches === 'function') {
      adapters.push(adapter);
      console.log('[AI对话拦截] 已注册适配器:', adapter.name);
    }
  }

  function findAdapter(url) {
    for (const a of adapters) {
      if (a.matches(url)) return a;
    }
    return null;
  }

  // ---------- 工具函数 ----------
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
  function postToRelay(data) {
    try {
      window.postMessage({
        source: BRIDGE_KEY,
        type: 'SAVE_CONVERSATION',
        data: data
      }, '*');
    } catch (e) {
      console.warn('[AI对话拦截] postMessage 失败:', e);
    }
  }

  // 暴露注册接口给适配器文件
  window[NAMESPACE] = { registerAdapter };

  // ---------- 统一组装对话记录 ----------
  // 适配器接口约定：
  //   name: string
  //   matches(url): boolean
  //   parseRequest(body, json)?: { prompt?, sessionId?, title? }
  //   parseResponse(raw): { user?, text?, thinking?, sessionId?, title? }
  function buildRecord(adapter, reqInfo, resInfo) {
    const user = (resInfo.user || reqInfo.prompt || '').trim();
    const assistant = (resInfo.text || resInfo.thinking || '').trim();
    if (!user && !assistant) return null;

    const now = Date.now();
    return {
      id: simpleHash(user + '\u0000' + assistant),
      sessionId: resInfo.sessionId || reqInfo.sessionId || genId(),
      title: resInfo.title || reqInfo.title || (user ? user.slice(0, 30) : '未命名对话'),
      user: user,
      assistant: assistant,
      thinking: (resInfo.thinking || '').trim(),
      timestamp: now,
      url: location.href,
      messageCount: 1,
      source: 'network',
      platform: adapter.name
    };
  }

  // 处理一次捕获到的「请求 + 响应」，交给适配器解析并保存
  function handleCapture(adapter, body, raw) {
    try {
      const json = (typeof body === 'string') ? tryParse(body) : null;
      const reqInfo = (adapter.parseRequest && adapter.parseRequest(body, json)) || {};
      const resInfo = (adapter.parseResponse && adapter.parseResponse(raw)) || {};
      const record = buildRecord(adapter, reqInfo, resInfo);
      if (!record) return;
      console.log('[' + adapter.name + '] 捕获对话:',
        record.user.slice(0, 30) + '... => ' + record.assistant.slice(0, 30) + '...');
      postToRelay(record);
    } catch (e) {
      console.warn('[AI对话拦截] 解析失败:', e);
    }
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
      console.warn('[AI对话拦截] 读取响应流失败:', e);
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

      const adapter = findAdapter(url);
      const body = (adapter && init && init.body) || null;

      const response = await origFetch.apply(this, arguments);

      if (adapter && response && response.ok && response.body) {
        readStream(response.clone(), (raw) => handleCapture(adapter, body, raw));
      }

      return response;
    };
  }

  // ---------- XHR 拦截 ----------
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__chatCaptureUrl = url;
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const adapter = findAdapter(this.__chatCaptureUrl);
    if (adapter) {
      const xhr = this;
      xhr.addEventListener('load', function () {
        let raw = '';
        if (xhr.responseType === '' || xhr.responseType === 'text') {
          raw = xhr.responseText || '';
        }
        handleCapture(adapter, body, raw);
      });
    }
    return origSend.apply(this, arguments);
  };

  console.log('[AI对话拦截] 已就绪');
})();
