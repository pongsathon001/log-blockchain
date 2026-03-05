const { spawn, execSync } = require('child_process');

console.log("🚀 กำลังสตาร์ทระบบ Blockchain Security ทั้งหมด... รอสักครู่นะครับ\n");

// 1. เปิด Blockchain (npx hardhat node)
const blockchainNode = spawn('npx', ['hardhat', 'node'], { shell: true });

// ดักจับข้อความจาก Hardhat Node เพื่อรอดูว่ามันเปิดเสร็จหรือยัง
blockchainNode.stdout.on('data', (data) => {
    const output = data.toString();
    
    // ถ้า Node เปิดสำเร็จ มันจะขึ้นคำว่า "Started HTTP and WebSocket JSON-RPC server"
    if (output.includes('Started HTTP and WebSocket JSON-RPC server')) {
        console.log("✅ [1/4] สร้าง Local Blockchain สำเร็จ!");
        
        try {
            // 2. สั่ง Deploy Contract
            console.log("⏳ [2/4] กำลัง Deploy Smart Contract...");
            execSync('npx hardhat run scripts/deploy.js --network localhost', { stdio: 'inherit' });
            
            // 3. ยัดข้อมูล MySQL ลง Blockchain
            console.log("\n⏳ [3/4] กำลังซิงค์ข้อมูลลง Blockchain...");
            execSync('npx hardhat run scripts/initialSync.js --network localhost', { stdio: 'inherit' });
            
            // 4. เปิด API Server หลังบ้าน
            console.log("\n⏳ [4/4] กำลังเปิด API Server...");
            const server = spawn('node', ['server.js'], { shell: true, stdio: 'inherit' });

            console.log("\n🎉=======================================🎉");
            console.log("   ระบบทั้งหมดพร้อมใช้งานแล้ว 100%!");
            console.log("   👉 เปิดหน้าเว็บ dashboard.html ได้เลยครับ");
            console.log("🎉=======================================🎉\n");
            console.log("(กด Ctrl + C สองครั้ง เพื่อปิดระบบทั้งหมดเมื่อเลิกใช้งาน)");

        } catch (error) {
            console.error("❌ เกิดข้อผิดพลาดระหว่างรันระบบ:", error.message);
            blockchainNode.kill();
            process.exit(1);
        }
    }
});

// ดักจับ Error เผื่อ Hardhat รันไม่ได้
blockchainNode.stderr.on('data', (data) => {
    console.error(`Error: ${data}`);
});

// เมื่อกด Ctrl+C ให้ปิดทุกอย่างทิ้งให้หมด
process.on('SIGINT', () => {
    console.log("\n🛑 กำลังปิดระบบทั้งหมด...");
    blockchainNode.kill();
    process.exit();
});