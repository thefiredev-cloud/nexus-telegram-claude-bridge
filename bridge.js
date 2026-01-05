#!/usr/bin/env node
/**
 * Telegram-Claude Bridge v6
 *
 * Features:
 * - Clean Telegram formatting (HTML mode)
 * - Parallel agents (up to 10 concurrent)
 * - Token usage & cost tracking (Opus 4.5)
 *
 * Domain Modes:
 * - /finance - Quant analysis, markets, economics
 * - /dev - Full-stack development
 * - /legal - Legal tech, JudgeFinder, SEC compliance
 * - /health - EMS/healthcare, Protocol Guide
 * - /judge - Judicial analytics
 */

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { query } = require('@anthropic-ai/claude-agent-sdk');

// Configuration
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_CHAT_IDS = (process.env.TELEGRAM_ALLOWED_CHAT_IDS || '').split(',').filter(Boolean);
let WORKING_DIR = process.env.WORKING_DIR || 'C:\\Users\\Tanner';
const TIMEOUT_MINUTES = 10;
const MAX_PARALLEL_AGENTS = 10;

// State files
const STATE_FILE = path.join(__dirname, '.bridge-state.json');
const MESSAGES_FILE = path.join(__dirname, 'messages.json');
const HEALTH_FILE = path.join(__dirname, 'health.json');

// ============================================
// TELEGRAM FORMATTING - Convert MD to HTML
// ============================================

