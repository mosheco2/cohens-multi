// server.js - Milamania / Wordmania

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

const PORT = process.env.PORT || 3000;

// ----------------------
//   Static files
// ----------------------

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

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
 *     categories,
 *     createdAt,
 *     updatedAt,
 *     lastActivity,
 *     teams: {
 *       A: { id, name, score, players: [clientId,...] },
 *       B: { ... }
 *     },
 *     players: {
 *       [clientId]: { clientId, socketId, name, teamId }
 *     },
 *     currentRound: {
 *       active,
 *       teamId,
 *       explainerId,
 *       explainerName,
 *       roundSeconds,
 *       startedAt,
 *       roundScore,
 *       secondsLeft,
 *       endsAt
 *     },
 *     usedWords: Set<"category|text">
 *   }
 * }
 */
const games = {};
const roundTimers = {};

// ----------------------
//   Word bank (basic demo)
// ----------------------

// אפשר להחליף/להרחיב בהמשך – זה רק בסיס עבודה
const WORD_BANK = {
  general: [
    "בית", "מכונית", "טלפון", "עץ", "חולצה",
    "חלון", "מעלית", "אוטובוס", "מחשב", "ספה",
  ],
  family: [
    "אמא", "אבא", "אחות", "אח", "סבתא",
    "סב", "בן דוד", "בת דודה", "אחיין", "גיס",
  ],
  food: [
    "פיצה", "המבורגר", "מלפפון", "שוקולד", "גלידה",
    "לחמניה", "טחינה", "שווארמה", "חומוס", "סלט",
  ],
  work: [
    "מחשב נייד", "ישיבה", "פרזנטציה", "אימייל", "חופשה",
    "בוס", "משכורת", "חוזה", "עובד", "פרויקט",
  ],
  hard: [
    "אינפלציה", "פילוסופיה", "טורנדו", "כימיה", "אסטרונאוט",
    "פרלמנט", "אופטימיזציה", "ארכיאולוגיה", "מיקרוסקופ", "אלגוריתם",
  ],
  sports: [
    "כדורגל", "כדורסל", "טניס", "שחייה", "ריצה",
    "אופניים", "כדורעף", "יוגה", "מרתון", "כדור בסיס",
  ],
  technology: [
    "וואטסאפ", "אפליקציה", "ענן", "בינה מלאכותית", "סיסמה",
    "רובוט", "מצלמה", "טלויזיה חכמה", "דפדפן", "מטען",
  ],
  travel: [
    "מטוס", "מלון", "מזוודה", "חוף ים", "דרכון",
    "רכבת", "סיור", "מפה", "טיול", "מגדל אייפל",
  ],
  school: [
    "מחברת", "מורה", "שיעורי בית", "הפסקה", "עט",
    "כיתה", "מבחן", "עיפרון", "לוח", "תיק",
  ],
  entertainment: [
    "קולנוע", "סדרה", "שחקן", "קריוקי", "קונסולה",
    "משחק וידאו", "פופקורן", "במה", "בדיחה", "קהל",
  ],
  music: [
    "גיטרה", "פסנתר", "תופים", "שיר", "זמר",
    "קונצרט", "מיקרופון", "דיג׳יי", "אקורד", "אוזניות",
  ],
  nature: [
    "הר", "ים", "נהר", "ענן", "גשם",
    "שמש", "פרח", "יער", "חול", "רוח",
  ],
  holidays: [
    "חנוכה", "פסח", "סוכה", "תחפושת", "מתנה",
    "סעודה", "קישוטים", "חופשה", "סיפור", "פסטיגל",
  ],
  animals: [
    "כלב", "חתול", "פיל", "ציפור", "דג",
    "ג׳ירפה", "אריה", "נמר", "כבשה", "תרנגולת",
  ],
  objects: [
    "כיסא", "שולחן", "מנורה", "דלת", "שעון",
    "ספר", "מפתח", "בקבוק", "ארנק", "משקפיים",
  ],
};

function getCategoriesForGame(game) {
  const all = Object.keys(WORD_BANK);
  if (!all.length) return [];
  if (!game || !Array.isArray(game.categories) || !game.categories.length) {
    return all;
  }
  const filtered = game.categories.filter((c) => all.includes(c));
  return filtered.length ? filtered : all;
}

function getNextWordForGame(game) {
  const cats = getCategoriesForGame(game);
  if (!cats.length) return null;

  if (!game.usedWords) {
    game.usedWords = new Set();
  }

  let candidates = [];
  cats.forEach((cat) => {
    const arr = WORD_BANK[cat] || [];
    arr.forEach((w) => {
      const key = `${cat}|${w}`;
      if (!game.usedWords.has(key)) {
        candidates.push({ category: cat, word: w, key });
      }
    });
  });

  // אם השתמשנו בהכל – מתחילים מחדש
  if (!candidates.length) {
    game.usedWords.clear();
    cats.forEach((cat) => {
      const arr = WORD_BANK[cat] || [];
      arr.forEach((w) => {
        const key = `${cat}|${w}`;
        candidates.push({ category: cat, word: w, key });
      });
    });
  }

  if (!candidates.length) return null;

  const idx = Math.floor(Math.random() * candidates.length);
  const chosen = candidates[idx];
  game.usedWords.add(chosen.key);
  game.lastActivity = new Date();
  return { category: chosen.category, word: chosen.word };
}

