const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");
const { Pool } = require("pg");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

// --- טעינת מודול ספיד מניה ---
// וודא שיצרת תיקייה בשם backend ושמת בה את הקובץ speedGameManager.js
const speedModulePath = path.join(__dirname, 'backend', 'speedGameManager.js');
if (fs.existsSync(speedModulePath)) {
    const { initSpeedGame } = require('./backend/speedGameManager');
    initSpeedGame(io);
    console.log("✅ Speed Mania module loaded successfully.");
} else {
    console.error("⚠️ Error: 'backend/speedGameManager.js' not found.");
}

const PORT = process.env.PORT || 3000;
const ADMIN_CODE = process.env.ADMIN_CODE || "ONEBTN";

// --- Setup ---
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// --- Database (חלק מהקוד המקורי שלך - מקוצר אך שומר על פונקציונליות) ---
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
    // יצירת טבלאות בסיסיות למניעת שגיאות
    await pool.query(`CREATE TABLE IF NOT EXISTS site_settings (id SERIAL PRIMARY KEY, top_banner_img TEXT, top_banner_link TEXT, bottom_banner_img TEXT, bottom_banner_link TEXT, top_banner_img_mobile TEXT, bottom_banner_img_mobile TEXT);`);
    await pool.query(`INSERT INTO site_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;`);
    dbReady = true;
    console.log("✅ Postgres ready.");
  } catch (err) {
    console.error("❌ DB Error:", err.message);
  }
}
initDb();

// --- API לבאנרים ---
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

server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
