<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
    <title>מילמניה - שער הכניסה</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Varela+Round&display=swap" rel="stylesheet">
    <script src="https://unpkg.com/@phosphor-icons/web"></script>

    <style>
        :root {
            --primary: #F84779;
            --secondary: #15C4C1;
            --dark: #2B1E4A;
            --light: #FFF8EA;
            --card-bg: rgba(255, 255, 255, 0.1);
            --card-hover: rgba(255, 255, 255, 0.2);
        }

        * { box-sizing: border-box; font-family: "Varela Round", sans-serif; -webkit-tap-highlight-color: transparent; }

        body {
            margin: 0; padding: 0; min-height: 100vh;
            background: radial-gradient(circle at top left, rgba(248, 71, 121, 0.4), transparent 60%), radial-gradient(circle at bottom right, rgba(21, 196, 193, 0.4), transparent 60%), #1b1233;
            color: white; display: flex; flex-direction: column; align-items: center; overflow-x: hidden;
        }

        .container { width: 100%; max-width: 1100px; padding: 20px; text-align: center; flex: 1; display: flex; flex-direction: column; align-items: center; }

        .logo-area { margin-bottom: 20px; animation: fadeInDown 0.8s ease-out; position: relative; margin-top: 20px; }
        .mascot-img { width: 160px; height: auto; max-width: 50vw; filter: drop-shadow(0 10px 20px rgba(0,0,0,0.3)); animation: float 3s ease-in-out infinite; margin-bottom: 5px; }
        .logo-title { font-size: 3rem; margin: 0; background: linear-gradient(45deg, #FF9A9E 0%, #FECFEF 99%, #FECFEF 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; text-shadow: 0 4px 15px rgba(0,0,0,0.3); letter-spacing: -2px; line-height: 1; }
        .tagline { font-size: 1.1rem; opacity: 0.9; margin-top: 5px; color: #ddd; }

        .main-actions { display: flex; gap: 20px; justify-content: center; flex-wrap: wrap; margin-bottom: 40px; width: 100%; animation: fadeInUp 0.8s ease-out 0.2s backwards; }
        .action-btn { padding: 16px 28px; border-radius: 50px; font-size: 1.2rem; border: none; cursor: pointer; transition: transform 0.2s, box-shadow 0.2s; display: flex; align-items: center; gap: 12px; text-decoration: none; color: white; font-weight: bold; width: 100%; max-width: 280px; justify-content: center; }
        .btn-join { background: linear-gradient(135deg, var(--secondary), #0e8a88); box-shadow: 0 4px 15px rgba(21, 196, 193, 0.4); }
        .btn-host { background: linear-gradient(135deg, var(--primary), #c21d4b); box-shadow: 0 4px 15px rgba(248, 71, 121, 0.4); }
        .action-btn:hover { transform: translateY(-3px); filter: brightness(1.1); }

        #gamesGrid { display: none; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 20px; margin-top: 20px; width: 100%; padding-bottom: 100px; animation: fadeInUp 0.5s ease-out; }
        .section-header { width: 100%; display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }

        .game-card { background: var(--card-bg); border: 1px solid rgba(255,255,255,0.1); border-radius: 20px; padding: 20px; text-align: right; cursor: pointer; transition: all 0.3s ease; position: relative; overflow: hidden; display: flex; flex-direction: column; min-height: 220px; }
        .game-card:hover { background: var(--card-hover); transform: translateY(-5px); border-color: rgba(255,255,255,0.3); box-shadow: 0 10px 30px rgba(0,0,0,0.2); }
        .game-card.existing-game { border: 2px solid #FFD700; background: linear-gradient(145deg, rgba(255, 215, 0, 0.1), rgba(0,0,0,0.2)); }
        
        .featured-tag { position: absolute; top: 15px; left: 15px; background: #FFD700; color: #2B1E4A; font-size: 0.75rem; font-weight: 800; padding: 4px 8px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.2); }
        .new-tag { position: absolute; top: 15px; left: 15px; background: var(--secondary); color: #2B1E4A; font-size: 0.75rem; font-weight: 800; padding: 4px 8px; border-radius: 12px; }

        .card-icon { font-size: 2.5rem; margin-bottom: 10px; display: inline-block; }
        .card-title { font-size: 1.3rem; margin: 0 0 8px 0; color: #fff; font-weight: 800; }
        .card-desc { font-size: 0.9rem; color: #ccc; line-height: 1.4; flex-grow: 1; }
        .card-meta { margin-top: 12px; display: flex; gap: 8px; font-size: 0.8rem; color: #fff; opacity: 0.8; font-weight: bold; }

        .join-form { display: none; background: white; padding: 30px; border-radius: 24px; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 90%; max-width: 400px; color: var(--dark); box-shadow: 0 20px 50px rgba(0,0,0,0.5); z-index: 100; text-align: center; animation: zoomIn 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
        .overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); backdrop-filter: blur(5px); z-index: 90; }
        .join-input { width: 100%; padding: 15px; font-size: 1.5rem; text-align: center; border: 2px solid #eee; border-radius: 12px; margin: 20px 0; text-transform: uppercase; letter-spacing: 5px; font-family: monospace; font-weight: bold; }

        @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
        @keyframes fadeInDown { from { opacity: 0; transform: translateY(-20px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes fadeInUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes zoomIn { from { opacity: 0; transform: translate(-50%, -50%) scale(0.9); } to { opacity: 1; transform: translate(-50%, -50%) scale(1); } }
        @media (max-width: 640px) { .logo-title { font-size: 2.5rem; } .action-btn { width: 100%; max-width: 100%; } .main-actions { flex-direction: column; align-items: center; } .mascot-img { width: 140px; } #gamesGrid { grid-template-columns: 1fr; } }
    </style>
</head>
<body>

    <div class="container">
        <div class="logo-area">
            <img src="m2.png" alt="מפלצת מילמניה" class="mascot-img" onerror="this.src='https://cdn-icons-png.flaticon.com/512/3069/3069172.png'">
            <h1 class="logo-title">מילמניה</h1>
            <p class="tagline">זירת משחקי המילים החברתית</p>
        </div>

        <div id="mainMenu" class="main-actions">
            <button class="action-btn btn-join" onclick="showJoinPanel()">
                <i class="ph ph-device-mobile"></i>
                יש לי קוד חדר
            </button>
            <button class="action-btn btn-host" onclick="showHostPanel()">
                <i class="ph ph-desktop"></i>
                אני רוצה לארח
            </button>
        </div>

        <div id="gamesGrid">
            <div class="section-header">
                <h2 style="margin:0;">באיזה משחק נשחק היום?</h2>
                <button onclick="backToMain()" style="background:none; border:none; color:white; cursor:pointer; font-size:1rem; display:flex; align-items:center; gap:5px;">חזרה <i class="ph ph-arrow-left"></i></button>
            </div>

            <!-- משחק קיים -->
            <div class="game-card existing-game" onclick="startGame('classic')">
                <div class="featured-tag">המשחק המקורי 🔥</div>
                <div class="card-icon">🎭</div>
                <h3 class="card-title">מילמניה: המסיבה</h3>
                <p class="card-desc">המשחק המוכר והאהוב! תיאורי מילים, קבוצות, ואדרנלין. (Alias/Taboo סטייל).</p>
                <div class="card-meta"><span><i class="ph ph-users"></i> 4+ שחקנים</span><span><i class="ph ph-smiley"></i> מסיבה</span></div>
            </div>

            <!-- ספיד מניה (פעיל!) -->
            <div class="game-card" style="border: 2px solid var(--secondary); background: rgba(21, 196, 193, 0.1);" onclick="startGame('speed')">
                <div class="new-tag">חדש! ⚡</div>
                <div class="card-icon">⚡</div>
                <h3 class="card-title">ספיד מניה</h3>
                <p class="card-desc">60 שניות של טירוף! כולם מקבלים אותן אותיות. מי ימצא הכי הרבה מילים ייחודיות?</p>
                <div class="card-meta"><span><i class="ph ph-users"></i> 3-8+ שחקנים</span><span><i class="ph ph-lightning"></i> מהיר</span></div>
            </div>

            <!-- משחקים עתידיים -->
            <div class="game-card" onclick="startGame('tactical')">
                <div class="new-tag" style="background:#555;">בקרוב</div>
                <div class="card-icon">🧠</div>
                <h3 class="card-title">הלוח הטקטי</h3>
                <p class="card-desc">הניחו מילים על הלוח, כבשו טריטוריות וגנבו אותיות ליריבים.</p>
                <div class="card-meta"><span><i class="ph ph-users"></i> 2-4 שחקנים</span></div>
            </div>

            <div class="game-card" onclick="startGame('bomb')">
                <div class="new-tag" style="background:#555;">בקרוב</div>
                <div class="card-icon">💣</div>
                <h3 class="card-title">מנטרלי הפצצות</h3>
                <p class="card-desc">משחק שיתופי. שתפו פעולה לפני שהפצצה תתפוצץ!</p>
                <div class="card-meta"><span><i class="ph ph-users"></i> 2-6 שחקנים</span></div>
            </div>
        </div>
    </div>

    <!-- מודלים -->
    <div id="overlay" class="overlay" onclick="closeJoinPanel()"></div>
    <div id="joinPanel" class="join-form">
        <h2 style="margin-top:0; color:var(--primary);">הצטרפות למשחק</h2>
        <p>בחר לאיזה משחק אתה רוצה להצטרף:</p>
        <button class="action-btn btn-join" style="width:100%; margin-bottom:10px;" onclick="goToPlayer('classic')">מילמניה קלאסי</button>
        <button class="action-btn btn-join" style="width:100%; background: linear-gradient(135deg, #FFD700, #FFA500);" onclick="goToPlayer('speed')">ספיד מניה ⚡</button>
        <button onclick="closeJoinPanel()" style="background:none; border:none; color:#888; margin-top:15px; cursor:pointer; text-decoration:underline;">ביטול</button>
    </div>

    <!-- באנר תחתון -->
    <div id="globalBottomBanner" style="position: fixed; bottom: 0; width: 100%; text-align: center; background: rgba(0,0,0,0.5); padding: 10px; display: none;">
        <a id="globalBottomBannerLink" href="#" target="_blank">
            <img id="globalBottomBannerImg" src="" alt="פרסומת" style="max-height: 80px; max-width: 100%;">
        </a>
    </div>

    <script>
        // ניהול באנרים גלובלי
        fetch("/api/banners").then(r=>r.json()).then(d => {
            if(d.bottomBanner && d.bottomBanner.img) {
                document.getElementById("globalBottomBannerImg").src = d.bottomBanner.img;
                document.getElementById("globalBottomBannerLink").href = d.bottomBanner.link || "#";
                document.getElementById("globalBottomBanner").style.display = "block";
            }
        }).catch(e => console.log("Banners info: Dev mode"));

        function showHostPanel() { document.getElementById('mainMenu').style.display = 'none'; document.getElementById('gamesGrid').style.display = 'grid'; }
        function backToMain() { document.getElementById('gamesGrid').style.display = 'none'; document.getElementById('mainMenu').style.display = 'flex'; }
        function showJoinPanel() { document.getElementById('overlay').style.display = 'block'; document.getElementById('joinPanel').style.display = 'block'; }
        function closeJoinPanel() { document.getElementById('overlay').style.display = 'none'; document.getElementById('joinPanel').style.display = 'none'; }
        
        function goToPlayer(type) {
            if(type === 'classic') window.location.href = 'home.html'; 
            if(type === 'speed') window.location.href = 'speed/player.html';
        }

        function startGame(mode) {
            if (mode === 'classic') window.location.href = 'home.html';
            else if (mode === 'speed') window.location.href = 'speed/host.html';
            else {
                const btn = event.currentTarget;
                btn.classList.add('selected');
                alert("מצב משחק זה נמצא כרגע בפיתוח! 🚧");
                btn.classList.remove('selected');
            }
        }
    </script>
</body>
</html>
