/**
 * ConnectionUI - Robot connection management UI
 * Simplified for cartesian impedance control (read-only visualization)
 */

const CONNECTION_PANEL_OFFSET_X = 50;

export class ConnectionUI {
    constructor(robotConnection, panelManager = null) {
        this.robotConnection = robotConnection;
        this.panelManager = panelManager;
        this.onConnect = null;      // (config) => void
        this.onDisconnect = null;   // () => void
        this.onModeChanged = null;  // (mode) => void

        this.panel = null;
        this.statusIndicator = null;
        this.connectBtn = null;
        this.serverInput = null;

        // Default server URL
        this.serverUrl = 'http://localhost:5000';

        // Control mode
        this.currentMode = 'position';

        // Waypoint state
        this.waypoints = [];
        this.maxWaypoints = 6;
        this.trajectoryRunning = false;
    }

    /**
     * Create and inject connection UI elements
     */
    createUI() {
        this.createConnectionPanel();
        this.createTopBarIndicator();
        this.createControlSections();
        this.setupCallbacks();
    }

    /**
     * Create floating connection panel
     */
    createConnectionPanel() {
        let panelContainer = document.getElementById('floating-connection-panel');
        if (panelContainer) {
            this.panel = panelContainer;
            this.setupPanelElements();
            this.panelManager?.registerPanel('floating-connection-panel');
            return;
        }

        this.panel = document.createElement('div');
        this.panel.id = 'floating-connection-panel';
        this.panel.className = 'floating-panel';
        this.panel.innerHTML = `
            <div class="floating-panel-header">
                <span>Robot Connection</span>
                <button class="panel-close-btn" title="Close">×</button>
            </div>
            <div class="floating-panel-content">
                <div class="connection-status-section">
                    <div class="connection-status">
                        <span class="status-dot disconnected"></span>
                        <span class="status-text">Disconnected</span>
                    </div>
                    <div class="connection-mode"></div>
                </div>

                <div class="connection-form">
                    <label for="server-url">Server URL</label>
                    <input type="text" id="server-url" value="http://localhost:5000" placeholder="http://localhost:5000">
                </div>

                <div class="connection-buttons">
                    <button id="connect-btn" class="control-button primary">Connect</button>
                    <button id="disconnect-btn" class="control-button" disabled>Disconnect</button>
                </div>

                <div class="robot-info" style="display: none;">
                    <div class="info-row">
                        <span class="info-label">Robot:</span>
                        <span class="info-value" id="robot-name">-</span>
                    </div>
                    <div class="info-row">
                        <span class="info-label">Joints:</span>
                        <span class="info-value" id="joint-count">-</span>
                    </div>
                    <div class="info-row">
                        <span class="info-label">Mode:</span>
                        <span class="info-value" id="connection-mode">-</span>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(this.panel);
        this.setupPanelElements();
        this.panelManager?.registerPanel('floating-connection-panel');
    }

    /**
     * Setup panel element references and events
     */
    setupPanelElements() {
        this.serverInput = this.panel.querySelector('#server-url');
        this.connectBtn = this.panel.querySelector('#connect-btn');
        const disconnectBtn = this.panel.querySelector('#disconnect-btn');
        const closeBtn = this.panel.querySelector('.panel-close-btn');

        if (this.connectBtn) {
            this.connectBtn.addEventListener('click', () => this.handleConnect());
        }

        if (disconnectBtn) {
            disconnectBtn.addEventListener('click', () => this.handleDisconnect());
        }

        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.hidePanel());
        }
    }

    /**
     * Create top bar connection indicator
     */
    createTopBarIndicator() {
        const topBar = document.getElementById('top-control-bar');
        if (!topBar) return;

        if (document.getElementById('connection-indicator')) return;

        const divider = document.createElement('div');
        divider.className = 'control-bar-divider';

        this.statusIndicator = document.createElement('button');
        this.statusIndicator.id = 'connection-indicator';
        this.statusIndicator.className = 'tool-button';
        this.statusIndicator.innerHTML = `
            <span class="status-dot-small disconnected"></span>
            <span class="connection-label">Robot Connection</span>
        `;
        this.statusIndicator.title = 'Robot Connection';
        this.statusIndicator.addEventListener('click', () => this.togglePanel());
        this.statusIndicator.classList.toggle('active', this.panel ? !this.panel.classList.contains('hidden') : false);

        topBar.insertBefore(this.statusIndicator, topBar.firstChild);
        topBar.insertBefore(divider, this.statusIndicator.nextSibling);

        requestAnimationFrame(() => this.positionInitialPanel());
    }

    positionInitialPanel() {
        if (!this.panel || !this.statusIndicator || !this.panelManager) return;
        if (!this.panelManager.isPanelVisible('floating-connection-panel')) return;

        this.panelManager.positionPanelBelowElement(
            'floating-connection-panel',
            this.statusIndicator,
            'center',
            10,
            CONNECTION_PANEL_OFFSET_X
        );
        this.statusIndicator.classList.add('active');
    }

    /**
     * Create control sections (mode buttons, quick controls, waypoints)
     * Appended to the connection panel after robot-info
     */
    createControlSections() {
        if (!this.panel) return;
        const content = this.panel.querySelector('.floating-panel-content');
        if (!content) return;
        if (document.getElementById('control-sections')) return;

        const sections = document.createElement('div');
        sections.id = 'control-sections';
        sections.style.display = 'none';

        sections.innerHTML = `
            <!-- Control Mode -->
            <div class="robot-controls" style="margin-top: 12px;">
                <div style="font-size:11px;font-weight:600;color:var(--text-secondary);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px;">Control Mode</div>
                <div id="mode-buttons" style="display:flex;gap:4px;">
                    <button class="mode-btn control-button active" data-mode="position" style="flex:1;padding:6px 8px;font-size:11px;border-radius:6px;">Position</button>
                    <button class="mode-btn control-button" data-mode="gravity_comp" style="flex:1;padding:6px 8px;font-size:11px;border-radius:6px;">Gravity</button>
                    <button class="mode-btn control-button" data-mode="gravity_friction" style="flex:1;padding:6px 8px;font-size:11px;border-radius:6px;">Gra+Fri</button>
                    <button class="mode-btn control-button" data-mode="impedance" style="flex:1;padding:6px 8px;font-size:11px;border-radius:6px;">Impedance</button>
                </div>
            </div>

            <!-- Waypoints -->
            <div id="waypoints-section" class="robot-controls" style="margin-top: 8px;">
                <div class="waypoints-content">
                    <div style="font-size:11px;font-weight:600;color:var(--text-secondary);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px;">
                        Waypoints <span id="wp-count" style="color:var(--text-tertiary);font-weight:400;">(0/6)</span>
                    </div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px;">
                        <button id="wp-add" class="control-button" style="padding:8px;font-size:12px;">+ Add Current</button>
                        <button id="wp-clear" class="control-button danger" style="padding:8px;font-size:12px;">Clear</button>
                    </div>
                    <div id="wp-list" style="max-height:120px;overflow-y:auto;margin-bottom:6px;font-size:11px;color:var(--text-tertiary);">
                        <div style="text-align:center;padding:8px;">No waypoints</div>
                    </div>
                    <div style="margin-bottom:6px;">
                        <button id="wp-go-first" class="control-button" style="width:100%;padding:8px;font-size:12px;">Move to Point 1</button>
                    </div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
                        <button id="wp-run" class="control-button" style="padding:8px;font-size:12px;">▶ Run Trajectory</button>
                        <button id="wp-stop" class="control-button danger" style="padding:8px;font-size:12px;" disabled>■ Stop</button>
                    </div>
                </div>
                <div class="waypoints-lock-overlay">Disabled in impedance</div>
            </div>
        `;

        content.appendChild(sections);
        this.bindControlEvents();
        this.updateWaypointLockState();
        this.updateWaypointButtonState();
    }

    /** Bind control section button events */
    bindControlEvents() {
        // Mode buttons
        document.querySelectorAll('.mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.getAttribute('data-mode');
                this.setControlMode(mode);
            });
        });

        // Waypoints
        document.getElementById('wp-add')?.addEventListener('click', () => this.addWaypoint());
        document.getElementById('wp-clear')?.addEventListener('click', () => this.clearWaypoints());
        document.getElementById('wp-go-first')?.addEventListener('click', () => this.goToFirstWaypoint());
        document.getElementById('wp-run')?.addEventListener('click', () => this.runTrajectory());
        document.getElementById('wp-stop')?.addEventListener('click', () => this.stopTrajectory());
    }

    /** Set control mode via WebSocket */
    setControlMode(mode) {
        if (!this.robotConnection.isConnected()) return;
        this.robotConnection.setMode(mode);
        this.currentMode = mode;
        document.querySelectorAll('.mode-btn').forEach(b => {
            b.classList.toggle('active', b.getAttribute('data-mode') === mode);
        });
        this.updateWaypointLockState();
        this.updateWaypointButtonState();
        if (this.onModeChanged) this.onModeChanged(mode);
    }

    isWaypointLocked() {
        return this.currentMode === 'impedance';
    }

    updateWaypointLockState() {
        const section = document.getElementById('waypoints-section');
        if (section) section.classList.toggle('waypoints-locked', this.isWaypointLocked());
    }

    updateWaypointButtonState() {
        const connected = Boolean(this.robotConnection?.isConnected?.());
        const locked = this.isWaypointLocked();
        const addBtn = document.getElementById('wp-add');
        const clearBtn = document.getElementById('wp-clear');
        const goFirstBtn = document.getElementById('wp-go-first');
        const runBtn = document.getElementById('wp-run');
        const stopBtn = document.getElementById('wp-stop');

        if (addBtn) addBtn.disabled = locked || !connected || this.waypoints.length >= this.maxWaypoints;
        if (clearBtn) clearBtn.disabled = locked || !connected || this.waypoints.length === 0;
        if (goFirstBtn) goFirstBtn.disabled = locked || !connected || this.trajectoryRunning || this.waypoints.length < 1;
        if (runBtn) runBtn.disabled = locked || !connected || this.trajectoryRunning || this.waypoints.length < 2;
        if (stopBtn) stopBtn.disabled = locked || !connected || !this.trajectoryRunning;
    }

    /** Add current robot position as waypoint */
    addWaypoint() {
        if (this.isWaypointLocked()) return;
        if (!this.robotConnection.isConnected()) return;
        const state = this.robotConnection.getState();
        if (!state || !state.positions || state.positions.length === 0) return;

        if (this.waypoints.length >= this.maxWaypoints) return;

        const waypoint = {
            positions: [...state.positions],
            duration: 1.0,
            index: this.waypoints.length
        };
        this.waypoints.push(waypoint);
        this.robotConnection.socket.emit('add_waypoint', {
            positions: waypoint.positions,
            duration: waypoint.duration
        });
        this.updateWaypointUI();
    }

    /** Clear all waypoints */
    clearWaypoints() {
        if (this.isWaypointLocked() || !this.robotConnection.isConnected()) return;
        this.waypoints = [];
        this.robotConnection.socket.emit('clear_waypoints');
        this.updateWaypointUI();
    }

    /** Move to the first waypoint */
    goToFirstWaypoint() {
        if (this.isWaypointLocked() || !this.robotConnection.isConnected()) return;
        if (this.trajectoryRunning || this.waypoints.length < 1) return;
        this.robotConnection.socket.emit('go_to_waypoint', { index: 0 });
    }

    /** Run trajectory */
    runTrajectory() {
        if (this.isWaypointLocked() || !this.robotConnection.isConnected()) return;
        if (this.waypoints.length < 2) return;
        if (this.currentMode === 'gravity_comp' || this.currentMode === 'gravity_friction') {
            this.setControlMode('position');
        }
        this.trajectoryRunning = true;
        this.robotConnection.socket.emit('run_trajectory', { control_rate: 100 });
        this.updateWaypointButtonState();
    }

    /** Stop trajectory */
    stopTrajectory() {
        if (this.isWaypointLocked() || !this.robotConnection.isConnected()) return;
        this.trajectoryRunning = false;
        this.robotConnection.socket.emit('stop_trajectory');
        this.updateWaypointButtonState();
    }

    /** Update waypoint list UI */
    updateWaypointUI() {
        const list = document.getElementById('wp-list');
        const count = document.getElementById('wp-count');
        if (!list) return;
        if (count) count.textContent = `(${this.waypoints.length}/${this.maxWaypoints})`;

        if (this.waypoints.length === 0) {
            list.innerHTML = '<div style="text-align:center;padding:8px;">No waypoints</div>';
            this.updateWaypointButtonState();
            return;
        }

        list.innerHTML = this.waypoints.map((wp, i) => {
            const posStr = wp.positions.map(p => p.toFixed(2)).join(', ');
            const dur = (wp.duration || 1.0).toFixed(1);
            return `<div style="padding:4px 6px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;justify-content:space-between;">
                <span style="color:var(--accent);font-weight:500;">#${i+1}</span>
                <span style="color:var(--text-tertiary);">[${posStr}]</span>
                <span style="color:var(--text-tertiary);">${dur}s</span>
            </div>`;
        }).join('');
        this.updateWaypointButtonState();
    }

    /**
     * Setup robot connection callbacks
     */
    setupCallbacks() {
        this.robotConnection.onConnected = () => {
            this.updateConnectionStatus(true);
            this.bindSocketEvents();
            this.updateWaypointLockState();
            this.updateWaypointButtonState();
        };

        this.robotConnection.onDisconnected = () => {
            this.updateConnectionStatus(false);
            this.waypoints = [];
            this.trajectoryRunning = false;
            this.updateWaypointLockState();
            this.updateWaypointButtonState();
            if (this.onDisconnect) this.onDisconnect();
        };

        this.robotConnection.onConfigReceived = (config) => {
            this.updateRobotInfo(config);
            if (config.control_mode) {
                this.currentMode = config.control_mode;
                document.querySelectorAll('.mode-btn').forEach(b => {
                    b.classList.toggle('active', b.getAttribute('data-mode') === config.control_mode);
                });
                this.updateWaypointLockState();
                this.updateWaypointButtonState();
                if (this.onModeChanged) this.onModeChanged(config.control_mode);
            }
            if (this.onConnect) this.onConnect(config);
        };

        this.robotConnection.onError = (error) => {
            this.showError(error.message || 'Connection failed');
        };

        // Mode changed callback from RobotConnection
        this.robotConnection.onModeChanged = (mode) => {
            this.currentMode = mode;
            document.querySelectorAll('.mode-btn').forEach(b => {
                b.classList.toggle('active', b.getAttribute('data-mode') === mode);
            });
            this.updateWaypointLockState();
            this.updateWaypointButtonState();
            if (this.onModeChanged) this.onModeChanged(mode);
        };
    }

    /** Bind WebSocket events after connection */
    bindSocketEvents() {
        const sock = this.robotConnection.socket;
        if (!sock) return;

        sock.off('waypoints_updated');
        sock.off('trajectory_complete');
        sock.off('trajectory_error');

        sock.on('waypoints_updated', (data) => {
            if (data.waypoints) {
                this.waypoints = data.waypoints;
                this.updateWaypointUI();
            }
        });

        sock.on('trajectory_complete', () => {
            this.trajectoryRunning = false;
            this.updateWaypointButtonState();
        });

        sock.on('trajectory_error', (data) => {
            this.trajectoryRunning = false;
            this.updateWaypointButtonState();
            if (data.error) this.showError(data.error);
        });
    }

    /**
     * Handle connect button click
     */
    async handleConnect() {
        const url = this.serverInput ? this.serverInput.value.trim() : this.serverUrl;
        if (!url) {
            this.showError('Please enter server URL');
            return;
        }

        this.serverUrl = url;
        this.setConnecting(true);

        try {
            await this.robotConnection.connect(url);
        } catch (error) {
            this.showError(error.message || 'Failed to connect');
            this.setConnecting(false);
        }
    }

    /**
     * Handle disconnect button click
     */
    handleDisconnect() {
        this.robotConnection.disconnect();
        this.updateConnectionStatus(false);
    }

    /**
     * Update connection status display
     */
    updateConnectionStatus(connected) {
        const statusDot = this.panel?.querySelector('.status-dot');
        const statusText = this.panel?.querySelector('.status-text');
        const connectBtn = this.panel?.querySelector('#connect-btn');
        const disconnectBtn = this.panel?.querySelector('#disconnect-btn');
        const robotInfo = this.panel?.querySelector('.robot-info');
        const controlSections = document.getElementById('control-sections');

        if (statusDot) {
            statusDot.className = `status-dot ${connected ? 'connected' : 'disconnected'}`;
        }
        if (statusText) {
            statusText.textContent = connected ? 'Connected' : 'Disconnected';
        }
        if (connectBtn) {
            connectBtn.disabled = connected;
            connectBtn.textContent = 'Connect';
        }
        if (disconnectBtn) {
            disconnectBtn.disabled = !connected;
        }
        if (robotInfo) {
            robotInfo.style.display = connected ? 'block' : 'none';
        }
        if (controlSections) {
            controlSections.style.display = connected ? 'block' : 'none';
        }

        // Update top bar indicator
        if (this.statusIndicator) {
            const dot = this.statusIndicator.querySelector('.status-dot-small');
            const label = this.statusIndicator.querySelector('.connection-label');

            if (dot) {
                dot.className = `status-dot-small ${connected ? 'connected' : 'disconnected'}`;
            }
            if (label) {
                label.textContent = 'Robot Connection';
            }

            const panelOpen = this.panelManager?.isPanelVisible('floating-connection-panel') ||
                (this.panel && !this.panel.classList.contains('hidden'));
            this.statusIndicator.classList.toggle('active', Boolean(panelOpen));
        }
    }

    /**
     * Update robot info display
     */
    updateRobotInfo(config) {
        if (!config) return;

        const robotName = this.panel?.querySelector('#robot-name');
        const jointCount = this.panel?.querySelector('#joint-count');
        const connectionMode = this.panel?.querySelector('#connection-mode');

        if (robotName) {
            robotName.textContent = config.robot_name || 'Unknown';
        }
        if (jointCount) {
            jointCount.textContent = config.joints?.length || '-';
        }
        if (connectionMode) {
            connectionMode.textContent = config.demo_mode ? 'Demo Mode' : 'Live Robot';
            connectionMode.className = `info-value ${config.demo_mode ? 'demo' : 'live'}`;
        }
    }

    /**
     * Show connecting state
     */
    setConnecting(connecting) {
        if (this.connectBtn) {
            this.connectBtn.disabled = connecting;
            this.connectBtn.textContent = connecting ? 'Connecting...' : 'Connect';
        }
    }

    /**
     * Show error message
     */
    showError(message) {
        console.error('[ConnectionUI]', message);

        const toast = document.createElement('div');
        toast.className = 'error-toast';
        toast.textContent = message;
        document.body.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('fade-out');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    togglePanel() {
        if (this.panel) {
            let visible;
            if (this.panelManager) {
                visible = this.panelManager.togglePanel('floating-connection-panel', 'flex', {
                    anchorEl: this.statusIndicator,
                    align: 'center',
                    offsetX: CONNECTION_PANEL_OFFSET_X
                });
            } else {
                visible = !this.panel.classList.toggle('hidden');
            }
            this.statusIndicator?.classList.toggle('active', visible);
        }
    }

    showPanel() {
        if (this.panel) {
            if (this.panelManager) {
                this.panelManager.showPanel('floating-connection-panel', 'flex', {
                    anchorEl: this.statusIndicator,
                    align: 'center',
                    offsetX: CONNECTION_PANEL_OFFSET_X
                });
            } else {
                this.panel.classList.remove('hidden');
            }
            this.statusIndicator?.classList.add('active');
        }
    }

    hidePanel() {
        if (this.panel) {
            if (this.panelManager) {
                this.panelManager.hidePanel('floating-connection-panel');
            } else {
                this.panel.classList.add('hidden');
            }
            this.statusIndicator?.classList.remove('active');
        }
    }

    isConnected() {
        return this.robotConnection.isConnected();
    }
}
