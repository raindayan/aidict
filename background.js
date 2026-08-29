// background.js
let db = null;

// 打开 IndexedDB
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('DeepSeekChatDB', 2);
    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains('conversations')) {
        const store = database.createObjectStore('conversations', { 
          keyPath: 'id' 
        });
        store.createIndex('timestamp', 'timestamp');
        store.createIndex('sessionId', 'sessionId');
        store.createIndex('title', 'title');
      }
    };
    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  });
}

// 保存对话
async function saveConversation(data) {
  try {
    if (!db) await openDB();
    
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['conversations'], 'readwrite');
      const store = transaction.objectStore('conversations');
      
      // 检查是否已存在
      const getRequest = store.get(data.id);
      getRequest.onsuccess = () => {
        if (getRequest.result) {
          // 已存在，更新（保留更完整的文本）
          const existing = getRequest.result;
          // 如果新文本更长，则更新
          if (data.user.length > existing.user.length || data.assistant.length > existing.assistant.length) {
            const putRequest = store.put(data);
            putRequest.onsuccess = () => resolve(data);
            putRequest.onerror = () => reject(putRequest.error);
          } else {
            resolve(existing);
          }
        } else {
          // 新增
          const putRequest = store.put(data);
          putRequest.onsuccess = () => resolve(data);
          putRequest.onerror = () => reject(putRequest.error);
        }
      };
    });
  } catch (error) {
    console.error('保存失败:', error);
  }
}

// 获取所有对话
async function getAllConversations() {
  try {
    if (!db) await openDB();
    
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['conversations'], 'readonly');
      const store = transaction.objectStore('conversations');
      const index = store.index('timestamp');
      const request = index.openCursor(null, 'prev'); // 按时间倒序
      
      const results = [];
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error('获取数据失败:', error);
    return [];
  }
}

// 删除单条对话
async function deleteConversation(id) {
  try {
    if (!db) await openDB();
    
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['conversations'], 'readwrite');
      const store = transaction.objectStore('conversations');
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error('删除失败:', error);
  }
}

// 清空所有
async function clearAll() {
  try {
    if (!db) await openDB();
    
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['conversations'], 'readwrite');
      const store = transaction.objectStore('conversations');
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error('清空失败:', error);
  }
}

// 广播数据更新通知（让已打开的侧边栏实时刷新）
function broadcastDataUpdated() {
  try {
    chrome.runtime.sendMessage({ type: 'DATA_UPDATED' }, () => {
      void chrome.runtime.lastError;
    });
  } catch (e) {
    // 忽略：无接收方或扩展上下文已失效
  }
}

// ---------- 消息监听 ----------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SAVE_CONVERSATION') {
    saveConversation(message.data)
      .then(() => {
        sendResponse({ success: true });
        broadcastDataUpdated();
      })
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true; // 异步响应
  }
  
  if (message.type === 'GET_ALL') {
    getAllConversations()
      .then((data) => sendResponse({ data }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message.type === 'DELETE_ONE') {
    deleteConversation(message.id)
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'CLEAR_ALL') {
    clearAll()
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }
});

// 初始化数据库
openDB().then(() => console.log('📦 DeepSeek 数据库已就绪'));