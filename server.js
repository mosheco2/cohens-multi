// server.js - מילמניה: הגרסה המלאה (כולל סטטיסטיקות, IP, ומיילים)

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
// יש להגדיר משתני סביבה בשרת (Render) או להזין פרטים ידנית כאן אם זה לשימוש אישי
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER, // המייל שלך
    pass: process.env.EMAIL_PASS  // סיסמת אפליקציה
  }
});

// פונקציה לשליחת התראה למנהל
async function sendNewGameEmail(gameInfo) {
  // אם אין הגדרות מייל, דלג
  if (!process.env.EMAIL_USER) return; 

  try {
    await transporter.sendMail({
      from: '"Millmania Bot" <no-reply@millmania.com>',
      to: process.env.ADMIN_EMAIL || process.env.EMAIL_USER, 
      subject: `🚀 משחק חדש נפתח: ${gameInfo.code}`,
      html: `
        <div style="direction: rtl; font-family: sans-serif;">
          <h2>משחק חדש יצא לדרך!</h2>
          <p><strong>קוד משחק:</strong> ${gameInfo.code}</p>
          <p><strong>מנהל:</strong> ${gameInfo.hostName}</p>
          <p><strong>זמן:</strong> ${new Date().toLocaleString("he-IL")}</p>
          <p>בהצלחה!</p>
        </div>
      `,
    });
    console.log(`📧 Email sent for game ${gameInfo.code}`);
  } catch (error) {
    console.error("❌ Error sending email:", error);
  }
}

// ----------------------
//   Static & JSON
// ----------------------

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ----------------------
//   Postgres DB Init
// ----------------------

let pool = null;
let dbReady = false;

