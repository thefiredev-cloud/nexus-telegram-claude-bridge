#!/usr/bin/env node
/**
 * Telegram-Claude Bridge Admin Panel
 * Runs on localhost:3000
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const app = express();
const PORT = 3000;

// File paths
const BRIDGE_DIR = __dirname;
const HEALTH_FILE = path.join(BRIDGE_DIR, 'health.json');
const MESSAGES_FILE = path.join(BRIDGE_DIR, 'messages.json');
const LOG_FILE = path.join(BRIDGE_DIR, 'bridge.log');

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper to read JSON files safely
function readJsonFile(filePath, defaultValue = null) {
    try {
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (e) {}
    return defaultValue;
}

// API: Get health status
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

    health.bridgeRunning = heartbeatAge < 15; // Consider dead if no heartbeat in 15s
    health.heartbeatAge = Math.round(heartbeatAge);

    res.json(health);
});

// API: Get message history
app.get('/api/messages', (req, res) => {
    const messages = readJsonFile(MESSAGES_FILE, []);
    // Return newest first
    res.json(messages.reverse());
});

// API: Get recent logs
app.get('/api/logs', (req, res) => {
    try {
        const lines = parseInt(req.query.lines) || 50;
        if (fs.existsSync(LOG_FILE)) {
            const content = fs.readFileSync(LOG_FILE, 'utf8');
            const allLines = content.split('\n').filter(Boolean);
            const recentLines = allLines.slice(-lines);
            res.json({ logs: recentLines });
        } else {
            res.json({ logs: [] });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// API: Restart bridge
app.post('/api/restart', (req, res) => {
    // Kill existing bridge processes and start new one
    exec('powershell -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -match \'bridge\' -or $_.Id -eq (Get-Content \'' + HEALTH_FILE + '\' | ConvertFrom-Json).pid } | Stop-Process -Force -ErrorAction SilentlyContinue"', (err) => {
        // Start new bridge
        exec(`powershell -Command "Start-Process -WindowStyle Hidden -FilePath 'node' -ArgumentList 'bridge.js' -WorkingDirectory '${BRIDGE_DIR}'"`, (err2) => {
            if (err2) {
                res.status(500).json({ error: err2.message });
            } else {
                res.json({ success: true, message: 'Bridge restarting...' });
            }
        });
    });
});

// API: Stop bridge
app.post('/api/stop', (req, res) => {
    const health = readJsonFile(HEALTH_FILE, {});
    if (health.pid) {
        exec(`powershell -Command "Stop-Process -Id ${health.pid} -Force -ErrorAction SilentlyContinue"`, (err) => {
            res.json({ success: true, message: 'Bridge stopped' });
        });
    } else {
        res.json({ success: false, message: 'No bridge PID found' });
    }
});

// API: Clear logs
app.post('/api/clear-logs', (req, res) => {
    try {
        fs.writeFileSync(LOG_FILE, '');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// API: Clear message history
app.post('/api/clear-messages', (req, res) => {
    try {
        fs.writeFileSync(MESSAGES_FILE, '[]');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Serve dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`  Telegram-Claude Bridge Admin Panel`);
    console.log(`  Running on http://localhost:${PORT}`);
    console.log(`========================================\n`);
});
