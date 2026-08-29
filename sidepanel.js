// sidepanel.js
let allData = [];
let currentPlatform = 'all';

const PLATFORM_META = {
  deepseek: { label: 'DeepSeek', icon: '🤖' },
  doubao: { label: '豆包', icon: '🫘' }
};

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
function platformBadge(platform) {
  const meta = PLATFORM_META[platform];
  if (!meta) return '';
  return `<span class="platform-badge ${escapeHtml(platform)}">${meta.icon} ${escapeHtml(meta.label)}</span>`;
}

function renderConversations(data, statsText) {
  const container = document.getElementById('listContainer');
  const stats = document.getElementById('stats');
  
  if (!data || data.length === 0) {
    const isEmpty = !allData || allData.length === 0;
    container.innerHTML = `
      <div class="empty-state">
        <div class="icon">${isEmpty ? '🗂️' : '🔍'}</div>
        <p>${isEmpty ? '还没有记录' : '没有符合条件的记录'}</p>
        ${isEmpty ? '<p style="font-size:12px;margin-top:4px;">在 AI 聊天中发消息后会自动记录</p>' : ''}
      </div>
    `;
    stats.textContent = statsText || '共 0 条记录';
    return;
  }

  stats.textContent = statsText || `共 ${data.length} 条对话记录`;

  container.innerHTML = data.map(item => `
    <div class="conversation-item" data-id="${item.id}">
      <div class="meta">
        <span class="meta-left">${platformBadge(item.platform)}<span>${escapeHtml(item.title || '未命名对话')}</span></span>
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
        // 弹窗渲染 Markdown 查看完整内容
        openViewModal(item);
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

// ---------- 轻量 Markdown 渲染（无第三方依赖） ----------
// 行内格式：行内代码、粗体、斜体、链接
function inlineFormat(text) {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}

// 把 Markdown 文本渲染成 HTML（支持标题/列表/代码块/引用/分隔线等）
function renderMarkdown(src) {
  if (!src) return '';
  const lines = String(src).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let listType = null;
  let para = [];

  function flushPara() {
    if (para.length) {
      out.push('<p>' + para.map(inlineFormat).join('<br>') + '</p>');
      para = [];
    }
  }
  function closeList() {
    if (listType) { out.push('</' + listType + '>'); listType = null; }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();

    // 围栏代码块 ```
    if (t.startsWith('```')) {
      flushPara(); closeList();
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      out.push('<pre><code>' + escapeHtml(codeLines.join('\n')) + '</code></pre>');
      continue;
    }

    // 空行：结束段落与列表
    if (t === '') { flushPara(); closeList(); continue; }

    // 标题
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara(); closeList();
      const level = h[1].length;
      out.push('<h' + level + '>' + inlineFormat(h[2]) + '</h' + level + '>');
      continue;
    }

    // 分隔线
    if (/^(-{3,}|\*{3,})$/.test(t)) {
      flushPara(); closeList();
      out.push('<hr>');
      continue;
    }

    // 引用
    if (t.startsWith('>')) {
      flushPara(); closeList();
      out.push('<blockquote>' + inlineFormat(t.replace(/^>\s?/, '')) + '</blockquote>');
      continue;
    }

    // 无序列表
    if (/^[-*+]\s+/.test(t)) {
      flushPara();
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
      out.push('<li>' + inlineFormat(t.replace(/^[-*+]\s+/, '')) + '</li>');
      continue;
    }

    // 有序列表
    if (/^\d+[.)]\s+/.test(t)) {
      flushPara();
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
      out.push('<li>' + inlineFormat(t.replace(/^\d+[.)]\s+/, '')) + '</li>');
      continue;
    }

    // 普通段落
    para.push(t);
  }

  flushPara();
  closeList();
  return out.join('\n');
}

// ---------- Markdown 查看弹窗 ----------
function openViewModal(item) {
  document.getElementById('viewModalTitle').textContent = item.title || '对话详情';
  document.getElementById('viewModalBody').innerHTML = `
    <div class="markdown-body">
      <p class="md-label">👤 用户</p>
      ${renderMarkdown(item.user)}
      <hr>
      <p class="md-label">🤖 AI</p>
      ${renderMarkdown(item.assistant)}
    </div>
  `;
  document.getElementById('viewModal').style.display = 'flex';
}

function closeViewModal() {
  document.getElementById('viewModal').style.display = 'none';
}

// ---------- 加载数据 ----------
function loadData() {
  if (!extensionValid()) return;
  chrome.runtime.sendMessage({ type: 'GET_ALL' }, (response) => {
    if (response && response.data) {
      allData = response.data;
      const keyword = document.getElementById('searchInput').value.trim().toLowerCase();
      let filtered = allData;
      if (currentPlatform !== 'all') {
        filtered = filtered.filter(item => item.platform === currentPlatform);
      }
      if (keyword) {
        filtered = filtered.filter(item => 
          item.user.toLowerCase().includes(keyword) || 
          item.assistant.toLowerCase().includes(keyword)
        );
      }

      const ds = allData.filter(i => i.platform === 'deepseek').length;
      const db = allData.filter(i => i.platform === 'doubao').length;
      const statsText = currentPlatform === 'all'
        ? `共 ${allData.length} 条记录 · DeepSeek ${ds} · 豆包 ${db}`
        : `共 ${filtered.length} 条记录`;

      renderConversations(filtered, statsText);
    } else {
      renderConversations([], '共 0 条记录');
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
  let md = `# AI 对话复盘\n\n> 导出时间：${new Date().toLocaleString()}\n> 共 ${allData.length} 条对话\n\n---\n\n`;
  
  allData.forEach((item, index) => {
    const meta = PLATFORM_META[item.platform];
    const platformLabel = meta ? `${meta.icon} ${meta.label}` : '未知';
    md += `## ${index + 1}. ${item.title || '未命名对话'}\n`;
    md += `- 平台：${platformLabel}\n`;
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
  a.download = `AI对话复盘_${new Date().toISOString().slice(0,10)}.md`;
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

  // 平台筛选
  document.querySelectorAll('#filterTabs .filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#filterTabs .filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentPlatform = btn.dataset.platform;
      loadData();
    });
  });

  // Markdown 弹窗关闭
  document.getElementById('viewModalClose').addEventListener('click', closeViewModal);
  document.getElementById('viewModal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeViewModal();
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