// ----------------------
//   Helpers
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
    teams: game.teams,
    players: game.players,
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
  io.to("game-" + game.code).emit("gameUpdated", safe);
  io.to("game-" + game.code).emit("gameState", safe);
}

function getScores(game) {
  const scores = {};
  Object.keys(game.teams || {}).forEach((tid) => {
    scores[tid] = game.teams[tid].score || 0;
  });
  return scores;
}

function clearRoundTimer(code) {
  if (roundTimers[code]) {
    clearInterval(roundTimers[code]);
    delete roundTimers[code];
  }
}

function cleanupOldGames() {
  const now = Date.now();
  const MAX_AGE = 6 * 60 * 60 * 1000; // 6 שעות
  Object.keys(games).forEach((code) => {
    const g = games[code];
    if (!g.lastActivity) return;
    const diff = now - new Date(g.lastActivity).getTime();
    if (diff > MAX_AGE) {
      clearRoundTimer(code);
      delete games[code];
      console.log("🧹 Removed old game", code);
    }
  });
}

setInterval(cleanupOldGames, 15 * 60 * 1000);

// ----------------------
//   Banners API (מותאם גם ל-host וגם ל-player)
// ----------------------

app.get("/api/banners", (req, res) => {
  const logoUrl = "/milmania-logo.png";

  const hostBanner = {
    imageUrl: "/banner-host.png",
    linkUrl: "https://onebtn.com",
    altText: "ONEBTN",
  };

  const playerBanner = {
    imageUrl: "/banner-player.png",
    linkUrl: "https://onebtn.com",
    altText: "ONEBTN",
  };

  res.json({
    // פורמט עבור host.html
    logo: {
      imageUrl: logoUrl,
      altText: "מילמניה",
    },
    host: hostBanner,
    player: playerBanner,

    // פורמט פשוט עבור player.html (logoUrl + HTML)
    logoUrl,
    playerBannerHtml: `
      <a href="${playerBanner.linkUrl}" target="_blank" rel="noopener">
        <img src="${playerBanner.imageUrl}" alt="${playerBanner.altText}" style="max-width:100%; border-radius:18px; display:block; margin-top:8px;" />
      </a>
    `,
  });
});

