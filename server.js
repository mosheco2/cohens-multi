// server.js
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const ADMIN_CODE = process.env.COHENS_ADMIN_CODE || "cohens1234";

// ----------------- BANNERS (IN-MEMORY) -----------------

let banners = {
  index: {
    imageUrl: "",
    linkUrl: ""
  },
  host: {
    imageUrl: "",
    linkUrl: ""
  },
  player: {
    imageUrl: "",
    linkUrl: ""
  }
};

app.get("/api/banners", (req, res) => {
  res.json(banners);
});

app.post("/api/admin/banners", (req, res) => {
  const { adminCode, index, host, player } = req.body || {};
  if (!adminCode || adminCode !== ADMIN_CODE) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  if (index) {
    banners.index = {
      ...banners.index,
      ...index
    };
  }
  if (host) {
    banners.host = {
      ...banners.host,
      ...host
    };
  }
  if (player) {
    banners.player = {
      ...banners.player,
      ...player
    };
  }

  return res.json({ ok: true, banners });
});

// ----------------- GAME LOGIC -----------------

const TEAM_LETTERS = ["A", "B", "C", "D", "E"];

let games = {}; // gameCode -> game object
let socketToPlayer = {}; // socket.id -> { gameCode, clientId }

// מאגר מילים לפי קטגוריות
const WORD_PACKS = {
  classic: [
    "טלפון",
    "שולחן",
    "כורסה",
    "חולצה",
    "חבר",
    "מפתח",
    "עיתון",
    "מסך",
    "חול",
    "עץ",
    "חלון",
    "מטבח",
    "מדרגות",
    "אוטובוס",
    "קניון",
    "אורז",
    "חגורה",
    "ספה",
    "תיק",
    "מקרר",
    "שכנים",
    "מעלית",
    "חניה",
    "דלת"
  ],
  family: [
    "צעצוע",
    "חד קרן",
    "ממתק",
    "ארמון",
    "כדורגל",
    "לגו",
    "בריכה",
    "אבטיח",
    "ארוחת ערב",
    "טיול משפחתי",
    "אחים",
    "סבתא",
    "סבא",
    "חיבוק",
    "סיפור לפני השינה",
    "גן ילדים",
    "בית ספר",
    "חגיגת יום הולדת",
    "חיבוק דובי",
    "עגלת תינוק"
  ],
  hard: [
    "פילוסופיה",
    "מקריות",
    "אשליה",
    "אינטואיציה",
    "השראה",
    "תודעה",
    "שגרה",
    "פוטנציאל",
    "אחריות",
    "עצמאות",
    "זיכרון",
    "אמפתיה",
    "פרספקטיבה",
    "התנגדות",
    "תובנה"
  ],
  food: [
    "חומוס",
    "פלאפל",
    "שווארמה",
    "קוסקוס",
    "ג׳חנון",
    "מלוואח",
    "קובה",
    "ממולאים",
    "סלט חצילים",
    "טחינה",
    "פיתות",
    "שקשוקה",
    "מרק עוף",
    "חמין",
    "שיפודים",
    "בורקס",
    "עוגת גבינה",
    "אורז לבן",
    "קישואים ממולאים",
    "עלי גפן",
    "סלט ישראלי",
    "לחם טרי",
    "ספינג׳"
  ],
  sports: [
    "כדורגל",
    "כדורסל",
    "טניס",
    "שחייה",
    "ריצה",
    "אופניים",
    "כדורעף",
    "כדוריד",
    "התעמלות",
    "כדורגל שולחן",
    "סטנגה",
    "אימון כוח",
    "מגרש",
    "שופט",
    "נבחרת",
    "איצטדיון",
    "שוער",
    "גול",
    "מדליה",
    "טורניר"
  ],
  professions: [
    "רופא",
    "אחות",
    "מורה",
    "נהג מונית",
    "שוטר",
    "כבאי",
    "עורך דין",
    "אדריכל",
    "טבח",
    "מלצר",
    "מוכר בחנות",
    "תוכניתן",
    "מעצב גרפי",
    "מנכ״ל",
    "מנהלת משרד",
    "יועץ עסקי",
    "ספר",
    "חשמלאי",
    "אינסטלטור",
    "נהג אוטובוס"
  ]
};

