async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text || '响应错误' };
  }
  if (!res.ok) {
    const err = new Error(data && data.error ? data.error : res.statusText);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function getMe() {
  const data = await api('/api/me');
  return data.user;
}

function requireAuthPage(user) {
  if (!user) {
    window.location.href = '/index.html';
  }
}

function formatTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

const TASK_CONTROL_DEFAULT = {
  mailLocked: false,
  chatLocked: false,
  spaceLocked: false,
  evalLesson1Locked: false,
  evalLesson2Locked: false,
  evalLesson3Locked: false,
  updatedAt: null,
  updatedBy: null,
};

let taskControlState = { ...TASK_CONTROL_DEFAULT };
let taskControlListeners = [];
let taskControlInited = false;
let taskControlSocket = null;
let taskControlPollTimer = null;
let taskControlClickBound = false;

function normalizeTaskControl(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    mailLocked: !!s.mailLocked,
    chatLocked: !!s.chatLocked,
    spaceLocked: !!s.spaceLocked,
    evalLesson1Locked: !!s.evalLesson1Locked,
    evalLesson2Locked: !!s.evalLesson2Locked,
    evalLesson3Locked: !!s.evalLesson3Locked,
    updatedAt: s.updatedAt || null,
    updatedBy: s.updatedBy || null,
  };
}

function getTaskControlState() {
  return { ...taskControlState };
}

function isTaskLockedByControl(taskKey, state = taskControlState) {
  if (taskKey === 'mail') return !!state.mailLocked;
  if (taskKey === 'chat') return !!state.chatLocked;
  if (taskKey === 'space') return !!state.spaceLocked;
  if (taskKey === 'evaluate') return !!state.evalLesson1Locked && !!state.evalLesson2Locked && !!state.evalLesson3Locked;
  return false;
}

function isEvaluationLessonLocked(lessonIndex, state = taskControlState) {
  if (lessonIndex === 1) return !!state.evalLesson1Locked;
  if (lessonIndex === 2) return !!state.evalLesson2Locked;
  if (lessonIndex === 3) return !!state.evalLesson3Locked;
  return false;
}

function taskLockReason(taskKey) {
  if (taskKey === 'mail') return '第1课（书信）已锁定';
  if (taskKey === 'chat') return '第2课（茶话）已锁定';
  if (taskKey === 'space') return '第3课（展厅）已锁定';
  if (taskKey === 'evaluate') return '评价任务已锁定';
  return '当前任务已锁定';
}

function showTaskLockedPrompt(reason) {
  return;
}

function updateTaskCardLockMask(el, locked) {
  if (!el || !el.classList || !el.classList.contains('feature-card')) return;
  let mask = el.querySelector('.task-card-lock-mask');
  if (locked) {
    if (!mask) {
      mask = document.createElement('div');
      mask.className = 'task-card-lock-mask';
      mask.innerHTML = '<div class="task-card-lock-icon">🔒</div><div class="task-card-lock-text">当前任务已锁定</div>';
      el.appendChild(mask);
    }
  } else if (mask) {
    mask.remove();
  }
}

function resolveTaskKeyByHref(href) {
  if (!href || href.startsWith('#')) return null;
  try {
    const url = new URL(href, window.location.origin);
    const pathname = url.pathname.toLowerCase();
    if (pathname.endsWith('/mail.html')) return 'mail';
    if (pathname.endsWith('/chat.html')) return 'chat';
    if (pathname.endsWith('/space.html')) return 'space';
    if (pathname.endsWith('/evaluate.html')) return 'evaluate';
  } catch {}
  return null;
}

