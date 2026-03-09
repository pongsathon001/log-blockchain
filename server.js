const express = require('express');
const mysql = require('mysql2/promise');
const { ethers } = require('ethers');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(require('cors')());

// ตั้งค่า Blockchain Connection
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const abi = [
    "function storeChainLog(string memory _logId, string memory _newHash) public",
    "function lastRootHash() public view returns (string memory)",
    "function getLog(string memory _logId) public view returns (string memory, uint256, address, uint256)"
];
const contract = new ethers.Contract(process.env.CONTRACT_ADDRESS, abi, signer);

async function getDB() {
    return await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASS,
        database: process.env.DB_NAME
    });
}

// 1. Logic การ Update (Verify-before-Update)
app.post('/api/employees/update', async (req, res) => {
    const { id, name, position, salary } = req.body;
    const db = await getDB();
    
    try {
        // [STEP A] ตรวจสอบ Integrity ปัจจุบันก่อน
        const [rows] = await db.execute('SELECT * FROM employees WHERE id = ?', [id]);
        const emp = rows[0];
        
        const [onChainHash] = await contract.getLog(`EMP_DB_${id}`);
        if (onChainHash !== emp.stored_hash) {
            return res.status(403).json({ error: "❌ ตรวจพบการบุกรุก! ข้อมูลใน DB ไม่ตรงกับ Blockchain ห้ามแก้ไข" });
        }

        // [STEP B] บันทึกค่าใหม่ลง MySQL
        await db.execute('UPDATE employees SET name=?, position=?, salary=? WHERE id=?', [name, position, salary, id]);

        // [STEP C] คำนวณ Hash ใหม่เพื่อต่อโซ่
        const previousHash = await contract.lastRootHash();
        const dataString = `${id}${name}${position}${salary}${previousHash}`;
        const newHash = crypto.createHash("sha256").update(dataString).digest("hex");

        // [STEP D] ส่งขึ้น Blockchain
        const tx = await contract.storeChainLog(`EMP_DB_${id}`, newHash);
        await tx.wait();

        // [STEP E] อัปเดต Hash ใหม่กลับลง MySQL และเก็บประวัติ
        await db.execute('UPDATE employees SET stored_hash = ? WHERE id = ?', [newHash, id]);
        await db.execute('INSERT INTO security_logs (action, employee_id, details, action_hash) VALUES (?, ?, ?, ?)', 
            ['UPDATE', id, `Updated to ${salary}`, newHash]);

        res.json({ success: true, txHash: tx.hash });
    } catch (error) {
        res.status(500).json({ error: error.message });
    } finally { await db.end(); }
});

// 2. Logic การลบ (วิธีที่ 2: Transaction Logging)
app.post('/api/employees/delete', async (req, res) => {
    const { id } = req.body;
    const db = await getDB();

    try {
        // [STEP A] สร้าง Action Hash เพื่อเป็นพยานในการลบ
        const previousHash = await contract.lastRootHash();
        const actionString = `DELETE_ID_${id}_${previousHash}`;
        const deleteHash = crypto.createHash("sha256").update(actionString).digest("hex");

        // [STEP B] บันทึก "หลักฐานการลบ" ลง Blockchain
        // ใช้ ID พิเศษเพื่อให้รู้ว่าเป็น Log ของการลบ
        const tx = await contract.storeChainLog(`DEL_LOG_${id}_${Date.now()}`, deleteHash);
        await tx.wait();

        // [STEP C] ลบข้อมูลออกจาก MySQL และบันทึกประวัติพยาน
        await db.execute('DELETE FROM employees WHERE id = ?', [id]);
        await db.execute('INSERT INTO security_logs (action, employee_id, details, action_hash) VALUES (?, ?, ?, ?)', 
            ['DELETE', id, `Deleted employee ${id}`, deleteHash]);

        res.json({ success: true, txHash: tx.hash });
    } catch (error) {
        res.status(500).json({ error: error.message });
    } finally { await db.end(); }
});

// API อื่นๆ (ดึงข้อมูลพนักงาน)
app.get('/api/employees', async (req, res) => {
    const db = await getDB();
    const [rows] = await db.execute('SELECT * FROM employees ORDER BY id ASC');
    await db.end();
    res.json(rows);
});

app.listen(3000, () => console.log("🚀 Server running on port 3000"));