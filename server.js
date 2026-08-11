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
// SQLITE DATABASE ENGINE
// ===================================================================
const Database = require("better-sqlite3");

const DB_DIR = path.join(__dirname, "public", "database");
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const DB_PATH = path.join(DB_DIR, "ghost_hunter.db");
const CSV_PATH = path.join(DB_DIR, "Ghost_Hunter-Leaderboard - Sheet1.csv");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL"); // High performance Write-Ahead Logging

// Initialize table schema
db.exec(`
    CREATE TABLE IF NOT EXISTS scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        name TEXT NOT NULL,
        company TEXT,
        score INTEGER NOT NULL,
        result TEXT NOT NULL
    )
`);

console.log("[SQLite] Database initialized at:", DB_PATH);

// Helper: escape a CSV field
function csvEscape(val) {
    const s = String(val == null ? "" : val);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

// Auto-migrate legacy CSV data into SQLite if table is currently empty
try {
    const countRow = db.prepare("SELECT COUNT(*) AS count FROM scores").get();
    if (countRow.count === 0 && fs.existsSync(CSV_PATH)) {
        const content = fs.readFileSync(CSV_PATH, "utf8");
        const lines = content.trim().split("\n");
        const insertStmt = db.prepare("INSERT INTO scores (timestamp, name, company, score, result) VALUES (?, ?, ?, ?, ?)");
        let migratedCount = 0;
        
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const cols = [];
            let current = "";
            let inQuotes = false;
            for (let c = 0; c < line.length; c++) {
                if (inQuotes) {
                    if (line[c] === '"' && line[c + 1] === '"') {
                        current += '"';
                        c++;
                    } else if (line[c] === '"') {
                        inQuotes = false;
                    } else {
                        current += line[c];
                    }
                } else {
                    if (line[c] === '"') {
                        inQuotes = true;
                    } else if (line[c] === ',') {
                        cols.push(current);
                        current = "";
                    } else {
                        current += line[c];
                    }
                }
            }
            cols.push(current);

            const ts = cols[0] || new Date().toISOString();
            const nm = cols[1] || "Unknown";
            const comp = cols[2] || "";
            const sc = parseInt(cols[3]) || 0;
            const res = cols[4] || "loss";

            insertStmt.run(ts, nm, comp, sc, res);
            migratedCount++;
        }
        console.log(`[SQLite] Migrated ${migratedCount} existing scores from CSV into database.`);
    }
} catch (migErr) {
    console.warn("[SQLite] Migration warning:", migErr.message);
}

// POST /api/score — record a new game score into SQLite database
app.post("/api/score", (req, res) => {
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

        // Insert score into SQLite database
        const stmt = db.prepare("INSERT INTO scores (timestamp, name, company, score, result) VALUES (?, ?, ?, ?, ?)");
        stmt.run(timestamp, playerName, playerCompany, finalScore, gameResult);

        console.log(`[SQLite] Score saved: ${playerName} (${playerCompany}) = ${finalScore}`);

        // Also append to local CSV file backup
        try {
            const csvRow = [
                csvEscape(timestamp),
                csvEscape(playerName),
                csvEscape(playerCompany),
                csvEscape(finalScore),
                csvEscape(gameResult)
            ].join(",") + "\n";
            fs.appendFileSync(CSV_PATH, csvRow, "utf8");
        } catch (csvErr) {
            // Ignore CSV append errors
        }

        res.json({ ok: true, timestamp });
    } catch (err) {
        console.error("[SQLite] Error saving score:", err);
        res.status(500).json({ error: "Failed to save score" });
    }
});

// GET /api/leaderboard — return Top 10 highest scoring games from SQLite database
app.get("/api/leaderboard", (req, res) => {
    try {
        const rows = db.prepare(`
            SELECT timestamp, name, company, score, result
            FROM scores
            ORDER BY score DESC, timestamp ASC
            LIMIT 10
        `).all();

        res.json(rows);
    } catch (err) {
        console.error("[SQLite] Error reading leaderboard:", err);
        res.json([]);
    }
});

// GET /api/download-csv — download ALL games played from database as CSV file
app.get("/api/download-csv", (req, res) => {
    try {
        const rows = db.prepare(`
            SELECT timestamp, name, company, score, result
            FROM scores
            ORDER BY timestamp ASC
        `).all();

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
        console.error("[SQLite] Error exporting CSV:", err);
        res.status(500).send("Failed to export CSV");
    }
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
