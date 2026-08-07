
// Ghost Hunter — Phase 0
// A tiny relay server: pairs one "laptop" (the game/display) with one "phone"
// (the controller) using a short room code, and forwards messages between them.
// Neither client needs to know the other's IP — everyone only talks to this server.

const express = require("express");
const http = require("http");
const https = require("https");
const { WebSocketServer } = require("ws");
const os = require("os");
const path = require("path");
const selfsigned = require("selfsigned");

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, "public")));

function getLocalIPs() {
    const ifaces = os.networkInterfaces();
    const ips = [];
    for (const name of Object.keys(ifaces)) {
        const lower = name.toLowerCase();
        // Ignore virtual WSL, Hyper-V, Docker, and VMware interfaces
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
    // Fallback if all adapters were filtered
    if (!ips.length) {
        for (const name of Object.keys(ifaces)) {
            for (const iface of ifaces[name]) {
                if (iface.family === "IPv4" && !iface.internal) ips.push(iface.address);
            }
        }
    }
    // Prioritize standard 192.168.x.x Wi-Fi/LAN IPs first
    ips.sort((a, b) => {
        if (a.startsWith("192.168.") && !b.startsWith("192.168.")) return -1;
        if (!a.startsWith("192.168.") && b.startsWith("192.168.")) return 1;
        return 0;
    });
    return ips;
}

async function startServer() {
    const localIps = getLocalIPs();

    // Generate self-signed SSL certificate with SAN (Subject Alternative Names) for Chrome TLS 1.3 compatibility
    const altNames = [
        { type: 2, value: "localhost" },
        { type: 7, ip: "127.0.0.1" },
        ...localIps.map(ip => ({ type: 7, ip }))
    ];

    const pki = await selfsigned.generate(
        [{ name: "commonName", value: "localhost" }],
        {
            keySize: 2048,
            algorithm: "sha256",
            days: 365,
            extensions: [
                { name: "basicConstraints", cA: true },
                {
                    name: "keyUsage",
                    keyCertSign: true,
                    digitalSignature: true,
                    keyEncipherment: true
                },
                {
                    name: "extKeyUsage",
                    serverAuth: true,
                    clientAuth: true
                },
                {
                    name: "subjectAltName",
                    altNames: altNames
                }
            ]
        }
    );

    const server = https.createServer({ key: pki.private, cert: pki.cert }, app);
    const wss = new WebSocketServer({ server });

// room code -> { laptop: ws|null, phone: ws|null }
const rooms = new Map();

function makeRoomCode() {
    // short, easy to glance-verify, avoids ambiguous chars (0/O, 1/I)
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

        // --- 1. LAPTOP registers itself and gets a fresh room code ---
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

        // --- 2. PHONE joins an existing room by code (from the QR link) ---
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

        // --- 3. Anything else is game traffic: relay to whoever this client is paired with ---
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
            // Laptop leaving ends the room — the QR code is no longer valid.
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
        console.log(`\n🔒 Ghost Hunter relay server running with HTTPS (required for motion sensors).`);
        console.log(`Open the laptop page on THIS machine at:`);
        console.log(`  https://localhost:${PORT}/laptop.html\n`);
        if (localIps.length) {
            console.log(`On the same WiFi, open the laptop page using one of these:`);
            localIps.forEach((ip) => console.log(`  https://${ip}:${PORT}/laptop.html`));
        } else {
            console.log(`Could not detect a LAN IP — make sure the laptop and phone are on the same WiFi.`);
        }
        console.log(`\n⚠️ NOTE: Because this uses a self-signed certificate, your browser/phone will show a security warning.`);
        console.log(`Simply tap "Advanced" -> "Proceed / Continue to site" on your phone to allow motion sensors.`);
        console.log("");
    });
}

startServer().catch((err) => {
    console.error("Failed to start server:", err);
});
