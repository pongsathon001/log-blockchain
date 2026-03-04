require('dotenv').config(); // เพิ่มบรรทัดนี้ที่บนสุด
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const app = express();

app.use(cors());

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