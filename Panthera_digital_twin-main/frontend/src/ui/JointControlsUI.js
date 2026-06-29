/**
 * JointControlsUI - Joint control UI module with robot connection support
 * Extended for Digital Twin to support robot synchronization
 */
import { ModelLoaderFactory } from '../loaders/ModelLoaderFactory.js';
import { XMLUpdater } from '../utils/XMLUpdater.js';
import * as THREE from 'three';

export class JointControlsUI {
    constructor(sceneManager) {
        this.sceneManager = sceneManager;
        this.angleUnit = 'rad';
        this.initialJointValues = new Map();
        this.codeEditorManager = null;
        this.isUpdatingFromEditor = false;

        // Robot connection support
        this.robotConnection = null;
        this.isConnectedMode = false;
        this.controlMode = 'position';
        this.isUpdatingFromRobot = false;  // Prevent feedback loops
        this.jointIndexMap = new Map();  // joint name -> index mapping
        this.pendingJointValues = new Map(); // joint index -> staged value
        this.commandVelocity = 0.6;
        this.velocityInput = null;
        this.velocityValue = null;
        this.sendPositionsButton = null;
        this.robotJointConfigs = [];
        this.gripperConfig = null;
        this.gripperUiLimits = { min: 0, max: 1.8 };
        this.dragPreview = null;
        this.dragPreviewHideTimer = null;
        this.previewRenderer = null;
        this.previewScene = null;
        this.previewCamera = null;
        this.previewModel = null;
        this.previewModelSource = null;
        this.previewAnimationFrame = null;
        this.previewCameraLocked = false;

    }

    /**
     * Set robot connection for real-time synchronization
     */
    setRobotConnection(robotConnection) {
        this.robotConnection = robotConnection;
    }

    /**
     * Enable/disable connected mode
     * In connected mode, slider changes are staged until Send Position is clicked
     */
    setConnectedMode(enabled) {
        this.isConnectedMode = enabled;

        // Update UI to reflect mode
        const container = document.getElementById('joint-controls');
        if (container) {
            container.classList.toggle('connected-mode', enabled);
        }

        this.updatePositionModeLock();
        this.updateSendButtonState();
    }

    isGripperName(name) {
        return name === 'gripper';
    }

    isGripperControlName(name) {
        return this.isGripperName(name) || this.isFingerJointName(name);
    }

    isFingerJointName(name) {
        return name === 'L_finger' || name === 'R_finger';
    }

    createGripperJoint() {
        const lower = this.gripperUiLimits.min;
        const upper = this.gripperUiLimits.max;
        return {
            name: 'gripper',
            type: 'prismatic',
            limits: { lower, upper },
            currentValue: lower,
            isVirtualGripper: true
        };
    }

    clampValue(value, lower, upper) {
        return Math.max(lower, Math.min(upper, value));
    }

    applyOfflineZeroState(model) {
        if (!model) return;

        document.querySelectorAll('.joint-slider').forEach(slider => {
            const jointName = slider.getAttribute('data-joint');
            const joint = model.joints.get(jointName);
            const lower = parseFloat(slider.min);
            const upper = parseFloat(slider.max);
            const zeroValue = this.clampValue(0.0, lower, upper);

            slider.value = zeroValue;
            this.initialJointValues.set(jointName, zeroValue);
            this.applyJointToModel(model, jointName, zeroValue, true);

            if (joint) {
                joint.currentValue = zeroValue;
            }

            const control = slider.closest('.joint-control');
            if (control && control._updateDisplay) control._updateDisplay();
        });
    }

    gripperToFingerPosition(value) {
        const min = this.gripperUiLimits.min;
        const max = this.gripperUiLimits.max;
        const range = max - min || 1;
        const normalized = Math.max(0, Math.min(1, (value - min) / range));
        return normalized * 0.04;
    }

    applyJointToModel(model, jointName, value, ignoreLimits = false) {
        if (!model) return;

        if (this.isGripperName(jointName)) {
            const fingerPos = this.gripperToFingerPosition(value);
            for (const name of ['L_finger', 'R_finger']) {
                if (model.getJoint?.(name)) {
                    ModelLoaderFactory.setJointAngle(model, name, fingerPos, true);
                }
            }
            return;
        }

        ModelLoaderFactory.setJointAngle(model, jointName, value, ignoreLimits);
    }

    /**
     * Update current backend control mode.
     * Joint commands are only allowed in Position mode.
     */
    setControlMode(mode) {
        this.controlMode = mode || 'position';
        this.updatePositionModeLock();
        this.updateSendButtonState();
    }

    isPositionModeLocked() {
        return this.isConnectedMode && this.controlMode !== 'position';
    }

    isGripperManualMode() {
        // Non-position modes intentionally lock the full Joints panel.
        return false;
    }

    canEditJointInCurrentMode(jointName) {
        if (!this.isConnectedMode) return true;
        if (this.controlMode === 'position') return true;
        return this.isGripperName(jointName) && this.isGripperManualMode();
    }

