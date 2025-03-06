const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { WebSocketServer } = require('ws');
const compression = require('compression');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(compression());
app.use(cors({
    origin: '*', // Em desenvolvimento, você pode liberar tudo. Em produção, restrinja.
    methods: ['GET', 'POST', 'DELETE', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));


const SESSIONS_PATH = '/usr/src/app/sessions';

if (!fs.existsSync(SESSIONS_PATH)) {
    fs.mkdirSync(SESSIONS_PATH, { recursive: true });
}

const clients = {};
const qrcodes = {};
const webhooks = {};
const webSockets = {};
const caches = {};
const sendQueues = {};

const CHROME_PATH = '/usr/bin/chromium';

const LOGS_PATH = path.join(__dirname, 'logs');

// Garante que a pasta de logs existe
if (!fs.existsSync(LOGS_PATH)) {
    fs.mkdirSync(LOGS_PATH, { recursive: true });
}

function log(action, data = {},) {
    const date = new Date();
    const dateStr = date.toISOString().split('T')[0]; // yyyy-mm-dd
    const logFile = path.join(LOGS_PATH, `${dateStr}.log`);

    const logEntry = `[${date.toISOString()}] [${action}] ${JSON.stringify(data)}\n`;

    fs.appendFileSync(logFile, logEntry, 'utf8');
    console.log(logEntry.trim()); // Também mostra no console, se quiser.
}

function restoreSessionsOnStartup() {
    const sessions = fs.readdirSync(SESSIONS_PATH).filter(folder => {
        const sessionPath = path.join(SESSIONS_PATH, folder);
        return fs.lstatSync(sessionPath).isDirectory();
    });

    sessions.forEach(sessionId => {
        log('RESTORING_SESSION', { sessionId });
        createClient(sessionId);  // Isso tenta reconectar
    });
}


function clearSessionFolder(sessionId, attempt = 1) {
    const sessionPath = path.join(SESSIONS_PATH, sessionId);

    if (!fs.existsSync(sessionPath)) {
        log('SESSION_FOLDER_ALREADY_CLEARED', { sessionId });
        return;
    }

    try {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        log('SESSION_FOLDER_CLEARED', { sessionId });
    } catch (err) {
        log('SESSION_FOLDER_DELETE_ERROR', { sessionId, attempt, error: err.message });

        if (attempt < 3) {
            setTimeout(() => clearSessionFolder(sessionId, attempt + 1), 2000);
        } else {
            log('SESSION_FOLDER_FINAL_DELETE_FAILED', { sessionId });
        }
    }
}


function createClient(sessionId) {
    log('SESSION_CREATE_START', { sessionId });

    if (!sendQueues[sessionId]) {
        sendQueues[sessionId] = {
            queue: [],
            lastSentAt: 0,
            sentTimestamps: [],
            cooldown: false,
            timer: null
        };
    }

    const client = new Client({
        authStrategy: new LocalAuth({
            dataPath: path.join(SESSIONS_PATH, sessionId)
        }),
        puppeteer: {
            executablePath: CHROME_PATH,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-features=VizDisplayCompositor',
                '--disable-software-rasterizer',
                '--disable-background-networking',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-breakpad',
                '--disable-client-side-phishing-detection',
                '--disable-component-extensions-with-background-pages',
                '--disable-default-apps',
                '--disable-hang-monitor',
                '--disable-ipc-flooding-protection',
                '--disable-popup-blocking',
                '--disable-prompt-on-repost',
                '--disable-renderer-backgrounding',
                '--disable-sync',
                '--force-color-profile=srgb',
                '--metrics-recording-only',
                '--no-first-run',
                '--password-store=basic',
                '--use-mock-keychain'
            ]
        }
    });

    clients[sessionId] = client;

    client.on('qr', qr => {
        qrcodes[sessionId] = qr;

        sendWebSocketMessage(sessionId, { type: 'qr', qr });

        const webhookUrl = webhooks[sessionId];
        if (webhookUrl) {
            axios.post(webhookUrl, { type: 'qr_generated', sessionId, qr }).catch(err => {
                log('WEBHOOK_ERROR', { sessionId, event: 'qr_generated', error: err.message });
            });
        }

        log('QR_GENERATED', { sessionId });
    });

    client.on('ready', async () => {
        delete qrcodes[sessionId];
        sendWebSocketMessage(sessionId, { type: 'ready' });

        caches[sessionId] = new Map();

        try {
            const chats = await client.getChats();
            chats.forEach(chat => caches[sessionId].set(chat.id._serialized, chat));
            log('SESSION_READY', { sessionId });
        } catch (err) {
            log('SESSION_READY_ERROR', { sessionId, error: err.message });
        }
    });

    client.on('message', msg => handleIncomingMessage(sessionId, msg));

    client.on('disconnected', () => {
        log('SESSION_DISCONNECTED', { sessionId });
        clearSession(sessionId);
    });

    client.initialize();
}


function handleIncomingMessage(sessionId, msg) {
    log('MESSAGE_RECEIVED', { sessionId, from: msg.from, body: msg.body });

    const event = {
        type: 'message',
        from: msg.from,
        body: msg.body,
        timestamp: msg.timestamp
    };

    if (!sendWebSocketMessage(sessionId, event)) {
        const webhookUrl = webhooks[sessionId];
        if (webhookUrl) {
            axios.post(webhookUrl, event).catch(err => {
                log('WEBHOOK_ERROR', { sessionId, error: err.message });
            });
        }
    }
}

function sendWebSocketMessage(sessionId, message) {
    const ws = webSockets[sessionId];
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(message));
        return true;
    }
    return false;
}

