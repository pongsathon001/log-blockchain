const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const app = express();

app.use(cors());

app.get('/api/employees', async (req, res) => {
    const db = await mysql.createConnection({
        host: 'localhost', user: 'root', password: '1234', database: 'company_db'
    });
    const [rows] = await db.execute('SELECT * FROM employees');
    await db.end();
    res.json(rows);
});

app.listen(3000, () => console.log('🚀 API Server running at http://localhost:3000'));