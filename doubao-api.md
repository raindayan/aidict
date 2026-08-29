# 豆包（Doubao）对话接口说明

> 本文档记录豆包网页版对话接口 `https://www.doubao.com/chat/completion` 的请求与响应格式，
> 供 `adapters/doubao.js` 适配器维护参考。

## 一、概述

- **请求**：`POST`，`Content-Type: application/json`
- **响应**：`text/event-stream`（SSE），按 `event:` 字段分帧
- **帧结构**：每帧由 `id:`、`event:`、`data:` 三行组成（`data:` 为 JSON），帧与帧之间用空行分隔

示例帧：

```
id: 9
event: CHUNK_DELTA
data: {"text":"长上下文，**别信"}
```

## 二、请求格式（JSON）

| 字段 | 说明 |
|---|---|
| `client_meta.conversation_id` | 会话 ID |
| `client_meta.bot_id` | 机器人 ID |
| `client_meta.last_section_id` | 上一个 section ID |
| `client_meta.last_message_index` | 上一条消息序号 |
| `messages[]` | 本次要发送的消息列表 |
| `messages[].content_block[].content.text_block.text` | 用户问题文本 |
| `option.need_deep_think` | 是否深度思考 |
| `option.is_regen` / `is_replace` | 是否重新生成 / 替换 |
| `option.sse_recv_event_options.support_chunk_delta` | 是否启用 CHUNK_DELTA 增量通道 |

> 注：请求 URL 的查询串里还有 `aid`、`device_id`、`msToken`、`a_bogus` 等反爬/设备元数据，不含对话内容。

## 三、响应事件总览

| 事件 | 作用 | 关键字段 |
|---|---|---|
| `SSE_HEARTBEAT` | 心跳保活 | `{}`（空） |
| `SSE_ACK` | 请求回执，返回会话/问题 ID | `ack_client_meta.conversation_id`、`query_list[].question_id` |
| `FULL_MSG_NOTIFY` | 用户消息完整回显 | `message.content` / `message.content_block` |
| `STREAM_MSG_NOTIFY` | AI 回复消息通知（首 token 或加载状态） | `content.content_block[]` |
| `STREAM_CHUNK` | 流式增量块（正文 / TTS / 扩展信息） | `patch_op[].patch_value` |
| `CHUNK_DELTA` | 文本增量（markdown 原文） | `data.text` |
| `SSE_REPLY_END` | 回复结束 | `end_type`、`msg_finish_attr.brief` |

## 四、各事件详解

### 1. `SSE_HEARTBEAT` —— 心跳保活

维持连接不断开，无业务数据。

```json
data: {}
```

### 2. `SSE_ACK` —— 请求回执

服务端确认收到请求，并回传会话与问题标识。**会话 ID 从这里拿最可靠。**

```json
{
  "query_list": [{ "question_id": "53900832616483586", "local_message_id": "...", "message_index": 16 }],
  "ack_client_meta": {
    "conversation_id": "38439319323713794",
    "conversation_type": 3,
    "section_id": "38439319323714050"
  },
  "timeout_conf": { "answer_first_pending_time": 180000, "max_retry_count": 10 }
}
```

| 字段 | 作用 |
|---|---|
| `query_list[].question_id` | 本次问题的 ID |
| `query_list[].local_message_id` | 客户端消息 ID |
| `ack_client_meta.conversation_id` | 会话 ID（重要） |
| `ack_client_meta.section_id` | section ID |
| `timeout_conf` | 超时/重试配置 |

### 3. `FULL_MSG_NOTIFY` —— 用户消息完整回显

服务端把用户刚发送的消息完整回显出来。**用户问题从这里拿最可靠**（也可从请求侧 `messages` 拿，二者交叉校验）。

```json
{
  "message": {
    "conversation_id": "38439319323713794",
    "message_id": "53900832616483586",
    "content": "[{\"block_type\":10000,\"content\":{\"text_block\":{\"text\":\"给我一个短回答\"}}}]",
    "content_block": [{ "block_type": 10000, "content": { "text_block": { "text": "给我一个短回答" } } }]
  }
}
```

| 字段 | 作用 |
|---|---|
| `message.conversation_id` | 会话 ID |
| `message.message_id` | 用户消息 ID |
| `message.content` | 内容块数组的 JSON 字符串 |
| `message.content_block` | 已解析的内容块数组（更易读） |

### 4. `STREAM_MSG_NOTIFY` —— AI 回复消息通知

宣告 AI 回复开始，携带**首个 token**（普通回复）或**加载状态块**（如联网搜索时）。

