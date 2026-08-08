const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const phoneUtil = require('google-libphonenumber').PhoneNumberUtil.getInstance();
const cron = require('node-cron');
const settings = require('./settings');

// ============================================================
// 📱 WHATSAPP SENDER MANAGER (BAILEYS + PAIRING CODE)
// ============================================================
const P = require('pino');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    DisconnectReason,
    delay
} = require('@whiskeysockets/baileys');

// --- KONFIGURASI FILE & FOLDER ---
const SENDER_FILE = './senders.json';
const DATA_DIR = path.join(__dirname, "countries");
const GROUPS_FILE = './groups.json';
const SESSIONS_DIR = './sessions';
const USER_DATA_FILE = './users.json';
const TRAFFIC_FILE = './traffic.json';

// --- FUNGSI AUTO-CREATE FILE/FOLDER ---
const initFiles = () => {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR);
        console.log("📁 Folder 'countries' berhasil dibuat.");
    }
    if (!fs.existsSync(SENDER_FILE)) {
        fs.writeFileSync(SENDER_FILE, JSON.stringify({}, null, 2));
        console.log("📄 File 'senders.json' berhasil dibuat.");
    }
    if (!fs.existsSync(GROUPS_FILE)) {
        fs.writeFileSync(GROUPS_FILE, JSON.stringify([], null, 2));
        console.log("📄 File 'groups.json' berhasil dibuat.");
    }
    if (!fs.existsSync(SESSIONS_DIR)) {
        fs.mkdirSync(SESSIONS_DIR);
        console.log("📁 Folder 'sessions' berhasil dibuat.");
    }
    if (!fs.existsSync(USER_DATA_FILE)) {
        fs.writeFileSync(USER_DATA_FILE, JSON.stringify({ users: [] }, null, 2));
        console.log("📄 File 'users.json' berhasil dibuat.");
    }
    if (!fs.existsSync(TRAFFIC_FILE)) {
        fs.writeFileSync(TRAFFIC_FILE, JSON.stringify({ daily: {}, lastReset: Date.now() }, null, 2));
        console.log("📄 File 'traffic.json' berhasil dibuat.");
    }
};

initFiles();

const bot = new TelegramBot(settings.BOT_TOKEN, { polling: true });
const userSession = new Map();
const seen_otps = new Set();
const lastBotMessage = new Map();
const takenNumbers = new Map();

// Session per user (WhatsApp)
const userSessions = new Map();
const userPairingState = new Map();

// --- HELPER UTILS ---
const isPrivate = (msg) => msg.chat.type === 'private';

const getGroups = () => {
    try { return JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8')); } catch (e) { return settings.GROUPS || []; }
};

const getUsers = () => {
    try {
        const data = JSON.parse(fs.readFileSync(USER_DATA_FILE, 'utf8'));
        return data.users || [];
    } catch (e) { return []; }
};

const addUser = (userId) => {
    const data = JSON.parse(fs.readFileSync(USER_DATA_FILE, 'utf8'));
    if (!data.users.includes(userId)) {
        data.users.push(userId);
        fs.writeFileSync(USER_DATA_FILE, JSON.stringify(data, null, 2));
    }
};

const getTotalUsers = () => {
    try {
        const data = JSON.parse(fs.readFileSync(USER_DATA_FILE, 'utf8'));
        return data.users.length;
    } catch (e) { return 0; }
};

const sendBQ = async (chatId, text, options = {}) => {
    return bot.sendMessage(chatId, `<blockquote>${text}</blockquote>`, { parse_mode: 'HTML', ...options });
};

const clearBotChat = (chatId) => {
    if (lastBotMessage.has(chatId)) {
        bot.deleteMessage(chatId, lastBotMessage.get(chatId)).catch(() => {});
        lastBotMessage.delete(chatId);
    }
};

const sendClean = async (chatId, text, options = {}, forceDelete = true) => {
    if (forceDelete) clearBotChat(chatId);
    const sent = await bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...options });
    lastBotMessage.set(chatId, sent.message_id);
};

// --- FORCE JOIN DYNAMIC ---
const isJoined = async (userId) => {
    if (userId === settings.OWNER_ID) return true;
    const targets = [...(settings.CHANNELS || []), ...getGroups()];
    if (targets.length === 0) return true;
    for (const target of targets) {
        try {
            const member = await bot.getChatMember(target, userId);
            if (['left', 'kicked', 'restricted'].includes(member.status)) return false;
        } catch (e) { continue; }
    }
    return true;
};

const getJoinKeyboard = () => {
    const inline_keyboard = [];
    const targets = [...(settings.CHANNELS || []), ...getGroups()];

    const createJoinUrl = (target) => {
        const t = target.toString();
        return t.startsWith('@') ? `https://t.me/${t.replace('@', '')}` : `https://t.me/c/${t.replace('-100', '')}/1`;
    };

    if (targets.length >= 2) {
        inline_keyboard.push([
            { text: "CH METODE", url: createJoinUrl(targets[0]), style: "primary" },
            { text: "CH NUMBER", url: createJoinUrl(targets[1]), style: "primary" }
        ]);
    }
    if (targets.length >= 4) {
        inline_keyboard.push([
            { text: "GRUP OTP", url: createJoinUrl(targets[2]), style: "primary" },
            { text: "GRUP CHAT", url: createJoinUrl(targets[3]), style: "primary" }
        ]);
    }
    if (targets.length >= 5) {
        inline_keyboard.push([
            { text: "CH INFORMASI", url: createJoinUrl(targets[4]), style: "primary" }
        ]);
    }
    inline_keyboard.push([{ text: "✅ KONFIRMASI", callback_data: "check_join", style: "success" }]);

    return { inline_keyboard };
};

const checkAccess = async (msg) => {
    if (await isJoined(msg.from.id)) return true;

    sendClean(msg.chat.id, "⚠️ <b>SILAHKAN JOIN SEMUA CHANNEL & GRUP TERLEBIH DAHULU!</b>", {
        reply_markup: getJoinKeyboard()
    });
    return false;
};

// --- CORE LOGIC ---
const extractOtp = (msg) => {
    if (!msg) return null;
    const match = msg.toString().match(/(\d{3})[- ]?(\d{3})/);
    return match ? `${match[1]}${match[2]}` : msg.toString().replace(/[^0-9]/g, '').slice(0, 6);
};

const maskNumber = (num) => {
    const rawNum = num.toString().replace(/[^0-9]/g, '');
    return rawNum.length > 7 ? `+${rawNum.substring(0, 4)}XXXX${rawNum.slice(-3)}` : `+${rawNum}`;
};

const detectOperator = (num) => {
    if (num.startsWith("62811") || num.startsWith("62812") || num.startsWith("62813")) return "Telkomsel";
    if (num.startsWith("62857") || num.startsWith("62858")) return "Indosat";
    return "Lainnya";
};

// ============================================================
// 🏴 FLAG EMOJI LENGKAP
// ============================================================
const flagEmoji = {
    'ID': '🇮🇩', 'MY': '🇲🇾', 'SG': '🇸🇬', 'TH': '🇹🇭', 'VN': '🇻🇳',
    'PH': '🇵🇭', 'BD': '🇧🇩', 'PK': '🇵🇰', 'IN': '🇮🇳', 'LK': '🇱🇰',
    'NP': '🇳🇵', 'MM': '🇲🇲', 'KH': '🇰🇭', 'LA': '🇱🇦', 'BN': '🇧🇳',
    'TL': '🇹🇱', 'CN': '🇨🇳', 'JP': '🇯🇵', 'KR': '🇰🇷', 'TW': '🇹🇼',
    'HK': '🇭🇰', 'MO': '🇲🇴', 'KP': '🇰🇵', 'MN': '🇲🇳', 'AF': '🇦🇫',
    'AM': '🇦🇲', 'AZ': '🇦🇿', 'BH': '🇧🇭', 'BT': '🇧🇹', 'CY': '🇨🇾',
    'GE': '🇬🇪', 'IQ': '🇮🇶', 'IR': '🇮🇷', 'IL': '🇮🇱', 'JO': '🇯🇴',
    'KW': '🇰🇼', 'LB': '🇱🇧', 'MV': '🇲🇻', 'OM': '🇴🇲', 'PS': '🇵🇸',
    'QA': '🇶🇦', 'SA': '🇸🇦', 'SY': '🇸🇾', 'TR': '🇹🇷', 'AE': '🇦🇪',
    'YE': '🇾🇪', 'KZ': '🇰🇿', 'KG': '🇰🇬', 'TJ': '🇹🇯', 'TM': '🇹🇲',
    'UZ': '🇺🇿',
    'GB': '🇬🇧', 'FR': '🇫🇷', 'DE': '🇩🇪', 'IT': '🇮🇹', 'ES': '🇪🇸',
    'PT': '🇵🇹', 'NL': '🇳🇱', 'BE': '🇧🇪', 'CH': '🇨🇭', 'AT': '🇦🇹',
    'SE': '🇸🇪', 'NO': '🇳🇴', 'DK': '🇩🇰', 'FI': '🇫🇮', 'IE': '🇮🇪',
    'PL': '🇵🇱', 'CZ': '🇨🇿', 'HU': '🇭🇺', 'RO': '🇷🇴', 'BG': '🇧🇬',
    'GR': '🇬🇷', 'UA': '🇺🇦', 'BY': '🇧🇾', 'RU': '🇷🇺', 'LT': '🇱🇹',
    'LV': '🇱🇻', 'EE': '🇪🇪', 'MD': '🇲🇩', 'AL': '🇦🇱', 'AD': '🇦🇩',
    'BA': '🇧🇦', 'HR': '🇭🇷', 'IS': '🇮🇸', 'LI': '🇱🇮', 'LU': '🇱🇺',
    'MK': '🇲🇰', 'MT': '🇲🇹', 'MC': '🇲🇨', 'ME': '🇲🇪', 'RS': '🇷🇸',
    'SK': '🇸🇰', 'SI': '🇸🇮', 'SM': '🇸🇲', 'VA': '🇻🇦',
    'US': '🇺🇸', 'CA': '🇨🇦', 'MX': '🇲🇽', 'BR': '🇧🇷', 'AR': '🇦🇷',
    'CL': '🇨🇱', 'CO': '🇨🇴', 'PE': '🇵🇪', 'VE': '🇻🇪', 'BO': '🇧🇴',
    'PY': '🇵🇾', 'UY': '🇺🇾', 'EC': '🇪🇨', 'GY': '🇬🇾', 'SR': '🇸🇷',
    'BZ': '🇧🇿', 'CR': '🇨🇷', 'SV': '🇸🇻', 'GT': '🇬🇹', 'HN': '🇭🇳',
    'NI': '🇳🇮', 'PA': '🇵🇦', 'CU': '🇨🇺', 'DO': '🇩🇴', 'HT': '🇭🇹',
    'JM': '🇯🇲', 'TT': '🇹🇹', 'BS': '🇧🇸', 'BB': '🇧🇧', 'DM': '🇩🇲',
    'GD': '🇬🇩', 'LC': '🇱🇨', 'VC': '🇻🇨', 'AG': '🇦🇬', 'KN': '🇰🇳',
    'PR': '🇵🇷',
    'EG': '🇪🇬', 'MA': '🇲🇦', 'DZ': '🇩🇿', 'TN': '🇹🇳', 'LY': '🇱🇾',
    'NG': '🇳🇬', 'GH': '🇬🇭', 'KE': '🇰🇪', 'TZ': '🇹🇿', 'UG': '🇺🇬',
    'ZA': '🇿🇦', 'BF': '🇧🇫', 'CI': '🇨🇮', 'SN': '🇸🇳', 'ML': '🇲🇱',
    'AO': '🇦🇴', 'BJ': '🇧🇯', 'BW': '🇧🇼', 'BI': '🇧🇮', 'CM': '🇨🇲',
    'CV': '🇨🇻', 'CF': '🇨🇫', 'TD': '🇹🇩', 'KM': '🇰🇲', 'CG': '🇨🇬',
    'CD': '🇨🇩', 'DJ': '🇩🇯', 'GQ': '🇬🇶', 'ER': '🇪🇷', 'SZ': '🇸🇿',
    'ET': '🇪🇹', 'GA': '🇬🇦', 'GM': '🇬🇲', 'GN': '🇬🇳', 'GW': '🇬🇼',
    'LR': '🇱🇷', 'LS': '🇱🇸', 'MG': '🇲🇬', 'MW': '🇲🇼', 'MR': '🇲🇷',
    'MU': '🇲🇺', 'MZ': '🇲🇿', 'NA': '🇳🇦', 'NE': '🇳🇪', 'RW': '🇷🇼',
    'ST': '🇸🇹', 'SC': '🇸🇨', 'SL': '🇸🇱', 'SO': '🇸🇴', 'SS': '🇸🇸',
    'SD': '🇸🇩', 'TG': '🇹🇬', 'ZM': '🇿🇲', 'ZW': '🇿🇼',
    'AU': '🇦🇺', 'NZ': '🇳🇿', 'FJ': '🇫🇯', 'PG': '🇵🇬', 'SB': '🇸🇧',
    'VU': '🇻🇺', 'WS': '🇼🇸', 'TO': '🇹🇴', 'TV': '🇹🇻', 'NR': '🇳🇷',
    'PW': '🇵🇼', 'MH': '🇲🇭', 'FM': '🇫🇲', 'KI': '🇰🇮'
};

