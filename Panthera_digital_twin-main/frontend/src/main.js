/**
 * Digital Twin - Main Application Entry Point
 * Cartesian impedance visualization with force/torque 3D arrows
 */
import * as THREE from 'three';
import * as d3 from 'd3';
import { SceneManager } from './renderer/SceneManager.js';
import { UIController } from './ui/UIController.js';
import { FileHandler } from './controllers/FileHandler.js';
import { JointControlsUI } from './ui/JointControlsUI.js';
import { PanelManager } from './ui/PanelManager.js';
import { ModelGraphView } from './views/ModelGraphView.js';
import { FileTreeView } from './views/FileTreeView.js';
import { MeasurementController } from './controllers/MeasurementController.js';
import { i18n } from './utils/i18n.js';
import { RobotConnection, robotConnection } from './robot/RobotConnection.js';
import { ConnectionUI } from './ui/ConnectionUI.js';
import { KeyboardControlUI } from './ui/KeyboardControlUI.js';
import { ScriptControlUI } from './ui/ScriptControlUI.js';

// Expose d3 globally for PanelManager
window.d3 = d3;
window.i18n = i18n;

class DigitalTwinApp {
    constructor() {
        this.sceneManager = null;
        this.uiController = null;
        this.fileHandler = null;
        this.jointControlsUI = null;
        this.panelManager = null;
        this.modelGraphView = null;
        this.fileTreeView = null;
        this.measurementController = null;
        this.currentModel = null;
        this.angleUnit = 'rad';

        // Robot connection
        this.robotConnection = robotConnection;
        this.connectionUI = null;
        this.keyboardControlUI = null;
        this.scriptControlUI = null;
        this.robotConfig = null;
        this.isConnectedMode = false;
        this.endEffectorOffset = 0.07;  // Backend FK display offset; marker uses configured end_effector_link.
        this.endEffectorLinkName = null;
        this.endEffectorMarkerOffset = new THREE.Vector3(0.16555, 0, 0);
        this.endEffectorMarker = null;  // Red dot showing actual end effector position
        this.arrowOffset = new THREE.Vector3(0, 0, 0);

        // Force/torque 3D arrows (custom cylinder+cone for thick lines)
        this.forceArrow = null;
        this.torqueArrow = null;
        this.FORCE_SCALE = 5e-3;   // 10N → 50mm arrow
        this.TORQUE_SCALE = 1e-3;  // 4Nm → 4mm arrow
        this.FORCE_THRESHOLD = 0.5;
        this.TORQUE_THRESHOLD = 0.1;
        this.SHAFT_RADIUS = 0.005;  // 5mm thick shaft
        this.HEAD_LENGTH = 0.020;   // 20mm cone head
        this.HEAD_RADIUS = 0.010;   // 10mm cone radius
    }

