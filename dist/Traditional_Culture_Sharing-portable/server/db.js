const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', 'data');
const dbPath = path.join(dataDir, 'app.sqlite3');
const legacyJsonPath = path.join(dataDir, 'app.json');

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
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    mailLocked: !!src.mailLocked,
    chatLocked: !!src.chatLocked,
    spaceLocked: !!src.spaceLocked,
    evalLesson1Locked: !!src.evalLesson1Locked,
    evalLesson2Locked: !!src.evalLesson2Locked,
    evalLesson3Locked: !!src.evalLesson3Locked,
    updatedAt: src.updatedAt || null,
    updatedBy: src.updatedBy || null,
  };
}

function toDbBool(value) {
  return value ? 1 : 0;
}

function ensureDataDir() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'student',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS email_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      file_path TEXT,
      file_name TEXT,
      mime TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (sender_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS email_recipients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      read_at TEXT,
      FOREIGN KEY (message_id) REFERENCES email_messages(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      file_path TEXT,
      file_name TEXT,
      mime TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS post_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS post_likes (
      post_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      PRIMARY KEY (post_id, user_id),
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter_id INTEGER NOT NULL,
      target_type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (reporter_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS self_evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      lesson1_star INTEGER NOT NULL DEFAULT 0,
      lesson2_star INTEGER NOT NULL DEFAULT 0,
      lesson3_star INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS task_control (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      mail_locked INTEGER NOT NULL DEFAULT 0,
      chat_locked INTEGER NOT NULL DEFAULT 0,
      space_locked INTEGER NOT NULL DEFAULT 0,
      eval_lesson1_locked INTEGER NOT NULL DEFAULT 0,
      eval_lesson2_locked INTEGER NOT NULL DEFAULT 0,
      eval_lesson3_locked INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT,
      updated_by TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_email_messages_sender_created ON email_messages(sender_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_email_recipients_user_kind ON email_recipients(user_id, kind);
    CREATE INDEX IF NOT EXISTS idx_email_recipients_message ON email_recipients(message_id);
    CREATE INDEX IF NOT EXISTS idx_chat_room_created ON chat_messages(room, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_post_comments_post_created ON post_comments(post_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_self_eval_user ON self_evaluations(user_id);
  `);
}

function ensureTaskControlRow(db) {
  db.prepare(
    `INSERT INTO task_control (
       singleton_id,
       mail_locked,
       chat_locked,
       space_locked,
       eval_lesson1_locked,
       eval_lesson2_locked,
       eval_lesson3_locked,
       updated_at,
       updated_by
     ) VALUES (1, 0, 0, 0, 0, 0, 0, NULL, NULL)
     ON CONFLICT(singleton_id) DO NOTHING`
  ).run();
}

function ensureLegacyShape(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const arr = (name) => (Array.isArray(src[name]) ? src[name] : []);
  return {
    meta: src.meta && typeof src.meta === 'object' ? src.meta : {},
    users: arr('users'),
    email_messages: arr('email_messages'),
    email_recipients: arr('email_recipients'),
    chat_messages: arr('chat_messages'),
    posts: arr('posts'),
    post_comments: arr('post_comments'),
    post_likes: arr('post_likes'),
    reports: arr('reports'),
    self_evaluations: arr('self_evaluations'),
  };
}

function readLegacyStore() {
  if (!fs.existsSync(legacyJsonPath)) return null;
  try {
    const raw = fs.readFileSync(legacyJsonPath, 'utf8');
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    return ensureLegacyShape(parsed);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[db] 读取旧 JSON 数据失败，跳过迁移: ${err.message}`);
    return null;
  }
}

function hasAnyData(db) {
  const tables = [
    'users',
    'email_messages',
    'email_recipients',
    'chat_messages',
    'posts',
    'post_comments',
    'post_likes',
    'reports',
    'self_evaluations',
  ];

  for (const table of tables) {
    const row = db.prepare(`SELECT 1 AS v FROM ${table} LIMIT 1`).get();
    if (row && row.v === 1) return true;
  }
  return false;
}

function migrateLegacyJsonIfNeeded(db) {
  const legacy = readLegacyStore();
  if (!legacy) return;
  if (hasAnyData(db)) return;

  const insertUser = db.prepare(
    'INSERT OR IGNORE INTO users (id, username, password_hash, display_name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertEmailMessage = db.prepare(
    'INSERT OR IGNORE INTO email_messages (id, sender_id, subject, body, file_path, file_name, mime, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertEmailRecipient = db.prepare(
    'INSERT OR IGNORE INTO email_recipients (id, message_id, user_id, kind, read_at) VALUES (?, ?, ?, ?, ?)'
  );
  const insertChat = db.prepare(
    'INSERT OR IGNORE INTO chat_messages (id, room, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  const insertPost = db.prepare(
    'INSERT OR IGNORE INTO posts (id, user_id, title, body, file_path, file_name, mime, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertComment = db.prepare(
    'INSERT OR IGNORE INTO post_comments (id, post_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  const insertLike = db.prepare('INSERT OR IGNORE INTO post_likes (post_id, user_id) VALUES (?, ?)');
  const insertReport = db.prepare(
    'INSERT OR IGNORE INTO reports (id, reporter_id, target_type, target_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const upsertSelfEvaluation = db.prepare(
    `INSERT INTO self_evaluations (id, user_id, lesson1_star, lesson2_star, lesson3_star, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       lesson1_star = excluded.lesson1_star,
       lesson2_star = excluded.lesson2_star,
       lesson3_star = excluded.lesson3_star,
       updated_at = excluded.updated_at`
  );

  const upsertTaskControl = db.prepare(
    `INSERT INTO task_control (
       singleton_id,
       mail_locked,
       chat_locked,
       space_locked,
       eval_lesson1_locked,
       eval_lesson2_locked,
       eval_lesson3_locked,
       updated_at,
       updated_by
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(singleton_id) DO UPDATE SET
       mail_locked = excluded.mail_locked,
       chat_locked = excluded.chat_locked,
       space_locked = excluded.space_locked,
       eval_lesson1_locked = excluded.eval_lesson1_locked,
       eval_lesson2_locked = excluded.eval_lesson2_locked,
       eval_lesson3_locked = excluded.eval_lesson3_locked,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`
  );

  const tx = db.transaction(() => {
    for (const row of legacy.users) {
      insertUser.run(
        Number(row.id || 0),
        String(row.username || '').trim(),
        String(row.password_hash || ''),
        String(row.display_name || ''),
        String(row.role || 'student'),
        String(row.created_at || new Date().toISOString())
      );
    }

    for (const row of legacy.email_messages) {
      insertEmailMessage.run(
        Number(row.id || 0),
        Number(row.sender_id || 0),
        String(row.subject || ''),
        String(row.body || ''),
        row.file_path || null,
        row.file_name || null,
        row.mime || null,
        String(row.created_at || new Date().toISOString())
      );
    }

    for (const row of legacy.email_recipients) {
      insertEmailRecipient.run(
        Number(row.id || 0),
        Number(row.message_id || 0),
        Number(row.user_id || 0),
        String(row.kind || ''),
        row.read_at || null
      );
    }

    for (const row of legacy.chat_messages) {
      insertChat.run(
        Number(row.id || 0),
        String(row.room || '大厅'),
        Number(row.user_id || 0),
        String(row.body || ''),
        String(row.created_at || new Date().toISOString())
      );
    }

    for (const row of legacy.posts) {
      insertPost.run(
        Number(row.id || 0),
        Number(row.user_id || 0),
        String(row.title || ''),
        String(row.body || ''),
        row.file_path || null,
        row.file_name || null,
        row.mime || null,
        String(row.created_at || new Date().toISOString())
      );
    }

    for (const row of legacy.post_comments) {
      insertComment.run(
        Number(row.id || 0),
        Number(row.post_id || 0),
        Number(row.user_id || 0),
        String(row.body || ''),
        String(row.created_at || new Date().toISOString())
      );
    }

    for (const row of legacy.post_likes) {
      insertLike.run(Number(row.post_id || 0), Number(row.user_id || 0));
    }

    for (const row of legacy.reports) {
      insertReport.run(
        Number(row.id || 0),
        Number(row.reporter_id || 0),
        String(row.target_type || ''),
        Number(row.target_id || 0),
        row.reason == null ? null : String(row.reason),
        String(row.created_at || new Date().toISOString())
      );
    }

    for (const row of legacy.self_evaluations) {
      upsertSelfEvaluation.run(
        Number(row.id || 0),
        Number(row.user_id || 0),
        Number(row.lesson1_star || 0),
        Number(row.lesson2_star || 0),
        Number(row.lesson3_star || 0),
        row.updated_at || null
      );
    }

    const taskControl = normalizeTaskControlState(
      legacy.meta && legacy.meta.task_control ? legacy.meta.task_control : DEFAULT_TASK_CONTROL
    );
    upsertTaskControl.run(
      1,
      toDbBool(taskControl.mailLocked),
      toDbBool(taskControl.chatLocked),
      toDbBool(taskControl.spaceLocked),
      toDbBool(taskControl.evalLesson1Locked),
      toDbBool(taskControl.evalLesson2Locked),
      toDbBool(taskControl.evalLesson3Locked),
      taskControl.updatedAt,
      taskControl.updatedBy
    );
  });

  tx();
  // eslint-disable-next-line no-console
  console.log(`[db] 已从 ${legacyJsonPath} 迁移到 SQLite: ${dbPath}`);
}

function seedTeacherIfNeeded(db) {
  const teacherUser = process.env.TEACHER_USERNAME || 'teacher';
  const teacherPass = process.env.TEACHER_PASSWORD || 'teacher123';
  const row = db.prepare('SELECT id FROM users WHERE username = ?').get(teacherUser);
  if (row) return;

  const hash = bcrypt.hashSync(teacherPass, 10);
  db.prepare('INSERT INTO users (username, password_hash, display_name, role, created_at) VALUES (?,?,?,?,?)').run(
    teacherUser,
    hash,
    '教师',
    'teacher',
    new Date().toISOString()
  );

  // eslint-disable-next-line no-console
  console.log(`[db] 已创建教师账号: ${teacherUser} / ${teacherPass} （请在生产环境修改 TEACHER_PASSWORD）`);
}

ensureDataDir();

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

createSchema(db);
ensureTaskControlRow(db);
migrateLegacyJsonIfNeeded(db);
ensureTaskControlRow(db);
seedTeacherIfNeeded(db);

function getTaskControlState() {
  ensureTaskControlRow(db);
  const row = db
    .prepare(
      `SELECT
         mail_locked AS mailLocked,
         chat_locked AS chatLocked,
         space_locked AS spaceLocked,
         eval_lesson1_locked AS evalLesson1Locked,
         eval_lesson2_locked AS evalLesson2Locked,
         eval_lesson3_locked AS evalLesson3Locked,
         updated_at AS updatedAt,
         updated_by AS updatedBy
       FROM task_control
       WHERE singleton_id = 1`
    )
    .get();

  return normalizeTaskControlState({ ...DEFAULT_TASK_CONTROL, ...(row || {}) });
}

function setTaskControlState(nextState) {
  ensureTaskControlRow(db);
  const state = normalizeTaskControlState({ ...DEFAULT_TASK_CONTROL, ...(nextState || {}) });

  db.prepare(
    `UPDATE task_control SET
       mail_locked = ?,
       chat_locked = ?,
       space_locked = ?,
       eval_lesson1_locked = ?,
       eval_lesson2_locked = ?,
       eval_lesson3_locked = ?,
       updated_at = ?,
       updated_by = ?
     WHERE singleton_id = 1`
  ).run(
    toDbBool(state.mailLocked),
    toDbBool(state.chatLocked),
    toDbBool(state.spaceLocked),
    toDbBool(state.evalLesson1Locked),
    toDbBool(state.evalLesson2Locked),
    toDbBool(state.evalLesson3Locked),
    state.updatedAt,
    state.updatedBy
  );

  return getTaskControlState();
}

module.exports = { db, dbPath, getTaskControlState, setTaskControlState };