    getJointNameByIndex(jointIndex) {
        for (const [name, index] of this.jointIndexMap.entries()) {
            if (index === jointIndex) return name;
        }
        return null;
    }

    prunePendingJointValuesForMode() {
        if (!this.isPositionModeLocked()) return;

        if (!this.isGripperManualMode()) {
            this.pendingJointValues.clear();
            return;
        }

        for (const [jointIndex] of this.pendingJointValues.entries()) {
            const jointName = this.getJointNameByIndex(jointIndex);
            if (!this.isGripperName(jointName)) {
                this.pendingJointValues.delete(jointIndex);
            }
        }
    }

    updatePositionModeLock() {
        const panel = document.getElementById('floating-joints-panel');
        const container = document.getElementById('joint-controls');
        const locked = this.isPositionModeLocked();
        const gripperOnly = locked && this.isGripperManualMode();
        const fullyLocked = locked && !gripperOnly;

        if (panel) {
            panel.classList.toggle('position-mode-locked', fullyLocked);
            panel.classList.toggle('gripper-only-mode', gripperOnly);
        }

        if (container) {
            container.setAttribute('aria-disabled', fullyLocked.toString());
            container.querySelectorAll('.joint-control').forEach(control => {
                const slider = control.querySelector('.joint-slider');
                const jointName = slider ? slider.getAttribute('data-joint') : null;
                const jointLocked = !this.canEditJointInCurrentMode(jointName);
                control.classList.toggle('joint-control-locked', jointLocked);
                control.querySelectorAll('input').forEach(element => {
                    element.disabled = jointLocked;
                });
            });
        }

        if (this.velocityInput) this.velocityInput.disabled = fullyLocked;
        if (this.velocityValue) this.velocityValue.disabled = fullyLocked;

        this.prunePendingJointValuesForMode();

        if (fullyLocked) {
            this.hideDragPreview();
        }

        this.updateSendButtonState();
    }

    /**
     * Update UI from robot state (called when receiving robot data)
     */
    updateFromRobotState(state) {
        if (!state || !state.positions) return;

        this.isUpdatingFromRobot = true;

        try {
            const positions = state.positions;

            document.querySelectorAll('.joint-slider').forEach((slider) => {
                const jointName = slider.getAttribute('data-joint');
                const jointIndex = Number(slider.getAttribute('data-joint-index'));
                let robotPosition;

                if (this.isGripperName(jointName)) {
                    if (state.gripper_position === undefined) return;
                    robotPosition = state.gripper_position;
                } else {
                    if (jointIndex >= positions.length) return;
                    robotPosition = positions[jointIndex];
                }

                const pendingPosition = this.pendingJointValues.get(jointIndex);
                const displayPosition = pendingPosition !== undefined ? pendingPosition : robotPosition;
                const control = slider.closest('.joint-control');

                // Check if value input is currently focused (user is typing)
                const valueInput = control?.querySelector('.joint-value-input');
                const isInputFocused = valueInput && document.activeElement === valueInput;

                // Keep staged slider values visible, but keep the 3D model on real robot state.
                slider.value = displayPosition;

                // Only update value display if user is NOT typing
                if (control && control._updateDisplay && !isInputFocused) {
                    control._updateDisplay();
                }

                if (jointName && this.sceneManager.currentModel) {
                    this.applyJointToModel(this.sceneManager.currentModel, jointName, robotPosition);
                }
            });

            // Render scene
            if (this.sceneManager) {
                this.sceneManager.redraw();
                this.sceneManager.render();
            }
        } finally {
            this.isUpdatingFromRobot = false;
        }
    }

    /**
     * Set code editor manager reference
     */
    setCodeEditorManager(codeEditorManager) {
        this.codeEditorManager = codeEditorManager;
    }

    /**
     * Update XML content in editor (URDF format only)
     */
    updateEditorXML(jointName, limits) {
        if (this.isUpdatingFromEditor) return;
        if (!this.codeEditorManager) return;

        const editor = this.codeEditorManager.getEditor();
        if (!editor) return;

        const currentContent = editor.getValue();
        if (!currentContent || !currentContent.includes('<robot')) return;

        this.isUpdatingFromEditor = true;

        try {
            const updatedXML = XMLUpdater.updateURDFJointLimits(currentContent, jointName, limits);
            if (updatedXML !== currentContent) {
                const cursorPos = editor.view.state.selection.main.head;
                editor.setValue(updatedXML);
                try {
                    const maxPos = editor.view.state.doc.length;
                    const newPos = Math.min(cursorPos, maxPos);
                    editor.view.dispatch({
                        selection: { anchor: newPos, head: newPos }
                    });
                } catch (e) {}
            }
        } catch (error) {
            console.error('Failed to update editor XML:', error);
        } finally {
            setTimeout(() => { this.isUpdatingFromEditor = false; }, 100);
        }
    }

