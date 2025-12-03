const speedGames = {};

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

function initSpeedGame(io) {
    io.on('connection', (socket) => {
        
        socket.on('speed:createGame', ({ hostName, teamCount, duration }) => {
            const gameCode = Math.random().toString(36).substring(2, 6).toUpperCase();
            const teams = {};
            const teamConfigs = [
                {name: 'הכחולים 🔵', color: '#3498db'}, {name: 'האדומים 🔴', color: '#e74c3c'},
                {name: 'הירוקים 🟢', color: '#2ecc71'}, {name: 'הצהובים 🟡', color: '#f1c40f'},
                {name: 'הסגולים 🟣', color: '#9b59b6'}
            ];
            
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

        socket.on('speed:join', ({ code, name, teamId }) => {
            const game = speedGames[code];
            if (!game) return socket.emit('speed:error', { message: "חדר לא נמצא" });
            if (!teamId) teamId = Object.keys(game.teams)[0];

            game.players[socket.id] = { id: socket.id, name, teamId };
            if(!game.teams[teamId].players.find(p => p.id === socket.id)) {
                game.teams[teamId].players.push({ id: socket.id, name });
            }

            socket.join(code);
            socket.join(`speed-${code}-${teamId}`);

            io.to(game.hostId).emit('speed:hostFullUpdate', { teams: game.teams, state: game.state });
            
            socket.emit('speed:joinedSuccess', { 
                teamName: game.teams[teamId].name, teamColor: game.teams[teamId].color, teamId,
                gameState: game.state, letters: game.letters, currentBoard: game.teams[teamId].currentBoard
            });
        });

        socket.on('speed:startGame', ({ code }) => {
            const game = speedGames[code];
            if (!game) return;

            game.state = 'playing';
            game.letters = generateLetters(7); 
            game.startTime = Date.now();
            
            Object.values(game.teams).forEach(t => { t.foundWords = []; t.currentBoard = [null,null,null,null,null,null,null]; });

            io.to(code).emit('speed:roundStart', { letters: game.letters, duration: game.gameDuration });
            io.to(game.hostId).emit('speed:hostFullUpdate', { teams: game.teams, state: 'playing', timeLeft: game.gameDuration });

            setTimeout(() => { endSpeedRound(io, code); }, game.gameDuration * 1000);
        });

        socket.on('speed:updateTeamBoard', ({ indices }) => {
            const { game, player } = getPlayerGame(socket.id);
            if(!game || !player) return;
            game.teams[player.teamId].currentBoard = indices;
            socket.to(`speed-${game.code}-${player.teamId}`).emit('speed:boardUpdated', { indices });
        });

        socket.on('speed:submitWord', ({ word }) => {
            const { game, player } = getPlayerGame(socket.id);
            if (!game || game.state !== 'playing') return;

            const team = game.teams[player.teamId];
            // קבלת כל מילה שלא קיימת כבר (גם אם לא במילון - לוגיקת משחק מסיבה)
            if (!team.foundWords.includes(word)) {
                team.foundWords.push(word);
                // שידור לכל הקבוצה
                io.to(`speed-${game.code}-${player.teamId}`).emit('speed:wordAccepted', { word });
                
                // איפוס הלוח
                team.currentBoard = [null,null,null,null,null,null,null];
                io.to(`speed-${game.code}-${player.teamId}`).emit('speed:boardUpdated', { indices: team.currentBoard });
                
                io.to(game.hostId).emit('speed:hostFullUpdate', { teams: game.teams });
            }
        });
        
        socket.on('speed:getHostState', ({ code }) => {
            const game = speedGames[code];
            if(game) {
                const timeLeft = game.startTime ? Math.max(0, game.gameDuration - Math.floor((Date.now() - game.startTime)/1000)) : 0;
                io.to(game.hostId).emit('speed:hostFullUpdate', { teams: game.teams, state: game.state, timeLeft });
            }
        });
    });
}

function getPlayerGame(socketId) {
    for(let code in speedGames) {
        if(speedGames[code].players[socketId]) return { game: speedGames[code], player: speedGames[code].players[socketId] };
    }
    return {};
}

function endSpeedRound(io, gameCode) {
    const game = speedGames[gameCode];
    if (!game || game.state !== 'playing') return;
    game.state = 'ended';

    const allWordsMap = {}; 
    Object.values(game.teams).forEach(team => {
        team.foundWords.forEach(word => { allWordsMap[word] = (allWordsMap[word] || 0) + 1; });
    });

    const leaderboard = [];
    Object.values(game.teams).forEach(team => {
        let uniqueCount = 0;
        team.foundWords.forEach(word => { if (allWordsMap[word] === 1) uniqueCount++; });
        team.score += uniqueCount;
        leaderboard.push({ name: team.name, score: uniqueCount, totalWords: team.foundWords.length, color: team.color });
    });

    leaderboard.sort((a, b) => b.score - a.score);
    io.to(gameCode).emit('speed:roundEnd', { leaderboard });
    io.to(game.hostId).emit('speed:hostFullUpdate', { teams: game.teams, state: 'ended' });
}

module.exports = { initSpeedGame };
