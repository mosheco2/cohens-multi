// server.js - כהנ'ס Alias Party

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

const PORT = process.env.PORT || 10000;
const ADMIN_CODE = process.env.ADMIN_CODE || "cohens1234";

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ----------------------
//   ניהול באנרים / לוגו
// ----------------------

let banners = {
  index: {
    imageUrl: "",
    linkUrl: "",
  },
  host: {
    imageUrl: "",
    linkUrl: "",
  },
  player: {
    imageUrl: "",
    linkUrl: "",
  },
  // לוגו כללי – נטען בעמוד הבית ובקטן במסכי מנהל/שחקן
  logo: {
    imageUrl: "",
    altText: "כהנ'ס",
  },
};

app.get("/api/banners", (req, res) => {
  res.json(banners);
});

app.post("/api/admin/banners", (req, res) => {
  const { adminCode, index, host, player, logo } = req.body || {};
  if (!adminCode || adminCode !== ADMIN_CODE) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  if (index) {
    banners.index = {
      ...banners.index,
      ...index,
    };
  }
  if (host) {
    banners.host = {
      ...banners.host,
      ...host,
    };
  }
  if (player) {
    banners.player = {
      ...banners.player,
      ...player,
    };
  }
  if (logo) {
    banners.logo = {
      ...banners.logo,
      ...logo,
    };
  }

  return res.json({ ok: true, banners });
});

// ----------------------
//   דוח חדרים פתוחים למנהל
// ----------------------

