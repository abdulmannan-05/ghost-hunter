const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

// Serve static files from public directory
app.use(express.static(path.join(__dirname, "public")));

// ===================================================================
// GOOGLE SHEETS INTEGRATION
// ===================================================================
const SHEET_ID = "1T_xPqKqKmbY4uYvw9XPlN-p2ITZg1_QrGiIPe9xAkos";
const SERVICE_ACCOUNT_PATH = path.join(__dirname, "public", "database", "calendar-service-account.json");
const SHEET_RANGE = "Sheet1"; // Sheet tab name
const CSV_PATH = path.join(__dirname, "public", "database", "Ghost_Hunter-Leaderboard - Sheet1.csv");

let sheetsApi = null;

async function initGoogleSheets() {
    try {
        let credentials = null;
        if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
            credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
        } else if (fs.existsSync(SERVICE_ACCOUNT_PATH)) {
            credentials = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, "utf8"));
        } else {
            throw new Error("No Google Service Account credentials found.");
        }
        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ["https://www.googleapis.com/auth/spreadsheets"],
        });
        const authClient = await auth.getClient();
        sheetsApi = google.sheets({ version: "v4", auth: authClient });

        // Ensure header row exists
        const headerRes = await sheetsApi.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: `${SHEET_RANGE}!A1:E1`,
        });
        const headerRow = headerRes.data.values;
        if (!headerRow || headerRow.length === 0 || headerRow[0][0] !== "Timestamp") {
            await sheetsApi.spreadsheets.values.update({
                spreadsheetId: SHEET_ID,
                range: `${SHEET_RANGE}!A1:E1`,
                valueInputOption: "RAW",
                resource: {
                    values: [["Timestamp", "Player Name", "Company", "Score", "Result"]],
                },
            });
            console.log("[Sheets] Header row created in Google Sheet.");
        }

        console.log("[Sheets] Google Sheets API initialized successfully.");
    } catch (err) {
        console.error("[Sheets] Failed to initialize Google Sheets API:", err.message);
        console.log("[Sheets] Falling back to local CSV only.");
        sheetsApi = null;
    }
}

// Initialize Google Sheets on startup
initGoogleSheets();

// Local CSV fallback — ensure file exists with headers
function ensureCsvHeaders() {
    const dir = path.dirname(CSV_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(CSV_PATH) || fs.readFileSync(CSV_PATH, "utf8").trim() === "") {
        fs.writeFileSync(CSV_PATH, "Timestamp,Player Name,Company,Score,Result\n", "utf8");
    }
}
ensureCsvHeaders();

// Helper: escape a CSV field
function csvEscape(val) {
    const s = String(val);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

// POST /api/score — record a game score to Google Sheets + local CSV
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

        // 1. Write to Google Sheets (primary)
        if (sheetsApi) {
            try {
                await sheetsApi.spreadsheets.values.append({
                    spreadsheetId: SHEET_ID,
                    range: `${SHEET_RANGE}!A:E`,
                    valueInputOption: "RAW",
                    insertDataOption: "INSERT_ROWS",
                    resource: {
                        values: [[timestamp, playerName, playerCompany, finalScore, gameResult]],
                    },
                });
                console.log(`[Sheets] Score saved: ${playerName} (${playerCompany}) = ${finalScore}`);
            } catch (sheetErr) {
                console.error("[Sheets] Error writing to Google Sheet:", sheetErr.message);
            }
        }

        // 2. Also write to local CSV (backup/mirror)
        try {
            const row = [
                csvEscape(timestamp),
                csvEscape(playerName),
                csvEscape(playerCompany),
                csvEscape(finalScore),
                csvEscape(gameResult)
            ].join(",") + "\n";
            fs.appendFileSync(CSV_PATH, row, "utf8");
        } catch (csvErr) {
            console.warn("[Local CSV Mirror] Could not append row locally (file locked):", csvErr.message);
        }

        res.json({ ok: true, timestamp });
    } catch (err) {
        console.error("Error writing score:", err);
        res.status(500).json({ error: "Failed to save score" });
    }
});

// GET /api/leaderboard — return top 10 scores from Google Sheets (or local CSV fallback)
app.get("/api/leaderboard", async (req, res) => {
    try {
        let entries = [];

        // Try Google Sheets first
        if (sheetsApi) {
            try {
                const response = await sheetsApi.spreadsheets.values.get({
                    spreadsheetId: SHEET_ID,
                    range: `${SHEET_RANGE}!A:E`,
                });
                const rows = response.data.values || [];
                // Skip header row (index 0)
                for (let i = 1; i < rows.length; i++) {
                    const row = rows[i];
                    if (!row || row.length < 4) continue;
                    entries.push({
                        timestamp: row[0] || "",
                        name: row[1] || "Unknown",
                        company: row[2] || "",
                        score: parseInt(row[3]) || 0,
                        result: row[4] || "loss"
                    });
                }
                console.log(`[Sheets] Leaderboard fetched: ${entries.length} total entries.`);
            } catch (sheetErr) {
                console.error("[Sheets] Error reading from Google Sheet:", sheetErr.message);
            }
        }

        // Fallback to local CSV if Sheets returned nothing
        if (entries.length === 0) {
            const content = fs.readFileSync(CSV_PATH, "utf8");
            const lines = content.trim().split("\n");
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
                entries.push({
                    timestamp: cols[0] || "",
                    name: cols[1] || "Unknown",
                    company: cols[2] || "",
                    score: parseInt(cols[3]) || 0,
                    result: cols[4] || "loss"
                });
            }
        }

        // Sort by score descending, then by timestamp ascending
        entries.sort((a, b) => b.score - a.score || a.timestamp.localeCompare(b.timestamp));
        // Return top 10
        res.json(entries.slice(0, 10));
    } catch (err) {
        console.error("Error reading leaderboard:", err);
        res.json([]);
    }
});

// GET /api/download-csv — download all scores as CSV (from Google Sheets if available)
app.get("/api/download-csv", async (req, res) => {
    try {
        if (sheetsApi) {
            try {
                const response = await sheetsApi.spreadsheets.values.get({
                    spreadsheetId: SHEET_ID,
                    range: `${SHEET_RANGE}!A:E`,
                });
                const rows = response.data.values || [];
                // Build CSV from Sheets data
                let csv = "";
                rows.forEach(row => {
                    csv += row.map(cell => csvEscape(cell || "")).join(",") + "\n";
                });
                res.setHeader("Content-Type", "text/csv");
                res.setHeader("Content-Disposition", 'attachment; filename="Ghost_Hunter_Leaderboard.csv"');
                return res.send(csv);
            } catch (sheetErr) {
                console.error("[Sheets] Error downloading from Google Sheet:", sheetErr.message);
                // Fall through to local CSV
            }
        }
        // Fallback: serve local CSV file
        res.download(CSV_PATH, "Ghost_Hunter_Leaderboard.csv");
    } catch (err) {
        console.error("Error downloading CSV:", err);
        res.status(500).send("Failed to download CSV");
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
