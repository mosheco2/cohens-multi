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

const PORT = process.env.PORT || 3000;

// ----------------------
//   Static Files
// ----------------------

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ----------------------
//   Postgres Pool
// ----------------------

// אפשר לשנות את משתני הסביבה בהתאם לשרת שלך
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

let dbReady = false;

async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS games (
        code TEXT PRIMARY KEY,
        host_name TEXT,
        target_score INTEGER,
        default_round_seconds INTEGER,
        categories TEXT[],
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        last_activity TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_teams (
        id SERIAL PRIMARY KEY,
        game_code TEXT NOT NULL REFERENCES games(code) ON DELETE CASCADE,
        team_id TEXT NOT NULL,
        name TEXT NOT NULL,
        score INTEGER DEFAULT 0
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_players (
        id SERIAL PRIMARY KEY,
        game_code TEXT NOT NULL REFERENCES games(code) ON DELETE CASCADE,
        client_id TEXT NOT NULL,
        name TEXT NOT NULL,
        team_id TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS rounds (
        id SERIAL PRIMARY KEY,
        game_code TEXT NOT NULL REFERENCES games(code) ON DELETE CASCADE,
        team_id TEXT,
        explainer_id TEXT,
        explainer_name TEXT,
        started_at TIMESTAMP,
        ended_at TIMESTAMP,
        round_seconds INTEGER,
        round_score INTEGER DEFAULT 0
      );
    `);

    dbReady = true;
    console.log("✅ Database initialized");
  } catch (err) {
    console.error("❌ Error initializing DB:", err);
  }
}
initDb().catch((err) => console.error(err));

// ----------------------
//   In-memory store
// ----------------------

/**
 * games = {
 *   [code]: {
 *     code,
 *     hostSocketId,
 *     hostName,
 *     targetScore,
 *     defaultRoundSeconds,
 *     categories: [...],
 *     createdAt,
 *     updatedAt,
 *     lastActivity,
 *     teams: {
 *       A: { id: "A", name: "הכחולים", score: 0, players: ["socketId1","socketId2"] },
 *       B: { ... }
 *     },
 *     players: {
 *       [clientId]: {
 *         clientId,
 *         socketId,
 *         name,
 *         teamId
 *       }
 *     },
 *     currentRound: {
 *       active: boolean,
 *       teamId: "A"|"B"|...,
 *       explainerId: clientId,
 *       explainerName: string,
 *       roundSeconds: number,
 *       startedAt: timestamp,
 *       roundScore: number,
 *       secondsLeft: number,
 *       endsAt: number (ms)
 *     }
 *   }
 * }
 */
const games = {};

// טיימרים פעילים לפי קוד משחק
const roundTimers = {};

// ----------------------
//   Helper Functions
// ----------------------

function generateGameCode(length = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < length; i++) {
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

    // כל הקבוצות עם שמות, ניקוד ורשימת שחקנים
    teams: game.teams,

    // מפת שחקנים לפי clientId -> { name, teamId, ... }
    players: game.players,
    playersByClientId: game.playersByClientId || game.players,

    // מידע על הסיבוב הנוכחי (אם יש)
    currentRound: game.currentRound
      ? {
          active: !!game.currentRound.active,
          teamId: game.currentRound.teamId,
          explainerId: game.currentRound.explainerId,
          explainerName: game.currentRound.explainerName,
          roundSeconds: game.currentRound.roundSeconds,
          startedAt: game.currentRound.startedAt,
          roundScore: game.currentRound.roundScore,
          secondsLeft:
            typeof game.currentRound.secondsLeft === "number"
              ? game.currentRound.secondsLeft
              : null,
        }
      : null,
  };
}

function broadcastGame(game) {
  const safe = sanitizeGame(game);
  // אירוע קלאסי לקליינטים קיימים
  io.to("game-" + game.code).emit("gameUpdated", safe);
  // אירוע נוסף למסכים שמשתמשים בשם gameState
  io.to("game-" + game.code).emit("gameState", safe);
}

function getScores(game) {
  const teamsScores = {};
  Object.keys(game.teams || {}).forEach((tid) => {
    teamsScores[tid] = game.teams[tid].score || 0;
  });
  return teamsScores;
}

// מפסיק טיימר סיבוב פעיל (אם יש) עבור קוד משחק
function clearRoundTimer(code) {
  if (roundTimers[code]) {
    clearInterval(roundTimers[code]);
    delete roundTimers[code];
  }
}

// מנקה משחקים ישנים מהזיכרון
function cleanupOldGames() {
  const now = Date.now();
  const GAME_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 שעות
  for (const code of Object.keys(games)) {
    const g = games[code];
    if (!g.lastActivity) continue;
    const diff = now - new Date(g.lastActivity).getTime();
    if (diff > GAME_MAX_AGE_MS) {
      console.log("🧹 Deleting old game from memory:", code);
      clearRoundTimer(code);
      delete games[code];
    }
  }
}

// להריץ פעם ב-15 דקות
setInterval(cleanupOldGames, 15 * 60 * 1000);

// ----------------------
//   API: Banners/Logo
// ----------------------

app.get("/api/banners", async (req, res) => {
  try {
    res.json({
      logo: {
        imageUrl: "/milmania-logo.png",
        altText: "מילמניה",
      },
      host: {
        imageUrl: "/banner-host.png",
        linkUrl: "https://onebtn.com",
        altText: "ONEBTN",
      },
      player: {
        imageUrl: "/banner-player.png",
        linkUrl: "https://onebtn.com",
        altText: "ONEBTN",
      },
    });
  } catch (err) {
    console.error("Error in /api/banners:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ----------------------
//   Socket.IO logic
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
      } = data || {};

      if (!hostName || !hostName.trim()) {
        return callback && callback({ ok: false, error: "שם מנהל אינו תקין." });
      }

      let code = generateGameCode(4);
      while (games[code]) {
        code = generateGameCode(4);
      }

      const now = new Date();
      const newGame = {
        code,
        hostSocketId: socket.id,
        hostName: hostName.trim(),
        targetScore: Number(targetScore) || 40,
        defaultRoundSeconds: Number(defaultRoundSeconds) || 60,
        categories: Array.isArray(categories) ? categories : [],
        createdAt: now,
        updatedAt: now,
        lastActivity: now,
        teams: {
          A: { id: "A", name: "קבוצה A", score: 0, players: [] },
          B: { id: "B", name: "קבוצה B", score: 0, players: [] },
        },
        players: {},
        currentRound: null,
      };

      games[code] = newGame;
      socket.join("game-" + code);

      if (dbReady && pool) {
        try {
          await pool.query(
            `
            INSERT INTO games (code, host_name, target_score, default_round_seconds, categories)
            VALUES ($1, $2, $3, $4, $5)
          `,
            [
              code,
              newGame.hostName,
              newGame.targetScore,
              newGame.defaultRoundSeconds,
              newGame.categories,
            ]
          );

          const teamEntries = Object.values(newGame.teams);
          for (const t of teamEntries) {
            await pool.query(
              `
              INSERT INTO game_teams (game_code, team_id, name, score)
              VALUES ($1, $2, $3, $4)
            `,
              [code, t.id, t.name, t.score]
            );
          }
        } catch (err) {
          console.error("Error persisting new game:", err);
        }
      }

      console.log("🎮 New game created:", code);

      callback &&
        callback({
          ok: true,
          gameCode: code,
          game: sanitizeGame(newGame),
        });

      broadcastGame(newGame);
    } catch (err) {
      console.error("Error in createGame:", err);
      callback && callback({ ok: false, error: "שגיאה ביצירת משחק." });
    }
  });

  // ----------------------
  //   Join Game (Player)
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
        const keys = Object.keys(game.teams);
        chosenTeamId = keys.length ? keys[0] : "A";
      }

      const clientId = socket.id;

      game.players[clientId] = {
        clientId,
        socketId: socket.id,
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

      broadcastGame(game);
    } catch (err) {
      console.error("Error in joinGame:", err);
      callback && callback({ ok: false, error: "שגיאה בהצטרפות למשחק." });
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

      const tid = (teamId || "").trim() || Object.keys(game.teams)[0];
      if (!game.teams[tid]) {
        return callback && callback({ ok: false, error: "קבוצה לא תקינה." });
      }

      let explainerId = explainerClientId || null;
      let explainerName = "";
      if (explainerId && game.players[explainerId]) {
        explainerName = game.players[explainerId].name || "";
      } else {
        const playersOnTeam = game.teams[tid].players || [];
        if (playersOnTeam.length > 0) {
          explainerId = playersOnTeam[0];
          explainerName = game.players[explainerId]?.name || "";
        }
      }

      const now = new Date();
      const seconds = roundSeconds || game.defaultRoundSeconds || 60;
      const endsAt = now.getTime() + seconds * 1000;

      game.currentRound = {
        active: true,
        teamId: tid,
        explainerId,
        explainerName,
        roundSeconds: seconds,
        startedAt: now,
        roundScore: 0,
        secondsLeft: seconds,
        endsAt,
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
          g.currentRound.active = false;
          clearRoundTimer(code);
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

      io.to("game-" + code).emit("roundScoreUpdated", {
        roundScore: game.currentRound.roundScore,
      });

      broadcastGame(game);
    } catch (err) {
      console.error("Error in changeRoundScore:", err);
      callback && callback({ ok: false, error: "שגיאה בעדכון ניקוד סיבוב." });
    }
  });

  // ----------------------
  //   Remove Player (by Host)
  // ----------------------
  socket.on("removePlayer", async (data, callback) => {
    try {
      const { gameCode, clientId } = data || {};
      const code = (gameCode || "").toUpperCase().trim();
      const game = games[code];
      if (!game || !clientId || !game.players[clientId]) {
        return callback && callback({ ok: false, error: "שחקן לא נמצא." });
      }

      const player = game.players[clientId];
      const teamId = player.teamId;

      // הסרה ממפת השחקנים
      delete game.players[clientId];
      if (game.playersByClientId) {
        delete game.playersByClientId[clientId];
      }

      // הסרה מהקבוצה
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

      // נשלח לשחקן הודעה שהוסר
      io.to(clientId).emit("removedFromGame", { reason: "הוסרת מהמשחק על ידי המנהל." });

      callback && callback({ ok: true, game: sanitizeGame(game) });
      broadcastGame(game);
    } catch (err) {
      console.error("Error in removePlayer:", err);
      callback && callback({ ok: false, error: "שגיאה בהסרת שחקן." });
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
            SET ended_at = $1, round_score = $2
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

          await pool.query(
            `
            UPDATE games
            SET updated_at = $1, last_activity = $1
            WHERE code = $2
          `,
            [now, code]
          );
        } catch (err) {
          console.error("Error logging round end / score:", err);
        }
      }

      console.log(
        `✅ Round ended in game ${code}, team ${teamId}, roundScore = ${round.roundScore}`
      );

      callback && callback({ ok: true, scores: getScores(game) });

      io.to("game-" + code).emit("roundEnded", {
        teamId,
        roundScore: round.roundScore || 0,
        scores: getScores(game),
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

      console.log("🛑 Game ended:", code);
      clearRoundTimer(code);
      delete games[code];

      if (dbReady && pool) {
        try {
          await pool.query(
            `
            UPDATE games
            SET updated_at = NOW(), last_activity = NOW()
            WHERE code = $1
          `,
            [code]
          );
        } catch (err) {
          console.error("Error logging game end:", err);
        }
      }

      io.to("game-" + code).emit("gameEnded", { code });
      callback && callback({ ok: true });
    } catch (err) {
      console.error("Error in endGame:", err);
      callback && callback({ ok: false, error: "שגיאה בסגירת המשחק." });
    }
  });

  // ----------------------
  //   Disconnect
  // ----------------------
  socket.on("disconnect", async () => {
    console.log("Client disconnected:", socket.id);
    const clientId = socket.id;

    for (const code of Object.keys(games)) {
      const game = games[code];
      if (!game || !game.players || !game.players[clientId]) continue;

      const player = game.players[clientId];
      const teamId = player.teamId;

      delete game.players[clientId];
      if (game.playersByClientId) {
        delete game.playersByClientId[clientId];
      }

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
    }
  });
});

// ----------------------
//   Admin Routes
// ----------------------

const ADMIN_CODE = process.env.ADMIN_CODE || "ONEBTN";

// החזרת תמונת מצב כללי (חדרים, מספר שחקנים וכו')
app.get("/admin/rooms", async (req, res) => {
  const code = req.query.code;
  if (code !== ADMIN_CODE) {
    return res.status(403).json({ error: "Not authorized" });
  }

  try {
    const memGames = Object.values(games).map((g) => ({
      code: g.code,
      hostName: g.hostName,
      targetScore: g.targetScore,
      defaultRoundSeconds: g.defaultRoundSeconds,
      categories: g.categories,
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
      lastActivity: g.lastActivity,
      teams: Object.keys(g.teams || {}).map((tid) => ({
        teamId: tid,
        name: g.teams[tid].name,
        score: g.teams[tid].score,
        playersCount: (g.teams[tid].players || []).length,
      })),
    }));

    let dbGames = [];
    if (dbReady && pool) {
      const result = await pool.query(`
        SELECT
          g.code,
          g.host_name,
          g.target_score,
          g.default_round_seconds,
          g.categories,
          g.created_at,
          g.updated_at,
          g.last_activity,
          COALESCE(json_agg(json_build_object(
            'team_id', t.team_id,
            'name', t.name,
            'score', t.score
          )) FILTER (WHERE t.id IS NOT NULL), '[]') AS teams
        FROM games g
        LEFT JOIN game_teams t
          ON t.game_code = g.code
        GROUP BY g.code, g.host_name, g.target_score, g.default_round_seconds, g.categories, g.created_at, g.updated_at, g.last_activity
        ORDER BY g.created_at DESC
        LIMIT 100
      `);

      dbGames = result.rows.map((row) => ({
        code: row.code,
        hostName: row.host_name,
        targetScore: row.target_score,
        defaultRoundSeconds: row.default_round_seconds,
        categories: row.categories,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastActivity: row.last_activity,
        teams: row.teams || [],
      }));
    }

    res.json({
      ok: true,
      inMemory: memGames,
      fromDb: dbGames,
      currentGames: Object.keys(games).length,
    });
  } catch (err) {
    console.error("Error in /admin/rooms:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// סיכום כולל (ניתן לשימוש לדשבורד קטן בעתיד)
app.get("/admin/summary", async (req, res) => {
  const code = req.query.code;
  if (code !== ADMIN_CODE) {
    return res.status(403).json({ error: "Not authorized" });
  }

  try {
    const summary = {
      totalRooms: 0,
      totalPlayers: 0,
      rooms: [],
    };

    if (dbReady && pool) {
      const gamesRes = await pool.query(`
        SELECT code, host_name, created_at
        FROM games
        ORDER BY created_at DESC
        LIMIT 200
      `);
      const gamesRows = gamesRes.rows;

      const playersRes = await pool.query(`
        SELECT game_code, COUNT(*) AS cnt
        FROM game_players
        GROUP BY game_code
      `);
      const playersRows = playersRes.rows;

      const playersByGame = {};
      playersRows.forEach((row) => {
        playersByGame[row.game_code] = parseInt(row.cnt, 10) || 0;
      });

      summary.totalRooms = gamesRows.length;
      gamesRows.forEach((g) => {
        const count = playersByGame[g.code] || 0;
        summary.totalPlayers += count;
        summary.rooms.push({
          code: g.code,
          hostName: g.host_name,
          playersCount: count,
          createdAt: g.created_at,
        });
      });
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
