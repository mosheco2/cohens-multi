const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// מגישים את קבצי ה-HTML / JS / CSS מתוך public
app.use(express.static(path.join(__dirname, "public")));

// מצב המשחקים בזיכרון (לא בבסיס נתונים)
const games = {};

// מאגרי מילים לפי חבילות
const wordPacks = {
  family: [
    "כלב","חתול","אמא","אבא","אח","אחות","גן","בית ספר","מחברת","עיפרון",
    "כדור","נדנדה","גלידה","עוגה","פיצה","מים","חולצה","מכנסיים","נעליים",
    "חדר","מיטה","שמיכה","צעצוע","בובה","בלון","סוכריה","קניון","סבא",
    "סבתא","ים","בריכה","מעלית","מדרגות","חנות צעצועים","טלוויזיה","מסעדה",
    "חג","מתנה","יום הולדת"
  ],
  classic: [
    "מטוס","מחשב","טלפון","עיתון","מגדל","חשמל","ספרייה","תאטרון","רופא",
    "נהג מונית","אינטרנט","מקרר","חלון","חברה","משפחה","מכונית","תחנת דלק",
    "גשר","משטרה","חייל","אוטובוס","רמזור","כביש","פקק תנועה","משרד","שכן",
    "גינה ציבורית","קפה","כיסא","שולחן","חניה","קופה רושמת","מרפאה","ספר",
    "חנות נעליים","חנות בגדים","שלט חוצות","תחנת אוטובוס"
  ],
  hard: [
    "דמוקרטיה","חופש","אחריות","לחץ","השראה","יצירתיות","חברות","סבלנות",
    "שאפתנות","בדידות","פחד","אומץ","אמון","תסכול","ויתור","ניצחון","תחרות",
    "אסטרטגיה","דמיון","עתיד","עבר","הווה","משבר","הצלחה","כישלון","שגרה",
    "הפתעה","זיכרון","חלום","ציפיות"
  ]
};

// מחזיר רשימת מילים לפי חבילה (או הכל)
function getWordList(packKey) {
  if (packKey && wordPacks[packKey]) {
    return wordPacks[packKey].slice();
  }
  // "all" או לא הוגדר -> מחברים את הכל
  const set = new Set();
  Object.values(wordPacks).forEach(list => {
    list.forEach(w => set.add(w));
  });
  return Array.from(set);
}

// מייצר קוד משחק קצר, למשל AB4F
function generateGameCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// בוחר מילה רנדומלית שלא חזרה על עצמה יותר מדי
function pickRandomWord(game) {
  if (!game.wordList || game.wordList.length === 0) {
    game.wordList = getWordList(game.wordPack);
    game.usedIndices = new Set();
  }

  if (game.usedIndices.size >= game.wordList.length) {
    // התחלה מחודשת של רשימת המילים
    game.usedIndices = new Set();
  }

  let idx;
  let tries = 0;
  do {
    idx = Math.floor(Math.random() * game.wordList.length);
    tries++;
    if (tries > 200) break;
  } while (game.usedIndices.has(idx));

  game.usedIndices.add(idx);
  return game.wordList[idx];
}

// מה אנחנו מחזירים לפרונט (בלי כל הפרטים הפנימיים)
function getPublicGameSummary(game) {
  return {
    code: game.code,
    targetScore: game.targetScore,
    wordPack: game.wordPack,
    teams: game.teams,
    players: Object.values(game.players).map(p => ({
      id: p.id,
      name: p.name,
      teamId: p.teamId,
      isHost: !!p.isHost
    })),
    state: game.state
  };
}

