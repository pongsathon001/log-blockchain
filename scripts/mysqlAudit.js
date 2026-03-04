require('dotenv').config(); // ดึงค่าจากไฟล์ .env
const mysql = require('mysql2/promise');
const hre = require("hardhat");
const crypto = require("crypto");

async function main() {
    // 1. ตั้งค่าการเชื่อมต่อ MySQL (ดึงจาก .env)
    const db = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root', 
        password: process.env.DB_PASS || '1234', 
        database: process.env.DB_NAME || 'company_db'
    });

    // 2. ดึง Address จากไฟล์ .env อัตโนมัติ
    const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS; 
    
    if (!CONTRACT_ADDRESS) {
        throw new Error("❌ หา CONTRACT_ADDRESS ไม่เจอ! ตรวจสอบไฟล์ .env ว่ามีค่ายัง");
    }

    const [signer] = await hre.ethers.getSigners();
    const LogStorage = await hre.ethers.getContractAt("LogStorage", CONTRACT_ADDRESS, signer);

    // 3. ดึงข้อมูลจาก MySQL
    const [rows] = await db.execute('SELECT * FROM employees');
    console.log(`🔍 เริ่มการตรวจสอบพนักงานจำนวน ${rows.length} รายการ...`);

    for (const emp of rows) {
        // ทำลายนิ้วมือข้อมูล (Hash) จากข้อมูลใน Database
        const dataString = `${emp.id}${emp.name}${emp.position}${emp.salary}`;
        const currentHash = crypto.createHash("sha256").update(dataString).digest("hex");
        const logId = `EMP_DB_${emp.id}`;

        try {
            // 4. พยายามเรียกดูข้อมูลจาก Blockchain
            const result = await LogStorage.getLog(logId);
            const onChainHash = result[0];

            // 5. ถ้าเจอ ให้เทียบความถูกต้อง
            if (onChainHash !== currentHash) {
                console.log(`❌ [ALERT] ID: ${emp.id} ข้อมูลถูกแก้ไข!`);
                console.log(`   - บน Blockchain: ${onChainHash}`);
                console.log(`   - ใน MySQL:     ${currentHash}`);
            } else {
                console.log(`✅ ID: ${emp.id}: ข้อมูลถูกต้อง`);
            }

        } catch (error) {
            // 6. ถ้ายังไม่มี ID นี้ใน Blockchain (Error: Log not found) ให้บันทึกใหม่
            if (error.message.includes("Log not found") || (error.data && error.data.message.includes("Log not found"))) {
                console.log(`🆕 ไม่พบข้อมูล ID: ${emp.id} บน Chain, กำลังบันทึกครั้งแรก...`);
                const tx = await LogStorage.storeLog(logId, currentHash);
                await tx.wait();
                console.log(`✅ บันทึก ID: ${emp.id} สำเร็จ!`);
            } else {
                console.error(`❗ เกิดข้อผิดพลาดอื่น:`, error.message);
            }
        }
    }

    await db.end();
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});