async function initDb() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.log("⚠️ No DATABASE_URL provided. Running without Postgres.");
    return;
  }

  try {
    pool = new Pool({
      connectionString,
      ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
    });

    // משחקים
    await pool.query(`
      CREATE TABLE IF NOT EXISTS games (
        code TEXT PRIMARY KEY,
        host_name TEXT NOT NULL,
        target_score INTEGER NOT NULL,
        default_round_seconds INTEGER NOT NULL,
        categories TEXT[] NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // קבוצות
    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_teams (
        id SERIAL PRIMARY KEY,
        game_code TEXT NOT NULL,
        team_id TEXT NOT NULL,
        team_name TEXT NOT NULL,
        score INTEGER NOT NULL DEFAULT 0
      );
    `);

    // שחקנים (כולל IP)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_players (
        id SERIAL PRIMARY KEY,
        game_code TEXT NOT NULL,
        client_id TEXT NOT NULL,
        name TEXT NOT NULL,
        team_id TEXT NOT NULL,
        ip_address TEXT
      );
    `);
    
    // וידוא עמודת IP לטבלאות קיימות (למקרה שהטבלה נוצרה בגרסאות קודמות)
    try {
        await pool.query(`ALTER TABLE game_players ADD COLUMN IF NOT EXISTS ip_address TEXT;`);
    } catch (e) {}

    dbReady = true;
    console.log("✅ Postgres ready.");
  } catch (err) {
    console.error("❌ Failed to init Postgres:", err);
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
    if (filtered.length > 0) {
      pool = filtered;
    }
  }
  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx];
}

// ----------------------
//   Utils & Logic
// ----------------------

function generateGameCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function sanitizeGame(game) {
  if (!game) return null;

  const teams = {};
  Object.entries(game.teams || {}).forEach(([teamId, t]) => {
    teams[teamId] = {
      id: t.id || teamId,
      name: t.name,
      score: t.score || 0,
      players: Array.isArray(t.players) ? [...t.players] : [],
    };
  });

  const playersByClientId = {};
  Object.entries(game.playersByClientId || {}).forEach(([cid, p]) => {
    playersByClientId[cid] = {
      clientId: cid,
      name: p.name,
      teamId: p.teamId,
      isHost: p.isHost || false,
    };
  });

  return {
    code: game.code,
    hostName: game.hostName,
    targetScore: game.targetScore,
    defaultRoundSeconds: game.defaultRoundSeconds,
    categories: game.categories || [],
    createdAt: game.createdAt,
    updatedAt: game.updatedAt,
    lastActivity: game.lastActivity,
    logoUrl: game.logoUrl || null,
    banners: game.banners || {},
    teams,
    playersByClientId,
    currentRound: game.currentRound || null,
  };
}

function broadcastGame(game) {
  if (!game || !game.code) return;
  io.to("game-" + game.code).emit("gameUpdated", sanitizeGame(game));
}

function clearRoundTimer(gameCode) {
  if (roundTimers[gameCode]) {
    clearInterval(roundTimers[gameCode]);
    delete roundTimers[gameCode];
  }
}

async function finishRound(gameCode, options = { reason: "manual" }) {
  const code = (gameCode || "").toUpperCase().trim();
  const game = games[code];
  if (!game || !game.currentRound) return;

  const round = game.currentRound;
  round.active = false;
  round.isActive = false;
  clearRoundTimer(code);

  const teamId = round.teamId;
  const roundScore =
    typeof round.roundScore === "number" && round.roundScore > 0
      ? round.roundScore
      : 0;

  // צבירת ניקוד לקבוצה
  if (teamId && game.teams[teamId]) {
    game.teams[teamId].score =
      (game.teams[teamId].score || 0) + roundScore;
  }

  game.lastActivity = new Date();
  game.updatedAt = new Date();

  // עדכון DB
  if (dbReady && pool && teamId && game.teams[teamId]) {
    try {
      await pool.query(
        `UPDATE game_teams SET score = $1 WHERE game_code = $2 AND team_id = $3`,
        [game.teams[teamId].score, code, teamId]);
    } catch (err) {
      console.error("Error updating team score at round end:", err);
    }
  }

  const totalScore = teamId && game.teams[teamId] ? game.teams[teamId].score : 0;

  console.log(`⏹️ Round ended in game ${code}, team ${teamId}, roundScore=${roundScore}`);

  // עדכון משחק מלא למסכים
  broadcastGame(game);

  // אירוע כללי לסיום סיבוב
  io.to("game-" + code).emit("roundFinished", {
    teamId,
    roundScore,
    totalScore,
    reason: options.reason || "manual",
  });

  // תאימות לפופ־אפ של סוף זמן
  if (options.reason === "timer") {
    const teamName =
      teamId && game.teams[teamId]
        ? game.teams[teamId].name
        : `קבוצה ${teamId || ""}`;

    io.to("game-" + code).emit("roundTimeUp", {
      code,
      roundScore,
      teamId,
      teamName,
      totalScore: totalScore || 0,
    });
}

game.currentRound = null;
}

// ----------------------
//   Socket.io
// ----------------------

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // יצירת משחק
  socket.on("createGame", async (data, callback) => {
    try {
      const {
        hostName,
        targetScore = 40,
        defaultRoundSeconds = 60,
        categories = [],
        teamNames = {},
      } = data || {};

      if (!hostName || !hostName.trim()) {
        return callback && callback({ ok: false, error: "נא להזין שם מנהל." });
      }

      let code;
      do {
        code = generateGameCode();
      } while (games[code]);

      const teams = {};
      const now = new Date();

      ["A", "B", "C", "D", "E"].forEach((id) => {
        const name = (teamNames[id] || "").trim();
        if (name) {
          teams[id] = { id, name, score: 0, players: [] };
        }
      });

      if (Object.keys(teams).length === 0) {
        teams["A"] = { id: "A", name: "קבוצה A", score: 0, players: [] };
        teams["B"] = { id: "B", name: "קבוצה B", score: 0, players: [] };
      }

      const game = {
        code,
        hostSocketId: socket.id,
        hostName: hostName.trim(),
        targetScore: parseInt(targetScore, 10) || 40,
        defaultRoundSeconds: parseInt(defaultRoundSeconds, 10) || 60,
        categories: Array.isArray(categories) ? categories : [],
        createdAt: now,
        updatedAt: now,
        lastActivity: now,
        logoUrl: null,
        banners: {},
        teams,
        playersByClientId: {},
        currentRound: null,
      };

      games[code] = game;
      socket.join("game-" + code);

      if (dbReady && pool) {
        try {
          await pool.query(
            `INSERT INTO games (code, host_name, target_score, default_round_seconds, categories) VALUES ($1, $2, $3, $4, $5)`,
            [game.code, game.hostName, game.targetScore, game.defaultRoundSeconds, game.categories]
          );
          const teamEntries = Object.values(game.teams);
          for (const t of teamEntries) {
            await pool.query(
              `INSERT INTO game_teams (game_code, team_id, team_name, score) VALUES ($1, $2, $3, $4)`,
              [game.code, t.id, t.name, t.score]
            );
          }
        } catch (err) {
          console.error("Error persisting game:", err);
        }
      }

      // שליחת מייל התראה למנהל האתר
      sendNewGameEmail(game);

      console.log(`🎮 New game created: ${code} by host ${game.hostName}`);

      callback &&
        callback({
          ok: true,
          gameCode: code,
          game: sanitizeGame(game),
        });
    } catch (err) {
      console.error("Error in createGame:", err);
      callback && callback({ ok: false, error: "שגיאה ביצירת המשחק." });
    }
  });

  // הצטרפות למשחק כשחקן (עם תפיסת IP)
  socket.on("joinGame", async (data, callback) => {
    try {
      const { gameCode, name, teamId } = data || {};
      const code = (gameCode || "").toUpperCase().trim();
      const game = games[code];

      if (!game) {
        return callback && callback({ ok: false, error: "המשחק לא נמצא." });
      }

      const playerName = (name || "").trim();
      if (!playerName) {
        return callback && callback({ ok: false, error: "נא להזין שם שחקן." });
      }

      let chosenTeamId = (teamId || "").trim();
      if ((!chosenTeamId || !game.teams[chosenTeamId]) && data.teamName) {
        const targetName = (data.teamName || "").trim();
        const foundEntry = Object.entries(game.teams).find(
          ([tid, t]) => t.name === targetName
        );
        if (foundEntry) chosenTeamId = foundEntry[0];
      }
      if (!chosenTeamId || !game.teams[chosenTeamId]) {
        const teamIds = Object.keys(game.teams || {});
        if (!teamIds.length) {
          return callback && callback({ ok: false, error: "אין קבוצות פעילות במשחק." });
        }
        chosenTeamId = teamIds[0];
      }

      const clientId = socket.id;
      const isHost = (socket.id === game.hostSocketId);
      
      // קבלת ה-IP
      const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

      game.playersByClientId[clientId] = {
        clientId,
        name: playerName,
        teamId: chosenTeamId,
        isHost: isHost,
        ip: clientIp // שמירת IP בזיכרון
      };

      if (!Array.isArray(game.teams[chosenTeamId].players)) {
        game.teams[chosenTeamId].players = [];
      }
      if (!game.teams[chosenTeamId].players.includes(clientId)) {
        game.teams[chosenTeamId].players.push(clientId);
      }

      game.lastActivity = new Date();
      game.updatedAt = new Date();

      if (dbReady && pool) {
        try {
          await pool.query(
            `INSERT INTO game_players (game_code, client_id, name, team_id, ip_address) VALUES ($1, $2, $3, $4, $5)`,
            [code, clientId, playerName, chosenTeamId, clientIp]
          );
        } catch (err) {
          console.error("Error persisting game player:", err);
        }
      }

      socket.join("game-" + code);

      callback &&
        callback({
          ok: true,
          game: sanitizeGame(game),
          clientId,
          teamId: chosenTeamId,
          teamName: game.teams[chosenTeamId].name,
          isHost: isHost
        });

      broadcastGame(game);
    } catch (err) {
      console.error("Error in joinGame:", err);
      callback && callback({ ok: false, error: "שגיאה בהצטרפות למשחק." });
    }
  });

  // הסרת שחקן דרך Socket
  socket.on("removePlayer", async (data, callback) => {
    try {
      const { gameCode, clientId } = data || {};
      const code = (gameCode || "").toUpperCase().trim();
      const game = games[code];
      if (!game) return callback && callback({ ok: false, error: "המשחק לא נמצא." });

      const player = game.playersByClientId[clientId];
      if (!player) return callback && callback({ ok: false, error: "השחקן לא נמצא." });

      const teamId = player.teamId;
      delete game.playersByClientId[clientId];

      if (teamId && game.teams[teamId] && Array.isArray(game.teams[teamId].players)) {
        game.teams[teamId].players = game.teams[teamId].players.filter(pId => pId !== clientId);
      }

      if (dbReady && pool) {
        try {
          await pool.query(`DELETE FROM game_players WHERE game_code = $1 AND client_id = $2`, [code, clientId]);
        } catch (err) { console.error("Error deleting game player:", err); }
      }

      if (game.currentRound && game.currentRound.explainerId === clientId) {
        await finishRound(code, { reason: "player_disconnected" });
      } else {
        game.updatedAt = new Date();
        game.lastActivity = new Date();
        broadcastGame(game);
      }

      callback && callback({ ok: true, game: sanitizeGame(game) });
    } catch (err) {
      console.error("Error in removePlayer:", err);
      callback && callback({ ok: false, error: "שגיאה בהסרת שחקן." });
    }
  });

  // עדכון ניקוד קבוצה
  socket.on("updateScore", async (data, callback) => {
    try {
      const { gameCode, teamId, delta } = data || {};
      const code = (gameCode || "").toUpperCase().trim();
      const game = games[code];

      if (!game || !game.teams[teamId]) return callback && callback({ ok: false, error: "המשחק/קבוצה לא נמצאו." });

      const change = parseInt(delta, 10) || 0;
      game.teams[teamId].score = Math.max(0, (game.teams[teamId].score || 0) + change);
      game.updatedAt = new Date();
      game.lastActivity = new Date();

      if (dbReady && pool) {
        try {
          await pool.query(`UPDATE game_teams SET score = $1 WHERE game_code = $2 AND team_id = $3`, [game.teams[teamId].score, code, teamId]);
        } catch (err) { console.error("Error updating team score:", err); }
      }

      broadcastGame(game);
      callback && callback({ ok: true, game: sanitizeGame(game) });
    } catch (err) {
      console.error("Error in updateScore:", err);
      callback && callback({ ok: false, error: "שגיאה בעדכון ניקוד הקבוצה." });
    }
  });

  // התחלת סיבוב
  socket.on("startRound", async (data, callback) => {
    try {
      const { gameCode, teamId, roundSeconds, explainerClientId } = data || {};
      const code = (gameCode || "").toUpperCase().trim();
      const game = games[code];
      if (!game) return callback && callback({ ok: false, error: "המשחק לא נמצא." });

      let chosenTeamId = (teamId || "").trim();
      if (!chosenTeamId || !game.teams[chosenTeamId]) {
        const teamIds = Object.keys(game.teams || {});
        if (!teamIds.length) return callback && callback({ ok: false, error: "אין קבוצות." });
        chosenTeamId = teamIds[0];
      }

      clearRoundTimer(code);

      const team = game.teams[chosenTeamId];
      const playersInTeam = (team.players || []).map(clientId => game.playersByClientId[clientId]);
      if (!playersInTeam.length) return callback && callback({ ok: false, error: "אין שחקנים בקבוצה שנבחרה." });

      let explainingPlayer = null;
      if (explainerClientId) {
        explainingPlayer = playersInTeam.find(p => p && p.clientId === explainerClientId);
      }
      if (!explainingPlayer) {
        explainingPlayer = playersInTeam[Math.floor(Math.random() * playersInTeam.length)];
      }

      const totalSeconds = parseInt(roundSeconds, 10) || game.defaultRoundSeconds || 60;
      const now = new Date();

      game.currentRound = {
        teamId: chosenTeamId,
        explainerId: explainingPlayer.clientId,
        explainerName: explainingPlayer.name,
        secondsLeft: totalSeconds,
        active: true,
        isActive: true,
        roundScore: 0,
        startedAt: now.toISOString(),
      };

      game.updatedAt = now;
      game.lastActivity = now;

      io.to("game-" + code).emit("roundStarted", {
        game: sanitizeGame(game),
      });

      broadcastGame(game);

      roundTimers[code] = setInterval(() => {
        const g = games[code];
        if (!g || !g.currentRound) {
          clearRoundTimer(code);
          return;
        }

        g.currentRound.secondsLeft -= 1;
        if (g.currentRound.secondsLeft <= 0) {
          finishRound(code, { reason: "timer" });
        } else {
          io.to("game-" + code).emit("roundTick", {
            gameCode: code,
            secondsLeft: g.currentRound.secondsLeft,
          });
        }
      }, 1000);

      callback && callback({ ok: true, game: sanitizeGame(game) });
    } catch (err) {
      console.error("Error in startRound:", err);
      callback && callback({ ok: false, error: "שגיאה בתחילת סיבוב." });
    }
  });

  // ניקוד סיבוב
  socket.on("changeRoundScore", (data, callback) => {
    try {
      const { gameCode, delta } = data || {};
      const code = (gameCode || "").toUpperCase().trim();
      const game = games[code];
      if (!game || !game.currentRound || !game.currentRound.active) {
        return callback && callback({ ok: false, error: "אין סיבוב פעיל." });
      }

      const d = parseInt(delta, 10) || 0;
      if (typeof game.currentRound.roundScore !== "number") {
        game.currentRound.roundScore = 0;
      }
      game.currentRound.roundScore += d;
      if (game.currentRound.roundScore < 0) {
        game.currentRound.roundScore = 0;
      }
      game.lastActivity = new Date();

      callback && callback({ ok: true, roundScore: game.currentRound.roundScore });
      broadcastGame(game);
    } catch (err) {
      console.error("Error in changeRoundScore:", err);
      callback && callback({ ok: false, error: "שגיאה בעדכון ניקוד." });
    }
  });

  // מילה חדשה
  socket.on("getNextWord", (data, callback) => {
    try {
      const { gameCode } = data || {};
      const code = (gameCode || "").toUpperCase().trim();
      const game = games[code];
      if (!game || !game.currentRound || !game.currentRound.active) {
        return callback && callback({ ok: false, error: "אין סיבוב פעיל." });
      }

      const word = getRandomWord(game.categories || []);
      callback && callback({ ok: true, word: word.text, category: word.category });
    } catch (err) {
      console.error("Error in getNextWord:", err);
      callback && callback({ ok: false, error: "שגיאה בקבלת מילה." });
    }
  });

  // סיום סיבוב ידני
  socket.on("endRound", async (data, callback) => {
    try {
      const { gameCode } = data || {};
      await finishRound(gameCode, { reason: "manual" });
      callback && callback({ ok: true });
    } catch (err) {
      console.error("Error in endRound:", err);
      callback && callback({ ok: false, error: "שגיאה בסיום סיבוב." });
    }
  });

  // סיום משחק ע"י המנהל
  socket.on("endGame", async (data, callback) => {
    try {
      const { gameCode } = data || {};
      const code = (gameCode || "").toUpperCase().trim();
      const game = games[code];
      if (!game) return callback && callback({ ok: false, error: "המשחק לא נמצא." });

      clearRoundTimer(code);
      delete games[code];

      if (dbReady && pool) {
        try {
          await pool.query(`DELETE FROM game_players WHERE game_code = $1;`, [code]);
          await pool.query(`DELETE FROM game_teams WHERE game_code = $1;`, [code]);
          await pool.query(`DELETE FROM games WHERE code = $1;`, [code]);
        } catch (err) {
          console.error("Error cleaning game from DB:", err);
        }
      }

      io.to("game-" + code).emit("gameEnded", { code });
      callback && callback({ ok: true });
      console.log(`🛑 Game ended: ${code}`);
    } catch (err) {
      console.error("Error in endGame:", err);
      callback && callback({ ok: false, error: "שגיאה בסיום משחק." });
    }
  });

  // מצב משחק מלא
  socket.on("getGameState", (data, callback) => {
    try {
      const code = ((data && data.gameCode) || "").toUpperCase().trim();
      const game = games[code];
      if (!game) return callback && callback({ ok: false, error: "המשחק לא נמצא." });
      callback && callback({ ok: true, game: sanitizeGame(game) });
    } catch (err) {
      console.error("Error in getGameState:", err);
      callback && callback({ ok: false, error: "שגיאה בקבלת מצב המשחק." });
    }
  });

  // שחזור חיבור מנהל
  socket.on("hostReconnect", (data, callback) => {
    try {
      const code = ((data && data.gameCode) || "").toUpperCase().trim();
      const game = games[code];
      if (!game) {
        return callback && callback({ ok: false, error: "המשחק לא נמצא (אולי השרת הופעל מחדש)." });
      }
      // אם המנהל מתחבר מחדש
      if (game.hostName) {
          game.hostSocketId = socket.id;
      }
      // חיבור מחדש לחדר לקבלת עדכונים
      socket.join("game-" + code);

      callback && callback({ ok: true, game: sanitizeGame(game) });
    } catch (err) {
      console.error("Error in hostReconnect:", err);
      callback && callback({ ok: false, error: "שגיאה בשחזור חיבור." });
    }
  });

  // ניתוק Socket
  socket.on("disconnect", async () => {
    try {
      console.log("Client disconnected:", socket.id);

      for (const code of Object.keys(games)) {
        const game = games[code];
        if (!game) continue;

        // מנהל התנתק - לא מוחקים, נותנים לו להתחבר מחדש
        if (game.hostSocketId === socket.id) continue;

        const player = game.playersByClientId ? game.playersByClientId[socket.id] : null;
        if (!player) continue;

        const clientId = socket.id;
        const teamId = player.teamId;

        delete game.playersByClientId[clientId];

        if (teamId && game.teams[teamId] && Array.isArray(game.teams[teamId].players)) {
          game.teams[teamId].players = game.teams[teamId].players.filter(pId => pId !== clientId);
        }

        game.lastActivity = new Date();
        game.updatedAt = new Date();

        if (dbReady && pool) {
          try {
            await pool.query(`DELETE FROM game_players WHERE game_code = $1 AND client_id = $2`, [code, clientId]);
          } catch (err) { console.error("Error deleting game player on disconnect:", err); }
        }

        // אם זה היה המסביר
        if (game.currentRound && game.currentRound.explainerId === clientId) {
          await finishRound(code, { reason: "player_disconnected" });
        } else {
          broadcastGame(game);
        }
      }
    } catch (err) {
      console.error("Error in disconnect handler:", err);
    }
  });
});

// ----------------------
//   Admin API (חדש!)
// ----------------------

app.get("/admin/stats", async (req, res) => {
  const code = req.query.code || "";
  if (code !== ADMIN_CODE) return res.status(403).json({ error: "Forbidden" });

  let dbStats = { gamesByDay: [], totalUniqueIps: 0 };

  if (dbReady && pool) {
    try {
      // משחקים לפי יום (30 ימים אחרונים)
      const gamesRes = await pool.query(`
        SELECT TO_CHAR(created_at, 'DD/MM') as date, COUNT(*) as count
        FROM games
        WHERE created_at > NOW() - INTERVAL '30 days'
        GROUP BY date, TO_CHAR(created_at, 'YYYY-MM-DD')
        ORDER BY TO_CHAR(created_at, 'YYYY-MM-DD') ASC
      `);
      dbStats.gamesByDay = gamesRes.rows;

      // יוניקים לפי IP
      const ipRes = await pool.query(`SELECT COUNT(DISTINCT ip_address) as count FROM game_players`);
      dbStats.totalUniqueIps = ipRes.rows[0].count;

    } catch (e) { console.error("DB Stats error", e); }
  }

  // משחקים פעילים בזכרון
  const activeGames = Object.values(games).map(g => {
      const pList = Object.values(g.playersByClientId || {});
      return {
        code: g.code,
        hostName: g.hostName,
        playerCount: pList.length,
        teamCount: Object.keys(g.teams || {}).length,
        createdAt: g.createdAt,
        players: pList
      };
  });

  res.json({ activeGames, dbStats });
});

// סגירת משחק (Admin API)
app.post("/admin/game/:gameCode/close", async (req, res) => {
  const adminCode = req.query.code || "";
  if (adminCode !== ADMIN_CODE) return res.status(403).json({ ok: false });

  const code = (req.params.gameCode || "").toUpperCase().trim();
  if (!games[code]) return res.status(404).json({ ok: false });

  clearRoundTimer(code);
  delete games[code];

  if (dbReady && pool) {
      try {
        await pool.query(`DELETE FROM game_players WHERE game_code=$1`, [code]);
        await pool.query(`DELETE FROM game_teams WHERE game_code=$1`, [code]);
        await pool.query(`DELETE FROM games WHERE code=$1`, [code]);
      } catch(e){}
  }
  io.to("game-"+code).emit("gameEnded", {code});
  res.json({ok:true});
});

// ניתוק שחקן (Admin API)
app.post("/admin/game/:gameCode/player/:clientId/disconnect", async (req, res) => {
  const adminCode = req.query.code || "";
  if (adminCode !== ADMIN_CODE) return res.status(403).json({ ok: false });

  const code = (req.params.gameCode || "").toUpperCase().trim();
  const clientId = req.params.clientId;
  const game = games[code];

  if(!game || !game.playersByClientId[clientId]) return res.status(404).json({ok:false});

  const p = game.playersByClientId[clientId];
  const teamId = p.teamId;
  delete game.playersByClientId[clientId];
  
  if(teamId && game.teams[teamId]) {
      game.teams[teamId].players = game.teams[teamId].players.filter(id=>id!==clientId);
  }

  if(dbReady && pool) {
      try { await pool.query(`DELETE FROM game_players WHERE game_code=$1 AND client_id=$2`, [code, clientId]); } catch(e){}
  }

  if(game.currentRound && game.currentRound.explainerId === clientId) {
      finishRound(code, {reason:"player_disconnected"});
  } else {
      broadcastGame(game);
  }
  
  res.json({ok:true});
});

app.get("/api/banners", (req, res) => { res.json({}); });

// ----------------------
//   Start server
// ----------------------

server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
