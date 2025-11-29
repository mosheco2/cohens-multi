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
const ADMIN_CODE = process.env.ADMIN_CODE || "ONEBTN";

const INACTIVITY_LIMIT = 24 * 60 * 60 * 1000; // 24 שעות
const CLEANUP_INTERVAL = 60 * 60 * 1000;      // בדיקה כל שעה

// --- Webhook Email ---
async function sendNewGameEmail(gameInfo) {
  const webhookUrl = process.env.EMAIL_WEBHOOK;
  if (!webhookUrl) return; 

  fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
          code: gameInfo.code,
          host: gameInfo.hostName
      })
  }).catch(err => console.error("Webhook error:", err.message));
}

// --- Setup ---
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

let pool = null;
let dbReady = false;

async function initDb() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.log("⚠️ No DATABASE_URL. Persistence disabled.");
    return;
  }
  try {
    pool = new Pool({
      connectionString,
      ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
    });

    await pool.query(`CREATE TABLE IF NOT EXISTS games (code TEXT PRIMARY KEY, host_name TEXT, target_score INTEGER, default_round_seconds INTEGER, categories TEXT[], created_at TIMESTAMPTZ DEFAULT NOW());`);
    try { await pool.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS host_ip TEXT;`); } catch (e) {}
    try { await pool.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS branding JSONB;`); } catch (e) {}
    try { await pool.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS game_title TEXT;`); } catch (e) {}

    await pool.query(`CREATE TABLE IF NOT EXISTS game_teams (id SERIAL PRIMARY KEY, game_code TEXT, team_id TEXT, team_name TEXT, score INTEGER DEFAULT 0);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS game_players (id SERIAL PRIMARY KEY, game_code TEXT, client_id TEXT, name TEXT, team_id TEXT, ip_address TEXT, joined_at TIMESTAMPTZ DEFAULT NOW());`);
    try { await pool.query(`ALTER TABLE game_players ADD COLUMN IF NOT EXISTS ip_address TEXT;`); } catch (e) {}
    try { await pool.query(`ALTER TABLE game_players ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ DEFAULT NOW();`); } catch (e) {}

    await pool.query(`CREATE TABLE IF NOT EXISTS active_states (game_code TEXT PRIMARY KEY, data TEXT, last_updated TIMESTAMPTZ DEFAULT NOW());`);
    
    dbReady = true;
    console.log("✅ Postgres ready.");
    await restoreActiveGames();
  } catch (err) {
    console.error("❌ DB Error:", err.message);
  }
}
initDb();

// --- State ---
const games = {};
const roundTimers = {};

const safeCb = (cb, data) => { if (typeof cb === 'function') cb(data); };

async function saveGameState(game) {
    if (!dbReady || !game) return;
    try {
        const gameToSave = JSON.parse(JSON.stringify(game));
        gameToSave.customWordsList = []; 

        const json = JSON.stringify(gameToSave);
        await pool.query(
            `INSERT INTO active_states (game_code, data, last_updated) VALUES ($1, $2, NOW()) 
             ON CONFLICT (game_code) DO UPDATE SET data = $2, last_updated = NOW()`,
            [game.code, json]
        );
    } catch (e) { console.error("Save State Error:", e.message); }
}

async function deleteGameState(gameCode) {
    if (!dbReady) return;
    try {
        await pool.query(`DELETE FROM active_states WHERE game_code = $1`, [gameCode]);
    } catch (e) { console.error("Delete State Error:", e.message); }
}

async function restoreActiveGames() {
    if (!dbReady) return;
    console.log("♻️ Restoring games...");
    try {
        const res = await pool.query("SELECT * FROM active_states");
        res.rows.forEach(row => {
            try {
                const game = JSON.parse(row.data);
                games[game.code] = game;
                if (game.currentRound && game.currentRound.active) {
                    const now = Date.now();
                    const lastUpdate = new Date(row.last_updated).getTime();
                    const secondsPassed = Math.floor((now - lastUpdate) / 1000);
                    game.currentRound.secondsLeft -= secondsPassed;
                    if (game.currentRound.secondsLeft > 0) {
                        startTimerInterval(game.code);
                    } else {
                        finishRound(game.code, { reason: "timer" });
                    }
                }
            } catch (e) { console.error("Failed to parse game", row.game_code); }
        });
    } catch (e) { console.error("Restore Error:", e.message); }
}

// מאגר מילים מורחב - 15 קטגוריות, ~20 מילים כל אחת
const WORD_BANK = [
    // אוכל (Food)
    {t:"פיצה",c:"food"},{t:"המבורגר",c:"food"},{t:"סושי",c:"food"},{t:"פלאפל",c:"food"},{t:"שווארמה",c:"food"},{t:"גלידה",c:"food"},{t:"שוקולד",c:"food"},{t:"פסטה",c:"food"},{t:"סלט",c:"food"},{t:"מרק",c:"food"},{t:"לחם",c:"food"},{t:"גבינה",c:"food"},{t:"עוגה",c:"food"},{t:"תפוח",c:"food"},{t:"בננה",c:"food"},{t:"אבטיח",c:"food"},{t:"קפה",c:"food"},{t:"תה",c:"food"},{t:"קולה",c:"food"},{t:"צ'יפס",c:"food"},
    // חיות (Animals)
    {t:"כלב",c:"animals"},{t:"חתול",c:"animals"},{t:"פיל",c:"animals"},{t:"אריה",c:"animals"},{t:"נמר",c:"animals"},{t:"ג'ירפה",c:"animals"},{t:"קוף",c:"animals"},{t:"דוב",c:"animals"},{t:"סוס",c:"animals"},{t:"פרה",c:"animals"},{t:"כבשה",c:"animals"},{t:"תרנגולת",c:"animals"},{t:"ציפור",c:"animals"},{t:"דג",c:"animals"},{t:"כריש",c:"animals"},{t:"לוויתן",c:"animals"},{t:"נחש",c:"animals"},{t:"צפרדע",c:"animals"},{t:"פרפר",c:"animals"},{t:"ארנב",c:"animals"},
    // חפצים בבית (Objects)
    {t:"שולחן",c:"objects"},{t:"כיסא",c:"objects"},{t:"מיטה",c:"objects"},{t:"ארון",c:"objects"},{t:"ספה",c:"objects"},{t:"טלוויזיה",c:"objects"},{t:"מחשב",c:"objects"},{t:"טלפון",c:"objects"},{t:"מקרר",c:"objects"},{t:"תנור",c:"objects"},{t:"מיקרוגל",c:"objects"},{t:"מכונת כביסה",c:"objects"},{t:"מזגן",c:"objects"},{t:"מנורה",c:"objects"},{t:"שטיח",c:"objects"},{t:"וילון",c:"objects"},{t:"ספר",c:"objects"},{t:"עט",c:"objects"},{t:"מחברת",c:"objects"},{t:"תיק",c:"objects"},
    // ספורט (Sports)
    {t:"כדורגל",c:"sports"},{t:"כדורסל",c:"sports"},{t:"טניס",c:"sports"},{t:"שחייה",c:"sports"},{t:"ריצה",c:"sports"},{t:"אופניים",c:"sports"},{t:"כדורעף",c:"sports"},{t:"כדוריד",c:"sports"},{t:"ג'ודו",c:"sports"},{t:"קראטה",c:"sports"},{t:"התעמלות",c:"sports"},{t:"יוגה",c:"sports"},{t:"פילאטיס",c:"sports"},{t:"גלישה",c:"sports"},{t:"סקי",c:"sports"},{t:"איגרוף",c:"sports"},{t:"שחמט",c:"sports"},{t:"פינג פונג",c:"sports"},{t:"באולינג",c:"sports"},{t:"חדר כושר",c:"sports"},
    // מקומות בארץ (Places IL)
    {t:"ירושלים",c:"places_il"},{t:"תל אביב",c:"places_il"},{t:"חיפה",c:"places_il"},{t:"אילת",c:"places_il"},{t:"באר שבע",c:"places_il"},{t:"הכנרת",c:"places_il"},{t:"ים המלח",c:"places_il"},{t:"החרמון",c:"places_il"},{t:"הכותל",c:"places_il"},{t:"מצדה",c:"places_il"},{t:"נמל יפו",c:"places_il"},{t:"שוק מחנה יהודה",c:"places_il"},{t:"פארק הירקון",c:"places_il"},{t:"הגולן",c:"places_il"},{t:"הגליל",c:"places_il"},{t:"הנגב",c:"places_il"},{t:"נתב״ג",c:"places_il"},{t:"עזריאלי",c:"places_il"},{t:"הכנסת",c:"places_il"},{t:"הסחנה",c:"places_il"},
    // מותגים (Brands)
    {t:"קוקה קולה",c:"brands"},{t:"אפל",c:"brands"},{t:"סמסונג",c:"brands"},{t:"נייקי",c:"brands"},{t:"אדידס",c:"brands"},{t:"מקדונלדס",c:"brands"},{t:"גוגל",c:"brands"},{t:"פייסבוק",c:"brands"},{t:"אינסטגרם",c:"brands"},{t:"טיקטוק",c:"brands"},{t:"נטפליקס",c:"brands"},{t:"דיסני",c:"brands"},{t:"טויוטה",c:"brands"},{t:"מרצדס",c:"brands"},{t:"איקאה",c:"brands"},{t:"ספוטיפיי",c:"brands"},{t:"זארה",c:"brands"},{t:"קסטרו",c:"brands"},{t:"תנובה",c:"brands"},{t:"אסם",c:"brands"},
    // צבא וביטחון (Army)
    {t:"חייל",c:"army"},{t:"מפקד",c:"army"},{t:"מדים",c:"army"},{t:"נשק",c:"army"},{t:"קסדה",c:"army"},{t:"אפוד",c:"army"},{t:"טנק",c:"army"},{t:"מטוס קרב",c:"army"},{t:"מסוק",c:"army"},{t:"צוללת",c:"army"},{t:"בסיס",c:"army"},{t:"טירונות",c:"army"},{t:"מילואים",c:"army"},{t:"רמטכ״ל",c:"army"},{t:"כיפת ברזל",c:"army"},{t:"אזעקה",c:"army"},{t:"ממ״ד",c:"army"},{t:"צו 8",c:"army"},{t:"דרגה",c:"army"},{t:"פק״ל",c:"army"},
    // קיבוץ ומושב (Kibbutz)
    {t:"רפת",c:"kibbutz"},{t:"לול",c:"kibbutz"},{t:"שדה",c:"kibbutz"},{t:"טרקטור",c:"kibbutz"},{t:"חדר אוכל",c:"kibbutz"},{t:"מכבסה",c:"kibbutz"},{t:"בריכה",c:"kibbutz"},{t:"פרדס",c:"kibbutz"},{t:"מטע",c:"kibbutz"},{t:"חציר",c:"kibbutz"},{t:"חליבה",c:"kibbutz"},{t:"בימבה",c:"kibbutz"},{t:"כלבו",c:"kibbutz"},{t:"מזכירות",c:"kibbutz"},{t:"נעורים",c:"kibbutz"},{t:"שומר",c:"kibbutz"},{t:"שער",c:"kibbutz"},{t:"אסיפת חברים",c:"kibbutz"},{t:"תורנות",c:"kibbutz"},{t:"חג משק",c:"kibbutz"},
    // הייטק (Hi-Tech)
    {t:"סטארטאפ",c:"hitech"},{t:"אקזיט",c:"hitech"},{t:"מתכנת",c:"hitech"},{t:"באג",c:"hitech"},{t:"קוד",c:"hitech"},{t:"אלגוריתם",c:"hitech"},{t:"אפליקציה",c:"hitech"},{t:"אתר אינטרנט",c:"hitech"},{t:"שרת",c:"hitech"},{t:"ענן",c:"hitech"},{t:"סייבר",c:"hitech"},{t:"בינה מלאכותית",c:"hitech"},{t:"רובוט",c:"hitech"},{t:"רחפן",c:"hitech"},{t:"האקתון",c:"hitech"},{t:"משקיע",c:"hitech"},{t:"קרן הון סיכון",c:"hitech"},{t:"מנכ״ל",c:"hitech"},{t:"סמנכ״ל",c:"hitech"},{t:"הפי האוור",c:"hitech"},
    // בית ספר (School)
    {t:"מורה",c:"school"},{t:"תלמיד",c:"school"},{t:"כיתה",c:"school"},{t:"לוח",c:"school"},{t:"גיר",c:"school"},{t:"מחק",c:"school"},{t:"עיפרון",c:"school"},{t:"מחברת",c:"school"},{t:"ספר לימוד",c:"school"},{t:"תיק אוכל",c:"school"},{t:"הפסקה",c:"school"},{t:"צלצול",c:"school"},{t:"מבחן",c:"school"},{t:"שיעורי בית",c:"school"},{t:"תעודה",c:"school"},{t:"טיול שנתי",c:"school"},{t:"מנהל",c:"school"},{t:"יועצת",c:"school"},{t:"ספרייה",c:"school"},{t:"אולם ספורט",c:"school"},
    // טבע וסביבה (Nature)
    {t:"עץ",c:"nature"},{t:"פרח",c:"nature"},{t:"דשא",c:"nature"},{t:"הר",c:"nature"},{t:"גבעה",c:"nature"},{t:"עמק",c:"nature"},{t:"נהר",c:"nature"},{t:"נחל",c:"nature"},{t:"ים",c:"nature"},{t:"חוף",c:"nature"},{t:"מדבר",c:"nature"},{t:"יער",c:"nature"},{t:"שמש",c:"nature"},{t:"ירח",c:"nature"},{t:"כוכב",c:"nature"},{t:"ענן",c:"nature"},{t:"גשם",c:"nature"},{t:"רוח",c:"nature"},{t:"אש",c:"nature"},{t:"אדמה",c:"nature"},
    // תרבות ובידור (Culture)
    {t:"סרט",c:"culture"},{t:"הצגה",c:"culture"},{t:"מופע",c:"culture"},{t:"קונצרט",c:"culture"},{t:"מוזיאון",c:"culture"},{t:"תערוכה",c:"culture"},{t:"גלריה",c:"culture"},{t:"קולנוע",c:"culture"},{t:"תיאטרון",c:"culture"},{t:"ספר",c:"culture"},{t:"שיר",c:"culture"},{t:"ריקוד",c:"culture"},{t:"ציור",c:"culture"},{t:"פסל",c:"culture"},{t:"צילום",c:"culture"},{t:"פסטיבל",c:"culture"},{t:"קרקס",c:"culture"},{t:"סטנדאפ",c:"culture"},{t:"סדרה",c:"culture"},{t:"חדשות",c:"culture"},
    // חגים ומועדים (Holidays)
    {t:"ראש השנה",c:"holidays"},{t:"יום כיפור",c:"holidays"},{t:"סוכות",c:"holidays"},{t:"שמחת תורה",c:"holidays"},{t:"חנוכה",c:"holidays"},{t:"טו בשבט",c:"holidays"},{t:"פורים",c:"holidays"},{t:"פסח",c:"holidays"},{t:"יום העצמאות",c:"holidays"},{t:"שבועות",c:"holidays"},{t:"שבת",c:"holidays"},{t:"סופגניה",c:"holidays"},{t:"מצה",c:"holidays"},{t:"לולב",c:"holidays"},{t:"אתרוג",c:"holidays"},{t:"סביבון",c:"holidays"},{t:"רעשן",c:"holidays"},{t:"תחפושת",c:"holidays"},{t:"זיקוקים",c:"holidays"},{t:"מנגל",c:"holidays"},
    // משפחה (Family)
    {t:"אמא",c:"family"},{t:"אבא",c:"family"},{t:"אח",c:"family"},{t:"אחות",c:"family"},{t:"סבא",c:"family"},{t:"סבתא",c:"family"},{t:"דוד",c:"family"},{t:"דודה",c:"family"},{t:"בן דוד",c:"family"},{t:"תינוק",c:"family"},{t:"ילד",c:"family"},{t:"הורים",c:"family"},{t:"נכד",c:"family"},{t:"אחיין",c:"family"},{t:"גיס",c:"family"},{t:"חמות",c:"family"},{t:"כלה",c:"family"},{t:"חתן",c:"family"},{t:"תאומים",c:"family"},{t:"משפחה",c:"family"},
    // כלי תחבורה (Transport)
    {t:"מכונית",c:"transport"},{t:"אוטובוס",c:"transport"},{t:"משאית",c:"transport"},{t:"אופנוע",c:"transport"},{t:"אופניים",c:"transport"},{t:"קורקינט",c:"transport"},{t:"רכבת",c:"transport"},{t:"מטוס",c:"transport"},{t:"מסוק",c:"transport"},{t:"אונייה",c:"transport"},{t:"סירה",c:"transport"},{t:"מונית",c:"transport"},{t:"ניידת משטרה",c:"transport"},{t:"אמבולנס",c:"transport"},{t:"כבאית",c:"transport"},{t:"טרקטורון",c:"transport"},{t:"רכבל",c:"transport"},{t:"מעלית",c:"transport"},{t:"דרגנוע",c:"transport"},{t:"גלגיליות",c:"transport"}
];

function getRandomWord(game) {
  let pool = [];
  if (game.customWordsList && game.customWordsList.length > 0) {
      pool = game.customWordsList.map(word => ({ text: word, category: 'מותאם אישית' }));
  }

  const categories = game.categories || [];
  if (Array.isArray(categories) && categories.length > 0 && !categories.includes('all')) {
    const catSet = new Set(categories);
    const filtered = WORD_BANK.filter((w) => catSet.has(w.c));
    pool = pool.concat(filtered.map(w => ({text: w.t, category: w.c})));
  } else {
    pool = pool.concat(WORD_BANK.map(w => ({text: w.t, category: w.c})));
  }

  if (pool.length === 0) return { text: "אין מילים", category: "כללי" };
  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx];
}

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
    code: game.code, hostName: game.hostName,
    gameTitle: game.gameTitle || null,
    targetScore: game.targetScore,
    defaultRoundSeconds: game.defaultRoundSeconds, categories: game.categories || [],
    createdAt: game.createdAt, updatedAt: game.updatedAt, lastActivity: game.lastActivity,
    logoUrl: game.logoUrl || null, banners: game.banners || {},
    branding: game.branding || null,
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

function startTimerInterval(code) {
    clearRoundTimer(code);
    roundTimers[code] = setInterval(() => {
        const g = games[code];
        if (!g || !g.currentRound || !g.currentRound.active) { clearRoundTimer(code); return; }
        
        g.currentRound.secondsLeft--;
        
        if (g.currentRound.secondsLeft <= 0) {
            g.currentRound.secondsLeft = 0;
            finishRound(code, { reason: "timer" });
        } else {
            io.to("game-" + code).emit("roundTick", { gameCode: code, secondsLeft: g.currentRound.secondsLeft });
        }
    }, 1000);
}

setInterval(() => {
    const now = Date.now();
    Object.keys(games).forEach(code => {
        const game = games[code];
        if (now - new Date(game.lastActivity).getTime() > INACTIVITY_LIMIT) {
            clearRoundTimer(code);
            delete games[code];
            deleteGameState(code);
        }
    });
}, CLEANUP_INTERVAL);

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
  
  saveGameState(game);
  broadcastGame(game);

  io.to("game-" + code).emit("roundFinished", { teamId, roundScore, totalScore, reason: options.reason || "manual" });

  if (options.reason === "timer") {
    const teamName = teamId && game.teams[teamId] ? game.teams[teamId].name : `קבוצה ${teamId || ""}`;
    io.to("game-" + code).emit("roundTimeUp", { code, roundScore, teamId, teamName, totalScore: totalScore || 0 });
  }
  game.currentRound = null;
}

io.on("connection", (socket) => {
  socket.on("createGame", async (data, callback) => {
    try {
      const { hostName, gameTitle="", targetScore=40, defaultRoundSeconds=60, categories=[], teamNames={}, branding=null, customWords="" } = data || {};
      if (!hostName) return safeCb(callback, { ok: false, error: "Missing host name" });

      let clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
      if (clientIp && clientIp.includes(',')) clientIp = clientIp.split(',')[0].trim();

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

      let customWordsList = [];
      if (customWords && typeof customWords === 'string') {
          customWordsList = customWords.split(',').map(w => w.trim()).filter(w => w.length > 0);
      }

      const game = {
        code, hostSocketId: socket.id, hostName,
        gameTitle: gameTitle.trim(),
        targetScore, defaultRoundSeconds, categories,
        createdAt: now, updatedAt: now, lastActivity: now, 
        logoUrl: null, banners: {}, branding, 
        teams, playersByClientId: {}, currentRound: null,
        customWordsList
      };

      games[code] = game;
      socket.join("game-" + code);

      if (dbReady && pool) {
        try {
          await pool.query(`INSERT INTO games (code, host_name, target_score, default_round_seconds, categories, host_ip, game_title) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [code, hostName, targetScore, defaultRoundSeconds, categories, clientIp, game.gameTitle]);
          
          if(branding) {
             try { await pool.query(`UPDATE games SET branding = $1 WHERE code = $2`, [JSON.stringify(branding), code]); } catch(e){}
          }

          for (const t of Object.values(teams)) {
            await pool.query(`INSERT INTO game_teams (game_code, team_id, team_name, score) VALUES ($1, $2, $3, $4)`,
              [code, t.id, t.name, 0]);
          }
        } catch (e) { console.error("DB Create Error:", e); }
      }

      saveGameState(game);
      sendNewGameEmail(game);
      safeCb(callback, { ok: true, gameCode: code, game: sanitizeGame(game) });

    } catch (err) {
      console.error("CreateGame Error:", err);
      safeCb(callback, { ok: false, error: "Server Error" });
    }
  });

  socket.on("joinGame", async (data, callback) => {
    try {
      const { gameCode, name, teamId } = data || {};
      const code = (gameCode || "").toUpperCase().trim();
      let game = games[code];

      if (!game) return safeCb(callback, { ok: false, error: "המשחק לא נמצא." });

      const playerName = (name || "").trim();
      if (!playerName) return safeCb(callback, { ok: false, error: "שם חסר." });

      let chosenTeamId = teamId;
      if (!chosenTeamId && data.teamName) {
         const entry = Object.entries(game.teams).find(([k,v]) => v.name === data.teamName);
         if(entry) chosenTeamId = entry[0];
      }
      if (!chosenTeamId || !game.teams[chosenTeamId]) {
         const keys = Object.keys(game.teams);
         if(keys.length) chosenTeamId = keys[0];
         else return safeCb(callback, {ok:false, error:"No teams"});
      }

      const clientId = socket.id;
      let clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
      if (clientIp && clientIp.includes(',')) clientIp = clientIp.split(',')[0].trim();

      const now = new Date();
      game.playersByClientId[clientId] = { clientId, name: playerName, teamId: chosenTeamId, isHost: false, ip: clientIp, joinedAt: now };
      if(!game.teams[chosenTeamId].players.includes(clientId)) {
          game.teams[chosenTeamId].players.push(clientId);
      }

      if (dbReady && pool) {
        try {
          await pool.query(`INSERT INTO game_players (game_code, client_id, name, team_id, ip_address, joined_at) VALUES ($1, $2, $3, $4, $5, $6)`,
            [code, clientId, playerName, chosenTeamId, clientIp, now]);
        } catch (e) {}
      }

      game.lastActivity = now;
      saveGameState(game);

      socket.join("game-" + code);
      safeCb(callback, { ok: true, game: sanitizeGame(game), clientId, teamId: chosenTeamId, teamName: game.teams[chosenTeamId].name, isHost: false });
      broadcastGame(game);

    } catch (err) {
      console.error("JoinGame Error:", err);
      safeCb(callback, { ok: false, error: "Join Error" });
    }
  });

  socket.on("hostReconnect", (data, callback) => {
      const code = (data?.gameCode || "").toUpperCase().trim();
      const game = games[code];
      
      if(!game) return safeCb(callback, {ok:false, error:"Not found"});
      
      if(game.hostName) game.hostSocketId = socket.id;
      socket.join("game-" + code);
      safeCb(callback, { ok: true, game: sanitizeGame(game) });
  });

  socket.on("getGameState", (data, callback) => {
      const code = (data?.gameCode || "").toUpperCase().trim();
      if(games[code]) safeCb(callback, { ok: true, game: sanitizeGame(games[code]) });
      else safeCb(callback, { ok: false });
  });

  socket.on("startRound", async (data, callback) => {
      const game = games[data.gameCode];
      if(!game) return safeCb(callback, {ok:false, error: "Game not found"});
      
      clearRoundTimer(data.gameCode);
      const team = game.teams[data.teamId];
      if(!team) return safeCb(callback, {ok:false, error: "Invalid team"});

      let explainer = null;
      const pIds = team.players;
      if(data.explainerClientId && pIds.includes(data.explainerClientId)) explainer = data.explainerClientId;
      if(!explainer && pIds.length > 0) explainer = pIds[Math.floor(Math.random() * pIds.length)];
      
      if(!explainer) return safeCb(callback, {ok:false, error: "אין שחקנים בקבוצה זו! אי אפשר להתחיל."});

      const pObj = game.playersByClientId[explainer];
      const now = new Date();
      
      game.currentRound = {
          teamId: data.teamId,
          explainerId: explainer,
          explainerName: pObj ? pObj.name : "Unknown",
          secondsLeft: parseInt(data.roundSeconds) || 60,
          active: true, isActive: true, roundScore: 0, startedAt: now.toISOString()
      };
      
      game.lastActivity = now;
      saveGameState(game);

      broadcastGame(game);
      io.to("game-" + game.code).emit("roundStarted", { game: sanitizeGame(game) });

      startTimerInterval(game.code);
      safeCb(callback, {ok:true});
  });

  socket.on("changeRoundScore", (data, cb) => {
      const game = games[data.gameCode];
      if(game && game.currentRound && game.currentRound.active) {
          const d = parseInt(data.delta) || 0;
          game.currentRound.roundScore = Math.max(0, (game.currentRound.roundScore || 0) + d);
          game.lastActivity = new Date();
          saveGameState(game);
          
          safeCb(cb, {ok:true});
          
          io.to("game-" + game.code).emit("roundScoreUpdated", {
              gameCode: game.code,
              roundScore: game.currentRound.roundScore,
              teamId: game.currentRound.teamId
          });
          
      } else {
          safeCb(cb, {ok:false, error: "Round not active"});
      }
  });

  socket.on("getNextWord", (data, cb) => {
      const game = games[data.gameCode];
      if(game && game.currentRound) {
          const w = getRandomWord(game);
          safeCb(cb, {ok:true, word: w.text, category: w.category});
      }
  });

  socket.on("endRound", (data, cb) => {
      finishRound(data.gameCode, {reason:"manual"});
      safeCb(cb, {ok:true});
  });

  socket.on("endGame", (data, cb) => {
      const code = data.gameCode;
      if(games[code]) {
          clearRoundTimer(code);
          delete games[code];
          deleteGameState(code);
          io.to("game-" + code).emit("gameEnded", { code });
          safeCb(cb, {ok:true});
      }
  });

  socket.on("removePlayer", (data, cb) => {
      const game = games[data.gameCode];
      if(!game) return safeCb(cb, {ok:false});
      
      const pid = data.clientId;
      const p = game.playersByClientId[pid];
      if(p) {
          delete game.playersByClientId[pid];
          if(game.teams[p.teamId]) {
              game.teams[p.teamId].players = game.teams[p.teamId].players.filter(id=>id!==pid);
          }
          saveGameState(game);
          
          io.to(pid).emit("playerRemoved");

          if(game.currentRound && game.currentRound.explainerId === pid) {
              finishRound(game.code, {reason:"player_disconnected"});
          } else {
              broadcastGame(game);
          }
      }
      safeCb(cb, {ok:true});
  });

  socket.on("disconnect", () => {
      const pid = socket.id;
      Object.values(games).forEach(g => {
          if(g.hostSocketId === pid) return; 
          if(g.playersByClientId[pid]) {
              const p = g.playersByClientId[pid];
              delete g.playersByClientId[pid];
              if(g.teams[p.teamId]) {
                  g.teams[p.teamId].players = g.teams[p.teamId].players.filter(id=>id!==pid);
              }
              
              saveGameState(g);

              if(g.currentRound && g.currentRound.explainerId === pid) {
                  finishRound(g.code, {reason:"player_disconnected"});
              } else {
                  broadcastGame(g);
              }
          }
      });
  });
});

