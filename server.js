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
        const [logs] = await pool.execute(
            `SELECT event_time, user_host, argument FROM mysql.general_log 
             WHERE event_time >= ? AND argument NOT LIKE '%general_log%' AND argument NOT LIKE '%audit_ledger%' 
             ORDER BY event_time ASC`, [lastProcessedTime]
        );

        // ตัด log ที่เคยประมวลผลไปแล้ว (กรณี event_time ซ้ำกับ lastProcessedTime)
        const [processed] = await pool.execute(
            "SELECT raw_logs_content FROM audit_ledger WHERE sequence_end_time = ? ORDER BY block_id DESC LIMIT 1",
            [lastProcessedTime]
        );
        let filteredLogs = logs;
        if (processed.length > 0 && lastProcessedTime !== '1970-01-01 00:00:00') {
            const lastProcessedLogs = JSON.parse(processed[0].raw_logs_content);
            const lastLogArg = lastProcessedLogs[lastProcessedLogs.length - 1].argument;
            const startIdx = logs.findIndex((l, i) => 
                l.event_time === lastProcessedTime && l.argument === lastLogArg
            );
            if (startIdx !== -1) {
                filteredLogs = logs.slice(startIdx + 1);
            }
        }

        // ตัดเอาแค่ 20 ตัวแรก
        const chunk = filteredLogs.slice(0, 20);

        if (chunk.length === 20) {
            console.log("\n📦 พบ Log ใหม่ครบ 20 รายการ กำลังร้อยโซ่ Hash ภายใน Block...");

            // Inter-block Chaining: ดึง master_hash ของ block ก่อนหน้ามาเป็น seed
            const [prevBlock] = await pool.execute("SELECT master_hash FROM audit_ledger ORDER BY block_id DESC LIMIT 1");
            let currentHash = prevBlock.length > 0 
                ? prevBlock[0].master_hash 
                : "0000000000000000000000000000000000000000000000000000000000000000";

            // ลอจิกร้อยโซ่ 20 รอบ (Intra-block Hash Chaining)
            for (let log of chunk) {
                const dataString = `${log.event_time}${log.user_host}${log.argument}${currentHash}`;
                currentHash = crypto.createHash('sha256').update(dataString).digest('hex');
            }

            const masterHash = currentHash;
            const rawContent = JSON.stringify(chunk);

            // INSERT ลง DB ก่อน
            const [result] = await pool.execute(
                "INSERT INTO audit_ledger (sequence_start_time, sequence_end_time, log_count, raw_logs_content, master_hash) VALUES (?, ?, ?, ?, ?)",
                [chunk[0].event_time, chunk[19].event_time, 20, rawContent, masterHash]
            );

            const blockId = `BLOCK_${result.insertId}`;
            console.log(`🚀 กำลังส่ง ${blockId} ขึ้น Blockchain... (รอคอนเฟิร์ม)`);

            try {
                const tx = await contract.addLog(blockId, masterHash);
                await tx.wait();
                console.log(`✅ ${blockId} บันทึกลง Blockchain สำเร็จ!`);
            } catch (bcError) {
                // Blockchain fail → ลบข้อมูลออกจาก DB เพื่อลองใหม่รอบหน้า
                await pool.execute("DELETE FROM audit_ledger WHERE block_id = ?", [result.insertId]);
                console.error(`❌ Blockchain fail! ลบ ${blockId} ออกจาก DB แล้ว จะลองใหม่รอบหน้า:`, bcError.message);
                return;
            }

            lastProcessedTime = chunk[19].event_time;
        }
    } catch (error) {
        console.error("❌ accumulateAndStore Error:", error.message);
    } finally {
        isProcessingLogs = false;
    }
}

// 3. ระบบ Audit แบบเช็ค Hash ตรงๆ กับ Blockchain (ตัดขั้นที่ 1 ออก)
async function runAudit() {
    if (isAuditing) return;
    try {
        isAuditing = true;
        // ดึงเฉพาะ Block ล่าสุด 10 อันมาตรวจ
        const [blocks] = await pool.execute("SELECT * FROM audit_ledger ORDER BY block_id DESC LIMIT 10");

        for (let block of blocks) {
            try {
                // เทียบ Hash ในฐานข้อมูล (block.master_hash) กับ Blockchain (onChain[0]) โดยตรง
                const onChain = await contract.getLog(`BLOCK_${block.block_id}`);
                const isAlert = block.master_hash !== onChain[0];

                // อัปเดตสถานะลง DB ให้หน้าเว็บ Dashboard รับรู้
                await pool.execute("UPDATE audit_ledger SET is_alert = ? WHERE block_id = ?", [isAlert, block.block_id]);

                // แจ้งเตือนบน Terminal กรณีถูกดัดแปลง
                if (isAlert) {
                    console.log(`❌ 🚨 SECURITY ALERT: Block #${block.block_id} ข้อมูลไม่ตรงกับ Blockchain!`);
                }

            } catch (error) {
                if (error.message.includes("Block not found")) {
                    console.log(`⏳ Block #${block.block_id} รอการยืนยันบนเชน...`);
                } else if (error.code === 'TIMEOUT' || error.message.includes('timeout')) {
                    console.log(`⚠️ การเชื่อมต่อช้าสำหรับ Block #${block.block_id} (Timeout) จะลองใหม่รอบหน้า`);
                } else {
                    console.error("Audit Check Error:", error.message);
                }
            }

            // หน่วงเวลา 1 วินาที ป้องกัน RPC ตัดการเชื่อมต่อ (แก้ปัญหา Timeout)
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    } finally {
        isAuditing = false;
    }
}

// 4. API ส่งข้อมูลให้หน้า Dashboard (รองรับ Pagination)
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

// 5. API ส่ง Config ให้ Frontend
app.get('/api/config', (req, res) => {
    res.json({ contractAddress: process.env.CONTRACT_ADDRESS, rpcUrl: process.env.RPC_URL });
});

// 6. เริ่มการทำงานของ Server
initServer().then(() => {
    setInterval(accumulateAndStore, 10000); // เช็ค Log ใหม่ทุก 10 วิ
    setInterval(runAudit, 30000);           // ตรวจสอบความถูกต้องทุก 30 วิ
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🛡️ Server Running (Port ${PORT}) 🛡️`);
    console.log(`Mode: Direct Audit (Intra-block Chaining | No Line Notify)`);
});