async function clearSession(sessionId) {
    if (clients[sessionId]) {
        try {
            await clients[sessionId].destroy();
            log('SESSION_DESTROYED', { sessionId });
        } catch (err) {
            log('SESSION_DESTROY_ERROR', { sessionId, error: err.message });
        }
        delete clients[sessionId];
    }

    delete qrcodes[sessionId];
    delete webSockets[sessionId];
    delete webhooks[sessionId];
    delete caches[sessionId];
    delete sendQueues[sessionId];

    setTimeout(() => clearSessionFolder(sessionId), 1000);
    log('SESSION_CLEARED', { sessionId });
}


function queueMessage(sessionId, number, message) {
    if (!sendQueues[sessionId]) {
        sendQueues[sessionId] = {
            queue: [],
            currentMinute: getCurrentMinute(),
            tokens: 30,
            processing: false
        };
    }

    sendQueues[sessionId].queue.push({ number, message });

    // Força disparar processamento imediatamente após enfileirar
    processQueue(sessionId);
}


function createQueueControl() {
    const control = {
        queue: [],
        currentMinute: getCurrentMinute(),
        tokens: 30, // Começa cada minuto com 30 mensagens permitidas
        processing: false
    };

    // Timer para resetar tokens a cada novo minuto
    setInterval(() => {
        const nowMinute = getCurrentMinute();
        if (nowMinute !== control.currentMinute) {
            control.currentMinute = nowMinute;
            control.tokens = 30; // Novo minuto: reseta para 30
            log('TOKEN_RESET', { nowMinute, tokens: control.tokens });
            processQueueAllSessions(); // Tenta processar todas as sessões
        }
    }, 1000);

    return control;
}

function processQueue(sessionId) {
    const sessionQueue = sendQueues[sessionId];
    if (!sessionQueue || sessionQueue.processing) {
        return; // Já está processando
    }
    
    sessionQueue.processing = true;

    const nowMinute = getCurrentMinute();

    if (nowMinute !== sessionQueue.currentMinute) {
        sessionQueue.currentMinute = nowMinute;
        sessionQueue.tokens = 30;  // Reseta tokens no novo minuto
        log('TOKEN_RESET', { sessionId, tokens: sessionQueue.tokens });
    }

    while (sessionQueue.queue.length > 0 && sessionQueue.tokens > 0) {
        const { number, message } = sessionQueue.queue.shift();
        
        sendMessage(sessionId, number, message)
            .then(() => {
                sessionQueue.tokens--;
                log('MESSAGE_SENT', { sessionId, number, message, tokensRemaining: sessionQueue.tokens });
            })
            .catch(err => {
                log('MESSAGE_SEND_FAILED', { sessionId, number, error: err.message });
            });
    }

    if (sessionQueue.tokens <= 0) {
        log('RATE_LIMIT_HIT', { sessionId });

        // Aguarda até o próximo minuto e libera a fila
        const msUntilNextMinute = getMillisecondsUntilNextMinute();
        setTimeout(() => {
            sessionQueue.processing = false;
            processQueue(sessionId);  // Tenta de novo depois do minuto virar
        }, msUntilNextMinute);
    } else {
        sessionQueue.processing = false;  // Libera a fila se sobrar tokens
    }
}


