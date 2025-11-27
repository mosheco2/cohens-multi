// server.js - גרסה מעודכנת (סטטיסטיקות מתקדמות, סינון תאריכים, IP, דיבאג למייל)

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

// ----------------------
//   הגדרות אימייל
// ----------------------
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER, 
    pass: process.env.EMAIL_PASS
  }
});

// בדיקת סטטוס מייל בהפעלה
if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn("⚠️ EMAIL_USER or EMAIL_PASS is missing in Environment Variables! Emails will NOT be sent.");
} else {
    console.log("✅ Email configuration detected for: " + process.env.EMAIL_USER);
}

async function sendNewGameEmail(gameInfo) {
  if (!process.env.EMAIL_USER) return; 

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
    console.log("⚠️ No DATABASE_URL provided. Running in-memory only.");
    return;
  }

  try {
    pool = new Pool({
      connectionString,
      ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
    });

    // יצירת טבלאות
    await pool.query(`CREATE TABLE IF NOT EXISTS games (code TEXT PRIMARY KEY, host_name TEXT NOT NULL, target_score INTEGER, default_round_seconds INTEGER, categories TEXT[], created_at TIMESTAMPTZ DEFAULT NOW());`);
    await pool.query(`CREATE TABLE IF NOT EXISTS game_teams (id SERIAL PRIMARY KEY, game_code TEXT, team_id TEXT, team_name TEXT, score INTEGER DEFAULT 0);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS game_players (id SERIAL PRIMARY KEY, game_code TEXT, client_id TEXT, name TEXT, team_id TEXT, ip_address TEXT, created_at TIMESTAMPTZ DEFAULT NOW());`);
    
    // וידוא עמודות (למקרה של שדרוג)
    try { await pool.query(`ALTER TABLE game_players ADD COLUMN IF NOT EXISTS ip_address TEXT;`); } catch (e) {}
    try { await pool.query(`ALTER TABLE game_players ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`); } catch (e) {}

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
//   Word bank (מקוצר לדוגמה, תשאיר את הרשימה המלאה שלך)
// ----------------------
const WORD_BANK = [
  { text: "חתול", category: "animals" }, { text: "כלב", category: "animals" },
  { text: "פיצה", category: "food" }, { text: "מחשב", category: "technology" }
  // ... (השאר את הרשימה המלאה שיש לך בקובץ המקורי)
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

      let explainer = null;
      const pIds = team.players;
      if(data.explainerClientId && pIds.includes(data.explainerClientId)) {
          explainer = data.explainerClientId;
      }
      if(!explainer && pIds.length > 0) {
          explainer = pIds[Math.floor(Math.random() * p
