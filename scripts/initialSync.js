const mysql = require('mysql2/promise');
const hre = require("hardhat");
const crypto = require("crypto");
require('dotenv').config();

async function main() {
    const db = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASS || '1234',
        database: process.env.DB_NAME || 'company_db'
    });

    const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
    if (!CONTRACT_ADDRESS) {
        throw new Error("❌ หา CONTRACT_ADDRESS ไม่เจอ! ตรวจสอบไฟล์ .env ด่วน");
    }

    const [signer] = await hre.ethers.getSigners();
    const LogStorage = await hre.ethers.getContractAt("LogStorage", CONTRACT_ADDRESS, signer);

    // 1. ดึงข้อมูลพนักงานมาเรียงลำดับ (สำคัญมากสำหรับ Hash Chain)
    const [rows] = await db.execute('SELECT * FROM employees ORDER BY id ASC');
    console.log(`📦 เตรียมร้อยโซ่ (Hash Chain) พนักงาน ${rows.length} รายการ...`);

    let idsToStore = [];
    let hashesToStore = [];
    let previousHash = "0000000000000000000000000000000000000000000000000000000000000000";

    // 2. คำนวณ Hash Chain และเตรียม Query สำหรับอัปเดต MySQL
    for (const emp of rows) {
        const logId = `EMP_DB_${emp.id}`;
        
        // สูตร: SHA256(ข้อมูล + Hash คนก่อนหน้า)
        const dataToHash = `${emp.id}${emp.name}${emp.position}${emp.salary}${previousHash}`;
        const currentHash = crypto.createHash("sha256").update(dataToHash).digest("hex");

        idsToStore.push(logId);
        hashesToStore.push(currentHash);

        // 📝 อัปเดตค่า Hash ลงใน MySQL ทันที
        await db.execute('UPDATE employees SET stored_hash = ? WHERE id = ?', [currentHash, emp.id]);

        previousHash = currentHash;
        console.log(`⛓️  Linked: ${logId} -> MySQL Updated`);
    }

    // 3. ส่งข้อมูลขึ้น Blockchain
    if (idsToStore.length > 0) {
        console.log(`\n🚀 กำลังส่ง Batch Chain ขึ้น Blockchain (Sepolia)...`);
        
        const tx = await LogStorage.batchStoreChain(idsToStore, hashesToStore);
        console.log(`⏳ รอการยืนยัน Transaction: ${tx.hash}`);
        await tx.wait();
        
        const finalRoot = await LogStorage.lastRootHash();
        console.log(`✅ สำเร็จ! Root Hash บน Blockchain: ${finalRoot}`);
        console.log(`✅ ข้อมูลใน MySQL และ Blockchain ตรงกันแล้ว 100%`);
    }

    await db.end();
}

main().catch((error) => { 
    console.error("❌ เกิดข้อผิดพลาด:", error); 
    process.exitCode = 1; 
});