// מחזיר מערך מילים לפי כמה קטגוריות
function getWordsForPacks(keys) {
  let packs = Array.isArray(keys) && keys.length ? keys : Object.keys(WORD_PACKS);
  let allWords = [];

  packs.forEach((k) => {
    const key = (k || "").toString().trim();
    if (!key) return;

    if (key === "all") {
      Object.values(WORD_PACKS).forEach((arr) => {
        allWords.push(...arr);
      });
    } else if (WORD_PACKS[key]) {
      allWords.push(...WORD_PACKS[key]);
    }
  });

  if (!allWords.length) {
    Object.values(WORD_PACKS).forEach((arr) => {
      allWords.push(...arr);
    });
  }

  return [...allWords];
}

function generateGameCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  if (games[code]) return generateGameCode();
  return code;
}

function serializeTeams(game) {
  const out = {};
  Object.entries(game.teams).forEach(([id, t]) => {
    out[id] = {
      id,
      name: t.name,
      score: t.score || 0
    };
  });
  return out;
}

function buildScores(game) {
  const s = {};
  Object.entries(game.teams).forEach(([id, t]) => {
    s[id] = t.score || 0;
  });
  return s;
}

function serializeGame(game) {
  return {
    code: game.code,
    targetScore: game.targetScore,
    teams: serializeTeams(game),
    players: game.players.map((p) => ({
      id: p.clientId,
      name: p.name,
      teamId: p.teamId,
      isHost: !!p.isHost,
      isConnected: !!p.isConnected
    })),
    wordPackKeys: game.wordPackKeys || []
  };
}

function broadcastGameUpdate(game) {
  io.to(game.code).emit("gameUpdated", serializeGame(game));
}

function getNextWord(game) {
  if (!game.words || !game.words.length) {
    game.words = getWordsForPacks(game.wordPackKeys);
  }
  if (!game.words.length) {
    return "אין מילים זמינות";
  }
  const idx = Math.floor(Math.random() * game.words.length);
  const word = game.words.splice(idx, 1)[0];
  return word || "מילה";
}

function computeWinnerTeamIds(game) {
  const scores = buildScores(game);
  let max = -Infinity;
  Object.values(scores).forEach((v) => {
    if (v > max) max = v;
  });
  if (max < 0) return [];
  const winners = Object.entries(scores)
    .filter(([, s]) => s === max)
    .map(([id]) => id);
  return winners;
}

function endGameInternal(game, forceWinnerIds) {
  if (game.isEnded) return;
  game.isEnded = true;
  const scores = buildScores(game);
  let winnerTeamIds = forceWinnerIds;
  if (!winnerTeamIds || !winnerTeamIds.length) {
    winnerTeamIds = computeWinnerTeamIds(game);
  }
  io.to(game.code).emit("gameEnded", {
    teams: serializeTeams(game),
    scores,
    winnerTeamIds
  });
}

// ----------------- SOCKET.IO -----------------

