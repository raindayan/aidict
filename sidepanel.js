// sidepanel.js
let allData = [];

// 判断扩展上下文是否有效（扩展被重载后 chrome.runtime.id 变为 undefined）
function extensionValid() {
  return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
}

// ---------- 工具函数 ----------
function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleString('zh-CN', { 
    month: 'short', day: 'numeric', 
    hour: '2-digit', minute: '2-digit' 
  });
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toast._hide);
  toast._hide = setTimeout(() => toast.classList.remove('show'), 2000);
}

// ---------- 渲染列表 ----------
function renderConversations(data) {
  const container = document.getElementById('listContainer');
  const stats = document.getElementById('stats');
  
  if (!data || data.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="icon">🗂️</div>
        <p>还没有记录</p>
        <p style="font-size:12px;margin-top:4px;">在 DeepSeek 聊天中发消息后会自动记录</p>
      </div>
    `;
    stats.textContent = '共 0 条记录';
    return;
  }

  stats.textContent = `共 ${data.length} 条对话记录`;

  container.innerHTML = data.map(item => `
    <div class="conversation-item" data-id="${item.id}">
      <div class="meta">
        <span>${item.title || '未命名对话'}</span>
        <span>${formatTime(item.timestamp)}</span>
      </div>
      <div class="content-preview">
        <span class="label">👤 我：</span>${escapeHtml(item.user.slice(0, 100))}${item.user.length > 100 ? '...' : ''}<br>
        <span class="label">🤖 AI：</span>${escapeHtml(item.assistant.slice(0, 120))}${item.assistant.length > 120 ? '...' : ''}
      </div>
      <div class="actions">
        <button class="btn-sm copy" data-action="copy" data-id="${item.id}">📋 复制</button>
        <button class="btn-sm delete" data-action="delete" data-id="${item.id}">🗑️ 删除</button>
        <button class="btn-sm" data-action="view" data-id="${item.id}">👁️ 查看完整</button>
      </div>
    </div>
  `).join('');

  // 绑定事件（委托）
  container.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      const item = allData.find(d => d.id === id);
      if (!item) return;

      if (action === 'copy') {
        const text = `用户：${item.user}\n\nAI：${item.assistant}`;
        navigator.clipboard.writeText(text).then(() => {
          showToast('✅ 已复制到剪贴板');
        });
      } else if (action === 'delete') {
        if (confirm('确定删除这条对话吗？')) {
          if (!extensionValid()) return;
          chrome.runtime.sendMessage({ type: 'DELETE_ONE', id }, (res) => {
            if (res.success) {
              showToast('已删除');
              loadData();
            }
          });
        }
      } else if (action === 'view') {
        // 弹窗显示完整内容
        alert(`👤 用户：\n${item.user}\n\n🤖 AI：\n${item.assistant}`);
      }
    });
  });
}

// 简单防 XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ---------- 加载数据 ----------
function loadData() {
  if (!extensionValid()) return;
  chrome.runtime.sendMessage({ type: 'GET_ALL' }, (response) => {
    if (response && response.data) {
      allData = response.data;
      // 搜索过滤
      const keyword = document.getElementById('searchInput').value.trim().toLowerCase();
      let filtered = allData;
      if (keyword) {
        filtered = allData.filter(item => 
          item.user.toLowerCase().includes(keyword) || 
          item.assistant.toLowerCase().includes(keyword)
        );
      }
      renderConversations(filtered);
    } else {
      renderConversations([]);
    }
  });
}

// ---------- 导出功能 ----------
function exportData() {
  if (allData.length === 0) {
    showToast('没有数据可导出');
    return;
  }
  
  // 生成 Markdown 格式
  let md = `# DeepSeek 对话复盘\n\n> 导出时间：${new Date().toLocaleString()}\n> 共 ${allData.length} 条对话\n\n---\n\n`;
  
  allData.forEach((item, index) => {
    md += `## ${index + 1}. ${item.title || '未命名对话'}\n`;
    md += `- 时间：${formatTime(item.timestamp)}\n`;
    md += `\n**👤 用户：**\n${item.user}\n\n`;
    md += `**🤖 AI：**\n${item.assistant}\n\n`;
    md += `---\n\n`;
  });

  // 下载
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `DeepSeek复盘_${new Date().toISOString().slice(0,10)}.md`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('📥 导出成功');
}

// ---------- 清空 ----------
function clearAll() {
  if (!confirm('确定要删除所有对话记录吗？此操作不可撤销！')) return;
  if (!extensionValid()) return;
  chrome.runtime.sendMessage({ type: 'CLEAR_ALL' }, (res) => {
    if (res.success) {
      showToast('已清空所有记录');
      loadData();
    }
  });
}

// ---------- 初始化 ----------
document.addEventListener('DOMContentLoaded', () => {
  loadData();

  // 搜索防抖
  const searchInput = document.getElementById('searchInput');
  let searchTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadData, 300);
  });

  document.getElementById('exportBtn').addEventListener('click', exportData);
  document.getElementById('clearAllBtn').addEventListener('click', clearAll);
});

// 监听数据更新（从 content script 发来的通知）
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'DATA_UPDATED') {
    loadData();
  }
});