function getCountryFlag(countryCode) {
    return flagEmoji[countryCode.toUpperCase()] || '🌍';
}

function getCountryName(countryCode) {
    const names = {
        'ID': 'Indonesia', 'MY': 'Malaysia', 'SG': 'Singapura', 'TH': 'Thailand',
        'VN': 'Vietnam', 'PH': 'Filipina', 'BD': 'Bangladesh', 'PK': 'Pakistan',
        'IN': 'India', 'LK': 'Sri Lanka', 'NP': 'Nepal', 'MM': 'Myanmar',
        'KH': 'Kamboja', 'LA': 'Laos', 'BN': 'Brunei', 'TL': 'Timor Leste',
        'CN': 'China', 'JP': 'Jepang', 'KR': 'Korea Selatan', 'TW': 'Taiwan',
        'HK': 'Hong Kong', 'MO': 'Makau', 'KP': 'Korea Utara', 'MN': 'Mongolia',
        'AF': 'Afghanistan', 'AM': 'Armenia', 'AZ': 'Azerbaijan', 'BH': 'Bahrain',
        'BT': 'Bhutan', 'CY': 'Siprus', 'GE': 'Georgia', 'IQ': 'Irak',
        'IR': 'Iran', 'IL': 'Israel', 'JO': 'Yordania', 'KW': 'Kuwait',
        'LB': 'Lebanon', 'MV': 'Maladewa', 'OM': 'Oman', 'PS': 'Palestina',
        'QA': 'Qatar', 'SA': 'Arab Saudi', 'SY': 'Suriah', 'TR': 'Turki',
        'AE': 'Uni Emirat Arab', 'YE': 'Yaman', 'KZ': 'Kazakhstan',
        'KG': 'Kyrgyzstan', 'TJ': 'Tajikistan', 'TM': 'Turkmenistan', 'UZ': 'Uzbekistan',
        'GB': 'Inggris', 'FR': 'Prancis', 'DE': 'Jerman', 'IT': 'Italia',
        'ES': 'Spanyol', 'PT': 'Portugal', 'NL': 'Belanda', 'BE': 'Belgia',
        'CH': 'Swiss', 'AT': 'Austria', 'SE': 'Swedia', 'NO': 'Norwegia',
        'DK': 'Denmark', 'FI': 'Finlandia', 'IE': 'Irlandia', 'PL': 'Polandia',
        'CZ': 'Ceko', 'HU': 'Hungaria', 'RO': 'Rumania', 'BG': 'Bulgaria',
        'GR': 'Yunani', 'UA': 'Ukraina', 'BY': 'Belarus', 'RU': 'Rusia',
        'LT': 'Lithuania', 'LV': 'Latvia', 'EE': 'Estonia', 'MD': 'Moldova',
        'AL': 'Albania', 'AD': 'Andorra', 'BA': 'Bosnia', 'HR': 'Kroasia',
        'IS': 'Islandia', 'LI': 'Liechtenstein', 'LU': 'Luksemburg',
        'MK': 'Makedonia', 'MT': 'Malta', 'MC': 'Monako', 'ME': 'Montenegro',
        'RS': 'Serbia', 'SK': 'Slovakia', 'SI': 'Slovenia', 'SM': 'San Marino',
        'VA': 'Vatikan',
        'US': 'Amerika Serikat', 'CA': 'Kanada', 'MX': 'Meksiko',
        'BR': 'Brasil', 'AR': 'Argentina', 'CL': 'Chili',
        'CO': 'Kolombia', 'PE': 'Peru', 'VE': 'Venezuela',
        'BO': 'Bolivia', 'PY': 'Paraguay', 'UY': 'Uruguay',
        'EC': 'Ekuador', 'GY': 'Guyana', 'SR': 'Suriname',
        'BZ': 'Belize', 'CR': 'Kosta Rika', 'SV': 'El Salvador',
        'GT': 'Guatemala', 'HN': 'Honduras', 'NI': 'Nikaragua',
        'PA': 'Panama', 'CU': 'Kuba', 'DO': 'Republik Dominika',
        'HT': 'Haiti', 'JM': 'Jamaika', 'TT': 'Trinidad & Tobago',
        'BS': 'Bahama', 'BB': 'Barbados', 'DM': 'Dominika',
        'GD': 'Grenada', 'LC': 'Saint Lucia', 'VC': 'Saint Vincent',
        'AG': 'Antigua', 'KN': 'Saint Kitts', 'PR': 'Puerto Rico',
        'EG': 'Mesir', 'MA': 'Maroko', 'DZ': 'Aljazair',
        'TN': 'Tunisia', 'LY': 'Libya', 'NG': 'Nigeria',
        'GH': 'Ghana', 'KE': 'Kenya', 'TZ': 'Tanzania',
        'UG': 'Uganda', 'ZA': 'Afrika Selatan', 'BF': 'Burkina Faso',
        'CI': 'Pantai Gading', 'SN': 'Senegal', 'ML': 'Mali',
        'AO': 'Angola', 'BJ': 'Benin', 'BW': 'Botswana',
        'BI': 'Burundi', 'CM': 'Kamerun', 'CV': 'Tanjung Verde',
        'CF': 'Republik Afrika Tengah', 'TD': 'Chad', 'KM': 'Komoro',
        'CG': 'Kongo', 'CD': 'Kongo DR', 'DJ': 'Djibouti',
        'GQ': 'Guinea Ekuatorial', 'ER': 'Eritrea', 'SZ': 'Eswatini',
        'ET': 'Ethiopia', 'GA': 'Gabon', 'GM': 'Gambia',
        'GN': 'Guinea', 'GW': 'Guinea-Bissau', 'LR': 'Liberia',
        'LS': 'Lesotho', 'MG': 'Madagaskar', 'MW': 'Malawi',
        'MR': 'Mauritania', 'MU': 'Mauritius', 'MZ': 'Mozambik',
        'NA': 'Namibia', 'NE': 'Niger', 'RW': 'Rwanda',
        'ST': 'Sao Tome', 'SC': 'Seychelles', 'SL': 'Sierra Leone',
        'SO': 'Somalia', 'SS': 'Sudan Selatan', 'SD': 'Sudan',
        'TG': 'Togo', 'ZM': 'Zambia', 'ZW': 'Zimbabwe',
        'AU': 'Australia', 'NZ': 'Selandia Baru', 'FJ': 'Fiji',
        'PG': 'Papua Nugini', 'SB': 'Kepulauan Solomon',
        'VU': 'Vanuatu', 'WS': 'Samoa', 'TO': 'Tonga',
        'TV': 'Tuvalu', 'NR': 'Nauru', 'PW': 'Palau',
        'MH': 'Kepulauan Marshall', 'FM': 'Mikronesia', 'KI': 'Kiribati'
    };
    return names[countryCode.toUpperCase()] || countryCode.toUpperCase();
}

