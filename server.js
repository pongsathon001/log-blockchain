require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const { ethers } = require('ethers');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

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

let lastProcessedTime = '1970-01-01 00:00:00';
let isProcessingLogs = false;
let isAuditing = false;

// 1. ดึงเวลาล่าสุดตอนเปิด Server
async function initServer() {
    try {
        const [rows] = await pool.execute("SELECT sequence_end_time FROM audit_ledger ORDER BY block_id DESC LIMIT 1");
        if (rows.length > 0) lastProcessedTime = rows[0].sequence_end_time;
        console.log(`🕒 ระบบพร้อม! เริ่มเฝ้าระวัง Log ใหม่ต่อจากเวลา: ${lastProcessedTime}`);
    } catch (error) {
        console.error("❌ เชื่อมต่อฐานข้อมูลไม่ได้:", error.message);
        process.exit(1);
    }
}

// 2. ฟังก์ชันมัดรวม 20 Logs และร้อยโซ่ Hash 
async function accumulateAndStore() {
    if (isProcessingLogs) return;
    try {
        isProcessingLogs = true;
        // ดึง Log ที่ยังไม่เคยประมวลผล (ใช้ Filter ให้ตรงกับ Audit)
        const [logs] = await pool.execute(
            `SELECT event_time, user_host, argument FROM mysql.general_log 
             WHERE event_time > ? 
               AND argument NOT LIKE '%general_log%' 
               AND argument NOT LIKE '%audit_ledger%' 
               AND argument NOT LIKE '%performance_schema%'
               AND argument NOT LIKE '%innodb%'
             ORDER BY event_time ASC LIMIT 20`, [lastProcessedTime]
        );

        if (logs && logs.length === 20) {
            console.log("\n📦 พบ Log ใหม่ครบ 20 รายการ กำลังร้อยโซ่ Hash ภายใน Block...");

            const [prevBlock] = await pool.execute("SELECT master_hash FROM audit_ledger ORDER BY block_id DESC LIMIT 1");
            let currentHash = prevBlock.length > 0 
                ? prevBlock[0].master_hash 
                : "0000000000000000000000000000000000000000000000000000000000000000";

            logs.forEach((log, idx) => {
                // รวม index ตำแหน่งของ log เพื่อป้องกันการสลับลำดับ
                const dataString = `${idx}${log.event_time}${log.user_host}${log.argument}${currentHash}`;
                currentHash = crypto.createHash('sha256').update(dataString).digest('hex');
            });

            const masterHash = currentHash;
            const rawContent = JSON.stringify(logs);

            const [result] = await pool.execute(
                "INSERT INTO audit_ledger (sequence_start_time, sequence_end_time, log_count, raw_logs_content, master_hash) VALUES (?, ?, ?, ?, ?)",
                [logs[0].event_time, logs[19].event_time, 20, rawContent, masterHash]
            );

            const blockId = `BLOCK_${result.insertId}`;
            console.log(`🚀 กำลังส่ง ${blockId} ขึ้น Blockchain...`);

            try {
                const tx = await contract.addLog(blockId, masterHash);
                await tx.wait();
                console.log(`✅ ${blockId} บันทึกลง Blockchain สำเร็จ!`);
                lastProcessedTime = logs[19].event_time; 
            } catch (bcError) {
                await pool.execute("DELETE FROM audit_ledger WHERE block_id = ?", [result.insertId]);
                console.error(`❌ Blockchain fail!`, bcError.message);
            }
        }
    } catch (error) {
        console.error("❌ accumulateAndStore Error:", error.message);
    } finally {
        isProcessingLogs = false;
    }
}

