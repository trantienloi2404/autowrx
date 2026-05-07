const vscode = require('vscode');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const TERMINAL_NAME = 'AutoWRX Console';
const RUNNER_RECONNECT_MS = 3000;
const SHELL_INTEGRATION_WAIT_MS = 150;
const SHELL_INTEGRATION_MAX_ATTEMPTS = 20;
const LOCAL_FALLBACK_RUNNER_WS_URL = 'ws://127.0.0.1:3200/v2/system/coder/runner/ws';
const VARS_EMIT_INTERVAL_MS = 1000;
const CONTROL_WRITE_GUARD_MS = 3000;

function activate(context) {
    console.log('AutoWRX runner extension is active');
    closeAllTerminalsForFreshSession();

    const runner = new RunnerBridge();
    runner.start();

    const disposableCmd = vscode.commands.registerCommand('autowrx-runner.triggerFromWeb', () => {
        runner.startRun('python-main', 'python3 -u main.py');
    });

    context.subscriptions.push(disposableCmd, {
        dispose: () => runner.dispose(),
    });
}

function closeAllTerminalsForFreshSession() {
    try {
        const terminals = vscode.window.terminals || [];
        terminals.forEach((terminal) => {
            try {
                terminal.dispose();
            } catch (error) {
                console.log(`[AutoWRX Runner] failed to close terminal: ${error?.message || error}`);
            }
        });
        if (terminals.length > 0) {
            console.log(`[AutoWRX Runner] closed ${terminals.length} existing terminal(s) for fresh session`);
        }
    } catch (error) {
        console.log(`[AutoWRX Runner] closeAllTerminalsForFreshSession failed: ${error?.message || error}`);
    }
}

class RunnerBridge {
    constructor() {
        this.ws = null;
        this.reconnectTimer = null;
        this.workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
        this.workspaceId = String(process.env.CODER_WORKSPACE_ID || '').trim();
        this.wsUrl = this.resolveWsUrl();
        this.runnerKey = String(process.env.AUTOWRX_RUNNER_KEY || '').trim();
        this.outputTerminal = null;
        this.activeExecution = null;
        this.varsChannel = null;
        this.pendingVarsPayload = null;
        this.lastVarsSentAt = 0;
        this.varsEmitTimer = null;
        this.recentRuntimeWrites = new Map();
        this.disposables = [];
        this.setupTerminalHooks();
    }

    resolveWsUrl() {
        const explicit = String(process.env.AUTOWRX_RUNNER_WS_URL || '').trim();
        if (explicit) return explicit;
        // Fallback for local/dev scenarios.
        return LOCAL_FALLBACK_RUNNER_WS_URL;
    }

    ensureTerminal() {
        // Re-resolve every time to survive manual terminal closes.
        let terminal = vscode.window.terminals.find((t) => t.name === TERMINAL_NAME);
        if (!terminal) {
            terminal = vscode.window.createTerminal({
                name: TERMINAL_NAME,
                cwd: this.workspacePath,
            });
        }
        this.outputTerminal = terminal;
        return terminal;
    }

    start() {
        if (!this.workspaceId) {
            vscode.window.showWarningMessage('AutoWRX Runner: CODER_WORKSPACE_ID is missing; websocket bridge disabled.');
            return;
        }
        this.log(`[AutoWRX Runner] workspaceId=${this.workspaceId}`);
        this.log(`[AutoWRX Runner] wsUrl=${this.wsUrl}`);
        this.connect();
    }

    connect() {
        const params = new URLSearchParams({
            workspace_id: this.workspaceId,
        });
        if (this.runnerKey) {
            params.set('runner_key', this.runnerKey);
        }
        const url = `${this.wsUrl}?${params.toString()}`;
        this.log(`[AutoWRX Runner] connecting: ${url}`);
        this.ws = new WebSocket(url);
        this.ws.on('open', () => {
            this.log('[AutoWRX Runner] websocket connected');
            this.send({
                type: 'runner.hello',
                workspaceId: this.workspaceId,
                at: new Date().toISOString(),
            });
        });

        this.ws.on('message', (raw) => {
            try {
                const payload = JSON.parse(String(raw));
                this.handleMessage(payload);
            } catch (error) {
                this.log(`[AutoWRX Runner] invalid message: ${error?.message || error}`);
            }
        });

        this.ws.on('close', (code, reason) => {
            this.log(`[AutoWRX Runner] websocket closed code=${code} reason=${String(reason || '')}`);
            this.scheduleReconnect();
        });
        this.ws.on('error', (err) => {
            this.log(`[AutoWRX Runner] websocket error: ${err?.message || err}`);
            this.scheduleReconnect();
        });
    }