    async init() {
        try {
            // Initialize i18n
            i18n.init();

            // Initialize scene manager
            const canvas = document.getElementById('canvas');
            if (!canvas) {
                console.error('Canvas element not found');
                return;
            }

            this.sceneManager = new SceneManager(canvas);
            window.sceneManager = this.sceneManager;

            // Initialize file handler
            this.fileHandler = new FileHandler();
            this.fileHandler.setupFileDrop();

            this.fileHandler.onFilesLoaded = (files) => {
                if (this.fileTreeView) {
                    this.fileTreeView.updateFileTree(files, this.fileHandler.getFileMap());
                }
            };

            this.fileHandler.onModelLoaded = (model, file, isMesh = false) => {
                this.handleModelLoaded(model, file, isMesh);
            };

            // Initialize joint controls UI with robot connection support
            this.jointControlsUI = new JointControlsUI(this.sceneManager);
            this.jointControlsUI.setRobotConnection(this.robotConnection);

            // Initialize model graph view
            this.modelGraphView = new ModelGraphView(this.sceneManager);

            // Initialize file tree view
            this.fileTreeView = new FileTreeView();
            this.fileTreeView.onFileClick = (fileInfo) => {
                this.handleFileClick(fileInfo);
            };
            this.fileTreeView.updateFileTree([], new Map());

            // Initialize panel manager
            this.panelManager = new PanelManager();
            this.panelManager.initAllPanels();

            if (this.modelGraphView) {
                this.panelManager.setModelGraphView(this.modelGraphView);
            }

            // Initialize UI controller
            this.uiController = new UIController(this.sceneManager);
            this.uiController.setupAll({
                onThemeChanged: (theme) => this.handleThemeChanged(theme),
                onAngleUnitChanged: (unit) => this.handleAngleUnitChanged(unit),
                onIgnoreLimitsChanged: (ignore) => this.handleIgnoreLimitsChanged(ignore),
                onLanguageChanged: (lang) => this.handleLanguageChanged(lang),
                onResetJoints: () => this.handleResetJoints()
            });

            // Set measurement update callback
            this.sceneManager.onMeasurementUpdate = () => {
                if (this.measurementController) {
                    this.measurementController.updateMeasurement();
                }
            };

            // Set joint drag update callback
            // In connected mode: read-only, don't send commands
            this.sceneManager.onJointDragUpdate = (joint, angle, model) => {
                if (this.isConnectedMode && this.robotConnection && this.robotConnection.isConnected()) {
                    return true;  // Indicate connected - prevent local visualization update
                }
                return false;  // Let SceneManager update visualization locally
            };

            // Setup canvas click handler
            this.setupCanvasClickHandler(canvas);

            // Initialize measurement controller
            this.measurementController = new MeasurementController(this.sceneManager);

            if (this.modelGraphView) {
                this.modelGraphView.setMeasurementController(this.measurementController);
            }

            // Initialize connection UI
            this.connectionUI = new ConnectionUI(this.robotConnection, this.panelManager);
            this.connectionUI.createUI();
            this.connectionUI.onModeChanged = (mode) => {
                this.jointControlsUI.setControlMode(mode);
            };

            // Initialize keyboard control UI
            this.keyboardControlUI = new KeyboardControlUI(this.robotConnection);
            this.keyboardControlUI.init();

            // Initialize script control UI (SDK example runner)
            this.scriptControlUI = new ScriptControlUI(this.panelManager);
            this.scriptControlUI.createUI();

            // Setup robot connection callbacks
            this.setupRobotConnectionCallbacks();

            // Setup model tree panel
            this.setupModelTreePanel();

            // Setup FK panel toggle
            this.setupFKPanel();

            // Start render loop
            this.animate();

            console.log('[DigitalTwin] Application initialized');

            // Auto-load default URDF from arm_description folder
            this.loadDefaultURDF();

        } catch (error) {
            console.error('Initialization error:', error);
        }
    }

    /**
     * Load default URDF from arm_description folder
     */
    async loadDefaultURDF() {
        try {
            const response = await fetch('/api/arm_description_files');
            if (!response.ok) {
                console.log('[DigitalTwin] No default URDF available (backend not running or arm_description not found)');
                return;
            }

            const data = await response.json();
            if (!data.success || !data.files) {
                console.log('[DigitalTwin] No files found in arm_description');
                return;
            }

            console.log('[DigitalTwin] Loading default URDF from arm_description...');
            await this.fileHandler.loadFromServer(data.base_url, data.files);

        } catch (error) {
            console.log('[DigitalTwin] Default URDF not loaded:', error.message);
        }
    }

