// server.js - Wordmania party מילהמניה

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { Pool } = require("pg");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

// ----------------------
//   Basic Config
// ----------------------
const PORT = process.env.PORT || 3000;

// ----------------------
//   Static Files
// ----------------------
app.use(express.static(path.join(__dirname, "public")));

// ----------------------
//   Database (Postgres)
// ----------------------
let dbReady = false;
let pool = null;

(async () => {
  try {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl:
        process.env.NODE_ENV === "production"
          ? { rejectUnauthorized: false }
          : false,
    });

    await pool.query("SELECT 1");
    dbReady = true;
    console.log("✅ Connected to Postgres");

    // יצירת טבלאות אם לא קיימות
    await pool.query(`
      CREATE TABLE IF NOT EXISTS games (
        code TEXT PRIMARY KEY,
        host_name TEXT,
        target_score INTEGER,
        default_round_seconds INTEGER,
        categories TEXT[],
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_teams (
        id SERIAL PRIMARY KEY,
        game_code TEXT REFERENCES games(code),
        team_id TEXT,
        name TEXT,
        score INTEGER DEFAULT 0
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_players (
        id SERIAL PRIMARY KEY,
        game_code TEXT REFERENCES games(code),
        client_id TEXT,
        name TEXT,
        team_id TEXT,
        joined_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS rounds (
        id SERIAL PRIMARY KEY,
        game_code TEXT REFERENCES games(code),
        team_id TEXT,
        explainer_id TEXT,
        explainer_name TEXT,
        started_at TIMESTAMP DEFAULT NOW(),
        ended_at TIMESTAMP,
        round_seconds INTEGER,
        round_score INTEGER DEFAULT 0
      );
    `);

    console.log("✅ DB schema ready");
  } catch (err) {
    console.error("❌ Postgres not ready:", err);
    dbReady = false;
  }
})();

// ----------------------
//   In-memory Storage
// ----------------------

/**
 * games[code] = {
 *   code,
 *   hostSocketId,
 *   hostName,
 *   targetScore,
 *   defaultRoundSeconds,
 *   categories: [],
 *   createdAt,
 *   updatedAt,
 *   lastActivity,
 *   logoUrl,
 *   banners: { host: {...}, player: {...} }
 *   teams: {
 *     A: { id: "A", name: "Team A", score: 0, players: [clientId, ...] },
 *     ...
 *   },
 *   playersByClientId: {
 *     socket.id: { clientId, name, teamId }
 *   },
 *   currentRound: {
 *     active: true,
 *     teamId,
 *     explainerId,
 *     explainerName,
 *     roundSeconds,
 *     startedAt,
 *     endsAt,
 *     secondsLeft,
 *     roundScore
 *   }
 * }
 */
const games = {};
const roundTimers = {};

// ----------------------
//   Utility
// ----------------------

function generateGameCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function sanitizeGame(game) {
  if (!game) return null;
  return {
    code: game.code,
    hostName: game.hostName,
    targetScore: game.targetScore,
    defaultRoundSeconds: game.defaultRoundSeconds,
    categories: game.categories,
    createdAt: game.createdAt,
    updatedAt: game.updatedAt,
    lastActivity: game.lastActivity,
    logoUrl: game.logoUrl || null,
    banners: game.banners || {},
    teams: game.teams,
    players: game.playersByClientId,
    currentRound: game.currentRound,
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

// ----------------------
//   Words / Categories
// ----------------------

// דוגמת מילים – אפשר להחליף בטעינה מקובץ/DB
const WORD_BANK = [
  { text: "חתול", category: "animals" },
  { text: "כלב", category: "animals" },
  { text: "שולחן", category: "objects" },
  { text: "מחשב", category: "technology" },
  { text: "פיצה", category: "food" },
  { text: "משפחה", category: "family" },
  { text: "חופשה", category: "travel" },
  { text: "כדורגל", category: "sports" },
  { text: "סדרה בטלוויזיה", category: "entertainment" },
  { text: "שיר", category: "music" },
  { text: "יער", category: "nature" },
  { text: "חג פסח", category: "holidays" },
  { text: "מורה", category: "school" },
  { text: "בוס", category: "work" },
  { text: "מכונת כביסה", category: "objects" },
];

// החזרת מילה אקראית לפי קטגוריות שנבחרו
function getRandomWord(categories) {
  let pool = WORD_BANK;

  if (Array.isArray(categories) && categories.length > 0) {
    pool = WORD_BANK.filter((w) => categories.includes(w.category));
    if (pool.length === 0) {
      pool = WORD_BANK;
    }
  }

  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx];
}

// ----------------------
//   Socket.io
// ----------------------

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // ----------------------
  //   Create Game
  // ----------------------
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

      // יצירת קוד ייחודי
      let code;
      do {
        code = generateGameCode();
      } while (games[code]);

      const now = new Date();

      const teams = {};
      const teamIds = ["A", "B", "C", "D", "E"];
      teamIds.forEach((id, index) => {
        const nameFromClient = (teamNames[id] || "").trim();
        if (index < 2 || nameFromClient) {
          teams[id] = {
            id,
            name:
              nameFromClient ||
              (id === "A"
                ? "קבוצה A"
                : id === "B"
                ? "קבוצה B"
                : "קבוצה " + id),
            score: 0,
            players: [],
          };
        }
      });

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
            `
            INSERT INTO games (code, host_name, target_score, default_round_seconds, categories)
            VALUES ($1, $2, $3, $4, $5)
          `,
            [
              game.code,
              game.hostName,
              game.targetScore,
              game.defaultRoundSeconds,
              game.categories,
            ]
          );

          const teamEntries = Object.values(game.teams);
          for (const t of teamEntries) {
            await pool.query(
              `
              INSERT INTO game_teams (game_code, team_id, name, score)
              VALUES ($1, $2, $3, $4)
            `,
              [game.code, t.id, t.name, t.score]
            );
          }
        } catch (err) {
          console.error("Error persisting game:", err);
        }
      }

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

  // ----------------------
  //   Join Game
  // ----------------------
  socket.on("joinGame", async (data, callback) => {
    try {
      const { gameCode, name, teamId } = data || {};
      const code = (gameCode || "").toUpperCase().trim();
      if (!games[code]) {
        return callback && callback({ ok: false, error: "המשחק לא נמצא." });
      }
      const game = games[code];

      const playerName = (name || "").trim();
      if (!playerName) {
        return callback && callback({ ok: false, error: "נא להזין שם שחקן." });
      }

      let chosenTeamId = (teamId || "").trim();
      if (!chosenTeamId || !game.teams[chosenTeamId]) {
        const teamIds = Object.keys(game.teams);
        chosenTeamId = teamIds[0];
      }

      const clientId = socket.id;

      game.playersByClientId[clientId] = {
        clientId,
        name: playerName,
        teamId: chosenTeamId,
      };

      if (!game.teams[chosenTeamId].players) {
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
            `
            INSERT INTO game_players (game_code, client_id, name, team_id)
            VALUES ($1, $2, $3, $4)
          `,
            [code, clientId, playerName, chosenTeamId]
          );
        } catch (err) {
          console.error("Error persisting game player:", err);
        }
      }

      console.log(`👤 Player joined: ${playerName} -> game ${code}, team ${chosenTeamId}`);

      callback &&
        callback({
          ok: true,
          game: sanitizeGame(game),
          clientId,
          teamId: chosenTeamId,
        });

      socket.join("game-" + code);
      broadcastGame(game);
    } catch (err) {
      console.error("Error in joinGame:", err);
      callback && callback({ ok: false, error: "שגיאה בהצטרפות למשחק." });
    }
  });

  // ----------------------
  //   Remove Player (by host)
  // ----------------------
  socket.on("removePlayer", async (data, callback) => {
    try {
      const { gameCode, clientId } = data || {};
      const code = (gameCode || "").toUpperCase().trim();
      const game = games[code];
      if (!game) {
        return callback && callback({ ok: false, error: "המשחק לא נמצא." });
      }

      // הסרת שחקן מהמבנה הפנימי
      const player = game.playersByClientId[clientId];
      if (!player) {
        return callback && callback({ ok: false, error: "השחקן לא נמצא במשחק." });
      }

      const teamId = player.teamId;
      delete game.playersByClientId[clientId];

      if (teamId && game.teams[teamId] && Array.isArray(game.teams[teamId].players)) {
        game.teams[teamId].players = game.teams[teamId].players.filter(
          (cid) => cid !== clientId
        );
      }

      game.lastActivity = new Date();
      game.updatedAt = new Date();

      if (dbReady && pool) {
        try {
          await pool.query(
            `
            DELETE FROM game_players
            WHERE game_code = $1 AND client_id = $2
          `,
            [code, clientId]
          );
        } catch (err) {
          console.error("Error deleting game player:", err);
        }
      }

      // אם השחקן מחובר – להוציא אותו מהחדר
      io.to(clientId).emit("removedFromGame", { gameCode: code });

      callback && callback({ ok: true, game: sanitizeGame(game) });
      broadcastGame(game);
    } catch (err) {
      console.error("Error in removePlayer:", err);
      callback && callback({ ok: false, error: "שגיאה בהסרת שחקן." });
    }
  });

  // ----------------------
  //   Get Game State
  // ----------------------
  socket.on("getGameState", (data, callback) => {
    try {
      const code = ((data && data.gameCode) || "").toUpperCase().trim();
      const game = games[code];
      if (!game) {
        return callback && callback({ ok: false, error: "המשחק לא נמצא." });
      }
      callback &&
        callback({
          ok: true,
          game: sanitizeGame(game),
        });
    } catch (err) {
      console.error("Error in getGameState:", err);
      callback && callback({ ok: false, error: "שגיאה בקבלת מצב משחק." });
    }
  });

  // ----------------------
  //   Host Reconnect
  // ----------------------
  socket.on("hostReconnect", (data, callback) => {
    try {
      const code = ((data && data.gameCode) || "").toUpperCase().trim();
      const game = games[code];
      if (!game) {
        return callback && callback({ ok: false, error: "המשחק לא נמצא." });
      }

      // עדכון ה-socketId של המנהל לחיבור הנוכחי
      game.hostSocketId = socket.id;
      socket.join("game-" + code);
      game.lastActivity = new Date();
      game.updatedAt = new Date();

      callback &&
        callback({
          ok: true,
          game: sanitizeGame(game),
        });

      broadcastGame(game);
    } catch (err) {
      console.error("Error in hostReconnect:", err);
      callback && callback({ ok: false, error: "שגיאה בשחזור המנהל." });
    }
  });

  // ----------------------
  //   Start Round
  // ----------------------
  socket.on("startRound", async (data, callback) => {
    try {
      const {
        gameCode,
        teamId,
        roundSeconds,
        explainerClientId,
      } = data || {};

      const code = (gameCode || "").toUpperCase().trim();
      const game = games[code];
      if (!game) {
        return callback && callback({ ok: false, error: "המשחק לא נמצא." });
      }

      const teamIds = Object.keys(game.teams || {});
      if (!teamIds.length) {
        return callback && callback({ ok: false, error: "אין קבוצות במשחק." });
      }

      const tid = teamId && game.teams[teamId] ? teamId : teamIds[0];

      const seconds =
        parseInt(roundSeconds, 10) || game.defaultRoundSeconds || 60;

      const now = new Date();
      const endsAt = new Date(now.getTime() + seconds * 1000);

      const teamPlayers = game.teams[tid].players || [];
      let explainerId = explainerClientId || null;
      let explainerName = "";

      if (!explainerId && teamPlayers.length > 0) {
        explainerId = teamPlayers[0];
      }

      if (explainerId && game.playersByClientId[explainerId]) {
        explainerName = game.playersByClientId[explainerId].name || "";
      }

      game.currentRound = {
        active: true,
        teamId: tid,
        explainerId,
        explainerName,
        roundSeconds: seconds,
        startedAt: now,
        endsAt,
        roundScore: 0,
        secondsLeft: seconds,
      };
      game.lastActivity = now;

      // מפסיקים טיימר קודם (אם היה) ומפעילים חדש לסיבוב הזה
      clearRoundTimer(code);
      roundTimers[code] = setInterval(() => {
        const g = games[code];
        if (!g || !g.currentRound || !g.currentRound.active) {
          clearRoundTimer(code);
          return;
        }
        const nowTs = Date.now();
        const remainingMs = (g.currentRound.endsAt || nowTs) - nowTs;
        const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
        g.currentRound.secondsLeft = remainingSeconds;
        if (remainingSeconds <= 0) {
          g.currentRound.secondsLeft = 0;
          g.currentRound.active = false;
          clearRoundTimer(code);
          io.to("game-" + code).emit("roundTimeUp", {
            code,
            roundScore: g.currentRound.roundScore || 0,
          });
        }
        g.lastActivity = new Date();
        broadcastGame(g);
      }, 1000);

      if (dbReady && pool) {
        try {
          await pool.query(
            `
            INSERT INTO rounds (game_code, team_id, explainer_id, explainer_name, started_at, round_seconds)
            VALUES ($1, $2, $3, $4, $5, $6)
          `,
            [code, tid, explainerId, explainerName, now, seconds]
          );
        } catch (err) {
          console.error("Error logging round start:", err);
        }
      }

      console.log(
        `▶ Round started in game ${code}, team ${tid}, explainerId=${explainerId}, seconds=${seconds}`
      );

      callback && callback({ ok: true });

      io.to("game-" + code).emit("roundStarted", {
        teamId: tid,
        explainerId,
        explainerName,
        roundSeconds: seconds,
      });

      broadcastGame(game);
    } catch (err) {
      console.error("Error in startRound:", err);
      callback && callback({ ok: false, error: "שגיאה בהתחלת סיבוב." });
    }
  });

  // ----------------------
  //   Change Round Score
  // ----------------------
  socket.on("changeRoundScore", async (data, callback) => {
    try {
      const { gameCode, delta } = data || {};
      const code = (gameCode || "").toUpperCase().trim();
      const game = games[code];
      if (!game || !game.currentRound || !game.currentRound.active) {
        return callback && callback({ ok: false, error: "אין סיבוב פעיל." });
      }

      const d = parseInt(delta, 10) || 0;
      game.currentRound.roundScore = (game.currentRound.roundScore || 0) + d;
      game.lastActivity = new Date();

      callback && callback({ ok: true, roundScore: game.currentRound.roundScore });

      broadcastGame(game);
    } catch (err) {
      console.error("Error in changeRoundScore:", err);
      callback && callback({ ok: false, error: "שגיאה בעדכון ניקוד." });
    }
  });

  // ----------------------
  //   Get Next Word
  // ----------------------
  socket.on("getNextWord", (data, callback) => {
    try {
      const { gameCode } = data || {};
      const code = (gameCode || "").toUpperCase().trim();
      const game = games[code];
      if (!game || !game.currentRound || !game.currentRound.active) {
        return callback && callback({ ok: false, error: "אין סיבוב פעיל." });
      }

      const word = getRandomWord(game.categories || []);
      callback &&
        callback({
          ok: true,
          word: word.text,
          category: word.category,
        });
    } catch (err) {
      console.error("Error in getNextWord:", err);
      callback && callback({ ok: false, error: "שגיאה בקבלת מילה." });
    }
  });

  // ----------------------
  //   End Round
  // ----------------------
  socket.on("endRound", async (data, callback) => {
    try {
      const { gameCode } = data || {};
      const code = (gameCode || "").toUpperCase().trim();
      const game = games[code];
      if (!game || !game.currentRound) {
        return callback && callback({ ok: false, error: "אין סיבוב פעיל." });
      }

      const round = game.currentRound;
      round.active = false;
      clearRoundTimer(code);

      const now = new Date();
      const teamId = round.teamId;
      if (teamId && game.teams[teamId]) {
        game.teams[teamId].score =
          (game.teams[teamId].score || 0) + (round.roundScore || 0);
      }
      game.lastActivity = now;
      game.updatedAt = now;

      if (dbReady && pool) {
        try {
          await pool.query(
            `
            UPDATE rounds
            SET 
              ended_at = $1, round_score = $2
            WHERE game_code = $3 AND team_id = $4
              AND ended_at IS NULL
            ORDER BY id DESC
            LIMIT 1
          `,
            [now, round.roundScore || 0, code, teamId]
          );

          await pool.query(
            `
            UPDATE game_teams
            SET score = $1
            WHERE game_code = $2 AND team_id = $3
          `,
            [game.teams[teamId].score, code, teamId]
          );
        } catch (err) {
          console.error("Error logging round end:", err);
        }
      }

      console.log(
        `⏹ Round ended in game ${code}, team ${teamId}, roundScore=${round.roundScore}`
      );

      callback && callback({ ok: true });

      io.to("game-" + code).emit("roundEnded", {
        teamId,
        roundScore: round.roundScore || 0,
        totalScore: game.teams[teamId] ? game.teams[teamId].score : 0,
      });

      game.currentRound = null;
      broadcastGame(game);
    } catch (err) {
      console.error("Error in endRound:", err);
      callback && callback({ ok: false, error: "שגיאה בסיום סיבוב." });
    }
  });

  // ----------------------
  //   End Game
  // ----------------------
  socket.on("endGame", async (data, callback) => {
    try {
      const { gameCode } = data || {};
      const code = (gameCode || "").toUpperCase().trim();
      const game = games[code];
      if (!game) {
        return callback && callback({ ok: false, error: "המשחק לא נמצא." });
      }

      clearRoundTimer(code);
      delete games[code];

      if (dbReady && pool) {
        try {
          await pool.query(
            `
            DELETE FROM game_players WHERE game_code = $1;
          `,
            [code]
          );
          await pool.query(
            `
            DELETE FROM game_teams WHERE game_code = $1;
          `,
            [code]
          );
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

  // ----------------------
  //   Disconnect
  // ----------------------
  socket.on("disconnect", async () => {
    try {
      console.log("Client disconnected:", socket.id);

      Object.keys(games).forEach(async (code) => {
        const game = games[code];
        if (!game) return;

        // אם זה המנהל
        if (game.hostSocketId === socket.id) {
          // כרגע לא מוחקים את המשחק אוטומטית, רק מסמנים ניתוק
          console.log(`Host disconnected from game ${code}`);
          return;
        }

        if (!game.playersByClientId) return;

        if (!game.playersByClientId[socket.id]) return;
        const player = game.playersByClientId[socket.id];
        const clientId = socket.id;
        const teamId = player.teamId;

        delete game.playersByClientId[clientId];

        if (teamId && game.teams[teamId] && Array.isArray(game.teams[teamId].players)) {
          game.teams[teamId].players = game.teams[teamId].players.filter(
            (cid) => cid !== clientId
          );
        }

        game.lastActivity = new Date();
        game.updatedAt = new Date();

        if (dbReady && pool) {
          try {
            await pool.query(
              `
              DELETE FROM game_players
              WHERE game_code = $1 AND client_id = $2
            `,
              [code, clientId]
            );
          } catch (err) {
            console.error("Error deleting game player on disconnect:", err);
          }
        }

        broadcastGame(game);
      });
    } catch (err) {
      console.error("Error in disconnect handler:", err);
    }
  });
});

// ----------------------
//   Admin Routes
// ----------------------

const ADMIN_CODE = process.env.ADMIN_CODE || "ONEBTN";

// החזרת תמונת מצב כללי (חדרים, מספר שחקנים וכו')
app.get("/admin/summary", async (req, res) => {
  try {
    const code = req.query.code || "";
    if (code !== ADMIN_CODE) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const summary = {
      activeGames: [],
    };

    Object.values(games).forEach((g) => {
      summary.activeGames.push({
        code: g.code,
        hostName: g.hostName,
        targetScore: g.targetScore,
        defaultRoundSeconds: g.defaultRoundSeconds,
        categories: g.categories,
        teamCount: Object.keys(g.teams || {}).length,
        playerCount: Object.keys(g.playersByClientId || {}).length,
        createdAt: g.createdAt,
      });
    });

    if (dbReady && pool) {
      const dbRes = await pool.query(`
        SELECT 
          code,
          host_name,
          target_score,
          default_round_seconds,
          categories,
          created_at
        FROM games
        ORDER BY created_at DESC
        LIMIT 50
      `);
      summary.recentGames = dbRes.rows.map((g) => ({
        code: g.code,
        hostName: g.host_name,
        targetScore: g.target_score,
        defaultRoundSeconds: g.default_round_seconds,
        categories: g.categories,
        createdAt: g.created_at,
      }));
    }

    res.json(summary);
  } catch (err) {
    console.error("Error in /admin/summary:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ----------------------
//   Start Server
// ----------------------

server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
