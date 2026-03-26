require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const { ethers } = require('ethers');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// ===== LINE Messaging API =====
const LINE_CHANNEL_TOKEN = process.env.LINE_CHANNEL_TOKEN;
const LINE_USER_ID = process.env.LINE_USER_ID;
const notifiedGroups = new Set(); // ป้องกันแจ้งซ้ำ

async function sendLineAlert(groupNum, auditHash, blockchainHash) {
    if (!LINE_CHANNEL_TOKEN || !LINE_USER_ID) return;
    if (notifiedGroups.has(groupNum)) return; // แจ้งแล้วไม่แจ้งซ้ำ

    const message = `🚨 SECURITY ALERT 🚨\n\nพบการดัดแปลง Log!\n📦 Group: ${groupNum}\n🔑 Audit Hash: ${auditHash.substring(0, 20)}...\n⛓️ Blockchain Hash: ${blockchainHash.substring(0, 20)}...\n⏰ เวลา: ${new Date().toLocaleString('th-TH')}\n\n⚠️ Log ในฐานข้อมูลไม่ตรงกับ Blockchain!`;

    try {
        const res = await fetch('https://api.line.me/v2/bot/message/push', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${LINE_CHANNEL_TOKEN}`
            },
            body: JSON.stringify({
                to: LINE_USER_ID,
                messages: [{ type: 'text', text: message }]
            })
        });

        if (res.ok) {
            notifiedGroups.add(groupNum);
            console.log(`📱 LINE แจ้งเตือน Group ${groupNum} สำเร็จ!`);
        } else {
            const err = await res.json();
            console.error(`❌ LINE Error:`, err.message || JSON.stringify(err));
        }
    } catch (e) {
        console.error(`❌ LINE ส่งไม่ได้:`, e.message);
    }
}

// Middleware ตรวจสอบ API Key
const API_KEY = process.env.API_KEY;
function authMiddleware(req, res, next) {
    const key = req.headers['x-api-key'] || req.query.apiKey;
    if (API_KEY && key !== API_KEY) {
        return res.status(401).json({ error: 'API Key ไม่ถูกต้อง' });
    }
    next();
}
app.use('/api', authMiddleware);

// ใช้ Connection Pool เพื่อความเสถียรของ Database
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    dateStrings: true,
    waitForConnections: true,
    connectionLimit: 10
});

// ตั้งค่า Blockchain
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const abi = [
    "function addLog(string memory _id, string memory _hash) public",
    "function getLog(string memory _id) public view returns (string memory, uint256, address)"
];
const contract = new ethers.Contract(process.env.CONTRACT_ADDRESS, abi, wallet);

// ===== State =====
let lastProcessedTime = '1970-01-01 00:00:00';
let currentGroupNumber = 1;
let currentRowIndex = 0;      // 0 = ยังไม่มีแถวในกลุ่มนี้, 1-20 = แถวล่าสุดที่ใส่
let previousHash = '0000000000000000000000000000000000000000000000000000000000000000';
let isProcessing = false;
let isAuditing = false;

// ===== External Log Queue (สำหรับ /api/ingest) =====
let externalQueue = [];

// 1. เริ่มต้น Server: สร้างตาราง + ดึง state ล่าสุด
async function initServer() {
    try {
        // สร้างตาราง audit_ledger แบบใหม่ (ถ้ายังไม่มี)
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS audit_ledger (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                group_number INT NOT NULL,
                row_index INT NOT NULL,
                event_time DATETIME(6) NOT NULL,
                log_source VARCHAR(100) NOT NULL,
                log_content TEXT NOT NULL,
                current_hash VARCHAR(64) NOT NULL,
                is_anchor TINYINT DEFAULT 0,
                tx_hash VARCHAR(100),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                is_alert TINYINT DEFAULT 0,
                tamper_first_detected_at DATETIME,
                INDEX idx_group (group_number),
                INDEX idx_event_time (event_time)
            )
        `);

        // ดึง state ล่าสุดจาก audit_ledger
        const [lastRow] = await pool.execute(
            "SELECT group_number, row_index, current_hash, event_time FROM audit_ledger ORDER BY id DESC LIMIT 1"
        );

        if (lastRow.length > 0) {
            const last = lastRow[0];
            previousHash = last.current_hash;
            lastProcessedTime = last.event_time;

            if (last.row_index >= 20) {
                // กลุ่มเดิมครบ 20 แล้ว → เริ่มกลุ่มใหม่
                currentGroupNumber = last.group_number + 1;
                currentRowIndex = 0;
            } else {
                currentGroupNumber = last.group_number;
                currentRowIndex = last.row_index;
            }
        }

        console.log(`🕒 ระบบพร้อม! Group: ${currentGroupNumber}, Row: ${currentRowIndex}/20, เฝ้าระวัง Log ต่อจาก: ${lastProcessedTime}`);
    } catch (error) {
        console.error("❌ เชื่อมต่อฐานข้อมูลไม่ได้:", error.message);
        process.exit(1);
    }
}