    /**
     * Setup joint controls
     */
    setupJointControls(model, robotConfig = null) {
        const container = document.getElementById('joint-controls');
        if (!container) return;

        container.innerHTML = '';
        this.pendingJointValues.clear();
        this.sendPositionsButton = null;
        this.velocityInput = null;
        this.velocityValue = null;
        this.destroyDragPreview();

        // Build joint index mapping if robot config provided
        this.jointIndexMap.clear();
        this.robotJointConfigs = [];
        this.gripperConfig = null;
        if (robotConfig && robotConfig.joints) {
            this.robotJointConfigs = robotConfig.joints.filter(jc => jc.kind !== 'gripper');
            this.gripperConfig = robotConfig.joints.find(jc => jc.kind === 'gripper' || jc.name === 'gripper') || null;
            robotConfig.joints.forEach((jc) => {
                this.jointIndexMap.set(jc.name, jc.index);
            });
        }

        if (!model || !model.joints || model.joints.size === 0) {
            const emptyState = document.createElement('div');
            emptyState.className = 'empty-state';
            emptyState.textContent = window.i18n ? window.i18n.t('noModel') : 'No model loaded';
            container.appendChild(emptyState);
            return;
        }

        let controlsToCreate = [];
        if (this.robotJointConfigs.length > 0) {
            controlsToCreate = this.robotJointConfigs
                .map((jc) => {
                    const joint = model.joints.get(jc.name);
                    if (!joint || joint.type === 'fixed') return null;
                    if (joint.limits) {
                        joint.limits.lower = jc.min;
                        joint.limits.upper = jc.max;
                    } else {
                        joint.limits = { lower: jc.min, upper: jc.max };
                    }
                    return { joint, index: jc.index };
                })
                .filter(Boolean);

            if (this.gripperConfig) {
                controlsToCreate.push({
                    joint: this.createGripperJoint(),
                    index: this.gripperConfig.index
                });
            }
        } else {
            let fallbackIndex = 0;
            model.joints.forEach((joint, name) => {
                if (joint.type === 'fixed' || this.isGripperControlName(name)) return;
                controlsToCreate.push({ joint, index: fallbackIndex++ });
            });
            if (model.joints.has('L_finger') || model.joints.has('R_finger')) {
                controlsToCreate.push({
                    joint: this.createGripperJoint(),
                    index: fallbackIndex
                });
            }
        }

        if (controlsToCreate.length === 0) {
            const emptyState = document.createElement('div');
            emptyState.className = 'empty-state';
            emptyState.textContent = window.i18n ? window.i18n.t('noControllableJoints') : 'No controllable joints';
            container.appendChild(emptyState);
            return;
        }

        container.appendChild(this.createSendPositionControl());
        this.updatePositionModeLock();
        this.updateSendButtonState();

        // Save initial joint values
        this.initialJointValues.clear();
        controlsToCreate.forEach(({ joint, index }) => {
            const limits = joint.limits || {};
            const lower = limits.lower !== undefined ? limits.lower : -Math.PI;
            const upper = limits.upper !== undefined ? limits.upper : Math.PI;
            const initialValue = robotConfig ?
                (joint.currentValue !== undefined ? joint.currentValue : lower) :
                this.clampValue(0.0, lower, upper);
            this.initialJointValues.set(joint.name, initialValue);
            if (!robotConfig) {
                this.applyJointToModel(model, joint.name, initialValue, true);
                if (!this.isGripperName(joint.name)) {
                    joint.currentValue = initialValue;
                }
            }

            if (!this.jointIndexMap.has(joint.name)) {
                this.jointIndexMap.set(joint.name, index);
            }
        });

        // Create controls for each joint
        controlsToCreate.forEach(({ joint, index }) => {
            const control = this.createJointControl(joint, model, index);
            container.appendChild(control);
        });

        if (!robotConfig) {
            this.applyOfflineZeroState(model);
        }

        this.updatePositionModeLock();
    }