function getAllCountries() {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.txt'));
    return files.map(file => {
        const code = file.replace('.txt', '').toUpperCase();
        return {
            code: code,
            flag: getCountryFlag(code),
            name: getCountryName(code),
            file: file
        };
    });
}

// ============================================================
// 📊 TRAFFIC PER HARI (RESET 00:00)
// ============================================================
function getDailyTraffic() {
    const data = JSON.parse(fs.readFileSync(TRAFFIC_FILE, 'utf8'));
    const today = new Date().toDateString();
    const lastReset = new Date(data.lastReset).toDateString();

    if (lastReset !== today) {
        data.daily = {};
        data.lastReset = Date.now();
        fs.writeFileSync(TRAFFIC_FILE, JSON.stringify(data, null, 2));
    }
    return data.daily;
}

function addTraffic(countryCode) {
    const data = JSON.parse(fs.readFileSync(TRAFFIC_FILE, 'utf8'));
    const today = new Date().toDateString();
    const lastReset = new Date(data.lastReset).toDateString();

    if (lastReset !== today) {
        data.daily = {};
        data.lastReset = Date.now();
    }

    data.daily[countryCode] = (data.daily[countryCode] || 0) + 1;
    fs.writeFileSync(TRAFFIC_FILE, JSON.stringify(data, null, 2));
}

function getTrafficStats() {
    const daily = getDailyTraffic();
    const sorted = Object.entries(daily).sort((a, b) => b[1] - a[1]);
    const total = sorted.reduce((sum, [_, count]) => sum + count, 0);
    return { sorted, total };
}

function getCountryInfo(phone) {
    try {
        const cleanPhone = phone.toString().replace(/[^0-9]/g, '');
        const number = phoneUtil.parse("+" + cleanPhone);
        const regionCode = phoneUtil.getRegionCodeForNumber(number);
        if (regionCode) return regionCode;
    } catch (e) {}
    return "UNKNOWN";
}

// ============================================================
// 📂 FUNGSI CEK UMUR FILE
// ============================================================
function getFileAge(filePath) {
    const stats = fs.statSync(filePath);
    const now = Date.now();
    return (now - stats.birthtimeMs) / (1000 * 60 * 60);
}

// ============================================================
// 📱 WHATSAPP SENDER FUNCTIONS
// ============================================================
async function startWASession(userId) {
    const sessionPath = path.join(SESSIONS_DIR, String(userId));

    if (fs.existsSync(sessionPath)) {
        try {
            await useMultiFileAuthState(sessionPath);
        } catch (e) {
            console.log(`⚠️ Session user ${userId} corrupt, menghapus...`);
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }
    }

    if (!fs.existsSync(sessionPath)) {
        fs.mkdirSync(sessionPath, { recursive: true });
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            logger: P({ level: 'silent' }),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' }))
            },
            browser: ['Ubuntu', 'Chrome', '20.0.04']
        });

        userSessions.set(String(userId), sock);

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'open') {
                console.log(`✅ WhatsApp user ${userId} terhubung!`);
                userPairingState.set(String(userId), 'connected');

                const alreadySent = userPairingState.get(String(userId) + '_notified');
                if (!alreadySent) {
                    await bot.sendMessage(userId,
                        `╭━━━〔 ✅ WHATSAPP TERHUBUNG 〕━━━╮
│
├─ WhatsApp berhasil terhubung!
├─ Sekarang Anda bisa cek bio nomor
├─ secara otomatis saat GET NUMBER.
│
╰━━━〔 🚀 SELAMAT MENGGUNAKAN 〕━━━╯`, {
                        parse_mode: 'HTML'
                    }).catch(() => {});
                    userPairingState.set(String(userId) + '_notified', true);
                }
            }
            if (connection === 'close') {
                const code = lastDisconnect?.error?.output?.statusCode;
                if (code === DisconnectReason.loggedOut || code === 401 || code === 403) {
                    userPairingState.set(String(userId), 'disconnected');
                    userSessions.delete(String(userId));
                    userPairingState.delete(String(userId) + '_notified');
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                    await bot.sendMessage(userId,
                        `❌ <b>WhatsApp terputus!</b>

${code === 403 ? '⚠️ Nomor WhatsApp Anda terkena BAN/BLOCK oleh WhatsApp.' : '⚠️ Anda telah LOGOUT dari WhatsApp Web.'}

Silakan gunakan menu <b>ADD WA</b> untuk menghubungkan kembali.`, {
                        parse_mode: 'HTML'
                    }).catch(() => {});
                } else {
                    userPairingState.set(String(userId), 'reconnecting');
                    setTimeout(() => startWASession(userId), 5000);
                }
            }
        });

        return sock;
    } catch (e) {
        console.error(`Error start session user ${userId}:`, e);
        return null;
    }
}

async function pairWhatsApp(userId, phoneNumber) {
    try {
        const cleanNum = phoneNumber.toString().replace(/[^0-9]/g, '');

        if (cleanNum.length < 10) {
            return { success: false, error: 'Nomor WhatsApp tidak valid (minimal 10 digit).' };
        }

        const sessionPath = path.join(SESSIONS_DIR, String(userId));
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }
        userSessions.delete(String(userId));
        userPairingState.delete(String(userId));
        userPairingState.delete(String(userId) + '_notified');

        try {
            const tempSock = makeWASocket({
                logger: P({ level: 'silent' }),
                browser: ['Ubuntu', 'Chrome', '20.0.04']
            });
            await delay(2000);
            const exists = await tempSock.onWhatsApp(cleanNum);
            if (!exists || exists.length === 0 || !exists[0]?.exists) {
                return { success: false, error: '❌ Nomor WhatsApp tidak terdaftar.\n\nPastikan nomor yang Anda masukkan benar dan memiliki akun WhatsApp aktif.' };
            }
        } catch (e) {
            console.log('⚠️ Validasi nomor gagal, tetap mencoba pairing...');
        }

        const sock = await startWASession(userId);
        if (!sock) {
            return { success: false, error: '❌ Gagal memulai session WhatsApp. Coba lagi.' };
        }

        await delay(3000);
        const code = await sock.requestPairingCode(cleanNum);

        userPairingState.set(String(userId), 'pairing');

        return {
            success: true,
            code: code,
            message:
                `╭━━━〔 📱 PAIRING WHATSAPP 〕━━━╮
│
├─ Kode: <code>${code}</code>
├─ Masukkan kode ini di WhatsApp Web
├─ di ponsel Anda.
│
╰━━━〔 ⏳ Tunggu hingga terhubung 〕━━━╯`
        };
    } catch (e) {
        console.error(`Error pairing user ${userId}:`, e);
        const sessionPath = path.join(SESSIONS_DIR, String(userId));
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }
        userSessions.delete(String(userId));
        userPairingState.delete(String(userId));
        userPairingState.delete(String(userId) + '_notified');

        let errorMsg = e.message;
        if (errorMsg.includes('405') || errorMsg.includes('not registered')) {
            errorMsg = '❌ Nomor WhatsApp tidak valid atau tidak terdaftar.';
        } else if (errorMsg.includes('timeout')) {
            errorMsg = '⏳ Koneksi timeout. Periksa koneksi internet Anda.';
        } else if (errorMsg.includes('closed')) {
            errorMsg = '❌ Koneksi ditutup. Coba lagi dengan nomor yang valid.';
        }
        return { success: false, error: errorMsg };
    }
}

async function deleteWASession(userId) {
    const sessionPath = path.join(SESSIONS_DIR, String(userId));
    if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
    }
    userSessions.delete(String(userId));
    userPairingState.delete(String(userId));
    userPairingState.delete(String(userId) + '_notified');
    return { success: true };
}

async function checkWhatsAppBio(userId, phoneNumber) {
    try {
        const userIdStr = String(userId);
        let sock = userSessions.get(userIdStr);
        const status = userPairingState.get(userIdStr);
        if (!sock || status === 'disconnected' || status === 'reconnecting') {
            sock = await startWASession(userId);
            if (!sock) {
                return {
                    registered: false,
                    name: null,
                    bio: null,
                    error: '❌ WhatsApp tidak terhubung. Gunakan ADD WA untuk menghubungkan.'
                };
            }
            await delay(3000);
        }
        if (status !== 'connected' && status !== 'pairing') {
            return {
                registered: false,
                name: null,
                bio: null,
                error: '⏳ WhatsApp sedang menghubungkan... Tunggu sebentar.'
            };
        }
        const cleanNum = phoneNumber.toString().replace(/[^0-9]/g, '');
        try {
            const exists = await sock.onWhatsApp(cleanNum);
            if (!exists || exists.length === 0 || !exists[0]?.exists) {
                return { registered: false, name: null, bio: null };
            }
            const jidResult = exists[0].jid;
            let name = null;
            let bio = null;
            try {
                const profile = await sock.getProfile(jidResult);
                if (profile) {
                    name = profile.name || null;
                    bio = profile.bio || null;
                }
            } catch (e) {}
            try {
                const statusData = await sock.fetchStatus(jidResult);
                if (statusData) {
                    bio = statusData.status || bio;
                }
            } catch (e) {}
            return {
                registered: true,
                name: name,
                bio: bio,
                jid: jidResult
            };
        } catch (e) {
            if (e.message?.includes('not found') || e.message?.includes('404')) {
                return { registered: false, name: null, bio: null };
            }
            return { registered: false, name: null, bio: null, error: e.message };
        }
    } catch (e) {
        return { registered: false, name: null, bio: null, error: e.message };
    }
}

