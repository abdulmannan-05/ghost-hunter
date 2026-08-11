const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

// Enable CORS for all API routes
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, "public")));

// ===================================================================
// DUAL DATABASE ENGINE (Cloud PostgreSQL on Render/Supabase OR Local SQLite)
// ===================================================================
const { Pool } = require("pg");
const Database = require("better-sqlite3");

const DB_DIR = path.join(__dirname, "public", "database");
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const CSV_PATH = path.join(DB_DIR, "Ghost_Hunter-Leaderboard - Sheet1.csv");

const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;

let pgPool = null;
let sqliteDb = null;

if (DATABASE_URL) {
    console.log("[DB] Initializing Cloud PostgreSQL database connection...");
    pgPool = new Pool({
        connectionString: DATABASE_URL,
        ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
    });

    pgPool.query(`
        CREATE TABLE IF NOT EXISTS scores (
            id SERIAL PRIMARY KEY,
            timestamp TEXT NOT NULL,
            name TEXT NOT NULL,
            company TEXT,
            score INTEGER NOT NULL,
            result TEXT NOT NULL
        );
    `).then(() => {
        console.log("[DB] Cloud PostgreSQL scores table verified.");
    }).catch(err => {
        console.error("[DB] Error setting up PostgreSQL table:", err.message);
    });
} else {
    console.log("[DB] No DATABASE_URL set. Initializing local SQLite database...");
    const DB_PATH = path.join(DB_DIR, "ghost_hunter.db");
    sqliteDb = new Database(DB_PATH);
    sqliteDb.pragma("journal_mode = WAL");

    sqliteDb.exec(`
        CREATE TABLE IF NOT EXISTS scores (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            name TEXT NOT NULL,
            company TEXT,
            score INTEGER NOT NULL,
            result TEXT NOT NULL
        )
    `);
    console.log("[DB] Local SQLite initialized at:", DB_PATH);
}