app.get("/api/admin/rooms", (req, res) => {
  try {
    const rooms = [];

    Object.entries(games).forEach(([code, game]) => {
      if (!game) return;

      const playersMap = game.players || {};
      const playersArr = Object.values(playersMap).map((p, idx) => ({
        name: p && p.name ? p.name : `שחקן ${idx + 1}`,
        teamId: p && p.teamId ? p.teamId : null,
      }));

      rooms.push({
        code: game.code || code,
        name:
          game.name ||
          game.title ||
          `משחק ${code}`,
        managerName: game.hostName || null,
        status: game.currentRound && game.currentRound.active ? "round-active" : "active",
        createdAt: game.createdAt || null,
        playersCount: playersArr.length,
        players: playersArr,
      });
    });

    const totalPlayers = rooms.reduce(
      (sum, r) => sum + (r.playersCount || 0),
      0
    );

    res.json({
      ok: true,
      rooms,
      totalRooms: rooms.length,
      totalPlayers,
    });
  } catch (err) {
    console.error("Error in /api/admin/rooms:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ----------------------
//   מאגר מילים / קטגוריות
// ----------------------

const WORD_SETS = {
  general: [
    "טלפון",
    "חופשה",
    "בית ספר",
    "מעלית",
    "שכן",
    "חניה",
    "סופרמרקט",
    "קניון",
    "עבודה",
    "קפה",
    "מחשב",
    "טלוויזיה",
    "חוג",
    "כדורגל",
    "כדורסל",
    "רופאה",
    "ראיון",
    "ישיבה",
    "ספה",
    "מיטה",
    "חלום",
    "שכונה",
    "אוטובוס",
    "רכבת",
    "חדר כושר",
    "מסיבה",
    "מוזיקה",
    "גיטרה",
    "פסנתר",
  ],
  family: [
    "אמא",
    "אבא",
    "סבתא",
    "סבא",
    "אח גדול",
    "אחות קטנה",
    "בן דוד",
    "בת דודה",
    "חתול",
    "כלב",
    "טיול משפחתי",
    "ארוחת שישי",
    "בר מצווה",
    "בת מצווה",
    "חג פסח",
    "סוכה",
    "יום הולדת",
  ],
  food: [
    "פלאפל",
    "שווארמה",
    "חומוס",
    "פיצה",
    "בורקס",
    "מלוואח",
    "ג'חנון",
    "סלט",
    "סטייק",
    "שניצל",
    "צ'יפס",
    "חמין",
    "קוסקוס",
    "מרק עוף",
    "קובה",
    "סיגרים",
    "טחינה",
    "חמוצים",
  ],
  work: [
    "מייל",
    "ישיבת צוות",
    "דדליין",
    "מצגת",
    "בוס",
    "קולגה",
    "זום",
    "פרויקט",
    "משימה",
    "אקסל",
    "בונוס",
    "חופשת מחלה",
  ],
  hard: [
    "פוליטיקה",
    "פילוסופיה",
    "אינפלציה",
    "בינה מלאכותית",
    "רוויזיה",
    "אופטימיזציה",
    "היפר אקטיבי",
  ],
  // קטגוריות חדשות
  sports: [
    "כדורגל",
    "כדורסל",
    "טניס",
    "ריצה",
    "שחייה",
    "כדורעף",
    "אופניים",
    "אימון כושר",
    "כדוריד",
    "כדורגל שולחן",
  ],
  technology: [
    "מחשב נייד",
    "סמארטפון",
    "אפליקציה",
    "ענן",
    "אינטרנט",
    "אוזניות",
    "מטען",
    "מסך מגע",
    "וייפיי",
    "רשת חברתית",
  ],
  travel: [
    "מטוס",
    "שדה תעופה",
    "מלון",
    "צימר",
    "חוף ים",
    "מזוודה",
    "טיול מאורגן",
    "כרטיס טיסה",
    "דרכון",
    "טיול שטח",
  ],
  school: [
    "מורה",
    "כיתה",
    "בחינה",
    "מחברת",
    "יומן",
    "הפסקה",
    "שיעורי בית",
    "לוח",
    "טוש מחיק",
    "מנהל בית ספר",
  ],
  entertainment: [
    "נטפליקס",
    "קולנוע",
    "סדרה",
    "סרט אימה",
    "קומדיה",
    "פופקורן",
    "כרטיסים",
    "במה",
    "הופעה",
    "פסטיבל",
  ],
  music: [
    "גיטרה",
    "תופים",
    "פסנתר",
    "מיקרופון",
    "שיר אהבה",
    "פזמון",
    "זמר",
    "להקה",
    "אוזניות",
    "קונצרט",
  ],
  nature: [
    "יער",
    "ים",
    "הר",
    "מדבר",
    "ציפור",
    "פרח",
    "עץ",
    "גשם",
    "שמש",
    "ענן",
  ],
  holidays: [
    "חנוכה",
    "פורים",
    "ראש השנה",
    "סוכה",
    "פסח",
    "מימונה",
    "ליל סדר",
    "תחפושת",
    "סביבון",
    "מתנות לחג",
  ],
  animals: [
    "כלב",
    "חתול",
    "סוס",
    "פרה",
    "גמל",
    "פיל",
    "אריה",
    "קוף",
    "דג זהב",
    "תוכי",
  ],
  objects: [
    "כיסא",
    "שולחן",
    "מנעול",
    "מפתח",
    "שעון יד",
    "טלוויזיה",
    "מנורה",
    "תיק גב",
    "בקבוק מים",
    "מצלמה",
  ],
};

// ----------------------
//   לוגיקת משחק
// ----------------------

const games = {}; // code -> game object

function makeGameCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c = "";
  for (let i = 0; i < 4; i++) {
    c += chars[Math.floor(Math.random() * chars.length)];
  }
  return c;
}

function pickWordForGame(game) {
  const categories =
    game.categories && game.categories.length
      ? game.categories
      : Object.keys(WORD_SETS);

  if (!categories.length) {
    return "מילה";
  }

  const cat =
    categories[Math.floor(Math.random() * categories.length)] || "general";
  const words = WORD_SETS[cat] || WORD_SETS.general || ["מילה"];

  if (!game.usedWords) {
    game.usedWords = new Set();
  }

  let tries = 0;
  let word = words[Math.floor(Math.random() * words.length)];
  while (game.usedWords.has(word) && tries < 10) {
    word = words[Math.floor(Math.random() * words.length)];
    tries++;
  }
  game.usedWords.add(word);
  if (game.usedWords.size > 300) {
    game.usedWords.clear();
  }
  return word;
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
    teams: game.teams,
    currentRound: game.currentRound
      ? {
          active: game.currentRound.active,
          teamId: game.currentRound.teamId,
          explainerId: game.currentRound.explainerId,
          roundSeconds: game.currentRound.roundSeconds,
          startedAt: game.currentRound.startedAt,
          roundScore: game.currentRound.roundScore,
        }
      : null,
  };
}

function broadcastGame(game) {
  const safe = sanitizeGame(game);
  io.to("game-" + game.code).emit("gameUpdated", safe);
}

function getScores(game) {
  const scores = {};
  Object.keys(game.teams).forEach((id) => {
    scores[id] = game.teams[id].score || 0;
  });
  return scores;
}

function endGame(game, reason) {
  const scores = getScores(game);
  let maxScore = -Infinity;
  let winnerTeamIds = [];

  Object.entries(scores).forEach(([id, score]) => {
    if (score > maxScore) {
      maxScore = score;
      winnerTeamIds = [id];
    } else if (score === maxScore) {
      winnerTeamIds.push(id);
    }
  });

  io.to("game-" + game.code).emit("gameEnded", {
    gameCode: game.code,
    reason: reason || "finished",
    scores,
    teams: game.teams,
    winnerTeamIds,
  });

  delete games[game.code];
}

// ----------------------
//   Socket.IO
// ----------------------

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("createGame", (payload, cb) => {
    try {
      const {
        hostName,
        numTeams,
        teamNames,
        targetScore,
        defaultRoundSeconds,
        categories,
      } = payload || {};

      const code = makeGameCode();
      const teams = {};
      const namesArray = teamNames || [];

      const count = Math.min(Math.max(numTeams || 2, 1), 5);
      const teamIds = ["A", "B", "C", "D", "E"].slice(0, count);

      teamIds.forEach((id, idx) => {
        teams[id] = {
          id,
          name: namesArray[idx] || `קבוצה ${idx + 1}`,
          score: 0,
          players: [],
        };
      });

      const game = {
        code,
        hostSocketId: socket.id,
        hostName: hostName || "מנהל",
        createdAt: Date.now(),
        targetScore: targetScore || 30,
        defaultRoundSeconds: defaultRoundSeconds || 60,
        categories: Array.isArray(categories) ? categories : [],
        teams,
        players: {},
        currentRound: null,
        usedWords: new Set(),
      };

      games[code] = game;
      socket.join("game-" + code);

      const safeGame = sanitizeGame(game);
      if (cb) {
        cb({ ok: true, gameCode: code, game: safeGame });
      }

      broadcastGame(game);
    } catch (err) {
      console.error("createGame error:", err);
      if (cb) cb({ ok: false, error: "Server error" });
    }
  });

  socket.on("joinGame", (payload, cb) => {
    try {
      const { gameCode, playerName, teamId, clientId } = payload || {};
      const code = (gameCode || "").toUpperCase();
      const game = games[code];
      if (!game) {
        return cb && cb({ ok: false, error: "המשחק לא נמצא" });
      }
      if (!playerName) {
        return cb && cb({ ok: false, error: "צריך שם שחקן" });
      }
      const teamKey = teamId || "A";
      if (!game.teams[teamKey]) {
        return cb && cb({ ok: false, error: "קבוצה לא קיימת" });
      }

      const cid =
        clientId && typeof clientId === "string"
          ? clientId
          : "c-" + Math.random().toString(36).slice(2);

      let player = game.players[cid];
      if (!player) {
        player = {
          clientId: cid,
          name: playerName,
          teamId: teamKey,
          socketId: socket.id,
        };
        game.players[cid] = player;
        if (!game.teams[teamKey].players.includes(cid)) {
          game.teams[teamKey].players.push(cid);
        }
      } else {
        player.name = playerName;
        player.teamId = teamKey;
        player.socketId = socket.id;

        Object.values(game.teams).forEach((t) => {
          t.players = t.players.filter((p) => p !== cid);
        });
        if (!game.teams[teamKey].players.includes(cid)) {
          game.teams[teamKey].players.push(cid);
        }
      }

      socket.join("game-" + code);

      const safeGame = sanitizeGame(game);
      cb &&
        cb({
          ok: true,
          gameCode: code,
          game: safeGame,
          clientId: cid,
        });

      broadcastGame(game);
    } catch (err) {
      console.error("joinGame error:", err);
      cb && cb({ ok: false, error: "Server error" });
    }
  });

  socket.on("leaveGame", (payload) => {
    try {
      const { gameCode, clientId } = payload || {};
      const code = (gameCode || "").toUpperCase();
      const game = games[code];
      if (!game || !clientId) return;

      const player = game.players[clientId];
      if (!player) return;

      Object.values(game.teams).forEach((t) => {
        t.players = t.players.filter((p) => p !== clientId);
      });

      delete game.players[clientId];

      socket.leave("game-" + code);
      broadcastGame(game);
    } catch (err) {
      console.error("leaveGame error:", err);
    }
  });

  socket.on("startRound", (payload, cb) => {
    try {
      const { gameCode, teamId, explainerId, roundSeconds } = payload || {};
      const code = (gameCode || "").toUpperCase();
      const game = games[code];
      if (!game) {
        return cb && cb({ ok: false, error: "המשחק לא נמצא" });
      }
      if (!teamId || !game.teams[teamId]) {
        return cb && cb({ ok: false, error: "קבוצה לא קיימת" });
      }
      if (!explainerId || !game.players[explainerId]) {
        return cb && cb({ ok: false, error: "שחקן לא נמצא" });
      }

      const rs = roundSeconds || game.defaultRoundSeconds || 60;

      game.currentRound = {
        active: true,
        teamId,
        explainerId,
        roundSeconds: rs,
        startedAt: Date.now(),
        roundScore: 0,
      };

      const safeGame = sanitizeGame(game);

      io.to("game-" + code).emit("roundStarted", {
        gameCode: code,
        teamId,
        explainerId,
        roundTime: rs,
        teams: safeGame.teams,
        targetScore: safeGame.targetScore,
        scores: getScores(game),
      });

      const player = game.players[explainerId];
      if (player && player.socketId) {
        const word = pickWordForGame(game);
        io.to(player.socketId).emit("wordForExplainer", { word });
      }

      broadcastGame(game);
      cb && cb({ ok: true });
    } catch (err) {
      console.error("startRound error:", err);
      cb && cb({ ok: false, error: "Server error" });
    }
  });

  socket.on("markCorrect", (payload) => {
    try {
      const { gameCode } = payload || {};
      const code = (gameCode || "").toUpperCase();
      const game = games[code];
      if (!game || !game.currentRound || !game.currentRound.active) return;

      const cid = findClientIdBySocket(game, socket.id);
      if (!cid || cid !== game.currentRound.explainerId) return;

      const teamId = game.currentRound.teamId;
      const team = game.teams[teamId];
      if (!team) return;

      team.score = (team.score || 0) + 1;
      game.currentRound.roundScore++;

      const scores = getScores(game);

      io.to("game-" + code).emit("scoreUpdated", {
        gameCode: code,
        teamId,
        delta: +1,
        scores,
        teams: game.teams,
        targetScore: game.targetScore,
      });

      const word = pickWordForGame(game);
      socket.emit("wordForExplainer", { word });

      if (team.score >= game.targetScore) {
        endGame(game, "targetScore");
        return;
      }

      broadcastGame(game);
    } catch (err) {
      console.error("markCorrect error:", err);
    }
  });

  socket.on("skipWord", (payload) => {
    try {
      const { gameCode } = payload || {};
      const code = (gameCode || "").toUpperCase();
      const game = games[code];
      if (!game || !game.currentRound || !game.currentRound.active) return;

      const cid = findClientIdBySocket(game, socket.id);
      if (!cid || cid !== game.currentRound.explainerId) return;

      const teamId = game.currentRound.teamId;
      const team = game.teams[teamId];
      if (!team) return;

      team.score = (team.score || 0) - 1;
      if (team.score < 0) team.score = 0;
      game.currentRound.roundScore--;

      const scores = getScores(game);

      io.to("game-" + code).emit("scoreUpdated", {
        gameCode: code,
        teamId,
        delta: -1,
        scores,
        teams: game.teams,
        targetScore: game.targetScore,
      });

      const word = pickWordForGame(game);
      socket.emit("wordForExplainer", { word });

      broadcastGame(game);
    } catch (err) {
      console.error("skipWord error:", err);
    }
  });

  socket.on("endRound", (payload, cb) => {
    try {
      const { gameCode } = payload || {};
      const code = (gameCode || "").toUpperCase();
      const game = games[code];
      if (!game || !game.currentRound) {
        return cb && cb({ ok: false, error: "אין סיבוב פעיל" });
      }

      const round = game.currentRound;
      game.currentRound = null;

      const scores = getScores(game);

      io.to("game-" + code).emit("roundEnded", {
        gameCode: code,
        teamId: round.teamId,
        roundScore: round.roundScore,
        scores,
        teams: game.teams,
        targetScore: game.targetScore,
      });

      broadcastGame(game);
      cb && cb({ ok: true });
    } catch (err) {
      console.error("endRound error:", err);
      cb && cb({ ok: false, error: "Server error" });
    }
  });

  socket.on("endGame", (payload, cb) => {
    try {
      const { gameCode } = payload || {};
      const code = (gameCode || "").toUpperCase();
      const game = games[code];
      if (!game) {
        return cb && cb({ ok: false, error: "המשחק לא נמצא" });
      }
      endGame(game, "manual");
      cb && cb({ ok: true });
    } catch (err) {
      console.error("endGame error:", err);
      cb && cb({ ok: false, error: "Server error" });
    }
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
    Object.values(games).forEach((game) => {
      Object.values(game.players).forEach((p) => {
        if (p.socketId === socket.id) {
          p.socketId = null;
        }
      });
    });
  });
});

function findClientIdBySocket(game, socketId) {
  for (const [cid, p] of Object.entries(game.players)) {
    if (p.socketId === socketId) return cid;
  }
  return null;
}

// ----------------------
//   הפעלת השרת
// ----------------------

server.listen(PORT, () => {
  console.log("שרת כהנ'ס רץ על פורט", PORT);
});
