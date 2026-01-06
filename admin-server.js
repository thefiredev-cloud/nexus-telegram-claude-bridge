#!/usr/bin/env node
/**
 * NEXUS - Telegram-Claude Bridge Admin Panel
 * Runs on localhost:3000
 *
 * Security Features:
 * - Token-based authentication (auto-generated)
 * - Rate limiting
 * - CSRF protection
 * - Safe process management (no command injection)
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { WebSocketServer } = require('ws');
const chokidar = require('chokidar');

const app = express();
const PORT = 3000;

// File paths
const BRIDGE_DIR = __dirname;
const HEALTH_FILE = path.join(BRIDGE_DIR, 'health.json');
const MESSAGES_FILE = path.join(BRIDGE_DIR, 'messages.json');
const LOG_FILE = path.join(BRIDGE_DIR, 'bridge.log');
const ADMIN_TOKEN_FILE = path.join(BRIDGE_DIR, '.admin-token');
const ADMIN_LOG_FILE = path.join(BRIDGE_DIR, 'admin.log');

// ============================================
// LOGGING
// ============================================

function log(level, message, data = '') {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level}] ${message} ${typeof data === 'object' ? JSON.stringify(data) : data}`;
    console.log(line);
    try {
        fs.appendFileSync(ADMIN_LOG_FILE, line + '\n');
    } catch (e) {
        console.error('Failed to write admin log:', e.message);
    }
}

// ============================================
// AUTHENTICATION
// ============================================

function getOrCreateAdminToken() {
    try {
        if (fs.existsSync(ADMIN_TOKEN_FILE)) {
            const token = fs.readFileSync(ADMIN_TOKEN_FILE, 'utf8').trim();
            if (token.length >= 32) {
                return token;
            }
        }
    } catch (e) {
        log('WARN', 'Failed to read admin token file:', e.message);
    }

    // Generate new token
    const token = crypto.randomBytes(32).toString('hex');
    try {
        fs.writeFileSync(ADMIN_TOKEN_FILE, token);
        console.log('\n' + '='.repeat(60));
        console.log('  NEXUS Admin Token (save this!)');
        console.log('  ' + token);
        console.log('='.repeat(60) + '\n');
    } catch (e) {
        log('ERROR', 'Failed to save admin token:', e.message);
    }
    return token;
}

const ADMIN_TOKEN = getOrCreateAdminToken();

// CSRF token storage (in-memory, cleared on restart)
const csrfTokens = new Map();

function generateCsrfToken(sessionId) {
    const token = crypto.randomBytes(32).toString('hex');
    csrfTokens.set(sessionId, { token, expires: Date.now() + 3600000 }); // 1 hour

    // Clean expired tokens
    for (const [key, value] of csrfTokens) {
        if (value.expires < Date.now()) csrfTokens.delete(key);
    }
    return token;
}

function verifyCsrfToken(sessionId, token) {
    const stored = csrfTokens.get(sessionId);
    return stored && stored.token === token && stored.expires > Date.now();
}

// ============================================
// MIDDLEWARE
// ============================================

// Security headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            connectSrc: ["'self'", "ws://localhost:3000"]
        }
    }
}));

app.use(cookieParser());
app.use(express.json());

// General rate limiting - 100 requests per 15 minutes
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false
});

// Strict rate limiting for sensitive endpoints - 10 requests per 15 minutes
const strictLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Too many attempts. Please wait.' },
    standardHeaders: true,
    legacyHeaders: false
});

// Authentication middleware
const authMiddleware = (req, res, next) => {
    // Skip auth for login endpoint (path is relative to /api mount point)
    if (req.path === '/login') {
        return next();
    }

    const token = req.headers['x-admin-token'] ||
                  req.query.token ||
                  req.cookies?.adminToken;

    if (token === ADMIN_TOKEN) {
        return next();
    }

    log('WARN', 'Unauthorized access attempt', { path: req.path, ip: req.ip });
    res.status(401).json({ error: 'Unauthorized. Provide valid admin token.' });
};

// CSRF middleware for state-changing requests
const csrfMiddleware = (req, res, next) => {
    if (req.method === 'POST' || req.method === 'DELETE') {
        // Skip for login (path is relative to /api mount point)
        if (req.path === '/login') {
            return next();
        }

        const sessionId = req.cookies?.sessionId;
        const token = req.headers['x-csrf-token'];

        if (!verifyCsrfToken(sessionId, token)) {
            log('WARN', 'Invalid CSRF token', { path: req.path, ip: req.ip });
            return res.status(403).json({ error: 'Invalid CSRF token' });
        }
    }
    next();
};

// Apply middleware
app.use(generalLimiter);
app.use('/api', authMiddleware);
app.use('/api', csrfMiddleware);

// Static files (public directory)
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// HELPERS
// ============================================

function readJsonFile(filePath, defaultValue = null) {
    try {
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (e) {
        log('ERROR', `Failed to read JSON file ${filePath}:`, e.message);
    }
    return defaultValue;
}

function getRecentLogs(lines = 50) {
    try {
        if (fs.existsSync(LOG_FILE)) {
            const content = fs.readFileSync(LOG_FILE, 'utf8');
            const allLines = content.split('\n').filter(Boolean);
            return allLines.slice(-lines);
        }
    } catch (e) {
        log('ERROR', 'Failed to read logs:', e.message);
    }
    return [];
}

// ============================================
// API ENDPOINTS
// ============================================

// Login endpoint (no auth required, but rate limited)
app.post('/api/login', strictLimiter, (req, res) => {
    const { token } = req.body;
    const tokenValue = (token || '').trim();

    if (tokenValue === ADMIN_TOKEN) {
        const sessionId = crypto.randomBytes(16).toString('hex');
        const csrfToken = generateCsrfToken(sessionId);

        res.cookie('sessionId', sessionId, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 3600000 // 1 hour
        });
        res.cookie('adminToken', tokenValue, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 3600000
        });

        log('INFO', 'Successful login', { ip: req.ip });
        res.json({ success: true, csrfToken });
    } else {
        log('WARN', 'Failed login attempt', { ip: req.ip });
        res.status(401).json({ error: 'Invalid token' });
    }
});

// Get CSRF token (requires auth)
app.get('/api/csrf-token', (req, res) => {
    let sessionId = req.cookies?.sessionId;
    if (!sessionId) {
        sessionId = crypto.randomBytes(16).toString('hex');
        res.cookie('sessionId', sessionId, { httpOnly: true, sameSite: 'strict' });
    }
    const csrfToken = generateCsrfToken(sessionId);
    res.json({ csrfToken });
});

// Logout
app.post('/api/logout', (req, res) => {
    res.clearCookie('sessionId');
    res.clearCookie('adminToken');
    res.json({ success: true });
});

// Health status
app.get('/api/health', (req, res) => {
    const health = readJsonFile(HEALTH_FILE, {
        status: 'unknown',
        uptime: 0,
        messagesProcessed: 0,
        errors: 0
    });

    // Check if bridge is actually running by checking heartbeat age
    const now = Date.now();
    const lastHeartbeat = health.lastHeartbeat || 0;
    const heartbeatAge = (now - lastHeartbeat) / 1000;

    health.bridgeRunning = heartbeatAge < 15;
    health.heartbeatAge = Math.round(heartbeatAge);

    res.json(health);
});

// Message history with pagination
app.get('/api/messages', (req, res) => {
    const page = Math.max(0, parseInt(req.query.page) || 0);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
    const sort = req.query.sort === 'asc' ? 'asc' : 'desc';

    let messages = readJsonFile(MESSAGES_FILE, []);

    // Sort by timestamp
    messages.sort((a, b) => {
        const diff = new Date(b.timestamp) - new Date(a.timestamp);
        return sort === 'desc' ? diff : -diff;
    });

    const total = messages.length;
    const totalPages = Math.ceil(total / limit);
    const start = page * limit;
    const data = messages.slice(start, start + limit);

    res.json({
        data,
        pagination: {
            page,
            limit,
            total,
            totalPages,
            hasNext: page < totalPages - 1,
            hasPrev: page > 0
        }
    });
});

// Search messages
app.get('/api/messages/search', (req, res) => {
    const { q, user, from, to } = req.query;
    const page = Math.max(0, parseInt(req.query.page) || 0);
    const limit = Math.min(100, parseInt(req.query.limit) || 25);

    let messages = readJsonFile(MESSAGES_FILE, []);

    // Filter by search query
    if (q) {
        const searchLower = q.toLowerCase();
        messages = messages.filter(m =>
            (m.prompt || '').toLowerCase().includes(searchLower) ||
            (m.response || '').toLowerCase().includes(searchLower)
        );
    }

    // Filter by username
    if (user) {
        messages = messages.filter(m =>
            (m.username || '').toLowerCase().includes(user.toLowerCase())
        );
    }

    // Filter by date range
    if (from) {
        const fromDate = new Date(from);
        messages = messages.filter(m => new Date(m.timestamp) >= fromDate);
    }

    if (to) {
        const toDate = new Date(to);
        messages = messages.filter(m => new Date(m.timestamp) <= toDate);
    }

    // Sort and paginate
    messages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const total = messages.length;
    const data = messages.slice(page * limit, (page + 1) * limit);

    res.json({
        data,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        query: { q, user, from, to }
    });
});

// Recent logs
app.get('/api/logs', (req, res) => {
    const lines = Math.min(500, Math.max(1, parseInt(req.query.lines) || 50));
    const logs = getRecentLogs(lines);
    res.json({ logs, total: logs.length });
});

// Export messages
app.get('/api/export/messages', (req, res) => {
    const format = req.query.format || 'json';
    let messages = readJsonFile(MESSAGES_FILE, []);

    // Apply date filters if provided
    if (req.query.from) {
        const fromDate = new Date(req.query.from);
        messages = messages.filter(m => new Date(m.timestamp) >= fromDate);
    }
    if (req.query.to) {
        const toDate = new Date(req.query.to);
        messages = messages.filter(m => new Date(m.timestamp) <= toDate);
    }

    if (format === 'csv') {
        const headers = ['id', 'timestamp', 'username', 'prompt', 'response', 'duration'];
        const csv = [
            headers.join(','),
            ...messages.map(m => headers.map(h =>
                `"${String(m[h] || '').replace(/"/g, '""').replace(/\n/g, ' ')}"`
            ).join(','))
        ].join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition',
            `attachment; filename="nexus-messages-${Date.now()}.csv"`);
        res.send(csv);
    } else {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition',
            `attachment; filename="nexus-messages-${Date.now()}.json"`);
        res.json(messages);
    }
});

// Export logs
app.get('/api/export/logs', (req, res) => {
    try {
        if (fs.existsSync(LOG_FILE)) {
            const logs = fs.readFileSync(LOG_FILE, 'utf8');
            res.setHeader('Content-Type', 'text/plain');
            res.setHeader('Content-Disposition',
                `attachment; filename="nexus-logs-${Date.now()}.txt"`);
            res.send(logs);
        } else {
            res.status(404).json({ error: 'No logs found' });
        }
    } catch (e) {
        log('ERROR', 'Failed to export logs:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Restart bridge (SECURE - uses process.kill and spawn, not exec)
app.post('/api/restart', strictLimiter, (req, res) => {
    const health = readJsonFile(HEALTH_FILE, {});

    // Safely kill existing process using process.kill
    if (health.pid && typeof health.pid === 'number' &&
        Number.isInteger(health.pid) && health.pid > 0) {
        try {
            process.kill(health.pid, 'SIGTERM');
            log('INFO', `Killed bridge process ${health.pid}`);
        } catch (e) {
            // Process might not exist, that's okay
            log('WARN', `Could not kill process ${health.pid}:`, e.message);
        }
    }

    // Use spawn instead of exec for starting new process
    try {
        const bridgeProcess = spawn('node', ['bridge.js'], {
            cwd: BRIDGE_DIR,
            detached: true,
            stdio: 'ignore',
            windowsHide: true
        });
        bridgeProcess.unref();

        log('INFO', 'Started new bridge process');
        res.json({ success: true, message: 'Bridge restarting...' });
    } catch (e) {
        log('ERROR', 'Failed to start bridge:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Stop bridge (SECURE)
app.post('/api/stop', strictLimiter, (req, res) => {
    const health = readJsonFile(HEALTH_FILE, {});

    // Validate PID is a positive integer
    if (health.pid && typeof health.pid === 'number' &&
        Number.isInteger(health.pid) && health.pid > 0) {
        try {
            process.kill(health.pid, 'SIGTERM');
            log('INFO', `Stopped bridge process ${health.pid}`);
            res.json({ success: true, message: 'Bridge stopped' });
        } catch (e) {
            log('ERROR', `Failed to stop process ${health.pid}:`, e.message);
            res.json({ success: false, message: `Error: ${e.message}` });
        }
    } else {
        res.json({ success: false, message: 'No valid bridge PID found' });
    }
});

// Clear logs
app.post('/api/clear-logs', (req, res) => {
    try {
        fs.writeFileSync(LOG_FILE, '');
        log('INFO', 'Logs cleared by admin');
        res.json({ success: true });
    } catch (e) {
        log('ERROR', 'Failed to clear logs:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Clear message history
app.post('/api/clear-messages', (req, res) => {
    try {
        fs.writeFileSync(MESSAGES_FILE, '[]');
        log('INFO', 'Message history cleared by admin');
        res.json({ success: true });
    } catch (e) {
        log('ERROR', 'Failed to clear messages:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Serve dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// WEBSOCKET SERVER
// ============================================

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Track connected clients
const clients = new Set();

// Broadcast to all authenticated clients
function broadcast(type, data) {
    const message = JSON.stringify({ type, data, timestamp: Date.now() });
    clients.forEach(client => {
        if (client.readyState === 1 && client.authenticated) { // WebSocket.OPEN
            client.send(message);
        }
    });
}

// WebSocket connection handler
wss.on('connection', (ws, req) => {
    ws.authenticated = false;
    clients.add(ws);

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);

            // Handle authentication
            if (msg.type === 'auth' && msg.token === ADMIN_TOKEN) {
                ws.authenticated = true;

                // Send initial state
                ws.send(JSON.stringify({
                    type: 'init',
                    data: {
                        health: readJsonFile(HEALTH_FILE, {}),
                        messages: readJsonFile(MESSAGES_FILE, []).slice(-25)
                    }
                }));

                log('INFO', 'WebSocket client authenticated');
            }
        } catch (e) {
            log('ERROR', 'WebSocket message error:', e.message);
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
    });

    ws.on('error', (e) => {
        log('ERROR', 'WebSocket error:', e.message);
        clients.delete(ws);
    });
});

// File watchers for real-time updates
const watcher = chokidar.watch([HEALTH_FILE, MESSAGES_FILE], {
    persistent: true,
    ignoreInitial: true
});

watcher.on('change', (filePath) => {
    if (filePath.endsWith('health.json')) {
        broadcast('health', readJsonFile(HEALTH_FILE, {}));
    } else if (filePath.endsWith('messages.json')) {
        broadcast('messages', readJsonFile(MESSAGES_FILE, []).slice(-25));
    }
});

// ============================================
// START SERVER
// ============================================

server.listen(PORT, 'localhost', () => {
    console.log('\n' + '='.repeat(50));
    console.log('  NEXUS Admin Panel');
    console.log(`  Running on http://localhost:${PORT}`);
    console.log('='.repeat(50));
    console.log('\n  Security: Authentication required');
    console.log('  WebSocket: Enabled for real-time updates');
    console.log('  Rate Limiting: Enabled\n');

    log('INFO', `Admin server started on port ${PORT}`);
});