// Helper: escape a CSV field
function csvEscape(val) {
    const s = String(val == null ? "" : val);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

// Database Helpers
async function saveScoreToDb(timestamp, name, company, score, result) {
    if (pgPool) {
        await pgPool.query(
            "INSERT INTO scores (timestamp, name, company, score, result) VALUES ($1, $2, $3, $4, $5)",
            [timestamp, name, company, score, result]
        );
    } else if (sqliteDb) {
        const stmt = sqliteDb.prepare("INSERT INTO scores (timestamp, name, company, score, result) VALUES (?, ?, ?, ?, ?)");
        stmt.run(timestamp, name, company, score, result);
    }
}

async function getTopLeaderboardFromDb() {
    if (pgPool) {
        const res = await pgPool.query(`
            SELECT timestamp, name, company, score, result
            FROM scores
            ORDER BY score DESC, timestamp ASC
            LIMIT 10
        `);
        return res.rows;
    } else if (sqliteDb) {
        return sqliteDb.prepare(`
            SELECT timestamp, name, company, score, result
            FROM scores
            ORDER BY score DESC, timestamp ASC
            LIMIT 10
        `).all();
    }
    return [];
}

async function getAllScoresForCsvFromDb() {
    if (pgPool) {
        const res = await pgPool.query(`
            SELECT timestamp, name, company, score, result
            FROM scores
            ORDER BY timestamp ASC
        `);
        return res.rows;
    } else if (sqliteDb) {
        return sqliteDb.prepare(`
            SELECT timestamp, name, company, score, result
            FROM scores
            ORDER BY timestamp ASC
        `).all();
    }
    return [];
}

// POST /api/score — record a new game score into database
app.post("/api/score", async (req, res) => {
    try {
        const { name, company, score, result } = req.body;
        if (name == null || score == null) {
            return res.status(400).json({ error: "name and score are required" });
        }
        const timestamp = new Date().toISOString();
        const playerName = name || "Unknown";
        const playerCompany = company || "";
        const finalScore = Number(score);
        const gameResult = result || "loss";

        await saveScoreToDb(timestamp, playerName, playerCompany, finalScore, gameResult);
        console.log(`[DB] Score saved: ${playerName} (${playerCompany}) = ${finalScore}`);

        // Also append to local CSV file backup if possible
        try {
            const csvRow = [
                csvEscape(timestamp),
                csvEscape(playerName),
                csvEscape(playerCompany),
                csvEscape(finalScore),
                csvEscape(gameResult)
            ].join(",") + "\n";
            fs.appendFileSync(CSV_PATH, csvRow, "utf8");
        } catch (csvErr) {}

        res.json({ ok: true, timestamp });
    } catch (err) {
        console.error("[DB] Error saving score:", err);
        res.status(500).json({ error: "Failed to save score" });
    }
});

// GET /api/leaderboard — return Top 10 highest scoring games from database
app.get("/api/leaderboard", async (req, res) => {
    try {
        const rows = await getTopLeaderboardFromDb();
        res.json(rows);
    } catch (err) {
        console.error("[DB] Error reading leaderboard:", err);
        res.json([]);
    }
});

// GET /api/download-csv — download ALL games played from database as CSV file
app.get("/api/download-csv", async (req, res) => {
    try {
        const rows = await getAllScoresForCsvFromDb();

        let csv = "Timestamp,Player Name,Company,Score,Result\n";
        rows.forEach(row => {
            csv += [
                csvEscape(row.timestamp),
                csvEscape(row.name),
                csvEscape(row.company),
                csvEscape(row.score),
                csvEscape(row.result)
            ].join(",") + "\n";
        });

        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", 'attachment; filename="Ghost_Hunter_Leaderboard.csv"');
        return res.send(csv);
    } catch (err) {
        console.error("[DB] Error exporting CSV:", err);
        res.status(500).send("Failed to export CSV");
    }
});

// ===================================================================
// HTTP POLLING RELAY FOR VERCEL & SERVERLESS ENVIRONMENTS
// ===================================================================
const httpRooms = new Map();

// Clean up stale HTTP rooms older than 15 minutes
setInterval(() => {
    const now = Date.now();
    for (const [code, room] of httpRooms.entries()) {
        if (now - room.lastSeen > 15 * 60 * 1000) {
            httpRooms.delete(code);
        }
    }
}, 60000);

// POST /api/room/create — Create HTTP pairing room for laptop
app.post("/api/room/create", (req, res) => {
    const code = makeRoomCode();
    const ips = getLocalIPs();
    httpRooms.set(code, {
        laptopMsgs: [],
        phoneMsgs: [],
        phoneJoined: false,
        lastSeen: Date.now()
    });
    res.json({ ok: true, room: code, ip: ips[0] || null, ips });
});

// POST /api/room/join — Phone joins HTTP pairing room
app.post("/api/room/join", (req, res) => {
    const code = (req.body.room || "").toUpperCase();
    const room = httpRooms.get(code);
    if (!room) {
        return res.status(404).json({ ok: false, reason: "Room not found. Ask the laptop for a fresh QR code." });
    }
    room.phoneJoined = true;
    room.lastSeen = Date.now();
    room.laptopMsgs.push({ type: "paired" });
    room.phoneMsgs.push({ type: "joined", room: code });
    room.phoneMsgs.push({ type: "paired" });
    res.json({ ok: true, room: code });
});

// POST /api/room/send — Send game message via HTTP
app.post("/api/room/send", (req, res) => {
    const { room: code, role, msg } = req.body;
    const room = httpRooms.get(code);
    if (!room) return res.status(404).json({ ok: false, reason: "Room expired" });

    room.lastSeen = Date.now();
    if (role === "phone") {
        room.laptopMsgs.push(msg);
        if (room.laptopMsgs.length > 80) room.laptopMsgs.shift();
    } else if (role === "laptop") {
        room.phoneMsgs.push(msg);
        if (room.phoneMsgs.length > 80) room.phoneMsgs.shift();
    }
    res.json({ ok: true });
});

// GET /api/room/poll — Poll pending messages for role
app.get("/api/room/poll", (req, res) => {
    const code = (req.query.room || "").toUpperCase();
    const role = req.query.role;
    const room = httpRooms.get(code);
    if (!room) return res.status(404).json({ ok: false, reason: "Room expired" });

    room.lastSeen = Date.now();
    let msgs = [];
    if (role === "laptop") {
        msgs = room.laptopMsgs;
        room.laptopMsgs = [];
    } else if (role === "phone") {
        msgs = room.phoneMsgs;
        room.phoneMsgs = [];
    }

    res.json({ ok: true, msgs });
});

// Redirect root route to laptop.html
app.get("/", (req, res) => {
    res.redirect("/laptop.html");
});

// Use Render/cloud PORT variable or default to 3000 locally
const PORT = process.env.PORT || 3000;

// Create standard HTTP server (Render/cloud platforms handle SSL automatically)
const server = http.createServer(app);

// Attach WebSocket server to the HTTP server
const wss = new WebSocketServer({ server });

// room code -> { laptop: ws|null, phone: ws|null }
const rooms = new Map();

function getLocalIPs() {
    const ifaces = os.networkInterfaces();
    const ips = [];
    for (const name of Object.keys(ifaces)) {
        const lower = name.toLowerCase();
        if (
            lower.includes("vethernet") ||
            lower.includes("wsl") ||
            lower.includes("virtual") ||
            lower.includes("vbox") ||
            lower.includes("vmware") ||
            lower.includes("docker")
        ) {
            continue;
        }
        for (const iface of ifaces[name]) {
            if (iface.family === "IPv4" && !iface.internal) ips.push(iface.address);
        }
    }
    if (!ips.length) {
        for (const name of Object.keys(ifaces)) {
            for (const iface of ifaces[name]) {
                if (iface.family === "IPv4" && !iface.internal) ips.push(iface.address);
            }
        }
    }
    ips.sort((a, b) => {
        if (a.startsWith("192.168.") && !b.startsWith("192.168.")) return -1;
        if (!a.startsWith("192.168.") && b.startsWith("192.168.")) return 1;
        return 0;
    });
    return ips;
}

function makeRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code;
    do {
        code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    } while (rooms.has(code));
    return code;
}