function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function formatForTelegram(text) {
    if (!text) return '(Empty response)';

    // Remove weird unicode math fonts (bold/italic unicode chars)
    text = text.replace(/[\u{1D400}-\u{1D7FF}]/gu, char => {
        // Convert math bold/italic to regular ASCII
        const code = char.codePointAt(0);
        if (code >= 0x1D400 && code <= 0x1D419) return String.fromCharCode(code - 0x1D400 + 65); // Bold A-Z
        if (code >= 0x1D41A && code <= 0x1D433) return String.fromCharCode(code - 0x1D41A + 97); // Bold a-z
        if (code >= 0x1D434 && code <= 0x1D44D) return String.fromCharCode(code - 0x1D434 + 65); // Italic A-Z
        if (code >= 0x1D44E && code <= 0x1D467) return String.fromCharCode(code - 0x1D44E + 97); // Italic a-z
        return char;
    });

    // Convert markdown tables to plain text
    text = text.replace(/\|([^\n]+)\|\n\|[-:\s|]+\|\n((?:\|[^\n]+\|\n?)*)/g, (match, header, rows) => {
        const headerCells = header.split('|').map(c => c.trim()).filter(Boolean);
        const rowLines = rows.trim().split('\n').map(row =>
            row.split('|').map(c => c.trim()).filter(Boolean)
        );

        let result = headerCells.join(' | ') + '\n';
        result += '-'.repeat(40) + '\n';
        rowLines.forEach(cells => {
            result += cells.join(' | ') + '\n';
        });
        return result;
    });

    // Remove standalone table separator lines
    text = text.replace(/^\|[-:\s|]+\|$/gm, '');

    // Escape HTML entities first (before adding our own tags)
    let escaped = escapeHtml(text);

    // Convert code blocks (``` ... ```)
    escaped = escaped.replace(/```(\w*)\n?([\s\S]*?)```/g, (match, lang, code) => {
        return `<pre>${code.trim()}</pre>`;
    });

    // Convert inline code (` ... `)
    escaped = escaped.replace(/`([^`\n]+)`/g, '<code>$1</code>');

    // Convert bold (**text** or __text__)
    escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    escaped = escaped.replace(/__([^_]+)__/g, '<b>$1</b>');

    // Convert italic (*text* or _text_) - be careful not to match inside words
    escaped = escaped.replace(/(?<![a-zA-Z])\*([^*\n]+)\*(?![a-zA-Z])/g, '<i>$1</i>');
    escaped = escaped.replace(/(?<![a-zA-Z])_([^_\n]+)_(?![a-zA-Z])/g, '<i>$1</i>');

    // Convert strikethrough (~~text~~)
    escaped = escaped.replace(/~~([^~]+)~~/g, '<s>$1</s>');

    // Convert headers (# ## ###) to bold
    escaped = escaped.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

    // Convert bullet points to cleaner format
    escaped = escaped.replace(/^[\s]*[-*]\s+/gm, '• ');

    // Convert numbered lists
    escaped = escaped.replace(/^(\d+)\.\s+/gm, '$1. ');

    // Clean up excessive newlines
    escaped = escaped.replace(/\n{3,}/g, '\n\n');

    return escaped.trim();
}

// ============================================
// STATE MANAGEMENT
// ============================================

function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            return state.lastUpdateId || 0;
        }
    } catch (e) {}
    return 0;
}

function saveState(updateId) {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify({ lastUpdateId: updateId }));
    } catch (e) {}
}

function loadMessages() {
    try {
        if (fs.existsSync(MESSAGES_FILE)) {
            return JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
        }
    } catch (e) {}
    return [];
}

function saveMessage(msg) {
    try {
        const messages = loadMessages();
        messages.push(msg);
        const trimmed = messages.slice(-100);
        fs.writeFileSync(MESSAGES_FILE, JSON.stringify(trimmed, null, 2));
    } catch (e) {
        log('ERROR', 'Failed to save message:', e.message);
    }
}

// Token tracking (Opus 4.5 pricing: $15/MTok input, $75/MTok output)
const TOKEN_COSTS = {
    inputPer1M: 15.00,
    outputPer1M: 75.00
};

// Estimate tokens (~4 chars per token)
function estimateTokens(text) {
    return Math.ceil((text || '').length / 4);
}

function calculateCost(inputTokens, outputTokens) {
    const inputCost = (inputTokens / 1000000) * TOKEN_COSTS.inputPer1M;
    const outputCost = (outputTokens / 1000000) * TOKEN_COSTS.outputPer1M;
    return inputCost + outputCost;
}

// Health tracking
let stats = {
    startTime: Date.now(),
    messagesProcessed: 0,
    errors: 0,
    lastActivity: Date.now(),
    status: 'starting',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0
};

let isProcessing = false;
let activeAgents = 0;

function updateHealth(updates = {}) {
    stats = { ...stats, ...updates, lastHeartbeat: Date.now() };
    try {
        fs.writeFileSync(HEALTH_FILE, JSON.stringify({
            ...stats,
            uptime: Math.floor((Date.now() - stats.startTime) / 1000),
            pid: process.pid,
            workingDir: WORKING_DIR,
            queueLength: messageQueue.length,
            isProcessing,
            activeAgents,
            costFormatted: `$${stats.totalCost.toFixed(4)}`
        }, null, 2));
    } catch (e) {}
}

setInterval(() => updateHealth(), 5000);

let lastUpdateId = loadState();
let messageQueue = [];

// Telegram API
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Logging
const LOG_FILE = path.join(__dirname, 'bridge.log');
function log(level, message, data = '') {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level}] ${message} ${data}`;
    console.log(line);
    fs.appendFileSync(LOG_FILE, line + '\n');
    if (level === 'ERROR') stats.errors++;
    stats.lastActivity = Date.now();
}

// ============================================
// TELEGRAM API
// ============================================

async function sendMessage(chatId, text, options = {}) {
    if (!text || text.trim() === '') {
        text = '(Empty response)';
    }

    try {
        const chunks = [];
        let remaining = text;
        while (remaining.length > 0) {
            chunks.push(remaining.substring(0, 4000));
            remaining = remaining.substring(4000);
        }

        for (let i = 0; i < chunks.length; i++) {
            let chunk = chunks[i];
            if (chunks.length > 1) {
                chunk = `[${i + 1}/${chunks.length}]\n${chunk}`;
            }

            try {
                await axios.post(`${API_BASE}/sendMessage`, {
                    chat_id: chatId,
                    text: chunk,
                    parse_mode: options.parse_mode || 'HTML',
                    disable_web_page_preview: true
                });
            } catch (htmlError) {
                // If HTML parsing fails, send as plain text
                await axios.post(`${API_BASE}/sendMessage`, {
                    chat_id: chatId,
                    text: chunk.replace(/<[^>]+>/g, ''), // Strip HTML tags
                    disable_web_page_preview: true
                });
            }

            if (i < chunks.length - 1) {
                await new Promise(r => setTimeout(r, 500));
            }
        }
    } catch (error) {
        log('ERROR', 'Failed to send message:', error.message);
    }
}

