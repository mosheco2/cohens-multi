// server.js - כהנ'ס Alias Party

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
//   חיבור ל-PostgreSQL
// ----------------------

let pool = null;
let hasDb = false;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl:
      process.env.DATABASE_SSL === "false"
        ? false
        : { rejectUnauthorized: false },
  });
  hasDb = true;
  console.log("PostgreSQL: using DATABASE_URL");

  (async function initDb() {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS games (
          id SERIAL PRIMARY KEY,
          code VARCHAR(10) UNIQUE NOT NULL,
          host_name TEXT,
          target_score INTEGER NOT NULL DEFAULT 30,
          default_round_seconds INTEGER NOT NULL DEFAULT 60,
          categories TEXT[],
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_activity TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          status TEXT NOT NULL DEFAULT 'active'
        );
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS game_players (
          id SERIAL PRIMARY KEY,
          game_code VARCHAR(10) NOT NULL REFERENCES games(code) ON DELETE CASCADE,
          client_id TEXT NOT NULL,
          name TEXT NOT NULL,
          team_id TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (game_code, client_id)
        );
      `);

      console.log("PostgreSQL: schema initialized");
    } catch (err) {
      console.error("PostgreSQL init error:", err);
    }
  })();
} else {
  console.warn("No DATABASE_URL set – running without DB persistence");
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ----------------------
//   ניהול באנרים / לוגו (in-memory)
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

  if (index) banners.index = { ...banners.index, ...index };
  if (host) banners.host = { ...banners.host, ...host };
  if (player) banners.player = { ...banners.player, ...player };
  if (logo) banners.logo = { ...banners.logo, ...logo };

  return res.json({ ok: true, banners });
});

// ----------------------
//   דוח חדרים פתוחים למנהל
// ----------------------

// נגדיר games כאן כדי שלא תהיה בעיית hoisting בהמשך
const games = {}; // code -> game object (חי ל-Socket)

// אם יש DB – נמשוך ממנו; אחרת – מהזיכרון
app.get("/api/admin/rooms", async (req, res) => {
  if (hasDb && pool) {
    try {
      const gamesRes = await pool.query(
        `SELECT code, host_name, created_at, updated_at, last_activity, status
         FROM games
         WHERE status = 'active'
         ORDER BY created_at DESC`
      );

      const gamesRows = gamesRes.rows || [];
      if (!gamesRows.length) {
        return res.json({
          ok: true,
          rooms: [],
          totalRooms: 0,
          totalPlayers: 0,
        });
      }

      const codes = gamesRows.map((g) => g.code);
      const playersRes = await pool.query(
        `SELECT game_code, client_id, name, team_id
         FROM game_players
         WHERE game_code = ANY($1::text[])`,
        [codes]
      );

      const playersRows = playersRes.rows || [];

      const playersByGame = {};
      playersRows.forEach((p) => {
        if (!playersByGame[p.game_code]) {
          playersByGame[p.game_code] = [];
        }
        playersByGame[p.game_code].push(p);
      });

      const rooms = gamesRows.map((g) => {
        const pList = playersByGame[g.code] || [];
        const players = pList.map((p, idx) => ({
          name: p.name || `שחקן ${idx + 1}`,
          teamId: p.team_id,
          teamName: p.team_id ? `קבוצה ${p.team_id}` : null,
        }));

        return {
          code: g.code,
          name: `משחק ${g.code}`,
          managerName: g.host_name || null,
          status: g.status || "active",
          createdAt: g.created_at,
          updatedAt: g.updated_at,
          lastActivity: g.last_activity,
          playersCount: players.length,
          players,
        };
      });

      const totalPlayers = rooms.reduce(
        (sum, r) => sum + (r.playersCount || 0),
        0
      );

      return res.json({
        ok: true,
        rooms,
        totalRooms: rooms.length,
        totalPlayers,
      });
    } catch (err) {
      console.error("Error in /api/admin/rooms (DB):", err);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  }

  // Fallback – ללא DB: משתמש במבנה games בזיכרון
  try {
    const rooms = [];

    Object.entries(games).forEach(([code, game]) => {
      if (!game) return;

      const playersMap = game.players || {};
      const playersArr = Object.values(playersMap).map((p, idx) => ({
        name: p && p.name ? p.name : `שחקן ${idx + 1}`,
        teamId: p.teamId,
        teamName: p.teamId ? `קבוצה ${p.teamId}` : null,
      }));

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
    console.error("Error in /api/admin/rooms (memory):", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// סגירת חדר ידנית ע"י אדמין (נקרא מעמוד admin-rooms.html)
app.post("/api/admin/rooms/:code/close", async (req, res) => {
  try {
    const code = (req.params.code || "").toUpperCase();
    const game = games[code];
    if (!game) {
      // גם אם המשחק לא בזיכרון – נסמן אותו כ"סגור" ב-DB
      if (hasDb && pool) {
        await pool.query(
          `UPDATE games SET status = 'manual-close', updated_at = NOW(), last_activity = NOW()
           WHERE code = $1`,
          [code]
        );
      }
      return res.json({ ok: true });
    }
    endGame(game, "admin-close");
    return res.json({ ok: true });
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
    "טיול משפחתי",
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
//   לוגיקת משחק (in-memory + DB sync)
// ----------------------

// ----------------------
//   לוגיקת משחק (in-memory + DB sync)
// ----------------------

// games הוגדר כבר למעלה (const games = {})

// יצירת קוד משחק
function makeGameCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c = "";
  for (let i = 0; i < 4; i++) {
    c += chars[Math.floor(Math.random() * chars.length)];
  }
  return c;
}

// עדכון זמני פעילות בזיכרון וגם ב-DB
async function touchGame(game) {
  const now = Date.now();
  game.updatedAt = now;
  game.lastActivity = now;

  if (hasDb && pool) {
    try {
      await pool.query(
        `UPDATE games
         SET updated_at = NOW(), last_activity = NOW()
         WHERE code = $1`,
      [game.code]
      );
    } catch (err) {
      console.error("touchGame DB error:", err);
    }
  }
}

// בחירת מילה לסיבוב
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

// החזרת אובייקט משחק "נקי" ללקוח
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

// חישוב ניקוד לכל קבוצה
function getScores(game) {
  const scores = {};
  Object.keys(game.teams).forEach((id) => {
    scores[id] = game.teams[id].score || 0;
  });
  return scores;
}

// סיום משחק – כולל עדכון DB ומחיקת המשחק מהזיכרון
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

  if (hasDb && pool) {
    (async () => {
      try {
        await pool.query(
          `UPDATE games
           SET status = $2, updated_at = NOW(), last_activity = NOW()
           WHERE code = $1`,
          [game.code, reason || "finished"]
        );
      } catch (err) {
        console.error("endGame DB error:", err);
      }
    })();
  }

  delete games[game.code];
}

// יצירת משחק חדש ב-DB
async function saveNewGameToDb(game) {
  if (!hasDb || !pool) return;
  try {
    await pool.query(
      `INSERT INTO games (code, host_name, target_score, default_round_seconds, categories, created_at, updated_at, last_activity, status)
       VALUES ($1,$2,$3,$4,$5,NOW(),NOW(),NOW(),'active')
       ON CONFLICT (code) DO UPDATE
       SET host_name = EXCLUDED.host_name,
           target_score = EXCLUDED.target_score,
           default_round_seconds = EXCLUDED.default_round_seconds,
           categories = EXCLUDED.categories,
           updated_at = NOW(),
           last_activity = NOW(),
           status = 'active'`,
      [
        game.code,
        game.hostName || "מנהל",
        game.targetScore || 30,
        game.defaultRoundSeconds || 60,
        game.categories || [],
      ]
    );
  } catch (err) {
    console.error("saveNewGameToDb error:", err);
  }
}

// שמירת שחקן ב-DB (צירוף / עדכון)
async function upsertPlayerInDb(gameCode, clientId, name, teamId) {
  if (!hasDb || !pool) return;
  try {
    await pool.query(
      `INSERT INTO game_players (game_code, client_id, name, team_id)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (game_code, client_id) DO UPDATE
       SET name = EXCLUDED.name,
           team_id = EXCLUDED.team_id`,
      [gameCode, clientId, name, teamId]
    );
  } catch (err) {
    console.error("upsertPlayerInDb error:", err);
  }
}

// מחיקת שחקן מה-DB
async function deletePlayerFromDb(gameCode, clientId) {
  if (!hasDb || !pool) return;
  try {
    await pool.query(
      `DELETE FROM game_players
       WHERE game_code = $1 AND client_id = $2`,
      [gameCode, clientId]
    );
  } catch (err) {
    console.error("deletePlayerFromDb error:", err);
  }
}

// טעינת משחק מה-DB אם הוא לא בזיכרון (ל-reconnect אחרי ריסט)
async function loadGameFromDb(code) {
  if (!hasDb || !pool) return null;

  try {
    const gameRes = await pool.query(
      `SELECT code, host_name, target_score, default_round_seconds, categories,
              created_at, updated_at, last_activity, status
       FROM games
       WHERE code = $1 AND status = 'active'`,
      [code]
    );

    if (!gameRes.rows.length) return null;
    const gRow = gameRes.rows[0];

    const playersRes = await pool.query(
      `SELECT client_id, name, team_id
       FROM game_players
       WHERE game_code = $1`,
      [code]
    );

    const playersRows = playersRes.rows || [];

    const teams = {};
    const players = {};

    playersRows.forEach((p, idx) => {
      const tId = p.team_id || "A";
      if (!teams[tId]) {
        teams[tId] = {
          id: tId,
          name: `קבוצה ${tId}`,
          score: 0,
          players: [],
        };
      }
      players[p.client_id] = {
        clientId: p.client_id,
        name: p.name || `שחקן ${idx + 1}`,
        teamId: tId,
        socketId: null,
      };
      teams[tId].players.push(p.client_id);
    });

    const createdAtMs = gRow.created_at
      ? new Date(gRow.created_at).getTime()
      : Date.now();
    const updatedAtMs = gRow.updated_at
      ? new Date(gRow.updated_at).getTime()
      : createdAtMs;
    const lastActivityMs = gRow.last_activity
      ? new Date(gRow.last_activity).getTime()
      : updatedAtMs;

    const game = {
      code: gRow.code,
      hostSocketId: null,
      hostName: gRow.host_name || "מנהל",
      createdAt: createdAtMs,
      updatedAt: updatedAtMs,
      lastActivity: lastActivityMs,
      targetScore: gRow.target_score || 30,
      defaultRoundSeconds: gRow.default_round_seconds || 60,
      categories: gRow.categories || [],
      teams: Object.keys(teams).length
        ? teams
        : {
            A: {
              id: "A",
              name: "קבוצה A",
              score: 0,
              players: Object.keys(players),
            },
          },
      players,
      currentRound: null,
      usedWords: new Set(),
    };

    games[code] = game;
    console.log("Game resurrected from DB:", code);
    return game;
  } catch (err) {
    console.error("loadGameFromDb error:", err);
    return null;
  }
}

// ----------------------
//   Socket.IO - events
// ----------------------

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // יצירת משחק חדש
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
      await saveNewGameToDb(game);

      socket.join("game-" + code);

      const safeGame = sanitizeGame(game);
      cb && cb({ ok: true, gameCode: code, game: safeGame });

      broadcastGame(game);
    } catch (err) {
      console.error("createGame error:", err);
      cb && cb({ ok: false, error: "Server error" });
    }
  });

  // הצטרפות למשחק (כולל ניסיון שחזור אחרי ריסט)
  socket.on("joinGame", async (payload, cb) => {
    try {
      const { gameCode, playerName, teamId, clientId } = payload || {};
      const code = (gameCode || "").toUpperCase();

      let game = games[code];
      if (!game) {
        game = await loadGameFromDb(code);
      }

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

      await touchGame(game);
      await upsertPlayerInDb(code, cid, playerName, teamKey);

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

  // עזיבת משחק
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

      await touchGame(game);
      await deletePlayerFromDb(code, clientId);

      socket.leave("game-" + code);
      broadcastGame(game);
    } catch (err) {
      console.error("leaveGame error:", err);
    }
  });

  // ----------------------
//   Socket.IO - events
// ----------------------

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // יצירת משחק חדש
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
      await saveNewGameToDb(game);

      socket.join("game-" + code);

      const safeGame = sanitizeGame(game);
      cb && cb({ ok: true, gameCode: code, game: safeGame });

      broadcastGame(game);
    } catch (err) {
      console.error("createGame error:", err);
      cb && cb({ ok: false, error: "Server error" });
    }
  });

  // הצטרפות למשחק (כולל ניסיון שחזור אחרי ריסט)
  socket.on("joinGame", async (payload, cb) => {
    try {
      const { gameCode, playerName, teamId, clientId } = payload || {};
      const code = (gameCode || "").toUpperCase();

      let game = games[code];
      if (!game) {
        game = await loadGameFromDb(code);
      }

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

      await touchGame(game);
      await upsertPlayerInDb(code, cid, playerName, teamKey);

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

  // עזיבת משחק
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

      await touchGame(game);
      await deletePlayerFromDb(code, clientId);

      socket.leave("game-" + code);
      broadcastGame(game);
    } catch (err) {
      console.error("leaveGame error:", err);
    }
  });

  // התחלת סיבוב
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
        currentWord: pickWordForGame(game),
      };

      await touchGame(game);

      const safeGame = sanitizeGame(game);

      io.to("game-" + code).emit("roundStarted", {
        gameCode: code,
        teamId,
        explainerId,
        roundSeconds: rs,
        word: game.currentRound.currentWord,
        game: safeGame,
      });

      cb && cb({ ok: true, game: safeGame });
    } catch (err) {
      console.error("startRound error:", err);
      cb && cb({ ok: false, error: "Server error" });
    }
  });

  // בקשת מילה הבאה
  socket.on("getNextWord", (payload, cb) => {
    try {
      const { gameCode } = payload || {};
      const code = (gameCode || "").toUpperCase();
      const game = games[code];
      if (!game || !game.currentRound || !game.currentRound.active) {
        return cb && cb({ ok: false, error: "אין סיבוב פעיל" });
      }
      const word = pickWordForGame(game);
      game.currentRound.currentWord = word;
      cb && cb({ ok: true, word });
    } catch (err) {
      console.error("getNextWord error:", err);
      cb && cb({ ok: false, error: "Server error" });
    }
  });

  // תשובה נכונה
  socket.on("correctGuess", async (payload, cb) => {
    try {
      const { gameCode } = payload || {};
      const code = (gameCode || "").toUpperCase();
      const game = games[code];
      if (!game || !game.currentRound || !game.currentRound.active) {
        return cb && cb({ ok: false, error: "אין סיבוב פעיל" });
      }

      const teamId = game.currentRound.teamId;
      if (game.teams[teamId]) {
        game.teams[teamId].score = (game.teams[teamId].score || 0) + 1;
      }
      game.currentRound.roundScore =
        (game.currentRound.roundScore || 0) + 1;

      await touchGame(game);
      broadcastGame(game);

      cb && cb({ ok: true, scores: getScores(game) });
    } catch (err) {
      console.error("correctGuess error:", err);
      cb && cb({ ok: false, error: "Server error" });
    }
  });

  // דילוג על מילה – בלי שינוי ניקוד
  socket.on("skipWord", (payload, cb) => {
    try {
      const { gameCode } = payload || {};
      const code = (gameCode || "").toUpperCase();
      const game = games[code];
      if (!game || !game.currentRound || !game.currentRound.active) {
        return cb && cb({ ok: false, error: "אין סיבוב פעיל" });
      }
      const word = pickWordForGame(game);
      game.currentRound.currentWord = word;
      cb && cb({ ok: true, word });
    } catch (err) {
      console.error("skipWord error:", err);
      cb && cb({ ok: false, error: "Server error" });
    }
  });

  // סיום סיבוב
  socket.on("endRound", async (payload, cb) => {
    try {
      const { gameCode } = payload || {};
      const code = (gameCode || "").toUpperCase();
      const game = games[code];
      if (!game || !game.currentRound) {
        return cb && cb({ ok: false, error: "אין סיבוב פעיל" });
      }

      game.currentRound.active = false;
      await touchGame(game);

      io.to("game-" + code).emit("roundEnded", {
        gameCode: code,
        scores: getScores(game),
        currentRound: game.currentRound,
      });

      broadcastGame(game);
      cb && cb({ ok: true });
    } catch (err) {
      console.error("endRound error:", err);
      cb && cb({ ok: false, error: "Server error" });
    }
  });

  // heartbeat מהלקוח – רק כדי לסמן פעילות
  socket.on("heartbeat", async (payload) => {
    try {
      const { gameCode } = payload || {};
      const code = (gameCode || "").toUpperCase();
      const game = games[code];
      if (!game) return;
      await touchGame(game);
    } catch (err) {
      console.error("heartbeat error:", err);
    }
  });

  // התנתקות – לא מוחקים שחקן, רק מנקים socketId כדי לאפשר reconnect
  socket.on("disconnect", () => {
    try {
      Object.values(games).forEach((game) => {
        Object.values(game.players || {}).forEach((p) => {
          if (p.socketId === socket.id) {
            p.socketId = null;
          }
        });
      });
      console.log("Client disconnected:", socket.id);
    } catch (err) {
      console.error("disconnect handler error:", err);
    }
  });
});

// ----------------------
//   ניקוי חדרים ישנים (24 שעות)
// ----------------------

function cleanupOldGames() {
  const now = Date.now();
  Object.values(games).forEach((game) => {
    const last = game.lastActivity || game.updatedAt || game.createdAt || now;
    if (now - last >= GAME_MAX_AGE_MS) {
      console.log("Auto-closing old game:", game.code);
      endGame(game, "timeout-24h");
    }
  });
}

// להריץ כל 60 שניות
setInterval(cleanupOldGames, 60 * 1000);

// ----------------------
//   הפעלת השרת
// ----------------------

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

server.listen(PORT, () => {
  console.log(`Cohens Alias server listening on port ${PORT}`);
});