// 3. ระบบ Audit: re-hash จากสถานะปัจจุบันของ general_log → เทียบกับ blockchain
async function runAudit() {
    if (isAuditing) return;
    try {
        isAuditing = true;
        const [blocks] = await pool.execute("SELECT * FROM audit_ledger ORDER BY block_id ASC");

        for (let block of blocks) {
            try {
                // ขั้นตอนที่ 1: ดึง log เดิมจาก raw_logs_content แล้วเช็คทีละตัวใน general_log
                const storedLogs = JSON.parse(block.raw_logs_content);

                // ขั้นตอนที่ 2: ดึง seed จาก block ก่อนหน้า
                const [prev] = await pool.execute(
                    "SELECT master_hash FROM audit_ledger WHERE block_id < ? ORDER BY block_id DESC LIMIT 1",
                    [block.block_id]
                );
                let currentHash = prev.length > 0
                    ? prev[0].master_hash
                    : "0000000000000000000000000000000000000000000000000000000000000000";

                // ขั้นตอนที่ 3: re-hash ทีละ log โดยเช็คจาก general_log จริง
                for (let idx = 0; idx < storedLogs.length; idx++) {
                    const log = storedLogs[idx];

                    // เช็ค 1: log เดิมยังอยู่ครบ? (event_time + user_host + argument ตรงหมด)
                    const [exact] = await pool.execute(
                        `SELECT event_time, user_host, argument FROM mysql.general_log 
                         WHERE event_time = ? AND user_host = ? AND argument = ? LIMIT 1`,
                        [log.event_time, log.user_host, log.argument]
                    );

                    let data;
                    if (exact.length > 0) {
                        // log ไม่เปลี่ยน → hash ด้วยข้อมูลเดิม
                        data = `${idx}${exact[0].event_time}${exact[0].user_host}${exact[0].argument}${currentHash}`;
                    } else {
                        // เช็ค 2: log ถูกแก้ไข? (event_time + user_host ตรง แต่ argument เปลี่ยน)
                        const [modified] = await pool.execute(
                            `SELECT event_time, user_host, argument FROM mysql.general_log 
                             WHERE event_time = ? AND user_host = ? LIMIT 1`,
                            [log.event_time, log.user_host]
                        );

                        if (modified.length > 0) {
                            // log ถูกแก้ไข → hash ด้วยข้อมูลที่ถูกแก้ (hash เปลี่ยนเพราะ argument ต่าง)
                            data = `${idx}${modified[0].event_time}${modified[0].user_host}${modified[0].argument}${currentHash}`;
                        } else {
                            // log ถูกลบ → hash ด้วย "DELETED"
                            data = `${idx}DELETED${currentHash}`;
                        }
                    }

                    currentHash = crypto.createHash('sha256').update(data).digest('hex');
                }

                // ขั้นตอนที่ 4: อัปเดต master_hash ให้สะท้อนสถานะ general_log ปัจจุบัน
                await pool.execute(
                    "UPDATE audit_ledger SET master_hash = ? WHERE block_id = ?",
                    [currentHash, block.block_id]
                );

                // ขั้นตอนที่ 5: เทียบกับ blockchain (ตัวตัดสินตัวเดียว)
                const onChain = await contract.getLog(`BLOCK_${block.block_id}`);
                const isAlert = currentHash !== onChain[0];

                if (isAlert) {
                    await pool.execute(
                        `UPDATE audit_ledger 
                         SET is_alert = 1, tamper_first_detected_at = COALESCE(tamper_first_detected_at, NOW()) 
                         WHERE block_id = ?`,
                        [block.block_id]
                    );
                    console.log(`❌ 🚨 SECURITY ALERT: Block #${block.block_id} — master_hash ไม่ตรงกับ Blockchain!`);
                } else {
                    await pool.execute("UPDATE audit_ledger SET is_alert = 0 WHERE block_id = ?", [block.block_id]);
                }

            } catch (error) {
                if (error.message.includes("Block not found")) {
                    console.log(`⏳ Block #${block.block_id} รอการยืนยันบนเชน...`);
                } else if (error.message.includes('timeout') || error.code === 'TIMEOUT') {
                    console.log(`⚠️ Timeout Block #${block.block_id} จะลองใหม่รอบหน้า`);
                } else {
                    console.error(`Audit Error (Block ${block.block_id}):`, error.message);
                }
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    } finally {
        isAuditing = false;
    }
}

// 4. API ส่งข้อมูลให้หน้า Dashboard
app.get('/api/get-status', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;

        const [rows] = await pool.execute(
            "SELECT * FROM audit_ledger ORDER BY block_id DESC LIMIT ? OFFSET ?",
            [String(limit), String(offset)]
        );
        const [countResult] = await pool.execute("SELECT COUNT(*) as total FROM audit_ledger");
        const total = countResult[0].total;

        res.json({
            blocks: rows,
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. API ส่ง Config
app.get('/api/config', (req, res) => {
    res.json({ contractAddress: process.env.CONTRACT_ADDRESS, rpcUrl: process.env.RPC_URL });
});

// 6. เริ่มการทำงาน
initServer().then(() => {
    setInterval(accumulateAndStore, 10000); 
    setInterval(runAudit, 30000); 
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🛡️ Server Running (Port ${PORT}) 🛡️`);
});