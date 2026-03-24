const mysql = require('mysql2/promise');
const hre = require("hardhat");
const crypto = require("crypto");
require('dotenv').config();

async function main() {
    // เชื่อมต่อ Database
    const db = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASS || '1234',
        database: process.env.DB_NAME || 'company_db',
        dateStrings: true // สำคัญมาก เพื่อให้เวลาคงที่ตอนทำ Hash
    });

    const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
    if (!CONTRACT_ADDRESS) {
        throw new Error("❌ หา CONTRACT_ADDRESS ไม่เจอ! ตรวจสอบไฟล์ .env ด่วน");
    }

    const [signer] = await hre.ethers.getSigners();
    // ใช้ฟังก์ชัน addLog จาก Contract ตัวใหม่
    const LogStorage = await hre.ethers.getContractAt("LogStorage", CONTRACT_ADDRESS, signer);

    // 1. ดึง Log ทั้งหมดจาก general_log โดยกรอง Log ของระบบ (Loop นรก) ทิ้งไป
    const [rows] = await db.execute(`
        SELECT event_time, user_host, argument 
        FROM mysql.general_log 
        WHERE argument NOT LIKE '%general_log%' 
          AND argument NOT LIKE '%audit_ledger%'
        ORDER BY event_time ASC
    `);
    console.log(`📦 พบ Log ทั้งหมด ${rows.length} รายการ กำลังเริ่มการมัดรวมกลุ่มละ 20...`);

    // 2. วนลูปประมวลผลทีละ 20 รายการ (Chunking)
    for (let i = 0; i < rows.length; i += 20) {
        const chunk = rows.slice(i, i + 20);
        
        // เราจะเก็บเฉพาะก้อนที่ครบ 20 รายการเท่านั้น
        if (chunk.length === 20) {
            const blockNum = (i / 20) + 1;
            console.log(`\n⛓️ กำลังประมวลผล Block #${blockNum} (Logs ${i + 1} - ${i + 20}) และร้อยโซ่ Hash...`);

            // 🌟 ลอจิกการร้อยโซ่ Hash หางต่อหัว 20 รอบ
            let currentHash = "0000000000000000000000000000000000000000000000000000000000000000"; // เริ่มต้นใหม่ทุก Block
            for (let log of chunk) {
                const dataString = `${log.event_time}${log.user_host}${log.argument}${currentHash}`;
                currentHash = crypto.createHash("sha256").update(dataString).digest("hex");
            }

            const masterHash = currentHash; // ตัวที่ 20 จะกลายเป็น Master Hash
            const rawContent = JSON.stringify(chunk);

            try {
                // A. บันทึกลง DB2 (audit_ledger)
                const [result] = await db.execute(
                    "INSERT INTO audit_ledger (sequence_start_time, sequence_end_time, log_count, raw_logs_content, master_hash) VALUES (?, ?, ?, ?, ?)",
                    [chunk[0].event_time, chunk[19].event_time, 20, rawContent, masterHash]
                );

                // B. ส่ง Master Hash ขึ้น Blockchain
                const blockId = `BLOCK_${result.insertId}`;
                console.log(`🚀 ส่ง ${blockId} ขึ้น Blockchain...`);
                
                const tx = await LogStorage.addLog(blockId, masterHash);
                await tx.wait();

                console.log(`✅ สำเร็จ: ${blockId} | TX: ${tx.hash}`);
            } catch (err) {
                console.error(`❌ ผิดพลาดที่ Block #${blockNum}:`, err.message);
            }
        } else {
            console.log(`\n⚠️ เศษที่เหลือ ${chunk.length} รายการ จะถูกประมวลผลโดย server.js เมื่อมี Log ใหม่เข้ามาครบ 20`);
        }
    }

    console.log(`\n✨ Initial Sync เสร็จสมบูรณ์! ข้อมูลเก่าถูกร้อยโซ่และประทับตราบน Blockchain เรียบร้อย`);
    await db.end();
}

main().catch((error) => { 
    console.error("❌ เกิดข้อผิดพลาดร้ายแรง:", error); 
    process.exitCode = 1; 
});