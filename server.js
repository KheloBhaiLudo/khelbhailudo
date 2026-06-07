const express = require('express');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const multer = require('multer');
const uploadNone = multer();
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const cors = require('cors'); 
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Ensure uploads folder exists
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

// Database Connection (Supabase initialization internally handled inside db.js)
const pool = require('./db');

// FIXED: Agar db.js ke andar 'supabase' exported hai toh thik hai, nahi toh collision se bachne ke liye standard check laga diya hai
const supabaseClientInstance = pool.supabase || global.supabase;

// 1. Gmail Transporter Setup
// (Render ke Environment Variables mein GMAIL_USER aur GMAIL_PASS daal dena)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER, 
        pass: process.env.GMAIL_PASS  // Gmail ka 16-digit App Password (normal password nahi)
    }
});


// ========================================================
// 🔒 100% STABLE CORS & PREFLIGHT BYPASS (NO REGEX - NO CRASH)
// ========================================================
const allowedOrigins = [
    'https://khelbhailudo.com',
    'https://www.khelbhailudo.com',
    'https://khelobhailudo.github.io/khelbhailudo/',
    'https://khelobhailudo.github.io/khelbhailudo',
    'https://khelobhailudo.github.io',
    'http://localhost:5500',
    'http://127.0.0.1:5500'
];

// 1. Apply Standard CORS to all standard routes
app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.indexOf(origin) !== -1 || origin.includes('localhost')) {
            callback(null, true);
        } else {
            console.log("Blocked by CORS from origin structure:", origin);
            callback(new Error('Not allowed by CORS infrastructure'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

// 2. 🔥 GLOBAL PREFLIGHT MIDDLEWARE BINDING (Bina Kisi Path ke - Safe Override)
// Yeh method bina kisi custom parameters ke browser ke OPTIONS preflight ko accept kar lega
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (allowedOrigins.indexOf(origin) !== -1 || origin.includes('localhost'))) {
        res.header('Access-Control-Allow-Origin', origin);
        res.header('Access-Control-Allow-Credentials', 'true');
    }
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
    
    // Agar request browser ki preflight OPTIONS request hai, toh yahin se return kar do
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});


// Dynamic Memory Cache Allocation for OTP tracking
const otpStore = {};