// API
app.get("/admin/stats", async (req, res) => {
  const code = req.query.code || "";
  if (code !== ADMIN_CODE) return res.status(403).json({ error: "Forbidden" });

  let dbStats = { gamesByDay: [], totalUniqueIps: 0 };

  if (dbReady && pool) {
    try {
      const gamesRes = await pool.query(`SELECT TO_CHAR(created_at, 'DD/MM') as date, COUNT(*) as count FROM games WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY date, TO_CHAR(created_at, 'YYYY-MM-DD') ORDER BY TO_CHAR(created_at, 'YYYY-MM-DD') ASC`);
      dbStats.gamesByDay = gamesRes.rows;

      const ipRes = await pool.query(`SELECT COUNT(DISTINCT ip_address) as count FROM game_players`);
      dbStats.totalUniqueIps = ipRes.rows[0].count;
    } catch (e) { console.error("Stats DB Error", e); }
  }

  const activeGames = Object.values(games).map(g => ({
    code: g.code,
    hostName: g.hostName,
    gameTitle: g.gameTitle,
    playerCount: Object.keys(g.playersByClientId).length,
    teamCount: Object.keys(g.teams).length,
    createdAt: g.createdAt,
    players: Object.values(g.playersByClientId).map(p => ({ name: p.name, ip: p.ip, joinedAt: p.joinedAt }))
  }));

  res.json({ activeGames, dbStats });
});

