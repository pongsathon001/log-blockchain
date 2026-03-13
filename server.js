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
    "function batchStoreChain(string[] memory _logIds, string[] memory _logHashes) public",
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

// 1. Logic การ Update (ตรวจสอบ -> แก้ไข -> ร้อยโซ่ใหม่ทุกคน)
app.post('/api/employees/update', async (req, res) => {
    const { id, name, position, salary } = req.body;
    const db = await getDB();
    
    try {
        // [STEP A] ตรวจสอบ Integrity
        const [rows] = await db.execute('SELECT * FROM employees WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ error: "ไม่พบข้อมูล" });
        
        const emp = rows[0];
        try {
            const [onChainHash] = await contract.getLog(`EMP_DB_${id}`);
            if (onChainHash !== emp.stored_hash) {
                return res.status(403).json({ error: "❌ ตรวจพบการบุกรุก! ข้อมูลใน DB ไม่ตรงกับ Blockchain ห้ามแก้ไข" });
            }
        } catch (e) {
            // ปล่อยผ่านถ้ายังไม่เคยมีบนเชน
        }

        // [STEP B] บันทึกค่าใหม่ลง MySQL
        await db.execute('UPDATE employees SET name=?, position=?, salary=? WHERE id=?', [name, position, salary, id]);

        // [STEP C] ดึงข้อมูลทุกคนมาร้อยโซ่ใหม่ (Hash Chain)
        const [allEmployees] = await db.execute('SELECT * FROM employees ORDER BY id ASC');
        let idsToStore = [];
        let hashesToStore = [];
        let previousHash = "0000000000000000000000000000000000000000000000000000000000000000";

        for (const employee of allEmployees) {
            const dataString = `${employee.id}${employee.name}${employee.position}${employee.salary}${previousHash}`;
            const currentHash = crypto.createHash("sha256").update(dataString).digest("hex");
            
            idsToStore.push(`EMP_DB_${employee.id}`);
            hashesToStore.push(currentHash);
            
            await db.execute('UPDATE employees SET stored_hash = ? WHERE id = ?', [currentHash, employee.id]);
            previousHash = currentHash;
        }

        // [STEP D] ส่งแบบมัดรวมขึ้น Blockchain
        const tx = await contract.batchStoreChain(idsToStore, hashesToStore);
        await tx.wait();

        // [STEP E] เก็บประวัติ
        const newRoot = await contract.lastRootHash();
        await db.execute('INSERT INTO security_logs (action, employee_id, details, action_hash) VALUES (?, ?, ?, ?)', 
            ['UPDATE', id, `Updated salary to ${salary}`, newRoot]);

        res.json({ success: true, txHash: tx.hash, message: "✅ อัปเดตและร้อยโซ่ใหม่เรียบร้อย!" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    } finally { await db.end(); }
});

// 2. Logic การลบ
app.post('/api/employees/delete', async (req, res) => {
    const { id } = req.body;
    const db = await getDB();

    try {
        const [rows] = await db.execute('SELECT stored_hash FROM employees WHERE id = ?', [id]);
        if (rows.length > 0) {
            try {
                const [onChainHash] = await contract.getLog(`EMP_DB_${id}`);
                if (onChainHash !== rows[0].stored_hash) {
                    return res.status(403).json({ error: "❌ ข้อมูลใน DB ถูกดัดแปลงอยู่! ห้ามลบ" });
                }
            } catch (e) {}
        }

        await db.execute('DELETE FROM employees WHERE id = ?', [id]);

        const [allEmployees] = await db.execute('SELECT * FROM employees ORDER BY id ASC');
        let idsToStore = [];
        let hashesToStore = [];
        let previousHash = "0000000000000000000000000000000000000000000000000000000000000000";

        for (const employee of allEmployees) {
            const dataString = `${employee.id}${employee.name}${employee.position}${employee.salary}${previousHash}`;
            const currentHash = crypto.createHash("sha256").update(dataString).digest("hex");
            
            idsToStore.push(`EMP_DB_${employee.id}`);
            hashesToStore.push(currentHash);
            
            await db.execute('UPDATE employees SET stored_hash = ? WHERE id = ?', [currentHash, employee.id]);
            previousHash = currentHash;
        }

        let txHash = null;
        if (idsToStore.length > 0) {
            const tx = await contract.batchStoreChain(idsToStore, hashesToStore);
            await tx.wait();
            txHash = tx.hash;
        } else {
            const emptyHash = crypto.createHash("sha256").update("EMPTY_DB").digest("hex");
            const tx = await contract.storeChainLog(`DB_CLEARED_${Date.now()}`, emptyHash);
            await tx.wait();
            txHash = tx.hash;
        }

        const newRoot = idsToStore.length > 0 ? await contract.lastRootHash() : "EMPTY_CHAIN";
        await db.execute('INSERT INTO security_logs (action, employee_id, details, action_hash) VALUES (?, ?, ?, ?)', 
            ['DELETE', id, `Deleted employee ${id}`, newRoot]);

        res.json({ success: true, txHash: txHash, message: "✅ ลบและร้อยโซ่ใหม่เรียบร้อย!" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    } finally { await db.end(); }
});

// 3. API ดึงข้อมูลพนักงาน (ใช้โชว์ตาราง)
app.get('/api/employees', async (req, res) => {
    const db = await getDB();
    const [rows] = await db.execute('SELECT * FROM employees ORDER BY id ASC');
    await db.end();
    res.json(rows);
});

// 4. 🔥 API ดึง Config ที่หายไป!
app.get('/api/config', (req, res) => {
    res.json({
        contractAddress: process.env.CONTRACT_ADDRESS,
        rpcUrl: process.env.RPC_URL
    });
});

app.listen(3000, () => console.log("🚀 Server running on port 3000 (Original Chain Mode)"));