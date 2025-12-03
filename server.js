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

// ==========================================
//       L O G I C :  S P E E D   M A N I A
// ==========================================

const speedGames = {};

// מאגר אותיות משופר (תדירות עברית)
const LETTERS_POOL = [
    ...'אאאאאאאבבבגגגדההההההויוווווזחחטייייייכללללממממננננסעעפפצקררררשתתת'.split('')
];

function generateLetters(count = 7) {
    let result = [];
    for(let i=0; i<count; i++) {
        const rand = Math.floor(Math.random() * LETTERS_POOL.length);
        result.push(LETTERS_POOL[rand]);
    }
    return result;
}

function getPlayerGame(socketId) {
    for(let code in speedGames) {
        if(speedGames[code].players[socketId]) {
            return { game: speedGames[code], player: speedGames[code].players[socketId] };
        }
    }
    return {};
}

function sendHostUpdate(io, game) {
    if(!game) return;
    const timeLeft = game.startTime ? Math.max(0, game.gameDuration - Math.floor((Date.now() - game.startTime)/1000)) : 0;
    
    io.to(game.hostId).emit('speed:hostFullUpdate', { 
        teams: game.teams,
        state: game.state,
        timeLeft
    });
}

function endSpeedRound(io, gameCode) {
    const game = speedGames[gameCode];
    if (!game || game.state !== 'playing') return;

    game.state = 'ended';

    // חישוב ניקוד (ייחודיות)
    const allWordsMap = {}; 
    Object.values(game.teams).forEach(team => {
        team.foundWords.forEach(word => {
            allWordsMap[word] = (allWordsMap[word] || 0) + 1;
        });
    });

    const leaderboard = [];
    Object.values(game.teams).forEach(team => {
        let uniqueCount = 0;
        team.foundWords.forEach(word => {
            if (allWordsMap[word] === 1) uniqueCount++;
        });
        team.score += uniqueCount;
        leaderboard.push({ name: team.name, score: uniqueCount, totalWords: team.foundWords.length, color: team.color });
    });

    leaderboard.sort((a, b) => b.score - a.score);
    io.to(gameCode).emit('speed:roundEnd', { leaderboard });
    sendHostUpdate(io, game);
}

function initSpeedGame(io) {
    console.log("⚡ Speed Mania Logic Initialized");

    io.on('connection', (socket) => {
        // יצירת משחק
        socket.on('speed:createGame', ({ hostName, teamCount, duration }) => {
            const gameCode = Math.random().toString(36).substring(2, 6).toUpperCase();
            const teamConfigs = [
                {name: 'הכחולים 🔵', color: '#3498db'}, {name: 'האדומים 🔴', color: '#e74c3c'},
                {name: 'הירוקים 🟢', color: '#2ecc71'}, {name: 'הצהובים 🟡', color: '#f1c40f'},
                {name: 'הסגולים 🟣', color: '#9b59b6'}
            ];
            
            const teams = {};
            for(let i=0; i< (teamCount || 2); i++) {
                const tid = "T" + (i+1);
                teams[tid] = { id: tid, ...teamConfigs[i], score: 0, players: [], currentBoard: [null,null,null,null,null,null,null], foundWords: [] };
            }

            speedGames[gameCode] = {
                hostId: socket.id, hostName, players: {}, teams,
                state: 'lobby', letters: [], gameDuration: duration || 60, startTime: null
            };

            socket.join(gameCode);
            socket.emit('speed:gameCreated', { gameCode, teams });
        });

        // הצטרפות
        socket.on('speed:join', ({ code, name, teamId }) => {
            const game = speedGames[code];
            if (!game) return socket.emit('speed:error', { message: "חדר לא נמצא" });
            if (!teamId) teamId = Object.keys(game.teams)[0];

            game.players[socket.id] = { id: socket.id, name, teamId };
            if(!game.teams[teamId].players.find(p => p.id === socket.id)) {
                game.teams[teamId].players.push({ id: socket.id, name });
            }

            socket.join(code);
            socket.join(`speed-${code}-${teamId}`); // חדר קבוצה

            sendHostUpdate(io, game);

            socket.emit('speed:joinedSuccess', { 
                teamName: game.teams[teamId].name, teamColor: game.teams[teamId].color, teamId,
                gameState: game.state, letters: game.letters, currentBoard: game.teams[teamId].currentBoard
            });
        });

        // התחלת סיבוב
        socket.on('speed:startGame', ({ code }) => {
            const game = speedGames[code];
            if (!game) return;

            game.state = 'playing';
            game.letters = generateLetters(7); 
            game.startTime = Date.now();
            
            Object.values(game.teams).forEach(t => { t.foundWords = []; t.currentBoard = [null,null,null,null,null,null,null]; });

            io.to(code).emit('speed:roundStart', { letters: game.letters, duration: game.gameDuration });
            sendHostUpdate(io, game);

            setTimeout(() => { endSpeedRound(io, code); }, game.gameDuration * 1000);
        });

        // עדכון לוח
        socket.on('speed:updateTeamBoard', ({ indices }) => {
            const { game, player } = getPlayerGame(socket.id);
            if(!game || !player) return;
            game.teams[player.teamId].currentBoard = indices;
            socket.to(`speed-${game.code}-${player.teamId}`).emit('speed:boardUpdated', { indices });
        });

        // הגשת מילה
        socket.on('speed:submitWord', ({ word }) => {
            const { game, player } = getPlayerGame(socket.id);
            if (!game || game.state !== 'playing') return;

            const team = game.teams[player.teamId];
            if (!team.foundWords.includes(word)) {
                team.foundWords.push(word);
                io.to(`speed-${game.code}-${player.teamId}`).emit('speed:wordAccepted', { word });
                
                team.currentBoard = [null,null,null,null,null,null,null];
                io.to(`speed-${game.code}-${player.teamId}`).emit('speed:boardUpdated', { indices: team.currentBoard });

                sendHostUpdate(io, game);
            }
        });

        socket.on('speed:getHostState', ({ code }) => {
            const game = speedGames[code];
            if(game) sendHostUpdate(io, game);
        });
    });
}

