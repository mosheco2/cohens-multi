// server.js - גרסה סופית ומתוקנת (כולל מיילים, IP וסטטיסטיקות)

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const nodemailer = require("nodemailer");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

const PORT = process.env.PORT || 3000;
const ADMIN_CODE = process.env.ADMIN_CODE || "ONEBTN";

// --- הגדרות אימייל ---
// השרת ינסה לשלוח מייל רק אם הגדרת משתני סביבה ב-Render
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER, 
    pass: process.env.EMAIL_PASS
  }
});

async function sendNewGameEmail(gameInfo) {
  if (!process.env.EMAIL_USER) return; // דלג אם אין הגדרות

  try {
    await transporter.sendMail({
      from: '"Millmania System" <no-reply@millmania.com>',
      to: process.env.ADMIN_EMAIL || process.env.EMAIL_USER, 
      subject: `🚀 משחק חדש נפתח: ${gameInfo.code}`,
      html: `
        <div style="direction: rtl; font-family: sans-serif;">
          <h2>משחק חדש נפתח!</h2>
          <p><strong>קוד משחק:</strong> ${gameInfo.code}</p>
          <p><strong>מנהל:</strong> ${gameInfo.hostName}</p>
          <p><strong>זמן:</strong> ${new Date().toLocaleString("he-IL", {timeZone: "Asia/Jerusalem"})}</p>
        </div>
      `,
    });
    console.log(`📧 Email sent for game ${gameInfo.code}`);
  } catch (error) {
    console.error("❌ Email error:", error.message);
  }
}

// ----------------------
//   Static & JSON
// ----------------------

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ----------------------
//   DB Init
// ----------------------

let pool = null;
let dbReady = false;

async function initDb() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.log("⚠️ No DATABASE_URL. Running in-memory only.");
    return;
  }

  try {
    pool = new Pool({
      connectionString,
      ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
    });

    // יצירת טבלאות
    await pool.query(`
      CREATE TABLE IF NOT EXISTS games (
        code TEXT PRIMARY KEY,
        host_name TEXT NOT NULL,
        target_score INTEGER,
        default_round_seconds INTEGER,
        categories TEXT[],
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_teams (
        id SERIAL PRIMARY KEY,
        game_code TEXT,
        team_id TEXT,
        team_name TEXT,
        score INTEGER DEFAULT 0
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_players (
        id SERIAL PRIMARY KEY,
        game_code TEXT,
        client_id TEXT,
        name TEXT,
        team_id TEXT,
        ip_address TEXT
      );
    `);
    
    // וידוא עמודת IP לטבלאות קיימות
    try {
        await pool.query(`ALTER TABLE game_players ADD COLUMN IF NOT EXISTS ip_address TEXT;`);
    } catch (e) {}

    dbReady = true;
    console.log("✅ Postgres ready.");
  } catch (err) {
    console.error("❌ DB Init Error:", err.message);
  }
}

initDb();

// ----------------------
//   In-memory state
// ----------------------

const games = {};
const roundTimers = {};

// ----------------------
//   Word bank
// ----------------------

const WORD_BANK = [
  { text: "חתול", category: "animals" }, { text: "כלב", category: "animals" }, { text: "פיל", category: "animals" },
  { text: "שולחן", category: "objects" }, { text: "מחשב", category: "technology" }, { text: "טלפון", category: "technology" },
  { text: "פיצה", category: "food" }, { text: "המבורגר", category: "food" }, { text: "משפחה", category: "family" },
  { text: "חופשה", category: "travel" }, { text: "ים", category: "travel" }, { text: "כדורגל", category: "sports" },
  { text: "כדורסל", category: "sports" }, { text: "סדרה בטלוויזיה", category: "entertainment" }, { text: "סרט", category: "entertainment" },
  { text: "שיר", category: "music" }, { text: "גיטרה", category: "music" }, { text: "יער", category: "nature" },
  { text: "מדבר", category: "nature" }, { text: "חג פסח", category: "holidays" }, { text: "ראש השנה", category: "holidays" },
  { text: "מורה", category: "school" }, { text: "תלמיד", category: "school" }, { text: "בוס", category: "work" },
  { text: "משרד", category: "work" },
];

function getRandomWord(categories) {
  let pool = WORD_BANK;
  if (Array.isArray(categories) && categories.length > 0) {
    const catSet = new Set(categories);
    const filtered = WORD_BANK.filter((w) => catSet.has(w.category));
    if (filtered.length > 0) pool = filtered;
  }
  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx];
}

// ----------------------
//   Utils
// ----------------------

function generateGameCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) { code += chars[Math.floor(Math.random() * chars.length)]; }
  return code;
}

