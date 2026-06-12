// 通用UI工具函数

// 显示加载overlay
function showLoading() {
  let overlay = document.getElementById('globalLoadingOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'globalLoadingOverlay';
    overlay.className = 'loading-overlay';
    overlay.innerHTML = '<div class="loading-spinner"></div>';
    document.body.appendChild(overlay);
  }
  overlay.style.display = 'flex';
}

// 隐藏加载overlay
function hideLoading() {
  const overlay = document.getElementById('globalLoadingOverlay');
  if (overlay) {
    overlay.style.display = 'none';
  }
}

// 显示Toast提示
function showToast(message, type = 'info', duration = 3000) {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const titles = {
    success: '✅ 成功',
    error: '❌ 错误',
    warning: '⚠️ 警告',
    info: 'ℹ️ 提示'
  };

  toast.innerHTML = `
    <div class="toast-title">${titles[type] || '提示'}</div>
    <div class="toast-message">${escapeHtml(message)}</div>
  `;

  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'slideIn 0.3s ease-out reverse';
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 300);
  }, duration);
}

// 按钮加载状态
function setButtonLoading(button, loading) {
  if (loading) {
    button.disabled = true;
    button.classList.add('loading');
    button.setAttribute('data-original-html', button.innerHTML);
  } else {
    button.disabled = false;
    button.classList.remove('loading');
    const originalHtml = button.getAttribute('data-original-html');
    if (originalHtml) {
      button.innerHTML = originalHtml;
      button.removeAttribute('data-original-html');
    }
  }
}

// 确认对话框
function confirm(message) {
  return window.confirm(message);
}

// 防抖函数
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// 节流函数
function throttle(func, limit) {
  let inThrottle;
  return function(...args) {
    if (!inThrottle) {
      func.apply(this, args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  };
}

// HTML转义（如果common.js中没有）
if (typeof escapeHtml === 'undefined') {
  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }
}
