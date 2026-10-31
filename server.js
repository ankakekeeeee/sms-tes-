const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Statik dosyalar için public klasörü (Web sitesi arayüzü buradan sunulacak)
app.use(express.static(path.join(__dirname, 'public')));

const APP_VERSION = '2026-10-31-20';

// ====== AYARLAR ======
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8989904538:AAGETyb0e5ghitsYM3yWInhnIi3lexYMjPw';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '8811977430';
const ADMIN_TELEGRAM_USERNAME = process.env.ADMIN_TELEGRAM_USERNAME || 'vipankaa';
const ADMIN_WHATSAPP = process.env.ADMIN_WHATSAPP || '573181006792';
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || 'https://g-venlipanelsms.onrender.com';

// sms.tc API Ayarları
const SMSTC_API_URL = 'https://sms.tc/stubs/handler_api.php';
const SMSTC_API_KEY = process.env.SMSTC_API_KEY || 'smstc_live_0vHjhoWB7H8qniIpTV5GDwF3W04eNpXRUWHZ9GYW';

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'Aklomanti';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'AZC.anka.34';

// Sağlayıcı istek kuyruğu (Rate limit koruması için)
const PROVIDER_MIN_INTERVAL_MS = 2200;
let providerQueue = Promise.resolve();
let lastProviderCallAt = 0;

function providerGet(params, timeout) {
    const run = providerQueue.then(async () => {
        const wait = PROVIDER_MIN_INTERVAL_MS - (Date.now() - lastProviderCallAt);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        lastProviderCallAt = Date.now();
        return axios.get(SMSTC_API_URL, { params: Object.assign({ api_key: SMSTC_API_KEY }, params), timeout: timeout || 20000 });
    });
    providerQueue = run.then(() => {}, () => {});
    return run;
}

const DEFAULT_DB = {
    users: {
        [ADMIN_USERNAME]: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD, balance: 5000, role: "admin", banned: false }
    },
    payments: {},
    visitors: [],
    logins: [],
    orders: {},
    support: {},
    adminSessions: {},
    customCatalog: [], // Admin panelden eklenen/düzenlenen ürünler ve özel fiyatlar
    smsConfigs: {}     // Admin panelden ürün bazlı servis ve ülke kodları eşlemeleri
};

const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'anka_data.json');
let db = DEFAULT_DB;
try {
    if (fs.existsSync(DB_FILE)) {
        const loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        db = Object.assign({}, DEFAULT_DB, loaded);
        for (const k in DEFAULT_DB) if (db[k] === undefined) db[k] = DEFAULT_DB[k];
        if (!db.users || !Object.keys(db.users).length) db.users = DEFAULT_DB.users;
        for (const u in DEFAULT_DB.users) {
            if (!db.users[u]) db.users[u] = DEFAULT_DB.users[u];
        }
    }
} catch (e) { console.error('[db] Diskten yükleme hatası:', e.message); }

db.users[ADMIN_USERNAME] = Object.assign(
    { balance: 5000 },
    db.users[ADMIN_USERNAME] || {},
    { username: ADMIN_USERNAME, password: ADMIN_PASSWORD, role: 'admin', banned: false }
);

let saveTimer = null;
function persist() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (e) { console.error('[db] Diske yazma hatası:', e.message); }
    }, 400);
}

// Varsayılan Ürün Kataloğu (Admin panelden fiyatları ve kodları tamamen değiştirebilirsin)
const DEFAULT_CATALOG = [
    { id: 'wa_tr', name: 'WhatsApp Türkiye (Özel)', serviceCode: 'wa', countryCode: '62', price: 380, icon: 'fa-whatsapp', color: 'text-violet-400' },
    { id: 'tg_tr', name: 'Telegram Türkiye', serviceCode: 'tg', countryCode: '62', price: 200, icon: 'fa-telegram', color: 'text-blue-400' },
    { id: 'ig_tr', name: 'Instagram Türkiye', serviceCode: 'ig', countryCode: '62', price: 60, icon: 'fa-instagram', color: 'text-pink-400' },
    { id: 'go_tr', name: 'Google / Gmail Türkiye', serviceCode: 'go', countryCode: '62', price: 60, icon: 'fa-google', color: 'text-violet-400' },
    { id: 'ds_tr', name: 'Discord Türkiye', serviceCode: 'ds', countryCode: '62', price: 60, icon: 'fa-discord', color: 'text-indigo-400' }
];

// Admin Token Kontrolü
function checkAdminToken(token) {
    const sess = token && db.adminSessions[token];
    if (!sess) return null;
    if (Date.now() - sess.ts > 7 * 24 * 60 * 60 * 1000) { delete db.adminSessions[token]; persist(); return null; }
    if (!db.users[sess.username] || db.users[sess.username].role !== 'admin') return null;
    return sess.username;
}

// ====== API ENDPOINTLERİ ======

// 1. Ürün Kataloğu ve Fiyatlar
app.get('/api/catalog', (req, res) => {
    // Admin panelden özelleştirilmiş fiyatlar/kodlar varsa uygula
    const catalog = DEFAULT_CATALOG.map(item => {
        const custom = (db.customCatalog || []).find(c => c.id === item.id);
        return custom ? Object.assign({}, item, custom) : item;
    });
    // Ekstra eklenen özel ürünler
    (db.customCatalog || []).filter(c => !DEFAULT_CATALOG.some(d => d.id === c.id)).forEach(c => catalog.push(c));
    res.json({ success: true, catalog });
});

