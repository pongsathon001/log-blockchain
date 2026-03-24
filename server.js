require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const { ethers } = require('ethers');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// ตั้งค่า Database
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    dateStrings: true 
};

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
    const db = await mysql.createConnection(dbConfig);
    const [rows] = await db.execute("SELECT sequence_end_time FROM audit_ledger ORDER BY block_id DESC LIMIT 1");
    if (rows.length > 0) lastProcessedTime = rows[0].sequence_end_time;
    console.log(`🕒 ระบบพร้อม! เริ่มเฝ้าระวัง Log ใหม่ต่อจากเวลา: ${lastProcessedTime}`);
    await db.end();
}

// 2. ฟังก์ชันมัดรวม 20 Logs และร้อยโซ่ Hash (Intra-block Hash Chaining)
async function accumulateAndStore() {
    if (isProcessingLogs) return; 
    const db = await mysql.createConnection(dbConfig);
    try {
        isProcessingLogs = true;
        const [logs] = await db.execute(
            `SELECT event_time, user_host, argument FROM mysql.general_log 
             WHERE event_time > ? AND argument NOT LIKE '%general_log%' AND argument NOT LIKE '%audit_ledger%' 
             ORDER BY event_time ASC LIMIT 20`, [lastProcessedTime]
        );

        if (logs.length === 20) {
            console.log("\n📦 พบ Log ใหม่ครบ 20 รายการ กำลังร้อยโซ่ Hash ภายใน Block...");
            
            // 🌟 ลอจิกการร้อยโซ่ 20 รอบ
            let currentHash = "0000000000000000000000000000000000000000000000000000000000000000"; 
            for (let log of logs) {
                const dataString = `${log.event_time}${log.user_host}${log.argument}${currentHash}`;
                currentHash = crypto.createHash('sha256').update(dataString).digest('hex');
            }
            
            const masterHash = currentHash; // ตัวที่ 20 กลายเป็น Master Hash
            const rawContent = JSON.stringify(logs);

            const [result] = await db.execute(
                "INSERT INTO audit_ledger (sequence_start_time, sequence_end_time, log_count, raw_logs_content, master_hash) VALUES (?, ?, ?, ?, ?)",
                [logs[0].event_time, logs[19].event_time, 20, rawContent, masterHash]
            );

            const blockId = `BLOCK_${result.insertId}`;
            console.log(`🚀 กำลังส่ง ${blockId} ขึ้น Blockchain... (รอคอนเฟิร์ม)`);
            const tx = await contract.addLog(blockId, masterHash);
            await tx.wait(); 
            console.log(`✅ ${blockId} บันทึกลง Blockchain สำเร็จ!`);
            lastProcessedTime = logs[19].event_time; 
        }
    } finally {
        isProcessingLogs = false;
        await db.end();
    }
}

// 3. ฟังก์ชันตรวจสอบความถูกต้อง (Audit)
async function runAudit() {
    if (isAuditing) return;
    const db = await mysql.createConnection(dbConfig);
    try {
        isAuditing = true;
        const [blocks] = await db.execute("SELECT * FROM audit_ledger ORDER BY block_id DESC LIMIT 10");
        
        for (let block of blocks) {
            // 🌟 ร้อยโซ่ Hash ใหม่จากข้อมูลดิบ เพื่อเทียบกับของจริง
            const parsedLogs = JSON.parse(block.raw_logs_content);
            let checkHash = "0000000000000000000000000000000000000000000000000000000000000000";
            
            for (let log of parsedLogs) {
                const dataString = `${log.event_time}${log.user_host}${log.argument}${checkHash}`;
                checkHash = crypto.createHash('sha256').update(dataString).digest('hex');
            }

            try {
                const onChain = await contract.getLog(`BLOCK_${block.block_id}`);
                const isAlert = checkHash !== onChain[0];
                await db.execute("UPDATE audit_ledger SET is_alert = ? WHERE block_id = ?", [isAlert, block.block_id]);
            } catch (error) {
                if (error.message.includes("Block not found")) console.log(`⏳ Block #${block.block_id} รอการยืนยันบนเชน...`);
            }
        }
    } finally {
        isAuditing = false;
        await db.end();
    }
}

// 4. API ส่งข้อมูลให้หน้า Dashboard
app.get('/api/get-status', async (req, res) => {
    const db = await mysql.createConnection(dbConfig);
    try {
        const [rows] = await db.execute("SELECT * FROM audit_ledger ORDER BY block_id DESC LIMIT 20");
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        await db.end();
    }
});

// 5. API ส่ง Config
app.get('/api/config', (req, res) => {
    res.json({ contractAddress: process.env.CONTRACT_ADDRESS, rpcUrl: process.env.RPC_URL });
});

// เริ่มทำงาน
initServer().then(() => {
    setInterval(accumulateAndStore, 10000); 
    setInterval(runAudit, 20000); 
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🛡️ Server Running (Port ${PORT}) 🛡️`);
    console.log(`Mode: Block Aggregation (20 logs) + Intra-block Hash Chaining`);
});