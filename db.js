const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: 'postgres',           // Aapka default username
    host: 'localhost',          // Aapka host
    database: 'kheloindia_db',        // Aapka database naam
    password: '12345',          // Aapka password (string format mein)
    port: 5432,                 // PostgreSQL port
    ssl: false                  // Local ke liye false
});

// Connection test
pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Connection Failed:', err.message);
    } else {
        console.log('✅ Database connected successfully with manual password!');
        release();
    }
});

module.exports = pool;