const hre = require("hardhat");

async function main() {
  const CONTRACT_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
  const logId = "LOG_001"; // ใส่ ID ที่คุณต้องการเช็ค

  const [signer] = await hre.ethers.getSigners();
  const LogStorage = await hre.ethers.getContractAt("LogStorage", CONTRACT_ADDRESS, signer);

  try {
    const [hash, timestamp, recorder] = await LogStorage.getLog(logId);
    console.log(`\n--- Data for ID: ${logId} ---`);
    console.log(`Stored Hash: ${hash}`);
    console.log(`Timestamp:   ${new Date(Number(timestamp) * 1000).toLocaleString()}`);
    console.log(`Recorded By: ${recorder}`);
  } catch (error) {
    console.log(`❌ ไม่พบข้อมูลสำหรับ ID: ${logId}`);
  }
}

main().catch((error) => { console.error(error); });