app.get("/admin/reports", async (req, res) => {
    const { code, type, from, to } = req.query;
    if (code !== ADMIN_CODE) return res.status(403).json({ error: "Forbidden" });
    if (!dbReady) return res.json({ error: "No DB connection" });

    try {
        let query = "", params = [from || '2020-01-01', to || '2030-01-01'];
        if (type === 'ips') {
            query = `SELECT ip_address, MAX(name) as last_name, COUNT(*) as games_count, MAX(created_at) as last_seen FROM game_players WHERE created_at >= $1::date AND created_at <= ($2::date + 1) GROUP BY ip_address ORDER BY last_seen DESC`;
        } else if (type === 'games') {
            query = `SELECT code, host_name, game_title, host_ip, created_at FROM games WHERE created_at >= $1::date AND created_at <= ($2::date + 1) ORDER BY created_at DESC`;
        }
        const result = await pool.query(query, params);
        res.json({ data: result.rows });
    } catch (e) { res.status(500).json({ error: "DB Error" }); }
});

app.post("/admin/reset", async (req, res) => {
    if (req.query.code !== ADMIN_CODE) return res.status(403).json({ ok: false });
    if (dbReady && pool) {
        await pool.query("TRUNCATE TABLE game_players, game_teams, games, active_states RESTART IDENTITY");
        res.json({ ok: true });
    } else res.json({ ok: false });
});

app.post("/admin/game/:gameCode/close", (req, res) => {
    if (req.query.code !== ADMIN_CODE) return res.status(403).send();
    const code = req.params.gameCode;
    if(games[code]) {
        clearRoundTimer(code); delete games[code]; deleteGameState(code);
        // שינוי: אירוע ספציפי לסגירת מנהל
        io.to("game-" + code).emit("adminClosedGame", { code });
        res.json({ok:true});
    } else res.status(404).send();
});

app.post("/admin/game/:gameCode/player/:clientId/disconnect", (req, res) => {
    if (req.query.code !== ADMIN_CODE) return res.status(403).send();
    const {gameCode, clientId} = req.params;
    const g = games[gameCode];
    if(g && g.playersByClientId[clientId]) {
        const p = g.playersByClientId[clientId];
        delete g.playersByClientId[clientId];
        if(g.teams[p.teamId]) g.teams[p.teamId].players = g.teams[p.teamId].players.filter(id=>id!==clientId);
        saveGameState(g); broadcastGame(g); res.json({ok:true});
    } else res.status(404).send();
});

app.get("/api/banners", (req, res) => res.json({}));

server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