// 2. Numara Satın Al (sms.tc üzerinden)
app.post('/api/order/buy', async (req, res) => {
    const { username, productId } = req.body;
    const user = db.users[username];
    if (!user) return res.json({ success: false, message: 'Kullanıcı bulunamadı.' });

    // Ürün bul
    const allCatalog = [...DEFAULT_CATALOG, ...(db.customCatalog || [])];
    const product = allCatalog.find(p => p.id === productId);
    if (!product) return res.json({ success: false, message: 'Ürün bulunamadı.' });

    if (user.balance < product.price) {
        return res.json({ success: false, message: 'Yetersiz bakiye! Lütfen bakiye yükleyin.' });
    }

    try {
        // sms.tc'den numara talep et (getNumber)
        // sms.tc standart stubs api parametreleri: action=getNumber, service=..., country=...
        const r = await providerGet({
            action: 'getNumber',
            service: product.serviceCode,
            country: product.countryCode
        });

        let data = r.data;
        // sms.tc yanıt formatı genellikle "ACCESS_NUMBER:id:number" veya JSON olabilir
        if (typeof data === 'string' && data.includes('ACCESS_NUMBER')) {
            const parts = data.split(':');
            const activationId = parts[1];
            const phoneNumber = parts[2];

            // Bakiyeden düş
            user.balance -= product.price;
            const orderId = 'ord_' + Date.now();
            db.orders[orderId] = {
                id: orderId,
                username,
                productId: product.id,
                productName: product.name,
                price: product.price,
                activationId,
                phoneNumber,
                smsCode: null,
                status: 'active',
                time: new Date().toLocaleString('tr-TR')
            };
            persist();

            return res.json({ success: true, orderId, phoneNumber, activationId });
        } else if (typeof data === 'object' && data.status === 'success') {
            user.balance -= product.price;
            const orderId = 'ord_' + Date.now();
            db.orders[orderId] = {
                id: orderId,
                username,
                productId: product.id,
                productName: product.name,
                price: product.price,
                activationId: data.id || data.activationId,
                phoneNumber: data.number || data.phone,
                smsCode: null,
                status: 'active',
                time: new Date().toLocaleString('tr-TR')
            };
            persist();
            return res.json({ success: true, orderId, phoneNumber: db.orders[orderId].phoneNumber, activationId: db.orders[orderId].activationId });
        } else {
            return res.json({ success: false, message: 'Sağlayıcıdan numara alınamadı (Stokta kalmamış olabilir): ' + JSON.stringify(data) });
        }
    } catch (e) {
        console.error('[Buy Number Error]:', e.message);
        return res.json({ success: false, message: 'Numara alma sırasında hata oluştu: ' + e.message });
    }
});

// 3. SMS Kodunu Kontrol Et
app.post('/api/order/check', async (req, res) => {
    const { orderId } = req.body;
    const order = db.orders[orderId];
    if (!order) return res.json({ success: false, message: 'Sipariş bulunamadı.' });
    if (order.smsCode) return res.json({ success: true, smsCode: order.smsCode, status: order.status });

    try {
        const r = await providerGet({
            action: 'getStatus',
            id: order.activationId
        });
        let data = r.data;
        if (typeof data === 'string' && data.includes('STATUS_OK')) {
            const code = data.split(':')[1];
            order.smsCode = code;
            order.status = 'completed';
            persist();
            return res.json({ success: true, smsCode: code, status: 'completed' });
        } else if (typeof data === 'string' && data.includes('STATUS_WAIT_CODE')) {
            return res.json({ success: true, smsCode: null, status: 'waiting' });
        } else {
            return res.json({ success: true, smsCode: null, status: data });
        }
    } catch (e) {
        return res.json({ success: false, message: e.message });
    }
});

// 4. Admin Girişi
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        const token = createAdminSession(username);
        return res.json({ success: true, token });
    }
    res.json({ success: false, message: 'Hatalı kullanıcı adı veya şifre!' });
});

function createAdminSession(username) {
    const token = crypto.randomBytes(32).toString('hex');
    db.adminSessions[token] = { username, ts: Date.now() };
    persist();
    return token;
}

// 5. Admin Panel: Ürün Fiyat ve Kodlarını Güncelleme
app.post('/api/admin/update-catalog', (req, res) => {
    const token = req.headers['x-admin-token'];
    if (!checkAdminToken(token)) return res.status(401).json({ success: false, message: 'Yetkisiz!' });

    const { id, name, serviceCode, countryCode, price } = req.body;
    if (!id) return res.json({ success: false, message: 'Ürün ID gerekli.' });

    let custom = db.customCatalog.find(c => c.id === id);
    if (custom) {
        if (name) custom.name = name;
        if (serviceCode) custom.serviceCode = serviceCode;
        if (countryCode) custom.countryCode = countryCode;
        if (price !== undefined) custom.price = parseFloat(price);
    } else {
        db.customCatalog.push({ id, name: name || id, serviceCode: serviceCode || 'wa', countryCode: countryCode || '62', price: parseFloat(price) || 100 });
    }
    persist();
    res.json({ success: true, message: 'Ürün güncellendi.' });
});

// Sunucuyu Başlat
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[Server] Anka SMS Panel ${PORT} portunda aktif! Sürüm: ${APP_VERSION}`);
});
