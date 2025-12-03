<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
    <title>ספיד מניה</title>
    <link href="https://fonts.googleapis.com/css2?family=Varela+Round&display=swap" rel="stylesheet">
    <script src="https://unpkg.com/@phosphor-icons/web"></script>
    <style>
        :root { --bg: #2B1E4A; --tile: #fff; --accent: #FFD700; --primary: #F84779; }
        body { margin:0; background: var(--bg); color: white; font-family: "Varela Round", sans-serif; overflow: hidden; user-select: none; display: flex; flex-direction: column; height: 100dvh; }
        
        #loginScreen, #waitScreen { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 20px; text-align: center; }
        input { width: 100%; max-width: 300px; padding: 15px; margin-bottom: 10px; border-radius: 12px; border: none; text-align: center; font-size: 1.2rem; }
        .btn { width: 100%; max-width: 300px; padding: 15px; border-radius: 50px; background: linear-gradient(135deg, var(--primary), #ff8e53); border: none; color: white; font-weight: bold; font-size: 1.2rem; cursor: pointer; }

        #gameScreen { height: 100%; display: flex; flex-direction: column; }
        .top-bar { padding: 15px; background: rgba(0,0,0,0.3); display: flex; justify-content: space-between; align-items: center; }
        .timer { background: var(--primary); padding: 5px 15px; border-radius: 20px; font-weight: bold; font-size: 1.2rem; }
        
        .words-area { flex: 1; margin: 10px; background: rgba(255,255,255,0.05); border-radius: 15px; padding: 10px; overflow-y: auto; display: flex; flex-wrap: wrap; gap: 8px; align-content: flex-start; }
        .word-tag { background: rgba(255,255,255,0.2); padding: 5px 12px; border-radius: 20px; animation: popIn 0.3s; }

        .play-area { background: rgba(0,0,0,0.3); border-radius: 25px 25px 0 0; padding: 20px 10px 30px; display: flex; flex-direction: column; gap: 20px; box-shadow: 0 -5px 20px rgba(0,0,0,0.3); }
        .slots { display: flex; gap: 5px; justify-content: center; height: 60px; }
        .slot { width: 13vw; height: 13vw; max-width: 60px; max-height: 60px; border: 2px dashed rgba(255,255,255,0.3); border-radius: 12px; display: flex; align-items: center; justify-content: center; }
        .bank { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; min-height: 70px; }
        .tile { width: 13vw; height: 13vw; max-width: 60px; max-height: 60px; background: var(--tile); color: #2B1E4A; border-radius: 12px; font-size: 1.8rem; font-weight: bold; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 0 #ccc; cursor: pointer; }
        .actions { display: flex; gap: 10px; width: 100%; max-width: 600px; margin: 0 auto; }
        .act-btn { flex: 1; padding: 15px; border-radius: 15px; border: none; font-size: 1.4rem; color: white; cursor: pointer; display: flex; align-items: center; justify-content: center; }
        .btn-clear { background: #e74c3c; flex: 0.6; }
        .btn-submit { background: #2ecc71; flex: 2; font-weight: 800; }
        .btn-submit:active { transform: scale(0.95); }

        .hidden { display: none !important; }
        @keyframes popIn { from{transform:scale(0)} to{transform:scale(1)} }
    </style>
</head>
<body>
    <div id="loginScreen">
        <h1 style="margin-bottom:20px; color:var(--accent);">ספיד מניה ⚡</h1>
        <input type="text" id="code" placeholder="קוד משחק" style="text-transform:uppercase;">
        <input type="text" id="name" placeholder="השם שלך">
        <button class="btn" onclick="join()">כנס למשחק</button>
        <p id="statusMsg" style="color:#ff6b6b; margin-top:10px;"></p>
    </div>
    <div id="waitScreen" class="hidden">
        <h2 id="waitTitle"></h2>
        <p>ממתינים למנהל...</p>
        <div style="font-size:4rem; margin-top:20px;">⏳</div>
    </div>
    <div id="gameScreen" class="hidden">
        <div class="top-bar">
            <span id="teamDisplay" style="font-weight:bold;"></span>
            <div class="timer" id="timer">60</div>
        </div>
        <div id="words" class="words-area"></div>
        <div class="play-area">
            <div class="slots" id="slots"></div>
            <div class="bank" id="bank"></div>
            <div class="actions">
                <button class="act-btn btn-clear" onclick="clearBoard()"><i class="ph-bold ph-x"></i></button>
                <button class="act-btn btn-submit" onclick="submit()">שלח <i class="ph-bold ph-paper-plane-right" style="margin-right:10px;"></i></button>
            </div>
        </div>
    </div>
    <script src="/socket.io/socket.io.js"></script>
    <script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
    <script>
        let socket, letters = [], slotsState = Array(7).fill(null), myTeamId = null;
        try { socket = io(); } catch(e) { socket = { on:()=>{}, emit:()=>{} }; }

        const urlParams = new URLSearchParams(location.search);
        if(urlParams.get('code')) document.getElementById('code').value = urlParams.get('code');
        if(urlParams.get('name')) document.getElementById('name').value = urlParams.get('name');
        if(urlParams.get('name')) setTimeout(join, 500);

        function join() {
            const code = document.getElementById('code').value.toUpperCase();
            const name = document.getElementById('name').value;
            const teamId = urlParams.get('teamId');
            if(code && name) socket.emit('speed:join', { code, name, teamId });
        }

        socket.on('speed:error', ({message}) => document.getElementById('statusMsg').innerText = message);

        socket.on('speed:joinedSuccess', ({ teamName, teamId, gameState, letters: l }) => {
            myTeamId = teamId;
            document.getElementById('loginScreen').classList.add('hidden');
            document.getElementById('waitTitle').innerText = `חבר ב${teamName}`;
            document.getElementById('teamDisplay').innerText = teamName;
            if (gameState === 'playing' && l) startRoundLogic(l, 60); 
            else document.getElementById('waitScreen').classList.remove('hidden');
        });

        socket.on('speed:roundStart', ({ letters: l, duration }) => startRoundLogic(l, duration));

        function startRoundLogic(l, duration) {
            letters = l.map((c, i) => ({ char: c, id: i }));
            slotsState.fill(null);
            render();
            document.getElementById('waitScreen').classList.add('hidden');
            document.getElementById('gameScreen').classList.remove('hidden');
            document.getElementById('words').innerHTML = '';
            
            let sec = duration;
            const t = setInterval(() => {
                sec--;
                document.getElementById('timer').innerText = sec;
                if(sec<=0) clearInterval(t);
            }, 1000);
        }

        socket.on('speed:boardUpdated', ({ indices }) => {
            slotsState = indices.map(id => id !== null ? letters.find(l => l.id === id) : null);
            render(false);
        });

        socket.on('speed:wordAccepted', ({ word }) => {
            const tag = document.createElement('div');
            tag.className = 'word-tag';
            tag.innerText = word;
            document.getElementById('words').appendChild(tag);
            slotsState.fill(null);
            render(false);
        });

        function render(emit = true) {
            const slotsEl = document.getElementById('slots');
            const bankEl = document.getElementById('bank');
            slotsEl.innerHTML = ''; bankEl.innerHTML = '';
            for(let i=0; i<7; i++) {
                const slot = document.createElement('div');
                slot.className = 'slot';
                if(slotsState[i]) {
                    const tile = createTile(slotsState[i]);
                    tile.onclick = () => { slotsState[i] = null; render(); };
                    slot.appendChild(tile);
                }
                slotsEl.appendChild(slot);
            }
            letters.forEach(l => {
                if(!slotsState.includes(l)) {
                    const tile = createTile(l);
                    tile.onclick = () => {
                        const idx = slotsState.indexOf(null);
                        if(idx !== -1) { slotsState[idx] = l; render(); }
                    };
                    bankEl.appendChild(tile);
                }
            });
            if(emit && myTeamId) {
                const indices = slotsState.map(o => o ? o.id : null);
                socket.emit('speed:updateTeamBoard', { indices });
            }
        }

        function createTile(l) {
            const d = document.createElement('div');
            d.className = 'tile';
            d.innerText = l.char;
            return d;
        }

        function clearBoard() { slotsState.fill(null); render(); }
        
        function submit() {
            const word = slotsState.filter(x => x).map(x => x.char).join('');
            if(word.length >= 2) socket.emit('speed:submitWord', { word });
        }
    </script>
</body>
</html>