function sanitizeGame(game) {
  if (!game) return null;
  const teams = {};
  Object.entries(game.teams || {}).forEach(([teamId, t]) => {
    teams[teamId] = { id: t.id || teamId, name: t.name, score: t.score || 0, players: Array.isArray(t.players) ? [...t.players] : [] };
  });
  const playersByClientId = {};
  Object.entries(game.playersByClientId || {}).forEach(([cid, p]) => {
    playersByClientId[cid] = { clientId: cid, name: p.name, teamId: p.teamId, isHost: p.isHost || false };
  });
  return {
    code: game.code, hostName: game.hostName, targetScore: game.targetScore,
    defaultRoundSeconds: game.defaultRoundSeconds, categories: game.categories || [],
    createdAt: game.createdAt, updatedAt: game.updatedAt, lastActivity: game.lastActivity,
    logoUrl: game.logoUrl || null, banners: game.banners || {},
    teams, playersByClientId, currentRound: game.currentRound || null,
  };
}

function broadcastGame(game) {
  if (!game || !game.code) return;
  io.to("game-" + game.code).emit("gameUpdated", sanitizeGame(game));
}

function clearRoundTimer(gameCode) {
  if (roundTimers[gameCode]) { clearInterval(roundTimers[gameCode]); delete roundTimers[gameCode]; }
}

async function finishRound(gameCode, options = { reason: "manual" }) {
  const code = (gameCode || "").toUpperCase().trim();
  const game = games[code];
  if (!game || !game.currentRound) return;

  const round = game.currentRound;
  round.active = false; round.isActive = false;
  clearRoundTimer(code);

  const teamId = round.teamId;
  const roundScore = typeof round.roundScore === "number" && round.roundScore > 0 ? round.roundScore : 0;

  if (teamId && game.teams[teamId]) {
    game.teams[teamId].score = (game.teams[teamId].score || 0) + roundScore;
  }

  game.lastActivity = new Date();
  game.updatedAt = new Date();

  // עדכון DB
  if (dbReady && pool && teamId && game.teams[teamId]) {
    try {
      await pool.query(`UPDATE game_teams SET score = $1 WHERE game_code = $2 AND team_id = $3`, 
      [game.teams[teamId].score, code, teamId]);
    } catch (err) {}
  }

  const totalScore = teamId && game.teams[teamId] ? game.teams[teamId].score : 0;
  broadcastGame(game);

  io.to("game-" + code).emit("roundFinished", { teamId, roundScore, totalScore, reason: options.reason || "manual" });

  if (options.reason === "timer") {
    const teamName = teamId && game.teams[teamId] ? game.teams[teamId].name : `קבוצה ${teamId || ""}`;
    io.to("game-" + code).emit("roundTimeUp", { code, roundScore, teamId, teamName, totalScore: totalScore || 0 });
  }
  game.currentRound = null;
}

