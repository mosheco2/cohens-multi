// server.js - מילמניה / כהנ'ס

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { Pool } = require("pg");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ----------------------
//   Postgres
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

    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_teams (
        id SERIAL PRIMARY KEY,
        game_code TEXT NOT NULL,
        team_id TEXT NOT NULL,
        team_name TEXT NOT NULL,
        score INTEGER NOT NULL DEFAULT 0
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_players (
        id SERIAL PRIMARY KEY,
        game_code TEXT NOT NULL,
        client_id TEXT NOT NULL,
        name TEXT NOT NULL,
        team_id TEXT NOT NULL
      );
    `);

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
//   Utils
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
  return {
    code: game.code,
    hostName: game.hostName,
    targetScore: game.targetScore,
    defaultRoundSeconds: game.defaultRoundSeconds,
    categories: game.categories,
    createdAt: game.createdAt,
    updatedAt: game.updatedAt,
    teams: Object.values(game.teams || {}).map((t) => ({
      id: t.id,
      name: t.name,
      score: t.score,
      players: (t.players || [])
        .map((clientId) => {
          const p = game.playersByClientId[clientId];
          return p
            ? {
                clientId,
                name: p.name,
              }
            : null;
        })
        .filter(Boolean),
    })),
    currentRound: game.currentRound
      ? {
          teamId: game.currentRound.teamId,
          explainingPlayer: game.currentRound.explainingPlayer
            ? {
                clientId: game.currentRound.explainingPlayer.clientId,
                name: game.currentRound.explainingPlayer.name,
              }
            : null,
          secondsLeft: game.currentRound.secondsLeft,
          isActive: game.currentRound.isActive,
        }
      : null,
  };
}

function clearRoundTimer(gameCode) {
  if (roundTimers[gameCode]) {
    clearInterval(roundTimers[gameCode]);
    delete roundTimers[gameCode];
  }
}

// סיום סיבוב (ידני או אוטומטי)
async function finishRound(gameCode, options = { reason: "manual" }) {
  const code = (gameCode || "").toUpperCase().trim();
  const game = games[code];
  if (!game || !game.currentRound) return;

  const round = game.currentRound;
  clearRoundTimer(code);
  game.currentRound = null;
  game.updatedAt = new Date();
  game.lastActivity = new Date();

  io.to("game-" + code).emit("roundFinished", {
    game: sanitizeGame(game),
    reason: options.reason || "manual",
  });

  console.log(
    `⏹️ Round finished for game ${code}, team ${round.teamId}, reason: ${
      options.reason || "manual"
    }`
  );
}

function broadcastGame(game) {
  const sanitized = sanitizeGame(game);
  io.to("game-" + game.code).emit("gameUpdated", {
    game: sanitized,
  });
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
          teams[id] = {
            id,
            name,
            score: 0,
            players: [],
          };
        }
      });

      if (Object.keys(teams).length === 0) {
        ["A", "B"].forEach((id) => {
          teams[id] = {
            id,
            name:
              id === "A"
                ? "קבוצה A"
                : id === "B"
                ? "קבוצה B"
                : "קבוצה " + id,
            score: 0,
            players: [],
          };
        });
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
              INSERT INTO game_teams (game_code, team_id, team_name, score)
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

  // הצטרפות למשחק
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

      console.log(
        `👤 Player joined: ${playerName} -> game ${code}, team ${chosenTeamId}`
      );

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

  // הסרת שחקן ע"י המנהל (דרך Socket, מתוך המשחק עצמו)
  socket.on("removePlayer", async (data, callback) => {
    try {
      const { gameCode, clientId } = data || {};
      const code = (gameCode || "").toUpperCase().trim();
      const game = games[code];
      if (!game) {
        return callback && callback({ ok: false, error: "המשחק לא נמצא." });
      }

      const player = game.playersByClientId[clientId];
      if (!player) {
        return callback && callback({ ok: false, error: "השחקן לא נמצא במשחק." });
      }

      const teamId = player.teamId;
      delete game.playersByClientId[clientId];

      if (
        teamId &&
        game.teams[teamId] &&
        Array.isArray(game.teams[teamId].players)
      ) {
        game.teams[teamId].players = game.teams[teamId].players.filter(
          (pId) => pId !== clientId
        );
      }

      // אם השחקן המסביר כרגע – מסיימים את הסיבוב
      if (
        game.currentRound &&
        game.currentRound.explainingPlayer &&
        game.currentRound.explainingPlayer.clientId === clientId
      ) {
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

  // עדכון ניקוד
  socket.on("updateScore", (data, callback) => {
    try {
      const { gameCode, teamId, delta } = data || {};
      const code = (gameCode || "").toUpperCase().trim();
      const game = games[code];
      if (!game || !game.teams[teamId]) {
        return callback && callback({ ok: false, error: "המשחק/קבוצה לא נמצאו." });
      }

      const d = parseInt(delta, 10) || 0;
      game.teams[teamId].score = Math.max(
        0,
        (game.teams[teamId].score || 0) + d
      );
      game.updatedAt = new Date();
      game.lastActivity = new Date();

      broadcastGame(game);
      callback && callback({ ok: true, game: sanitizeGame(game) });
    } catch (err) {
      console.error("Error in updateScore:", err);
      callback &&
        callback({ ok: false, error: "שגיאה בעדכון ניקוד הקבוצה." });
    }
  });

  // התחלת סיבוב
  socket.on("startRound", async (data, callback) => {
    try {
      const { gameCode, teamId, durationSeconds } = data || {};
      const code = (gameCode || "").toUpperCase().trim();
      const game = games[code];
      if (!game) {
        return callback && callback({ ok: false, error: "המשחק לא נמצא." });
      }

      if (!game.teams[teamId]) {
        return callback &&
          callback({ ok: false, error: "הקבוצה שנבחרה לא קיימת." });
      }

      clearRoundTimer(code);

      const playersInTeam = (game.teams[teamId].players || []).map(
        (clientId) => game.playersByClientId[clientId]
      );
      if (!playersInTeam.length) {
        return callback &&
          callback({ ok: false, error: "אין שחקנים בקבוצה שנבחרה." });
      }

      const explainingPlayer =
        playersInTeam[Math.floor(Math.random() * playersInTeam.length)];

      const totalSeconds =
        parseInt(durationSeconds, 10) || game.defaultRoundSeconds || 60;

      game.currentRound = {
        teamId,
        explainingPlayer: {
          clientId: explainingPlayer.clientId,
          name: explainingPlayer.name,
        },
        secondsLeft: totalSeconds,
        isActive: true,
      };

      game.updatedAt = new Date();
      game.lastActivity = new Date();

      io.to("game-" + code).emit("roundStarted", {
        game: sanitizeGame(game),
      });

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

      callback &&
        callback({
          ok: true,
          game: sanitizeGame(game),
        });
    } catch (err) {
      console.error("Error in startRound:", err);
      callback && callback({ ok: false, error: "שגיאה בתחילת סיבוב." });
    }
  });

  // סיום סיבוב ידני
  socket.on("finishRound", async (data, callback) => {
    try {
      const { gameCode } = data || {};
      await finishRound(gameCode, { reason: "manual" });
      callback && callback({ ok: true });
    } catch (err) {
      console.error("Error in finishRound:", err);
      callback && callback({ ok: false, error: "שגיאה בסיום סיבוב." });
    }
  });

  // סיום משחק (מהצד של המנהל בתוך המשחק)
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
            `DELETE FROM game_players WHERE game_code = $1;`,
            [code]
          );
          await pool.query(
            `DELETE FROM game_teams WHERE game_code = $1;`,
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

  // ניתוק Socket
  socket.on("disconnect", async () => {
    try {
      console.log("Client disconnected:", socket.id);

      Object.keys(games).forEach(async (code) => {
        const game = games[code];
        if (!game) return;

        if (game.hostSocketId === socket.id) {
          clearRoundTimer(code);
          delete games[code];

          if (dbReady && pool) {
            try {
              await pool.query(
                `DELETE FROM game_players WHERE game_code = $1;`,
                [code]
              );
              await pool.query(
                `DELETE FROM game_teams WHERE game_code = $1;`,
                [code]
              );
            } catch (err) {
              console.error("Error cleaning up game on disconnect:", err);
            }
          }

          io.to("game-" + code).emit("gameEnded", { code });
          console.log(`🛑 Game ended because host disconnected: ${code}`);
          return;
        }

        if (!game.playersByClientId) return;
        const player = game.playersByClientId[socket.id];
        if (!player) return;

        const clientId = socket.id;
        const teamId = player.teamId;

        delete game.playersByClientId[clientId];

        if (
          teamId &&
          game.teams[teamId] &&
          Array.isArray(game.teams[teamId].players)
        ) {
          game.teams[teamId].players = game.teams[teamId].players.filter(
            (pId) => pId !== clientId
          );
        }

        // אם זה השחקן המסביר – לסיים סיבוב
        if (
          game.currentRound &&
          game.currentRound.explainingPlayer &&
          game.currentRound.explainingPlayer.clientId === clientId
        ) {
          await finishRound(code, { reason: "player_disconnected" });
        } else {
          game.updatedAt = new Date();
          game.lastActivity = new Date();
          broadcastGame(game);
        }
      });
    } catch (err) {
      console.error("Error in disconnect handler:", err);
    }
  });

  // מצב משחק מלא
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
      callback &&
        callback({ ok: false, error: "שגיאה בקבלת מצב המשחק." });
    }
  });
});

// ----------------------
//   Admin Routes
// ----------------------

const ADMIN_CODE = process.env.ADMIN_CODE || "ONEBTN";

// סיכום חדרים + שחקנים
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
      const playersMap = g.playersByClientId || {};
      const teamsMap = g.teams || {};

      const players = Object.values(playersMap).map((p) => ({
        clientId: p.clientId,
        name: p.name,
        teamId: p.teamId,
        teamName: teamsMap[p.teamId] ? teamsMap[p.teamId].name : null,
      }));

      summary.activeGames.push({
        code: g.code,
        hostName: g.hostName,
        targetScore: g.targetScore,
        defaultRoundSeconds: g.defaultRoundSeconds,
        categories: g.categories,
        teamCount: Object.keys(g.teams || {}).length,
        playerCount: Object.keys(playersMap).length,
        createdAt: g.createdAt,
        players, // NEW: רשימת שחקנים לחדר הזה
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

// Admin - close game
app.post("/admin/game/:gameCode/close", async (req, res) => {
  try {
    const adminCode = req.query.code || "";
    if (adminCode !== ADMIN_CODE) {
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }

    const gameCode = req.params.gameCode || "";
    const code = gameCode.toUpperCase().trim();
    const game = games[code];
    if (!game) {
      return res.status(404).json({ ok: false, error: "המשחק לא נמצא." });
    }

    clearRoundTimer(code);
    delete games[code];

    if (dbReady && pool) {
      try {
        await pool.query(`DELETE FROM game_players WHERE game_code = $1;`, [
          code,
        ]);
        await pool.query(`DELETE FROM game_teams WHERE game_code = $1;`, [
          code,
        ]);
      } catch (err) {
        console.error("Error cleaning game from DB (admin close):", err);
      }
    }

    io.to("game-" + code).emit("gameEnded", { code });
    console.log(`🛑 Game ended by admin: ${code}`);
    res.json({ ok: true });
  } catch (err) {
    console.error("Error in /admin/game/:gameCode/close:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Admin - disconnect single player from a game
app.post(
  "/admin/game/:gameCode/player/:clientId/disconnect",
  async (req, res) => {
    try {
      const adminCode = req.query.code || "";
      if (adminCode !== ADMIN_CODE) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }

      const gameCode = req.params.gameCode || "";
      const clientId = req.params.clientId || "";
      const code = gameCode.toUpperCase().trim();

      const game = games[code];
      if (!game) {
        return res
          .status(404)
          .json({ ok: false, error: "המשחק לא נמצא." });
      }

      const player = game.playersByClientId[clientId];
      if (!player) {
        return res
          .status(404)
          .json({ ok: false, error: "השחקן לא נמצא במשחק." });
      }

      const teamId = player.teamId;
      delete game.playersByClientId[clientId];

      if (
        teamId &&
        game.teams[teamId] &&
        Array.isArray(game.teams[teamId].players)
      ) {
        game.teams[teamId].players = game.teams[teamId].players.filter(
          (pId) => pId !== clientId
        );
      }

      // אם זה המסביר – לסיים את הסיבוב
      if (
        game.currentRound &&
        game.currentRound.explainingPlayer &&
        game.currentRound.explainingPlayer.clientId === clientId
      ) {
        await finishRound(code, { reason: "player_disconnected" });
      } else {
        game.updatedAt = new Date();
        game.lastActivity = new Date();
        broadcastGame(game);
      }

      console.log(`👢 Player disconnected by admin: ${clientId} from game ${code}`);
      res.json({ ok: true });
    } catch (err) {
      console.error("Error in admin disconnect player:", err);
      res.status(500).json({ ok: false, error: "Server error" });
    }
  }
);

// ----------------------
//   Start server
// ----------------------

server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
