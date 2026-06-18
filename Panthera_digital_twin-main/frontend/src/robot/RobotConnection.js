/**
 * RobotConnection - WebSocket client for real-time robot communication
 *
 * Handles:
 * - WebSocket connection to backend server
 * - Real-time position streaming
 * - Joint command sending
 * - Connection state management
 */

import { io } from 'socket.io-client'

export class RobotConnection {
    constructor() {
        this.socket = null
        this.connected = false
        this.serverUrl = null
        this.robotConfig = null
        this.demoMode = false

        // Callbacks
        this.onStateUpdate = null      // (state) => void
        this.onConfigReceived = null   // (config) => void
        this.onConnected = null        // () => void
        this.onDisconnected = null     // () => void
        this.onError = null            // (error) => void
        this.onModeChanged = null      // (mode) => void

        // Control mode: 'position', 'gravity_comp', 'gravity_friction', 'impedance'
        this.controlMode = 'position'

        // State cache
        this.currentState = {
            positions: [],
            velocities: [],
            torques: [],
            target_positions: [],
            control_mode: 'position',
            impedance_target: [],
            ee_position: [0, 0, 0],
            ee_euler: [0, 0, 0],
            external_wrench: [0, 0, 0, 0, 0, 0],
            target_ee_position: [0, 0, 0],
            control_torques: [],
            timestamp: 0
        }

        // Rate limiting for commands
        this.lastCommandTime = 0
        this.commandInterval = 20  // ms, max 50Hz command rate
    }

    /**
     * Connect to robot backend server
     * @param {string} url - Server URL (e.g., 'http://localhost:5000')
     * @returns {Promise<boolean>}
     */
    async connect(url = 'http://localhost:5000') {
        return new Promise((resolve, reject) => {
            if (this.socket) {
                this.disconnect()
            }

            this.serverUrl = url
            console.log(`[RobotConnection] Connecting to ${url}...`)

            try {
                this.socket = io(url, {
                    transports: ['websocket', 'polling'],
                    reconnection: true,
                    reconnectionAttempts: 5,
                    reconnectionDelay: 1000,
                    timeout: 10000
                })

                // Connection established
                this.socket.on('connect', () => {
                    console.log('[RobotConnection] Connected!')
                    this.connected = true
                    if (this.onConnected) this.onConnected()
                    resolve(true)
                })

                // Connection error
                this.socket.on('connect_error', (error) => {
                    console.error('[RobotConnection] Connection error:', error.message)
                    if (this.onError) this.onError(error)
                    if (!this.connected) {
                        reject(error)
                    }
                })

                // Disconnected
                this.socket.on('disconnect', (reason) => {
                    console.log('[RobotConnection] Disconnected:', reason)
                    this.connected = false
                    if (this.onDisconnected) this.onDisconnected()
                })

                // Receive robot configuration
                this.socket.on('config', (config) => {
                    console.log('[RobotConnection] Config received:', config)
                    this.robotConfig = config
                    this.demoMode = config.demo_mode
                    this.controlMode = config.control_mode || 'position'
                    if (this.onConfigReceived) this.onConfigReceived(config)
                })

                // Receive robot state updates
                this.socket.on('robot_state', (state) => {
                    this.currentState = state
                    if (state.control_mode) {
                        this.controlMode = state.control_mode
                    }
                    if (this.onStateUpdate) this.onStateUpdate(state)
                })

                // Receive mode change notifications
                this.socket.on('mode_changed', (data) => {
                    console.log('[RobotConnection] Mode changed:', data.mode)
                    this.controlMode = data.mode
                    if (this.onModeChanged) this.onModeChanged(data.mode)
                })

                // Timeout handling
                setTimeout(() => {
                    if (!this.connected) {
                        this.socket.disconnect()
                        reject(new Error('Connection timeout'))
                    }
                }, 10000)

            } catch (error) {
                console.error('[RobotConnection] Failed to create socket:', error)
                reject(error)
            }
        })
    }

    /**
     * Disconnect from server
     */
    disconnect() {
        if (this.socket) {
            this.socket.disconnect()
            this.socket = null
        }
        this.connected = false
        this.robotConfig = null
        console.log('[RobotConnection] Disconnected')
    }

    /**
     * Send joint position command
     * @param {number} jointIndex - Joint index (0-5)
     * @param {number} position - Target position in radians
     */
    moveJoint(jointIndex, position) {
        if (!this.connected || !this.socket) return

        // Rate limiting
        const now = Date.now()
        if (now - this.lastCommandTime < this.commandInterval) return
        this.lastCommandTime = now

        this.socket.emit('move_joint', {
            joint: jointIndex,
            position: position
        })
    }