// ----------------------
//   Socket.io Handlers
// ----------------------

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("createGame", async (data, callback) => {
    try {
      const { hostName, targetScore=40, defaultRoundSeconds=60, categories=[], teamNames={} } = data || {};
      if (!hostName) return callback({ ok: false, error: "Missing host name" });

      let code;
      do { code = generateGameCode(); } while (games[code]);

      const teams = {};
      const now = new Date();
      ["A", "B", "C", "D", "E"].forEach((id) => {
        const name = (teamNames[id] || "").trim();
        if (name) teams[id] = { id, name, score: 0, players: [] };
      });
      if (Object.keys(teams).length === 0) {
        teams["A"] = { id: "A", name: "קבוצה A", score: 0, players: [] };
        teams["B"] = { id: "B", name: "קבוצה B", score: 0, players: [] };
      }

      const game = {
        code, hostSocketId: socket.id, hostName, targetScore, defaultRoundSeconds, categories,
        createdAt: now, updatedAt: now, lastActivity: now, logoUrl: null, banners: {},
        teams, playersByClientId: {}, currentRound: null,
      };

      games[code] = game;
      socket.join("game-" + code);

      if (dbReady && pool) {
        try {
          await pool.query(`INSERT INTO games (code, host_name, target_score, default_round_seconds, categories) VALUES ($1, $2, $3, $4, $5)`,
            [code, hostName, targetScore, defaultRoundSeconds, categories]);
          for (const t of Object.values(teams)) {
            await pool.query(`INSERT INTO game_teams (game_code, team_id, team_name, score) VALUES ($1, $2, $3, $4)`,
              [code, t.id, t.name, 0]);
          }
        } catch (e) { console.error("DB Create Error:", e); }
      }

      // שליחת מייל (לא קריטי אם נכשל, לכן אין await שחוסם)
      sendNewGameEmail(game);

      callback({ ok: true, gameCode: code, game: sanitizeGame(game) });

    } catch (err) {
      console.error("CreateGame Error:", err);
      callback({ ok: false, error: "Server Error" });
    }
  });

  socket.on("joinGame", async (data, callback) => {
    try {
      const { gameCode, name, teamId } = data || {};
      const code = (gameCode || "").toUpperCase().trim();
      const game = games[code];
      if (!game) return callback({ ok: false, error: "המשחק לא נמצא (אולי נסגר)." });

      const playerName = (name || "").trim();
      if (!playerName) return callback({ ok: false, error: "שם חסר." });

      let chosenTeamId = teamId;
      if (!chosenTeamId && data.teamName) {
         const entry = Object.entries(game.teams).find(([k,v]) => v.name === data.teamName);
         if(entry) chosenTeamId = entry[0];
      }
      if (!chosenTeamId || !game.teams[chosenTeamId]) {
         const keys = Object.keys(game.teams);
         if(keys.length) chosenTeamId = keys[0];
         else return callback({ok:false, error:"No teams"});
      }

      const clientId = socket.id;
      const isHost = (socket.id === game.hostSocketId);
      // תפיסת IP
      const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

      game.playersByClientId[clientId] = { clientId, name: playerName, teamId: chosenTeamId, isHost, ip: clientIp };
      if(!game.teams[chosenTeamId].players.includes(clientId)) {
          game.teams[chosenTeamId].players.push(clientId);
      }

      if (dbReady && pool) {
        try {
          await pool.query(`INSERT INTO game_players (game_code, client_id, name, team_id, ip_address) VALUES ($1, $2, $3, $4, $5)`,
            [code, clientId, playerName, chosenTeamId, clientIp]);
        } catch (e) {}
      }

      socket.join("game-" + code);
      callback({ ok: true, game: sanitizeGame(game), clientId, teamId: chosenTeamId, teamName: game.teams[chosenTeamId].name, isHost });
      broadcastGame(game);

    } catch (err) {
      console.error("JoinGame Error:", err);
      callback({ ok: false, error: "Join Error" });
    }
  });

  socket.on("hostReconnect", (data, callback) => {
      const code = (data?.gameCode || "").toUpperCase().trim();
      const game = games[code];
      if(!game) return callback({ok:false, error:"Not found"});
      
      if(game.hostName) game.hostSocketId = socket.id;
      socket.join("game-" + code);
      callback({ ok: true, game: sanitizeGame(game) });
  });

  socket.on("getGameState", (data, callback) => {
      const code = (data?.gameCode || "").toUpperCase().trim();
      if(games[code]) callback({ ok: true, game: sanitizeGame(games[code]) });
      else callback({ ok: false });
  });

  socket.on("startRound", async (data, callback) => {
      const game = games[data.gameCode];
      if(!game) return callback({ok:false});
      
      clearRoundTimer(data.gameCode);
      const team = game.teams[data.teamId];
      if(!team) return callback({ok:false});

      // בחירת מסביר
      let explainer = null;
      const pIds = team.players;
      if(data.explainerClientId) {
          if(pIds.includes(data.explainerClientId)) explainer = data.explainerClientId;
      }
      if(!explainer && pIds.length > 0) {
          explainer = pIds[Math.floor(Math.random() * pIds.length)];
      }
      if(!explainer) return callback({ok:false, error: "No players"});

      const pObj = game.playersByClientId[explainer];
      const now = new Date();
      
      game.currentRound = {
          teamId: data.teamId,
          explainerId: explainer,
          explainerName: pObj ? pObj.name : "Unknown",
          secondsLeft: parseInt(data.roundSeconds) || 60,
          active: true, isActive: true, roundScore: 0, startedAt: now.toISOString()
      };
      
      broadcastGame(game);
      io.to("game-" + game.code).emit("roundStarted", { game: sanitizeGame(game) });

      roundTimers[game.code] = setInterval(() => {
          if(!game.currentRound) { clearRoundTimer(game.code); return; }
          game.currentRound.secondsLeft--;
          if(game.currentRound.secondsLeft <= 0) {
              finishRound(game.code, {reason:"timer"});
          } else {
              io.to("game-" + game.code).emit("roundTick", { gameCode: game.code, secondsLeft: game.currentRound.secondsLeft });
          }
      }, 1000);
      
      callback({ok:true});
  });

  socket.on("changeRoundScore", (data, cb) => {
      const game = games[data.gameCode];
      if(game && game.currentRound && game.currentRound.active) {
          const d = parseInt(data.delta) || 0;
          game.currentRound.roundScore = Math.max(0, (game.currentRound.roundScore || 0) + d);
          cb({ok:true});
          broadcastGame(game);
      }
  });

  socket.on("getNextWord", (data, cb) => {
      const game = games[data.gameCode];
      if(game && game.currentRound) {
          const w = getRandomWord(game.categories);
          cb({ok:true, word: w.text, category: w.category});
      }
  });

  socket.on("endRound", (data) => {
      finishRound(data.gameCode, {reason:"manual"});
  });

  socket.on("endGame", (data, cb) => {
      const code = data.gameCode;
      if(games[code]) {
          clearRoundTimer(code);
          delete games[code];
          if(dbReady && pool) {
              pool.query(`DELETE FROM games WHERE code=$1`, [code]).catch(()=>{});
              pool.query(`DELETE FROM game_players WHERE game_code=$1`, [code]).catch(()=>{});
              pool.query(`DELETE FROM game_teams WHERE game_code=$1`, [code]).catch(()=>{});
          }
          io.to("game-" + code).emit("gameEnded", { code });
          cb({ok:true});
      }
  });

  socket.on("removePlayer", (data, cb) => {
      const game = games[data.gameCode];
      if(!game) return cb({ok:false});
      
      const pid = data.clientId;
      const p = game.playersByClientId[pid];
      if(p) {
          delete game.playersByClientId[pid];
          if(game.teams[p.teamId]) {
              game.teams[p.teamId].players = game.teams[p.teamId].players.filter(id=>id!==pid);
          }
          if(dbReady && pool) {
              pool.query(`DELETE FROM game_players WHERE game_code=$1 AND client_id=$2`, [game.code, pid]).catch(()=>{});
          }
          if(game.currentRound && game.currentRound.explainerId === pid) {
              finishRound(game.code, {reason:"player_disconnected"});
          } else {
              broadcastGame(game);
          }
      }
      cb({ok:true});
  });

  socket.on("disconnect", () => {
      const pid = socket.id;
      Object.values(games).forEach(g => {
          if(g.hostSocketId === pid) return; // לא מוחקים מנהל
          if(g.playersByClientId[pid]) {
              const p = g.playersByClientId[pid];
              delete g.playersByClientId[pid];
              if(g.teams[p.teamId]) {
                  g.teams[p.teamId].players = g.teams[p.teamId].players.filter(id=>id!==pid);
              }
              if(dbReady && pool) {
                  pool.query(`DELETE FROM game_players WHERE game_code=$1 AND client_id=$2`, [g.code, pid]).catch(()=>{});
              }
              if(g.currentRound && g.currentRound.explainerId === pid) {
                  finishRound(g.code, {reason:"player_disconnected"});
              } else {
                  broadcastGame(g);
              }
          }
      });
  });
});