async function checkMultipleNumbers(userId, numbers, progressCallback) {
    const results = [];
    const total = numbers.length;
    for (let i = 0; i < total; i++) {
        const num = numbers[i];
        const result = await checkWhatsAppBio(userId, num);
        results.push({
            number: num,
            ...result
        });
        if (progressCallback) {
            const percent = Math.round(((i + 1) / total) * 100);
            const filled = Math.round((percent / 100) * 10);
            const empty = 10 - filled;
            const bar = '▰'.repeat(filled) + '▱'.repeat(empty);
            await progressCallback(percent, bar);
        }
        if (i < total - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    return results;
}

function getSenderStatus(userId) {
    const status = userPairingState.get(String(userId));
    return status || 'disconnected';
}

// ============================================================
// 📞 SHOW NUMBERS (DENGAN CEK WA + PROGRESS BAR)
// ============================================================
async function showNumbers(q, country) {
    if (!q.message) return;
    const { chat, message_id } = q.message;
    const userId = q.from.id;
    const filePath = path.join(DATA_DIR, `${country}.txt`);

    if (!fs.existsSync(filePath)) {
        return bot.answerCallbackQuery(q.id, { text: "❌ Data sudah tidak tersedia!", show_alert: true });
    }

    let nums = fs.readFileSync(filePath, 'utf8').split('\n').filter(n => n.trim());

    if (nums.length === 0) {
        fs.unlinkSync(filePath);
        await bot.editMessageText(`❌ Stok <b>${country.toUpperCase()}</b> habis. File telah dihapus.`, {
            chat_id: chat.id,
            message_id: message_id,
            parse_mode: 'HTML'
        });
        return bot.answerCallbackQuery(q.id, { text: "Stok habis!" });
    }

    const selected = [];
    for (let i = 0; i < Math.min(5, nums.length); i++) {
        const idx = Math.floor(Math.random() * nums.length);
        const num = nums[idx].replace(/[^0-9]/g, '');
        selected.push(num);
        takenNumbers.set(num, chat.id);
        nums.splice(idx, 1);
    }

    fs.writeFileSync(filePath, nums.join('\n'), 'utf8');

    const status = getSenderStatus(userId);
    const isWAConnected = (status === 'connected');
    const flag = getCountryFlag(country.toUpperCase());
    const countryName = getCountryName(country.toUpperCase());

    let text = `📱 <b>NOMOR ${countryName} ${flag}</b>\n\n`;
    let results = [];

    if (isWAConnected) {
        // TAMPILKAN PROGRESS
        await bot.editMessageText(
            `⚙️ <b>Fetching Profiles (0%)</b>\n▰▱▱▱▱▱▱▱▱▱\n\n<i>Mohon tunggu sebentar...</i>`,
            {
                chat_id: chat.id,
                message_id: message_id,
                parse_mode: "HTML"
            }
        );

        // CEK SATU PERSATU DENGAN PROGRESS
        for (let i = 0; i < selected.length; i++) {
            const num = selected[i];
            const result = await checkWhatsAppBio(userId, num);
            results.push({
                number: num,
                ...result
            });

            // UPDATE PROGRESS
            const percent = Math.round(((i + 1) / selected.length) * 100);
            const filled = Math.round((percent / 100) * 10);
            const empty = 10 - filled;
            const bar = '▰'.repeat(filled) + '▱'.repeat(empty);

            await bot.editMessageText(
                `⚙️ <b>Fetching Profiles (${percent}%)</b>\n${bar}\n\n<i>Mohon tunggu sebentar...</i>`,
                {
                    chat_id: chat.id,
                    message_id: message_id,
                    parse_mode: "HTML"
                }
            ).catch(() => {});
        }

        // TAMPILKAN HASIL
        results.forEach((r) => {
            const icon = r.registered ? '✅' : '❌';
            text += `${icon} +${r.number}\n`;
        });

    } else {
        selected.forEach((num) => {
            text += `📱 +${num}\n`;
        });
        text += `\n<i>💡 Ketuk "ADD WA" untuk cek bio nomor otomatis.</i>`;
    }

    text += `\n\n📦 Sisa: ${nums.length} nomor`;

    // BUILD KEYBOARD
    const kb = [];

    // Tombol SALIN SEMUA
    const allNumbers = selected.map(n => '+' + n).join('\n');
    kb.push([{
        text: "📋 SALIN SEMUA",
        copy_text: { text: allNumbers },
        style: "primary"
    }]);

    // Tombol per nomor
    if (isWAConnected && results.length > 0) {
        results.forEach((r, index) => {
            const num = selected[index];
            const style = r.registered ? 'success' : 'danger';
            const icon = r.registered ? '✅' : '❌';
            kb.push([{
                text: `${icon} +${num}`,
                copy_text: { text: '+' + num },
                style: style
            }]);
        });
    } else {
        selected.forEach(num => {
            kb.push([{
                text: `📋 +${num}`,
                copy_text: { text: '+' + num },
                style: "primary"
            }]);
        });
    }

    if (!isWAConnected) {
        kb.push([{
            text: "📱 ADD WA",
            callback_data: "add_wa_menu",
            style: "success"
        }]);
    }

    kb.push([
        { text: "🔄 GANTI NOMER", callback_data: `sel_country:${country}`, style: "primary" },
        { text: "🌍 GANTI NEGARA", callback_data: "change_range", style: "primary" }
    ]);
    kb.push([{
        text: "🔑 GRUP OTP",
        url: settings.GROUP_OTP_LINK,
        style: "danger"
    }]);

    try {
        await bot.editMessageText(text, {
            chat_id: chat.id,
            message_id: message_id,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: kb }
        });
    } catch (e) {
        console.error("Error edit message:", e);
        // FALLBACK: kirim pesan baru
        await bot.sendMessage(chat.id, text, {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: kb }
        });
    }
    bot.answerCallbackQuery(q.id).catch(() => {});
}

// ============================================================
// 📊 LIHAT STOK ALL
// ============================================================
async function handleViewAllStok(chatId) {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.txt'));
    if (files.length === 0) {
        return sendBQ(chatId, "📂 Folder data kosong.");
    }

    let text = "📊 <b>LIST ALL STOK</b>\n";
    text += "━━━━━━━━━━━━━━━━━━━━━\n";
    let totalAll = 0;

    files.forEach(file => {
        const filePath = path.join(DATA_DIR, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const count = (content.match(/\d{9,15}/g) || []).length;
        const country = file.replace('.txt', '').toUpperCase();
        const flag = getCountryFlag(country);
        const name = getCountryName(country);
        text += `${flag} ${name} : ${count} nomor\n`;
        totalAll += count;
    });

    text += "━━━━━━━━━━━━━━━━━━━━━\n";
    text += `📦 <b>Total: ${totalAll} nomor</b>`;

    const keyboard = {
        inline_keyboard: [
            [{ text: "⬅️ KEMBALI", callback_data: "admin_back_menu", style: "primary" }]
        ]
    };

    bot.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard
    });
}

// ============================================================
// 📊 TRAFFIC COMMAND
// ============================================================
async function handleTrafficCommand(chatId) {
    const waitMsg = await sendBQ(chatId, "🔄 <i>Sedang mengambil data traffic...</i>");
    try {
        const { sorted, total } = getTrafficStats();

        let text = "📊 <b>LIVE TRAFFIC & OTP COUNT</b>\n";
        text += "━━━━━━━━━━━━━━━━━━━━━\n";
        text += `📅 <b>${new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</b>\n\n`;

        if (sorted.length === 0 || total === 0) {
            text += "<i>Belum ada data OTP hari ini.</i>";
        } else {
            const top10 = sorted.slice(0, 10);
            top10.forEach(([code, count], index) => {
                const flag = getCountryFlag(code);
                const name = getCountryName(code);
                text += `${index + 1}. ${flag} ${name} : <b>${count}</b> OTP\n`;
            });
            text += `\n📦 <b>Total: ${total} OTP</b>`;
        }

        const keyboard = {
            inline_keyboard: [
                [{ text: "🔄 Refresh", callback_data: "refresh_traffic", style: "primary" }],
                [{ text: "⬅️ KEMBALI", callback_data: "admin_back_menu", style: "primary" }]
            ]
        };

        await bot.editMessageText(text, {
            chat_id: chatId,
            message_id: waitMsg.message_id,
            parse_mode: 'HTML',
            reply_markup: keyboard
        });
    } catch (e) {
        await bot.editMessageText("⚠️ Gagal mengambil data traffic.", {
            chat_id: chatId,
            message_id: waitMsg.message_id
        });
    }
}

// ============================================================
// 🗑️ AUTO DELETE FUNCTIONS
// ============================================================
async function autoDeleteOldFiles() {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.txt'));
    const deleted = [];
    const kept = [];
    const hours = settings.AUTO_DELETE_HOURS || 24;

    for (const file of files) {
        const filePath = path.join(DATA_DIR, file);
        const age = getFileAge(filePath);
        const country = file.replace('.txt', '').toUpperCase();
        const flag = getCountryFlag(country);
        const name = getCountryName(country);

        if (age > hours) {
            const content = fs.readFileSync(filePath, 'utf8');
            const count = (content.match(/\d{9,15}/g) || []).length;
            fs.unlinkSync(filePath);
            deleted.push({ file, flag, name, age, count });
        } else {
            const content = fs.readFileSync(filePath, 'utf8');
            const count = (content.match(/\d{9,15}/g) || []).length;
            kept.push({ file, flag, name, age, count });
        }
    }

    await sendDeleteReport(deleted, kept);
    return { deleted, kept };
}

async function sendDeleteReport(deleted, kept) {
    const now = new Date();
    const tanggal = now.toLocaleDateString('id-ID', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric'
    });
    const jam = now.toLocaleTimeString('id-ID', {
        hour: '2-digit',
        minute: '2-digit'
    });

    let text = `🗑️ <b>AUTO DELETE REPORT</b>\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `📅 ${tanggal} ${jam}\n\n`;

    if (deleted.length > 0) {
        text += `📂 <b>File dihapus (${deleted.length}):</b>\n`;
        deleted.forEach((item, index) => {
            const prefix = index === deleted.length - 1 ? '└' : '├';
            text += `${prefix} ${item.flag} ${item.name} (${item.count} nomor, ${item.age.toFixed(1)} jam)\n`;
        });
    } else {
        text += `📂 <b>Tidak ada file yang dihapus.</b>\n`;
    }

    if (kept.length > 0) {
        text += `\n📂 <b>File tetap (fresh):</b>\n`;
        kept.forEach((item, index) => {
            const prefix = index === kept.length - 1 ? '└' : '├';
            text += `${prefix} ${item.flag} ${item.name} (${item.count} nomor, ${item.age.toFixed(1)} jam)\n`;
        });
    }

    text += `\n━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `✅ Auto delete selesai!`;

    await bot.sendMessage(settings.OWNER_ID, text, {
        parse_mode: 'HTML'
    }).catch(() => {});
}