// ========================================================
// ⚡ 100% PRODUCTION-READY CASHFREE CREATE ORDER ROUTE
// ========================================================
app.post('/api/payment/create-order', async (req, res) => {
    try {
        const { amount, userId, username, mobileNo } = req.body;

        if (!amount || !userId) {
            return res.status(400).json({ success: false, message: "Amount or User ID missing" });
        }

        // Generate unique dynamic client reference ID
        const uniqueOrderId = `ORD_${Date.now()}_${userId}`;

        // 🔥 PRODUCTION BASE URL CHECK: Cashfree Production Live API Endpoint
        const cashfreeProductionUrl = "https://api.cashfree.com/pg/orders";

        // Structured JSON payload according to Cashfree V3 Production Standard
        const orderPayload = {
            order_amount: parseFloat(amount),
            order_currency: "INR",
            order_id: uniqueOrderId,
            customer_details: {
                customer_id: String(userId),
                customer_name: username || "Ludo Player",
                customer_phone: mobileNo && mobileNo.length === 10 ? mobileNo : "9999999999", // Valid phone bypass fallback
                customer_email: `${userId}@khelbhailudo.com` // Dynamic fake backup email structure
            },
            order_meta: {
                // Tumhara dynamic live webhook return map route
                return_url: "https://khelbhailudo.onrender.com/dashboard.html",
                notify_url: "https://khelbhailudo.onrender.com/api/payment/webhook"
            }
        };

        console.log(`[Production Gateway Initiation]: Requesting order ${uniqueOrderId} for ₹${amount}`);

        // Live AXIOS call token authentication layer
        const gatewayResponse = await axios.post(cashfreeProductionUrl, orderPayload, {
            headers: {
                'x-client-id': process.env.CASHFREE_APP_ID, // Ensure Render Env holds Production APP ID
                'x-client-secret': process.env.CASHFREE_SECRET_KEY, // Ensure Render Env holds Production Secret Key
                'x-api-version': '2023-08-01',
                'Content-Type': 'application/json'
            }
        });

        // Agar Cashfree session successfully allocate kar deta hai
        if (gatewayResponse.data && gatewayResponse.data.payment_session_id) {
            return res.json({
                success: true,
                payment_session_id: gatewayResponse.data.payment_session_id,
                order_id: uniqueOrderId
            });
        } else {
            console.error("Cashfree Empty Payload Allocation Error:", gatewayResponse.data);
            return res.status(500).json({ success: false, message: "Gateway empty payload tracking error" });
        }

    } catch (error) {
        // Log the exact error coming from Cashfree production engine to trace wrong keys
        if (error.response) {
            console.error("🔥 Cashfree API Rejection Logs:", JSON.stringify(error.response.data));
            return res.status(500).json({ 
                success: false, 
                message: `Gateway Setup Error: ${error.response.data.message || 'Authentication Failed'}` 
            });
        }
        console.error("Critical Internal Server Error:", error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
});


// ========================================================
// 1. ⚡ CASHFREE WEBHOOK ROUTE (TRANSACTIONS HISTORY SYNC)
// ========================================================
app.post('/api/payment/webhook', async (req, res) => {
    try {
        console.log("=== RAW WEBHOOK BODY RECEIVED ===", JSON.stringify(req.body));

        const webhookData = req.body.data || req.body;
        if (!webhookData || (!webhookData.order && !webhookData.order_id)) {
            return res.status(400).send("Invalid Webhook Structure");
        }

        const orderInfo = webhookData.order || webhookData;
        const paymentInfo = webhookData.payment || webhookData;

        const orderStatus = orderInfo.order_status || orderInfo.txStatus;
        const paymentStatus = paymentInfo.payment_status || orderInfo.txStatus;

        if (orderStatus === "PAID" || orderStatus === "SUCCESS" || paymentStatus === "SUCCESS") {
            const amount = parseFloat(orderInfo.order_amount || orderInfo.orderAmount);
            const orderId = String(orderInfo.order_id || orderInfo.orderId).trim();

            if (!orderId) return res.status(400).send("Required Order ID missing");
            const userId = orderId.split('_')[2];

            // PostgreSQL Sequential Atomic Transaction
            await pool.query('BEGIN');

            // 🚫 LAYER 1: transactions table mein check karo kya ye order_id (utr_no) pehle se exist karta hai?
            const txCheck = await pool.query('SELECT id FROM transactions WHERE utr_no = $1', [orderId]);
            if (txCheck.rows.length > 0) {
                await pool.query('ROLLBACK');
                console.log(`[STRICT BLOCKED - WEBHOOK]: Transaction history for order ${orderId} already exists!`);
                return res.status(200).send("OK"); // Respond OK to stop Cashfree retry loop
            }

            // 1. User ka profile balance lock karo for update
            const userLockQuery = await pool.query('SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE', [userId]);
            if (userLockQuery.rows.length === 0) {
                await pool.query('ROLLBACK');
                return res.status(404).send("User not found");
            }

            const currentBalance = parseFloat(userLockQuery.rows[0].wallet_balance || 0);
            const newBalance = currentBalance + amount;

            // 2. Users table mein wallet balance update karo
            await pool.query('UPDATE users SET wallet_balance = $1 WHERE id = $2', [newBalance, userId]);

            // 3. 🔥 TUMHARI TRANSACTIONS TABLE MEIN ENTRY INSERT KARO
            await pool.query(
                `INSERT INTO transactions (user_id, amount, type, status, utr_no) 
                 VALUES ($1, $2, $3, $4, $5)`,
                [userId, amount, 'deposit', 'SUCCESS', orderId]
            );
            
            await pool.query('COMMIT');
            console.log(`[Success Webhook]: ₹${amount} added & history saved for User ${userId}.`);
            return res.status(200).send("OK");
        }
        res.status(200).send("Not paid status");
    } catch (error) {
        await pool.query('ROLLBACK');
        console.error("Critical Webhook Error:", error.message);
        res.status(500).send("Internal Error");
    }
});

// ========================================================
// 2. 🔍 MANUAL FRONTEND SYNC FALLBACK ROUTE (TRANSACTIONS SYNC)
// ========================================================
app.post('/api/payment/verify-status', async (req, res) => {
    try {
        const { order_id } = req.body;
        if (!order_id) return res.status(400).json({ success: false, message: "Order ID missing" });

        const testUrl = "https://api.cashfree.com/pg/orders";
        const finalUrl = `${testUrl}/${order_id}`;

        const response = await axios.get(finalUrl, {
            headers: {
                'x-client-id': process.env.CASHFREE_APP_ID,
                'x-client-secret': process.env.CASHFREE_SECRET_KEY,
                'x-api-version': '2023-08-01'
            }
        });

        if (response.data.order_status === "PAID") {
            const amount = parseFloat(response.data.order_amount);
            const orderIdClean = String(order_id).trim();
            const userId = orderIdClean.split('_')[2];

            await pool.query('BEGIN');
            
            // 🚫 LAYER 2: Frontend sync par bhi verification check mapping
            const txCheck = await pool.query('SELECT id FROM transactions WHERE utr_no = $1', [orderIdClean]);
            if (txCheck.rows.length > 0) {
                await pool.query('ROLLBACK');
                console.log(`[STRICT BLOCKED - FRONTEND]: Order ${orderIdClean} already applied in transaction history.`);
                return res.json({ success: true, amount, message: "Balance already updated" });
            }

            const userQuery = await pool.query('SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE', [userId]);
            
            if (userQuery.rows.length > 0) {
                const currentBalance = parseFloat(userQuery.rows[0].wallet_balance || 0);
                const newBalance = currentBalance + amount;
                
                // Users table main status update execution
                await pool.query('UPDATE users SET wallet_balance = $1 WHERE id = $2', [newBalance, userId]);
                
                // 🔥 TUMHARI TRANSACTIONS TABLE MEIN ENTRY INSERT KARO
                await pool.query(
                    `INSERT INTO transactions (user_id, amount, type, status, utr_no) 
                     VALUES ($1, $2, $3, $4, $5)`,
                    [userId, amount, 'deposit', 'SUCCESS', orderIdClean]
                );

                await pool.query('COMMIT');
                console.log(`[Success Frontend Sync]: ₹${amount} added safely & history saved.`);
                return res.json({ success: true, amount });
            }
            await pool.query('ROLLBACK');
        }
        res.json({ success: false, message: "Order not paid yet" });
    } catch (e) {
        await pool.query('ROLLBACK');
        console.error("Sync Route Error:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- DATABASE TABLES INITIALIZATION ---
const initDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                full_name TEXT,
                email TEXT UNIQUE,
                mobile_no TEXT UNIQUE,
                username TEXT UNIQUE,
                password TEXT,
                aadhar_front_url TEXT,
                aadhar_back_url TEXT,
                is_verified BOOLEAN DEFAULT FALSE,
                kyc_status TEXT DEFAULT 'pending_login',
                referred_by INT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS admin_settings (
                id SERIAL PRIMARY KEY,
                admin_email TEXT,
                smtp_password TEXT
            );
        `);
        console.log("Database Tables Ready.");
    } catch (err) {
        console.error("Database Init Error:", err.message);
    }
};
initDB();

// Multer Memory Buffers setup
const storage = multer.memoryStorage(); 
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 } 
});

// --- ROUTES ---

// ========================================================
// 📝 1. REGISTER ROUTE (WITH EMAIL & PASSWORD)
// ========================================================
app.post('/api/register', async (req, res) => {
    try {
        const { fullName, email, mobile, username, password, referred_by } = req.body;
        
        if (!fullName || !email || !mobile || !username || !password) {
            return res.status(400).json({ success: false, error: "Saari details bharna anivarya hai!" });
        }

        const parsedReferBy = referred_by && !isNaN(referred_by) ? parseInt(referred_by) : null;

        // Aadhaar URLs ko null rkh rahe hain jaisa pehle set kiya tha
        await pool.query(
            `INSERT INTO users (
                full_name, email, mobile_no, username, password, 
                aadhar_front_url, aadhar_back_url, is_verified, kyc_status, referred_by
             ) VALUES ($1, $2, $3, $4, $5, null, null, true, 'verified', $6)`,
            [fullName, email.trim().toLowerCase(), mobile.trim(), username.trim(), password, parsedReferBy]
        );
        
        return res.status(200).json({ success: true, message: "Registration successful!" });
    } catch (err) {
        console.error("Registration Failure:", err.message);
        return res.status(500).json({ success: false, error: "Username ya Mobile pehle se exist karta hai!" });
    }
});


// ========================================================
// 🔑 2. LOGIN ROUTE (MOBILE + PASSWORD) - INSTEAD OF OTP
// ========================================================
app.post('/api/auth/login-with-password', async (req, res) => {
    try {
        const { mobile, password } = req.body;

        if (!mobile || !password) {
            return res.status(400).json({ success: false, error: "Mobile number aur Password dono zaroori hain!" });
        }

        const cleanMobile = String(mobile).trim();

        // Database se password aur verification status check karein
        const userCheck = await pool.query(
            "SELECT id, password, is_verified FROM users WHERE mobile_no = $1", 
            [cleanMobile]
        );

        if (userCheck.rows.length === 0) {
            return res.status(400).json({ success: false, error: "Yeh mobile number registered nahi hai!" });
        }

        const user = userCheck.rows[0];

        // Strict password matching
        if (user.password !== password) {
            return res.status(400).json({ success: false, error: "Galat password! Kripya sahi password daalein." });
        }

        if (!user.is_verified) {
            return res.status(400).json({ success: false, error: "Aapka account suspended ya unverified hai." });
        }

        return res.status(200).json({ 
            success: true, 
            userId: user.id,
            termsAccepted: true
        });

    } catch (err) {
        console.error("Login Error:", err.message);
        return res.status(500).json({ success: false, error: "Server error during login." });
    }
});


// ========================================================
// 📩 3. FORGOT PASSWORD ROUTE (SEND DEFAULT PASSWORD TO EMAIL)
// ========================================================
app.post('/api/auth/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ success: false, error: "Email ID daalna zaroori hai!" });
        }

        const cleanEmail = String(email).trim().toLowerCase();

        // 1. Database se user ka asli password aur username nikal rahe hain
        console.log(`[Retrieve Password]: Fetching existing password for email: ${cleanEmail}`);
        const userCheck = await pool.query(
            "SELECT username, password FROM users WHERE email = $1", 
            [cleanEmail]
        );
        
        if (userCheck.rows.length === 0) {
            return res.status(400).json({ success: false, error: "Yeh Email ID humare system mein nahi hai!" });
        }

        const user = userCheck.rows[0];
        const existingPassword = user.password; // 🔑 Asli password fetch ho gaya

        // 2. Nodemailer Transporter Setup (IPv4 connection layer for Render)
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport({
            host: 'smtp.gmail.com',
            port: 587,
            secure: false, 
            family: 4, // Force IPv4 network to prevent connection timeouts
            auth: {
                user: (process.env.GMAIL_USER || "").trim(), 
                pass: (process.env.GMAIL_PASS || "").trim() 
            },
            tls: {
                rejectUnauthorized: false
            }
        });

        // 3. Email Content Design - Sending original password securely
        const mailOptions = {
            from: `"Khel Bhai Ludo Support" <${process.env.GMAIL_USER}>`,
            to: cleanEmail,
            subject: '🔑 Your Account Password - Khel Bhai Ludo',
            html: `
                <div style="font-family: Arial, sans-serif; padding: 20px; background: #1e293b; color: white; border-radius: 8px; max-width: 500px;">
                    <h2 style="color: #ffd700; text-align: center;">Khel Bhai Ludo</h2>
                    <p>Hello <b>${user.username}</b>,</p>
                    <p>Aapki request par humne aapka account password retrieve kar liya hai.</p>
                    <div style="background: #0f172a; padding: 15px; border-radius: 6px; text-align: center; margin: 20px 0; border: 1px solid #d32f2f;">
                        <span style="font-size: 12px; color: #94a3b8; display: block; margin-bottom: 5px;">Aapka Login Password Hai:</span>
                        <b style="font-size: 22px; color: #ffd700; letter-spacing: 1px;">${existingPassword}</b>
                    </div>
                    <p style="font-size: 13px; color: #cbd5e1;">Ab aap is password ka use karke apne registered mobile number ke sath smoothly login kar sakte hain.</p>
                    <hr style="border-color: #334155;">
                    <small style="color: #64748b;">Security Note: Kisi ke sath bhi apna login password share na karein.</small>
                </div>
            `
        };

        // 4. Send Mail Sequence
        await transporter.sendMail(mailOptions);
        console.log(`[Email Dispatch Success]: Password successfully retrieved and sent to ${cleanEmail}`);

        return res.status(200).json({ 
            success: true, 
            message: "Aapka password aapke register email par bhej diya gaya hai!" 
        });

    } catch (err) {
        console.error("🔥 PASSWORD RETRIEVAL ROUTE ERROR:", err.message);
        return res.status(500).json({ 
            success: false, 
            error: `Email integration failed: ${err.message || 'Check network configurations'}` 
        });
    }
});


// ========================================================
// ⚡ PROFILE FETCH ROUTE FOR DASHBOARD SYNC
// ========================================================
app.get('/api/user/profile/:userId', async (req, res) => {
    try {
        const { userId } = req.getParams || req.params;
        
        console.log(`[Profile Fetch Engine]: Requesting details for User ID: ${userId}`);
        
        // Database se details fetch karein
        const userQuery = await pool.query(
            "SELECT id, username, full_name, mobile_no, email, wallet_balance, earning_balance, kyc_status, created_at FROM users WHERE id = $1",
            [userId]
        );

        if (userQuery.rows.length === 0) {
            return res.status(404).json({ success: false, error: "User profile not found in database." });
        }

        // Dashboard.html isi 'success' aur 'user' object ka wait karta hai
        return res.status(200).json({
            success: true,
            user: userQuery.rows[0]
        });

    } catch (err) {
        console.error("Critical Profile Route Crash:", err.message);
        return res.status(500).json({ success: false, error: "Internal Server Error" });
    }
});


// SAFE FALLBACK: Frontend agar galti se purana route bhi hit karega, toh ye route use handle kar lega bina crash kiye
app.post('/api/verify-login-firebase', async (req, res) => {
    const { mobile } = req.body;
    try {
        const userCheck = await pool.query("SELECT id, is_verified FROM users WHERE mobile_no = $1", [mobile.trim()]);
        if (userCheck.rows.length === 0) return res.status(400).json({ success: false, error: "User not registered." });
        
        const user = userCheck.rows[0];
        return res.status(200).json({ success: true, userId: user.id, termsAccepted: true });
    } catch(e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});


// --- 1. Terms Accept Karne Ka Route ---
app.post('/api/accept-terms', async (req, res) => {
    const { userId } = req.body;
    
    console.log("Terms acceptance request for User ID:", userId);

    try {
        // Database mein terms_accepted ko true set karein
        const result = await pool.query(
            'UPDATE users SET terms_accepted = true WHERE id = $1 RETURNING *', 
            [userId]
        );

        if (result.rowCount > 0) {
            console.log(`✅ User ${userId} ne terms accept kar liye hain.`);
            res.json({ success: true, message: "Terms accepted successfully!" });
        } else {
            res.status(404).json({ success: false, error: "User nahi mila!" });
        }
    } catch (err) {
        console.error("❌ Terms Update Error:", err.message);
        res.status(500).json({ success: false, error: "Database error: " + err.message });
    }
});






// Purana Verify Login (OTP Store wala)
app.post('/api/verify-login', async (req, res) => {
    const { mobile, otp } = req.body;
    try {
        if (!otpStore[mobile] || otpStore[mobile] != otp) return res.status(400).json({ error: "Invalid OTP!" });
        const userRes = await pool.query('SELECT id, terms_accepted FROM users WHERE mobile_no = $1', [mobile]);
        const user = userRes.rows[0];
        delete otpStore[mobile];
        res.json({ success: true, userId: user.id, termsAccepted: user.terms_accepted });
    } catch (err) { res.status(500).json({ error: "Server error" }); }
});


// --- 1. User Profile Detail (Naam aur Balance ke liye) ---
app.get('/api/user/details/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            'SELECT username, full_name, mobile_no, wallet_balance, earning_balance, kyc_status, created_at FROM users WHERE id = $1', 
            [id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: "User not found" });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// --- 2. Game History (Play Ludo/Win click ke liye) ---
app.get('/api/user/game-history/:id', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM battles WHERE creator_id = $1 OR joiner_id = $1 ORDER BY created_at DESC', 
            [req.params.id]
        );
        res.json(result.rows); // Agar khali hai toh [] jayega
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 3. Transaction History (Wallet transaction ke liye) ---
app.get('/api/user/transactions/:id', async (req, res) => {
    try {
        const result = await pool.query(

            'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC', 
            [req.params.id]
        );
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});





// 3. Battles
app.post('/api/battles/create', async (req, res) => {
    const { userId, amount } = req.body;
    try {
        await pool.query('BEGIN');
        
        // Creator ka balance check karein
        const userRes = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [userId]);
        const balance = parseFloat(userRes.rows[0].wallet_balance);

        if (balance < parseFloat(amount)) {
            await pool.query('ROLLBACK');
            return res.status(400).json({ success: false, error: "Paryapt balance nahi hai!" });
        }

        // 1. Creator ke paise turant deduct karein
        await pool.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2', [amount, userId]);

        // 2. Battle create karein
        const result = await pool.query(
            'INSERT INTO battles (creator_id, amount, status) VALUES ($1, $2, $3) RETURNING id', 
            [userId, amount, 'open']
        );

        await pool.query('COMMIT');
        res.json({ success: true, battleId: result.rows[0].id });
    } catch (err) {
        await pool.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    }
});


// --- BATTLES LIST ROUTE ---
app.get('/api/battles/list', async (req, res) => {
    try {
        // Sirf 'open' status waali battles dikhani hain jisme kisi ne join nahi kiya
        const result = await pool.query(`
            SELECT b.*, u.username 
            FROM battles b 
            JOIN users u ON b.creator_id = u.id 
            WHERE b.status = 'open' 
            ORDER BY b.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error("Fetch Battles Error:", err.message);
        res.status(500).json({ error: "Server error" });
    }
});


// 3. Join Challenge
app.post('/api/battles/join', async (req, res) => {
    const { userId, battleId } = req.body;

    try {
        await pool.query('BEGIN');

        // 1. Battle fetch aur lock (FOR UPDATE zaroori hai)
        const battleRes = await pool.query('SELECT * FROM battles WHERE id = $1 FOR UPDATE', [battleId]);
        const battle = battleRes.rows[0];

        if (!battle) {
            await pool.query('ROLLBACK');
            return res.status(404).json({ success: false, error: "Battle nahi mili!" });
        }

        if (battle.status !== 'open') {
            await pool.query('ROLLBACK');
            return res.status(400).json({ success: false, error: "Battle full ho chuki hai!" });
        }

        if (battle.creator_id == userId) {
            await pool.query('ROLLBACK');
            return res.status(400).json({ success: false, error: "Aap apni hi battle join nahi kar sakte!" });
        }

        // 2. Joiner balance check
        const userRes = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [userId]);
        const userBalance = parseFloat(userRes.rows[0].wallet_balance);
        const battleAmt = parseFloat(battle.amount); // Yahan fix kiya hai

        if (userBalance < battleAmt) {
            await pool.query('ROLLBACK');
            return res.status(400).json({ success: false, error: "Paryapt balance nahi hai!" });
        }

        // 3. Joiner balance deduct karein
        await pool.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2', [battleAmt, userId]);

        // 4. Battle status update
        await pool.query('UPDATE battles SET joiner_id = $1, status = \'joined\' WHERE id = $2', [userId, battleId]);

        // 5. Transaction History entry
        // Dhyan dein: Agar 'type' column nahi hai toh pehle database mein add karein
        await pool.query(
            'INSERT INTO transactions (user_id, amount, status, created_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)', 
            [userId, battleAmt, 'success']
        );

        await pool.query('COMMIT');
        console.log(`✅ Battle Joined: ${battleId} by User ${userId}`);
        res.json({ success: true });

    } catch (err) {
        await pool.query('ROLLBACK');
        console.error("Join Error Details:", err.message); // Render logs mein error dekhein
        res.status(500).json({ success: false, error: "Server Internal Error: " + err.message });
    }
});


// --- BATTLE STATUS CHECK (Creator ke liye) ---
app.get('/api/battles/status/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT status, joiner_id FROM battles WHERE id = $1', [req.params.id]);
        if (result.rows.length > 0) {
            res.json(result.rows[0]);
        } else {
            res.status(404).json({ error: "Not found" });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// A. Battle Details Fetch karna (Improved Version)
app.get('/api/battles/details/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // SQL Query check karein ki data mil raha hai ya nahi
        const result = await pool.query(`
            SELECT 
                b.*, 
                u1.username as creator_name, 
                u2.username as joiner_name 
            FROM battles b 
            JOIN users u1 ON b.creator_id = u1.id 
            LEFT JOIN users u2 ON b.joiner_id = u2.id 
            WHERE b.id = $1`, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Battle nahi mili!" });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error("Fetch Battle Error:", err.message);
        res.status(500).json({ error: "Server error occurred" });
    }
});

// B. Room Code Update karna (Sirf Creator kar sakta hai)
app.post('/api/battles/update-room', async (req, res) => {
    const { battleId, roomCode } = req.body;
    try {
        await pool.query('UPDATE battles SET room_code = $1, status = $2 WHERE id = $3', 
        [roomCode, 'playing', battleId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Naya submit-result route
// C. Screenshot Upload Setup (Multer use karein)
app.post('/api/battles/submit-result', upload.single('screenshot'), async (req, res) => {
    try {
        const { userId, battleId, status } = req.body;
        let finalPublicUrl = null;

        // Sirf 'won' status hone par hi file check hogi
        if (status === 'won') {
            if (!req.file) {
                return res.status(400).json({ success: false, error: "Winner ke liye screenshot zaroori hai!" });
            }

            const fileExt = req.file.mimetype.split('/')[1] || 'png';
            const fileName = `${Date.now()}_battle_${battleId}.${fileExt}`;

            const { data: uploadData, error: upError } = await supabase.storage
                .from('screenshots')
                .upload(fileName, req.file.buffer, { 
                    contentType: req.file.mimetype,
                    upsert: true 
                });

            if (upError) throw upError;

            const { data: urlData } = supabase.storage.from('screenshots').getPublicUrl(fileName);
            finalPublicUrl = urlData.publicUrl;
        }

        // Database Update (Har case ke liye: won, lost, cancel)
        await pool.query(
            `UPDATE battles SET 
                result_status = $1, 
                screenshot_url = $2, 
                status = $3, 
                winner_id = CASE WHEN $1 = 'won' THEN winner_id ELSE winner_id END 
             WHERE id = $4`,
            [status, finalPublicUrl, 'pending_approval', battleId]
        );

        res.json({ success: true, message: "Result updated successfully!" });

    } catch (err) {
        console.error("Critical Upload Error:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});


// KYC Submission with Aadhar Upload
app.post('/api/user/submit-kyc', upload.fields([
    { name: 'aadharFront', maxCount: 1 },
    { name: 'aadharBack', maxCount: 1 }
]), async (req, res) => {
    try {
        const { userId, bankAcc, ifsc, upiId, whatsapp } = req.body;
        let frontUrl = null;
        let backUrl = null;

        // 1. Upload Aadhar Front
        if (req.files['aadharFront']) {
            const frontFile = req.files['aadharFront'][0];
            const frontName = `kyc_${userId}_front_${Date.now()}.png`;
            const { data } = await supabase.storage.from('screenshots').upload(frontName, frontFile.buffer, { contentType: frontFile.mimetype });
            const { data: urlData } = supabase.storage.from('screenshots').getPublicUrl(frontName);
            frontUrl = urlData.publicUrl;
        }

        // 2. Upload Aadhar Back
        if (req.files['aadharBack']) {
            const backFile = req.files['aadharBack'][0];
            const backName = `kyc_${userId}_back_${Date.now()}.png`;
            const { data } = await supabase.storage.from('screenshots').upload(backName, backFile.buffer, { contentType: backFile.mimetype });
            const { data: urlData } = supabase.storage.from('screenshots').getPublicUrl(backName);
            backUrl = urlData.publicUrl;
        }

        // 3. Update Database
        await pool.query(`
            UPDATE users SET 
                bank_account_no = $1, 
                ifsc_code = $2, 
                upi_id = $3, 
                whatsapp_no = $4,
                aadhar_front_url = $5,
                aadhar_back_url = $6,
                kyc_status = 'pending'
            WHERE id = $7`, 
            [bankAcc, ifsc, upiId, whatsapp, frontUrl, backUrl, userId]
        );

        res.json({ success: true, message: "KYC details and Aadhar submitted!" });
    } catch (err) {
        console.error("KYC Error:", err.message);
        res.status(500).json({ success: false, error: "Server Error" });
    }
});



// 5. Withdrawals
app.post('/api/withdraw/request', async (req, res) => {
    const { userId, amount } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. User ka balance check karein (earning_balance se withdraw hoga)
        const userRes = await client.query('SELECT earning_balance FROM users WHERE id = $1', [userId]);
        const user = userRes.rows[0];

        if (!user || parseFloat(user.earning_balance) < parseFloat(amount)) {
            throw new Error("Insufficient Winning Balance!");
        }

        // 2. Earning balance se amount minus karein
        await client.query(
            'UPDATE users SET earning_balance = earning_balance - $1 WHERE id = $2',
            [amount, userId]
        );

        // 3. Transactions table mein entry karein (Kyuki withdrawals table ab nahi hai)
        await client.query(
            `INSERT INTO transactions (user_id, amount, type, status, created_at) 
             VALUES ($1, $2, 'withdrawal', 'pending', NOW())`,
            [userId, amount]
        );

        await client.query('COMMIT');
        res.json({ success: true, message: "Withdrawal request submitted successfully!" });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Withdraw Error:", err.message);
        res.status(500).json({ success: false, error: err.message });
    } finally {
        client.release();
    }
});


// UPIGateway Order Create
// SIRF ISE RAKHEIN ✅
app.post('/api/payment/create-order', async (req, res) => {
    try {
        const { amount, userId, username, mobileNo } = req.body;

        if (!amount || !userId) {
            return res.status(400).json({ success: false, message: "Amount and User ID are required" });
        }

        // Cashfree Production API URL
        const cashfreeUrl = "https://api.cashfree.com/pg/orders";

        const orderData = {
            order_amount: parseFloat(amount).toFixed(2),
            order_currency: "INR",
            order_id: `ORD_${Date.now()}_${userId}`, // Dynamic Unique Order ID
            customer_details: {
                customer_id: String(userId),
                customer_phone: String(mobileNo || "0000000000"),
                customer_name: username || "Ludo Player"
            },
            order_meta: {
                // Settle hone ke baad user wapas is page par aayega
                return_url: "https://khelobhailudo.github.io/khelbhailudo/dashboard.html?order_id={order_id}"
            }
        };

        const response = await axios.post(cashfreeUrl, orderData, {
            headers: {
                'x-client-id': process.env.CASHFREE_APP_ID,       // Render Environment Variable
                'x-client-secret': process.env.CASHFREE_SECRET_KEY, // Render Environment Variable
                'x-api-version': '2023-08-01',
                'Content-Type': 'application/json'
            }
        });

        // Sending successful session payload to checkout client
        res.json({ 
            success: true, 
            payment_session_id: response.data.payment_session_id, 
            order_id: response.data.order_id 
        });

    } catch (error) {
        console.error("Cashfree API Execution Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ 
            success: false, 
            message: "Gateway sequence response failed", 
            error: error.response ? error.response.data : error.message 
        });
    }
});



app.post('/api/webhook/upigateway', async (req, res) => {
    const { status, client_txn_id, amount, udf1 } = req.body; // udf1 mein humne userId bheja tha

    if (status === 'success') {
        try {
            // 1. Transaction record update karein
            await pool.query('INSERT INTO transactions (user_id, amount, utr_no, status, type) VALUES ($1, $2, $3, $4, $5)', 
            [udf1, amount, client_txn_id, 'success', 'deposit']);

            // 2. User ka Wallet Update karein
            await pool.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [amount, udf1]);

            console.log(`✅ Wallet Updated for User ${udf1}: ₹${amount}`);
            res.send('OK'); // Gateway ko batayein ki humne data process kar liya
        } catch (err) {
            console.error("Webhook Error:", err.message);
            res.status(500).send('Database Error');
        }
    } else {
        res.send('Not Success');
    }
});



// --- ADMIN SYSTEM ROUTES ---

// 1. Admin Login Verification
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    const ADMIN_PASSWORD = "Ludo@2026Hemraj"; // Aap ise yahan se badal sakte hain

    if (password === ADMIN_PASSWORD) {
        res.json({ success: true, token: "ADMIN_SESSION_ACTIVE" });
    } else {
        res.status(401).json({ success: false, message: "Galat Password!" });
    }
});


// --- ADMIN: Pending Battle Results Fetch Karein ---
// Is query ko server.js mein update karein
app.get('/api/admin/battles/pending-details', async (req, res) => {
    try {
        const query = `
            SELECT b.*, u1.username as creator_name, u2.username as joiner_name 
            FROM battles b
            JOIN users u1 ON b.creator_id = u1.id
            LEFT JOIN users u2 ON b.joiner_id = u2.id
            WHERE b.status = 'pending_approval' 
            ORDER BY b.created_at DESC`;
            
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});


app.get('/api/admin/master-stats', async (req, res) => {
    try {
        const users = await pool.query('SELECT COUNT(*) FROM users');
        const kyc = await pool.query("SELECT COUNT(*) FROM users WHERE kyc_status = 'pending'");
        
        // FIX: Ab hum 'transactions' table se withdrawal count nikalenge
        const withdraw = await pool.query("SELECT COUNT(*) FROM transactions WHERE type = 'withdrawal' AND status = 'pending'");
        
        const battles = await pool.query("SELECT COUNT(*) FROM battles WHERE status = 'pending_approval'");

        res.json({
            totalUsers: parseInt(users.rows[0].count),
            pendingKyc: parseInt(kyc.rows[0].count),
            pendingWithdrawals: parseInt(withdraw.rows[0].count),
            pendingBattles: parseInt(battles.rows[0].count)
        });
    } catch (err) { 
        console.error("Stats Error:", err.message);
        res.status(500).json({ error: err.message }); 
    }
});

app.post('/api/admin/battles/verify-winner', async (req, res) => {
    const { battleId, winnerId } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Battle details aur amount nikalna
        const battleRes = await client.query('SELECT amount, status FROM battles WHERE id = $1', [battleId]);
        const battle = battleRes.rows[0];

        if (!battle || battle.status === 'completed') {
            throw new Error("Battle pehle hi complete ho chuki hai!");
        }

        // 2. Winning Amount Calculate karna (Platform fee kaat kar, eg: 10%)
        // Agar aapne koi fee nahi rakhi toh direct battle.amount use karein
        const winAmount = parseFloat(battle.amount) * 1.8; // Example: ₹100 ki battle par ₹180 milenge

        // 3. Winner ke EARNING_BALANCE mein paisa add karna (Wallet mein nahi)
        await client.query(
            'UPDATE users SET earning_balance = earning_balance + $1 WHERE id = $2',
            [winAmount, winnerId]
        );

        // 4. Battle status update karna
        await client.query(
            'UPDATE battles SET status = $1, winner_id = $2 WHERE id = $3',
            ['completed', winnerId, battleId]
        );

        await client.query('COMMIT');
        res.json({ success: true, message: "Winner Approved! Paisa Earning Balance mein bhej diya gaya hai." });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Verification Error:", err.message);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

app.get('/api/admin/pending-users', async (req, res) => {
    try {
        // FIXED: Only pulls records where kyc_status is strictly 'pending'
        const result = await pool.query(
            "SELECT * FROM users WHERE kyc_status = 'pending' ORDER BY id DESC"
        );
        res.json(result.rows);
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// 3. Approve User Function (Kept intact with existing update query format)
app.post('/api/admin/approve-user', async (req, res) => {
    const { userId } = req.body;
    try {
        await pool.query("UPDATE users SET is_verified = true, kyc_status = 'approved' WHERE id = $1", [userId]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. Admin Users List View (Ensured is_verified selection is explicitly active)
app.get('/api/admin/users/list', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, full_name, username, mobile_no, wallet_balance, is_verified FROM users ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});


// 1. KYC Approve Route
app.post('/api/admin/approve-kyc', async (req, res) => {
    const { userId } = req.body;
    try {
        await pool.query("UPDATE users SET kyc_status = 'approved' WHERE id = $1", [userId]);
        res.json({ success: true, message: "User approved" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. KYC Reject Route
app.post('/api/admin/reject-kyc', async (req, res) => {
    const { userId, reason } = req.body;
    try {
        // KYC status ko 'rejected' set karein
        await pool.query("UPDATE users SET kyc_status = 'rejected' WHERE id = $1", [userId]);
        res.json({ success: true, message: "User rejected" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// 1. Pending Withdrawals Fetch karna
app.get('/api/admin/withdrawals/pending', async (req, res) => {
    try {
        // Hum transactions aur users table ko join kar rahe hain taaki bank/UPI details mil sakein
        const result = await pool.query(`
            SELECT 
                t.id, 
                t.amount, 
                t.status, 
                t.created_at, 
                u.username, 
                u.mobile_no, 
                u.upi_id,
                u.bank_account_no,
                u.ifsc_code
            FROM transactions t
            JOIN users u ON t.user_id = u.id 
            WHERE t.type = 'withdrawal' AND t.status = 'pending'
            ORDER BY t.created_at DESC`);
            
        res.json(result.rows);
    } catch (err) {
        console.error("Fetch Withdrawals Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// 2. Withdrawal Approve karna
app.post('/api/admin/withdrawals/approve', async (req, res) => {
    const { withdrawId } = req.body;
    try {
        // 1. Transaction status update
        const result = await pool.query(
            "UPDATE transactions SET status = 'success' WHERE id = $1 RETURNING *", 
            [withdrawId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Transaction nahi mili" });
        }

        res.json({ success: true, message: "Withdrawal Approved successfully!" });
    } catch (err) {
        console.error("Approve Error:", err.message);
        res.status(500).json({ success: false, error: "Server Error" });
    }
});


app.post('/api/admin/withdrawals/reject', async (req, res) => {
    const { withdrawId, reason } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Transaction details nikalna
        const transRes = await client.query("SELECT user_id, amount FROM transactions WHERE id = $1 AND status = 'pending'", [withdrawId]);
        if (transRes.rows.length === 0) throw new Error("Transaction nahi mili");
        
        const { user_id, amount } = transRes.rows[0];

        // 2. User ke earning_balance mein paisa wapis dalna
        await client.query("UPDATE users SET earning_balance = earning_balance + $1 WHERE id = $2", [amount, user_id]);

        // 3. Transaction status update karna
        await client.query("UPDATE transactions SET status = 'rejected' WHERE id = $1", [withdrawId]);

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});


// --- NEW: Fetch User Referral History ---
// --- 1. Fetch User Referral History ---
app.get('/api/user/referrals/:userId', async (req, res) => {
    const { userId } = req.params;
    
    // Fallback parsing checks
    const targetId = parseInt(userId);
    if (!targetId || isNaN(targetId)) {
        console.error("Critical: Invalid or missing userId passed to referrals:", userId);
        return res.status(400).json({ success: false, error: "Invalid User ID parameter" });
    }

    try {
        console.log(`Executing safe query for referred_by ID: ${targetId}`);
        
        // Ensure standard clean SQL parameters
        const result = await pool.query(`
            SELECT id, username, kyc_status, created_at 
            FROM users 
            WHERE referred_by = $1 
            ORDER BY created_at DESC`, 
            [targetId]
        );
        
        console.log(`Query successful. Found ${result.rows.length} referral rows.`);
        
        // Send safe headers manually to prevent gateway blockages
        res.status(200).json(result.rows);
    } catch (err) {
        console.error("Render Query Crash Error:", err.message);
        res.status(500).json({ success: false, error: "Database transaction failed", details: err.message });
    }
});


// 1. Admin se Notification Send karne ka Route
app.post('/api/admin/notifications/add', async (req, res) => {
    const { title, message } = req.body;
    if (!title || !message) {
        return res.status(400).json({ success: false, error: "Title aur Message zaroori hain!" });
    }
    try {
        await pool.query(
            "INSERT INTO notifications (title, message, created_at) VALUES ($1, $2, NOW())",
            [title, message]
        );
        res.json({ success: true, message: "Notification sent successfully!" });
    } catch (err) {
        console.error("Notification Add Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// 2. Users ke liye Notification Fetch karne ka Route
app.get('/api/notifications', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM notifications ORDER BY created_at DESC");
        res.json(result.rows);
    } catch (err) {
        console.error("Notification Fetch Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});


// Admin se Notification Delete karne ka Route
app.delete('/api/admin/notifications/delete/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query("DELETE FROM notifications WHERE id = $1 RETURNING *", [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Notification nahi mila!" });
        }
        
        res.json({ success: true, message: "Notification deleted successfully!" });
    } catch (err) {
        console.error("Notification Delete Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});


// Get All Users for Admin Panel (FIXED: Added is_verified column)
app.get('/api/admin/users', async (req, res) => {
    try {
        // CRITICAL FIX: explicit select kiya hai is_verified column ko
        const result = await pool.query(`
            SELECT id, username, mobile_no, wallet_balance, is_verified,
                   COALESCE(kyc_status, 'pending') as kyc_status, 
                   aadhar_front_url, aadhar_back_url, created_at 
            FROM users 
            ORDER BY id DESC
        `);
        
        console.log("Backend Users Fetch sample row:", result.rows[0]); // Debugging log
        res.status(200).json(result.rows);
    } catch (err) {
        console.error("Admin Users Fetch Error:", err.message);
        res.status(500).json([]); 
    }
});



// ADMIN USER VERIFICATION - Only triggers Login Activation (Removes confusion with KYC)
app.post('/api/admin/user/verify', async (req, res) => {
    const { userId, action } = req.body; 
    
    if (!userId || !action) {
        return res.status(400).json({ success: false, error: "Missing fields: userId aur action zaroori hain!" });
    }
    
    try {
        const verifyStatus = (action.toLowerCase() === 'approve');
        const targetUserId = parseInt(userId);

        console.log(`Setting verification flag in database: User #${targetUserId} -> is_verified = ${verifyStatus}`);

        // Only updates the boolean login flag column, leaves aadhar/kyc columns untouched
        const result = await pool.query(
            `UPDATE users 
             SET is_verified = $1 
             WHERE id = $2
             RETURNING id, is_verified`, 
            [verifyStatus, targetUserId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "User record not found in system." });
        }

        return res.status(200).json({ 
            success: true, 
            message: `User login access updated to ${verifyStatus}`,
            user: result.rows[0]
        });
    } catch (err) {
        console.error("Critical Verification Error:", err.message);
        return res.status(500).json({ success: false, error: "Database state transition failed." });
    }
});


// 3. Route to Delete a User Request / Account completely
app.delete('/api/admin/user/delete/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query("DELETE FROM users WHERE id = $1 RETURNING *", [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "User nahi mila!" });
        }
        res.status(200).json({ success: true, message: "User requested account deleted successfully!" });
    } catch (err) {
        console.error("User Delete Error:", err.message);
        res.status(500).json({ success: false, error: "Failed to delete user structure" });
    }
});



const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server is live on port: ${PORT}`);
});