// ----------------------
//   Admin API
// ----------------------

app.get("/admin/stats", async (req, res) => {
  const code = req.query.code || "";
  if (code !== ADMIN_CODE) return res.status(403).json({ error: "Forbidden" });

  let dbStats = { gamesByDay: [], totalUniqueIps: 0 };

  if (dbReady && pool) {
    try {
      const gamesRes = await pool.query(`
        SELECT TO_CHAR(created_at, 'DD/MM') as date, COUNT(*) as count
        FROM games
        WHERE created_at > NOW() - INTERVAL '30 days'
        GROUP BY date, TO_CHAR(created_at, 'YYYY-MM-DD')
        ORDER BY TO_CHAR(created_at, 'YYYY-MM-DD') ASC
      `);
      dbStats.gamesByDay = gamesRes.rows;

      const ipRes = await pool.query(`SELECT COUNT(DISTINCT ip_address) as count FROM game_players`);
      dbStats.totalUniqueIps = ipRes.rows[0].count;
    } catch (e) { console.error("Stats DB Error", e); }
  }

  const activeGames = Object.values(games).map(g => ({
    code: g.code,
    hostName: g.hostName,
    playerCount: Object.keys(g.playersByClientId).length,
    teamCount: Object.keys(g.teams).length,
    createdAt: g.createdAt,
    players: Object.values(g.playersByClientId)
  }));

  res.json({ activeGames, dbStats });
});

app.post("/admin/game/:gameCode/close", (req, res) => {
    if (req.query.code !== ADMIN_CODE) return res.status(403).send();
    const code = req.params.gameCode;
    if(games[code]) {
        clearRoundTimer(code);
        delete games[code];
        io.to("game-" + code).emit("gameEnded", { code });
        if(dbReady && pool) {
             pool.query(`DELETE FROM games WHERE code=$1`, [code]).catch(()=>{});
        }
        res.json({ok:true});
    } else res.status(404).send();
});

app.post("/admin/game/:gameCode/player/:clientId/disconnect", (req, res) => {
    if (req.query.code !== ADMIN_CODE) return res.status(403).send();
    const {gameCode, clientId} = req.params;
    const g = games[gameCode];
    if(g && g.playersByClientId[clientId]) {
        const p = g.playersByClientId[clientId];
        delete g.playersByClientId[clientId];
        if(g.teams[p.teamId]) g.teams[p.teamId].players = g.teams[p.teamId].players.filter(id=>id!==clientId);
        broadcastGame(g);
        res.json({ok:true});
    } else res.status(404).send();
});

app.get("/api/banners", (req, res) => res.json({}));

server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
