#!/usr/bin/env node
/**
 * NEXUS Watchdog - Process Supervisor
 *
 * Features:
 * - Auto-restart bridge.js on crash
 * - Restart loop prevention
 * - Health file monitoring
 * - Graceful shutdown propagation
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Configuration
const BRIDGE_SCRIPT = path.join(__dirname, 'bridge.js');
const HEALTH_FILE = path.join(__dirname, 'watchdog-health.json');
const LOG_FILE = path.join(__dirname, 'watchdog.log');

// Restart loop prevention
const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 60000; // 60 seconds
const RESTART_DELAY_MS = 5000; // 5 seconds between restarts

// State
let bridgeProcess = null;
let restartTimes = [];
let shuttingDown = false;

// Logging
function log(level, message) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [WATCHDOG] [${level}] ${message}`;
    console.log(line);
    try {
        fs.appendFileSync(LOG_FILE, line + '\n');
    } catch (e) {}
}

// Update health file
function updateHealth(status, extra = {}) {
    try {
        fs.writeFileSync(HEALTH_FILE, JSON.stringify({
            status,
            pid: process.pid,
            bridgePid: bridgeProcess?.pid || null,
            lastUpdate: new Date().toISOString(),
            restartCount: restartTimes.length,
            ...extra
        }, null, 2));
    } catch (e) {}
}

// Check for restart loop
function isRestartLoopDetected() {
    const now = Date.now();
    // Remove old restart times outside the window
    restartTimes = restartTimes.filter(t => now - t < RESTART_WINDOW_MS);

    if (restartTimes.length >= MAX_RESTARTS) {
        log('ERROR', `Restart loop detected: ${MAX_RESTARTS} restarts in ${RESTART_WINDOW_MS / 1000}s. Stopping watchdog.`);
        return true;
    }
    return false;
}

// Start bridge process
function startBridge() {
    if (shuttingDown) return;

    if (isRestartLoopDetected()) {
        updateHealth('stopped', { reason: 'restart_loop' });
        process.exit(1);
    }

    log('INFO', 'Starting bridge.js...');
    restartTimes.push(Date.now());

    bridgeProcess = spawn('node', [BRIDGE_SCRIPT], {
        cwd: __dirname,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env }
    });

    updateHealth('running', { bridgePid: bridgeProcess.pid });
    log('INFO', `Bridge started with PID ${bridgeProcess.pid}`);

    // Pipe output to console and log
    bridgeProcess.stdout.on('data', data => {
        const lines = data.toString().trim();
        if (lines) console.log(lines);
    });

    bridgeProcess.stderr.on('data', data => {
        const lines = data.toString().trim();
        if (lines) console.error(lines);
    });

    // Handle exit
    bridgeProcess.on('exit', (code, signal) => {
        if (shuttingDown) {
            log('INFO', 'Bridge stopped (shutdown requested)');
            return;
        }

        if (code === 0) {
            log('INFO', 'Bridge exited normally');
            updateHealth('stopped', { reason: 'normal_exit' });
        } else {
            log('WARN', `Bridge crashed with code ${code}, signal ${signal}`);
            updateHealth('restarting', { exitCode: code, signal });

            // Schedule restart
            log('INFO', `Restarting in ${RESTART_DELAY_MS / 1000}s...`);
            setTimeout(startBridge, RESTART_DELAY_MS);
        }
    });

    bridgeProcess.on('error', err => {
        log('ERROR', `Failed to start bridge: ${err.message}`);
        updateHealth('error', { error: err.message });

        // Schedule restart
        setTimeout(startBridge, RESTART_DELAY_MS);
    });
}

// Graceful shutdown
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    log('INFO', `Received ${signal}, shutting down...`);
    updateHealth('stopping');

    if (bridgeProcess) {
        log('INFO', `Stopping bridge (PID ${bridgeProcess.pid})...`);

        // Try graceful termination first
        bridgeProcess.kill('SIGTERM');

        // Force kill after timeout
        const killTimeout = setTimeout(() => {
            if (bridgeProcess && !bridgeProcess.killed) {
                log('WARN', 'Bridge did not stop gracefully, force killing...');
                bridgeProcess.kill('SIGKILL');
            }
        }, 10000);

        bridgeProcess.on('exit', () => {
            clearTimeout(killTimeout);
            log('INFO', 'Bridge stopped');
            updateHealth('stopped', { reason: signal });
            process.exit(0);
        });
    } else {
        updateHealth('stopped', { reason: signal });
        process.exit(0);
    }
}

// Handle signals
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGHUP', () => shutdown('SIGHUP'));

// Handle uncaught exceptions
process.on('uncaughtException', err => {
    log('ERROR', `Uncaught exception: ${err.message}`);
    shutdown('uncaughtException');
});

// Start
log('INFO', '='.repeat(50));
log('INFO', 'NEXUS Watchdog Starting');
log('INFO', `Max restarts: ${MAX_RESTARTS} in ${RESTART_WINDOW_MS / 1000}s`);
log('INFO', `Restart delay: ${RESTART_DELAY_MS / 1000}s`);
log('INFO', '='.repeat(50));

updateHealth('starting');
startBridge();

// Heartbeat
setInterval(() => {
    if (!shuttingDown && bridgeProcess) {
        updateHealth('running');
    }
}, 30000);