io.on("connection", socket => {
  console.log("לקוח התחבר:", socket.id);

  // יצירת משחק (על ידי המנהל)
  socket.on("createGame", (data, cb) => {
    let code;
    do {
      code = generateGameCode();
    } while (games[code]);

    const teamAName = data.teamAName || "קבוצה A";
    const teamBName = data.teamBName || "קבוצה B";
    const targetScore = Number(data.targetScore) || 30;
    const wordPack = data.wordPack || "classic";

    const game = {
      code,
      hostId: socket.id,
      wordPack,
      targetScore,
      teams: {
        A: { id: "A", name: teamAName, score: 0 },
        B: { id: "B", name: teamBName, score: 0 }
      },
      players: {},
      state: {
        phase: "lobby", // lobby | playing
        currentTeamId: null,
        explainerId: null,
        currentWord: null
      },
      wordList: getWordList(wordPack),
      usedIndices: new Set()
    };

    game.players[socket.id] = {
      id: socket.id,
      name: data.hostName || "מנהל",
      teamId: "A",
      isHost: true
    };

    games[code] = game;
    socket.join(code);

    const summary = getPublicGameSummary(game);
    cb && cb({ ok: true, gameCode: code, game: summary });
    io.to(code).emit("gameUpdated", summary);

    console.log("נוצר משחק חדש:", code);
  });

  // שחקן מצטרף למשחק
  socket.on("joinGame", (data, cb) => {
    const code = (data.gameCode || "").toUpperCase().trim();
    const name = (data.playerName || "").trim();
    const teamId = data.teamId === "B" ? "B" : "A";

    const game = games[code];
    if (!game) {
      cb && cb({ ok: false, error: "המשחק לא נמצא" });
      return;
    }
    if (!name) {
      cb && cb({ ok: false, error: "חייבים שם שחקן" });
      return;
    }

    game.players[socket.id] = {
      id: socket.id,
      name,
      teamId,
      isHost: false
    };

    socket.join(code);

    const summary = getPublicGameSummary(game);
    cb && cb({ ok: true, gameCode: code, game: summary });
    io.to(code).emit("gameUpdated", summary);

    console.log(`שחקן ${name} הצטרף למשחק ${code}`);
  });

  // התחלת סיבוב (רק המנהל)
  socket.on("startRound", data => {
    const code = (data.gameCode || "").toUpperCase().trim();
    const game = games[code];
    if (!game) return;
    if (socket.id !== game.hostId) return;

    const teamId = data.teamId === "B" ? "B" : "A";
    let explainerId = data.explainerId;
    const roundTime = Number(data.roundTime) || 60;

    // אם לא נבחר מסביר ספציפי – נבחר אוטומטית שחקן מהקבוצה (מעדיפים לא-מנהל)
    if (!explainerId || !game.players[explainerId] || game.players[explainerId].teamId !== teamId) {
      const allCandidates = Object.values(game.players).filter(p => p.teamId === teamId);
      const nonHostCandidates = allCandidates.filter(p => !p.isHost);

      const chosenList = nonHostCandidates.length ? nonHostCandidates : allCandidates;
      if (chosenList.length === 0) {
        console.log("אין שחקנים בקבוצה", teamId, "למשחק", code);
        return;
      }
      explainerId = chosenList[0].id;
    }

    game.state.phase = "playing";
    game.state.currentTeamId = teamId;
    game.state.explainerId = explainerId;
    game.state.currentWord = pickRandomWord(game);

    const payload = {
      teamId,
      explainerId,
      roundTime,
      scores: {
        A: game.teams.A.score,
        B: game.teams.B.score
      },
      targetScore: game.targetScore
    };

    io.to(code).emit("roundStarted", payload);
    io.to(explainerId).emit("wordForExplainer", {
      word: game.state.currentWord
    });

    console.log(`סיבוב התחיל במשחק ${code}, קבוצה ${teamId}, מסביר ${explainerId}`);
  });

  // המסביר לוחץ "נכון"
  socket.on("markCorrect", data => {
    const code = (data.gameCode || "").toUpperCase().trim();
    const game = games[code];
    if (!game) return;
    if (game.state.phase !== "playing") return;
    if (socket.id !== game.state.explainerId) return;

    const teamId = game.state.currentTeamId;
    if (!teamId) return;

    game.teams[teamId].score += 1;
    game.state.currentWord = pickRandomWord(game);

    io.to(code).emit("scoreUpdated", {
      scores: {
        A: game.teams.A.score,
        B: game.teams.B.score
      },
      targetScore: game.targetScore
    });

    io.to(game.state.explainerId).emit("wordForExplainer", {
      word: game.state.currentWord
    });
  });

  // המסביר לוחץ "דילוג"
  socket.on("skipWord", data => {
    const code = (data.gameCode || "").toUpperCase().trim();
    const game = games[code];
    if (!game) return;
    if (game.state.phase !== "playing") return;
    if (socket.id !== game.state.explainerId) return;

    game.state.currentWord = pickRandomWord(game);
    io.to(game.state.explainerId).emit("wordForExplainer", {
      word: game.state.currentWord
    });
  });

  // סיום סיבוב (רק המנהל)
  socket.on("endRound", data => {
    const code = (data.gameCode || "").toUpperCase().trim();
    const game = games[code];
    if (!game) return;
    if (socket.id !== game.hostId) return;

    const teamId = game.state.currentTeamId;

    game.state.phase = "lobby";
    game.state.currentTeamId = null;
    game.state.explainerId = null;
    game.state.currentWord = null;

    io.to(code).emit("roundEnded", {
      scores: {
        A: game.teams.A.score,
        B: game.teams.B.score
      },
      teamId
    });
  });

  // ניתוק שחקן
  socket.on("disconnect", () => {
    console.log("לקוח התנתק:", socket.id);
    for (const code of Object.keys(games)) {
      const game = games[code];
      if (!game.players[socket.id]) continue;

      const wasHost = socket.id === game.hostId;
      delete game.players[socket.id];

      // אם אין שחקנים – מוחקים את המשחק
      if (Object.keys(game.players).length === 0) {
        delete games[code];
        console.log("משחק נמחק כי אין שחקנים:", code);
        continue;
      }

      // אם המנהל התנתק – מעבירים מנהל למישהו אחר
      if (wasHost) {
        const firstPlayerId = Object.keys(game.players)[0];
        game.hostId = firstPlayerId;
        game.players[firstPlayerId].isHost = true;
      }

      const summary = getPublicGameSummary(game);
      io.to(code).emit("gameUpdated", summary);
    }
  });
});

server.listen(PORT, () => {
  console.log("שרת כהנ'ס רץ על פורט", PORT);
  console.log("פתח דפדפן על http://localhost:" + PORT + "/");
});
