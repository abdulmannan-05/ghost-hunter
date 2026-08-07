const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const os = require("os");
const path = require("path");

const app = express();

// Serve static files from public directory
app.use(express.static(path.join(__dirname, "public")));

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

server.listen(PORT, () => {
    console.log(`Ghost Hunter relay server listening on port ${PORT}`);
    const localIps = getLocalIPs();
    if (localIps.length) {
        console.log(`Local network URL: http://${localIps[0]}:${PORT}/laptop.html`);
    }
});