function wsSend(ws, msg) {
    if (ws && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(msg));
    }
}

function logRoomState(room, code) {
    console.log(
        `[room ${code}] laptop=${room.laptop ? "connected" : "-"} phone=${room.phone ? "connected" : "-"}`
    );
}

wss.on("connection", (ws) => {
    ws.role = null;
    ws.roomCode = null;

    ws.on("message", (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch (e) {
            console.warn("Bad JSON from client, ignoring:", raw.toString().slice(0, 120));
            return;
        }

        // 1. LAPTOP registers itself and gets a fresh room code
        if (msg.type === "register-laptop") {
            const code = makeRoomCode();
            ws.role = "laptop";
            ws.roomCode = code;
            rooms.set(code, { laptop: ws, phone: null });
            const ips = getLocalIPs();
            wsSend(ws, { type: "room-created", room: code, ip: ips[0] || null, ips });
            logRoomState(rooms.get(code), code);
            return;
        }

        // 2. PHONE joins an existing room by code
        if (msg.type === "register-phone") {
            const code = (msg.room || "").toUpperCase();
            const room = rooms.get(code);
            if (!room) {
                wsSend(ws, { type: "join-failed", reason: "Room not found. Ask the laptop for a fresh QR code." });
                return;
            }
            ws.role = "phone";
            ws.roomCode = code;
            room.phone = ws;
            logRoomState(room, code);

            wsSend(ws, { type: "joined", room: code });
            if (room.laptop) {
                wsSend(room.laptop, { type: "paired" });
                wsSend(ws, { type: "paired" });
            }
            return;
        }

        // 3. Relay game traffic between laptop and phone
        const room = rooms.get(ws.roomCode);
        if (!room) return;

        const target = ws.role === "phone" ? room.laptop : room.phone;
        wsSend(target, msg);
    });

    ws.on("close", () => {
        if (!ws.roomCode) return;
        const room = rooms.get(ws.roomCode);
        if (!room) return;

        if (ws.role === "laptop") {
            room.laptop = null;
            wsSend(room.phone, { type: "peer-disconnected", who: "laptop" });
            rooms.delete(ws.roomCode);
            console.log(`[room ${ws.roomCode}] laptop left, room closed`);
        } else if (ws.role === "phone") {
            room.phone = null;
            wsSend(room.laptop, { type: "peer-disconnected", who: "laptop" });
            console.log(`[room ${ws.roomCode}] phone left`);
        }
    });
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Ghost Hunter relay server listening on port ${PORT} (0.0.0.0)`);
    const localIps = getLocalIPs();
    if (localIps.length) {
        console.log(`Local network URL: http://${localIps[0]}:${PORT}/laptop.html`);
    }
});