// ============================================================
// 📢 NOTIFIKASI STOK KE CHANNEL
// ============================================================
async function sendStokNotification(country, total) {
    const flag = getCountryFlag(country);
    const name = getCountryName(country);

    const text =
        `✅ 𝗦𝗨𝗞𝗦𝗘𝗦 𝗠𝗘𝗡𝗔𝗠𝗕𝗔𝗛𝗞𝗔𝗡 𝗡𝗢𝗠𝗢𝗥 𝗨𝗡𝗧𝗨𝗞 ${flag} ${name}
📦 𝗧𝗢𝗧𝗔𝗟: ${total} 𝗡𝗢𝗠𝗘𝗥.
BURUAN CEK MUMPUNG MASIH FRESH DAN GA NGEJAM`;

    const keyboard = {
        inline_keyboard: [
            [{ text: "📱 GET NUMBER", url: `https://t.me/otpOrvinz_bot?start=country_${country.toLowerCase()}`, style: "primary" }]
        ]
    };

    if (settings.NOTIF_CHANNEL) {
        await bot.sendMessage(settings.NOTIF_CHANNEL, text, {
            parse_mode: 'HTML',
            reply_markup: keyboard
        }).catch(() => {});
    }

    await bot.sendMessage(settings.OWNER_ID, text, {
        parse_mode: 'HTML'
    }).catch(() => {});
}

// --- MONITORING API ---
async function checkApi() {
    try {
        const { data } = await axios.get(settings.API_URL, { timeout: 8000 });
        const dataList = Array.isArray(data) ? data : (data.data || []);
        for (const item of dataList.reverse()) {
            if (!item || !Array.isArray(item)) continue;
            const rawNum = (item[1] || "").toString().replace(/[^0-9]/g, '');
            const otp = extractOtp(item[2]);
            const uid = `${rawNum}_${otp}`.slice(0, 50);
            if (seen_otps.has(uid) || rawNum === "" || !otp) continue;
            seen_otps.add(uid);

            // Update daily traffic
            const country = getCountryInfo(rawNum);
            if (country !== 'UNKNOWN') {
                addTraffic(country);
            }

            handleGacha(rawNum, otp, item[0]);
            sendToGroups(rawNum, otp, item[0]);
        }
    } catch (e) {
        console.error("API Monitoring Error:", e.message);
    }
}

function handleGacha(rawNum, otp, appName) {
    for (let [num, chatId] of takenNumbers) {
        if (rawNum.endsWith(num) || num.endsWith(rawNum)) {
            const text = `🎰 <b>GACHA OTP BERHASIL!</b>\n\n📱 <b>App:</b> ${appName}\n🔢 <b>No:</b> +${rawNum}\n🔑 <b>OTP:</b> <code>${otp}</code>`;
            bot.sendMessage(chatId, text, {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: "📋 COPY OTP", copy_text: { text: String(otp) }, style: "danger" }]] }
            }).catch(() => {});
            takenNumbers.delete(num);
        }
    }
}

function sendToGroups(rawNum, otp, appName) {
    let cleanNum = rawNum.toString().replace(/[^0-9]/g, '');
    let countryCode = getCountryInfo(cleanNum);
    if (countryCode === 'UNKNOWN') countryCode = 'ID';
    const flag = getCountryFlag(countryCode);
    const countryName = getCountryName(countryCode);

    let masked = cleanNum;
    if (cleanNum.length > 7) {
        masked = cleanNum.slice(0, 4) + 'XXXX' + cleanNum.slice(-3);
    } else if (cleanNum.length > 4) {
        masked = cleanNum.slice(0, 2) + 'XX' + cleanNum.slice(-2);
    }

    const provider = detectOperator(cleanNum);

    const text = `╭─◈ <b>OTP TERDETEKSI</b>\n` +
        `│\n` +
        `├─ 📱 Aplikasi: <code>${(appName || "UNKNOWN").toUpperCase()}</code>\n` +
        `├─ ☎️ Nomor: ${flag} +${masked}\n` +
        `├─ 📶 Provider: <code>${provider}</code>\n` +
        `├─ 🌍 Negara: <code>${countryName}</code>\n` +
        `├─ 💎 Tetap fokus pada tujuan, kesuksesan sedang menunggumu.\n` +
        `│\n` +
        `╰─◈ OTP: <code>${otp}</code>`;

    const options = {
        parse_mode: "HTML",
        reply_markup: {
            inline_keyboard: [
                [{ text: "📋 COPY OTP", copy_text: { text: String(otp) }, style: "primary" }],
                [
                    { text: "PANEL", url: "https://t.me/otpOrvinz_bot", style: "primary" },
                    { text: "CEK BIO", url: "https://t.me/CEKBOIWHATSAPP_bot", style: "primary" }
                ],
                [
                    { text: "FIX MERAH", url: "https://t.me/botmerahprem_bot", style: "danger" },
                    { text: "JUAL NOKOS", url: "https://t.me/Ws_Sell_World_bot?start=ref_8448338520", style: "success" }
                ]
            ]
        }
    };

    getGroups().forEach(gid => {
        bot.sendMessage(gid, text, options)
            .then(msg => {
                setTimeout(async () => {
                    try { await bot.deleteMessage(gid, msg.message_id); } catch (e) {}
                }, 600000);
            })
            .catch(() => {});
    });
}

// ============================================================
// 🚀 CRON JOB
// ============================================================
cron.schedule('0 0 * * *', async () => {
    console.log('🗑️ Auto Delete berjalan...');
    await autoDeleteOldFiles();
    console.log('🔄 Reset daily traffic...');
    const data = JSON.parse(fs.readFileSync(TRAFFIC_FILE, 'utf8'));
    data.daily = {};
    data.lastReset = Date.now();
    fs.writeFileSync(TRAFFIC_FILE, JSON.stringify(data, null, 2));
    console.log('✅ Semua selesai!');
});

setInterval(checkApi, 2000);

// ============================================================
// 📱 MENU START / MAIN MENU
// ============================================================
async function showMainMenu(chatId, firstName, userId) {
    addUser(userId);

    const username = firstName || 'User';
    const totalUsers = getTotalUsers();
    const totalGroups = getGroups().length;
    const status = getSenderStatus(userId);
    const statusIcon = status === 'connected' ? '🟢' : '🔴';
    const statusText = status === 'connected' ? 'Terhubung' : 'Belum';

    const menuText =
        `Hallo @${username} Selamat Datang
﹌﹌﹌﹌﹌﹌﹌﹌﹌﹌﹌﹌﹌﹌
Informasi Lengkap Bot
Total User : ${totalUsers}
Total Group : ${totalGroups}
Version : 10 Unlimited
Type Code : Javascript
───────────────────
Silahkan Pilih Menu Di Keyboard nya ya

📱 WhatsApp: ${statusIcon} ${statusText}`;

    const keyboard = {
        keyboard: [
            ['☎️ GET NUMBER', '📂 GET FILE'],
            ['🛠️ LIST FITUR', '📊 TRAFFIC'],
            ['➕ ADD WA', '🗑️ HAPUS WA']
        ],
        resize_keyboard: true
    };

    try {
        await bot.sendAudio(chatId, 'https://files.catbox.moe/nmdo4w.mp3', {
            caption: menuText,
            parse_mode: 'HTML',
            reply_markup: keyboard
        });
    } catch (e) {
        bot.sendMessage(chatId, menuText, {
            parse_mode: 'HTML',
            reply_markup: keyboard
        });
    }
}

// ============================================================
// 🛠️ ADMIN PANEL
// ============================================================
function showListFitur(chatId, userId) {
    const isOwner = userId === settings.OWNER_ID;
    if (!isOwner) {
        return sendBQ(chatId, "❌ Menu ini hanya dapat digunakan Owner.");
    }

    const menuText =
        `╭━━━〔 🛠️ ADMIN PANEL 〕━━━╮
│
├ 🗑️ DEL FILE
├ 📋 LIST GRUP
├ ➕ ADD GRUP
├ 🗑️ DEL GRUP
├ 📊 LIHAT STOK ALL
├ 📢 BROADCAST
│
╰━━━〔 ⬅️ KEMBALI 〕━━━╯`;

    const keyboard = {
        inline_keyboard: [
            [{ text: "🗑️ DEL FILE", callback_data: "admin_del_file", style: "danger" }],
            [{ text: "📋 LIST GRUP", callback_data: "admin_list_grup", style: "primary" }],
            [{ text: "➕ ADD GRUP", callback_data: "admin_add_grup", style: "success" }],
            [{ text: "🗑️ DEL GRUP", callback_data: "admin_del_grup", style: "danger" }],
            [{ text: "📊 LIHAT STOK ALL", callback_data: "admin_view_all_stok", style: "primary" }],
            [{ text: "📢 BROADCAST", callback_data: "admin_broadcast", style: "success" }],
            [{ text: "⬅️ KEMBALI", callback_data: "admin_back_menu", style: "primary" }]
        ]
    };

    bot.sendMessage(chatId, menuText, {
        parse_mode: 'HTML',
        reply_markup: keyboard
    });
}

// ============================================================
// 🗑️ DEL FILE MENU
// ============================================================
function showDeleteFileMenu(chatId) {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.txt'));
    if (files.length === 0) {
        return sendBQ(chatId, "📂 Folder data kosong.");
    }

    const keyboard = [];
    files.forEach(file => {
        const country = file.replace('.txt', '').toUpperCase();
        const flag = getCountryFlag(country);
        const name = getCountryName(country);
        keyboard.push([{
            text: `${flag} ${name}`,
            callback_data: `del_file:${file}`,
            style: "danger"
        }]);
    });
    keyboard.push([{ text: "⬅️ KEMBALI", callback_data: "admin_back_menu", style: "primary" }]);

    bot.sendMessage(chatId, "🗑️ <b>Pilih file yang ingin dihapus:</b>", {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard }
    });
}

