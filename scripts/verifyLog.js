const hre = require("hardhat");
const fs = require("fs");
const crypto = require("crypto");

async function main() {
  const CONTRACT_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
  const logId = "LOG_001";

  // 1. อ่านไฟล์และทำ Hash
  const currentContent = fs.readFileSync("app.log", "utf8");
  const currentHash = crypto.createHash("sha256").update(currentContent).digest("hex");

  // --- ส่วนที่แก้ไข ---
  // ดึง Signer (กระเป๋าเงิน) มาก่อนเพื่อให้ ethers ทำงานได้สมบูรณ์
  const [signer] = await hre.ethers.getSigners();
  
  // ใช้ getContractAt โดยส่ง signer เข้าไปด้วย
  const LogStorage = await hre.ethers.getContractAt("LogStorage", CONTRACT_ADDRESS, signer);
  // ------------------

  // 2. ดึงข้อมูลจาก Blockchain
  console.log("🔍 Fetching data from Blockchain...");
  const result = await LogStorage.getLog(logId);
  const originalHash = result[0];
  const timestamp = result[1];

  console.log(`\n--- Log Verification Report ---`);
  console.log(`Original Hash: ${originalHash}`);
  console.log(`Current Hash:  ${currentHash}`);

  if (originalHash === currentHash) {
    console.log("✅ RESULT: Log is VALID. No manipulation detected.");
  } else {
    console.log("❌ ALERT: LOG MANIPULATION DETECTED!");
    // แปลงเวลาจาก Unix Timestamp เป็นภาษาไทย
    const date = new Date(Number(timestamp) * 1000).toLocaleString('th-TH');
    console.log(`บันทึกไว้เมื่อ: ${date}`);
  }
}

main().catch((error) => {
  console.error("❌ Error:", error.message);
});