    /**
     * Setup robot connection callbacks
     */
    setupRobotConnectionCallbacks() {
        // On connection established
        this.connectionUI.onConnect = (config) => {
            console.log('[DigitalTwin] Robot connected:', config);
            this.robotConfig = config;
            this.isConnectedMode = true;
            this.endEffectorOffset = config.end_effector_offset || 0;
            this.endEffectorLinkName = config.end_effector_link || null;

            // Enable connected mode in joint controls
            this.jointControlsUI.setConnectedMode(true);
            this.jointControlsUI.setControlMode(config.control_mode || this.robotConnection.getMode());

            // Enable keyboard control
            if (this.keyboardControlUI) this.keyboardControlUI.setEnabled(true);

            // If model loaded, sync joint configuration
            if (this.currentModel) {
                this.jointControlsUI.setupJointControls(this.currentModel, config);
            }

            // Update FK panel status
            this.updateFKStatus(true, config.demo_mode ? 'Demo mode' : 'Connected');

        };

        // On disconnection
        this.connectionUI.onDisconnect = () => {
            console.log('[DigitalTwin] Robot disconnected');
            this.robotConfig = null;
            this.isConnectedMode = false;
            this.endEffectorLinkName = null;

            // Disable connected mode
            this.jointControlsUI.setConnectedMode(false);
            this.jointControlsUI.setControlMode('position');

            // Disable keyboard control
            if (this.keyboardControlUI) this.keyboardControlUI.setEnabled(false);

            // Update FK panel status
            this.updateFKStatus(false, 'Not connected');

            // Hide force/torque arrows
            if (this.forceArrow) this.forceArrow.visible = false;
            if (this.torqueArrow) this.torqueArrow.visible = false;
        };

        // On robot state update (real-time position streaming)
        this.robotConnection.onStateUpdate = (state) => {
            if (this.isConnectedMode && this.currentModel) {
                // Update joint positions from robot
                this.jointControlsUI.updateFromRobotState(state);

            }

            // Update FK display with backend-computed EE pose (includes tool offset)
            const fkData = state.forward_kinematics || {};
            if (state.ee_position && state.ee_euler) {
                this.updateFKDisplay({
                    position: state.ee_position,
                    euler: state.ee_euler
                });
            } else if (fkData.position && fkData.euler) {
                this.updateFKDisplay({
                    position: fkData.position,
                    euler: fkData.euler
                });
            }

            // Update external wrench display and 3D arrows (only in impedance mode)
            if (state.control_mode === 'impedance' && state.external_wrench) {
                this.updateExternalWrench(state.external_wrench);
            } else {
                // Clear force display when not in impedance mode
                this.clearExternalWrench();
            }
        };
    }

    /**
     * Handle model loaded
     */
    handleModelLoaded(model, file, isMesh = false) {
        // Clear old model
        if (this.currentModel) {
            this.sceneManager.removeModel(this.currentModel);
            this.currentModel = null;
        }

        this.currentModel = model;

        // Add to scene
        this.sceneManager.addModel(model);

        // Hide drop zone
        const dropZone = document.getElementById('drop-zone');
        if (dropZone) {
            dropZone.classList.remove('show');
            dropZone.classList.remove('drag-over');
        }

        if (!isMesh) {
            // Normal model
            this.sceneManager.setGroundVisible(true);

            // Setup joint controls with robot config if connected
            if (this.isConnectedMode && this.robotConfig) {
                this.jointControlsUI.setupJointControls(model, this.robotConfig);
            } else {
                this.jointControlsUI.setupJointControls(model);
            }

            // Create end effector marker (small red dot at tool tip)
            this.createEndEffectorMarker();

            // Draw model graph
            if (this.modelGraphView) {
                this.modelGraphView.drawModelGraph(model);
            }

            // Show panels
            const graphPanel = document.getElementById('model-graph-panel');
            if (graphPanel) graphPanel.style.display = 'block';

            const jointsPanel = document.getElementById('joints-panel');
            if (jointsPanel) jointsPanel.style.display = 'block';

            // Hide axes by default
            this.setAxesButtonState(false);
        } else {
            // Mesh file
            this.sceneManager.setGroundVisible(false);

            // Clear graph
            if (this.modelGraphView) {
                const svg = d3.select('#model-graph-svg');
                svg.selectAll('*:not(defs)').remove();
                const emptyState = document.getElementById('graph-empty-state');
                if (emptyState) emptyState.classList.remove('hidden');
            }

            const graphPanel = document.getElementById('model-graph-panel');
            if (graphPanel) graphPanel.style.display = 'none';

            // Clear joint controls
            const jointContainer = document.getElementById('joint-controls');
            if (jointContainer) {
                jointContainer.innerHTML = '';
                const emptyState = document.createElement('div');
                emptyState.className = 'empty-state';
                emptyState.textContent = window.i18n?.t('noModel') || 'No model loaded';
                jointContainer.appendChild(emptyState);
            }

            const jointsPanel = document.getElementById('joints-panel');
            if (jointsPanel) jointsPanel.style.display = 'none';

            // Show axes for mesh files
            this.setAxesButtonState(true);
        }

        // Update file tree
        if (this.fileTreeView && !this._isReloading) {
            this.fileTreeView.updateFileTree(
                this.fileHandler.getAvailableModels(),
                this.fileHandler.getFileMap(),
                true
            );
            this.fileTreeView.expandAndScrollToFile(file, this.fileHandler.getFileMap());
        }

        // Update model info
        this.updateModelInfo(model, file);

        // Render
        this.sceneManager.redraw();
        this.sceneManager.render();
    }