    scheduleReconnect() {
        if (this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, RUNNER_RECONNECT_MS);
    }

    handleMessage(payload) {
        if (!payload || typeof payload !== 'object') return;
        switch (payload.type) {
            case 'run.start':
                void this.startRun(payload.runKind, payload.command);
                break;
            case 'run.stdin':
                this.writeStdin(payload.data);
                break;
            case 'run.stop':
                this.stopRun();
                break;
            case 'run.set_value':
                this.setRuntimeValue(payload.data);
                break;
            default:
                break;
        }
    }

    async startRun(runKind, command) {
        if (!command || typeof command !== 'string') return;
        const terminal = this.ensureTerminal();
        terminal.show(true);
        this.stopVarsChannel();
        this.recentRuntimeWrites.clear();
        let effectiveCommand = command;
        if (runKind === 'python-main') {
            effectiveCommand = this.buildPythonWrappedCommand(command);
        } else if (runKind === 'cpp-main') {
            effectiveCommand = this.buildCppWrappedCommand(command);
        } else if (runKind === 'rust-main') {
            effectiveCommand = this.buildRustWrappedCommand(command);
        }
        this.send({
            type: 'run.started',
            runKind: runKind || null,
            command: effectiveCommand,
            at: new Date().toISOString(),
        });

        const integration = await this.waitForShellIntegration(terminal);
        if (integration && typeof integration.executeCommand === 'function') {
            try {
                const execution = integration.executeCommand(effectiveCommand);
                this.activeExecution = execution;
                this.captureExecutionOutput(execution);
                return;
            } catch (error) {
                this.send({
                    type: 'run.error',
                    message: `executeCommand failed: ${error?.message || error}`,
                    at: new Date().toISOString(),
                });
            }
        }

        this.send({
            type: 'run.error',
            message: 'shellIntegration unavailable; output stream may be incomplete for this run',
            at: new Date().toISOString(),
        });
        // Last-resort fallback when shell integration is unavailable.
        terminal.sendText(effectiveCommand, true);
    }

    buildPythonWrappedCommand(command) {
        const wrapperPath = path.join(__dirname, 'python', 'autowrx_python_wrapper.py');
        if (!fs.existsSync(wrapperPath)) {
            this.send({
                type: 'run.error',
                message: 'python wrapper script is missing; running original command',
                at: new Date().toISOString(),
            });
            return command;
        }

        const varsPipePath = path.join(
            os.tmpdir(),
            `autowrx-vars-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.pipe`,
        );
        const controlPipePath = path.join(
            os.tmpdir(),
            `autowrx-control-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.pipe`,
        );
        try {
            execFileSync('mkfifo', [varsPipePath]);
            execFileSync('mkfifo', [controlPipePath]);
        } catch (error) {
            this.send({
                type: 'run.error',
                message: `failed to initialize python pipes: ${error?.message || error}`,
                at: new Date().toISOString(),
            });
            return command;
        }
        this.startVarsChannel(varsPipePath, controlPipePath);

        return [
            'python3 -u',
            `"${wrapperPath}"`,
            '--script',
            '"main.py"',
            '--vars-pipe',
            `"${varsPipePath}"`,
            '--control-pipe',
            `"${controlPipePath}"`,
        ].join(' ');
    }

