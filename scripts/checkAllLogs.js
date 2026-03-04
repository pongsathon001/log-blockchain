require('dotenv').config();
const hre = require("hardhat");

async function main() {
  // ดึง Address จาก .env
  const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
  if (!CONTRACT_ADDRESS) throw new Error("❌ หา CONTRACT_ADDRESS ไม่เจอ");

  // ลองดึงพนักงานคนที่ 1 มาดู
  const logId = "EMP_DB_1"; 

  const [signer] = await hre.ethers.getSigners();
  const LogStorage = await hre.ethers.getContractAt("LogStorage", CONTRACT_ADDRESS, signer);

  try {
    console.log(`🔍 กำลังค้นหาข้อมูล ID: ${logId} ใน Blockchain...`);
    const [hash, timestamp, recorder] = await LogStorage.getLog(logId);
    
    console.log(`\n--- ข้อมูลที่พบสำหรับ ID: ${logId} ---`);
    console.log(`✅ Stored Hash: ${hash}`);
    console.log(`⏱️ Timestamp:   ${new Date(Number(timestamp) * 1000).toLocaleString()}`);
    console.log(`👤 Recorded By: ${recorder}`);
    console.log(`-----------------------------------`);
  } catch (error) {
    console.log(`❌ ไม่พบข้อมูลสำหรับ ID: ${logId} (แปลว่ายังไม่เข้าไปใน Blockchain จริงๆ)`);
  }
}

main().catch((error) => { console.error(error); });