// ==========================================
//       M A I N   S E R V E R   L O G I C
// ==========================================

initSpeedGame(io);

const PORT = process.env.PORT || 3000;
const ADMIN_CODE = process.env.ADMIN_CODE || "ONEBTN";

// --- Setup ---
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// --- Database ---
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
    await pool.query(`CREATE TABLE IF NOT EXISTS game_teams (id SERIAL PRIMARY KEY, game_code TEXT, team_id TEXT, team_name TEXT, score INTEGER DEFAULT 0);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS game_players (id SERIAL PRIMARY KEY, game_code TEXT, client_id TEXT, name TEXT, team_id TEXT, ip_address TEXT, created_at TIMESTAMPTZ DEFAULT NOW());`);
    await pool.query(`CREATE TABLE IF NOT EXISTS active_states (game_code TEXT PRIMARY KEY, data TEXT, last_updated TIMESTAMPTZ DEFAULT NOW());`);
    await pool.query(`CREATE TABLE IF NOT EXISTS site_settings (id SERIAL PRIMARY KEY, top_banner_img TEXT, top_banner_link TEXT, bottom_banner_img TEXT, bottom_banner_link TEXT, top_banner_img_mobile TEXT, bottom_banner_img_mobile TEXT);`);
    await pool.query(`INSERT INTO site_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;`);

    dbReady = true;
    console.log("✅ Postgres ready.");
  } catch (err) {
    console.error("❌ DB Error:", err.message);
  }
}
initDb();

// --- API ---
app.get("/api/banners", async (req, res) => {
    let banners = {};
    if (dbReady && pool) {
        try {
            const result = await pool.query("SELECT * FROM site_settings WHERE id = 1");
            if (result.rows.length > 0) {
                const row = result.rows[0];
                banners.topBanner = { img: row.top_banner_img, imgMobile: row.top_banner_img_mobile, link: row.top_banner_link };
                banners.bottomBanner = { img: row.bottom_banner_img, imgMobile: row.bottom_banner_img_mobile, link: row.bottom_banner_link };
            }
        } catch (e) {}
    }
    res.json(banners);
});

app.get("/admin/history", async (req, res) => {
    if (req.query.code !== ADMIN_CODE) return res.status(403).json({ error: "Unauthorized" });
    if (!dbReady) return res.status(503).json({ error: "DB not ready" });
    try {
        const result = await pool.query(`SELECT * FROM games ORDER BY created_at DESC LIMIT 50`);
        res.json({ results: result.rows, summary: { count: result.rowCount } });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