// ============================================================
// 🗑️ DEL GRUP MENU
// ============================================================
async function showDeleteGrupMenu(chatId) {
    const groups = getGroups();
    if (groups.length === 0) {
        return sendBQ(chatId, "📋 Daftar grup kosong.");
    }

    const keyboard = [];
    for (const gid of groups) {
        let name = gid;
        try {
            const chat = await bot.getChat(gid);
            name = chat.title || chat.username || gid;
        } catch (e) {
            name = gid;
        }
        keyboard.push([{
            text: `📢 ${name}`,
            callback_data: `del_grup:${gid}`,
            style: "danger"
        }]);
    }
    keyboard.push([{ text: "⬅️ KEMBALI", callback_data: "admin_back_menu", style: "primary" }]);

    bot.sendMessage(chatId, "🗑️ <b>Pilih grup yang ingin dihapus:</b>", {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard }
    });
}

// ============================================================
// 📋 LIST GRUP
// ============================================================
async function showListGrup(chatId) {
    const groups = getGroups();
    if (groups.length === 0) {
        return sendBQ(chatId, "📋 Daftar grup kosong.");
    }

    let text = "📋 <b>Daftar Grup OTP</b>\n\n";
    let index = 1;
    for (const gid of groups) {
        let name = gid;
        try {
            const chat = await bot.getChat(gid);
            name = chat.title || chat.username || gid;
        } catch (e) {
            name = gid;
        }
        text += `${index}. ${name}\n`;
        index++;
    }
    text += `\nTotal: <b>${groups.length}</b> Grup`;

    const keyboard = {
        inline_keyboard: [
            [{ text: "⬅️ KEMBALI", callback_data: "admin_back_menu", style: "primary" }]
        ]
    };

    bot.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard
    });
}

// ============================================================
// 📄 GET FILE INFO
// ============================================================
function getFileInfo(fileName) {
    const filePath = path.join(DATA_DIR, fileName);
    if (!fs.existsSync(filePath)) return "<b>❌ File tidak ditemukan.</b>";
    const stats = fs.statSync(filePath);
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(n => n.trim());
    const country = fileName.replace('.txt', '').toUpperCase();
    const flag = getCountryFlag(country);
    const name = getCountryName(country);

    return `<b>𝗜𝗡𝗙𝗢𝗥𝗠𝗔𝗦𝗜 𝗙𝗜𝗟𝗘 𝗡𝗨𝗠𝗕𝗘𝗥</b>\n\n` +
        `🌍 <b>𝗡𝗘𝗚𝗔𝗥𝗔:</b> ${flag} ${name}\n` +
        `📦 <b>𝗧𝗢𝗧𝗔𝗟 𝗡𝗢𝗠𝗘𝗥:</b> ${lines.length} baris\n` +
        `📅 <b>𝗧𝗔𝗡𝗚𝗚𝗔𝗟 𝗔𝗗𝗗:</b> ${stats.birthtime.toLocaleDateString('id-ID')}`;
}

// ============================================================
// 🌍 SHOW COUNTRY MENU
// ============================================================
function showCountryMenu(chatId, messageId) {
    const countries = getAllCountries();
    if (countries.length === 0) {
        return sendBQ(chatId, "📂 Folder data kosong.");
    }

    const keyboard = [];
    for (let i = 0; i < countries.length; i += 2) {
        const row = [{
            text: `${countries[i].flag} ${countries[i].name}`,
            callback_data: `sel_country:${countries[i].code.toLowerCase()}`,
            style: "primary"
        }];
        if (countries[i + 1]) {
            row.push({
                text: `${countries[i + 1].flag} ${countries[i + 1].name}`,
                callback_data: `sel_country:${countries[i + 1].code.toLowerCase()}`,
                style: "primary"
            });
        }
        keyboard.push(row);
    }

    const text = "🌍 <b>PILIH NEGARA:</b>";
    if (messageId) {
        bot.editMessageText(text, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard }
        }).catch(() => {});
    } else {
        sendClean(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
    }
}

// ============================================================
// 📂 HANDLE GET FILE MENU
// ============================================================
async function handleGetFileMenu(chatId) {
    if (lastBotMessage.has(chatId)) {
        bot.deleteMessage(chatId, lastBotMessage.get(chatId)).catch(() => {});
    }

    const countries = getAllCountries();
    if (countries.length === 0) return sendBQ(chatId, "📂 Folder data kosong.");

    let session = userSession.get(chatId);
    if (!session || !countries.find(c => c.code.toLowerCase() === session.selectedCountry)) {
        session = { selectedCountry: countries[0].code.toLowerCase() };
        userSession.set(chatId, session);
    }

    const selectedFile = `${session.selectedCountry}.txt`;
    const text = getFileInfo(selectedFile);

    const inline_keyboard = countries.map(country => {
        const isSelected = country.code.toLowerCase() === session.selectedCountry;
        return [{
            text: `${isSelected ? "▶️ " : ""}${country.flag} ${country.name}`,
            callback_data: `select_view:${country.file}`,
            style: "primary"
        }];
    });

    inline_keyboard.push([{ text: "📥 DOWNLOAD", callback_data: `dl_file:${selectedFile}`, style: "success" }]);
    inline_keyboard.push([{ text: "🔑 GRUP OTP", url: settings.GROUP_OTP_LINK, style: "danger" }]);

    const sent = await bot.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard }
    });
    lastBotMessage.set(chatId, sent.message_id);
}

// ============================================================
// 🎯 BOT EVENTS
// ============================================================
bot.on('callback_query', async (q) => {
    if (!q.message) return;
    const { chat, message_id } = q.message;

    try {
        if (q.data === 'check_join') {
            await bot.answerCallbackQuery(q.id, { text: "Memeriksa status..." });
            if (await isJoined(q.from.id)) {
                await bot.deleteMessage(chat.id, message_id).catch(() => {});
                showMainMenu(chat.id, q.from.first_name, q.from.id);
            } else {
                await bot.answerCallbackQuery(q.id, { text: "❌ Kamu belum bergabung di semua channel/grup wajib!", show_alert: true });
            }
        } else if (q.data === 'delete_message') {
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            await bot.answerCallbackQuery(q.id);
        } else if (q.data === 'add_wa_menu') {
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            userSession.set(chat.id, { step: 'waiting_wa_pairing' });
            sendBQ(chat.id, "📱 Masukkan nomor WhatsApp Anda.\n\nContoh: 628123456789");
            await bot.answerCallbackQuery(q.id);
        } else if (q.data.startsWith('dl_file:')) {
            const fileName = q.data.split(':')[1];
            const filePath = path.join(DATA_DIR, fileName);
            if (fs.existsSync(filePath)) {
                await bot.sendDocument(chat.id, filePath);
                await bot.answerCallbackQuery(q.id, { text: "📂 File dikirim." });
            } else {
                await bot.answerCallbackQuery(q.id, { text: "❌ File tidak ditemukan!", show_alert: true });
            }
        } else if (q.data === 'change_range') {
            showCountryMenu(chat.id, message_id);
            await bot.answerCallbackQuery(q.id);
        } else if (q.data.startsWith('sel_country:')) {
            await showNumbers(q, q.data.split(':')[1]);
        } else if (q.data.startsWith('select_view:')) {
            const selectedFile = q.data.split(':')[1];
            userSession.set(chat.id, { selectedCountry: selectedFile.replace('.txt', '') });
            const countries = getAllCountries();
            const inline_keyboard = countries.map(country => {
                const isSelected = country.file === selectedFile;
                return [{
                    text: `${isSelected ? "▶️ " : ""}${country.flag} ${country.name}`,
                    callback_data: `select_view:${country.file}`,
                    style: "primary"
                }];
            });
            inline_keyboard.push([{ text: "📥 DOWNLOAD", callback_data: `dl_file:${selectedFile}`, style: "success" }]);
            inline_keyboard.push([{ text: "🔑 GRUP OTP", url: settings.GROUP_OTP_LINK, style: "danger" }]);
            await bot.editMessageText(getFileInfo(selectedFile), {
                chat_id: chat.id,
                message_id: message_id,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard }
            });
            await bot.answerCallbackQuery(q.id);
        }
        // ADMIN MENU
        else if (q.data === 'admin_back_menu') {
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            showMainMenu(chat.id, q.from.first_name, q.from.id);
            await bot.answerCallbackQuery(q.id);
        } else if (q.data === 'admin_add_stok') {
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            sendBQ(chat.id, "📤 Kirim file TXT stok yang ingin ditambahkan.\n\nNama negara akan diambil dari nama file.");
            userSession.set(chat.id, { step: 'waiting_add_stok' });
            await bot.answerCallbackQuery(q.id);
        } else if (q.data === 'admin_del_file') {
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            showDeleteFileMenu(chat.id);
            await bot.answerCallbackQuery(q.id);
        } else if (q.data === 'admin_list_grup') {
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            await showListGrup(chat.id);
            await bot.answerCallbackQuery(q.id);
        } else if (q.data === 'admin_add_grup') {
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            sendBQ(chat.id, "📝 Masukkan ID Grup.\n\n<i>Pastikan bot sudah menjadi admin dan memiliki izin Mengelola Pesan.</i>");
            userSession.set(chat.id, { step: 'waiting_add_grup' });
            await bot.answerCallbackQuery(q.id);
        } else if (q.data === 'admin_del_grup') {
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            await showDeleteGrupMenu(chat.id);
            await bot.answerCallbackQuery(q.id);
        } else if (q.data === 'admin_view_all_stok') {
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            await handleViewAllStok(chat.id);
            await bot.answerCallbackQuery(q.id);
        } else if (q.data === 'admin_broadcast') {
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            sendBQ(chat.id, "📢 Kirimkan pesan yang ingin di-broadcast ke semua user.\n\nKirim pesan teks, foto, video, atau dokumen.");
            userSession.set(chat.id, { step: 'waiting_broadcast' });
            await bot.answerCallbackQuery(q.id);
        } else if (q.data.startsWith('del_file:')) {
            const fileName = q.data.split(':')[1];
            const filePath = path.join(DATA_DIR, fileName);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                const country = fileName.replace('.txt', '').toUpperCase();
                const flag = getCountryFlag(country);
                const name = getCountryName(country);
                const keyboard = {
                    inline_keyboard: [
                        [{ text: "⬅️ KEMBALI", callback_data: "admin_back_menu", style: "primary" }]
                    ]
                };
                await bot.editMessageText(`✅ File ${flag} <b>${name}</b> berhasil dihapus.`, {
                    chat_id: chat.id,
                    message_id: message_id,
                    parse_mode: 'HTML',
                    reply_markup: keyboard
                });
            } else {
                await bot.answerCallbackQuery(q.id, { text: "❌ File tidak ditemukan!", show_alert: true });
            }
            await bot.answerCallbackQuery(q.id);
        } else if (q.data.startsWith('del_grup:')) {
            const grupId = q.data.split(':')[1];
            userSession.set(chat.id, { step: 'confirm_del_grup', grupId: grupId });
            const keyboard = {
                inline_keyboard: [
                    [{ text: "✅ Ya", callback_data: `confirm_del_grup_yes:${grupId}`, style: "danger" }],
                    [{ text: "❌ Tidak", callback_data: "confirm_del_grup_no", style: "primary" }]
                ]
            };
            await bot.editMessageText(`⚠️ Yakin ingin menghapus grup ini?\n\n<code>${grupId}</code>`, {
                chat_id: chat.id,
                message_id: message_id,
                parse_mode: 'HTML',
                reply_markup: keyboard
            });
            await bot.answerCallbackQuery(q.id);
        } else if (q.data.startsWith('confirm_del_grup_yes:')) {
            const grupId = q.data.split(':')[1];
            let groups = getGroups();
            if (groups.includes(grupId)) {
                groups = groups.filter(id => id !== grupId);
                fs.writeFileSync(GROUPS_FILE, JSON.stringify(groups, null, 2));
                const keyboard = {
                    inline_keyboard: [
                        [{ text: "⬅️ KEMBALI", callback_data: "admin_back_menu", style: "primary" }]
                    ]
                };
                await bot.editMessageText(`✅ Grup <code>${grupId}</code> berhasil dihapus.`, {
                    chat_id: chat.id,
                    message_id: message_id,
                    parse_mode: 'HTML',
                    reply_markup: keyboard
                });
            } else {
                await bot.editMessageText(`❌ Grup <code>${grupId}</code> tidak ditemukan.`, {
                    chat_id: chat.id,
                    message_id: message_id,
                    parse_mode: 'HTML'
                });
            }
            userSession.delete(chat.id);
            await bot.answerCallbackQuery(q.id);
        } else if (q.data === 'confirm_del_grup_no') {
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            await showDeleteGrupMenu(chat.id);
            userSession.delete(chat.id);
            await bot.answerCallbackQuery(q.id);
        } else if (q.data === 'refresh_traffic') {
            await handleTrafficCommand(chat.id);
            await bot.answerCallbackQuery(q.id);
        } else if (q.data.startsWith('confirm_delete_wa')) {
            const userId = q.from.id;
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            const result = await deleteWASession(userId);
            if (result.success) {
                sendBQ(chat.id, "✅ WhatsApp berhasil dihapus dari bot.");
            } else {
                sendBQ(chat.id, "❌ Gagal menghapus WhatsApp.");
            }
            await bot.answerCallbackQuery(q.id);
        } else if (q.data.startsWith('cancel_delete_wa')) {
            await bot.deleteMessage(chat.id, message_id).catch(() => {});
            await bot.answerCallbackQuery(q.id);
        }
    } catch (e) {
        console.error("Callback Error:", e);
        bot.answerCallbackQuery(q.id, { text: "⚠️ Terjadi kesalahan.", show_alert: true }).catch(() => {});
    }
});

