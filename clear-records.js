const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const Database = require("better-sqlite3");

const DB_DIR = path.join(__dirname, "public", "database");
const CSV_PATH = path.join(DB_DIR, "Ghost_Hunter-Leaderboard - Sheet1.csv");
const DB_PATH = path.join(DB_DIR, "ghost_hunter.db");
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.argv[2];

async function clearRecords() {
    console.log("Starting database and record cleanup...");

    // 1. Reset CSV backup file
    try {
        const csvHeader = "Timestamp,Player Name,Company,Score,Result\n";
        fs.writeFileSync(CSV_PATH, csvHeader, "utf8");
        console.log(`[CSV] Reset CSV backup file at: ${CSV_PATH}`);
    } catch (err) {
        console.error(`[CSV] Error resetting CSV backup: ${err.message}`);
    }

    // 2. Clear Database
    if (DATABASE_URL) {
        console.log("[DB] Connecting to Cloud PostgreSQL database...");
        const pool = new Pool({
            connectionString: DATABASE_URL,
            ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
        });

        try {
            await pool.query("TRUNCATE TABLE scores RESTART IDENTITY;");
            console.log("[DB] Cloud PostgreSQL 'scores' table truncated successfully.");
        } catch (err) {
            console.error(`[DB] Error truncating PostgreSQL table: ${err.message}`);
        } finally {
            await pool.end();
        }
    } else {
        console.log("[DB] Connecting to local SQLite database...");
        if (fs.existsSync(DB_PATH)) {
            try {
                const db = new Database(DB_PATH);
                db.exec("DELETE FROM scores;");
                // Reset autoincrement sequence
                try {
                    db.exec("DELETE FROM sqlite_sequence WHERE name='scores';");
                } catch (e) {
                    // sqlite_sequence might not exist if no auto-increment was defined
                }
                db.close();
                console.log("[DB] Local SQLite 'scores' table cleared successfully.");
            } catch (err) {
                console.error(`[DB] Error clearing SQLite database: ${err.message}`);
            }
        } else {
            console.log("[DB] SQLite database file does not exist yet. Nothing to clear.");
        }
    }

    console.log("Cleanup complete!");
}

clearRecords();