io.on("connection", (socket) => {
  // יצירת משחק (Host)
  socket.on("createGame", (payload, callback) => {
    try {
      const hostName = (payload.hostName || "מנהל").toString().trim();
      let teamCount = parseInt(payload.teamCount || 2, 10);
      if (Number.isNaN(teamCount) || teamCount < 2) teamCount = 2;
      if (teamCount > 5) teamCount = 5;

      let targetScore = parseInt(payload.targetScore || 30, 10);
      if (Number.isNaN(targetScore) || targetScore < 5) targetScore = 30;
      if (targetScore > 200) targetScore = 200;

      // קטגוריות מילים - אפשר כמה בבת אחת
      const rawKeys = Array.isArray(payload.wordPackKeys) ? payload.wordPackKeys : [];
      let wordPackKeys = rawKeys
        .map((k) => (k || "").toString().trim())
        .filter((k) => k);

      if (!wordPackKeys.length) {
        let single = (payload.wordPack || "classic").toString().trim();
        if (!single) single = "classic";
        if (single === "all") {
          wordPackKeys = Object.keys(WORD_PACKS);
        } else {
          wordPackKeys = [single];
        }
      }

      const teamNames = payload.teamNames || {};

      const code = generateGameCode();

      const teams = {};
      for (let i = 0; i < teamCount; i++) {
        const id = TEAM_LETTERS[i];
        teams[id] = {
          id,
          name: teamNames[id] && teamNames[id].trim()
            ? teamNames[id].trim()
            : "קבוצה " + id,
          score: 0
        };
      }

      const hostClientId = "host-" + code;
      const hostPlayer = {
        clientId: hostClientId,
        socketId: socket.id,
        name: hostName,
        teamId: "A",
        isHost: true,
        isConnected: true
      };

      const game = {
        code,
        hostSocketId: socket.id,
        targetScore,
        wordPackKeys,
        teams,
        players: [hostPlayer],
        words: getWordsForPacks(wordPackKeys),
        currentRound: null,
        isEnded: false
      };

      games[code] = game;
      socket.join(code);
      socketToPlayer[socket.id] = { gameCode: code, clientId: hostClientId };

      const responseGame = serializeGame(game);

      if (callback) {
        callback({ ok: true, gameCode: code, game: responseGame });
      }

      broadcastGameUpdate(game);
    } catch (err) {
      console.error("createGame error", err);
      if (callback) callback({ ok: false, error: "Server error" });
    }
  });

  // הצטרפות למשחק (Player)
  socket.on("joinGame", (payload, callback) => {
    try {
      const code = (payload.gameCode || "").toString().trim().toUpperCase();
      const playerName = (payload.playerName || "").toString().trim() || "שחקן";
      let teamId = (payload.teamId || "A").toString().toUpperCase();
      const clientIdFromClient = (payload.clientId || "").toString().trim();

      const game = games[code];
      if (!game || game.isEnded) {
        if (callback) callback({ ok: false, error: "המשחק לא קיים או הסתיים." });
        return;
      }

      if (!game.teams[teamId]) {
        const defaultTeamId = Object.keys(game.teams)[0] || "A";
        teamId = defaultTeamId;
      }

      let clientId = clientIdFromClient;
      if (!clientId) {
        clientId = "c-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      }

      let player = game.players.find((p) => p.clientId === clientId);

      if (!player) {
        player = {
          clientId,
          socketId: socket.id,
          name: playerName,
          teamId,
          isHost: false,
          isConnected: true
        };
        game.players.push(player);
      } else {
        player.socketId = socket.id;
        player.name = playerName;
        player.teamId = teamId;
        player.isConnected = true;
      }

      socket.join(code);
      socketToPlayer[socket.id] = { gameCode: code, clientId };

      const responseGame = serializeGame(game);
      if (callback) {
        callback({ ok: true, gameCode: code, clientId, game: responseGame });
      }

      broadcastGameUpdate(game);
    } catch (err) {
      console.error("joinGame error", err);
      if (callback) callback({ ok: false, error: "Server error" });
    }
  });

  // התחלת סיבוב
  socket.on("startRound", (payload) => {
    try {
      const code = (payload.gameCode || "").toString().trim().toUpperCase();
      const game = games[code];
      if (!game || game.isEnded) return;

      let teamId = (payload.teamId || "").toString().toUpperCase();
      if (!game.teams[teamId]) {
        teamId = Object.keys(game.teams)[0];
      }

      let roundTime = parseInt(payload.roundTime || 60, 10);
      if (Number.isNaN(roundTime) || roundTime < 20) roundTime = 60;
      if (roundTime > 240) roundTime = 240;

      let explainerClientId = payload.explainerId || null;
      if (!explainerClientId) {
        const candidates = game.players.filter(
          (p) => p.teamId === teamId && p.isConnected
        );
        if (candidates.length) {
          explainerClientId = candidates[0].clientId;
        }
      }

      game.currentRound = {
        isActive: true,
        teamId,
        explainerClientId,
        endsAt: Date.now() + roundTime * 1000,
        currentWord: null,
        roundScore: 0
      };

      const scores = buildScores(game);
      const roundPayload = {
        teamId,
        explainerId: explainerClientId || null,
        roundTime,
        teams: serializeTeams(game),
        scores,
        targetScore: game.targetScore
      };

      io.to(code).emit("roundStarted", roundPayload);

      if (explainerClientId) {
        const explainer = game.players.find((p) => p.clientId === explainerClientId);
        if (explainer && explainer.socketId) {
          const word = getNextWord(game);
          game.currentRound.currentWord = word;
          io.to(explainer.socketId).emit("wordForExplainer", { word });
        }
      }
    } catch (err) {
      console.error("startRound error", err);
    }
  });

  // סיום סיבוב
  socket.on("endRound", (payload) => {
    try {
      const code = (payload.gameCode || "").toString().trim().toUpperCase();
      const game = games[code];
      if (!game || !game.currentRound || !game.currentRound.isActive) return;

      const round = game.currentRound;
      round.isActive = false;

      const scores = buildScores(game);
      const roundScore =
        typeof round.roundScore === "number" ? round.roundScore : 0;

      io.to(code).emit("roundEnded", {
        teamId: round.teamId,
        teams: serializeTeams(game),
        scores,
        roundScore
      });

      // בדיקת ניצחון
      const winners = computeWinnerTeamIds(game);
      if (winners.length && Math.max(...Object.values(scores)) >= game.targetScore) {
        endGameInternal(game, winners);
      }
    } catch (err) {
      console.error("endRound error", err);
    }
  });

  // תשובה נכונה
  socket.on("markCorrect", (payload) => {
    try {
      const code = (payload.gameCode || "").toString().trim().toUpperCase();
      const game = games[code];
      if (!game || !game.currentRound || !game.currentRound.isActive) return;

      const teamId = game.currentRound.teamId;
      if (!game.teams[teamId]) return;

      game.teams[teamId].score = (game.teams[teamId].score || 0) + 1;

      if (game.currentRound) {
        game.currentRound.roundScore =
          (game.currentRound.roundScore || 0) + 1;
      }

      const scores = buildScores(game);
      io.to(code).emit("scoreUpdated", {
        teams: serializeTeams(game),
        scores,
        targetScore: game.targetScore
      });

      const round = game.currentRound;
      if (round && round.isActive && round.explainerClientId) {
        const explainer = game.players.find(
          (p) => p.clientId === round.explainerClientId
        );
        if (explainer && explainer.socketId) {
          const word = getNextWord(game);
          round.currentWord = word;
          io.to(explainer.socketId).emit("wordForExplainer", { word });
        }
      }

      if (scores[teamId] >= game.targetScore) {
        endGameInternal(game, [teamId]);
      }
    } catch (err) {
      console.error("markCorrect error", err);
    }
  });

  // דילוג על מילה - מוריד נקודה
  socket.on("skipWord", (payload) => {
    try {
      const code = (payload.gameCode || "").toString().trim().toUpperCase();
      const game = games[code];
      if (!game || !game.currentRound || !game.currentRound.isActive) return;

      const round = game.currentRound;
      const teamId = round.teamId;
      if (!game.teams[teamId]) return;

      const currentScore = game.teams[teamId].score || 0;
      game.teams[teamId].score = Math.max(0, currentScore - 1);

      if (round) {
        round.roundScore = (round.roundScore || 0) - 1;
      }

      const scores = buildScores(game);
      io.to(code).emit("scoreUpdated", {
        teams: serializeTeams(game),
        scores,
        targetScore: game.targetScore
      });

      if (!round.explainerClientId) return;
      const explainer = game.players.find(
        (p) => p.clientId === round.explainerClientId
      );
      if (!explainer || !explainer.socketId) return;

      const word = getNextWord(game);
      round.currentWord = word;
      io.to(explainer.socketId).emit("wordForExplainer", { word });
    } catch (err) {
      console.error("skipWord error", err);
    }
  });

  // סיום משחק ע"י המנהל
  socket.on("endGame", (payload) => {
    try {
      const code = (payload.gameCode || "").toString().trim().toUpperCase();
      const game = games[code];
      if (!game) return;
      endGameInternal(game);
    } catch (err) {
      console.error("endGame error", err);
    }
  });

  // ניתוק שחקן
  socket.on("disconnect", () => {
    try {
      const mapping = socketToPlayer[socket.id];
      if (!mapping) return;
      const { gameCode, clientId } = mapping;
      delete socketToPlayer[socket.id];

      const game = games[gameCode];
      if (!game) return;

      const player = game.players.find((p) => p.clientId === clientId);
      if (!player) return;

      player.isConnected = false;
      player.socketId = null;

      broadcastGameUpdate(game);
    } catch (err) {
      console.error("disconnect error", err);
    }
  });
});

// ----------------- START SERVER -----------------

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Cohens Alias server listening on port", PORT);
});