    buildCppWrappedCommand(command) {
        const wrapperPath = path.join(__dirname, 'cpp', 'autowrx_cpp_gdb_wrapper.js');
        if (!fs.existsSync(wrapperPath)) {
            this.send({
                type: 'run.error',
                message: 'cpp gdb wrapper script is missing; running original command',
                at: new Date().toISOString(),
            });
            return command;
        }

        const varsPipePath = path.join(
            os.tmpdir(),
            `autowrx-vars-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.pipe`,
        );
        const controlPipePath = path.join(
            os.tmpdir(),
            `autowrx-control-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.pipe`,
        );
        try {
            execFileSync('mkfifo', [varsPipePath]);
            execFileSync('mkfifo', [controlPipePath]);
        } catch (error) {
            this.send({
                type: 'run.error',
                message: `failed to initialize cpp pipes: ${error?.message || error}`,
                at: new Date().toISOString(),
            });
            return command;
        }
        this.startVarsChannel(varsPipePath, controlPipePath);

        const commandParts = String(command || '')
            .split('&&')
            .map((part) => part.trim())
            .filter(Boolean);
        const runPart = commandParts.length > 0 ? commandParts[commandParts.length - 1] : '';
        const compilePart = commandParts.slice(0, -1).join(' && ');
        const runParts = runPart.split(/\s+/).filter(Boolean);
        const programPath = runParts[0] || './main';
        const nodeBin = process.execPath || 'node';
        const wrapperCommand = [
            `"${nodeBin}"`,
            `"${wrapperPath}"`,
            '--program',
            `"${programPath}"`,
            '--vars-pipe',
            `"${varsPipePath}"`,
            '--control-pipe',
            `"${controlPipePath}"`,
        ].join(' ');
        if (!compilePart) return wrapperCommand;
        return `${compilePart} && ${wrapperCommand}`;
    }

