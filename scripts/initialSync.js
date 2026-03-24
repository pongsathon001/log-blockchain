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
        dateStrings: true 
    });

    const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
    if (!CONTRACT_ADDRESS) {
        throw new Error("❌ หา CONTRACT_ADDRESS ไม่เจอ! ตรวจสอบไฟล์ .env ด่วน");
    }

    // 🌟 [แก้ปัญหา Hardhat ดื้อ] บังคับใส่ ABI ใหม่เข้าไปตรงๆ เลย
    const [signer] = await hre.ethers.getSigners();
    const abi = [
        "function addLog(string memory _id, string memory _hash) public",
        "function getLog(string memory _id) public view returns (string memory, uint256, address)"
    ];
    const LogStorage = new hre.ethers.Contract(CONTRACT_ADDRESS, abi, signer);

    // 1. ดึง Log ทั้งหมดจาก general_log โดยกรอง Log ของระบบทิ้งไป
    const [rows] = await db.execute(`
        SELECT event_time, user_host, argument 
        FROM mysql.general_log 
        WHERE argument NOT LIKE '%general_log%' 
          AND argument NOT LIKE '%audit_ledger%'
        ORDER BY event_time ASC
    `);
    console.log(`📦 พบ Log ทั้งหมด ${rows.length} รายการ กำลังเริ่มการมัดรวมกลุ่มละ 20...`);

    // 2. วนลูปประมวลผลทีละ 20 รายการ (Inter-block Chaining)
    let prevMasterHash = "0000000000000000000000000000000000000000000000000000000000000000";
    
    for (let i = 0; i < rows.length; i += 20) {
        const chunk = rows.slice(i, i + 20);
        
        if (chunk.length === 20) {
            const blockNum = (i / 20) + 1;
            console.log(`\n⛓️ กำลังประมวลผล Block #${blockNum} (Logs ${i + 1} - ${i + 20}) และร้อยโซ่ Hash...`);

            // ลอจิกการร้อยโซ่ Hash โดยใช้ master_hash ของ block ก่อนหน้าเป็น seed
            let currentHash = prevMasterHash;
            for (let log of chunk) {
                const dataString = `${log.event_time}${log.user_host}${log.argument}${currentHash}`;
                currentHash = crypto.createHash("sha256").update(dataString).digest("hex");
            }

            const masterHash = currentHash; 
            const rawContent = JSON.stringify(chunk);

            try {
                // บันทึกลง DB
                const [result] = await db.execute(
                    "INSERT INTO audit_ledger (sequence_start_time, sequence_end_time, log_count, raw_logs_content, master_hash) VALUES (?, ?, ?, ?, ?)",
                    [chunk[0].event_time, chunk[19].event_time, 20, rawContent, masterHash]
                );

                // ส่ง Master Hash ขึ้น Blockchain
                const blockId = `BLOCK_${result.insertId}`;
                console.log(`🚀 ส่ง ${blockId} ขึ้น Blockchain...`);
                
                const tx = await LogStorage.addLog(blockId, masterHash);
                await tx.wait();

                console.log(`✅ สำเร็จ: ${blockId} | TX: ${tx.hash}`);
                prevMasterHash = masterHash; // อัปเดต seed สำหรับ block ถัดไป
            } catch (err) {
                console.error(`❌ ผิดพลาดที่ Block #${blockNum}:`, err.message);
                // ถ้า blockchain fail ลบข้อมูลออกจาก DB
                try { await db.execute("DELETE FROM audit_ledger WHERE master_hash = ?", [masterHash]); } catch {}
                break; // หยุดเพราะ chain จะเสีย
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