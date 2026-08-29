// adapters/doubao.js - 豆包适配器（MAIN world）
// 接口: https://www.doubao.com/chat/completion
// 请求: JSON，client_meta.conversation_id = 会话，messages[].content_block[].text_block.text = 问题
// 响应: text/event-stream，按 event 字段区分：
//   SSE_HEARTBEAT     -> 心跳，忽略
//   SSE_ACK           -> ack_client_meta.conversation_id（会话 ID）
//   FULL_MSG_NOTIFY   -> message.content（用户问题的 content_block 数组，JSON 字符串）
//   STREAM_MSG_NOTIFY -> content.content_block[].text_block.text（AI 回答首 token）
//   STREAM_CHUNK      -> patch_op[].patch_value.content_block[].text_block.text（正文块增量）
//   CHUNK_DELTA       -> data.text（AI 回答文本增量，保留 markdown）
//   注意: STREAM_CHUNK 里的 tts_content 与 CHUNK_DELTA 内容重复，须忽略，避免重复
(function () {
  'use strict';

  const NS = window.__CHAT_CAPTURE__;
  if (!NS) return;

  const TARGET = '/chat/completion';
  const HOST = 'doubao.com';

  function tryParse(str) {
    if (typeof str !== 'string' || !str) return null;
    try { return JSON.parse(str); } catch (e) { return null; }
  }

  // 从 content_block 数组里收集文本（block.content.text_block.text）
  function collectBlocksText(blocks) {
    if (!Array.isArray(blocks)) return '';
    let text = '';
    for (const b of blocks) {
      const t = b && b.content && b.content.text_block && b.content.text_block.text;
      if (typeof t === 'string') text += t;
    }
    return text;
  }

  // 解析豆包 SSE 响应
  function parseDoubaoSSE(raw) {
    const result = { user: '', text: '', sessionId: '' };
    if (!raw) return result;

    const events = raw.split(/\n\n+/);
    for (const evt of events) {
      let event = '';
      let data = '';
      for (const line of evt.split('\n')) {
        const t = line.trim();
        if (t.indexOf('event:') === 0) event = t.slice(6).trim();
        else if (t.indexOf('data:') === 0) data += t.slice(5).trim();
      }
      if (!data) continue;

      if (event === 'SSE_ACK') {
        const obj = tryParse(data);
        const convId = obj && obj.ack_client_meta && obj.ack_client_meta.conversation_id;
        if (typeof convId === 'string' && convId) result.sessionId = convId;
      } else if (event === 'FULL_MSG_NOTIFY') {
        const obj = tryParse(data);
        const msg = obj && obj.message;
        if (!msg) continue;
        let user = '';
        if (typeof msg.content === 'string') {
          user = collectBlocksText(tryParse(msg.content));
        } else if (Array.isArray(msg.content_block)) {
          user = collectBlocksText(msg.content_block);
        }
        if (user) result.user = user;
      } else if (event === 'CHUNK_DELTA') {
        // AI 回答的文本增量（保留 markdown）
        const obj = tryParse(data);
        if (obj && typeof obj.text === 'string') result.text += obj.text;
      } else if (event === 'STREAM_MSG_NOTIFY') {
        // 首个 token 可能携带在 content_block 里
        const obj = tryParse(data);
        if (obj && obj.content && Array.isArray(obj.content.content_block)) {
          result.text += collectBlocksText(obj.content.content_block);
        }
      } else if (event === 'STREAM_CHUNK') {
        // 正文块（content_block）与 TTS（tts_content）都会出现在这里，
        // 只取 content_block 的 text_block.text，忽略 tts_content，避免重复
        const obj = tryParse(data);
        if (obj && Array.isArray(obj.patch_op)) {
          for (const op of obj.patch_op) {
            result.text += collectBlocksText(op && op.patch_value && op.patch_value.content_block);
          }
        }
      }
    }
    return result;
  }

  NS.registerAdapter({
    name: 'doubao',
    matches(url) {
      return typeof url === 'string' &&
        url.indexOf(TARGET) !== -1 &&
        url.indexOf(HOST) !== -1;
    },
    // 请求侧提取：
    //   client_meta.conversation_id           -> 会话 ID
    //   messages[].content_block[].text_block.text -> 用户问题
    // 响应侧（SSE）仍会回显用户问题与会话 ID，二者可交叉校验。
    parseRequest(body, json) {
      if (!json) return {};
      let prompt = '';
      if (Array.isArray(json.messages)) {
        for (const m of json.messages) {
          prompt += collectBlocksText(m && m.content_block);
        }
      }
      const convId = json.client_meta && json.client_meta.conversation_id;
      return {
        prompt: prompt,
        sessionId: typeof convId === 'string' ? convId : ''
      };
    },
    parseResponse(raw) {
      const { user, text, sessionId } = parseDoubaoSSE(raw);
      return { user, text, sessionId };
    }
  });
})();