    /**
     * Create joint control element
     */
    createJointControl(joint, model, jointIndex) {
        const div = document.createElement('div');
        div.className = 'joint-control';
        if (this.isGripperName(joint.name)) div.classList.add('gripper-control');
        div.setAttribute('data-joint-index', jointIndex);
        const isGripper = this.isGripperName(joint.name);

        // Header row: name + value
        const header = document.createElement('div');
        header.className = 'joint-header';

        const name = document.createElement('div');
        name.className = 'joint-name';
        name.textContent = joint.name;
        name.title = joint.name;

        header.appendChild(name);

        // Slider row
        const sliderRow = document.createElement('div');
        sliderRow.className = 'joint-slider-row';

        const limits = joint.limits || {};
        let lower = limits.lower !== undefined ? limits.lower : -Math.PI;
        let upper = limits.upper !== undefined ? limits.upper : Math.PI;

        if (joint.type === 'continuous') {
            lower = -Math.PI;
            upper = Math.PI;
        }

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'joint-slider';
        slider.setAttribute('data-joint', joint.name);
        slider.setAttribute('data-joint-index', jointIndex);
        slider.min = lower;
        slider.max = upper;

        let initialValue = this.initialJointValues.get(joint.name);
        if (initialValue === undefined) {
            initialValue = joint.currentValue !== undefined ? joint.currentValue : (lower + upper) / 2;
        }
        slider.value = initialValue;
        slider.step = (upper - lower) / 1000;

        // Min/max labels
        const minLabel = document.createElement('input');
        minLabel.type = 'number';
        minLabel.className = 'joint-limit-min editable-limit';
        minLabel.step = '0.01';
        minLabel.title = 'Click to edit min limit';

        const maxLabel = document.createElement('input');
        maxLabel.type = 'number';
        maxLabel.className = 'joint-limit-max editable-limit';
        maxLabel.step = '0.01';
        maxLabel.title = 'Click to edit max limit';

        // Value input
        const valueInput = document.createElement('input');
        valueInput.type = 'number';
        valueInput.className = 'joint-value-input';
        valueInput.setAttribute('data-joint-input', joint.name);
        valueInput.step = '0.01';

        const valueUnit = document.createElement('span');
        valueUnit.className = 'joint-value-unit';
        valueUnit.textContent = isGripper ? '' : (this.angleUnit === 'deg' ? '°' : 'rad');

        const updateLabels = () => {
            const currentMin = parseFloat(slider.min);
            const currentMax = parseFloat(slider.max);
            if (!isGripper && this.angleUnit === 'deg') {
                minLabel.value = (currentMin * 180 / Math.PI).toFixed(1);
                maxLabel.value = (currentMax * 180 / Math.PI).toFixed(1);
            } else {
                minLabel.value = currentMin.toFixed(2);
                maxLabel.value = currentMax.toFixed(2);
            }
        };

        const updateValueInput = () => {
            const value = parseFloat(slider.value);
            valueInput.value = !isGripper && this.angleUnit === 'deg' ?
                (value * 180 / Math.PI).toFixed(1) :
                value.toFixed(2);
        };

        updateLabels();
        updateValueInput();

        // Min limit change handler
        minLabel.addEventListener('change', () => {
            let inputValue = parseFloat(minLabel.value);
            if (isNaN(inputValue)) { updateLabels(); return; }

            let valueInRad = !isGripper && this.angleUnit === 'deg' ? inputValue * Math.PI / 180 : inputValue;
            const currentMax = parseFloat(slider.max);
            if (valueInRad >= currentMax) { updateLabels(); return; }

            slider.min = valueInRad;
            slider.step = (slider.max - slider.min) / 1000;

            if (joint.limits) joint.limits.lower = valueInRad;
            if (!isGripper) this.updateEditorXML(joint.name, { lower: valueInRad });

            const currentValue = parseFloat(slider.value);
            if (currentValue < valueInRad) {
                slider.value = valueInRad;
                this.handleJointChange(joint.name, valueInRad, jointIndex, model, { markPending: true });
            }
            updateLabels();
        });

        // Max limit change handler
        maxLabel.addEventListener('change', () => {
            let inputValue = parseFloat(maxLabel.value);
            if (isNaN(inputValue)) { updateLabels(); return; }

            let valueInRad = !isGripper && this.angleUnit === 'deg' ? inputValue * Math.PI / 180 : inputValue;
            const currentMin = parseFloat(slider.min);
            if (valueInRad <= currentMin) { updateLabels(); return; }

            slider.max = valueInRad;
            slider.step = (slider.max - slider.min) / 1000;

            if (joint.limits) joint.limits.upper = valueInRad;
            if (!isGripper) this.updateEditorXML(joint.name, { upper: valueInRad });

            const currentValue = parseFloat(slider.value);
            if (currentValue > valueInRad) {
                slider.value = valueInRad;
                this.handleJointChange(joint.name, valueInRad, jointIndex, model, { markPending: true });
            }
            updateLabels();
        });

        // Build slider container
        const sliderContainer = document.createElement('div');
        sliderContainer.className = 'joint-slider-container';
        sliderContainer.appendChild(slider);

        const valueInputContainer = document.createElement('div');
        valueInputContainer.className = 'joint-value-input-container';
        valueInputContainer.appendChild(valueInput);
        valueInputContainer.appendChild(valueUnit);

        sliderRow.appendChild(minLabel);
        sliderRow.appendChild(sliderContainer);
        sliderRow.appendChild(maxLabel);
        sliderRow.appendChild(valueInputContainer);

        // Slider events with robot integration
        slider.addEventListener('mousedown', () => {
            if (this.sceneManager.axesManager) {
                this.sceneManager.axesManager.showOnlyJointAxis(joint);
            }
        });

        slider.addEventListener('mouseup', () => {
            if (this.sceneManager.axesManager) {
                this.sceneManager.axesManager.restoreAllJointAxes();
            }
        });

        slider.addEventListener('pointerdown', () => {
            this.showDragPreview(joint.name, parseFloat(slider.value), slider);
            window.addEventListener('pointerup', () => this.hideDragPreview(), { once: true });
        });

        // Main slider input handler
        slider.addEventListener('input', () => {
            if (this.isUpdatingFromRobot) return;  // Don't send back to robot

            const value = parseFloat(slider.value);
            this.handleJointChange(joint.name, value, jointIndex, model, { markPending: true });
            this.updateDragPreview(joint.name, value, slider);
            updateValueInput();
        });

        // Value input handler
        valueInput.addEventListener('change', () => {
            if (this.isUpdatingFromRobot) return;

            let inputValue = parseFloat(valueInput.value);
            if (isNaN(inputValue)) { updateValueInput(); return; }

            let valueInRad = !isGripper && this.angleUnit === 'deg' ? inputValue * Math.PI / 180 : inputValue;
            const currentMin = parseFloat(slider.min);
            const currentMax = parseFloat(slider.max);
            valueInRad = Math.max(currentMin, Math.min(currentMax, valueInRad));

            slider.value = valueInRad;
            this.handleJointChange(joint.name, valueInRad, jointIndex, model, { markPending: true });
            updateValueInput();
        });

        // Save update function for external updates
        div._updateDisplay = () => {
            updateValueInput();
            updateLabels();
            valueUnit.textContent = isGripper ? '' : (this.angleUnit === 'deg' ? '°' : 'rad');
        };

        div.appendChild(header);
        div.appendChild(sliderRow);

        return div;
    }