// Dispara tentativa de processamento para todas as sessões (após reset de minuto)
function processQueueAllSessions() {
    Object.keys(sendQueues).forEach(sessionId => processQueue(sessionId));
}

function getCurrentMinute() {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')} ${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
}





function sendMessage(sessionId, number, message) {
    const client = clients[sessionId];
    if (!client) return Promise.reject(new Error('Sessão não encontrada'));

    const chatId = `${number}@c.us`;
    return client.sendMessage(chatId, message)
        .then(() => {
            log('MESSAGE_SENT', { sessionId, number, message });
        });
}





app.post('/session', (req, res) => {
    const { sessionId, webhookUrl } = req.body;
    if (clients[sessionId]) {
        log('SESSION_CREATE_ERROR', { ip: req.ip, sessionId, reason: 'Já existe' });
        return res.status(400).send({ error: 'Sessão já existe.' });
    }
    createClient(sessionId);
    if (webhookUrl) webhooks[sessionId] = webhookUrl;
    res.send({ message: 'Sessão criada!' });
    log('SESSION_CREATED', { ip: req.ip, sessionId });
});

app.get('/session/:sessionId', async (req, res) => {
    const { sessionId } = req.params;

    const qr = qrcodes[sessionId];
    if (!qr) {
        log('QR_NOT_FOUND', { ip: req.ip, sessionId });
        return res.status(404).send({ error: 'QR Code não disponível ou sessão já conectada.' });
    }

    const qrImage = await qrcode.toDataURL(qr);
    res.send(`<img src="${qrImage}" alt="Escaneie o QR Code para conectar" />`);
    log('QR_FETCHED', { ip: req.ip, sessionId });
});

app.delete('/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;

    if (!clients[sessionId]) {
        log('SESSION_DELETE_ERROR', { ip: req.ip, sessionId, reason: 'Não encontrada' });
        return res.status(404).send({ error: 'Sessão não encontrada.' });
    }

    clearSession(sessionId);
    res.send({ message: `Sessão ${sessionId} removida com sucesso!` });
    log('SESSION_DELETED', { ip: req.ip, sessionId });
});

app.post('/session/:sessionId/send-message', (req, res) => {
    const { sessionId } = req.params;
    const { number, message } = req.body;
    const client = clients[sessionId];
    if (!client) {
        log('MESSAGE_SEND_ERROR', { ip: req.ip, sessionId, reason: 'Sessão não encontrada' });
        return res.status(404).send({ error: 'Sessão não encontrada.' });
    }

    queueMessage(sessionId, number, message);
    res.send({ message: 'Mensagem enfileirada para envio!' });
    log('MESSAGE_QUEUED', { ip: req.ip, sessionId, number, message });
});



app.get('/sessions', (req, res) => {
    const activeSessions = Object.keys(clients).map(sessionId => ({
        sessionId,
        connected: !!(clients[sessionId] && clients[sessionId].info),
        webhookUrl: webhooks[sessionId] || null
    }));

    res.json({ sessions: activeSessions });
    log('SESSIONS_LISTED', { ip: req.ip, count: activeSessions.length });
});

const server = app.listen(3000, () => {
    log('SERVER_STARTED', { port: 3000 });
    restoreSessionsOnStartup(); // <- Chama ao iniciar
});


const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
    const sessionId = new URL(req.url, `http://${req.headers.host}`).searchParams.get('sessionId');
    if (!sessionId || !clients[sessionId]) {
        ws.close();
        return;
    }
    webSockets[sessionId] = ws;
    ws.send(JSON.stringify({ type: 'connected', sessionId }));
    ws.on('close', () => delete webSockets[sessionId]);
    log('WEBSOCKET_CONNECTED', { sessionId });
});
