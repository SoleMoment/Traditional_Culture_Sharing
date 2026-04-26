const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { Server } = require('socket.io');
const { db, getTaskControlState: dbGetTaskControlState, setTaskControlState: dbSetTaskControlState } = require('./db');
const pinyinLib = require('pinyin');
const pinyin = pinyinLib.default || pinyinLib.pinyin || pinyinLib;

const PORT = Number(process.env.PORT || 3000);
const MAIL_DOMAIN = process.env.MAIL_DOMAIN || 'jifang.lab';
const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 8);

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const DIST_DIR = path.join(__dirname, '..', 'dist');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STATIC_DIR = fs.existsSync(DIST_DIR) ? DIST_DIR : PUBLIC_DIR;

const sessionMiddleware = session({
  name: 'lab.sid',
  secret: process.env.SESSION_SECRET || 'change-me-in-school-deployment',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
});

const io = new Server(server, {
  path: '/socket.io/',
  cors: { origin: false },
});

io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);
app.use(express.static(STATIC_DIR));

const ATTACHMENT_EXT_RE = /\.(png|jpg|jpeg|gif|webp|pdf|txt|doc|docx)$/i;

function createUploader(allowLabel) {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '') || '';
      const safe = `${Date.now()}_${Math.random().toString(16).slice(2)}${ext}`;
      cb(null, safe);
    },
  });

  return multer({
    storage,
    limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ok = ATTACHMENT_EXT_RE.test(file.originalname || '');
      if (!ok) return cb(new Error(`仅允许 ${allowLabel}`));
      cb(null, true);
    },
  });
}

const mailUpload = createUploader('png/jpg/gif/webp/pdf/txt/doc/docx');
const postUpload = createUploader('png/jpg/gif/webp/pdf/txt/doc/docx');

const DEFAULT_TASK_CONTROL = {
  mailLocked: false,
  chatLocked: false,
  spaceLocked: false,
  evalLesson1Locked: false,
  evalLesson2Locked: false,
  evalLesson3Locked: false,
  updatedAt: null,
  updatedBy: null,
};

function normalizeTaskControlState(raw) {
  const state = raw && typeof raw === 'object' ? raw : {};
  return {
    mailLocked: !!state.mailLocked,
    chatLocked: !!state.chatLocked,
    spaceLocked: !!state.spaceLocked,
    evalLesson1Locked: !!state.evalLesson1Locked,
    evalLesson2Locked: !!state.evalLesson2Locked,
    evalLesson3Locked: !!state.evalLesson3Locked,
    updatedAt: state.updatedAt || null,
    updatedBy: state.updatedBy || null,
  };
}

function getTaskControlState() {
  return normalizeTaskControlState({ ...DEFAULT_TASK_CONTROL, ...dbGetTaskControlState() });
}

function saveTaskControlState(nextState) {
  dbSetTaskControlState(normalizeTaskControlState(nextState));
}

function isTaskLocked(taskKey) {
  const state = getTaskControlState();
  if (taskKey === 'mail') return state.mailLocked;
  if (taskKey === 'chat') return state.chatLocked;
  if (taskKey === 'space') return state.spaceLocked;
  return false;
}

function requireTaskUnlocked(taskKey, label) {
  return (req, res, next) => {
    const currentUser = db.prepare('SELECT role FROM users WHERE id = ?').get(req.session.userId);
    if (currentUser && currentUser.role === 'teacher') return next();
    if (!isTaskLocked(taskKey)) return next();
    return res.status(423).json({ error: `${label}已被教师锁定，暂不可用` });
  };
}

function broadcastTaskControlState() {
  io.emit('task:control:update', getTaskControlState());
}

function updateTaskControlState(patch, updatedBy) {
  const current = getTaskControlState();
  const next = { ...current };
  const action = String((patch && patch.action) || '').trim();

  if (action === 'allLock') {
    next.mailLocked = true;
    next.chatLocked = true;
    next.spaceLocked = true;
    next.evalLesson1Locked = true;
    next.evalLesson2Locked = true;
    next.evalLesson3Locked = true;
  } else if (action === 'allUnlock') {
    next.mailLocked = false;
    next.chatLocked = false;
    next.spaceLocked = false;
    next.evalLesson1Locked = false;
    next.evalLesson2Locked = false;
    next.evalLesson3Locked = false;
  }

  const keys = [
    'mailLocked',
    'chatLocked',
    'spaceLocked',
    'evalLesson1Locked',
    'evalLesson2Locked',
    'evalLesson3Locked',
  ];
  for (const key of keys) {
    if (typeof patch[key] === 'boolean') {
      next[key] = patch[key];
    }
  }

  next.updatedAt = new Date().toISOString();
  next.updatedBy = updatedBy || null;

  saveTaskControlState(next);
  return getTaskControlState();
}