async function sendTyping(chatId) {
    try {
        await axios.post(`${API_BASE}/sendChatAction`, {
            chat_id: chatId,
            action: 'typing'
        });
    } catch (error) {}
}

async function getUpdates() {
    try {
        const response = await axios.get(`${API_BASE}/getUpdates`, {
            params: {
                offset: lastUpdateId + 1,
                timeout: 30,
                allowed_updates: ['message']
            },
            timeout: 35000
        });
        return response.data.result || [];
    } catch (error) {
        if (error.code !== 'ECONNABORTED') {
            log('ERROR', 'Failed to get updates:', error.message);
        }
        return [];
    }
}

function isAuthorized(chatId) {
    if (ALLOWED_CHAT_IDS.length === 0) return false;
    return ALLOWED_CHAT_IDS.includes(String(chatId));
}

// ============================================
// SYSTEM PROMPTS FOR MODES
// ============================================

const SYSTEM_PROMPTS = {
    finance: `You are a quantitative financial analyst and economist with deep expertise in:
- Technical analysis, chart patterns, and trading indicators
- Fundamental analysis and company valuation
- Macroeconomics, monetary policy, and fiscal policy
- Portfolio theory, risk management, and optimization
- Derivatives, options pricing, and hedging strategies
- Cryptocurrency and DeFi analysis
- Statistical modeling and quantitative methods

Format responses cleanly without markdown tables. Use bullet points and clear sections.
Be precise with numbers and always cite data sources when possible.`,

    dev: `You are a senior full-stack developer with expertise in:
- Frontend: React, Vue, Next.js, TypeScript, Tailwind CSS
- Backend: Node.js, Python, Go, REST APIs, GraphQL
- Databases: PostgreSQL, MongoDB, Redis, Supabase
- DevOps: Docker, CI/CD, AWS, Vercel, Netlify
- Mobile: React Native, Flutter
- AI/ML: LangChain, OpenAI API, embeddings, RAG

Write clean, production-ready code. Explain architectural decisions.
Format code blocks properly but avoid markdown tables.`,

    legal: `You are a legal technology expert working on JudgeFinder - a judicial analytics platform.

Your expertise includes:
- Judicial behavior analysis and prediction
- Court data analytics (California courts, expanding nationally)
- CourtListener and UniCourt API integration
- Legal tech SaaS architecture (Next.js 15, Supabase, Stripe, Clerk)
- SEC compliance (Rule 506(c), Form D, accredited investor verification)
- Subscription agreement drafting and review
- Legal tech product development and pricing strategy

JudgeFinder context:
- 1,800+ judge profiles in California
- 175+ API endpoints
- Three-tier subscription ($29/mo Pro, $299/mo Enterprise)
- B2B legal advertising platform
- 40+ database tables with normalized court data

Format responses professionally. Cite legal sources when applicable.
Avoid markdown tables - use bullet points instead.`,

    health: `You are a healthcare technology expert specializing in EMS (Emergency Medical Services) applications.

Your expertise includes:
- LA County Prehospital Care Manual (PCM) protocols
- Paramedic decision support systems
- Pediatric dosing calculations (weight-based)
- Medical knowledge base design (BM25 retrieval, MiniSearch)
- PWA development for offline-first medical apps
- HIPAA compliance and medical data security
- OpenAI GPT-4o integration for medical Q&A

Protocol Guide context:
- AI-powered EMS protocol assistant for LA County Fire
- 3,200+ paramedics across 174 fire stations
- 450,000 annual EMS calls
- 810-line medical knowledge base
- Offline-capable PWA with 11MB cached data
- Voice input for hands-free operation

Be precise with medical information. Always emphasize following local protocols.
Format responses clearly without markdown tables.`,

    judge: `You are an expert on JudgeFinder - a judicial analytics and transparency platform.

Key capabilities:
- Search 1,800+ California judge profiles
- Analyze judicial behavior patterns and case outcomes
- Access civil, criminal, and family law metrics
- Multi-dimensional bias detection analysis
- Court and jurisdiction data lookup
- Case analytics and outcome predictions

Technical details:
- Next.js 15.5 with React 18.3
- Supabase PostgreSQL database
- Clerk authentication with SSO
- Stripe billing integration
- 175+ REST API endpoints
- Real-time data updates

Help users understand judicial patterns, search for judges, analyze court data,
and leverage the platform's analytics features.
Format responses cleanly without markdown tables.`,

    default: `Format responses cleanly for Telegram. Avoid markdown tables - use bullet points or plain text instead. Keep responses focused and well-structured.`
};