// ----------------------
//   Socket.IO logic
// ----------------------

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // Create game (host)
  socket.on("createGame", (data, callback) => {
    try {
      const {
        hostName,
        targetScore = 40,
        defaultRoundSeconds = 60,
        categories = [],
        numTeams: rawNumTeams,
        teamNames: incomingTeamNames,
      } = data || {};

      if (!hostName || !hostName.trim()) {
        return callback && callback({ ok: false, error: "שם מנהל אינו תקין." });
      }

      let code = generateGameCode(4);
      while (games[code]) {
        code = generateGameCode(4);
      }

      const now = new Date();

      // build teams dynamically (תקלה 1 – שמות אמיתיים)
      const numTeams = Math.max(2, Math.min(5, parseInt(rawNumTeams || 2, 10) || 2));
      const teamIds = ["A", "B", "C", "D", "E"];
      const teams = {};
      const namesObj = incomingTeamNames || {};
      for (let i = 0; i < numTeams; i++) {
        const id = teamIds[i];
        const rawName = namesObj[id] || "";
        const name = typeof rawName === "string" ? rawName.trim() : "";
        teams[id] = {
          id,
          name: name || `קבוצה ${id}`,
          score: 0,
          players: [],
        };
      }

      const game = {
        code,
        hostSocketId: socket.id,
        hostName: hostName.trim(),
        targetScore: Number(targetScore) || 40,
        defaultRoundSeconds: Number(defaultRoundSeconds) || 60,
        categories: Array.isArray(categories) ? categories : [],
        createdAt: now,
        updatedAt: now,
        lastActivity: now,
        teams,
        players: {},
        currentRound: null,
        usedWords: new Set(),
      };

      games[code] = game;
      socket.join("game-" + code);

      console.log("🎮 New game created:", code);

      callback &&
        callback({
          ok: true,
          gameCode: code,
          game: sanitizeGame(game),
        });

      broadcastGame(game);
    } catch (err) {
      console.error("Error in createGame:", err);
      callback && callback({ ok: false, error: "שגיאה ביצירת משחק." });
    }
  });

  // Join game (player)
  socket.on("joinGame", (data, callback) => {
    try {
      const { gameCode, name, teamId } = data || {};
      const code = (gameCode || "").toUpperCase().trim();
      const game = games[code];
      if (!game) {
        return callback && callback({ ok: false, error: "המשחק לא נמצא." });
      }

      // תקלה 2 – שחקן מצטרף גם לחדר המשחק
      socket.join("game-" + code);

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

      if (!Array.isArray(game.teams[chosenTeamId].players)) {
        game.teams[chosenTeamId].players = [];
      }
      if (!game.teams[chosenTeamId].players.includes(clientId)) {
        game.teams[chosenTeamId].players.push(clientId);
      }

      game.lastActivity = new Date();
      game.updatedAt = new Date();

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

  // Get current game state
  socket.on("getGameState", (data, callback) => {
    try {
      const code = ((data && data.gameCode) || "").toUpperCase().trim();
      const game = games[code];
      if (!game) {
        return callback && callback({ ok: false, error: "המשחק לא נמצא." });
      }
      callback && callback({ ok: true, game: sanitizeGame(game) });
    } catch (err) {
      console.error("Error in getGameState:", err);
      callback && callback({ ok: false, error: "שגיאה בקבלת מצב משחק." });
    }
  });

  // 🔹 מילים – מילה הבאה
  socket.on("getNextWord", (data, callback) => {
    try {
      const { gameCode } = data || {};
      const code = (gameCode || "").toUpperCase().trim();
      const game = games[code];
      if (!game) {
        return callback && callback({ ok: false, error: "המשחק לא נמצא." });
      }

      const result = getNextWordForGame(game);
      if (!result) {
        return callback && callback({ ok: false, error: "אין מילים זמינות כרגע." });
      }

      callback &&
        callback({
          ok: true,
          word: result.word,
          category: result.category,
        });
    } catch (err) {
      console.error("Error in getNextWord:", err);
      callback && callback({ ok: false, error: "שגיאה בקבלת מילה." });
    }
  });

  // Start round
  socket.on("startRound", (data, callback) => {
    try {
      const { gameCode, teamId, roundSeconds, explainerClientId } = data || {};
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
      const seconds = parseInt(roundSeconds || game.defaultRoundSeconds || 60, 10);
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

  // Change round score
  socket.on("changeRoundScore", (data, callback) => {
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

  // Remove player (by host)
  socket.on("removePlayer", (data, callback) => {
    try {
      const { gameCode, clientId } = data || {};
      const code = (gameCode || "").toUpperCase().trim();
      const game = games[code];
      if (!game || !clientId || !game.players[clientId]) {
        return callback && callback({ ok: false, error: "שחקן לא נמצא." });
      }

      const player = game.players[clientId];
      const teamId = player.teamId;

      delete game.players[clientId];

      if (teamId && game.teams[teamId] && Array.isArray(game.teams[teamId].players)) {
        game.teams[teamId].players = game.teams[teamId].players.filter(
          (cid) => cid !== clientId
        );
      }

      game.lastActivity = new Date();
      game.updatedAt = new Date();

      io.to(clientId).emit("removedFromGame", {
        reason: "הוסרת מהמשחק על ידי המנהל.",
      });

      callback && callback({ ok: true, game: sanitizeGame(game) });
      broadcastGame(game);
    } catch (err) {
      console.error("Error in removePlayer:", err);
      callback && callback({ ok: false, error: "שגיאה בהסרת שחקן." });
    }
  });

  // End round
  socket.on("endRound", (data, callback) => {
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

  // End game
  socket.on("endGame", (data, callback) => {
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

      io.to("game-" + code).emit("gameEnded", { code });
      callback && callback({ ok: true });
    } catch (err) {
      console.error("Error in endGame:", err);
      callback && callback({ ok: false, error: "שגיאה בסגירת המשחק." });
    }
  });

  // Disconnect
  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
    const clientId = socket.id;

    Object.keys(games).forEach((code) => {
      const game = games[code];
      if (!game || !game.players || !game.players[clientId]) return;

      const player = game.players[clientId];
      const teamId = player.teamId;

      delete game.players[clientId];

      if (teamId && game.teams[teamId] && Array.isArray(game.teams[teamId].players)) {
        game.teams[teamId].players = game.teams[teamId].players.filter(
          (cid) => cid !== clientId
        );
      }

      game.lastActivity = new Date();
      game.updatedAt = new Date();

      broadcastGame(game);
    });
  });
});

// ----------------------
//   Admin (in-memory only)
// ----------------------

const ADMIN_CODE = process.env.ADMIN_CODE || "ONEBTN";

app.get("/admin/rooms", (req, res) => {
  const code = req.query.code;
  if (code !== ADMIN_CODE) {
    return res.status(403).json({ error: "Not authorized" });
  }

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

  res.json({
    ok: true,
    inMemory: memGames,
    currentGames: Object.keys(games).length,
  });
});

// ----------------------
//   Start server
// ----------------------

server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
