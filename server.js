const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const os = require("os");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json());

// Serve static files from public directory
app.use(express.static(path.join(__dirname, "public")));

// CSV file path
const CSV_PATH = path.join(__dirname, "public", "database", "Ghost_Hunter-Leaderboard - Sheet1.csv");

// Ensure CSV file exists with headers
function ensureCsvHeaders() {
    const dir = path.dirname(CSV_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(CSV_PATH) || fs.readFileSync(CSV_PATH, "utf8").trim() === "") {
        fs.writeFileSync(CSV_PATH, "Timestamp,Player Name,Company,Score,Result\n", "utf8");
    }
}
ensureCsvHeaders();

// Helper: escape a CSV field (wrap in quotes if it contains comma, quote, or newline)
function csvEscape(val) {
    const s = String(val);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

// POST /api/score — record a game score to CSV
app.post("/api/score", (req, res) => {
    try {
        const { name, company, score, result } = req.body;
        if (name == null || score == null) {
            return res.status(400).json({ error: "name and score are required" });
        }
        const timestamp = new Date().toISOString();
        const row = [
            csvEscape(timestamp),
            csvEscape(name || "Unknown"),
            csvEscape(company || ""),
            csvEscape(Number(score)),
            csvEscape(result || "loss")
        ].join(",") + "\n";

        fs.appendFileSync(CSV_PATH, row, "utf8");
        res.json({ ok: true });
    } catch (err) {
        console.error("Error writing score:", err);
        res.status(500).json({ error: "Failed to save score" });
    }
});

// GET /api/leaderboard — return top 10 scores from CSV
app.get("/api/leaderboard", (req, res) => {
    try {
        const content = fs.readFileSync(CSV_PATH, "utf8");
        const lines = content.trim().split("\n");
        // Skip header row
        const entries = [];
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            // Simple CSV parse (handles quoted fields)
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
            entries.push({
                timestamp: cols[0] || "",
                name: cols[1] || "Unknown",
                company: cols[2] || "",
                score: parseInt(cols[3]) || 0,
                result: cols[4] || "loss"
            });
        }
        // Sort by score descending, then by timestamp ascending (earlier = tiebreaker)
        entries.sort((a, b) => b.score - a.score || a.timestamp.localeCompare(b.timestamp));
        // Return top 10
        res.json(entries.slice(0, 10));
    } catch (err) {
        console.error("Error reading leaderboard:", err);
        res.json([]);
    }
});

// GET /api/download-csv — download the full CSV file
app.get("/api/download-csv", (req, res) => {
    res.download(CSV_PATH, "Ghost_Hunter_Leaderboard.csv");
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

function send(ws, msg) {
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
            send(ws, { type: "room-created", room: code, ip: ips[0] || null, ips });
            logRoomState(rooms.get(code), code);
            return;
        }

        // 2. PHONE joins an existing room by code
        if (msg.type === "register-phone") {
            const code = (msg.room || "").toUpperCase();
            const room = rooms.get(code);
            if (!room) {
                send(ws, { type: "join-failed", reason: "Room not found. Ask the laptop for a fresh QR code." });
                return;
            }
            ws.role = "phone";
            ws.roomCode = code;
            room.phone = ws;
            logRoomState(room, code);

            send(ws, { type: "joined", room: code });
            if (room.laptop) {
                send(room.laptop, { type: "paired" });
                send(ws, { type: "paired" });
            }
            return;
        }

        // 3. Relay game traffic between laptop and phone
        const room = rooms.get(ws.roomCode);
        if (!room) return;

        const target = ws.role === "phone" ? room.laptop : room.phone;
        send(target, msg);
    });

    ws.on("close", () => {
        if (!ws.roomCode) return;
        const room = rooms.get(ws.roomCode);
        if (!room) return;

        if (ws.role === "laptop") {
            room.laptop = null;
            send(room.phone, { type: "peer-disconnected", who: "laptop" });
            rooms.delete(ws.roomCode);
            console.log(`[room ${ws.roomCode}] laptop left, room closed`);
        } else if (ws.role === "phone") {
            room.phone = null;
            send(room.laptop, { type: "peer-disconnected", who: "phone" });
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