// ============================================
// CLAUDE SDK EXECUTION
// ============================================

async function runClaude(prompt, chatId, mode = 'default') {
    log('INFO', `Running Claude (${mode}): "${prompt.substring(0, 80)}..."`);
    updateHealth({ status: 'processing' });
    isProcessing = true;
    activeAgents = 1;

    const typingInterval = setInterval(() => sendTyping(chatId), 4000);
    sendTyping(chatId);

    try {
        const systemPrompt = SYSTEM_PROMPTS[mode] || SYSTEM_PROMPTS.default;
        const fullPrompt = `${systemPrompt}\n\n---\n\nUser request: ${prompt}`;

        let result = '';
        for await (const message of query({
            prompt: fullPrompt,
            options: {
                cwd: WORKING_DIR,
                allowedTools: ["Read", "Edit", "Bash", "Write", "Glob", "Grep", "WebFetch", "WebSearch"],
                permissionMode: "bypassPermissions",
            }
        })) {
            if ("result" in message) {
                result = message.result;
            }
            sendTyping(chatId);
        }

        // Track token usage
        const inputTokens = estimateTokens(fullPrompt);
        const outputTokens = estimateTokens(result);
        const cost = calculateCost(inputTokens, outputTokens);

        stats.totalInputTokens += inputTokens;
        stats.totalOutputTokens += outputTokens;
        stats.totalCost += cost;

        log('INFO', `Claude completed. Tokens: ${inputTokens}/${outputTokens}, Cost: $${cost.toFixed(4)}`);
        return formatForTelegram(result || '(No output)');
    } catch (error) {
        log('ERROR', `Claude error: ${error.message}`);
        return `Error: ${error.message}`;
    } finally {
        clearInterval(typingInterval);
        isProcessing = false;
        activeAgents = 0;
        updateHealth({ status: 'idle' });
    }
}

// ============================================
// PARALLEL AGENTS
// ============================================

async function runParallelAgents(prompts, chatId, mode = 'default') {
    const numAgents = prompts.length;
    log('INFO', `Running ${numAgents} parallel agents`);
    updateHealth({ status: `processing (${numAgents} agents)` });
    isProcessing = true;
    activeAgents = numAgents;

    const typingInterval = setInterval(() => sendTyping(chatId), 3000);
    sendTyping(chatId);

    try {
        const systemPrompt = SYSTEM_PROMPTS[mode] || SYSTEM_PROMPTS.default;

        const promises = prompts.map(async (prompt, index) => {
            const fullPrompt = `${systemPrompt}\n\nAgent ${index + 1} task: ${prompt}`;
            let result = '';

            try {
                for await (const message of query({
                    prompt: fullPrompt,
                    options: {
                        cwd: WORKING_DIR,
                        allowedTools: ["Read", "Edit", "Bash", "Write", "Glob", "Grep", "WebFetch", "WebSearch"],
                        permissionMode: "bypassPermissions",
                    }
                })) {
                    if ("result" in message) {
                        result = message.result;
                    }
                }
                return { index: index + 1, success: true, result };
            } catch (error) {
                return { index: index + 1, success: false, error: error.message };
            }
        });

        const results = await Promise.allSettled(promises);

        let output = `<b>Parallel Agents Results (${numAgents} agents)</b>\n\n`;

        for (const result of results) {
            if (result.status === 'fulfilled') {
                const r = result.value;
                if (r.success) {
                    output += `<b>Agent ${r.index}:</b>\n${formatForTelegram(r.result)}\n\n`;
                } else {
                    output += `<b>Agent ${r.index}:</b> Error - ${r.error}\n\n`;
                }
            } else {
                output += `<b>Agent:</b> Failed - ${result.reason}\n\n`;
            }
        }

        log('INFO', `${numAgents} agents completed`);
        return output;
    } catch (error) {
        log('ERROR', `Parallel agents error: ${error.message}`);
        return `Error: ${error.message}`;
    } finally {
        clearInterval(typingInterval);
        isProcessing = false;
        activeAgents = 0;
        updateHealth({ status: 'idle' });
    }
}

