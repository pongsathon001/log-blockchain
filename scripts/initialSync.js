const mysql = require('mysql2/promise');
const hre = require("hardhat");
const crypto = require("crypto");
require('dotenv').config();

async function main() {
    // 1. เพิ่ม Fallback ให้กับ Database เผื่อไฟล์ .env อ่านค่าไม่ได้
    const db = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASS || '1234',
        database: process.env.DB_NAME || 'company_db'
    });

    // 2. ดึง Contract Address จาก .env
    const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
    if (!CONTRACT_ADDRESS) {
        throw new Error("❌ หา CONTRACT_ADDRESS ไม่เจอ! ตรวจสอบไฟล์ .env ด่วน");
    }

    const [signer] = await hre.ethers.getSigners();
    const LogStorage = await hre.ethers.getContractAt("LogStorage", CONTRACT_ADDRESS, signer);

    const [rows] = await db.execute('SELECT * FROM employees');
    console.log(`📦 เตรียมบันทึกพนักงานจำนวน ${rows.length} รายการแบบ Batch...`);

    let idsToStore = [];
    let hashesToStore = [];

    for (const emp of rows) {
        const dataString = `${emp.id}${emp.name}${emp.position}${emp.salary}`;
        const currentHash = crypto.createHash("sha256").update(dataString).digest("hex");
        const logId = `EMP_DB_${emp.id}`;

        try {
            // เช็คก่อนว่ามีในระบบหรือยัง โดยดึงค่า Hash มาดู
            const [onChainHash] = await LogStorage.getLog(logId);
            
            // 💡 ถ้าค่าที่ดึงมาว่างเปล่า (Empty String) แปลว่ายังไม่เคยบันทึก
            if (!onChainHash || onChainHash === "") {
                idsToStore.push(logId);
                hashesToStore.push(currentHash);
            }
        } catch (error) {
            // เผื่อไว้กรณี Blockchain โยน Error กลับมา ก็ให้ถือว่ายังไม่มีข้อมูลเช่นกัน
            idsToStore.push(logId);
            hashesToStore.push(currentHash);
        }
    }

    if (idsToStore.length > 0) {
        console.log(`🚀 กำลังส่ง ${idsToStore.length} รายการขึ้น Blockchain...`);
        const tx = await LogStorage.batchStoreLogs(idsToStore, hashesToStore); // เรียกใช้ฟังก์ชัน Batch
        await tx.wait(); // รอจนกว่านักขุดจะยืนยันข้อมูล
        console.log(`✅ บันทึกข้อมูลพนักงานทั้งหมดสำเร็จ!`);
    } else {
        console.log("ℹ️ ข้อมูลทั้งหมดอยู่ใน Blockchain เรียบร้อยแล้ว");
    }

    await db.end();
}

main().catch((error) => { console.error(error); process.exitCode = 1; });