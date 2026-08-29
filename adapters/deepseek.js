// adapters/deepseek.js - DeepSeek 适配器（MAIN world）
// 接口: https://chat.deepseek.com/api/v0/chat/completion
// 请求: JSON，prompt 字段为问题，chat_session_id 为会话 ID
// 响应: text/event-stream，data 形如 {"v":"..."}（v 内是嵌套 SSE / JSON / 纯文本）
(function () {
  'use strict';

  const NS = window.__CHAT_CAPTURE__;
  if (!NS) return;

  const TARGET = '/api/v0/chat/completion';

  function tryParse(str) {
    if (typeof str !== 'string' || !str) return null;
    try { return JSON.parse(str); } catch (e) { return null; }
  }

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
  //   - 包裹 JSON: {"v":"..."}
  //   - 纯文本
  function collectPayload(payload, collected) {
    if (!payload || payload === '[DONE]') return;
    const obj = tryParse(payload);
    if (!obj) {
      collected.text += payload; // 非 JSON，按纯文本内容处理
      return;
    }
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

  NS.registerAdapter({
    name: 'deepseek',
    matches(url) {
      return typeof url === 'string' && url.indexOf(TARGET) !== -1;
    },
    parseRequest(body, json) {
      if (!json) return {};
      return {
        prompt: typeof json.prompt === 'string' ? json.prompt.trim() : '',
        sessionId: typeof json.chat_session_id === 'string' ? json.chat_session_id : '',
        title: typeof json.title === 'string' ? json.title : ''
      };
    },
    parseResponse(raw) {
      const { thinking, text } = parseStream(raw);
      return { thinking, text };
    }
  });
})();