// ============================================================
// 🤖 BOT EVENT: MESSAGE
// ============================================================
  bot.on('message', async (msg) => {
    if (!msg.text && !msg.document && !msg.photo && !msg.video) return;

    // 🔥 CEK DULU APAKAH OWNER
    const isOwner = msg.from.id === settings.OWNER_ID;

    // HANDLE BROADCAST
    if (userSession.get(msg.from.id)?.step === 'waiting_broadcast') {
        if (!isOwner) {
            userSession.delete(msg.from.id);
            return;
        }

        const users = getUsers();
        if (users.length === 0) {
            sendBQ(msg.chat.id, "❌ Tidak ada user yang terdaftar.");
            userSession.delete(msg.from.id);
            return;
        }

        const sendMsg = await sendBQ(msg.chat.id, `📢 Mengirim broadcast ke ${users.length} user...`);

        let success = 0;
        let failed = 0;

        for (const userId of users) {
            try {
                if (msg.text) {
                    await bot.sendMessage(userId, msg.text, { parse_mode: 'HTML' });
                } else if (msg.document) {
                    await bot.sendDocument(userId, msg.document.file_id, { caption: msg.caption || '' });
                } else if (msg.photo) {
                    await bot.sendPhoto(userId, msg.photo[0].file_id, { caption: msg.caption || '' });
                } else if (msg.video) {
                    await bot.sendVideo(userId, msg.video.file_id, { caption: msg.caption || '' });
                }
                success++;
            } catch (e) {
                failed++;
            }

            // Delay 1-2 detik per nomor (biar aman dari limit WA)
const delayMs = 1000 + Math.floor(Math.random() * 1000);
await new Promise(resolve => setTimeout(resolve, delayMs));
}

        await bot.editMessageText(
            `✅ <b>Broadcast selesai!</b>\n\n📤 Terkirim: ${success} user\n❌ Gagal: ${failed} user`,
            {
                chat_id: msg.chat.id,
                message_id: sendMsg.message_id,
                parse_mode: 'HTML'
            }
        );

        userSession.delete(msg.from.id);
        return;
    }

    if (isOwner && msg.document) {
    
}

// 🔥 HANDLE ADD STOK (OWNER KIRIM FILE LANGSUNG)
if (isOwner && msg.document) {
    const mimeType = msg.document.mime_type || '';
    const fileName = msg.document.file_name || 'unknown.txt';
    
    if (mimeType.includes('text') || fileName.endsWith('.txt')) {
        let countryName = fileName.replace('.txt', '').toLowerCase().trim();
        countryName = countryName.replace(/_numbers$/i, '');
        countryName = countryName.replace(/_num$/i, '');
        countryName = countryName.replace(/_nomor$/i, '');
        countryName = countryName.replace(/_stok$/i, '');
        countryName = countryName.replace(/[^a-z]/g, '');

        if (!countryName || countryName.length < 2) {
            sendBQ(msg.chat.id, "❌ Nama file tidak valid.");
            userSession.delete(msg.from.id); // RESET SESSION
            return;
        }

        try {
            const filePath = await bot.downloadFile(msg.document.file_id, DATA_DIR);
            const fileContent = fs.readFileSync(filePath, 'utf8');
            const newNumbers = fileContent.match(/\d{9,15}/g) || [];

            if (newNumbers.length === 0) {
                sendBQ(msg.chat.id, "❌ File tidak mengandung nomor yang valid.");
                fs.unlinkSync(filePath);
                userSession.delete(msg.from.id); // RESET SESSION
                return;
            }

            const targetFile = path.join(DATA_DIR, `${countryName}.txt`);
            let existingNumbers = [];
            if (fs.existsSync(targetFile)) {
                const oldContent = fs.readFileSync(targetFile, 'utf8');
                existingNumbers = oldContent.match(/\d{9,15}/g) || [];
            }

            const allNumbers = [...existingNumbers, ...newNumbers];
            const uniqueNumbers = [...new Set(allNumbers)];

            fs.writeFileSync(targetFile, uniqueNumbers.join('\n'));
            fs.unlinkSync(filePath);

            const flag = getCountryFlag(countryName.toUpperCase());
            const name = getCountryName(countryName.toUpperCase());
            const newUniqueCount = uniqueNumbers.length - existingNumbers.length;

            await sendStokNotification(countryName.toUpperCase(), uniqueNumbers.length);

            sendBQ(msg.chat.id,
                `✅ <b>Berhasil menambahkan stok</b>\n\n` +
                `Negara : ${flag} ${name}\n` +
                `Nomor baru : ${newNumbers.length}\n` +
                `Duplikat skip : ${newNumbers.length - newUniqueCount}\n` +
                `Total unik : ${uniqueNumbers.length} nomor`
            );
            
            userSession.delete(msg.from.id); // ✅ RESET SESSION
            return;
        } catch (e) {
            sendBQ(msg.chat.id, `❌ Gagal memproses file: ${e.message}`);
            userSession.delete(msg.from.id); // ✅ RESET SESSION
            return;
        }
    }
}

    // HANDLE WAITING ADD STOK (via command /addstok)
    if (userSession.get(msg.from.id)?.step === 'waiting_add_stok') {
        if (!isOwner) {
            userSession.delete(msg.from.id);
            return;
        }
        if (!msg.document) {
            sendBQ(msg.chat.id, "⚠️ Kirimkan file TXT, bukan teks.");
            return;
        }

        const mimeType = msg.document.mime_type || '';
        const fileName = msg.document.file_name || 'unknown.txt';
        if (!mimeType.includes('text') && !fileName.endsWith('.txt')) {
            sendBQ(msg.chat.id, "⚠️ Kirimkan file TXT, bukan file lain.");
            return;
        }

        try {
            const filePath = await bot.downloadFile(msg.document.file_id, DATA_DIR);
            const countryName = fileName.replace('.txt', '').toLowerCase().trim();
            const fileContent = fs.readFileSync(filePath, 'utf8');
            const newNumbers = fileContent.match(/\d{9,15}/g) || [];

            if (newNumbers.length === 0) {
                sendBQ(msg.chat.id, "❌ File tidak mengandung nomor yang valid.");
                fs.unlinkSync(filePath);
                userSession.delete(msg.from.id);
                return;
            }

            const targetFile = path.join(DATA_DIR, `${countryName}.txt`);
            let existingNumbers = [];
            if (fs.existsSync(targetFile)) {
                const oldContent = fs.readFileSync(targetFile, 'utf8');
                existingNumbers = oldContent.match(/\d{9,15}/g) || [];
            }

            const allNumbers = [...existingNumbers, ...newNumbers];
            const uniqueNumbers = [...new Set(allNumbers)];

            fs.writeFileSync(targetFile, uniqueNumbers.join('\n'));
            fs.unlinkSync(filePath);

            const flag = getCountryFlag(countryName.toUpperCase());
            const name = getCountryName(countryName.toUpperCase());
            const newUniqueCount = uniqueNumbers.length - existingNumbers.length;

            await sendStokNotification(countryName.toUpperCase(), uniqueNumbers.length);

            sendBQ(msg.chat.id,
                `✅ <b>Berhasil menambahkan stok</b>\n\n` +
                `Negara : ${flag} ${name}\n` +
                `Nomor baru : ${newNumbers.length}\n` +
                `Duplikat skip : ${newNumbers.length - newUniqueCount}\n` +
                `Total unik : ${uniqueNumbers.length} nomor`
            );
            userSession.delete(msg.from.id);
        } catch (e) {
            sendBQ(msg.chat.id, `❌ Gagal memproses file: ${e.message}`);
            userSession.delete(msg.from.id);
        }
        return;
    }

    // HANDLE PAIRING WA
    if (userSession.get(msg.from.id)?.step === 'waiting_wa_pairing') {
        if (!isPrivate(msg)) return;
        const userId = msg.from.id;
        const phoneNumber = msg.text.replace(/[^0-9]/g, '');

        if (phoneNumber.length < 10) {
            sendBQ(msg.chat.id, "❌ Nomor tidak valid. Masukkan minimal 10 digit.\n\nContoh: 628123456789");
            return;
        }

        const status = getSenderStatus(userId);
        if (status === 'connected') {
            sendBQ(msg.chat.id, "✅ WhatsApp sudah terhubung!");
            userSession.delete(userId);
            return;
        }

        const loadingMsg = await sendBQ(msg.chat.id, "⏳ Menghubungkan WhatsApp...\n\n<i>Mohon tunggu, ini bisa memakan waktu 10-30 detik.</i>");

        try {
            const result = await pairWhatsApp(userId, phoneNumber);

            if (result.success) {
                await bot.editMessageText(result.message, {
                    chat_id: msg.chat.id,
                    message_id: loadingMsg.message_id,
                    parse_mode: 'HTML'
                });
            } else {
                await bot.editMessageText(`❌ ${result.error}`, {
                    chat_id: msg.chat.id,
                    message_id: loadingMsg.message_id,
                    parse_mode: 'HTML'
                });
            }
        } catch (e) {
            await bot.editMessageText(`❌ Terjadi kesalahan: ${e.message}`, {
                chat_id: msg.chat.id,
                message_id: loadingMsg.message_id,
                parse_mode: 'HTML'
            });
        }

        userSession.delete(userId);
        return;
    }

    // HANDLE ADD GRUP
    if (userSession.get(msg.from.id)?.step === 'waiting_add_grup') {
        if (!isOwner) {
            userSession.delete(msg.from.id);
            return;
        }
        const gid = msg.text.trim();
        if (!gid.match(/^-?\d+$/) && !gid.startsWith('@')) {
            sendBQ(msg.chat.id, "❌ ID Grup tidak valid.");
            return;
        }
        try {
            const chat = await bot.getChat(gid);
            const groups = getGroups();
            if (!groups.includes(gid)) {
                groups.push(gid);
                fs.writeFileSync(GROUPS_FILE, JSON.stringify(groups, null, 2));
                const chatTitle = chat.title || chat.username || gid;
                const keyboard = {
                    inline_keyboard: [
                        [{ text: "⬅️ KEMBALI", callback_data: "admin_back_menu", style: "primary" }]
                    ]
                };
                sendBQ(msg.chat.id, `✅ <b>Grup berhasil ditambahkan</b>\n\n📢 Nama: ${chatTitle}\n🆔 ID: <code>${gid}</code>`, { reply_markup: keyboard });
            } else {
                sendBQ(msg.chat.id, "⚠️ Grup ini sudah terdaftar sebelumnya.");
            }
        } catch (e) {
            sendBQ(msg.chat.id, `❌ Gagal menambahkan grup. Error: ${e.message}`);
        }
        userSession.delete(msg.from.id);
        return;
    }

    // COMMAND /start
    if (msg.text && msg.text.startsWith('/start')) {
        if (!isPrivate(msg)) return;
        bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});

        const args = msg.text.split(' ');
        if (args.length > 1 && args[1].startsWith('country_')) {
            const country = args[1].replace('country_', '');
            const filePath = path.join(DATA_DIR, `${country}.txt`);
            if (fs.existsSync(filePath)) {
                showCountryMenu(msg.chat.id, null);
                return;
            }
        }

        if (await checkAccess(msg)) {
            showMainMenu(msg.chat.id, msg.from.first_name, msg.from.id);
        }
        return;
    }

    // COMMAND /addstok (tanpa parameter, masuk mode waiting)
    if (msg.text && msg.text.startsWith('/addstok')) {
        if (!isOwner) return;
        
        const args = msg.text.split(' ');
        if (args.length > 1) {
            // Ada parameter nama negara
            const countryName = args[1].toLowerCase().trim();
            userSession.set(msg.from.id, { step: 'waiting_add_stok', countryName: countryName });
            sendBQ(msg.chat.id, `📤 Kirim file TXT untuk negara <b>${countryName.toUpperCase()}</b>\n\nAtau kirim file dengan nama yang sesuai (contoh: ${countryName}.txt)`);
        } else {
            // Tanpa parameter
            userSession.set(msg.from.id, { step: 'waiting_add_stok' });
            sendBQ(msg.chat.id, "📤 Kirim file TXT stok yang ingin ditambahkan.\n\nNama negara akan diambil dari nama file.");
        }
        return;
    }

    // PUBLIC COMMANDS
    if (msg.text && msg.text.startsWith('/traffic')) {
        return handleTrafficCommand(msg.chat.id);
    }

    // ADMIN COMMANDS
    if (isOwner) {
        if (msg.text && msg.text.startsWith('/listfile')) {
            const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.txt'));
            if (files.length === 0) return sendBQ(msg.chat.id, "📂 Folder data kosong.");
            let responseText = "<b>📊 LIST STOK FILE:</b>\n\n";
            files.forEach(file => {
                const filePath = path.join(DATA_DIR, file);
                const stats = fs.statSync(filePath);
                const content = fs.readFileSync(filePath, 'utf8');
                const count = (content.match(/\d{9,15}/g) || []).length;
                const date = stats.birthtime.toLocaleDateString();
                const country = file.replace('.txt', '').toUpperCase();
                const flag = getCountryFlag(country);
                const name = getCountryName(country);
                responseText += `${flag} <b>${name}</b>\n`;
                responseText += `├ 📦 ${count} nomor\n`;
                responseText += `└ 📅 ${date}\n\n`;
            });
            const keyboard = {
                inline_keyboard: [
                    [{ text: "✅ DONE", callback_data: "delete_message", style: "success" }]
                ]
            };
            const sent = await bot.sendMessage(msg.chat.id, responseText, {
                parse_mode: 'HTML',
                reply_markup: keyboard
            });
            lastBotMessage.set(msg.chat.id, sent.message_id);
            return;
        }
        if (msg.text && msg.text.startsWith('/delfile')) {
            const args = msg.text.split(' ');
            if (args.length < 2) return sendBQ(msg.chat.id, "⚠️ Gunakan format: /delfile [NAMA_NEGARA]");
            const filePath = path.join(DATA_DIR, `${args[1].toLowerCase()}.txt`);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                const flag = getCountryFlag(args[1].toUpperCase());
                const name = getCountryName(args[1].toUpperCase());
                sendBQ(msg.chat.id, `✅ File ${flag} <b>${name}</b> berhasil dihapus.`);
            } else {
                sendBQ(msg.chat.id, "❌ File tidak ditemukan.");
            }
            return;
        }
    }

    // PRIVATE CHAT ONLY - LANJUT KE MENU
    if (!isPrivate(msg)) return;
    if (!(await checkAccess(msg))) return;

    // 🔥 OWNER TIDAK DIHAPUS PESANNYA
    if (!isOwner) {
        bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
    }

    const clearBotChat = () => {
        if (lastBotMessage.has(msg.chat.id)) {
            bot.deleteMessage(msg.chat.id, lastBotMessage.get(msg.chat.id)).catch(() => {});
        }
    };
    clearBotChat();
    userSession.delete(msg.from.id);

    switch (msg.text) {
        case '☎️ GET NUMBER':
            showCountryMenu(msg.chat.id, null);
            break;
        case '📂 GET FILE':
            handleGetFileMenu(msg.chat.id);
            break;
        case '🛠️ LIST FITUR':
            showListFitur(msg.chat.id, msg.from.id);
            break;
        case '📊 TRAFFIC':
            handleTrafficCommand(msg.chat.id);
            break;
        case '➕ ADD WA':
            if (userSession.get(msg.from.id)?.step === 'waiting_wa_pairing') return;
            userSession.set(msg.from.id, { step: 'waiting_wa_pairing' });
            sendBQ(msg.chat.id, "📱 Masukkan nomor WhatsApp Anda.\n\nContoh: 628123456789");
            break;
        case '🗑️ HAPUS WA':
            const userId = msg.from.id;
            const status = getSenderStatus(userId);
            if (status !== 'connected' && status !== 'pairing') {
                sendBQ(msg.chat.id, "❌ WhatsApp belum terhubung!");
                return;
            }
            const keyboard = {
                inline_keyboard: [
                    [{ text: "✅ Ya, Hapus", callback_data: "confirm_delete_wa", style: "danger" }],
                    [{ text: "❌ Tidak", callback_data: "cancel_delete_wa", style: "primary" }]
                ]
            };
            sendBQ(msg.chat.id, "⚠️ <b>Yakin ingin menghapus WhatsApp?</b>\n\nData session akan dihapus.", {
                reply_markup: keyboard
            });
            break;
        default:
            break;
    }
});

// ============================================================
// 🚀 START BOT
// ============================================================
console.log("🤖 Bot OTP Monitor started!");
console.log(`📊 Bot running with Telegram Bot API`);
