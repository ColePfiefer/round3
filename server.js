/**
 * CodeCricket Quiz – Round 3  Backend
 * MongoDB database: round3quiz
 * Collections: scores, settings
 */

const express  = require('express');
const cors     = require('cors');
const { MongoClient } = require('mongodb');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── MongoDB (lazy cached connection — works for both serverless & long-lived) ─
const MONGO_URI = 'mongodb+srv://codemsrit01:6Jmy0j41cF6NT4kt@cluster0.qxej0.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';
const DB_NAME   = 'round3quiz';

let _db = null;
async function getDB() {
  if (_db) return _db;
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  _db = client.db(DB_NAME);
  console.log(`✅  Connected to MongoDB  →  database: ${DB_NAME}`);

  // Seed quiz settings document if it doesn't exist
  const existing = await _db.collection('settings').findOne({ key: 'quizState' });
  if (!existing) {
    await _db.collection('settings').insertOne({ key: 'quizState', active: false });
    console.log('📋  Seeded default quiz state (inactive)');
  }
  return _db;
}

// ── Admin auth ────────────────────────────────────────────────────────────────
const ADMIN_PASSWORD = 'admin@22yc';   // change this before going live
const ADMIN_TOKEN    = 'codecricket_' + Buffer.from(ADMIN_PASSWORD).toString('base64');

function requireAdmin(req, res, next) {
  const auth = req.headers['x-admin-token'] || req.body?.adminToken;
  if (auth === ADMIN_TOKEN) return next();
  return res.status(401).json({ error: 'Unauthorized. Invalid admin token.' });
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
// Static files are served by Vercel CDN directly; only needed for local dev
if (process.env.NODE_ENV !== 'production') {
  app.use(express.static('.'));
}

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', db: DB_NAME, time: new Date().toISOString() });
});

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC ROUTES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/status
 * Returns whether the quiz is currently active.
 */
app.get('/api/status', async (_req, res) => {
  try {
    const db = await getDB();
    const doc = await db.collection('settings').findOne({ key: 'quizState' });
    res.json({ active: doc?.active ?? false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/submit
 * Body: { teamName, runs, wickets, correct, strikeRate, totalQuestions }
 * Saves the score to the scores collection.
 */
app.post('/api/submit', async (req, res) => {
  try {
    const db = await getDB();
    // Check quiz is active
    const stateDoc = await db.collection('settings').findOne({ key: 'quizState' });
    if (!stateDoc?.active) {
      return res.status(403).json({ error: 'Quiz is not active right now. Please wait for the admin to start it.' });
    }

    const { teamName, runs, wickets, correct, strikeRate, totalQuestions } = req.body;
    if (!teamName || teamName.trim() === '') {
      return res.status(400).json({ error: 'Team name is required.' });
    }

    const score = {
      teamName:       teamName.trim().toUpperCase(),
      runs:           Number(runs)           || 0,
      wickets:        Number(wickets)        || 0,
      correct:        Number(correct)        || 0,
      strikeRate:     Number(strikeRate)     || 0,
      totalQuestions: Number(totalQuestions) || 12,
      submittedAt:    new Date()
    };

    const result = await db.collection('scores').insertOne(score);
    res.json({ success: true, id: result.insertedId, score });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/leaderboard
 * Returns top 20 scores sorted by: correct DESC → runs DESC → wickets ASC → time ASC
 * Each team's BEST run is shown (de-duplicated by teamName).
 */
app.get('/api/leaderboard', async (_req, res) => {
  try {
    const db = await getDB();
    const scores = await db.collection('scores')
      .find()
      .sort({ correct: -1, runs: -1, wickets: 1, submittedAt: 1 })
      .toArray();

    // De-duplicate: keep best entry per team
    const seen = new Map();
    for (const s of scores) {
      const key = s.teamName;
      if (!seen.has(key)) seen.set(key, s);
      else {
        const prev = seen.get(key);
        // Replace only if this attempt is strictly better
        const better =
          s.correct > prev.correct ||
          (s.correct === prev.correct && s.runs > prev.runs) ||
          (s.correct === prev.correct && s.runs === prev.runs && s.wickets < prev.wickets);
        if (better) seen.set(key, s);
      }
    }

    const leaderboard = [...seen.values()]
      .sort((a, b) =>
        b.correct - a.correct ||
        b.runs    - a.runs    ||
        a.wickets - b.wickets ||
        new Date(a.submittedAt) - new Date(b.submittedAt)
      )
      .slice(0, 20)
      .map((s, idx) => ({
        rank:        idx + 1,
        teamName:    s.teamName,
        correct:     s.correct,
        runs:        s.runs,
        wickets:     s.wickets,
        strikeRate:  s.strikeRate,
        submittedAt: s.submittedAt
      }));

    res.json({ leaderboard });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN ROUTES  (require X-Admin-Token header)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/admin/login
 * Body: { password }
 * Returns the admin token on success.
 */
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true, token: ADMIN_TOKEN });
  } else {
    res.status(401).json({ error: 'Wrong password.' });
  }
});

/**
 * POST /api/admin/start
 * Marks the quiz as active.
 */
app.post('/api/admin/start', requireAdmin, async (_req, res) => {
  try {
    const db = await getDB();
    await db.collection('settings').updateOne(
      { key: 'quizState' },
      { $set: { active: true, startedAt: new Date() } }
    );
    res.json({ success: true, message: 'Quiz started! Participants can now submit scores.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/stop
 * Marks the quiz as inactive.
 */
app.post('/api/admin/stop', requireAdmin, async (_req, res) => {
  try {
    const db = await getDB();
    await db.collection('settings').updateOne(
      { key: 'quizState' },
      { $set: { active: false, stoppedAt: new Date() } }
    );
    res.json({ success: true, message: 'Quiz stopped. Submissions are now closed.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/scores
 * Returns all raw score entries (newest first).
 */
app.get('/api/admin/scores', requireAdmin, async (_req, res) => {
  try {
    const db = await getDB();
    const scores = await db.collection('scores')
      .find()
      .sort({ submittedAt: -1 })
      .toArray();
    res.json({ count: scores.length, scores });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/admin/scores
 * Clears all scores (reset leaderboard).
 */
app.delete('/api/admin/scores', requireAdmin, async (_req, res) => {
  try {
    const db = await getDB();
    const result = await db.collection('scores').deleteMany({});
    res.json({ success: true, deleted: result.deletedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Boot  — listen locally, export for Vercel serverless
// ─────────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  // Running directly with `node server.js` (local dev)
  getDB().then(() => {
    app.listen(PORT, () => {
      console.log(`🚀  Server running  →  http://localhost:${PORT}`);
      console.log(`🏏  Quiz page       →  http://localhost:${PORT}/cricket-cs-quiz.html`);
      console.log(`🛡️   Admin panel     →  http://localhost:${PORT}/admin.html`);
    });
  }).catch(err => {
    console.error('❌  Failed to connect to MongoDB:', err);
    process.exit(1);
  });
}

// Vercel imports this file as a module — export the Express app
module.exports = app;
