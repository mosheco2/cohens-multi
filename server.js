const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;
const ADMIN_CODE = "ONEBTN"; // קוד לכניסה לממשק הניהול
const BANNERS_FILE = path.join(__dirname, 'banners.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- ניהול מצב (State) ---
// משחקים פעילים בזמן אמת
const games = {}; 
// היסטוריית משחקים (נשמרת בזיכרון כל עוד השרת רץ)
const allGamesHistory = [];

// --- קטגוריות מילים (ניתן להרחיב) ---
const wordCategories = {
    food: ["פיצה", "פלאפל", "סושי", "המבורגר", "גלידה", "שוקולד", "פסטה", "סלט", "תפוח", "בננה"],
    animals: ["כלב", "חתול", "אריה", "פיל", "ג'ירפה", "קוף", "זברה", "דוב", "ציפור", "דג"],
    objects: ["כיסא", "שולחן", "מחשב", "טלפון", "מכונית", "ספר", "עט", "כוס", "בקבוק", "תיק"],
    sports: ["כדורגל", "כדורסל", "טניס", "שחייה", "ריצה", "אופניים", "כדורעף", "ג'ודו", "התעמלות", "טיפוס"],
    professions: ["רופא", "מורה", "שוטר", "כבאים", "טבח", "נהג", "טייס", "זמר", "שחקן", "צייר"],
    technology: ["אינטרנט", "וואטסאפ", "אינסטגרם", "טיקטוק", "מקלדת", "עכבר", "מסך", "סוללה", "מטען", "אוזניות"],
    nature: ["עץ", "פרח", "ים", "שמש", "ירח", "כוכב", "ענן", "גשם", "רוח", "אש"],
    home: ["מטבח", "סלון", "חדר שינה", "אמבטיה", "מרפסת", "גינה", "גג", "חלון", "דלת", "מדרגות"],
    clothing: ["חולצה", "מכנסיים", "שמלה", "חצאית", "נעליים", "גרביים", "כובע", "מעיל", "צעיף", "כפפות"],
    emotions: ["שמחה", "עצב", "כעס", "פחד", "הפתעה", "אהבה", "שנאה", "קנאה", "געגוע", "תקווה"],
    transport: ["אוטובוס", "רכבת", "מטוס", "אונייה", "מונית", "אופנוע", "קורקינט", "משאית", "טרקטור", "רכבל"],
    instruments: ["גיטרה", "פסנתר", "תוף", "כינור", "חליל", "חצוצרה", "סקסופון", "מפוחית", "אקורדיון", "דרבוקה"],
    countries: ["ישראל", "ארה״ב", "צרפת", "איטליה", "ספרד", "יוון", "תאילנד", "יפן", "סין", "ברזיל"],
    colors: ["אדום", "כחול", "צהוב", "ירוק", "כתום", "סגול", "ורוד", "שחור", "לבן", "אפור"],
    verbs: ["לרוץ", "לקפוץ", "לשיר", "לרקוד", "לצחוק", "לבכות", "לאכול", "לשתות", "לישון", "לחשוב"]
};

// --- פונקציות עזר ---
function generateGameCode() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function getWords(categories, customWords) {
    let words = [];
    if (customWords && customWords.trim().length > 0) {
        words = words.concat(customWords.split(',').map(w => w.trim()));
    }
    if (categories.includes('all')) {
        Object.values(wordCategories).forEach(arr => words = words.concat(arr));
    } else {
        categories.forEach(cat => {
            if (wordCategories[cat]) words = words.concat(wordCategories[cat]);
        });
    }
    // ערבוב המילים
    return words.sort(() => Math.random() - 0.5);
}

function getClientIp(req) {
    return req.headers['x-forwarded-for'] || req.socket.remoteAddress;
}

// --- API Routes ---

// קבלת באנרים
app.get("/api/banners", (req, res) => {
    if (fs.existsSync(BANNERS_FILE)) {
        res.json(JSON.parse(fs.readFileSync(BANNERS_FILE)));
    } else {
        res.json({});
    }
});

// שמירת באנרים (כולל תמיכה במובייל בצורה גנרית)
app.post("/api/banners", (req, res) => {
    try {
        fs.writeFileSync(BANNERS_FILE, JSON.stringify(req.body, null, 2));
        res.json({ ok: true });
    } catch (e) {
        console.error("Error saving banners:", e);
        res.status(500).json({ error: "Failed to save banners" });
    }
});

// יצירת משחק (דרך טופס POST רגיל)
app.post('/create-game', (req, res) => {
    // דף זה מיועד רק אם המשתמש מגיע מדפדפן ללא JS, בפועל היצירה נעשית דרך Socket
    res.redirect('/');
});


// =========================================
//  Admin API Routes (החלק המעודכן)
// =========================================

// סטטיסטיקות זמן אמת
app.get("/admin/stats", (req, res) => {
    if (req.query.code !== ADMIN_CODE) return res.status(403).json({ error: "Unauthorized" });

    const activeGamesList = Object.values(games).map(g => ({
        code: g.code,
        hostName: g.hostName,
        hostIp: g.hostIp,
        createdAt: g.createdAt,
        playerCount: Object.keys(g.playersByClientId).length,
        teamCount: Object.keys(g.teams).length,
        isActive: true,
        gameTitle: g.gameTitle,
        teams: g.teams // שליחת פירוט קבוצות ושחקנים לזמן אמת
    }));

    const uniqueIps = new Set();
    Object.values(games).forEach(g => {
        if(g.hostIp) uniqueIps.add(g.hostIp);
        Object.values(g.playersByClientId).forEach(p => {
            if(p.ip) uniqueIps.add(p.ip);
        });
    });

    res.json({
        stats: {
            activeGamesCount: activeGamesList.length,
            connectedSockets: io.engine.clientsCount,
            uniqueIps: uniqueIps.size
        },
        activeGames: activeGamesList
    });
});


// *** ה-ENDPOINT המעודכן להיסטוריה עם סינון חכם ***
app.get("/admin/history", (req, res) => {
    const { code, startDate, endDate, search, scope } = req.query;

    if (code !== ADMIN_CODE) {
        return res.status(403).json({ error: "Unauthorized" });
    }

    let filteredGames = [...allGamesHistory];

    // 1. סינון לפי תאריכים (חובה)
    if (startDate && endDate) {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);

        filteredGames = filteredGames.filter(g => {
            const gameDate = new Date(g.createdAt);
            return gameDate >= start && gameDate <= end;
        });
    }

    // 2. סינון לפי חיפוש ותחום (אופציונלי, רק אם נשלח search)
    if (search) {
        const searchTerm = search.toLowerCase().trim();
        
        filteredGames = filteredGames.filter(g => {
            let matches = false;

            // --- בדיקה: תחום חדרים ---
            if (scope === 'rooms' || scope === 'all') {
                if (g.code.toLowerCase().includes(searchTerm)) matches = true;
                if (g.gameTitle && g.gameTitle.toLowerCase().includes(searchTerm)) matches = true;
            }

            // --- בדיקה: תחום משתמשים ו-IP ---
            if (!matches && (scope === 'users' || scope === 'all')) {
                // בדיקת מנהל
                if (g.hostName.toLowerCase().includes(searchTerm)) matches = true;
                if (g.hostIp && g.hostIp.includes(searchTerm)) matches = true;

                // בדיקת שחקנים עמוקה (בתוך כל הקבוצות)
                if (!matches && g.teams) {
                    // עוברים על כל הקבוצות
                    Object.values(g.teams).some(team => {
                        // עוברים על כל השחקנים בקבוצה
                        return team.players.some(playerData => {
                            // playerData כאן הוא האובייקט המלא שנשמר בהיסטוריה
                            if (playerData.name && playerData.name.toLowerCase().includes(searchTerm)) {
                                matches = true; return true;
                            }
                            if (playerData.ip && playerData.ip.includes(searchTerm)) {
                                matches = true; return true;
                            }
                            return false;
                        });
                    });
                }
            }
            
            return matches;
        });
    }

    res.json({ games: filteredGames });
});

