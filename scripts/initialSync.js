const mysql = require('mysql2/promise');
const hre = require("hardhat");
const crypto = require("crypto");
require('dotenv').config();

async function main() {
    const db = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASS,
        database: process.env.DB_NAME
    });

    const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
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
            // เช็คก่อนว่ามีในระบบหรือยัง
            await LogStorage.getLog(logId);
        } catch (error) {
            // ถ้ายังไม่มี ให้ใส่ใน List เตรียมบันทึก
            idsToStore.push(logId);
            hashesToStore.push(currentHash);
        }
    }

    if (idsToStore.length > 0) {
        console.log(`🚀 กำลังส่ง ${idsToStore.length} รายการขึ้น Blockchain...`);
        const tx = await LogStorage.batchStoreLogs(idsToStore, hashesToStore); // เรียกใช้ฟังก์ชัน Batch
        await tx.wait();
        console.log(`✅ บันทึกข้อมูลพนักงานทั้งหมดสำเร็จ!`);
    } else {
        console.log("ℹ️ ข้อมูลทั้งหมดอยู่ใน Blockchain เรียบร้อยแล้ว");
    }

    await db.end();
}

main().catch((error) => { console.error(error); process.exitCode = 1; });