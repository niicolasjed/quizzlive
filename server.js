const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// ── Init ──────────────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || './data';
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'quizzlive.db');

[DATA_DIR, UPLOADS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── Base de données (sql.js — pure JS, pas de compilation native) ─────────────
let db;
let SQL;

async function initDb() {
  SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS trainers (
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL, created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS quizzes (
      id TEXT PRIMARY KEY, trainer_id TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT DEFAULT '', questions TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, pin TEXT UNIQUE NOT NULL, quiz_id TEXT NOT NULL,
      trainer_id TEXT NOT NULL, status TEXT DEFAULT 'lobby',
      current_question INTEGER DEFAULT -1, quiz_snapshot TEXT NOT NULL,
      participants TEXT DEFAULT '{}', answers TEXT DEFAULT '{}',
      results TEXT DEFAULT NULL, created_at INTEGER DEFAULT (strftime('%s','now')),
      finished_at INTEGER DEFAULT NULL
    );
  `);
  saveDb();
}

// Sauvegarde périodique sur disque (sql.js est en mémoire)
function saveDb() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}
setInterval(saveDb, 10000);

// Helpers SQL
function dbRun(sql, params = []) { db.run(sql, params); saveDb(); }
function dbGet(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) { const r = stmt.getAsObject(); stmt.free(); return r; }
  stmt.free(); return null;
}
function dbAll(sql, params = []) {
  const results = [];
  const stmt = db.prepare(sql);
  stmt.bind(params);
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /image\/(jpeg|png|gif|webp)/.test(file.mimetype);
    cb(null, ok);
  }
});

// ── Sessions WebSocket en mémoire ─────────────────────────────────────────────
const rooms = new Map();
function getRoom(sid) {
  if (!rooms.has(sid)) rooms.set(sid, { hostWs: null, playerWs: new Map(), timer: null });
  return rooms.get(sid);
}
function broadcast(sid, msg, exclude = null) {
  const room = getRoom(sid);
  const data = JSON.stringify(msg);
  if (room.hostWs && room.hostWs !== exclude && room.hostWs.readyState === 1) room.hostWs.send(data);
  room.playerWs.forEach(ws => { if (ws !== exclude && ws.readyState === 1) ws.send(data); });
}
function sendTo(ws, msg) { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); }

// ── Auth tokens ───────────────────────────────────────────────────────────────
const tokens = new Map();
function createToken(trainerId) { const t = uuidv4(); tokens.set(t, trainerId); return t; }
function authTrainer(req) { const t = req.headers['x-token']; return t ? tokens.get(t) : null; }

// ── Session helpers ───────────────────────────────────────────────────────────
function getSession(id) {
  const s = dbGet('SELECT * FROM sessions WHERE id=?', [id]);
  if (!s) return null;
  s.participants = JSON.parse(s.participants);
  s.answers = JSON.parse(s.answers);
  s.quiz_snapshot = JSON.parse(s.quiz_snapshot);
  s.results = s.results ? JSON.parse(s.results) : null;
  return s;
}
function saveSession(s) {
  dbRun(`UPDATE sessions SET status=?,current_question=?,participants=?,answers=?,results=?,finished_at=? WHERE id=?`,
    [s.status, s.current_question, JSON.stringify(s.participants), JSON.stringify(s.answers),
     s.results ? JSON.stringify(s.results) : null, s.finished_at || null, s.id]);
}
function publicSession(s) {
  return { id: s.id, pin: s.pin, status: s.status, current_question: s.current_question,
    quiz_snapshot: s.quiz_snapshot, participants: s.participants, answers: s.answers };
}

// ════════════════════════════════════════════════════════════════════════════════
// API REST
// ════════════════════════════════════════════════════════════════════════════════

app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username?.trim() || !password?.trim()) return res.status(400).json({ error: 'Champs manquants' });
  if (dbGet('SELECT id FROM trainers WHERE username=?', [username.trim()])) return res.status(409).json({ error: 'Identifiant déjà pris' });
  const id = uuidv4();
  dbRun('INSERT INTO trainers(id,username,password_hash) VALUES(?,?,?)', [id, username.trim(), bcrypt.hashSync(password, 10)]);
  res.json({ token: createToken(id), username: username.trim() });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const trainer = dbGet('SELECT * FROM trainers WHERE username=?', [username?.trim()]);
  if (!trainer || !bcrypt.compareSync(password, trainer.password_hash)) return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect' });
  res.json({ token: createToken(trainer.id), username: trainer.username });
});

app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!authTrainer(req)) return res.status(401).json({ error: 'Non autorisé' });
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

app.get('/api/quizzes', (req, res) => {
  const tid = authTrainer(req);
  if (!tid) return res.status(401).json({ error: 'Non autorisé' });
  const rows = dbAll('SELECT * FROM quizzes WHERE trainer_id=? ORDER BY updated_at DESC', [tid]);
  res.json(rows.map(r => ({ ...r, questions: JSON.parse(r.questions) })));
});

app.post('/api/quizzes', (req, res) => {
  const tid = authTrainer(req);
  if (!tid) return res.status(401).json({ error: 'Non autorisé' });
  const { title, description, questions } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Titre manquant' });
  const id = uuidv4();
  dbRun('INSERT INTO quizzes(id,trainer_id,title,description,questions) VALUES(?,?,?,?,?)',
    [id, tid, title.trim(), description || '', JSON.stringify(questions || [])]);
  res.json({ id });
});

app.put('/api/quizzes/:id', (req, res) => {
  const tid = authTrainer(req);
  if (!tid) return res.status(401).json({ error: 'Non autorisé' });
  const { title, description, questions } = req.body;
  if (!dbGet('SELECT id FROM quizzes WHERE id=? AND trainer_id=?', [req.params.id, tid])) return res.status(404).json({ error: 'Introuvable' });
  dbRun(`UPDATE quizzes SET title=?,description=?,questions=?,updated_at=strftime('%s','now') WHERE id=?`,
    [title.trim(), description || '', JSON.stringify(questions || []), req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/quizzes/:id', (req, res) => {
  const tid = authTrainer(req);
  if (!tid) return res.status(401).json({ error: 'Non autorisé' });
  dbRun('DELETE FROM quizzes WHERE id=? AND trainer_id=?', [req.params.id, tid]);
  res.json({ ok: true });
});

app.post('/api/sessions', (req, res) => {
  const tid = authTrainer(req);
  if (!tid) return res.status(401).json({ error: 'Non autorisé' });
  const quiz = dbGet('SELECT * FROM quizzes WHERE id=? AND trainer_id=?', [req.body.quizId, tid]);
  if (!quiz) return res.status(404).json({ error: 'Quizz introuvable' });
  const questions = JSON.parse(quiz.questions);
  if (!questions.length) return res.status(400).json({ error: 'Quizz sans questions' });
  let pin;
  do { pin = String(Math.floor(100000 + Math.random() * 900000)); }
  while (dbGet("SELECT id FROM sessions WHERE pin=? AND status != 'finished'", [pin]));
  const id = uuidv4();
  const snapshot = { id: quiz.id, title: quiz.title, description: quiz.description, questions };
  dbRun('INSERT INTO sessions(id,pin,quiz_id,trainer_id,quiz_snapshot) VALUES(?,?,?,?,?)',
    [id, pin, quiz.id, tid, JSON.stringify(snapshot)]);
  res.json({ id, pin });
});

app.get('/api/sessions/by-pin/:pin', (req, res) => {
  const s = dbGet("SELECT id,pin,status,quiz_snapshot FROM sessions WHERE pin=? AND status != 'finished'", [req.params.pin]);
  if (!s) return res.status(404).json({ error: 'Session introuvable ou terminée' });
  const snap = JSON.parse(s.quiz_snapshot);
  res.json({ id: s.id, pin: s.pin, status: s.status, quizTitle: snap.title });
});

app.get('/api/sessions/history', (req, res) => {
  const tid = authTrainer(req);
  if (!tid) return res.status(401).json({ error: 'Non autorisé' });
  const rows = dbAll(`SELECT s.id,s.pin,s.status,s.created_at,s.finished_at,s.results,q.title as quiz_title
    FROM sessions s JOIN quizzes q ON s.quiz_id=q.id WHERE s.trainer_id=? ORDER BY s.created_at DESC LIMIT 50`, [tid]);
  res.json(rows.map(r => ({ ...r, results: r.results ? JSON.parse(r.results) : null })));
});

app.get('/api/sessions/:id/results', (req, res) => {
  const tid = authTrainer(req);
  if (!tid) return res.status(401).json({ error: 'Non autorisé' });
  const s = getSession(req.params.id);
  if (!s || s.trainer_id !== tid) return res.status(404).json({ error: 'Introuvable' });
  res.json(s);
});

// ════════════════════════════════════════════════════════════════════════════════
// WebSocket
// ════════════════════════════════════════════════════════════════════════════════
function revealAnswer(sessionId, qIndex) {
  const room = getRoom(sessionId);
  clearTimeout(room.timer);
  const s = getSession(sessionId);
  if (!s || s.status !== 'question' || s.current_question !== qIndex) return;

  const q = s.quiz_snapshot.questions[qIndex];
  const ans = s.answers[qIndex] || {};
  Object.entries(ans).forEach(([pid, resp]) => {
    if (!s.participants[pid]) return;
    if (!s.participants[pid].score) s.participants[pid].score = 0;
    if (!s.participants[pid].correct) s.participants[pid].correct = 0;
    if (resp.answer === q.correct) {
      s.participants[pid].score += Math.round(200 + Math.max(0, resp.timeRatio * 800));
      s.participants[pid].correct++;
    }
  });

  s.status = 'reveal';
  saveSession(s);
  broadcast(sessionId, { type: 'reveal', qIndex, correctIdx: q.correct, participants: s.participants });

  setTimeout(() => {
    const s2 = getSession(sessionId);
    if (!s2 || s2.status !== 'reveal') return;
    s2.status = 'scoreboard';
    saveSession(s2);
    broadcast(sessionId, { type: 'scoreboard', qIndex, participants: s2.participants, answers: s2.answers, quizSnapshot: s2.quiz_snapshot });
  }, 2500);
}

wss.on('connection', ws => {
  ws.meta = {};
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'ping') { sendTo(ws, { type: 'pong' }); return; }
    handlers[msg.type]?.(ws, msg);
  });

  ws.on('close', () => {
    const { sessionId, role, playerId } = ws.meta;
    if (!sessionId) return;
    const room = getRoom(sessionId);
    if (role === 'host') room.hostWs = null;
    else if (playerId) room.playerWs.delete(playerId);
  });
});

// Ping toutes les 25s pour garder les connexions vivantes (Railway coupe à 60s)
const pingInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

const handlers = {
  host_join(ws, { sessionId, token }) {
    const tid = tokens.get(token);
    if (!tid) return sendTo(ws, { type:'error', msg:'Token invalide' });
    const s = getSession(sessionId);
    if (!s || s.trainer_id !== tid) return sendTo(ws, { type:'error', msg:'Session introuvable' });
    ws.meta = { role:'host', sessionId };
    getRoom(sessionId).hostWs = ws;
    sendTo(ws, { type:'session_state', session: publicSession(s) });
  },

  player_join(ws, { sessionId, name }) {
    const s = getSession(sessionId);
    if (!s || s.status === 'finished') return sendTo(ws, { type:'error', msg:'Session introuvable ou terminée' });
    const playerId = uuidv4();
    s.participants[playerId] = { id:playerId, name:name.trim().slice(0,20), score:0, correct:0 };
    saveSession(s);
    ws.meta = { role:'player', sessionId, playerId };
    getRoom(sessionId).playerWs.set(playerId, ws);
    sendTo(ws, { type:'joined', playerId, session: publicSession(s) });
    const room = getRoom(sessionId);
    if (room.hostWs) sendTo(room.hostWs, { type:'participant_update', participants: s.participants });
  },

  start_quiz(ws) {
    const { sessionId } = ws.meta;
    const s = getSession(sessionId);
    if (!s || s.status !== 'lobby') return;
    s.status = 'question'; s.current_question = 0; s.answers[0] = {};
    saveSession(s);
    const q = s.quiz_snapshot.questions[0];
    broadcast(sessionId, { type:'question_start', qIndex:0, question:q, totalQuestions: s.quiz_snapshot.questions.length });
    const room = getRoom(sessionId);
    room.timer = setTimeout(() => revealAnswer(sessionId, 0), (q.time||20)*1000);
  },

  player_answer(ws, { qIndex, answer, timeRatio }) {
    const { sessionId, playerId } = ws.meta;
    const s = getSession(sessionId);
    if (!s || s.status !== 'question' || s.current_question !== qIndex) return;
    if (s.answers[qIndex]?.[playerId]) return;
    s.answers[qIndex][playerId] = { answer, timeRatio: Math.max(0,Math.min(1,timeRatio)) };
    saveSession(s);
    const count = Object.keys(s.answers[qIndex]).length;
    const total = Object.keys(s.participants).length;
    const room = getRoom(sessionId);
    if (room.hostWs) sendTo(room.hostWs, { type:'answer_count', count, total, qIndex });
    if (count >= total) revealAnswer(sessionId, qIndex);
  },

  next_question(ws) {
    const { sessionId } = ws.meta;
    const s = getSession(sessionId);
    if (!s || s.status !== 'scoreboard') return;
    const nextQ = s.current_question + 1;
    s.current_question = nextQ; s.status = 'question';
    s.answers[nextQ] = {};
    saveSession(s);
    const q = s.quiz_snapshot.questions[nextQ];
    broadcast(sessionId, { type:'question_start', qIndex:nextQ, question:q, totalQuestions: s.quiz_snapshot.questions.length });
    const room = getRoom(sessionId);
    room.timer = setTimeout(() => revealAnswer(sessionId, nextQ), (q.time||20)*1000);
  },

  finish_quiz(ws) {
    const { sessionId } = ws.meta;
    clearTimeout(getRoom(sessionId).timer);
    const s = getSession(sessionId);
    if (!s) return;
    s.status = 'finished';
    s.finished_at = Math.floor(Date.now()/1000);
    const parts = Object.values(s.participants).sort((a,b) => (b.score||0)-(a.score||0));
    s.results = { participants:parts, totalQuestions: s.quiz_snapshot.questions.length, answers: s.answers };
    saveSession(s);
    broadcast(sessionId, { type:'quiz_finished', results: s.results, quizSnapshot: s.quiz_snapshot });
  },

  force_reveal(ws, { qIndex }) {
    revealAnswer(ws.meta.sessionId, qIndex);
  },
};

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDb().then(() => server.listen(PORT, () => console.log(`QuizzLive → http://localhost:${PORT}`)));
