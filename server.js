require('dotenv').config(); 
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const app = express();

app.use(cors());

// 👇 [ส่วนที่เพิ่มใหม่] สร้าง API ให้หน้าเว็บมาดึง Contract Address จาก .env
app.get('/api/config', (req, res) => {
    res.json({ contractAddress: process.env.CONTRACT_ADDRESS });
});

app.get('/api/employees', async (req, res) => {
    try {
        const db = await mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASS,
            database: process.env.DB_NAME
        });
        const [rows] = await db.execute('SELECT * FROM employees');
        await db.end();
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(3000, () => console.log('🚀 API Server running at http://localhost:3000'));