    /**
     * Send all joints position command
     * @param {number[]|null} positions - Array of 6 joint positions in radians, or null for gripper-only commands
     * @param {number} [velocity] - Movement velocity (optional)
     * @param {number|null} [gripper] - Gripper target position (optional)
     */
    moveAll(positions, velocity = null, gripper = null) {
        if (!this.connected || !this.socket) return

        const data = {}
        if (positions !== null) {
            data.positions = positions
        }
        if (velocity !== null) {
            data.velocity = velocity
        }
        if (gripper !== null) {
            data.gripper = gripper
        }

        this.socket.emit('move_all', data)
    }

    /**
     * Send smooth reset command (all joints to zero with backend-managed profile)
     */
    resetAll() {
        if (!this.connected || !this.socket) return
        this.socket.emit('reset_all')
    }

    /**
     * Get current robot state
     * @returns {Object} Current state
     */
    getState() {
        return this.currentState
    }

    /**
     * Get robot configuration
     * @returns {Object|null} Robot config or null if not connected
     */
    getConfig() {
        return this.robotConfig
    }

    /**
     * Check if connected
     * @returns {boolean}
     */
    isConnected() {
        return this.connected
    }

    /**
     * Check if in demo mode
     * @returns {boolean}
     */
    isDemoMode() {
        return this.demoMode
    }

    /**
     * Fetch config via REST (for initial load before WebSocket)
     * @param {string} url - Server URL
     * @returns {Promise<Object>}
     */
    async fetchConfig(url = 'http://localhost:5000') {
        try {
            const response = await fetch(`${url}/api/config`)
            if (!response.ok) throw new Error('Failed to fetch config')
            return await response.json()
        } catch (error) {
            console.error('[RobotConnection] Failed to fetch config:', error)
            throw error
        }
    }

    /**
     * Set control mode
     * @param {string} mode - 'position', 'gravity_comp', 'gravity_friction', or 'impedance'
     */
    setMode(mode) {
        if (!this.connected || !this.socket) return

        if (!['position', 'gravity_comp', 'gravity_friction', 'impedance'].includes(mode)) {
            console.error('[RobotConnection] Invalid mode:', mode)
            return
        }

        console.log('[RobotConnection] Setting mode to:', mode)
        this.socket.emit('set_mode', { mode })
    }

    /**
     * Get current control mode
     * @returns {string}
     */
    getMode() {
        return this.controlMode
    }

    /**
     * Set impedance target for a single joint
     * @param {number} jointIndex - Joint index (0-5)
     * @param {number} position - Target position in radians
     */
    setImpedanceTarget(jointIndex, position) {
        if (!this.connected || !this.socket) return

        // Rate limiting
        const now = Date.now()
        if (now - this.lastCommandTime < this.commandInterval) return
        this.lastCommandTime = now

        this.socket.emit('set_impedance_target', {
            joint: jointIndex,
            position: position
        })
    }

    /**
     * Set impedance target for all joints
     * @param {number[]} positions - Array of 6 joint positions in radians
     */
    setImpedanceTargetAll(positions) {
        if (!this.connected || !this.socket) return

        this.socket.emit('set_impedance_target', { target: positions })
    }

    /**
     * Set impedance control parameters
     * @param {number[]} K - Stiffness array (6 values)
     * @param {number[]} B - Damping array (6 values)
     */
    setImpedanceParams(K, B) {
        if (!this.connected || !this.socket) return

        const data = {}
        if (K) data.K = K
        if (B) data.B = B

        this.socket.emit('set_impedance_params', data)
    }

    /**
     * Send key down event (continuous key pressed)
     * @param {string} key - Key character (e.g., 'w', 'a', 's', 'd')
     */
    sendKeyDown(key) {
        if (!this.connected || !this.socket) return
        this.socket.emit('key_down', { key })
    }

    /**
     * Send key up event (continuous key released)
     * @param {string} key - Key character
     */
    sendKeyUp(key) {
        if (!this.connected || !this.socket) return
        this.socket.emit('key_up', { key })
    }

    /**
     * Send one-shot command
     * @param {string} action - 'home', 'zero_ft', or 'print_pose'
     */
    sendCommand(action) {
        if (!this.connected || !this.socket) return
        this.socket.emit('command', { action })
    }
}

// Singleton instance
export const robotConnection = new RobotConnection()
