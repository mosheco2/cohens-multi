// server.js - כהנ'ס Party

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

const PORT = process.env.PORT || 10000;
const ADMIN_CODE = process.env.ADMIN_CODE || "cohens1234";

// 24 שעות במילישניות
const GAME_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// ----------------------
//   DB Connection
// ----------------------

const useDb = !!process.env.DATABASE_URL;
let pool = null;

if (useDb) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl:
      process.env.DATABASE_SSL === "false"
        ? false
        : { rejectUnauthorized: false },
  });
  pool
    .connect()
    .then((client) => {
      console.log("Connected to PostgreSQL");
      client.release();
    })
    .catch((err) => {
      console.error("Failed to connect to PostgreSQL:", err.message);
    });
}

async function dbQuery(text, params) {
  if (!pool) return null;
  try {
    return await pool.query(text, params);
  } catch (err) {
    console.error("DB error:", err.message);
    return null;
  }
}

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

app.get("/api/admin/rooms", async (req, res) => {
  // אם יש DB – ננסה קודם ממנו
  if (pool) {
    try {
      const gamesResult = await dbQuery(
        `
        SELECT code,
               host_name,
               target_score,
               default_round_seconds,
               categories,
               created_at,
               updated_at,
               last_activity,
               status
        FROM games
        WHERE status = 'active'
        ORDER BY created_at DESC
      `,
        []
      );

      const playersResult = await dbQuery(
        `
        SELECT game_code, client_id, name, team_id
        FROM game_players
      `,
        []
      );

      const rooms = [];
      const playersByGame = new Map();

      if (playersResult && playersResult.rows) {
        for (const row of playersResult.rows) {
          const list =
            playersByGame.get(row.game_code) || playersByGame.set(row.game_code, []).get(row.game_code);
        }
      }

      // הקוד לעיל מכניס רפרנס מוזר, נעדכן אותו בצורה נקייה:
    } catch (err) {
      console.error("Error in /api/admin/rooms (DB path):", err);
    }
  }

  // אם אין DB / הייתה שגיאה – נ fallback לזיכרון
  try {
    const rooms = [];

    Object.entries(games).forEach(([code, game]) => {
      if (!game) return;

      const playersMap = game.players || {};
      const teamsMap = game.teams || {};

      const playersArr = Object.values(playersMap).map((p, idx) => {
        const teamId = p && p.teamId ? p.teamId : null;
        const teamName =
          teamId && teamsMap[teamId]
            ? teamsMap[teamId].name || `קבוצה ${teamId}`
            : null;

        return {
          name: p && p.name ? p.name : `שחקן ${idx + 1}`,
          teamId: teamId,
          teamName: teamName,
        };
      });

      rooms.push({
        code: game.code || code,
        name: game.name || game.title || `משחק ${code}`,
        managerName: game.hostName || null,
        status:
          game.currentRound && game.currentRound.active
            ? "round-active"
            : "active",
        createdAt: game.createdAt || null,
        updatedAt: game.updatedAt || null,
        lastActivity: game.lastActivity || null,
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
    console.error("Error in /api/admin/rooms (memory path):", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// סגירת חדר ידנית ע"י אדמין
app.post("/api/admin/rooms/:code/close", async (req, res) => {
  try {
    const code = (req.params.code || "").toUpperCase();
    const game = games[code];

    if (game) {
      // יש משחק בזיכרון – נסגור גם ב-Socket וגם ב-DB
      endGame(game, "admin-close");
      return res.json({ ok: true });
    } else if (pool) {
      // אין משחק בזיכרון אבל קיים ב-DB – נסמן כנסגר
      const result = await dbQuery(
        `
        UPDATE games
        SET status = 'admin-close',
            updated_at = NOW(),
            last_activity = NOW()
        WHERE code = $1
        RETURNING code
      `,
        [code]
      );
      if (result && result.rowCount > 0) {
        return res.json({ ok: true });
      } else {
        return res
          .status(404)
          .json({ ok: false, error: "החדר לא נמצא בשרת או בבסיס הנתונים" });
      }
    } else {
      return res
        .status(404)
        .json({ ok: false, error: "המשחק לא נמצא" });
    }
  } catch (err) {
    console.error("Error in /api/admin/rooms/:code/close:", err);
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
//   לוגיקת משחק בזיכרון
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

// עדכון זמן פעילות במשחק
function touchGame(game) {
  const now = Date.now();
  game.updatedAt = now;
  game.lastActivity = now;
}

// בחירת מילה
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
    updatedAt: game.updatedAt,
    lastActivity: game.lastActivity,
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

async function markGameStatusInDb(gameCode, status) {
  if (!pool) return;
  await dbQuery(
    `
    UPDATE games
    SET status = $2,
        updated_at = NOW(),
        last_activity = NOW()
    WHERE code = $1
  `,
    [gameCode, status]
  );
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

  // עדכון ב-DB (אם קיים)
  markGameStatusInDb(game.code, reason || "finished").catch(() => {});

  delete games[game.code];
}

// ----------------------
//   Socket.IO
// ----------------------

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("createGame", async (payload, cb) => {
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

      const now = Date.now();

      const game = {
        code,
        hostSocketId: socket.id,
        hostName: hostName || "מנהל",
        createdAt: now,
        updatedAt: now,
        lastActivity: now,
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

      // כתיבה ל-DB (לא חובה למשחק לחיות, אבל טוב להיסטוריה)
      if (pool) {
        await dbQuery(
          `
          INSERT INTO games (code, host_name, target_score, default_round_seconds, categories, status)
          VALUES ($1, $2, $3, $4, $5, 'active')
          ON CONFLICT (code) DO UPDATE
          SET host_name = EXCLUDED.host_name,
              target_score = EXCLUDED.target_score,
              default_round_seconds = EXCLUDED.default_round_seconds,
              categories = EXCLUDED.categories,
              status = 'active',
              updated_at = NOW(),
              last_activity = NOW()
        `,
          [
            code,
            game.hostName,
            game.targetScore,
            game.defaultRoundSeconds,
            game.categories,
          ]
        );
      }

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

  socket.on("joinGame", async (payload, cb) => {
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

      touchGame(game);

      socket.join("game-" + code);

      // כתיבה ל-DB על שחקן ופעילות
      if (pool) {
        await dbQuery(
          `
          INSERT INTO game_players (game_code, client_id, name, team_id)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (game_code, client_id) DO UPDATE
          SET name = EXCLUDED.name,
              team_id = EXCLUDED.team_id
        `,
          [code, cid, playerName, teamKey]
        );

        await dbQuery(
          `
          UPDATE games
          SET last_activity = NOW(), updated_at = NOW()
          WHERE code = $1
        `,
          [code]
        );
      }

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

  socket.on("leaveGame", async (payload) => {
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

      touchGame(game);

      socket.leave("game-" + code);
      broadcastGame(game);

      if (pool) {
        await dbQuery(
          `
          DELETE FROM game_players
          WHERE game_code = $1 AND client_id = $2
        `,
          [code, clientId]
        );
        await dbQuery(
          `
          UPDATE games
          SET last_activity = NOW(), updated_at = NOW()
          WHERE code = $1
        `,
          [code]
        );
      }
    } catch (err) {
      console.error("leaveGame error:", err);
    }
  });

  socket.on("startRound", async (payload, cb) => {
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

      touchGame(game);

      if (pool) {
        await dbQuery(
          `
          UPDATE games
          SET last_activity = NOW(), updated_at = NOW()
          WHERE code = $1
        `,
          [code]
        );
      }

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

  socket.on("markCorrect", async (payload) => {
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

      touchGame(game);

      if (pool) {
        await dbQuery(
          `
          UPDATE games
          SET last_activity = NOW(), updated_at = NOW()
          WHERE code = $1
        `,
          [code]
        );
      }

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

  socket.on("skipWord", async (payload) => {
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

      touchGame(game);

      if (pool) {
        await dbQuery(
          `
          UPDATE games
          SET last_activity = NOW(), updated_at = NOW()
          WHERE code = $1
        `,
          [code]
        );
      }

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

  socket.on("endRound", async (payload, cb) => {
    try {
      const { gameCode } = payload || {};
      const code = (gameCode || "").toUpperCase();
      const game = games[code];
      if (!game || !game.currentRound) {
        return cb && cb({ ok: false, error: "אין סיבוב פעיל" });
      }

      const round = game.currentRound;
      game.currentRound = null;

      touchGame(game);

      if (pool) {
        await dbQuery(
          `
          UPDATE games
          SET last_activity = NOW(), updated_at = NOW()
          WHERE code = $1
        `,
          [code]
        );
      }

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

  socket.on("endGame", async (payload, cb) => {
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
      let touched = false;
      Object.values(game.players).forEach((p) => {
        if (p.socketId === socket.id) {
          p.socketId = null;
          touched = true;
        }
      });
      if (touched) {
        touchGame(game);
      }
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
//   מנגנון סגירה אוטומטי אחרי 24 שעות
// ----------------------

setInterval(() => {
  const now = Date.now();
  const codesToClose = [];

  for (const [code, game] of Object.entries(games)) {
    if (!game) continue;
    const base =
      typeof game.lastActivity === "number"
        ? game.lastActivity
        : typeof game.createdAt === "number"
        ? game.createdAt
        : null;
    if (!base) continue;

    const age = now - base;
    if (age > GAME_MAX_AGE_MS) {
      codesToClose.push(code);
    }
  }

  codesToClose.forEach((code) => {
    const game = games[code];
    if (!game) return;
    console.log(
      "Auto-closing game",
      code,
      "after",
      GAME_MAX_AGE_MS / (60 * 60 * 1000),
      "hours"
    );
    endGame(game, "timeout");
  });
}, 60 * 1000);

// ----------------------
//   הפעלת השרת
// ----------------------

server.listen(PORT, () => {
  console.log("שרת כהנ'ס רץ על פורט", PORT);
});