// 2. ดึง Log 1 ตัว → Hash Chain → INSERT → ครบ 20 ส่ง Blockchain
async function processNextLog() {
    if (isProcessing) return;
    try {
        isProcessing = true;

        let logEntry = null;

        // ลำดับความสำคัญ: general_log ก่อน → แล้วค่อย external queue
        const [logs] = await pool.execute(
            `SELECT event_time, user_host, argument FROM mysql.general_log 
             WHERE event_time > ? 
               AND argument NOT LIKE '%audit_ledger%'
             ORDER BY event_time ASC LIMIT 1`, [lastProcessedTime]
        );

        if (logs.length > 0) {
            logEntry = {
                event_time: logs[0].event_time,
                source: 'general_log',
                content: `${logs[0].user_host} | ${logs[0].argument}`
            };
        } else if (externalQueue.length > 0) {
            // ดึงจาก external queue
            logEntry = externalQueue.shift();
        }

        if (!logEntry) return; // ไม่มี log ใหม่

        // ===== Hash Chaining =====
        currentRowIndex++;
        const dataString = `${currentRowIndex}${logEntry.event_time}${logEntry.source}${logEntry.content}${previousHash}`;
        const currentHash = crypto.createHash('sha256').update(dataString).digest('hex');

        // INSERT 1 แถว
        await pool.execute(
            `INSERT INTO audit_ledger (group_number, row_index, event_time, log_source, log_content, current_hash) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [currentGroupNumber, currentRowIndex, logEntry.event_time, logEntry.source, logEntry.content, currentHash]
        );

        console.log(`🔗 Group ${currentGroupNumber} | Row ${currentRowIndex}/20 | Hash: ${currentHash.substring(0, 16)}...`);

        previousHash = currentHash;
        lastProcessedTime = logEntry.event_time;

        // ===== ครบ 20 → ส่ง Blockchain =====
        if (currentRowIndex >= 20) {
            const blockId = `GROUP_${currentGroupNumber}`;
            console.log(`🚀 ครบ 20 แถว! กำลังส่ง ${blockId} ขึ้น Blockchain...`);

            try {
                const tx = await contract.addLog(blockId, currentHash);
                await tx.wait();

                // อัปเดตแถว anchor
                await pool.execute(
                    "UPDATE audit_ledger SET is_anchor = 1, tx_hash = ? WHERE group_number = ? AND row_index = 20",
                    [tx.hash, currentGroupNumber]
                );

                console.log(`✅ ${blockId} บันทึกลง Blockchain สำเร็จ! TX: ${tx.hash}`);

                // เริ่มกลุ่มใหม่
                currentGroupNumber++;
                currentRowIndex = 0;

            } catch (bcError) {
                // Blockchain fail → ลบทั้งกลุ่ม แล้ว rollback state
                console.error(`❌ Blockchain fail!`, bcError.message);
                await pool.execute("DELETE FROM audit_ledger WHERE group_number = ?", [currentGroupNumber]);

                // Rollback state กลับไป state ของ group ก่อนหน้า
                const [prevRow] = await pool.execute(
                    "SELECT group_number, row_index, current_hash, event_time FROM audit_ledger ORDER BY id DESC LIMIT 1"
                );
                if (prevRow.length > 0) {
                    previousHash = prevRow[0].current_hash;
                    lastProcessedTime = prevRow[0].event_time;
                    currentGroupNumber = prevRow[0].group_number + 1;
                    currentRowIndex = 0;
                } else {
                    previousHash = '0000000000000000000000000000000000000000000000000000000000000000';
                    lastProcessedTime = '1970-01-01 00:00:00';
                    currentGroupNumber = 1;
                    currentRowIndex = 0;
                }
            }
        }

    } catch (error) {
        console.error("❌ processNextLog Error:", error.message);
    } finally {
        isProcessing = false;
    }
}

// 3. Audit: re-hash ทุกแถว → เทียบ anchor กับ blockchain
async function runAudit() {
    if (isAuditing) return;
    try {
        isAuditing = true;

        // ดึงทุก group ที่มี anchor (ส่ง blockchain แล้ว)
        const [anchors] = await pool.execute(
            "SELECT DISTINCT group_number FROM audit_ledger WHERE is_anchor = 1 ORDER BY group_number ASC"
        );

        for (const anchor of anchors) {
            try {
                const groupNum = anchor.group_number;

                // ดึงทุกแถวในกลุ่มนี้
                const [rows] = await pool.execute(
                    "SELECT * FROM audit_ledger WHERE group_number = ? ORDER BY row_index ASC",
                    [groupNum]
                );

                if (rows.length === 0) continue;

                // ดึง hash ของแถวสุดท้ายของกลุ่มก่อนหน้า (seed)
                let reHash;
                if (groupNum === 1) {
                    reHash = '0000000000000000000000000000000000000000000000000000000000000000';
                } else {
                    const [prevAnchor] = await pool.execute(
                        "SELECT current_hash FROM audit_ledger WHERE group_number = ? AND row_index = 20 LIMIT 1",
                        [groupNum - 1]
                    );
                    reHash = prevAnchor.length > 0
                        ? prevAnchor[0].current_hash
                        : '0000000000000000000000000000000000000000000000000000000000000000';
                }

                // Re-hash ทุกแถว
                for (const row of rows) {
                    if (row.log_source === 'general_log') {
                        // ตรวจจาก general_log จริง
                        const parts = row.log_content.split(' | ');
                        const userHost = parts[0] || '';
                        const argument = parts.slice(1).join(' | ') || '';

                        const [exact] = await pool.execute(
                            `SELECT event_time, user_host, argument FROM mysql.general_log 
                             WHERE event_time = ? AND user_host = ? AND argument = ? LIMIT 1`,
                            [row.event_time, userHost, argument]
                        );

                        let content;
                        if (exact.length > 0) {
                            content = `${exact[0].user_host} | ${exact[0].argument}`;
                        } else {
                            // เช็คว่าถูกแก้ไขหรือถูกลบ
                            const [modified] = await pool.execute(
                                `SELECT event_time, user_host, argument FROM mysql.general_log 
                                 WHERE event_time = ? AND user_host = ? LIMIT 1`,
                                [row.event_time, userHost]
                            );
                            if (modified.length > 0) {
                                content = `${modified[0].user_host} | ${modified[0].argument}`;
                            } else {
                                content = 'DELETED';
                            }
                        }

                        const dataString = `${row.row_index}${row.event_time}${row.log_source}${content}${reHash}`;
                        reHash = crypto.createHash('sha256').update(dataString).digest('hex');
                    } else {
                        // External log → ใช้ข้อมูลจาก audit_ledger ตรงๆ (ไม่มี source table ให้ re-query)
                        const dataString = `${row.row_index}${row.event_time}${row.log_source}${row.log_content}${reHash}`;
                        reHash = crypto.createHash('sha256').update(dataString).digest('hex');
                    }
                }

                // เทียบ anchor hash กับ blockchain
                const onChain = await contract.getLog(`GROUP_${groupNum}`);
                const isAlert = reHash !== onChain[0];

                if (isAlert) {
                    await pool.execute(
                        `UPDATE audit_ledger 
                         SET is_alert = 1, tamper_first_detected_at = COALESCE(tamper_first_detected_at, NOW()) 
                         WHERE group_number = ?`,
                        [groupNum]
                    );
                    console.log(`🚨 ALERT: Group ${groupNum} — hash ไม่ตรงกับ Blockchain!`);
                    await sendLineAlert(groupNum, reHash, onChain[0]);
                } else {
                    await pool.execute(
                        "UPDATE audit_ledger SET is_alert = 0 WHERE group_number = ?",
                        [groupNum]
                    );
                }

            } catch (error) {
                if (error.message.includes("Block not found")) {
                    console.log(`⏳ Group ${anchor.group_number} รอการยืนยันบนเชน...`);
                } else if (error.message.includes('timeout') || error.code === 'TIMEOUT') {
                    console.log(`⚠️ Timeout Group ${anchor.group_number} จะลองใหม่รอบหน้า`);
                } else {
                    console.error(`Audit Error (Group ${anchor.group_number}):`, error.message);
                }
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    } finally {
        isAuditing = false;
    }
}

// 4. API: รับ Log จากภายนอก
app.post('/api/ingest', (req, res) => {
    try {
        const body = req.body;
        let logs = [];

        if (Array.isArray(body.logs)) {
            logs = body.logs;
        } else if (body.log_source && body.message) {
            logs = [body];
        } else {
            return res.status(400).json({ error: 'ต้องระบุ log_source และ message' });
        }

        let count = 0;
        for (const log of logs) {
            if (!log.log_source || !log.message) continue;
            externalQueue.push({
                event_time: log.event_time || new Date().toISOString().slice(0, 19).replace('T', ' '),
                source: `api:${log.log_source}`,
                content: log.message
            });
            count++;
        }

        console.log(`📥 รับ ${count} log จาก API (Queue: ${externalQueue.length})`);
        res.json({ success: true, received: count, queueSize: externalQueue.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. API: ดึงข้อมูลให้ Dashboard
app.get('/api/get-status', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;

        const [rows] = await pool.execute(
            "SELECT * FROM audit_ledger ORDER BY id DESC LIMIT ? OFFSET ?",
            [String(limit), String(offset)]
        );
        const [countResult] = await pool.execute("SELECT COUNT(*) as total FROM audit_ledger");
        const total = countResult[0].total;

        // ดึงสรุปตาม group
        const [groups] = await pool.execute(
            `SELECT group_number, COUNT(*) as row_count, 
                    MAX(is_anchor) as has_anchor, MAX(is_alert) as has_alert
             FROM audit_ledger GROUP BY group_number ORDER BY group_number DESC LIMIT 10`
        );

        res.json({
            rows,
            groups,
            state: {
                currentGroup: currentGroupNumber,
                currentRow: currentRowIndex,
                queueSize: externalQueue.length
            },
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 6. API: Report — ดึงข้อมูล alert ทั้งหมด + เทียบกับ blockchain
app.get('/api/report', async (req, res) => {
    try {
        // ดึงทุก group ที่มี anchor
        const [groups] = await pool.execute(
            `SELECT group_number, COUNT(*) as row_count,
                    MIN(event_time) as start_time, MAX(event_time) as end_time,
                    MAX(is_anchor) as has_anchor, MAX(is_alert) as has_alert
             FROM audit_ledger GROUP BY group_number ORDER BY group_number ASC`
        );

        const report = [];
        for (const g of groups) {
            // ดึง anchor row (แถวที่ 20) ของกลุ่มนี้
            const [anchorRow] = await pool.execute(
                "SELECT current_hash, tx_hash FROM audit_ledger WHERE group_number = ? AND is_anchor = 1 LIMIT 1",
                [g.group_number]
            );

            let blockchainHash = null;
            let blockchainTimestamp = null;
            let blockchainRecorder = null;
            let onChainStatus = 'NOT_ON_CHAIN';

            if (anchorRow.length > 0) {
                try {
                    const onChain = await contract.getLog(`GROUP_${g.group_number}`);
                    blockchainHash = onChain[0];
                    blockchainTimestamp = new Date(Number(onChain[1]) * 1000).toISOString().slice(0, 19).replace('T', ' ');
                    blockchainRecorder = onChain[2];
                    onChainStatus = anchorRow[0].current_hash === blockchainHash ? 'MATCH' : 'MISMATCH';
                } catch (e) {
                    if (e.message.includes("Block not found")) {
                        onChainStatus = 'PENDING';
                    } else {
                        onChainStatus = 'ERROR';
                    }
                }
            }

            // ถ้ามี alert ดึงรายละเอียดแถวที่มีปัญหา
            let alertRows = [];
            if (g.has_alert === 1) {
                const [rows] = await pool.execute(
                    "SELECT row_index, event_time, log_source, log_content, current_hash, tamper_first_detected_at FROM audit_ledger WHERE group_number = ? AND is_alert = 1 ORDER BY row_index ASC",
                    [g.group_number]
                );
                alertRows = rows;
            }

            report.push({
                group_number: g.group_number,
                row_count: g.row_count,
                start_time: g.start_time,
                end_time: g.end_time,
                has_anchor: g.has_anchor === 1,
                audit_hash: anchorRow.length > 0 ? anchorRow[0].current_hash : null,
                tx_hash: anchorRow.length > 0 ? anchorRow[0].tx_hash : null,
                blockchain_hash: blockchainHash,
                blockchain_timestamp: blockchainTimestamp,
                blockchain_recorder: blockchainRecorder,
                status: onChainStatus,
                alert_rows: alertRows
            });
        }

        res.json({ report, generatedAt: new Date().toISOString() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 7. API: ดึง Config
app.get('/api/config', (req, res) => {
    res.json({ contractAddress: process.env.CONTRACT_ADDRESS, rpcUrl: process.env.RPC_URL });
});

// 8. เริ่มการทำงาน
initServer().then(() => {
    setInterval(processNextLog, 3000);   // ดึง log ทุก 3 วินาที
    setInterval(runAudit, 30000);        // audit ทุก 30 วินาที
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🛡️ Server Running (Port ${PORT}) — Row-by-Row Hash Chaining 🛡️`);
});