    /**
     * Setup canvas click handler
     */
    setupCanvasClickHandler(canvas) {
        let mouseDownPos = null;
        let mouseDownTime = 0;

        canvas.addEventListener('mousedown', (event) => {
            if (event.button === 0) {
                mouseDownPos = { x: event.clientX, y: event.clientY };
                mouseDownTime = Date.now();
            }
        }, true);

        canvas.addEventListener('mouseup', (event) => {
            if (event.button !== 0 || !this.sceneManager || !mouseDownPos) return;

            const dx = event.clientX - mouseDownPos.x;
            const dy = event.clientY - mouseDownPos.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            const duration = Date.now() - mouseDownTime;

            if (distance < 5 && duration < 300) {
                const raycaster = new THREE.Raycaster();
                const mouse = new THREE.Vector2();

                const rect = canvas.getBoundingClientRect();
                mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
                mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

                raycaster.setFromCamera(mouse, this.sceneManager.camera);
                const intersects = raycaster.intersectObjects(this.sceneManager.scene.children, true);

                const modelIntersects = intersects.filter(intersect => {
                    const obj = intersect.object;
                    let current = obj;
                    while (current) {
                        const name = current.name || '';
                        if (name.includes('jointAxis') || name.includes('helper') ||
                            name.includes('grid') || name.includes('Ground') ||
                            name === 'groundPlane') {
                            return false;
                        }
                        current = current.parent;
                    }
                    return obj.isMesh && obj.visible;
                });

                if (modelIntersects.length === 0) {
                    this.sceneManager.highlightManager.clearHighlight();

                    if (this.modelGraphView) {
                        const svg = d3.select('#model-graph-svg');
                        this.modelGraphView.clearAllSelections(svg);
                    }

                    if (this.measurementController) {
                        this.measurementController.clearMeasurement();
                    }
                }
            }

            mouseDownPos = null;
        }, true);
    }

    /**
     * Setup model tree panel
     */
    setupModelTreePanel() {
        const toggleBtn = document.getElementById('toggle-model-tree');
        const floatingPanel = document.getElementById('floating-model-tree');

        if (toggleBtn && floatingPanel) {
            floatingPanel.style.display = 'none';
            toggleBtn.classList.remove('active');
        }

        if (floatingPanel) {
            floatingPanel.addEventListener('click', (event) => {
                const target = event.target;

                if (target === floatingPanel ||
                    target.classList?.contains('graph-controls-hint') ||
                    target.classList?.contains('empty-state') ||
                    target.id === 'floating-model-tree') {

                    if (this.modelGraphView) {
                        const svg = d3.select('#model-graph-svg');
                        this.modelGraphView.clearAllSelections(svg);
                    }

                    if (this.measurementController) {
                        this.measurementController.clearMeasurement();
                    }

                    if (this.sceneManager) {
                        this.sceneManager.highlightManager.clearHighlight();
                    }
                }
            });
        }
    }

    /**
     * Setup FK (End Effector) panel toggle
     */
    setupFKPanel() {
        const toggleBtn = document.getElementById('toggle-fk-panel');
        const fkPanel = document.getElementById('floating-fk-panel');

        if (toggleBtn && fkPanel) {
            const initialVisible = this.panelManager
                ? this.panelManager.isPanelVisible('floating-fk-panel')
                : fkPanel.style.display !== 'none' && getComputedStyle(fkPanel).display !== 'none';
            toggleBtn.classList.toggle('active', initialVisible);

            toggleBtn.addEventListener('click', () => {
                const visible = this.panelManager
                    ? this.panelManager.togglePanel('floating-fk-panel')
                    : fkPanel.style.display === 'none';
                if (!this.panelManager) {
                    fkPanel.style.display = visible ? 'block' : 'none';
                }
                toggleBtn.classList.toggle('active', visible);
            });

            const closeBtn = fkPanel.querySelector('.panel-close-btn');
            if (closeBtn) {
                closeBtn.addEventListener('click', () => {
                    if (this.panelManager) {
                        this.panelManager.hidePanel('floating-fk-panel');
                    } else {
                        fkPanel.style.display = 'none';
                    }
                    toggleBtn.classList.remove('active');
                });
            }
        }
    }

