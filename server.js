// server.js - הגרסה המלאה: תמיכה במיתוג (Branding) וקבוצות דינמיות

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

const INACTIVITY_LIMIT = 24 * 60 * 60 * 1000; 
const CLEANUP_INTERVAL = 60 * 60 * 1000;      

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

    // יצירת טבלאות
    await pool.query(`CREATE TABLE IF NOT EXISTS games (code TEXT PRIMARY KEY, host_name TEXT, target_score INTEGER, default_round_seconds INTEGER, categories TEXT[], created_at TIMESTAMPTZ DEFAULT NOW());`);
    await pool.query(`CREATE TABLE IF NOT EXISTS game_teams (id SERIAL PRIMARY KEY, game_code TEXT, team_id TEXT, team_name TEXT, score INTEGER DEFAULT 0);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS game_players (id SERIAL PRIMARY KEY, game_code TEXT, client_id TEXT, name TEXT, team_id TEXT, ip_address TEXT);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS active_states (game_code TEXT PRIMARY KEY, data TEXT, last_updated TIMESTAMPTZ DEFAULT NOW());`);
    
    // עדכונים ושדרוגים לטבלאות קיימות
    try { await pool.query(`ALTER TABLE game_players ADD COLUMN IF NOT EXISTS ip_address TEXT;`); } catch (e) {}
    try { await pool.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS branding JSONB;`); } catch (e) {} // <--- עמודה חדשה למיתוג

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
        const json = JSON.stringify(game);
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

const WORD_BANK = [
  { text: "חתול", category: "animals" }, { text: "כלב", category: "animals" }, { text: "פיל", category: "animals" },
  { text: "שולחן", category: "objects" }, { text: "מחשב", category: "technology" }, { text: "טלפון", category: "technology" },
  { text: "פיצה", category: "food" }, { text: "המבורגר", category: "food" }, { text: "משפחה", category: "family" },
  { text: "חופשה", category: "travel" }, { text: "ים", category: "travel" }, { text: "כדורגל", category: "sports" },
  { text: "כדורסל", category: "sports" }, { text: "סדרה בטלוויזיה", category: "entertainment" }, { text: "סרט", category: "entertainment" },
  { text: "שיר", category: "music" }, { text: "גיטרה", category: "music" }, { text: "יער", category: "nature" },
  { text: "מדבר", category: "nature" }, { text: "חג פסח", category: "holidays" }, { text: "ראש השנה", category: "holidays" },
  { text: "מורה", category: "school" }, { text: "תלמיד", category: "school" }, { text: "בוס", category: "work" },
  { text: "משרד", category: "work" }
];

function getRandomWord(categories) {
  let pool = WORD_BANK;
  if (Array.isArray(categories) && categories.length > 0) {
    const catSet = new Set(categories);
    const filtered = WORD_BANK.filter((w) => catSet.has(w.category));
    if (filtered.length > 0) pool = filtered;
  }
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
    code: game.code, hostName: game.hostName, targetScore: game.targetScore,
    defaultRoundSeconds: game.defaultRoundSeconds, categories: game.categories || [],
    createdAt: game.createdAt, updatedAt: game.updatedAt, lastActivity: game.lastActivity,
    logoUrl: game.logoUrl || null, banners: game.banners || {},
    branding: game.branding || null, // <--- שליחת מיתוג ללקוח
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

// --- Sockets ---

io.on("connection", (socket) => {
  socket.on("createGame", async (data, callback) => {
    try {
      const { hostName, targetScore=40, defaultRoundSeconds=60, categories=[], teamNames=[], branding=null } = data || {};
      if (!hostName) return safeCb(callback, { ok: false, error: "Missing host name" });

      let code;
      do { code = generateGameCode(); } while (games[code]);

      const teams = {};
      
      // <--- יצירת קבוצות לפי רשימת שמות (במקום קבוע A,B)
      if (Array.isArray(teamNames) && teamNames.length > 0) {
          teamNames.forEach((name, idx) => {
              const id = (idx + 1).toString(); // ID: 1, 2, 3...
              if(name.trim()) teams[id] = { id, name: name.trim(), score: 0, players: [] };
          });
      }
      
      // Fallback אם לא נשלחו שמות
      if (Object.keys(teams).length < 2) {
        teams["1"] = { id: "1", name: "קבוצה 1", score: 0, players: [] };
        teams["2"] = { id: "2", name: "קבוצה 2", score: 0, players: [] };
      }

      const now = new Date();
      const game = {
        code, hostSocketId: socket.id, hostName, targetScore, defaultRoundSeconds, categories,
        createdAt: now, updatedAt: now, lastActivity: now, 
        logoUrl: null, banners: {}, branding: branding, // <--- שמירת מיתוג
        teams, playersByClientId: {}, currentRound: null,
      };

      games[code] = game;
      socket.join("game-" + code);

      if (dbReady && pool) {
        try {
          await pool.query(`INSERT INTO games (code, host_name, target_score, default_round_seconds, categories) VALUES ($1, $2, $3, $4, $5)`,
            [code, hostName, targetScore, defaultRoundSeconds, categories]);
            
          // אם יש מיתוג, נעדכן אותו בנפרד (כי לא שינינו את ה-INSERT למעלה כדי למנוע שבירת תאימות אם לא עדכנת סכמה)
          if(branding) {
               // נסיון לעדכן JSONB אם העמודה קיימת
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
         // נסיון למצוא לפי שם קבוצה (מהלינק)
         const entry = Object.entries(game.teams).find(([k,v]) => v.name === data.teamName);
         if(entry) chosenTeamId = entry[0];
      }
      if (!chosenTeamId || !game.teams[chosenTeamId]) {
         const keys = Object.keys(game.teams);
         if(keys.length) chosenTeamId = keys[0];
         else return safeCb(callback, {ok:false, error:"No teams"});
      }

      const clientId = socket.id;
      let rawIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
      if (rawIp && rawIp.includes(',')) rawIp = rawIp.split(',')[0].trim();
      const clientIp = rawIp;

      game.playersByClientId[clientId] = { clientId, name: playerName, teamId: chosenTeamId, isHost: false, ip: clientIp };
      if(!game.teams[chosenTeamId].players.includes(clientId)) {
          game.teams[chosenTeamId].players.push(clientId);
      }

      if (dbReady && pool) {
        try {
          await pool.query(`INSERT INTO game_players (game_code, client_id, name, team_id, ip_address) VALUES ($1, $2, $3, $4, $5)`,
            [code, clientId, playerName, chosenTeamId, clientIp]);
        } catch (e) {}
      }

      game.lastActivity = new Date();
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
          broadcastGame(game);
      } else {
          safeCb(cb, {ok:false, error: "Round not active"});
      }
  });

  socket.on("getNextWord", (data, cb) => {
      const game = games[data.gameCode];
      if(game && game.currentRound) {
          const w = getRandomWord(game.categories);
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
    playerCount: Object.keys(g.playersByClientId).length,
    teamCount: Object.keys(g.teams).length,
    createdAt: g.createdAt,
    players: Object.values(g.playersByClientId)
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
            query = `SELECT code, host_name, created_at FROM games WHERE created_at >= $1::date AND created_at <= ($2::date + 1) ORDER BY created_at DESC`;
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
        io.to("game-" + code).emit("gameEnded", { code });
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