    getRustBinNameFromCargoToml(projectRoot) {
        const cargoPath = path.join(projectRoot, 'Cargo.toml');
        try {
            const content = fs.readFileSync(cargoPath, 'utf8');
            // Prefer the first [[bin]] definition if present.
            const binMatch = content.match(/\[\[bin\]\][\s\S]*?name\s*=\s*"([^"]+)"/m);
            if (binMatch?.[1]) return String(binMatch[1]).trim();
            // Fallback to [package] name.
            const pkgMatch = content.match(/\[package\][\s\S]*?name\s*=\s*"([^"]+)"/m);
            if (pkgMatch?.[1]) return String(pkgMatch[1]).trim();
        } catch {
            // ignore
        }
        return 'main';
    }

    buildRustWrappedCommand(command) {
        const wrapperPath = path.join(__dirname, 'rust', 'autowrx_rust_gdb_wrapper.js');
        if (!fs.existsSync(wrapperPath)) {
            this.send({
                type: 'run.error',
                message: 'rust gdb wrapper script is missing; running original command',
                at: new Date().toISOString(),
            });
            return command;
        }

        const varsPipePath = path.join(
            os.tmpdir(),
            `autowrx-vars-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.pipe`,
        );
        const controlPipePath = path.join(
            os.tmpdir(),
            `autowrx-control-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.pipe`,
        );

        try {
            execFileSync('mkfifo', [varsPipePath]);
            execFileSync('mkfifo', [controlPipePath]);
        } catch (error) {
            this.send({
                type: 'run.error',
                message: `failed to initialize rust pipes: ${error?.message || error}`,
                at: new Date().toISOString(),
            });
            return command;
        }
        this.startVarsChannel(varsPipePath, controlPipePath);

        const projectRoot = this.workspacePath;
        const binName = this.getRustBinNameFromCargoToml(projectRoot);
        const programPath = `./target/debug/${binName}`;

        const nodeBin = process.execPath || 'node';
        const wrapperCommand = [
            `"${nodeBin}"`,
            `"${wrapperPath}"`,
            '--program',
            `"${programPath}"`,
            '--vars-pipe',
            `"${varsPipePath}"`,
            '--control-pipe',
            `"${controlPipePath}"`,
        ].join(' ');

        // Always build in debug profile; cargo defaults to dev profile.
        const compilePart = 'cargo build --quiet';
        return `${compilePart} && ${wrapperCommand}`;
    }

    setRuntimeValue(data) {
        if (!data || typeof data !== 'object') return;
        const api = String(data.api || '').trim();
        if (!api) return;
        const normalizedValue = this.normalizeRuntimeValue(data.value);
        const payload = {
            type: 'set_value',
            name: api,
            value: normalizedValue,
            at: new Date().toISOString(),
        };
        const controlPipePath = this.varsChannel?.controlPipePath;
        if (!controlPipePath) {
            return;
        }
        try {
            fs.appendFileSync(controlPipePath, `${JSON.stringify(payload)}\n`);
            this.recentRuntimeWrites.set(api, {
                value: normalizedValue,
                atMs: Date.now(),
            });
            // If a stale payload is already queued for throttled emission, patch it now.
            if (this.pendingVarsPayload?.vars && typeof this.pendingVarsPayload.vars === 'object') {
                this.pendingVarsPayload.vars[api] = normalizedValue;
            }
            // Flush immediately so UI sees the user write before any delayed stale frame.
            this.emitPendingVarsIfDue(true);
        } catch (error) {
            this.send({
                type: 'run.error',
                message: `run.set_value failed: ${error?.message || error}`,
                at: new Date().toISOString(),
            });
        }
    }

    startVarsChannel(varsPipePath, controlPipePath) {
        this.stopVarsChannel();
        const readStream = fs.createReadStream(varsPipePath, { encoding: 'utf8' });
        this.varsChannel = {
            varsPipePath,
            controlPipePath,
            readStream,
            residue: '',
        };
        readStream.on('data', (chunk) => {
            this.consumeVarsChunk(String(chunk || ''));
        });
        readStream.on('error', (error) => {
            this.send({
                type: 'run.error',
                message: `vars pipe read failed: ${error?.message || error}`,
                at: new Date().toISOString(),
            });
        });
        readStream.on('end', () => {
            this.emitPendingVarsIfDue(true);
        });
    }

    emitPendingVarsIfDue(force = false) {
        const pending = this.pendingVarsPayload;
        if (!pending) return;
        this.applyRecentWriteGuard(pending.vars);
        const now = Date.now();
        if (!force && now - this.lastVarsSentAt < VARS_EMIT_INTERVAL_MS) {
            const waitMs = Math.max(1, VARS_EMIT_INTERVAL_MS - (now - this.lastVarsSentAt));
            if (!this.varsEmitTimer) {
                this.varsEmitTimer = setTimeout(() => {
                    this.varsEmitTimer = null;
                    this.emitPendingVarsIfDue();
                }, waitMs);
            }
            return;
        }
        this.send({
            type: 'run.vars',
            vars: pending.vars,
            frame: pending.frame || null,
            at: new Date().toISOString(),
        });
        this.pendingVarsPayload = null;
        this.lastVarsSentAt = now;
    }

    consumeVarsChunk(chunk) {
        const channel = this.varsChannel;
        if (!channel) return;
        if (!chunk) return;
        const joined = `${channel.residue || ''}${chunk}`;
        const lines = joined.split(/\r?\n/);
        channel.residue = lines.pop() || '';

        lines.forEach((line) => {
            const text = String(line || '').trim();
            if (!text) return;
            try {
                const payload = JSON.parse(text);
                if (payload?.type !== 'vars.snapshot') return;
                const vars = payload?.vars;
                if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return;
                this.applyRecentWriteGuard(vars);
                this.pendingVarsPayload = {
                    vars,
                    frame: payload.frame || null,
                };
            } catch {
                // ignore malformed line
            }
        });
        this.emitPendingVarsIfDue();
    }

    stopVarsChannel() {
        const state = this.varsChannel;
        if (!state) return;
        this.emitPendingVarsIfDue(true);
        if (this.varsEmitTimer) {
            clearTimeout(this.varsEmitTimer);
            this.varsEmitTimer = null;
        }
        try {
            state.readStream?.destroy();
        } catch {
            // ignore
        }
        try {
            if (state.varsPipePath) fs.unlinkSync(state.varsPipePath);
        } catch {
            // ignore
        }
        try {
            if (state.controlPipePath) fs.unlinkSync(state.controlPipePath);
        } catch {
            // ignore
        }
        this.varsChannel = null;
        this.pendingVarsPayload = null;
        this.recentRuntimeWrites.clear();
    }

    normalizeRuntimeValue(value) {
        if (typeof value !== 'string') return value;
        const low = value.trim().toLowerCase();
        if (low === 'true') return true;
        if (low === 'false') return false;
        if (low === 'null' || low === 'none' || low === 'nil') return null;
        return value;
    }

    valuesEqual(a, b) {
        if (Object.is(a, b)) return true;
        try {
            return JSON.stringify(a) === JSON.stringify(b);
        } catch {
            return false;
        }
    }

    applyRecentWriteGuard(vars) {
        if (!vars || typeof vars !== 'object') return;
        const now = Date.now();
        for (const [name, info] of this.recentRuntimeWrites.entries()) {
            if (!info || now - info.atMs > CONTROL_WRITE_GUARD_MS) {
                this.recentRuntimeWrites.delete(name);
                continue;
            }
            if (!(name in vars)) continue;
            if (this.valuesEqual(vars[name], info.value)) {
                this.recentRuntimeWrites.delete(name);
                continue;
            }
            // Prevent stale snapshots from briefly overriding user-controlled values.
            vars[name] = info.value;
        }
    }

    async waitForShellIntegration(terminal) {
        for (let i = 0; i < SHELL_INTEGRATION_MAX_ATTEMPTS; i += 1) {
            if (terminal !== this.outputTerminal) return null;
            const integration = terminal.shellIntegration;
            if (integration && typeof integration.executeCommand === 'function') {
                return integration;
            }
            await new Promise((resolve) => setTimeout(resolve, SHELL_INTEGRATION_WAIT_MS));
        }
        return null;
    }

    writeStdin(data) {
        const line = typeof data === 'string' ? data : String(data ?? '');
        const terminal = this.ensureTerminal();
        terminal.show(true);
        terminal.sendText(line, true);
    }

    stopRun() {
        const terminal = this.ensureTerminal();
        terminal.show(true);
        // Send Ctrl+C into the active terminal.
        terminal.sendText('\u0003', false);
    }

    setupTerminalHooks() {
        const closed = vscode.window.onDidCloseTerminal((terminal) => {
            if (terminal !== this.outputTerminal) return;
            this.log('[AutoWRX Runner] terminal closed by user');
            this.send({
                type: 'run.exit',
                code: null,
                signal: 'terminal_closed',
                at: new Date().toISOString(),
            });
            this.outputTerminal = null;
            this.activeExecution = null;
        });

        const started = vscode.window.onDidStartTerminalShellExecution((event) => {
            if (!this.outputTerminal || event.terminal !== this.outputTerminal) return;
            this.activeExecution = event.execution;
        });

        const ended = vscode.window.onDidEndTerminalShellExecution((event) => {
            if (!this.outputTerminal || event.terminal !== this.outputTerminal) return;
            if (this.activeExecution && event.execution !== this.activeExecution) return;
            this.stopVarsChannel();
            this.send({
                type: 'run.exit',
                code: event.exitCode ?? null,
                signal: null,
                at: new Date().toISOString(),
            });
            this.activeExecution = null;
        });

        this.disposables.push(closed, started, ended);
    }

    async captureExecutionOutput(execution) {
        if (!execution || typeof execution.read !== 'function') return;
        try {
            for await (const chunk of execution.read()) {
                const text = typeof chunk === 'string' ? chunk : String(chunk ?? '');
                if (!text) continue;
                this.send({
                    type: 'run.output',
                    stream: 'stdout',
                    data: text,
                    at: new Date().toISOString(),
                });
            }
        } catch (error) {
            this.send({
                type: 'run.error',
                message: `read() failed: ${error?.message || error}`,
                at: new Date().toISOString(),
            });
        }
    }

    send(payload) {
        try {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify(payload));
            }
        } catch {
            // ignore
        }
    }

    dispose() {
        this.stopVarsChannel();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            try {
                this.ws.close();
            } catch {
                // ignore
            }
            this.ws = null;
        }
        this.stopRun();
        this.disposables.forEach((d) => d.dispose());
        this.disposables = [];
    }

    log(message) {
        console.log(message);
    }
}

function deactivate() { }

module.exports = {
    activate,
    deactivate,
};