    /**
     * Update FK display with EE pose from backend
     */
    updateFKDisplay(fk) {
        if (!fk) return;

        // Update position (meters)
        if (fk.position) {
            const posX = document.getElementById('fk-pos-x');
            const posY = document.getElementById('fk-pos-y');
            const posZ = document.getElementById('fk-pos-z');

            if (posX) posX.textContent = fk.position[0].toFixed(4);
            if (posY) posY.textContent = fk.position[1].toFixed(4);
            if (posZ) posZ.textContent = fk.position[2].toFixed(4);
        }

        // Update euler angles (degrees from backend)
        if (fk.euler) {
            const roll = document.getElementById('fk-roll');
            const pitch = document.getElementById('fk-pitch');
            const yaw = document.getElementById('fk-yaw');

            if (roll) roll.textContent = fk.euler[0].toFixed(2);
            if (pitch) pitch.textContent = fk.euler[1].toFixed(2);
            if (yaw) yaw.textContent = fk.euler[2].toFixed(2);
        }
    }

    /**
     * Update FK panel connection status
     */
    updateFKStatus(connected, statusText) {
        const statusDot = document.querySelector('.fk-status-dot');
        const statusTextEl = document.querySelector('.fk-status-text');

        if (statusDot) {
            statusDot.classList.toggle('connected', connected);
            statusDot.classList.toggle('disconnected', !connected);
        }

        if (statusTextEl) {
            statusTextEl.textContent = statusText || (connected ? 'Connected' : 'Not connected');
        }
    }

    // ========== External Wrench Visualization ==========

    /**
     * Clear external wrench display and hide arrows
     */
    clearExternalWrench() {
        ['fk-force-x','fk-force-y','fk-force-z','fk-force-mag'].forEach(id => {
            const el = document.getElementById(id); if (el) el.textContent = '0.00';
        });
        ['fk-torque-x','fk-torque-y','fk-torque-z','fk-torque-mag'].forEach(id => {
            const el = document.getElementById(id); if (el) el.textContent = '0.00';
        });
        if (this.forceArrow) this.forceArrow.visible = false;
        if (this.torqueArrow) this.torqueArrow.visible = false;
    }

    /**
     * Process external wrench data: update display + 3D arrows
     * @param {number[]} wrench - [Fx, Fy, Fz, Mx, My, Mz]
     */
    updateExternalWrench(wrench) {
        if (!wrench || wrench.length < 6) return;

        const [Fx, Fy, Fz, Mx, My, Mz] = wrench;
        const forceMag = Math.sqrt(Fx * Fx + Fy * Fy + Fz * Fz);
        const torqueMag = Math.sqrt(Mx * Mx + My * My + Mz * Mz);

        // Update numeric displays
        this.updateForceDisplay(Fx, Fy, Fz, forceMag);
        this.updateTorqueDisplay(Mx, My, Mz, torqueMag);

        // Update 3D arrows
        this.updateForceArrow(Fx, Fy, Fz, forceMag);
        this.updateTorqueArrow(Mx, My, Mz, torqueMag);
    }

    /**
     * Update force values in FK panel with color coding
     */
    updateForceDisplay(Fx, Fy, Fz, mag) {
        const elFx = document.getElementById('fk-force-x');
        const elFy = document.getElementById('fk-force-y');
        const elFz = document.getElementById('fk-force-z');
        const elMag = document.getElementById('fk-force-mag');

        if (elFx) elFx.textContent = Fx.toFixed(2);
        if (elFy) elFy.textContent = Fy.toFixed(2);
        if (elFz) elFz.textContent = Fz.toFixed(2);
        if (elMag) elMag.textContent = mag.toFixed(2);

        // Color coding based on magnitude
        const colorClass = mag < 2 ? 'force-low' : mag < 5 ? 'force-med' : 'force-high';
        [elFx, elFy, elFz, elMag].forEach(el => {
            if (el) {
                el.classList.remove('force-low', 'force-med', 'force-high');
                el.classList.add(colorClass);
            }
        });
    }

    /**
     * Update torque values in FK panel with color coding
     */
    updateTorqueDisplay(Mx, My, Mz, mag) {
        const elMx = document.getElementById('fk-torque-x');
        const elMy = document.getElementById('fk-torque-y');
        const elMz = document.getElementById('fk-torque-z');
        const elMag = document.getElementById('fk-torque-mag');

        if (elMx) elMx.textContent = Mx.toFixed(2);
        if (elMy) elMy.textContent = My.toFixed(2);
        if (elMz) elMz.textContent = Mz.toFixed(2);
        if (elMag) elMag.textContent = mag.toFixed(2);

        // Color coding based on magnitude
        const colorClass = mag < 0.5 ? 'torque-low' : mag < 2 ? 'torque-med' : 'torque-high';
        [elMx, elMy, elMz, elMag].forEach(el => {
            if (el) {
                el.classList.remove('torque-low', 'torque-med', 'torque-high');
                el.classList.add(colorClass);
            }
        });
    }