function addr(username) {
  const u = String(username || '').toLowerCase().trim();
  if (!u) return `unknown@${MAIL_DOMAIN}`;
  return `${u}@${MAIL_DOMAIN}`;
}

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: '请先登录' });
  }
  next();
}

function requireTeacher(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: '请先登录' });
  const u = db.prepare('SELECT role FROM users WHERE id = ?').get(req.session.userId);
  if (!u || u.role !== 'teacher') return res.status(403).json({ error: '需要教师权限' });
  next();
}

function parseUserList(str) {
  if (!str || !String(str).trim()) return [];
  return String(str)
    .split(/[,，;；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function getUserByUsername(name) {
  // 处理邮箱格式，如 lisi@jifang.lab 提取用户名 lisi
  let username = String(name || '').trim();
  if (username.includes('@')) {
    username = username.split('@')[0];
  }
  return db.prepare('SELECT id, username, display_name, role FROM users WHERE username = ? COLLATE NOCASE').get(username);
}

// 中文姓名转拼音
function nameToPinyin(name) {
  try {
    const str = String(name || '').trim();
    if (!str) {
      return 'user' + Date.now().toString(36);
    }

    console.log('[pinyin] 输入姓名:', str);

    // 使用 STYLE_NORMAL (pinyin.STYLE_NORMAL 或数字 0)
    // 这会返回不带声调的拼音
    const py = pinyin(str, {
      style: 0  // STYLE_NORMAL = 0, 返回不带声调的拼音
    });
    console.log('[pinyin] 转换结果:', JSON.stringify(py));

    if (Array.isArray(py) && py.length > 0) {
      // 将二维数组展平并连接: [['wang'], ['wu']] => 'wangwu'
      const result = py.flat().join('').toLowerCase();
      console.log('[pinyin] 拼接结果:', result);

      // 只保留字母
      const cleaned = result.replace(/[^a-z]/g, '');
      console.log('[pinyin] 清理后:', cleaned);

      if (cleaned && cleaned.length >= 2) {
        return cleaned;
      }
    }

    // 如果转换结果为空，生成基于时间的用户名
    console.log('[pinyin] 转换失败，使用随机用户名');
    return 'user' + Date.now().toString(36);
  } catch (e) {
    // 如果 pinyin 转换失败，生成基于时间的用户名
    console.error('[pinyin] 转换异常:', e);
    return 'user' + Date.now().toString(36);
  }
}

// 根据姓名获取用户（支持中文姓名或拼音用户名）
function getUserByNameOrUsername(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  
  // 先尝试按用户名查找
  let user = db.prepare('SELECT id, username, display_name, role FROM users WHERE username = ? COLLATE NOCASE').get(trimmed);
  if (user) return user;
  
  // 再尝试按显示名称（中文姓名）查找
  user = db.prepare('SELECT id, username, display_name, role FROM users WHERE display_name = ?').get(trimmed);
  if (user) return user;
  
  return null;
}

// ---------- Auth ----------
// 注册：使用中文姓名，自动生成拼音用户名和邮箱
app.post('/api/register', (req, res) => {
  const { name, password } = req.body || {};
  const n = String(name || '').trim();
  const p = String(password || '');
  
  // 验证中文姓名（2-10个汉字）
  // 使用更宽松的正则，允许中间有空格，但只计算汉字数量
  const chineseChars = n.match(/[\u4e00-\u9fa5]/g) || [];
  if (chineseChars.length < 2 || chineseChars.length > 10) {
    return res.status(400).json({ error: '请使用真实中文姓名（2-10个汉字）' });
  }
  // 提取纯汉字姓名用于后续处理
  const pureName = chineseChars.join('');
  if (p.length < 4) return res.status(400).json({ error: '密码至少 4 位' });
  
  // 生成拼音用户名
  const pyUsername = nameToPinyin(pureName);
  
  // 检查拼音用户名是否已存在，如果存在则添加数字后缀
  let finalUsername = pyUsername;
  let counter = 1;
  while (db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(finalUsername)) {
    finalUsername = pyUsername + counter;
    counter++;
  }
  
  const hash = bcrypt.hashSync(p, 10);
  const info = db
    .prepare(
      'INSERT INTO users (username, password_hash, display_name, role, created_at) VALUES (?,?,?,?,?)'
    )
    .run(finalUsername, hash, pureName, 'student', new Date().toISOString());
  req.session.userId = info.lastInsertRowid;
  res.json({
    ok: true,
    user: {
      id: info.lastInsertRowid,
      username: finalUsername,
      displayName: pureName,
      email: addr(finalUsername),
      role: 'student'
    },
  });
});

// 登录：支持中文姓名或拼音用户名
app.post('/api/login', (req, res) => {
  const { name, password } = req.body || {};
  const n = String(name || '').trim();
  const p = String(password || '');
  
  // 根据姓名或用户名查找用户
  const row = db.prepare('SELECT * FROM users WHERE display_name = ? OR username = ? COLLATE NOCASE').get(n, n);
  if (!row || !bcrypt.compareSync(p, row.password_hash)) {
    return res.status(400).json({ error: '姓名或密码错误' });
  }
  req.session.userId = row.id;
  res.json({
    ok: true,
    user: {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      email: addr(row.username),
      role: row.role,
    },
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/config', (req, res) => {
  res.json({ mailDomain: MAIL_DOMAIN, maxUploadMb: MAX_UPLOAD_MB });
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const row = db.prepare('SELECT id, username, display_name, role FROM users WHERE id = ?').get(req.session.userId);
  if (!row) return res.json({ user: null });
  res.json({
    user: {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      email: addr(row.username),
      role: row.role,
    },
  });
});

app.get('/api/users', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id, username, display_name AS displayName FROM users ORDER BY username').all();
  res.json({ users: rows.map((r) => ({ ...r, email: addr(r.username) })) });
});

app.get('/api/task-control', requireAuth, (req, res) => {
  res.json({ controls: getTaskControlState() });
});

app.post('/api/admin/task-control', requireTeacher, (req, res) => {
  const teacher = db.prepare('SELECT id, username, display_name, role FROM users WHERE id = ?').get(req.session.userId);
  const controls = updateTaskControlState(req.body || {}, teacher ? teacher.username : 'teacher');
  broadcastTaskControlState();
  res.json({ ok: true, controls });
});

// ---------- Self Evaluation ----------
app.get('/api/evaluation', requireAuth, (req, res) => {
  const uid = req.session.userId;
  const row = db
    .prepare(
      `SELECT lesson1_star AS lesson1Star, lesson2_star AS lesson2Star, lesson3_star AS lesson3Star, updated_at AS updatedAt
       FROM self_evaluations
       WHERE user_id = ?`
    )
    .get(uid);

  res.json({
    evaluation: row || {
      lesson1Star: 0,
      lesson2Star: 0,
      lesson3Star: 0,
      updatedAt: null,
    },
    submitted: !!(row && row.updatedAt),
  });
});

app.post('/api/evaluation', requireAuth, (req, res) => {
  const uid = req.session.userId;
  const l1 = Number(req.body?.lesson1Star || 0);
  const l2 = Number(req.body?.lesson2Star || 0);
  const l3 = Number(req.body?.lesson3Star || 0);

  const stars = [l1, l2, l3];
  if (stars.some((s) => !Number.isInteger(s) || s < 0 || s > 3)) {
    return res.status(400).json({ error: '星级范围为 0-3 星' });
  }

  const controls = getTaskControlState();
  const existing = db
    .prepare(
      `SELECT lesson1_star AS lesson1Star, lesson2_star AS lesson2Star, lesson3_star AS lesson3Star, updated_at AS updatedAt
       FROM self_evaluations
       WHERE user_id = ?`
    )
    .get(uid);

  if (existing && existing.updatedAt) {
    return res.status(423).json({ error: '评价已提交，不能重复修改' });
  }

  const current = existing || { lesson1Star: 0, lesson2Star: 0, lesson3Star: 0 };

  if (controls.evalLesson1Locked && l1 !== Number(current.lesson1Star || 0)) {
    return res.status(423).json({ error: '第1课评价已被教师锁定，暂不可修改' });
  }
  if (controls.evalLesson2Locked && l2 !== Number(current.lesson2Star || 0)) {
    return res.status(423).json({ error: '第2课评价已被教师锁定，暂不可修改' });
  }
  if (controls.evalLesson3Locked && l3 !== Number(current.lesson3Star || 0)) {
    return res.status(423).json({ error: '第3课评价已被教师锁定，暂不可修改' });
  }

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO self_evaluations (user_id, lesson1_star, lesson2_star, lesson3_star, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       lesson1_star = excluded.lesson1_star,
       lesson2_star = excluded.lesson2_star,
       lesson3_star = excluded.lesson3_star,
       updated_at = excluded.updated_at`
  ).run(uid, l1, l2, l3, now);

  res.json({ ok: true, updatedAt: now });
});

// ---------- Mail ----------
app.get('/api/mail/inbox', requireAuth, requireTaskUnlocked('mail', '书信任务'), (req, res) => {
  const uid = req.session.userId;
  const rows = db
    .prepare(
      `SELECT m.id, m.subject, m.body, m.created_at AS createdAt,
              s.username AS senderUsername, s.display_name AS senderName,
              er.read_at AS readAt, er.kind
       FROM email_recipients er
       JOIN email_messages m ON m.id = er.message_id
       JOIN users s ON s.id = m.sender_id
       WHERE er.user_id = ? AND er.kind = 'to'
       ORDER BY m.created_at DESC`
    )
    .all(uid);
  res.json({ items: rows });
});

app.get('/api/mail/sent', requireAuth, requireTaskUnlocked('mail', '书信任务'), (req, res) => {
  const uid = req.session.userId;
  const rows = db
    .prepare(
      `SELECT id, subject, body, created_at AS createdAt FROM email_messages WHERE sender_id = ? ORDER BY created_at DESC`
    )
    .all(uid);
  res.json({ items: rows });
});

app.get('/api/mail/:id', requireAuth, requireTaskUnlocked('mail', '书信任务'), (req, res) => {
  const uid = req.session.userId;
  const id = Number(req.params.id);
  const msg = db.prepare('SELECT * FROM email_messages WHERE id = ?').get(id);
  if (!msg) return res.status(404).json({ error: '邮件不存在' });

  const isSender = msg.sender_id === uid;
  const rec = db
    .prepare('SELECT * FROM email_recipients WHERE message_id = ? AND user_id = ?')
    .get(id, uid);
  if (!isSender && !rec) return res.status(403).json({ error: '无权查看' });

  if (rec && rec.kind === 'to' && !rec.read_at) {
    db.prepare('UPDATE email_recipients SET read_at = ? WHERE id = ?').run(new Date().toISOString(), rec.id);
  }

  const sender = db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(msg.sender_id);
  const recipients = db
    .prepare(
      `SELECT u.username, u.display_name AS displayName, er.kind
       FROM email_recipients er
       JOIN users u ON u.id = er.user_id
       WHERE er.message_id = ?`
    )
    .all(id);

  res.json({
    id: msg.id,
    subject: msg.subject,
    body: msg.body,
    createdAt: msg.created_at,
    attachment: msg.file_path
      ? {
          fileUrl: `/uploads/${path.basename(msg.file_path)}`,
          fileName: msg.file_name,
          mime: msg.mime,
        }
      : null,
    sender: { username: sender.username, displayName: sender.display_name, email: addr(sender.username) },
    recipients: recipients.map((r) => ({
      username: r.username,
      displayName: r.displayName,
      kind: r.kind,
      email: addr(r.username),
    })),
  });
});

app.post('/api/mail/send', requireAuth, requireTaskUnlocked('mail', '书信任务'), (req, res, next) => {
  mailUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || '上传失败' });
    next();
  });
}, (req, res) => {
  const uid = req.session.userId;
  const { to, cc, subject, body } = req.body || {};
  const toList = parseUserList(to);
  const ccList = parseUserList(cc);
  if (!toList.length) return res.status(400).json({ error: '请选择收件人' });
  const sub = String(subject || '').trim();
  const bod = String(body || '');
  if (!sub) return res.status(400).json({ error: '请填写主题' });
  if (!bod) return res.status(400).json({ error: '请填写正文' });

  const toIds = [];
  for (const name of toList) {
    const u = getUserByNameOrUsername(name);
    if (!u) return res.status(400).json({ error: `找不到收件人：${name}` });
    toIds.push(u.id);
  }
  const ccIds = [];
  for (const name of ccList) {
    const u = getUserByNameOrUsername(name);
    if (!u) return res.status(400).json({ error: `找不到抄送对象：${name}` });
    ccIds.push(u.id);
  }

  const now = new Date().toISOString();
  const filePath = req.file ? req.file.path : null;
  const fileName = req.file ? req.file.originalname : null;
  const mime = req.file ? req.file.mimetype : null;
  const ins = db.prepare(
    'INSERT INTO email_messages (sender_id, subject, body, file_path, file_name, mime, created_at) VALUES (?,?,?,?,?,?,?)'
  );
  const insRec = db.prepare(
    'INSERT INTO email_recipients (message_id, user_id, kind, read_at) VALUES (?,?,?,NULL)'
  );
  const tx = db.transaction(() => {
    const r = ins.run(uid, sub, bod, filePath, fileName, mime, now);
    const mid = r.lastInsertRowid;
    for (const id of toIds) insRec.run(mid, id, 'to');
    for (const id of ccIds) insRec.run(mid, id, 'cc');
  });
  tx();
  res.json({ ok: true });
});

// ---------- Posts / Space ----------
app.get('/api/posts', requireAuth, requireTaskUnlocked('space', '展厅任务'), (req, res) => {
  const uid = req.session.userId;
  const rows = db
    .prepare(
      `SELECT p.*, u.username, u.display_name AS displayName,
        (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id) AS likeCount,
        EXISTS(SELECT 1 FROM post_likes l WHERE l.post_id = p.id AND l.user_id = ?) AS liked
       FROM posts p JOIN users u ON u.id = p.user_id
       ORDER BY p.created_at DESC`
    )
    .all(uid);
  res.json({
    posts: rows.map((p) => ({
      id: p.id,
      title: p.title,
      body: p.body,
      fileUrl: p.file_path ? `/uploads/${path.basename(p.file_path)}` : null,
      fileName: p.file_name,
      mime: p.mime,
      createdAt: p.created_at,
      author: { username: p.username, displayName: p.displayName },
      likeCount: p.likeCount,
      liked: !!p.liked,
    })),
  });
});

app.post('/api/posts', requireAuth, requireTaskUnlocked('space', '展厅任务'), (req, res, next) => {
  postUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || '上传失败' });
    next();
  });
}, (req, res) => {
  const uid = req.session.userId;
  const title = String(req.body.title || '').trim();
  const body = String(req.body.body || '').trim();
  if (!title || !body) return res.status(400).json({ error: '请填写标题与正文' });
  let filePath = null;
  let fileName = null;
  let mime = null;
  if (req.file) {
    filePath = req.file.path;
    fileName = req.file.originalname;
    mime = req.file.mimetype;
  }
  const now = new Date().toISOString();
  const r = db
    .prepare(
      'INSERT INTO posts (user_id, title, body, file_path, file_name, mime, created_at) VALUES (?,?,?,?,?,?,?)'
    )
    .run(uid, title, body, filePath, fileName, mime, now);
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.post('/api/posts/:id/like', requireAuth, requireTaskUnlocked('space', '展厅任务'), (req, res) => {
  const uid = req.session.userId;
  const pid = Number(req.params.id);
  const p = db.prepare('SELECT id FROM posts WHERE id = ?').get(pid);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const existing = db.prepare('SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?').get(pid, uid);
  if (existing) {
    db.prepare('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?').run(pid, uid);
  } else {
    db.prepare('INSERT INTO post_likes (post_id, user_id) VALUES (?,?)').run(pid, uid);
  }
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM post_likes WHERE post_id = ?').get(pid).c;
  res.json({ ok: true, likeCount: cnt, liked: !existing });
});

app.get('/api/posts/:id/comments', requireAuth, requireTaskUnlocked('space', '展厅任务'), (req, res) => {
  const pid = Number(req.params.id);
  const rows = db
    .prepare(
      `SELECT c.id, c.body, c.created_at AS createdAt, u.username, u.display_name AS displayName
       FROM post_comments c JOIN users u ON u.id = c.user_id
       WHERE c.post_id = ?
       ORDER BY c.created_at ASC`
    )
    .all(pid);
  res.json({ comments: rows });
});

app.post('/api/posts/:id/comments', requireAuth, requireTaskUnlocked('space', '展厅任务'), (req, res) => {
  const uid = req.session.userId;
  const pid = Number(req.params.id);
  const p = db.prepare('SELECT id FROM posts WHERE id = ?').get(pid);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const body = String((req.body && req.body.body) || '').trim();
  if (!body) return res.status(400).json({ error: '评论不能为空' });
  if (body.length > 500) return res.status(400).json({ error: '评论过长' });
  const now = new Date().toISOString();
  const r = db.prepare('INSERT INTO post_comments (post_id, user_id, body, created_at) VALUES (?,?,?,?)').run(
    pid,
    uid,
    body,
    now
  );
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.use('/uploads', express.static(UPLOAD_DIR));

// ---------- Reports & teacher ----------
app.post('/api/report', requireAuth, (req, res) => {
  const uid = req.session.userId;
  const { targetType, targetId, reason } = req.body || {};
  const tt = String(targetType || '');
  const tid = Number(targetId);
  if (!['post', 'comment', 'chat'].includes(tt)) return res.status(400).json({ error: '类型无效' });
  if (!tid) return res.status(400).json({ error: '参数错误' });
  db.prepare('INSERT INTO reports (reporter_id, target_type, target_id, reason, created_at) VALUES (?,?,?,?,?)').run(
    uid,
    tt,
    tid,
    String(reason || '').slice(0, 500),
    new Date().toISOString()
  );
  res.json({ ok: true });
});

app.get('/api/admin/reports', requireTeacher, (req, res) => {
  const rows = db
    .prepare(
      `SELECT r.*, u.username AS reporterName FROM reports r JOIN users u ON u.id = r.reporter_id ORDER BY r.created_at DESC LIMIT 200`
    )
    .all();

  const enriched = rows.map((row) => {
    const item = {
      ...row,
      targetTitle: `目标 #${row.target_id}`,
      targetAuthorName: '未知',
      targetAuthorUsername: '',
      previewPost: null,
    };

    if (row.target_type === 'post') {
      const post = db
        .prepare('SELECT id, title, body, file_path, file_name, mime, created_at, user_id FROM posts WHERE id = ?')
        .get(row.target_id);
      if (post) {
        const author = db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(post.user_id);
        item.targetTitle = post.title || `作品 #${post.id}`;
        item.targetAuthorName = author ? author.display_name : '未知';
        item.targetAuthorUsername = author ? author.username : '';
        item.previewPost = {
          id: post.id,
          title: post.title || '',
          body: post.body || '',
          createdAt: post.created_at,
          fileUrl: post.file_path ? `/uploads/${path.basename(post.file_path)}` : null,
          fileName: post.file_name || null,
          mime: post.mime || null,
          authorName: item.targetAuthorName,
          authorUsername: item.targetAuthorUsername,
        };
      } else {
        item.targetTitle = `作品 #${row.target_id}（已删除）`;
      }
    }

    if (row.target_type === 'comment') {
      const comment = db.prepare('SELECT id, post_id, user_id, body FROM post_comments WHERE id = ?').get(row.target_id);
      if (comment) {
        const commentAuthor = db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(comment.user_id);
        const post = db
          .prepare('SELECT id, title, body, file_path, file_name, mime, created_at, user_id FROM posts WHERE id = ?')
          .get(comment.post_id);
        item.targetAuthorName = commentAuthor ? commentAuthor.display_name : '未知';
        item.targetAuthorUsername = commentAuthor ? commentAuthor.username : '';
        if (post) {
          item.targetTitle = `${post.title || `作品 #${post.id}`}（评论）`;
          item.previewPost = {
            id: post.id,
            title: post.title || '',
            body: post.body || '',
            createdAt: post.created_at,
            fileUrl: post.file_path ? `/uploads/${path.basename(post.file_path)}` : null,
            fileName: post.file_name || null,
            mime: post.mime || null,
            authorName: item.targetAuthorName,
            authorUsername: item.targetAuthorUsername,
            note: '以下为被举报评论内容预览',
          };
        } else {
          item.targetTitle = `评论 #${comment.id}（原作品已删除）`;
        }
      } else {
        item.targetTitle = `评论 #${row.target_id}（已删除）`;
      }
    }

    if (row.target_type === 'chat') {
      item.targetTitle = `聊天消息 #${row.target_id}`;
      const chat = db.prepare('SELECT id, user_id, body FROM chat_messages WHERE id = ?').get(row.target_id);
      if (chat) {
        const chatAuthor = db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(chat.user_id);
        item.targetAuthorName = chatAuthor ? chatAuthor.display_name : '未知';
        item.targetAuthorUsername = chatAuthor ? chatAuthor.username : '';
        item.previewPost = {
          id: chat.id,
          title: `聊天消息 #${chat.id}`,
          body: chat.body || '',
          createdAt: row.created_at,
          fileUrl: null,
          fileName: null,
          mime: null,
          authorName: item.targetAuthorName,
          authorUsername: item.targetAuthorUsername,
          note: '以下为被举报聊天内容预览',
        };
      }
    }

    return item;
  });

  res.json({ reports: enriched });
});

app.delete('/api/admin/posts/:id', requireTeacher, (req, res) => {
  const id = Number(req.params.id);
  const p = db.prepare('SELECT file_path FROM posts WHERE id = ?').get(id);
  if (!p) return res.status(404).json({ error: '不存在' });
  db.prepare('DELETE FROM posts WHERE id = ?').run(id);
  if (p.file_path && fs.existsSync(p.file_path)) fs.unlinkSync(p.file_path);
  res.json({ ok: true });
});

app.delete('/api/admin/comments/:id', requireTeacher, (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM post_comments WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---------- Chat history ----------
app.get('/api/chat/history', requireAuth, requireTaskUnlocked('chat', '茶话任务'), (req, res) => {
  const room = String(req.query.room || '大厅');
  const rows = db
    .prepare(
      `SELECT c.id, c.body, c.created_at AS createdAt, u.username, u.display_name AS displayName
       FROM chat_messages c JOIN users u ON u.id = c.user_id
       WHERE c.room = ?
       ORDER BY c.created_at DESC
       LIMIT 80`
    )
    .all(room);
  res.json({ messages: rows.reverse() });
});

io.use((socket, next) => {
  const uid = socket.request.session && socket.request.session.userId;
  if (!uid) return next(new Error('未登录'));
  socket.userId = uid;
  const u = db.prepare('SELECT id, username, display_name, role FROM users WHERE id = ?').get(uid);
  if (!u) return next(new Error('用户不存在'));
  socket.user = u;
  next();
});

io.on('connection', (socket) => {
  const defaultRoom = '大厅';
  socket.currentRoom = defaultRoom;
  socket.join(defaultRoom);
  socket.emit('task:control:update', getTaskControlState());

  socket.on('chat:join', (payload, cb) => {
    if (isTaskLocked('chat') && socket.user.role !== 'teacher') {
      return typeof cb === 'function' && cb({ ok: false, error: '茶话任务已被教师锁定，暂不可进入' });
    }
    const r = String((payload && payload.room) || '大厅').slice(0, 32) || '大厅';
    const prev = socket.currentRoom || defaultRoom;
    socket.leave(prev);
    socket.join(r);
    socket.currentRoom = r;
    if (typeof cb === 'function') cb({ ok: true, room: r });
  });

  socket.on('chat:message', (payload, cb) => {
    if (isTaskLocked('chat') && socket.user.role !== 'teacher') {
      return typeof cb === 'function' && cb({ ok: false, error: '茶话任务已被教师锁定，暂不可发言' });
    }
    const r = socket.currentRoom || '大厅';
    const body = String((payload && payload.body) || '').trim();
    if (!body) return typeof cb === 'function' && cb({ ok: false, error: '内容为空' });
    if (body.length > 500) return typeof cb === 'function' && cb({ ok: false, error: '内容过长' });
    const now = new Date().toISOString();
    const ins = db
      .prepare('INSERT INTO chat_messages (room, user_id, body, created_at) VALUES (?,?,?,?)')
      .run(r, socket.userId, body, now);
    const msg = {
      id: ins.lastInsertRowid,
      room: r,
      body,
      createdAt: now,
      username: socket.user.username,
      displayName: socket.user.display_name,
    };
    io.to(r).emit('chat:message', msg);
    if (typeof cb === 'function') cb({ ok: true, id: msg.id });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`机房素养网已启动: http://0.0.0.0:${PORT}`);
  console.log(`邮件域 @${MAIL_DOMAIN}  上传目录 ${UPLOAD_DIR}`);
});