// ============================================
// MESSAGE PROCESSING
// ============================================

async function processMessage(message) {
    const chatId = message.chat.id;
    const text = message.text?.trim();
    const username = message.from?.username || message.from?.first_name || 'Unknown';

    if (!text) return;

    if (!isAuthorized(chatId)) {
        log('WARN', `Unauthorized: ${username} (${chatId})`);
        await sendMessage(chatId, `Unauthorized. Your chat ID: ${chatId}`);
        return;
    }

    log('INFO', `From ${username}: "${text.substring(0, 50)}..."`);

    // ===== COMMANDS =====

    if (text === '/start') {
        await sendMessage(chatId,
            `<b>Claude Code Bridge v6</b>\n\n` +
            `Send any message to Claude. Using Opus 4.5.\n\n` +
            `<b>Domain Modes:</b>\n` +
            `• /finance [q] - Quant/market analysis\n` +
            `• /dev [q] - Full-stack development\n` +
            `• /legal [q] - Legal tech (JudgeFinder)\n` +
            `• /health [q] - EMS/healthcare (Protocol Guide)\n` +
            `• /judge [q] - Judicial analytics\n\n` +
            `<b>Power Features:</b>\n` +
            `• /agents [N] [q] - Run N parallel agents\n` +
            `• /cost - View token usage & costs\n\n` +
            `<b>System:</b>\n` +
            `• /status - Bridge status\n` +
            `• /cd [path] - Change directory\n` +
            `• /logs - View logs`
        );
        return;
    }

    if (text === '/status') {
        const status = isProcessing ? `Processing (${activeAgents} agents)` : 'Ready';
        await sendMessage(chatId,
            `<b>Status:</b> ${status}\n` +
            `<b>Directory:</b> ${WORKING_DIR}\n` +
            `<b>Queue:</b> ${messageQueue.length} pending\n` +
            `<b>Processed:</b> ${stats.messagesProcessed}\n` +
            `<b>Uptime:</b> ${Math.floor((Date.now() - stats.startTime) / 60000)} min\n` +
            `<b>Session Cost:</b> $${stats.totalCost.toFixed(4)}`
        );
        return;
    }

    if (text === '/cost') {
        const inputK = (stats.totalInputTokens / 1000).toFixed(1);
        const outputK = (stats.totalOutputTokens / 1000).toFixed(1);
        await sendMessage(chatId,
            `<b>Token Usage (Opus 4.5)</b>\n\n` +
            `<b>Input:</b> ${inputK}K tokens ($${((stats.totalInputTokens / 1000000) * TOKEN_COSTS.inputPer1M).toFixed(4)})\n` +
            `<b>Output:</b> ${outputK}K tokens ($${((stats.totalOutputTokens / 1000000) * TOKEN_COSTS.outputPer1M).toFixed(4)})\n` +
            `<b>Total Cost:</b> $${stats.totalCost.toFixed(4)}\n\n` +
            `<i>Pricing: $15/MTok input, $75/MTok output</i>`
        );
        return;
    }

    if (text === '/stop') {
        await sendMessage(chatId, isProcessing
            ? 'Processing cannot be interrupted mid-stream. Wait for completion.'
            : 'Nothing running.');
        return;
    }

    if (text === '/logs') {
        try {
            const logs = fs.readFileSync(LOG_FILE, 'utf8');
            const lastLines = logs.split('\n').slice(-20).join('\n');
            await sendMessage(chatId, `<pre>${escapeHtml(lastLines)}</pre>`);
        } catch (e) {
            await sendMessage(chatId, 'No logs available.');
        }
        return;
    }

    if (text.startsWith('/cd ')) {
        const newDir = text.substring(4).trim();
        if (fs.existsSync(newDir)) {
            WORKING_DIR = newDir;
            process.env.WORKING_DIR = newDir;
            await sendMessage(chatId, `Changed to: <code>${newDir}</code>`);
        } else {
            await sendMessage(chatId, `Not found: ${newDir}`);
        }
        return;
    }

    // ===== FINANCE MODE =====
    if (text.startsWith('/finance ')) {
        const prompt = text.substring(9).trim();
        if (!prompt) {
            await sendMessage(chatId, 'Usage: /finance [query]');
            return;
        }

        if (isProcessing) {
            messageQueue.push({ chatId, text, username, mode: 'finance' });
            await sendMessage(chatId, `Queued (#${messageQueue.length})`);
            return;
        }

        await sendMessage(chatId, `<b>Financial Analysis:</b> ${prompt.substring(0, 50)}...`);
        const response = await runClaude(prompt, chatId, 'finance');
        await sendMessage(chatId, response);
        stats.messagesProcessed++;
        return;
    }

    // ===== DEV MODE =====
    if (text.startsWith('/dev ')) {
        const prompt = text.substring(5).trim();
        if (!prompt) {
            await sendMessage(chatId, 'Usage: /dev [query]');
            return;
        }

        if (isProcessing) {
            messageQueue.push({ chatId, text, username, mode: 'dev' });
            await sendMessage(chatId, `Queued (#${messageQueue.length})`);
            return;
        }

        await sendMessage(chatId, `<b>Dev Mode:</b> ${prompt.substring(0, 50)}...`);
        const response = await runClaude(prompt, chatId, 'dev');
        await sendMessage(chatId, response);
        stats.messagesProcessed++;
        return;
    }

    // ===== LEGAL MODE (JudgeFinder) =====
    if (text.startsWith('/legal ')) {
        const prompt = text.substring(7).trim();
        if (!prompt) {
            await sendMessage(chatId, 'Usage: /legal [query]\nExpert in legal tech, JudgeFinder, SEC compliance.');
            return;
        }

        if (isProcessing) {
            messageQueue.push({ chatId, text, username, mode: 'legal' });
            await sendMessage(chatId, `Queued (#${messageQueue.length})`);
            return;
        }

        await sendMessage(chatId, `<b>Legal Tech:</b> ${prompt.substring(0, 50)}...`);
        const response = await runClaude(prompt, chatId, 'legal');
        await sendMessage(chatId, response);
        stats.messagesProcessed++;
        return;
    }

    // ===== HEALTH/EMS MODE (Protocol Guide) =====
    if (text.startsWith('/health ')) {
        const prompt = text.substring(8).trim();
        if (!prompt) {
            await sendMessage(chatId, 'Usage: /health [query]\nEMS protocols, Protocol Guide, paramedic support.');
            return;
        }

        if (isProcessing) {
            messageQueue.push({ chatId, text, username, mode: 'health' });
            await sendMessage(chatId, `Queued (#${messageQueue.length})`);
            return;
        }

        await sendMessage(chatId, `<b>Healthcare/EMS:</b> ${prompt.substring(0, 50)}...`);
        const response = await runClaude(prompt, chatId, 'health');
        await sendMessage(chatId, response);
        stats.messagesProcessed++;
        return;
    }

    // ===== JUDGE MODE (JudgeFinder Analytics) =====
    if (text.startsWith('/judge ')) {
        const prompt = text.substring(7).trim();
        if (!prompt) {
            await sendMessage(chatId, 'Usage: /judge [query]\nJudicial analytics, search judges, court data.');
            return;
        }

        if (isProcessing) {
            messageQueue.push({ chatId, text, username, mode: 'judge' });
            await sendMessage(chatId, `Queued (#${messageQueue.length})`);
            return;
        }

        await sendMessage(chatId, `<b>Judicial Analytics:</b> ${prompt.substring(0, 50)}...`);
        const response = await runClaude(prompt, chatId, 'judge');
        await sendMessage(chatId, response);
        stats.messagesProcessed++;
        return;
    }

    // ===== PARALLEL AGENTS =====
    if (text.startsWith('/agents ')) {
        const match = text.match(/^\/agents\s+(\d+)\s+(.+)$/s);
        if (!match) {
            await sendMessage(chatId,
                'Usage: /agents [N] [query]\n\n' +
                'Examples:\n' +
                '• /agents 3 Research the top 3 JS frameworks\n' +
                '• /agents 5 Analyze 5 different stocks');
            return;
        }

        const numAgents = Math.min(parseInt(match[1]), MAX_PARALLEL_AGENTS);
        const basePrompt = match[2].trim();

        if (numAgents < 1) {
            await sendMessage(chatId, 'Need at least 1 agent');
            return;
        }

        if (isProcessing) {
            await sendMessage(chatId, 'Already processing. Please wait.');
            return;
        }

        // Create varied prompts for each agent
        const prompts = Array(numAgents).fill(null).map((_, i) =>
            `${basePrompt} (Focus area ${i + 1} of ${numAgents})`
        );

        await sendMessage(chatId, `<b>Launching ${numAgents} parallel agents...</b>\n${basePrompt.substring(0, 100)}`);
        const response = await runParallelAgents(prompts, chatId);
        await sendMessage(chatId, response);
        stats.messagesProcessed += numAgents;
        return;
    }

    // ===== DEFAULT MODE =====
    if (isProcessing) {
        messageQueue.push({ chatId, text, username, mode: 'default' });
        await sendMessage(chatId, `Queued (#${messageQueue.length})`);
        return;
    }

    await sendMessage(chatId, `Processing: ${text.substring(0, 40)}${text.length > 40 ? '...' : ''}`);

    const startTime = Date.now();
    const response = await runClaude(text, chatId, 'default');
    const duration = Math.round((Date.now() - startTime) / 1000);

    saveMessage({
        id: Date.now(),
        timestamp: new Date().toISOString(),
        username,
        chatId,
        prompt: text,
        response: response.substring(0, 5000),
        duration,
        status: 'completed'
    });

    stats.messagesProcessed++;
    updateHealth();

    await sendMessage(chatId, response);
    await sendMessage(chatId, `<i>Completed in ${duration}s</i>`);

    // Process queue
    if (messageQueue.length > 0) {
        const next = messageQueue.shift();
        setImmediate(() => processMessage({
            chat: { id: next.chatId },
            text: next.text,
            from: { username: next.username }
        }));
    }
}

// ============================================
// MAIN LOOP
// ============================================

async function pollLoop() {
    log('INFO', '='.repeat(50));
    log('INFO', 'Telegram-Claude Bridge v6 Started');
    log('INFO', `Modes: finance, dev, legal, health, judge`);
    log('INFO', `Features: HTML formatting, parallel agents, token tracking`);
    log('INFO', `Working dir: ${WORKING_DIR}`);
    log('INFO', `Max parallel agents: ${MAX_PARALLEL_AGENTS}`);
    log('INFO', `Allowed users: ${ALLOWED_CHAT_IDS.join(', ')}`);
    log('INFO', '='.repeat(50));

    updateHealth({ status: 'idle' });

    while (true) {
        try {
            const updates = await getUpdates();
            for (const update of updates) {
                lastUpdateId = update.update_id;
                saveState(lastUpdateId);
                if (update.message) {
                    await processMessage(update.message);
                }
            }
        } catch (error) {
            log('ERROR', 'Poll error:', error.message);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

// Validate and start
if (!BOT_TOKEN) {
    console.error('ERROR: Set TELEGRAM_BOT_TOKEN in .env');
    process.exit(1);
}

pollLoop().catch(console.error);