    /**
     * Create a custom thick arrow (cylinder shaft + cone head)
     * Default orientation: +Y axis. Use quaternion to point along desired direction.
     */
    _createArrowGroup() {
        const group = new THREE.Group();

        // Shaft: unit-height cylinder, scaled at update time
        const shaftGeo = new THREE.CylinderGeometry(this.SHAFT_RADIUS, this.SHAFT_RADIUS, 1.0, 8);
        const shaftMat = new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false });
        const shaft = new THREE.Mesh(shaftGeo, shaftMat);
        shaft.renderOrder = 998;
        group.add(shaft);

        // Head: cone
        const headGeo = new THREE.ConeGeometry(this.HEAD_RADIUS, this.HEAD_LENGTH, 8);
        const headMat = new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false });
        const head = new THREE.Mesh(headGeo, headMat);
        head.renderOrder = 998;
        group.add(head);

        group.renderOrder = 998;
        return group;
    }

    /**
     * Update arrow group properties (direction, length, color)
     * Position is managed by updateEndEffectorMarker() in the animate loop.
     */
    _updateArrowGroup(group, dir, length, colorHex) {
        // Head takes at most 30% of total length, scales down for short arrows
        const headLen = Math.min(this.HEAD_LENGTH, length * 0.3);
        const shaftLength = length - headLen;  // always length*0.7 for small arrows, no clamp needed
        const headScale = headLen / this.HEAD_LENGTH;

        // Shaft: scale Y to desired length, position at half height
        const shaft = group.children[0];
        shaft.scale.y = shaftLength;
        shaft.position.set(0, shaftLength / 2, 0);
        shaft.material.color.setHex(colorHex);

        // Head: scale proportionally + position above shaft
        const head = group.children[1];
        head.scale.set(headScale, headScale, headScale);
        head.position.set(0, shaftLength + headLen / 2, 0);
        head.material.color.setHex(colorHex);

        // Orient group: rotate from +Y to dir
        const quat = new THREE.Quaternion();
        quat.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        group.quaternion.copy(quat);

        group.visible = true;
    }

    /**
     * Create or update force arrow (orange→red gradient)
     */
    updateForceArrow(Fx, Fy, Fz, mag) {
        if (!this.endEffectorMarker) return;

        if (mag < this.FORCE_THRESHOLD) {
            if (this.forceArrow) this.forceArrow.visible = false;
            return;
        }

        // Robot frame (Z-up) → THREE.js scene (Y-up), negated
        const dir = new THREE.Vector3(-Fx, -Fz, Fy).normalize();
        const length = mag * this.FORCE_SCALE;
        const color = this._lerpColor(0xff8800, 0xff2200, Math.min(mag / 10, 1));

        if (!this.forceArrow) {
            this.forceArrow = this._createArrowGroup();
            this.forceArrow.userData.isForceArrow = true;
            this.sceneManager.scene.add(this.forceArrow);
        }

        this._updateArrowGroup(this.forceArrow, dir, length, color);
    }

    /**
     * Create or update torque arrow (cyan→blue gradient)
     */
    updateTorqueArrow(Mx, My, Mz, mag) {
        if (!this.endEffectorMarker) return;

        if (mag < this.TORQUE_THRESHOLD) {
            if (this.torqueArrow) this.torqueArrow.visible = false;
            return;
        }

        // Robot frame (Z-up) → THREE.js scene (Y-up), negated
        const dir = new THREE.Vector3(-Mx, -Mz, My).normalize();
        const length = mag * this.TORQUE_SCALE;
        const color = this._lerpColor(0x44ddff, 0x2244ff, Math.min(mag / 5, 1));

        if (!this.torqueArrow) {
            this.torqueArrow = this._createArrowGroup();
            this.torqueArrow.userData.isTorqueArrow = true;
            this.sceneManager.scene.add(this.torqueArrow);
        }

        this._updateArrowGroup(this.torqueArrow, dir, length, color);
    }

    /**
     * Linearly interpolate between two hex colors
     */
    _lerpColor(color1, color2, t) {
        const c1 = new THREE.Color(color1);
        const c2 = new THREE.Color(color2);
        c1.lerp(c2, t);
        return c1.getHex();
    }

    // ========== Model Info & Misc ==========

    /**
     * Update model info display
     */
    updateModelInfo(model, file) {
        const statusInfo = document.getElementById('status-info');
        if (!statusInfo || !model) return;

        let info = `<strong>${file.name}</strong><br>`;

        const fileType = file.name.split('.').pop().toLowerCase();
        info += `Type: ${fileType.toUpperCase()}<br>`;

        if (model.links) {
            info += `Links: ${model.links.size}<br>`;
        }

        if (model.joints) {
            const controllableJoints = Array.from(model.joints.values()).filter(j => j.type !== 'fixed').length;
            info += `Joints: ${model.joints.size} (${controllableJoints} controllable)<br>`;
        }

        if (model.constraints && model.constraints.size > 0) {
            info += `<span style="color: #00aaff; font-weight: bold;">Constraints: ${model.constraints.size}</span><br>`;
        }

        if (model.rootLink) {
            info += `Root Link: ${model.rootLink}`;
        }

        if (this.isConnectedMode) {
            const mode = this.robotConfig?.demo_mode ? 'Demo' : 'Live';
            info += `<br><span style="color: #00ff88;">Connected (${mode})</span>`;
        }

        statusInfo.innerHTML = info;
        statusInfo.className = 'success';
    }

    /**
     * Handle file click
     */
    handleFileClick(fileInfo) {
        const ext = fileInfo.ext;
        const modelExts = ['urdf', 'xml', 'usd', 'usda', 'usdc', 'usdz'];
        const meshExts = ['dae', 'stl', 'obj', 'collada'];

        if (modelExts.includes(ext)) {
            this.fileHandler.loadFile(fileInfo.file);
        } else if (meshExts.includes(ext)) {
            this.fileHandler.loadMeshAsModel(fileInfo.file, fileInfo.name);
        }
    }

    handleThemeChanged(theme) {
        if (this.currentModel && this.modelGraphView) {
            this.modelGraphView.drawModelGraph(this.currentModel);
        }
    }

    handleAngleUnitChanged(unit) {
        this.angleUnit = unit;
        if (this.jointControlsUI) {
            this.jointControlsUI.setAngleUnit(unit);
        }
    }

    handleResetJoints() {
        if (this.currentModel && this.jointControlsUI) {
            this.jointControlsUI.resetAllJoints(this.currentModel);
        }
    }

    handleIgnoreLimitsChanged(ignore) {
        if (this.jointControlsUI && this.currentModel) {
            this.jointControlsUI.updateAllSliderLimits(this.currentModel, ignore);
        }
    }

    handleLanguageChanged(lang) {
        i18n.setLanguage(lang);

        if (this.currentModel && this.jointControlsUI) {
            if (this.isConnectedMode && this.robotConfig) {
                this.jointControlsUI.setupJointControls(this.currentModel, this.robotConfig);
            } else {
                this.jointControlsUI.setupJointControls(this.currentModel);
            }
        }

        if (this.currentModel && this.modelGraphView) {
            this.modelGraphView.drawModelGraph(this.currentModel);
        }

        if (this.fileTreeView && this.fileHandler) {
            this.fileTreeView.updateFileTree(
                this.fileHandler.getAvailableModels(),
                this.fileHandler.getFileMap(),
                true
            );
        }
    }

    setAxesButtonState(show) {
        const axesBtn = document.getElementById('toggle-axes-btn');
        if (!axesBtn) return;

        axesBtn.setAttribute('data-checked', show.toString());
        if (show) {
            axesBtn.classList.add('active');
            if (this.sceneManager) {
                this.sceneManager.axesManager.showAllAxes();
            }
        } else {
            axesBtn.classList.remove('active');
            if (this.sceneManager) {
                this.sceneManager.axesManager.hideAllAxes();
            }
        }
    }

    /**
     * Animation loop
     */
    animate() {
        requestAnimationFrame(() => this.animate());
        if (this.sceneManager) {
            this.sceneManager.update();
            this.sceneManager.render();

            // Update end effector marker position
            this.updateEndEffectorMarker();
        }
    }

    /**
     * Create the end effector marker (small red sphere)
     */
    createEndEffectorMarker() {
        // Remove existing marker
        if (this.endEffectorMarker) {
            if (this.endEffectorMarker.parent) {
                this.endEffectorMarker.parent.remove(this.endEffectorMarker);
            }
            if (this.endEffectorMarker.geometry) this.endEffectorMarker.geometry.dispose();
            if (this.endEffectorMarker.material) this.endEffectorMarker.material.dispose();
            this.endEffectorMarker = null;
        }

        // Remove existing arrows if model is being reloaded
        if (this.forceArrow) {
            this.sceneManager.scene.remove(this.forceArrow);
            this.forceArrow.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); });
            this.forceArrow = null;
        }
        if (this.torqueArrow) {
            this.sceneManager.scene.remove(this.torqueArrow);
            this.torqueArrow.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); });
            this.torqueArrow = null;
        }

        // Create small red sphere - render on top to always be visible
        const geometry = new THREE.SphereGeometry(0.005, 16, 16);  // 5mm radius
        const material = new THREE.MeshBasicMaterial({
            color: 0xff0000,
            depthTest: false,
            depthWrite: false
        });

        this.endEffectorMarker = new THREE.Mesh(geometry, material);
        this.endEffectorMarker.renderOrder = 999;
        this.endEffectorMarker.userData.isEndEffectorMarker = true;

        this.sceneManager.scene.add(this.endEffectorMarker);
        console.log('[DigitalTwin] End effector marker created');
    }

    /**
     * Find the last link in the kinematic chain (end effector link)
     */
    _findEndEffectorLink() {
        if (!this.currentModel || !this.currentModel.links) return null;

        if (this.endEffectorLinkName) {
            const configuredLink = this.currentModel.links.get(this.endEffectorLinkName);
            if (configuredLink && configuredLink.threeObject) return configuredLink;
        }

        // Try fixed TCP/tool frames first. Avoid finger links because they move when the gripper opens.
        for (const name of ['tool_link', 'tcp_link', 'ee_link', 'link6', 'Link_6', 'Link6', 'link_6']) {
            const link = this.currentModel.links.get(name);
            if (link && link.threeObject) return link;
        }

        // Fallback: get the last link by iterating joints
        let lastLink = null;
        if (this.currentModel.joints) {
            this.currentModel.joints.forEach(joint => {
                if (joint.type !== 'fixed' && joint.child) {
                    const childLink = this.currentModel.links.get(joint.child);
                    if (childLink && childLink.threeObject && !['L_finger', 'R_finger'].includes(childLink.name)) {
                        lastLink = childLink;
                    }
                }
            });
        }
        return lastLink;
    }

    updateEndEffectorMarker() {
        if (!this.endEffectorMarker || !this.currentModel) return;

        const endEffectorLink = this._findEndEffectorLink();
        if (!endEffectorLink || !endEffectorLink.threeObject) {
            if (!this._loggedMissingLink) {
                console.warn('[DigitalTwin] End effector link not found');
                this._loggedMissingLink = true;
            }
            return;
        }

        // Get world position of end effector link
        const position = new THREE.Vector3();
        endEffectorLink.threeObject.getWorldPosition(position);

        // Get world quaternion once (reused for both offsets)
        const worldQuaternion = new THREE.Quaternion();
        endEffectorLink.threeObject.getWorldQuaternion(worldQuaternion);

        const markerPosition = position.clone();
        if (endEffectorLink.name === 'link6' && this.endEffectorMarkerOffset.lengthSq() > 0) {
            markerPosition.add(this.endEffectorMarkerOffset.clone().applyQuaternion(worldQuaternion));
        }

        // Marker shows the fixed tool center, not the sliding finger links.
        this.endEffectorMarker.position.copy(markerPosition);

        const arrowPosition = markerPosition.clone();
        if (this.arrowOffset.lengthSq() > 0) {
            const displayOffset = this.arrowOffset.clone().applyQuaternion(worldQuaternion);
            arrowPosition.add(displayOffset);
        }

        if (this.forceArrow) this.forceArrow.position.copy(arrowPosition);
        if (this.torqueArrow) this.torqueArrow.position.copy(arrowPosition);
    }
}

// Create and start application
const app = new DigitalTwinApp();
app.init();

// Expose to global (for debugging)
window.app = app;