function setElementLocked(el, locked, reason) {
  if (!el) return;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'A') {
    if (locked) {
      el.classList.add('task-locked-link');
      el.setAttribute('aria-disabled', 'true');
      el.dataset.tcLocked = '1';
      el.dataset.tcLockReason = reason || '当前功能已锁定';
      updateTaskCardLockMask(el, true);
    } else {
      el.classList.remove('task-locked-link');
      el.removeAttribute('aria-disabled');
      delete el.dataset.tcLocked;
      delete el.dataset.tcLockReason;
      updateTaskCardLockMask(el, false);
    }
    return;
  }

  if (locked) {
    el.classList.add('task-locked');
    el.setAttribute('aria-disabled', 'true');
    if (reason) el.title = reason;

    if ((tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') && !el.dataset.tcPrevDisabled) {
      el.dataset.tcPrevDisabled = el.disabled ? '1' : '0';
      el.disabled = true;
    }
  } else {
    el.classList.remove('task-locked');
    el.removeAttribute('aria-disabled');
    el.removeAttribute('title');

    if ((tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') && el.dataset.tcPrevDisabled) {
      el.disabled = el.dataset.tcPrevDisabled === '1';
      delete el.dataset.tcPrevDisabled;
    }
  }
}

function applyTaskControlToLinks(root = document, state = taskControlState) {
  const links = root.querySelectorAll('a[href], a[data-tc-locked="1"]');
  links.forEach((el) => {
    const href = el.getAttribute('href') || '';
    const taskKey = resolveTaskKeyByHref(href);
    if (!taskKey) return;
    const locked = isTaskLockedByControl(taskKey, state);
    setElementLocked(el, locked, taskLockReason(taskKey));
  });
}

function applyTaskControlToSelectors(selectors, locked, reason) {
  if (!Array.isArray(selectors)) return;
  for (const selector of selectors) {
    document.querySelectorAll(selector).forEach((el) => setElementLocked(el, locked, reason));
  }
}

function onTaskControlChange(listener, fireImmediately = true) {
  if (typeof listener !== 'function') return () => {};
  taskControlListeners.push(listener);
  if (fireImmediately) listener(getTaskControlState());
  return () => {
    taskControlListeners = taskControlListeners.filter((fn) => fn !== listener);
  };
}

function notifyTaskControlListeners() {
  const snapshot = getTaskControlState();
  taskControlListeners.forEach((fn) => {
    try {
      fn(snapshot);
    } catch {}
  });
}

async function fetchTaskControlState() {
  try {
    const data = await api('/api/task-control');
    taskControlState = normalizeTaskControl({ ...TASK_CONTROL_DEFAULT, ...(data && data.controls ? data.controls : {}) });
    notifyTaskControlListeners();
    return taskControlState;
  } catch {
    return getTaskControlState();
  }
}

function startTaskControlPolling() {
  if (taskControlPollTimer) return;
  taskControlPollTimer = setInterval(() => {
    fetchTaskControlState();
  }, 5000);
}

function initTaskControlRealtime(options = {}) {
  if (taskControlInited) return;
  taskControlInited = true;

  const autoApply = options.autoApply !== false;
  if (autoApply) {
    onTaskControlChange((state) => {
      applyTaskControlToLinks(document, state);
    });
  }

  fetchTaskControlState();

  if (!taskControlClickBound) {
    taskControlClickBound = true;
    document.addEventListener('click', (evt) => {
      const link = evt.target && evt.target.closest ? evt.target.closest('a.task-locked-link[data-tc-locked="1"]') : null;
      if (!link) return;
      evt.preventDefault();
      evt.stopPropagation();
      showTaskLockedPrompt(link.dataset.tcLockReason || '当前功能已锁定');
    });
  }

  if (typeof io === 'function') {
    taskControlSocket = io({
      path: '/socket.io/',
      transports: ['polling', 'websocket'],
    });

    taskControlSocket.on('task:control:update', (controls) => {
      taskControlState = normalizeTaskControl({ ...TASK_CONTROL_DEFAULT, ...(controls || {}) });
      notifyTaskControlListeners();
    });

    taskControlSocket.on('connect_error', () => {
      startTaskControlPolling();
    });
  } else {
    startTaskControlPolling();
  }
}