```json
{
  "content": {
    "content_block": [
      { "block_type": 10000, "content": { "text_block": { "text": "判断" } }, "is_finish": false }
    ],
    "content_status": 100
  },
  "meta": { "message_id": "53900832616488706", "conversation_id": "...", "bot_reply_message_id": "..." }
}
```

联网搜索时的加载块（`block_type: 10101`）：

```json
{ "block_type": 10101, "content": { "loading_block": { "text_loading": { "text": "正在搜索" } } } }
```

### 5. `STREAM_CHUNK` —— 流式增量块

AI 回复的增量更新，`patch_op[]` 里按 `patch_object` 区分三种用途：

| patch_object | 用途 | 内容位置 |
|---|---|---|
| `1` | 正文内容块 | `patch_value.content_block[].content.text_block.text` |
| `111` | TTS 语音文本（与正文重复） | `patch_value.tts_content` |
| `50` | 扩展元数据（耗时/建议等） | `patch_value.ext` |

```json
{
  "message_id": "53900832616488706",
  "patch_op": [
    {
      "patch_object": 1,
      "patch_type": 1,
      "patch_value": {
        "content_block": [
          { "block_type": 10000, "content": { "text_block": { "text": "AI" } }, "is_finish": false }
        ]
      }
    }
  ]
}
```

### 6. `CHUNK_DELTA` —— 文本增量（markdown 原文）

**AI 回答文本的主体来源**，逐段下发，保留 markdown 语法（加粗、列表、引用等）。

```json
data: {"text":"长上下文，**别信"}
```

### 7. `SSE_REPLY_END` —— 回复结束

标记回复结束，`end_type` 区分阶段：

| end_type | 含义 |
|---|---|
| `1` | 正文结束，`msg_finish_attr.brief` 为**截断摘要**（不含末尾引用段，不可当完整回答） |
| `2` | 附加信息结束（`answer_finish_attr.has_suggest`） |
| `3` | 整个回复结束 |

```json
{ "end_type": 1, "msg_finish_attr": { "msgid": "...", "brief": "判断AI长上下文…" } }
```

## 五、content_block 类型

| block_type | 类型 | content 结构 | 说明 |
|---|---|---|---|
| `10000` | 文本块 | `content.text_block.text` | 用户问题 / AI 回答正文 |
| `10101` | 加载/状态块 | `content.loading_block.text_loading.text` | "正在搜索"、"找到 N 篇资料" |

## 六、patch_op 字段

| 字段 | 说明 |
|---|---|
| `patch_object` | 补丁目标：`1`=正文，`111`=TTS，`50`=扩展元数据 |
| `patch_type` | 补丁类型：`1`=追加，`2`=更新/替换（观测到空 `patch_value`） |
| `patch_value.content_block[]` | 正文内容块 |
| `patch_value.tts_content` | TTS 文本（与 `CHUNK_DELTA` 重复，需忽略） |

## 七、适配器提取映射

| 需要的数据 | 来源事件 / 请求 | 字段 |
|---|---|---|
| 用户问题 | `FULL_MSG_NOTIFY`（响应回显） | `message.content` 解析后的 `text_block.text` |
| 用户问题（兜底） | 请求 `messages[]` | `content_block[].content.text_block.text` |
| 会话 ID | `SSE_ACK` | `ack_client_meta.conversation_id` |
| 会话 ID（兜底） | 请求 `client_meta` | `conversation_id` |
| AI 回答 | `STREAM_MSG_NOTIFY` + `STREAM_CHUNK` + `CHUNK_DELTA` | `text_block.text` 与 `data.text` 按事件顺序拼接 |

## 八、注意事项（坑）

1. **`tts_content` 与 `CHUNK_DELTA` 内容重复**：`STREAM_CHUNK` 的 `patch_value.tts_content` 是 TTS 回显，与 `CHUNK_DELTA` 的 `data.text` 相同，必须忽略其一，否则回答会重复。
2. **结束标记为空文本块**：`STREAM_CHUNK` 结束时会下发 `text_block: {}`（`is_finish: true`），解析时天然取不到 `text`，跳过即可。
3. **`SSE_REPLY_END` 的 `brief` 是截断摘要**：不含末尾的引用段落（`>` 引用内容），不能当作完整回答使用。
4. **联网搜索有加载块**：`block_type: 10101` 的 `loading_block` 是"正在搜索/找到 N 篇资料"的状态提示，不是回答正文，解析 `text_block.text` 时会自然跳过。
