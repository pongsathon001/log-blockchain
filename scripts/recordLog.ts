import hre from "hardhat";
const ethers = hre.ethers;
import * as fs from "fs";
import * as crypto from "crypto";

async function main() {
  // 1. อ่านไฟล์ Log และสร้าง Hash (SHA-256)
  const logContent = fs.readFileSync("app.log", "utf8");
  const logHash = crypto.createHash("sha256").update(logContent).digest("hex");
  const logId = "LOG_001"; // ตั้งชื่อ ID ให้ Log ชุดนี้

  console.log(`📄 Log Content Hash: ${logHash}`);

  // 2. ระบุ Address ของ Contract (เอาเลขที่ได้จากการ Deploy ครั้งก่อนมาใส่)
  // ถ้ายังไม่ได้ Deploy ให้รัน npx hardhat node และ npx hardhat run scripts/deploy.ts --network localhost ก่อน
  const CONTRACT_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3"; 
  
  const LogStorage = await ethers.getContractAt("LogStorage", CONTRACT_ADDRESS);

  // 3. ส่ง Hash ขึ้น Blockchain
  console.log("🚀 Sending hash to Blockchain...");
  const tx = await LogStorage.storeLog(logId, logHash);
  await tx.wait(); // รอจนกว่า Transaction จะสำเร็จ

  console.log("✅ Log recorded on Blockchain successfully!");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});