    /**
     * Create the command button for staged joint positions.
     */
    createSendPositionControl() {
        const row = document.createElement('div');
        row.className = 'joint-send-control';

        const velocityControl = document.createElement('div');
        velocityControl.className = 'joint-velocity-control';

        const velocityHeader = document.createElement('div');
        velocityHeader.className = 'joint-velocity-header';

        const velocityLabel = document.createElement('span');
        velocityLabel.className = 'joint-velocity-label';
        velocityLabel.textContent = 'Velocity';

        const velocityValue = document.createElement('input');
        velocityValue.type = 'number';
        velocityValue.className = 'joint-velocity-value';
        velocityValue.min = '0.1';
        velocityValue.max = '2.0';
        velocityValue.step = '0.05';
        velocityValue.title = 'Type movement velocity';

        const velocitySlider = document.createElement('input');
        velocitySlider.type = 'range';
        velocitySlider.className = 'joint-velocity-slider';
        velocitySlider.min = '0.1';
        velocitySlider.max = '2.0';
        velocitySlider.step = '0.05';
        velocitySlider.value = this.commandVelocity.toString();
        velocitySlider.title = 'Movement velocity used by Send Position';

        const applyVelocity = (value, updateSlider = true) => {
            const min = parseFloat(velocitySlider.min);
            const max = parseFloat(velocitySlider.max);
            const fallback = Number.isFinite(this.commandVelocity) ? this.commandVelocity : 0.6;
            const nextValue = Number.isNaN(value) ? fallback : Math.max(min, Math.min(max, value));
            this.commandVelocity = nextValue;
            velocityValue.value = this.commandVelocity.toFixed(2);
            if (updateSlider) velocitySlider.value = this.commandVelocity.toString();
        };

        velocitySlider.addEventListener('input', () => {
            applyVelocity(parseFloat(velocitySlider.value), false);
        });

        velocityValue.addEventListener('change', () => {
            applyVelocity(parseFloat(velocityValue.value));
        });

        velocityValue.addEventListener('blur', () => {
            applyVelocity(parseFloat(velocityValue.value));
        });

        velocityValue.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                applyVelocity(parseFloat(velocityValue.value));
                velocityValue.blur();
            }
        });

        applyVelocity(this.commandVelocity);

        velocityHeader.appendChild(velocityLabel);
        velocityHeader.appendChild(velocityValue);
        velocityControl.appendChild(velocityHeader);
        velocityControl.appendChild(velocitySlider);

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'control-button joint-send-button';
        button.textContent = 'Send Position';
        button.title = 'Send current joint slider positions to the robot';
        button.disabled = true;
        button.addEventListener('click', () => this.sendPendingJointPositions());

        row.appendChild(velocityControl);
        row.appendChild(button);
        this.velocityInput = velocitySlider;
        this.velocityValue = velocityValue;
        this.sendPositionsButton = button;
        this.updateSendButtonState();

        return row;
    }

    /**
     * Show a small floating position preview next to the joint row while dragging.
     */
    showDragPreview(jointName, value, anchorEl) {
        if (!this.dragPreview) {
            this.dragPreview = document.createElement('div');
            this.dragPreview.className = 'joint-drag-preview';
            this.dragPreview.innerHTML = `
                <canvas class="joint-drag-preview-canvas"></canvas>
            `;
            document.body.appendChild(this.dragPreview);
            this.setupPreviewRenderer();
        }
        this.dragPreview.classList.remove('hidden');

        if (this.dragPreviewHideTimer) {
            clearTimeout(this.dragPreviewHideTimer);
            this.dragPreviewHideTimer = null;
        }

        this.updateDragPreview(jointName, value, anchorEl);
        requestAnimationFrame(() => {
            this.dragPreview.classList.add('visible');
        });
    }

    updateDragPreview(jointName, value, anchorEl) {
        if (!this.dragPreview || Number.isNaN(value)) return;

        const control = anchorEl.closest('.joint-control');
        const rect = (control || anchorEl).getBoundingClientRect();
        this.dragPreview.style.left = `${rect.right + 24}px`;
        this.dragPreview.style.top = `${rect.top + rect.height / 2}px`;

        this.updatePreviewModel(jointName, value);
        this.renderPreview();
    }

    hideDragPreview() {
        if (!this.dragPreview) return;

        this.dragPreview.classList.remove('visible');
        if (this.dragPreviewHideTimer) {
            clearTimeout(this.dragPreviewHideTimer);
        }
        this.dragPreviewHideTimer = setTimeout(() => {
            if (this.dragPreview && !this.dragPreview.classList.contains('visible')) {
                this.dragPreview.classList.add('hidden');
            }
            this.dragPreviewHideTimer = null;
        }, 180);
    }

    setupPreviewRenderer() {
        const canvas = this.dragPreview?.querySelector('.joint-drag-preview-canvas');
        if (!canvas) return;

        this.previewScene = new THREE.Scene();
        this.previewCamera = new THREE.PerspectiveCamera(38, 260 / 220, 0.01, 1000);

        this.previewRenderer = new THREE.WebGLRenderer({
            canvas,
            antialias: true,
            alpha: true
        });
        this.previewRenderer.setPixelRatio(1);
        this.previewRenderer.setSize(260, 220, false);

        const ambient = new THREE.AmbientLight(0xffffff, 1.4);
        const key = new THREE.DirectionalLight(0xffffff, 1.2);
        key.position.set(3, 4, 5);
        this.previewScene.add(ambient);
        this.previewScene.add(key);
    }

    ensurePreviewModel() {
        const sourceModel = this.sceneManager.currentModel;
        if (!sourceModel || !sourceModel.threeObject || !this.previewScene) return null;

        if (this.previewModel && this.previewModelSource === sourceModel) {
            return this.previewModel;
        }

        if (this.previewModel?.previewRoot) {
            this.previewScene.remove(this.previewModel.previewRoot);
        }

        const objectClone = sourceModel.threeObject.clone(true);
        const previewRoot = new THREE.Object3D();
        if (this.sceneManager.world) {
            previewRoot.rotation.copy(this.sceneManager.world.rotation);
        }
        previewRoot.add(objectClone);

        const cloneMap = new Map();
        const sourceObjects = [];
        const cloneObjects = [];
        sourceModel.threeObject.traverse(obj => sourceObjects.push(obj));
        objectClone.traverse(obj => cloneObjects.push(obj));
        sourceObjects.forEach((sourceObj, index) => {
            if (cloneObjects[index]) cloneMap.set(sourceObj.uuid, cloneObjects[index]);
        });

        const clonedJoints = new Map();
        sourceModel.joints?.forEach((joint, name) => {
            const clonedJoint = { ...joint };
            if (joint.threeObject) {
                clonedJoint.threeObject = cloneMap.get(joint.threeObject.uuid) || null;
            }
            clonedJoints.set(name, clonedJoint);
        });

        const clonedLinks = new Map();
        sourceModel.links?.forEach((link, name) => {
            const clonedLink = { ...link };
            if (link.threeObject) {
                clonedLink.threeObject = cloneMap.get(link.threeObject.uuid) || null;
            }
            clonedLinks.set(name, clonedLink);
        });

        this.previewModel = {
            ...sourceModel,
            threeObject: objectClone,
            previewRoot,
            links: clonedLinks,
            joints: clonedJoints,
            rootLink: sourceModel.rootLink,
            getLink(name) {
                return clonedLinks.get(name);
            },
            getJoint(name) {
                return clonedJoints.get(name);
            }
        };
        this.previewModelSource = sourceModel;
        this.previewScene.add(previewRoot);
        this.fitPreviewCamera(this.previewModel);
        this.previewCameraLocked = true;

        return this.previewModel;
    }

    updatePreviewModel(activeJointName, activeValue) {
        const model = this.ensurePreviewModel();
        if (!model) return;

        document.querySelectorAll('.joint-slider').forEach(slider => {
            const name = slider.getAttribute('data-joint');
            const index = Number(slider.getAttribute('data-joint-index'));
            let value = this.pendingJointValues.get(index);
            if (name === activeJointName) value = activeValue;
            if (value === undefined) value = parseFloat(slider.value);

            if (name && !Number.isNaN(value)) {
                this.applyJointToModel(model, name, value, true);
            }
        });
    }

    fitPreviewCamera(model) {
        const object3d = model?.previewRoot || model?.threeObject;
        if (!this.previewCamera || !object3d || this.previewCameraLocked) return;

        object3d.updateMatrixWorld(true);
        const bbox = new THREE.Box3().setFromObject(object3d);
        if (bbox.isEmpty()) return;

        const size = bbox.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z, 0.1);
        const lookAt = this.getBaseTowardLink1Focus(model, bbox, size);

        const distance = maxDim * 1.5;
        const direction = new THREE.Vector3(1.35, 1.0, 1.2).normalize();

        this.previewCamera.position.copy(lookAt).add(direction.multiplyScalar(distance));
        this.previewCamera.near = Math.max(distance / 100, 0.01);
        this.previewCamera.far = distance * 100;
        this.previewCamera.lookAt(lookAt);
        this.previewCamera.updateProjectionMatrix();
    }

    getBaseTowardLink1Focus(model, bbox, size) {
        const baseLink = this.findPreviewLink(model, ['base_link', 'base', 'Link_0', 'link0']);
        const link1 = this.findPreviewLink(model, ['link1', 'Link_1', 'link_1', 'Link1']);
        const fallback = bbox.getCenter(new THREE.Vector3());
        fallback.y = bbox.min.y + size.y * 0.12;

        if (!baseLink?.threeObject || !link1?.threeObject) {
            return fallback;
        }

        baseLink.threeObject.updateMatrixWorld(true);
        link1.threeObject.updateMatrixWorld(true);

        const basePos = baseLink.threeObject.getWorldPosition(new THREE.Vector3());
        const link1Box = new THREE.Box3().setFromObject(link1.threeObject);
        const link1Pos = link1Box.isEmpty()
            ? link1.threeObject.getWorldPosition(new THREE.Vector3())
            : link1Box.getCenter(new THREE.Vector3());

        const direction = link1Pos.clone().sub(basePos);
        if (direction.lengthSq() < 1e-8) return fallback;

        direction.normalize();
        return basePos.add(direction.multiplyScalar(size.length() * 0.15));
    }

    findPreviewLink(model, names) {
        for (const name of names) {
            if (model.links?.has(name)) return model.links.get(name);
        }

        if (!model.links) return null;

        const normalizedNames = names.map(name => name.toLowerCase().replace(/[_\-\s]/g, ''));
        for (const [name, link] of model.links.entries()) {
            const normalized = name.toLowerCase().replace(/[_\-\s]/g, '');
            if (normalizedNames.includes(normalized)) return link;
        }

        return null;
    }

    renderPreview() {
        if (!this.previewRenderer || !this.previewScene || !this.previewCamera) return;
        if (this.previewAnimationFrame) cancelAnimationFrame(this.previewAnimationFrame);
        this.previewAnimationFrame = requestAnimationFrame(() => {
            try {
                this.previewRenderer.render(this.previewScene, this.previewCamera);
            } catch (error) {
                console.warn('[JointControlsUI] Preview render failed:', error);
                this.hideDragPreview();
            }
            this.previewAnimationFrame = null;
        });
    }

    destroyDragPreview() {
        if (this.previewAnimationFrame) {
            cancelAnimationFrame(this.previewAnimationFrame);
            this.previewAnimationFrame = null;
        }

        if (this.previewRenderer) {
            this.previewRenderer.dispose();
            this.previewRenderer = null;
        }

        this.previewScene = null;
        this.previewCamera = null;
        this.previewModel = null;
        this.previewModelSource = null;
        this.previewCameraLocked = false;

        if (this.dragPreview) {
            this.dragPreview.remove();
            this.dragPreview = null;
        }
    }

    /**
     * Enable the send button only when connected and there are staged edits.
     */
    updateSendButtonState() {
        if (!this.sendPositionsButton) return;
        const gripperIndex = this.jointIndexMap.get('gripper');
        const hasGripperPending = gripperIndex !== undefined && this.pendingJointValues.has(gripperIndex);
        const canSend = this.isConnectedMode &&
            this.robotConnection &&
            this.robotConnection.isConnected() &&
            (
                (this.controlMode === 'position' && this.pendingJointValues.size > 0) ||
                (this.isGripperManualMode() && hasGripperPending)
            );

        this.sendPositionsButton.disabled = !canSend;
        this.sendPositionsButton.classList.toggle('active', canSend);
    }

    /**
     * Send all current slider positions as one command.
     */
    sendPendingJointPositions() {
        if (!this.robotConnection || !this.robotConnection.isConnected()) return;
        const canSendArm = this.controlMode === 'position';
        const canSendGripper = canSendArm || this.isGripperManualMode();
        if (!canSendArm && !canSendGripper) return;

        const sliders = Array.from(document.querySelectorAll('.joint-slider'))
            .sort((a, b) => {
                const ai = Number(a.getAttribute('data-joint-index'));
                const bi = Number(b.getAttribute('data-joint-index'));
                return ai - bi;
            });

        const armPositions = [];
        let gripperPosition = null;
        for (const slider of sliders) {
            const jointName = slider.getAttribute('data-joint');
            const value = parseFloat(slider.value);
            if (Number.isNaN(value)) return;

            if (this.isGripperName(jointName)) {
                gripperPosition = value;
            } else {
                armPositions.push(value);
            }
        }

        if (!canSendArm && gripperPosition === null) return;
        if (canSendArm && armPositions.length === 0 && gripperPosition === null) return;

        const velocity = Number.isFinite(this.commandVelocity) ? this.commandVelocity : 0.6;
        this.robotConnection.moveAll(canSendArm ? armPositions : null, velocity, gripperPosition);
        this.pendingJointValues.clear();
        this.updateSendButtonState();
    }

    /**
     * Handle joint value change - stages commands when connected and updates visualization.
     */
    handleJointChange(jointName, value, jointIndex, model, options = {}) {
        if (!this.canEditJointInCurrentMode(jointName)) return;

        const shouldMarkPending = options.markPending === true;

        if (shouldMarkPending &&
            this.isConnectedMode &&
            this.robotConnection &&
            this.robotConnection.isConnected()) {
            this.pendingJointValues.set(jointIndex, value);
            this.updateSendButtonState();
            return;
        }

        // Offline mode: update visualization directly.
        this.applyJointToModel(model, jointName, value);

        const joint = model.joints.get(jointName);
        if (joint) joint.currentValue = value;

        // Apply constraints
        if (!this.isGripperName(jointName) && this.sceneManager.constraintManager) {
            this.sceneManager.constraintManager.applyConstraints(model, joint);
        }

        // Render
        requestAnimationFrame(() => {
            this.sceneManager.redraw();
            this.sceneManager.render();

            if (this.sceneManager.onMeasurementUpdate) {
                this.sceneManager.onMeasurementUpdate();
            }
        });
    }

    /**
     * Set angle unit
     */
    setAngleUnit(unit) {
        this.angleUnit = unit;
        const controls = document.querySelectorAll('.joint-control');
        controls.forEach(control => {
            if (control._updateDisplay) control._updateDisplay();
        });
    }

    /**
     * Reset all joints to initial positions
     * When connected: sends command to robot, visualization updated by robot state
     * When offline: updates visualization directly
     */
    resetAllJoints(model) {
        if (!model || !model.joints) return;
        if (this.isPositionModeLocked()) return;

        // Connected mode: reset follows a continuous S-curve trajectory to zero.
        if (this.isConnectedMode && this.robotConnection && this.robotConnection.isConnected()) {
            this.robotConnection.resetAll();
            this.pendingJointValues.clear();
            this.updateSendButtonState();
            return;
        }

        // Offline mode: update visualization directly from the visible controls.
        document.querySelectorAll('.joint-slider').forEach(slider => {
            const name = slider.getAttribute('data-joint');
            let initialValue = this.initialJointValues.get(name);
            if (initialValue === undefined) {
                initialValue = parseFloat(slider.min) || 0;
            }

            slider.value = initialValue;
            this.applyJointToModel(model, name, initialValue, true);

            const joint = model.joints.get(name);
            if (joint) joint.currentValue = initialValue;

            const control = slider.closest('.joint-control');
            if (control && control._updateDisplay) control._updateDisplay();
        });

        this.sceneManager.render();

        if (this.sceneManager.onMeasurementUpdate) {
            this.sceneManager.onMeasurementUpdate();
        }
    }

    /**
     * Update limits for all sliders
     */
    updateAllSliderLimits(model, ignoreLimits) {
        if (!model) return;

        document.querySelectorAll('.joint-slider').forEach(slider => {
            const jointName = slider.getAttribute('data-joint');
            if (this.isGripperName(jointName)) {
                const min = this.gripperUiLimits.min;
                const max = this.gripperUiLimits.max;
                slider.min = min;
                slider.max = max;
                slider.step = (max - min) / 1000;
                const control = slider.closest('.joint-control');
                if (control && control._updateDisplay) control._updateDisplay();
                return;
            }

            const joint = model.joints.get(jointName);

            if (joint && joint.type !== 'fixed') {
                if (ignoreLimits) {
                    slider.min = -Math.PI * 2;
                    slider.max = Math.PI * 2;
                    slider.step = 0.01;
                } else {
                    const limits = joint.limits || {};
                    const lower = limits.lower !== undefined ? limits.lower : -Math.PI;
                    const upper = limits.upper !== undefined ? limits.upper : Math.PI;

                    if (joint.type === 'continuous') {
                        slider.min = -Math.PI;
                        slider.max = Math.PI;
                    } else {
                        slider.min = lower;
                        slider.max = upper;
                    }
                    slider.step = (slider.max - slider.min) / 1000;
                }

                const control = slider.closest('.joint-control');
                if (control && control._updateDisplay) control._updateDisplay();
            }
        });
    }
}