// =========================================
//  Socket.IO Logic
// =========================================

io.on('connection', (socket) => {
    const clientIp = getClientIp(socket.request);
    console.log(`New client connected: ${socket.id} from ${clientIp}`);

    socket.on('createGame', (data, callback) => {
        const gameCode = generateGameCode();
        const words = getWords(data.categories, data.customWords);
        
        const teams = {};
        Object.entries(data.teamNames).forEach(([key, name]) => {
            if (name) teams[key] = { id: key, name: name, score: 0, players: [] };
        });

        games[gameCode] = {
            code: gameCode,
            hostId: socket.id,
            hostName: data.hostName,
            hostIp: clientIp,
            gameTitle: data.gameTitle,
            createdAt: new Date().toISOString(),
            teams: teams,
            playersByClientId: {}, // מיפוי מהיר של socketId לנתוני שחקן
            words: words,
            wordsPointer: 0,
            branding: data.branding,
            settings: {
                targetScore: parseInt(data.targetScore) || 50,
                roundSeconds: parseInt(data.roundSeconds) || 60
            },
            currentRound: { isActive: false }
        };

        socket.join(gameCode);
        console.log(`Game created: ${gameCode} by ${data.hostName}`);
        callback({ ok: true, gameCode: gameCode, game: games[gameCode] });
    });

    socket.on('joinGame', (data, callback) => {
        const { gameCode, name, teamId } = data;
        const game = games[gameCode];
        if (!game) return callback({ ok: false, error: "משחק לא נמצא" });
        if (!game.teams[teamId]) return callback({ ok: false, error: "קבוצה לא קיימת" });

        // שמירת נתוני השחקן
        game.playersByClientId[socket.id] = { 
            id: socket.id, 
            name: name, 
            teamId: teamId, 
            ip: clientIp 
        };
        // הוספת ה-ID לרשימת השחקנים בקבוצה
        game.teams[teamId].players.push(socket.id);
        
        socket.join(gameCode);
        console.log(`Player ${name} joined game ${gameCode} team ${teamId}`);
        io.to(gameCode).emit('gameUpdated', game);
        callback({ ok: true, game: game, clientId: socket.id, teamId: teamId });
    });

    socket.on('getGameState', (data) => {
        const game = games[data.gameCode];
        if(game) socket.emit('gameUpdated', game);
    });

    socket.on('removePlayer', (data) => {
        const { gameCode, clientId } = data;
        const game = games[gameCode];
        if(game && game.hostId === socket.id) {
            const player = game.playersByClientId[clientId];
            if(player) {
                // הסרה מהקבוצה
                const team = game.teams[player.teamId];
                if(team) {
                    team.players = team.players.filter(pid => pid !== clientId);
                }
                // הסרה מהמיפוי הכללי
                delete game.playersByClientId[clientId];
                
                io.to(clientId).emit('playerRemoved');
                io.in(gameCode).socketsLeave(clientId); // ניתוק כפוי מהחדר
                io.to(gameCode).emit('gameUpdated', game);
            }
        }
    });

    socket.on('startRound', (data, callback) => {
        const { gameCode, teamId, explainerClientId } = data;
        const game = games[gameCode];
        if (!game || game.hostId !== socket.id) return callback({ ok: false, error: "לא מורשה" });
        if (game.currentRound.isActive) return callback({ ok: false, error: "סיבוב כבר פעיל" });

        let actualExplainerId = explainerClientId;
        // בחירה אוטומטית של מסביר אם לא נבחר
        if(!actualExplainerId) {
            const teamPlayers = game.teams[teamId].players;
            if(teamPlayers.length === 0) return callback({ok:false, error: "אין שחקנים בקבוצה זו"});
            actualExplainerId = teamPlayers[Math.floor(Math.random() * teamPlayers.length)];
        }

        game.currentRound = {
            isActive: true,
            teamId: teamId,
            explainerId: actualExplainerId,
            explainerName: game.playersByClientId[actualExplainerId].name,
            roundScore: 0,
            startTime: Date.now(),
            timer: null
        };

        let secondsLeft = game.settings.roundSeconds;
        
        // טיימר בצד שרת
        game.currentRound.timer = setInterval(() => {
            secondsLeft--;
            io.to(gameCode).emit('roundTick', { gameCode, secondsLeft });
            if (secondsLeft <= 0) {
                endRoundInternal(gameCode);
            }
        }, 1000);

        io.to(gameCode).emit('roundStarted', { game: game });
        callback({ ok: true });
    });

    socket.on('getNextWord', (data, callback) => {
        const game = games[data.gameCode];
        if(!game || !game.currentRound.isActive || game.currentRound.explainerId !== socket.id) {
            return callback({ ok: false, error: "לא מורשה" });
        }
        if(game.wordsPointer >= game.words.length) game.wordsPointer = 0; // מחזור מילים
        const word = game.words[game.wordsPointer++];
        callback({ ok: true, word: word });
    });

    socket.on('changeRoundScore', (data, callback) => {
        const game = games[data.gameCode];
        if(!game || !game.currentRound.isActive || game.currentRound.explainerId !== socket.id) return;
        
        game.currentRound.roundScore += data.delta;
        io.to(data.gameCode).emit('roundScoreUpdated', { gameCode: data.gameCode, roundScore: game.currentRound.roundScore });
        if(callback) callback();
    });

    socket.on('endRound', (data) => {
        const game = games[data.gameCode];
        if (game && game.hostId === socket.id) {
            endRoundInternal(data.gameCode);
        }
    });

    function endRoundInternal(gameCode) {
        const game = games[gameCode];
        if (!game || !game.currentRound.isActive) return;

        clearInterval(game.currentRound.timer);
        
        const team = game.teams[game.currentRound.teamId];
        team.score += game.currentRound.roundScore;
        
        const roundSummary = {
            teamName: team.name,
            roundScore: game.currentRound.roundScore,
            totalScore: team.score
        };

        game.currentRound = { isActive: false };
        io.to(gameCode).emit('roundTimeUp', roundSummary);
        io.to(gameCode).emit('gameUpdated', game);

        if (team.score >= game.settings.targetScore) {
            io.to(gameCode).emit('gameOver', { winningTeam: team.name });
        }
    }

    socket.on('endGame', (data) => {
        const game = games[data.gameCode];
        if (game && game.hostId === socket.id) {
            closeGameInternal(data.gameCode, false);
        }
    });

    socket.on('hostReconnect', (data, callback) => {
        const game = games[data.gameCode];
        if(game) {
             // עדכון Socket ID של המנהל אם השתנה
             if(game.hostId !== socket.id) {
                 console.log(`Host reconnected to ${data.gameCode}, updating socket ID.`);
                 game.hostId = socket.id;
             }
             socket.join(data.gameCode);
             callback({ ok: true, game });
        } else {
            callback({ ok: false });
        }
    });

    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
        // אופציונלי: טיפול בהתנתקות שחקן באמצע משחק
    });
});

// פונקציה פנימית לסגירת משחק (גם ע"י מנהל וגם ע"י אדמין)
function closeGameInternal(gameCode, isAdminAction) {
    const game = games[gameCode];
    if (!game) return;

    if (game.currentRound.timer) clearInterval(game.currentRound.timer);
    
    // שמירה להיסטוריה
    const historyEntry = {
        ...game,
        endedAt: new Date().toISOString(),
        totalPlayers: Object.keys(game.playersByClientId).length,
        totalTeams: Object.keys(game.teams).length,
        // המרת מבנה השחקנים לשמירה שטוחה יותר בהיסטוריה (לצורך חיפוש קל)
        teams: Object.values(game.teams).map(t => ({
            ...t,
            players: t.players.map(pid => game.playersByClientId[pid])
        }))
    };
    delete historyEntry.playersByClientId; // לא נחוץ בהיסטוריה
    delete historyEntry.currentRound;
    delete historyEntry.words;
    
    allGamesHistory.push(historyEntry);

    io.to(gameCode).emit(isAdminAction ? 'adminClosedGame' : 'gameEnded');
    io.in(gameCode).socketsLeave(gameCode);
    delete games[gameCode];
    console.log(`Game ${gameCode} ended and moved to history.`);
}


server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
