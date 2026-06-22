#!/usr/bin/env python3
"""
Digital Twin Backend - Flask + WebSocket Server
Connects to Panthera robot and streams real-time data to web interface.

Usage:
    python app.py                                   # Uses default config
    python app.py --config path/to/robot.yaml       # Custom config
    python app.py --demo                            # Demo mode without robot
"""
import sys
import os
import time
import threading
import logging
import argparse
import yaml
import numpy as np
import pinocchio as pin
from flask import Flask, jsonify, request, send_from_directory, Response
from flask_socketio import SocketIO, emit
from flask_cors import CORS

# Disable Flask's request logging
log = logging.getLogger('werkzeug')
log.setLevel(logging.ERROR)

# Add Panthera SDK to path
SDK_PATH = os.path.join(os.path.dirname(__file__), '..', '..', 'panthera_python')
sys.path.insert(0, SDK_PATH)
sys.path.insert(0, os.path.join(SDK_PATH, 'scripts'))

# Local config path (self-contained in digital_twin folder)
LOCAL_CONFIG_PATH = os.path.join(os.path.dirname(__file__), '..', 'robot_param', 'xlb.yaml')

app = Flask(__name__, static_folder='../frontend/dist', static_url_path='')
CORS(app, origins="*")
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

# ============== GLOBAL SETTINGS ==============
CONTROL_FREQ = 200  # Hz - control loop frequency
BROADCAST_FREQ = 30  # Hz - WebSocket broadcast frequency
END_EFFECTOR_OFFSET = 0.07  # meters - offset from Link_6 origin to actual tool tip
ARM_JOINT_COUNT = 6
GRIPPER_JOINT_NAME = "gripper"
GRIPPER_DEFAULT_TARGET = 0.0
# =============================================

# Robot instance
robot = None
robot_config = None
demo_mode = False
script_mode = False  # True when external script is pushing state
script_state = {
    'positions': [0.0] * 6,
    'velocities': [0.0] * 6,
    'torques': [0.0] * 6,
    'fk': None
}

# Control state
target_positions = [0.0] * 6
target_velocity = 0.6
max_torque = [10.0, 10.0, 10.0, 10.0, 10.0, 2.0]
reset_profile_active = False
reset_profile_target = [0.0] * 6
reset_profile_started_at = 0.0
reset_profile_handoff_until = 0.0
reset_profile_handoff_positions = [0.0] * 6
reset_gripper_active = False
reset_gripper_target = 0.0
RESET_MAX_VELOCITY = 0.7
RESET_START_VELOCITY = 0.04
RESET_MIN_VELOCITY = 0.12
RESET_VELOCITY_GAIN = 1.8
RESET_VELOCITY_OFFSET = 0.06
RESET_NEAR_ZERO_THRESHOLD = 0.01
RESET_ACCEL_DURATION = 0.45
RESET_HANDOFF_DURATION = 0.18

# Current state
current_positions = [0.0] * 6
current_velocities = [0.0] * 6
current_torques = [0.0] * 6

# ============== CONTROL MODE SETTINGS ==============
# Modes: 'position', 'gravity_comp', 'gravity_friction', 'impedance'
control_mode = 'position'


# Gravity compensation parameters
gravity_gain = np.array([1.0, 1.0, 1.0, 1.0, 1.0, 1.0])
joint_offset = np.array([0.0, 0.0, 0.0, 0.0, 0.0, 0.0])
tau_limit = np.array([10.0, 10.0, 10.0, 10.0, 10.0, 3.7])

# Impedance control parameters (PD + gravity)
# impedance_K = np.array([10.0, 21.0, 21.0, 16.0, 13.0, 1.0])  # Stiffness
# impedance_B = np.array([1.0, 2.0, 2.0, 0.9, 0.8, 0.1])    # Damping
impedance_K = np.array([5.0, 12.0, 12.0, 4.0, 4.0, 2.0])
impedance_B = np.array([0.5, 1.0, 1.0, 0.4, 0.4, 0.2])
impedance_target = np.array([0.0, 0.7, 0.7, -0.1, 0.0, 0.0])  # Target position

# Joint configuration
JOINT_CONFIG = []
URDF_PATH = None

# Thread control
target_lock = threading.Lock()
loop_running = False
connected_clients = set()

# Forward kinematics data
current_fk = {
    'position': [0.0, 0.0, 0.0],
    'euler': [0.0, 0.0, 0.0],  # Roll, Pitch, Yaw in degrees
    'rotation': [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
}

# Waypoints for trajectory execution (max 6)
MAX_WAYPOINTS = 6
waypoints = []
trajectory_running = False
trajectory_progress = 0.0
TRAJECTORY_START_BLEND_DURATION = 1.0


def rotation_matrix_to_euler(R):
    """Convert rotation matrix to euler angles (ZYX intrinsic order, degrees)

    Uses scipy.spatial.transform.Rotation for robust conversion.
    ZYX intrinsic = Yaw-Pitch-Roll convention.
    Returns: [roll, pitch, yaw] in degrees

    Note: For this robot's coordinate frame:
    - Roll = Y rotation (lateral tilt)
    - Pitch = X rotation (forward/back tilt)
    - Yaw = Z rotation (heading)
    """
    from scipy.spatial.transform import Rotation

    R = np.array(R)
    rot = Rotation.from_matrix(R)
    # ZYX intrinsic returns [Z, Y, X] = [yaw, pitch, roll] order
    zyx_angles = rot.as_euler('ZYX', degrees=True)
    # Swap to match robot's coordinate frame convention
    roll = zyx_angles[1]   # Y rotation
    pitch = zyx_angles[2]  # X rotation
    yaw = zyx_angles[0]    # Z rotation
    return [roll, pitch, yaw]

# Timing stats
timing_stats = {
    "loop_count": 0,
    "avg_cmd_time": 0.0,
    "overruns": 0
}

# External wrench (force/torque estimation)
current_wrench = [0.0] * 6
FT_LAMBDA = 0.05       # DLS damping for force estimation
FT_Fc = np.array([0.10, 0.12, 0.12, 0.08, 0.03, 0.02])
FT_Fv = np.array([0.04, 0.06, 0.06, 0.04, 0.02, 0.02])
FT_VEL_THRESH = 0.02
TOOL_OFFSET = np.array([0.165, 0.0, 0.0])


def compute_external_wrench(robot, joint_angles, joint_velocities, joint_torques):
    """Estimate external Cartesian force/torque from joint torque measurements.
    Returns: [Fx, Fy, Fz, Mx, My, Mz]
    """
    try:
        q = np.asarray(joint_angles)
        dq = np.asarray(joint_velocities)
        tau_measured = np.asarray(joint_torques)

        # Gravity compensation
        G = robot.get_Gravity(q)

        # Friction compensation
        F_friction = robot.get_friction_compensation(dq, FT_Fc, FT_Fv, FT_VEL_THRESH)

        # External joint torque = measured - model
        tau_ext = tau_measured - G - F_friction

        # Compute Jacobian at last joint
        q_pin = np.zeros(robot.model.nq)
        for i, name in enumerate(robot.joint_names):
            jid = robot.model.getJointId(name)
            q_pin[robot.model.joints[jid].idx_q] = q[i]

        pin.computeJointJacobians(robot.model, robot.data, q_pin)
        last_jid = robot.model.getJointId(robot.joint_names[-1])
        J_full = pin.getJointJacobian(
            robot.model, robot.data, last_jid,
            pin.ReferenceFrame.LOCAL_WORLD_ALIGNED
        )

        # Tool offset adjustment
        T_last = robot.data.oMi[last_jid]
        r_world = T_last.rotation @ TOOL_OFFSET
        skew_r = np.array([[0, -r_world[2], r_world[1]],
                           [r_world[2], 0, -r_world[0]],
                           [-r_world[1], r_world[0], 0]])
        J_tcp = J_full.copy()
        J_tcp[:3, :] -= skew_r @ J_full[3:, :]

        # Select 6 controlled joints
        cols = [robot.model.joints[robot.model.getJointId(n)].idx_v
                for n in robot.joint_names]
        J6 = J_tcp[:, cols]

        # DLS: F = J^T (J J^T + λ²I)^(-1) τ_ext
        JJT = J6 @ J6.T
        F_ext = J6.T @ np.linalg.solve(JJT + FT_LAMBDA**2 * np.eye(6), tau_ext)

        return F_ext.tolist()
    except Exception as e:
        # Silently return zero on any estimation error
        return [0.0] * 6


def precise_sleep(duration):
    """High precision sleep function"""
    if duration <= 0:
        return

    end_time = time.perf_counter() + duration

    # Use sleep for most of the time (leave 1ms margin)
    if duration > 0.001:
        time.sleep(duration - 0.001)

    # Busy wait for final precision
    while time.perf_counter() < end_time:
        pass


def _current_arm_positions():
    if robot is not None and not demo_mode:
        try:
            robot.send_get_motor_state_cmd()
            pos = robot.get_current_pos()
            return (pos.tolist() if hasattr(pos, 'tolist') else list(pos))[:ARM_JOINT_COUNT]
        except Exception:
            pass
    return current_positions.copy()


def _prepare_trajectory_from_current_pose():
    with target_lock:
        _cancel_reset_profile()

    current_start = _clamp_arm_positions(_current_arm_positions())
    waypoint_list = [wp['positions'] for wp in waypoints]
    durations = [wp['duration'] for wp in waypoints[:-1]]

    if waypoint_list:
        first_distance = max(
            abs(current_start[i] - waypoint_list[0][i])
            for i in range(min(len(current_start), len(waypoint_list[0])))
        )
        if first_distance > 0.01:
            waypoint_list = [current_start] + waypoint_list
            durations = [TRAJECTORY_START_BLEND_DURATION] + durations

    return waypoint_list, durations


def execute_trajectory_thread(waypoint_list, durations, control_rate=100):
    """Execute trajectory in a separate thread"""
    global trajectory_running, trajectory_progress, target_positions, control_mode

    if len(waypoint_list) < 2:
        print("Need at least 2 waypoints for trajectory")
        return False

    if robot is None or demo_mode:
        print("Cannot execute trajectory: robot not available or in demo mode")
        # In demo mode, simulate trajectory execution
        if demo_mode:
            trajectory_running = True
            total_duration = sum(durations)
            elapsed = 0

            for seg_idx, duration in enumerate(durations):
                start_pos = waypoint_list[seg_idx]
                end_pos = waypoint_list[seg_idx + 1]
                steps = int(duration * 30)  # Lower rate for demo

                for step in range(steps):
                    if not trajectory_running:
                        return False

                    t = step / steps
                    # Smooth interpolation
                    s = 3 * t**2 - 2 * t**3
                    pos = [start_pos[i] + s * (end_pos[i] - start_pos[i]) for i in range(len(start_pos))]

                    with target_lock:
                        target_positions[:] = pos

                    elapsed += duration / steps
                    trajectory_progress = elapsed / total_duration
                    socketio.emit('trajectory_progress', {'progress': trajectory_progress})
                    time.sleep(1.0 / 30)

            trajectory_progress = 1.0
            socketio.emit('trajectory_progress', {'progress': 1.0})
            socketio.emit('trajectory_complete', {'success': True})
            trajectory_running = False
            return True
        return False

    # Switch to trajectory mode - control_loop will skip, letting this thread have exclusive control.
    control_mode = 'trajectory'

    trajectory_running = True
    trajectory_progress = 0.0

    dt = 1.0 / control_rate
    total_duration = sum(durations)
    elapsed_total = 0

    try:
        for segment in range(len(durations)):
            start_pos = waypoint_list[segment]
            end_pos = waypoint_list[segment + 1]
            duration = durations[segment]

            steps = int(duration * control_rate)
            segment_start = time.perf_counter()

            for step in range(steps):
                if not trajectory_running:
                    # Trajectory was cancelled
                    socketio.emit('trajectory_complete', {'success': False, 'cancelled': True})
                    return False

                target_time = segment_start + (step + 1) * dt
                current_time = step * dt

                # Generate interpolated trajectory using septic polynomial
                pos, vel, _ = robot.septic_interpolation(start_pos, end_pos, duration, current_time)

                # Send control command
                robot.Joint_Pos_Vel(pos, vel, max_torque)

                # Update progress
                elapsed_total = sum(durations[:segment]) + current_time
                trajectory_progress = elapsed_total / total_duration

                # Broadcast progress to clients
                socketio.emit('trajectory_progress', {'progress': trajectory_progress})

                # High precision wait
                wait_time = target_time - time.perf_counter()
                if wait_time > 0:
                    precise_sleep(wait_time)

        # Move to final position
        final_pos = waypoint_list[-1]
        robot.Joint_Pos_Vel(final_pos, [0.0] * robot.motor_count, max_torque)

        trajectory_progress = 1.0
        socketio.emit('trajectory_progress', {'progress': 1.0})
        socketio.emit('trajectory_complete', {'success': True})

    except Exception as e:
        print(f"Trajectory execution error: {e}")
        socketio.emit('trajectory_complete', {'success': False, 'error': str(e)})

    finally:
        trajectory_running = False
        control_mode = 'position'
        with target_lock:
            if waypoint_list:
                target_positions[:] = _clamp_arm_positions(waypoint_list[-1])

    return True


def load_config(config_path):
    """Load robot configuration from YAML file"""
    global robot_config, JOINT_CONFIG, URDF_PATH

    with open(config_path, 'r', encoding='utf-8') as f:
        robot_config = yaml.safe_load(f)

    config_dir = os.path.dirname(os.path.abspath(config_path))

    # Load URDF path
    urdf_relative = robot_config['urdf']['file_path']
    URDF_PATH = os.path.normpath(os.path.join(config_dir, urdf_relative))

    # Load joint configuration
    joint_names = robot_config['kinematics']['joint_names']
    lower_limits = robot_config['robot']['joint_limits']['lower']
    upper_limits = robot_config['robot']['joint_limits']['upper']

    JOINT_CONFIG = []
    for i, name in enumerate(joint_names):
        JOINT_CONFIG.append({
            "name": name,
            "index": i,
            "min": lower_limits[i],
            "max": upper_limits[i],
            "kind": "arm"
        })

    gripper_limits = robot_config.get('robot', {}).get('gripper_limits')
    if gripper_limits:
        JOINT_CONFIG.append({
            "name": GRIPPER_JOINT_NAME,
            "index": len(joint_names),
            "min": float(gripper_limits.get('lower', 0.0)),
            "max": float(gripper_limits.get('upper', 1.8)),
            "kind": "gripper"
        })

    print(f"Config loaded: {robot_config['robot']['name']}")
    print(f"URDF: {URDF_PATH}")
    print(f"Joints: {len(JOINT_CONFIG)}")

    return robot_config


def _arm_joint_config():
    return [jc for jc in JOINT_CONFIG if jc.get("kind") != "gripper"]


def _gripper_config():
    for jc in JOINT_CONFIG:
        if jc.get("kind") == "gripper" or jc.get("name") == GRIPPER_JOINT_NAME:
            return jc
    return None


def _gripper_limits_list():
    cfg = _gripper_config()
    if not cfg:
        return None
    return [cfg["min"], cfg["max"]]


def _clamp_gripper_position(position):
    cfg = _gripper_config()
    position = float(position)
    if cfg:
        position = max(cfg["min"], min(cfg["max"], position))
    return position


def _set_gripper_target(position, velocity=0.3):
    global _gripper_target
    position = _clamp_gripper_position(position)
    _gripper_target = position
    if robot is not None and not demo_mode:
        try:
            robot.gripper_control(position, velocity, 0.15)
        except Exception:
            pass
    return position


def _release_gripper():
    """Release gripper torque so it can be moved freely by hand."""
    if robot is not None and not demo_mode:
        try:
            robot.gripper_control_MIT(0.0, 0.0, 0.0, 0.0, 0.0)
        except Exception:
            pass


def _hold_gripper_impedance():
    """Keep gripper in a light MIT hold while arm impedance is active."""
    if robot is not None and not demo_mode:
        try:
            robot.gripper_control_MIT(1.0, 0.0, 0.0, 0.65, 0.06)
        except Exception:
            pass


def _read_gripper_position():
    global _gripper_target
    if robot is not None and not demo_mode:
        try:
            state = robot.get_current_state_gripper()
            _gripper_target = _clamp_gripper_position(state.position)
        except Exception:
            pass
    return _gripper_target


def _is_gripper_index(joint_index):
    cfg = _gripper_config()
    return cfg is not None and joint_index == cfg["index"]


def _reset_velocity_from_error(error):
    return max(
        RESET_MIN_VELOCITY,
        min(RESET_MAX_VELOCITY, RESET_VELOCITY_GAIN * error + RESET_VELOCITY_OFFSET)
    )


def _smoothstep(progress):
    progress = max(0.0, min(1.0, progress))
    return progress * progress * progress * (progress * (progress * 6.0 - 15.0) + 10.0)


def _reset_accel_velocity_cap(elapsed):
    if RESET_ACCEL_DURATION <= 0:
        return RESET_MAX_VELOCITY
    progress = _smoothstep(elapsed / RESET_ACCEL_DURATION)
    return RESET_START_VELOCITY + (RESET_MAX_VELOCITY - RESET_START_VELOCITY) * progress


def _clamp_arm_positions(positions):
    arm_config = _arm_joint_config()
    next_positions = list(positions[:len(target_positions)])
    for i, pos in enumerate(next_positions):
        if i < len(arm_config):
            jc = arm_config[i]
            next_positions[i] = max(jc["min"], min(jc["max"], pos))
    return next_positions


def _cancel_reset_profile():
    global reset_profile_active, reset_gripper_active, reset_profile_handoff_until
    reset_profile_active = False
    reset_gripper_active = False
    reset_profile_handoff_until = 0.0


def _start_smooth_position_reset(with_handoff=False):
    global target_positions, target_velocity, reset_profile_active, reset_profile_target, reset_profile_started_at
    global reset_profile_handoff_until, reset_profile_handoff_positions
    global reset_gripper_active, reset_gripper_target

    reset_profile_target[:] = [0.0] * len(target_positions)
    target_positions[:] = reset_profile_target.copy()
    reset_gripper_target = 0.0
    reset_gripper_active = True
    now = time.time()
    reset_profile_started_at = now
    reset_profile_handoff_until = 0.0
    reset_profile_handoff_positions[:] = current_positions[:len(reset_profile_handoff_positions)]
    if with_handoff:
        reset_profile_handoff_positions[:] = _clamp_arm_positions(_current_arm_positions())
        reset_profile_handoff_until = now + RESET_HANDOFF_DURATION
        reset_profile_started_at = reset_profile_handoff_until
    target_velocity = RESET_MAX_VELOCITY
    reset_profile_active = True


def _set_control_mode(mode):
    global control_mode, impedance_target, reset_profile_active, reset_gripper_active

    previous_mode = control_mode
    control_mode = mode

    if mode == 'position':
        if previous_mode in ['gravity_comp', 'gravity_friction', 'impedance']:
            _start_smooth_position_reset(with_handoff=True)
        return

    _cancel_reset_profile()

    if mode == 'impedance':
        impedance_target = np.array(current_positions)


def init_robot(config_path):
    """Initialize robot connection"""
    global robot, demo_mode

    try:
        if demo_mode:
            # In demo mode, use PantheraSim for FK kinematics (no hardware needed)
            print("Running in DEMO mode (no motor control)")
            try:
                from panthera_sim import PantheraSim
                robot = PantheraSim(config_path)
                print(f"Kinematics initialized for {robot.motor_count} joints (FK available)")
            except Exception as e:
                print(f"Could not initialize kinematics: {e}")
                print("FK will not be available in demo mode")
                robot = None
            return True

        from scripts.Panthera_lib.Panthera import Panthera
        robot = Panthera(config_path)
        print(f"Robot initialized with {robot.motor_count} motors")

        # Read fresh motor state before getting positions
        robot.send_get_motor_state_cmd()
        robot.motor_send_cmd()
        time.sleep(0.1)

        pos = robot.get_current_pos()
        # Validate that positions are reasonable (not uninitialized 999)
        pos_list = pos.tolist() if hasattr(pos, 'tolist') else list(pos)
        if any(abs(p) > 100 for p in pos_list):
            print(f"[WARN] Motor positions look invalid ({pos_list}), defaulting to zero")
            pos_list = [0.0] * len(pos_list)

        global target_positions, current_positions, _gripper_target
        target_positions = pos_list
        current_positions = pos_list
        _set_gripper_target(GRIPPER_DEFAULT_TARGET)

        return True
    except Exception as e:
        print(f"Failed to initialize robot: {e}")
        print("Falling back to DEMO mode")
        demo_mode = True
        return True


def control_loop():
    """Main control loop - sends commands to robot based on control mode"""
    global current_positions, current_velocities, current_torques, timing_stats
    global control_mode, impedance_target, reset_profile_active, reset_gripper_active

    dt = 1.0 / CONTROL_FREQ

    # Zero arrays for torque-only control
    zero_pos = [0.0] * 6
    zero_vel = [0.0] * 6
    zero_kp = [0.0] * 6
    zero_kd = [0.0] * 6

    while loop_running:
        loop_start = time.time()

        try:
            if script_mode:
                # Let the script thread control the robot exclusively
                pass
            elif not demo_mode and robot is not None:
                with target_lock:
                    mode = control_mode
                    targets = target_positions.copy()
                    vel_target = target_velocity
                    reset_active = reset_profile_active
                    reset_target = reset_profile_target.copy()
                    reset_started_at = reset_profile_started_at
                    reset_handoff_until = reset_profile_handoff_until
                    reset_handoff_positions = reset_profile_handoff_positions.copy()
                    gripper_reset_active = reset_gripper_active
                    gripper_reset_target = reset_gripper_target
                    imp_target = impedance_target.copy()

                # Process keyboard input (nudges targets)
                _process_keyboard()

                t1 = time.time()

                if mode == 'position':
                    # Position control mode - direct joint control
                    # Safety clamp
                    arm_config = _arm_joint_config()
                    if arm_config:
                        for i in range(min(len(targets), len(arm_config))):
                            jc = arm_config[i]
                            targets[i] = max(jc['min'], min(jc['max'], targets[i]))
                    if reset_active:
                        now = time.time()
                        if reset_handoff_until > now:
                            targets = reset_handoff_positions[:len(targets)]
                            vel = [0.0] * len(targets)
                        else:
                            targets = reset_target[:len(targets)]
                            errors = [abs(targets[i] - current_positions[i]) for i in range(len(targets))]
                            max_error = max(errors) if errors else 0.0
                            accel_cap = _reset_accel_velocity_cap(now - reset_started_at)
                            vel = [min(accel_cap, _reset_velocity_from_error(error)) for error in errors]
                            if max_error < RESET_NEAR_ZERO_THRESHOLD:
                                vel = [RESET_MIN_VELOCITY] * len(targets)
                    else:
                        vel = [vel_target] * len(targets)
                    robot.Joint_Pos_Vel(targets, vel, max_torque, iswait=False)

                    if gripper_reset_active:
                        current_gripper_position = _read_gripper_position()
                        gripper_error = abs(gripper_reset_target - current_gripper_position)
                        accel_cap = _reset_accel_velocity_cap(time.time() - reset_started_at)
                        gripper_velocity = min(accel_cap, _reset_velocity_from_error(gripper_error))
                        if gripper_error < RESET_NEAR_ZERO_THRESHOLD:
                            gripper_velocity = RESET_MIN_VELOCITY
                        _set_gripper_target(gripper_reset_target, velocity=gripper_velocity)

                elif mode == 'gravity_comp':
                    # Gravity compensation mode - robot floats freely
                    robot.send_get_motor_state_cmd()
                    q = robot.get_current_pos() + joint_offset
                    tor = robot.get_Gravity(q) * gravity_gain
                    tor = np.clip(tor, -tau_limit, tau_limit)
                    robot.pos_vel_tqe_kp_kd(zero_pos, zero_vel, tor.tolist(), zero_kp, zero_kd)
                    _release_gripper()

                elif mode == 'gravity_friction':
                    # Gravity + friction compensation mode
                    robot.send_get_motor_state_cmd()
                    q = robot.get_current_pos() + joint_offset
                    dq = robot.get_current_vel()
                    tor_g = robot.get_Gravity(q) * gravity_gain
                    tor_f = robot.get_friction_compensation(dq, FT_Fc, FT_Fv, FT_VEL_THRESH)
                    tor = np.clip(tor_g + tor_f, -tau_limit, tau_limit)
                    robot.pos_vel_tqe_kp_kd(zero_pos, zero_vel, tor.tolist(), zero_kp, zero_kd)
                    _release_gripper()

                elif mode == 'impedance':
                    # Impedance control mode - PD + gravity compensation
                    robot.send_get_motor_state_cmd()
                    q_current = robot.get_current_pos()
                    vel_current = robot.get_current_vel()

                    # PD torque
                    tor_pd = impedance_K * (imp_target - q_current) + impedance_B * (0.0 - vel_current)

                    # Gravity compensation
                    G = robot.get_Gravity(q_current + joint_offset)

                    # Total torque
                    tor = tor_pd + G * gravity_gain
                    tor = np.clip(tor, -tau_limit, tau_limit)
                    robot.pos_vel_tqe_kp_kd(zero_pos, zero_vel, tor.tolist(), zero_kp, zero_kd)
                    _hold_gripper_impedance()

                elif mode == 'trajectory':
                    # Trajectory mode - control handled by execute_trajectory_thread
                    # Just skip, don't send any commands
                    pass

                cmd_time = (time.time() - t1) * 1000

                timing_stats["loop_count"] += 1
                timing_stats["avg_cmd_time"] = (
                    timing_stats["avg_cmd_time"] * 0.95 + cmd_time * 0.05
                )
        except Exception as e:
            print(f"Control loop error: {e}")

        elapsed = time.time() - loop_start
        if elapsed > dt:
            timing_stats["overruns"] += 1

        sleep_time = dt - elapsed
        if sleep_time > 0:
            time.sleep(sleep_time)


def state_broadcast_loop():
    """Broadcast robot state to connected clients"""
    global current_positions, current_velocities, current_torques, current_fk

    dt = 1.0 / BROADCAST_FREQ

    while loop_running:
        loop_start = time.time()

        try:
            if script_mode:
                # Script is running — still read real robot state for frontend
                # (the script thread controls motors; we only observe)
                if not demo_mode and robot is not None:
                    try:
                        pos = robot.get_current_pos()
                        vel = robot.get_current_vel()
                        tqe = robot.get_current_torque()
                        current_positions[:] = pos.tolist() if hasattr(pos, 'tolist') else list(pos)
                        current_velocities[:] = vel.tolist() if hasattr(vel, 'tolist') else list(vel)
                        current_torques[:] = tqe.tolist() if hasattr(tqe, 'tolist') else list(tqe)
                    except Exception:
                        pass

            elif not demo_mode and robot is not None:
                # Read fresh state from real robot
                robot.send_get_motor_state_cmd()
                robot.motor_send_cmd()

                pos = robot.get_current_pos()
                vel = robot.get_current_vel()
                tqe = robot.get_current_torque()

                current_positions = pos.tolist() if hasattr(pos, 'tolist') else list(pos)
                current_velocities = vel.tolist() if hasattr(vel, 'tolist') else list(vel)
                current_torques = tqe.tolist() if hasattr(tqe, 'tolist') else list(tqe)

                # Calculate forward kinematics
                try:
                    fk = robot.forward_kinematics(pos)
                    if fk:
                        current_fk['position'] = fk['position'].tolist() if hasattr(fk['position'], 'tolist') else list(fk['position'])
                        rotation = fk['rotation']
                        current_fk['rotation'] = rotation.tolist() if hasattr(rotation, 'tolist') else [list(row) for row in rotation]
                        current_fk['euler'] = rotation_matrix_to_euler(rotation)
                except Exception as fk_error:
                    pass  # FK calculation failed, keep previous values

            else:
                # Demo mode: smoothly interpolate to target
                with target_lock:
                    targets = target_positions.copy()

                for i in range(len(current_positions)):
                    diff = targets[i] - current_positions[i]
                    current_positions[i] += diff * 0.1  # Smooth interpolation

                # Demo mode FK: use robot if available, otherwise skip
                if robot is not None:
                    try:
                        fk = robot.forward_kinematics(np.array(current_positions))
                        if fk:
                            current_fk['position'] = fk['position'].tolist() if hasattr(fk['position'], 'tolist') else list(fk['position'])
                            rotation = fk['rotation']
                            current_fk['rotation'] = rotation.tolist() if hasattr(rotation, 'tolist') else [list(row) for row in rotation]
                            current_fk['euler'] = rotation_matrix_to_euler(rotation)
                    except Exception:
                        pass

            # External wrench estimation (only in live mode)
            if not demo_mode and robot is not None:
                try:
                    wrench = compute_external_wrench(
                        robot, current_positions, current_velocities, current_torques
                    )
                    current_wrench[:] = wrench
                except Exception:
                    pass

            # Broadcast to all connected clients
            if connected_clients:
                with target_lock:
                    mode = control_mode
                    imp_target = impedance_target.tolist()
                    gripper_position = _read_gripper_position()

                socketio.emit('robot_state', {
                    'positions': current_positions,
                    'velocities': current_velocities,
                    'torques': current_torques,
                    'target_positions': target_positions,
                    'gripper_position': gripper_position,
                    'control_mode': mode,
                    'impedance_target': imp_target,
                    'forward_kinematics': current_fk,
                    'ee_position': current_fk['position'],
                    'ee_euler': current_fk['euler'],
                    'external_wrench': current_wrench,
                    'timestamp': time.time()
                })

        except Exception as e:
            print(f"Broadcast loop error: {e}")

        elapsed = time.time() - loop_start
        sleep_time = dt - elapsed
        if sleep_time > 0:
            time.sleep(sleep_time)


def start_loops():
    """Start control and broadcast loops"""
    global loop_running
    loop_running = True

    # Control loop (high frequency)
    control_thread = threading.Thread(target=control_loop, daemon=True)
    control_thread.start()

    # Broadcast loop (medium frequency)
    broadcast_thread = threading.Thread(target=state_broadcast_loop, daemon=True)
    broadcast_thread.start()

    print(f"Control loop started at {CONTROL_FREQ} Hz")
    print(f"Broadcast loop started at {BROADCAST_FREQ} Hz")


# ============== Static Files ==============
ARM_DESCRIPTION_PATH = os.path.join(os.path.dirname(__file__), '..', 'arm_description')
PANTHERA_HT_PATH = os.path.join(os.path.dirname(__file__), '..', '..', 'panthera_python', 'Panthera-HT_description')


@app.route('/arm_description/<path:filename>')
def serve_arm_description(filename):
    """Serve files from arm_description folder"""
    return send_from_directory(ARM_DESCRIPTION_PATH, filename)


@app.route('/Panthera-HT_description/<path:filename>')
def serve_panthera_ht(filename):
    """Serve files from Panthera-HT_description folder"""
    return send_from_directory(PANTHERA_HT_PATH, filename)


# ============== REST API Routes ==============

@app.route('/')
def index():
    """Serve frontend"""
    return send_from_directory(app.static_folder, 'index.html')


@app.route('/api/config')
def get_config():
    """Get robot configuration for frontend"""
    return jsonify({
        "robot_name": robot_config['robot']['name'] if robot_config else "Unknown",
        "joints": JOINT_CONFIG,
        "urdf_path": URDF_PATH,
        "demo_mode": demo_mode,
        "control_freq": CONTROL_FREQ,
        "connected": robot is not None or demo_mode,
        "control_mode": control_mode,
        "end_effector_link": robot_config.get('urdf', {}).get('end_effector_link') if robot_config else None,
        "end_effector_offset": END_EFFECTOR_OFFSET,
        "gripper_limits": _gripper_limits_list(),
        "impedance_kp": impedance_K.tolist(),
    })


@app.route('/api/arm_description_files')
def get_arm_description_files():
    """Get list of files in arm_description and Panthera-HT_description folders for auto-loading"""
    files = {}

    def scan_directory(path, prefix='', url_prefix=''):
        """Recursively scan directory and build file list"""
        for entry in os.scandir(path):
            rel_path = os.path.join(prefix, entry.name) if prefix else entry.name
            if entry.is_file():
                url_path = rel_path
                if url_prefix:
                    url_path = f'{url_prefix}/{rel_path}'
                files[rel_path] = url_path
            elif entry.is_dir():
                scan_directory(entry.path, rel_path, url_prefix)

    try:
        # Scan arm_description
        scan_directory(ARM_DESCRIPTION_PATH, url_prefix='/arm_description')
        # Also scan Panthera-HT_description
        scan_directory(PANTHERA_HT_PATH, url_prefix='/Panthera-HT_description')
        return jsonify({
            "success": True,
            "files": files,
            "base_url": "/arm_description"
        })
    except Exception as e:
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


@app.route('/api/status')
def get_status():
    """Get current robot status (REST fallback)"""
    return jsonify({
        "connected": robot is not None or demo_mode,
        "demo_mode": demo_mode,
        "script_mode": script_mode,
        "script_running": _script_is_running(),
        "current_script": _script_name,
        "positions": current_positions,
        "velocities": current_velocities,
        "torques": current_torques,
        "target_positions": target_positions,
        "target_velocity": target_velocity,
        "gripper_position": _read_gripper_position()
    })


@app.route('/api/move_joint', methods=['POST'])
def move_joint():
    """Move a single joint"""
    global target_positions

    data = request.json
    joint_index = data.get('joint')
    position = data.get('position')

    if joint_index is not None and position is not None:
        joint_index = int(joint_index)
        if _is_gripper_index(joint_index):
            _cancel_reset_profile()
            _set_gripper_target(position)
            return jsonify({"success": True})

        # Clamp to joint limits
        arm_config = _arm_joint_config()
        if arm_config and joint_index < len(arm_config):
            jc = arm_config[joint_index]
            position = max(jc['min'], min(jc['max'], position))

        if joint_index < len(target_positions):
            with target_lock:
                _cancel_reset_profile()
                target_positions[joint_index] = position

    return jsonify({"success": True})


@app.route('/api/move', methods=['POST'])
def move_all():
    """Move all joints"""
    global target_positions, target_velocity

    data = request.json
    gripper_velocity = data.get('velocity', 0.3)

    with target_lock:
        _cancel_reset_profile()
        if 'positions' in data:
            positions = list(data['positions'])
            target_positions[:] = _clamp_arm_positions(positions)
            gripper_cfg = _gripper_config()
            if gripper_cfg and len(positions) > gripper_cfg["index"]:
                _set_gripper_target(positions[gripper_cfg["index"]], velocity=gripper_velocity)

        if 'gripper' in data:
            _set_gripper_target(data['gripper'], velocity=gripper_velocity)

        if 'velocity' in data:
            target_velocity = data['velocity']

    return jsonify({"success": True})


@app.route('/api/home', methods=['POST'])
def go_home():
    """Move to home position"""
    with target_lock:
        _start_smooth_position_reset()

    return jsonify({"success": True})


@app.route('/api/stop', methods=['POST'])
def stop():
    """Stop at current position"""
    global target_positions

    with target_lock:
        _cancel_reset_profile()
        target_positions[:] = current_positions.copy()

    return jsonify({"success": True})


# ── Script execution state ─────────────────────────────────────────
import subprocess as _subprocess
import contextlib
import io
_script_process = None
_script_name = None
_script_stop_event = threading.Event()  # signal to stop in-process script
_backend_config_path = None  # set at startup
SCRIPTS_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__),
    '..', '..', 'panthera_python', 'scripts'))
SCRIPT_LOG_DIR = os.path.join(os.path.dirname(__file__), 'logs')
SCRIPT_LOG_PATH = os.path.join(SCRIPT_LOG_DIR, 'script_runner.log')
_script_output_lock = threading.Lock()
_SCRIPT_OUTPUT_LIMIT = 1000


def _append_script_output(text):
    if text is None:
        return
    text = str(text)
    if not text:
        return
    os.makedirs(SCRIPT_LOG_DIR, exist_ok=True)
    if not text.endswith('\n'):
        text += '\n'
    with _script_output_lock:
        with open(SCRIPT_LOG_PATH, 'a', encoding='utf-8', errors='replace') as log_file:
            log_file.write(text)
            log_file.flush()


def _clear_script_output():
    os.makedirs(SCRIPT_LOG_DIR, exist_ok=True)
    with _script_output_lock:
        with open(SCRIPT_LOG_PATH, 'w', encoding='utf-8'):
            pass


def _get_script_output():
    if not os.path.exists(SCRIPT_LOG_PATH):
        return []
    with _script_output_lock:
        with open(SCRIPT_LOG_PATH, 'r', encoding='utf-8', errors='replace') as log_file:
            lines = log_file.read().splitlines()
    return lines[-_SCRIPT_OUTPUT_LIMIT:]


def _script_is_running():
    return (_script_process is not None and
        ((isinstance(_script_process, _subprocess.Popen) and _script_process.poll() is None) or
         (isinstance(_script_process, threading.Thread) and _script_process.is_alive())))


def _discover_scripts():
    scripts = []

    if not os.path.isdir(SCRIPTS_DIR):
        return scripts

    for filename in sorted(os.listdir(SCRIPTS_DIR)):
        full_path = os.path.normpath(os.path.join(SCRIPTS_DIR, filename))
        if not os.path.isfile(full_path) or not filename.endswith('.py') or filename.startswith('__'):
            continue
        name = filename[:-3]
        label = name.replace('_', ' ')
        scripts.append({
            'name': name,
            'file': filename,
            'label': label,
        })

    scripts.sort(key=lambda item: item['file'])
    return scripts


def _resolve_script_path(script_name):
    script_name = (script_name or '').replace('\\', '/').lstrip('/')
    if not script_name.endswith('.py'):
        script_name += '.py'

    script_path = os.path.normpath(os.path.join(SCRIPTS_DIR, script_name))
    scripts_root = os.path.abspath(SCRIPTS_DIR)
    abs_script_path = os.path.abspath(script_path)
    if os.path.commonpath([scripts_root, abs_script_path]) != scripts_root:
        return None, script_name
    return script_path, script_name


@app.route('/api/scripts', methods=['GET'])
def list_scripts():
    """List available Python scripts from the SDK scripts directory."""
    is_running = _script_is_running()
    scripts = _discover_scripts()
    return jsonify({
        'scripts': scripts,
        'scripts_count': len(scripts),
        'scripts_dir': os.path.abspath(SCRIPTS_DIR),
        'running': is_running,
        'current_script': _script_name
    })


@app.route('/api/scripts/output', methods=['GET'])
def get_script_output():
    """Get captured output from the current or last script run."""
    return jsonify({
        'success': True,
        'running': _script_is_running(),
        'current_script': _script_name,
        'log_path': os.path.abspath(SCRIPT_LOG_PATH),
        'output': _get_script_output()
    })


@app.route('/api/scripts/log', methods=['GET'])
def get_script_log():
    """Read captured script output directly from the log file."""
    lines = _get_script_output()
    return Response('\n'.join(lines), mimetype='text/plain; charset=utf-8')


@app.route('/api/scripts/run', methods=['POST'])
def run_script():
    """Launch a script.  Demo→subprocess(PantheraSim).  Real→in-process thread."""
    global _script_process, _script_name, script_mode
    data = request.json or {}
    script_name = data.get('script', '')

    if not script_name:
        return jsonify({'success': False, 'error': 'No script specified'}), 400

    script_path, script_name = _resolve_script_path(script_name)
    if not script_path:
        return jsonify({'success': False, 'error': f'Invalid script path: {script_name}'}), 403
    if not os.path.exists(script_path):
        return jsonify({'success': False, 'error': f'Script not found: {script_name}'}), 404

    _clear_script_output()
    _append_script_output(f"[ScriptRunner] Starting {script_name}")

    # Stop any running script first
    if _script_process is not None:
        if isinstance(_script_process, _subprocess.Popen) and _script_process.poll() is None:
            _script_process.terminate()
            try: _script_process.wait(timeout=2)
            except Exception: _script_process.kill()
        elif isinstance(_script_process, threading.Thread) and _script_process.is_alive():
            # In-process thread — we can't force-kill reliably,
            # but setting script_mode=False lets the control loop resume
            script_mode = False
            _script_process = None
            _script_name = None

    # ── Demo / simulation mode: subprocess with PantheraSim ──────────
    if demo_mode or robot is None:
        runner = os.path.join(os.path.dirname(__file__), 'run_script.py')
        cmd = [sys.executable, runner, '--demo', script_name]
        try:
            log_file = open(SCRIPT_LOG_PATH, 'a', encoding='utf-8', buffering=1)
            _script_process = _subprocess.Popen(
                cmd,
                cwd=os.path.dirname(__file__),
                stdout=log_file,
                stderr=log_file,
                text=True,
                bufsize=1,
            )
            _script_name = script_name
            script_mode = True
            threading.Thread(target=_watch_script_process, args=(_script_process, log_file), daemon=True).start()
            return jsonify({'success': True, 'script': script_name, 'pid': _script_process.pid})
        except Exception as e:
            return jsonify({'success': False, 'error': str(e)}), 500

    # ── Real robot mode: run in-process thread to avoid serial-port
    #     conflicts with the backend's existing Panthera instance ─────
    try:
        _script_name = script_name
        script_mode = True
        thr = threading.Thread(
            target=_run_script_in_thread,
            args=(script_path,),
            daemon=True,
        )
        thr.start()
        _script_process = thr
        return jsonify({'success': True, 'script': script_name, 'thread': True})
    except Exception as e:
        script_mode = False
        return jsonify({'success': False, 'error': str(e)}), 500


def _watch_script_process(process, log_file=None):
    """Clear running state when a subprocess exits."""
    global _script_process, _script_name, script_mode

    try:
        return_code = process.wait()
        _append_script_output(f"[ScriptRunner] Script exited with code {return_code}")
    except Exception as e:
        _append_script_output(f"[ScriptRunner] Process watcher error: {e}")
    finally:
        if log_file:
            try:
                log_file.close()
            except Exception:
                pass
        if _script_process is process:
            _script_process = None
            _script_name = None
            script_mode = False


class _ScriptOutputCapture(io.TextIOBase):
    def __init__(self, stream):
        super().__init__()
        self.stream = stream
        self._buffer = ''

    def writable(self):
        return True

    def write(self, text):
        if not text:
            return 0
        self.stream.write(text)
        self.stream.flush()
        self._buffer += text
        while '\n' in self._buffer:
            line, self._buffer = self._buffer.split('\n', 1)
            _append_script_output(line)
        return len(text)

    def flush(self):
        self.stream.flush()
        if self._buffer:
            _append_script_output(self._buffer)
            self._buffer = ''


class _ScriptStop(Exception):
    """Raised inside a script thread to abort execution."""
    pass


def _run_script_in_thread(script_path):
    """Execute a script in-process using the backend's real robot instance."""
    global script_mode, _script_name, _script_process, robot, current_positions, current_velocities
    global current_torques, current_fk, _script_stop_event
    import types

    _script_stop_event.clear()
    real_robot = robot  # NEVER patch this — control/broadcast loops use it

    # ── joint limits for position clamping ──────────────────────────
    arm_config = _arm_joint_config()
    if arm_config:
        jl_lower = np.array([jc['min'] for jc in arm_config])
        jl_upper = np.array([jc['max'] for jc in arm_config])
    else:
        jl_lower = np.array([-3.14]*6)
        jl_upper = np.array([3.14]*6)

    def _check_stop():
        if _script_stop_event.is_set():
            raise _ScriptStop("Script stopped by user")

    def _safe_pos():
        raw = real_robot.get_current_pos()
        if hasattr(raw, 'tolist'):
            raw = raw.tolist()
        raw = np.asarray(raw[:len(jl_lower)])
        return np.clip(raw, jl_lower + 1e-6, jl_upper - 1e-6)

    def _push_state():
        """Sync broadcast variables from real robot so frontend sees live position."""
        try:
            pos = real_robot.get_current_pos()
            vel = real_robot.get_current_vel()
            tqe = real_robot.get_current_torque()
            current_positions[:] = pos.tolist() if hasattr(pos, 'tolist') else list(pos)
            current_velocities[:] = vel.tolist() if hasattr(vel, 'tolist') else list(vel)
            current_torques[:] = tqe.tolist() if hasattr(tqe, 'tolist') else list(tqe)
            try:
                fk = real_robot.forward_kinematics(pos)
                if fk:
                    current_fk['position'] = fk['position'].tolist() if hasattr(fk['position'], 'tolist') else list(fk['position'])
                    Rmat = fk['rotation']
                    current_fk['rotation'] = Rmat.tolist() if hasattr(Rmat, 'tolist') else [list(row) for row in Rmat]
                    from scipy.spatial.transform import Rotation
                    rot = Rotation.from_matrix(np.array(Rmat))
                    zyx = rot.as_euler('ZYX', degrees=True)
                    current_fk['euler'] = [zyx[1], zyx[2], zyx[0]]
            except Exception:
                pass
        except Exception:
            pass

    # ── Build a wrapper around the real robot ───────────────────────
    # The wrapper adds: stop-check, position-clamping, auto-push.
    # The real robot object is never modified.

    class _ScriptRobotWrapper:
        def __init__(self):
            pass

        def __getattr__(self, name):
            # Forward everything to the real robot
            attr = getattr(real_robot, name)
            if not callable(attr):
                return attr

            def checked_method(*args, **kwargs):
                _check_stop()
                result = attr(*args, **kwargs)
                _check_stop()
                return result

            return checked_method

        # ── position getters (clamped) ──────────────────────────
        def get_current_pos(self):
            _check_stop()
            return _safe_pos()

        # ── control methods (checked + auto-push) ───────────────
        def Joint_Pos_Vel(self, *a, **kw):
            _check_stop()
            r = real_robot.Joint_Pos_Vel(*a, **kw)
            _push_state()
            _check_stop()
            return r

        def pos_vel_tqe_kp_kd(self, *a, **kw):
            _check_stop()
            r = real_robot.pos_vel_tqe_kp_kd(*a, **kw)
            _push_state()
            _check_stop()
            return r

        def moveJ(self, *a, **kw):
            _check_stop()
            r = real_robot.moveJ(*a, **kw)
            _push_state()
            _check_stop()
            return r

        def Joint_Vel(self, *a, **kw):
            _check_stop()
            r = real_robot.Joint_Vel(*a, **kw)
            _push_state()
            return r

        def moveL(self, *a, **kw):
            _check_stop()
            r = real_robot.moveL(*a, **kw)
            _push_state()
            return r

    wrapper = _ScriptRobotWrapper()

    # Make sure script imports see the current panthera_python/scripts tree.
    scripts_path = os.path.abspath(SCRIPTS_DIR)
    if scripts_path in sys.path:
        sys.path.remove(scripts_path)
    sys.path.insert(0, scripts_path)

    # Import a fresh Panthera module so static helpers match the updated scripts.
    for module_name in list(sys.modules):
        if module_name == 'Panthera_lib' or module_name.startswith('Panthera_lib.'):
            del sys.modules[module_name]
    from Panthera_lib.Panthera import Panthera as RealPantheraClass

    # Inject Panthera→wrapper into Panthera_lib

    class _ScriptPantheraProxy:
        def __new__(cls, *args, **kwargs):
            return wrapper

    panthera_lib = types.ModuleType('Panthera_lib')
    panthera_lib.Panthera = _ScriptPantheraProxy
    panthera_lib.TrajectoryRecorder = None
    sys.modules['Panthera_lib'] = panthera_lib
    sys.modules['Panthera_lib.Panthera'] = types.ModuleType('Panthera_lib.Panthera')
    sys.modules['Panthera_lib.Panthera'].Panthera = _ScriptPantheraProxy

    for attr_name in dir(RealPantheraClass):
        if attr_name.startswith('__'):
            continue
        attr = getattr(RealPantheraClass, attr_name)
        if isinstance(RealPantheraClass.__dict__.get(attr_name), staticmethod):
            setattr(_ScriptPantheraProxy, attr_name, staticmethod(attr))

    try:
        with open(script_path) as f:
            code = compile(f.read(), script_path, 'exec')
        exec_globals = {'__name__': '__main__', '__file__': script_path}
        capture = _ScriptOutputCapture(sys.stdout)
        with contextlib.redirect_stdout(capture), contextlib.redirect_stderr(capture):
            exec(code, exec_globals)
        capture.flush()
    except _ScriptStop:
        print("[ScriptRunner] Script stopped by user")
        _append_script_output("[ScriptRunner] Script stopped by user")
    except Exception as e:
        import traceback
        print(f"[ScriptRunner] Error: {e}")
        _append_script_output(f"[ScriptRunner] Error: {e}")
        traceback.print_exc()
        _append_script_output(traceback.format_exc())
    finally:
        script_mode = False
        _script_name = None
        _script_process = None
        print("[ScriptRunner] Script finished")
        _append_script_output("[ScriptRunner] Script finished")


@app.route('/api/scripts/stop', methods=['POST'])
def stop_script():
    """Stop the currently running script (subprocess or in-process thread)."""
    global _script_process, _script_name, script_mode

    if _script_process is None:
        _script_name = None
        script_mode = False
        return jsonify({'success': True, 'status': 'not_running'})

    # Subprocess
    if isinstance(_script_process, _subprocess.Popen):
        if _script_process.poll() is not None:
            _script_process = None; _script_name = None; script_mode = False
            return jsonify({'success': True, 'status': 'not_running'})
        try:
            _script_process.terminate()
            try: _script_process.wait(timeout=3)
            except Exception: _script_process.kill(); _script_process.wait(timeout=2)
            _script_process = None; _script_name = None; script_mode = False
            return jsonify({'success': True, 'status': 'stopped'})
        except Exception as e:
            return jsonify({'success': False, 'error': str(e)}), 500

    # In-process thread — signal stop via event
    if isinstance(_script_process, threading.Thread):
        if not _script_process.is_alive():
            _script_process = None; _script_name = None; script_mode = False
            return jsonify({'success': True, 'status': 'not_running'})
        _script_stop_event.set()
        # Give the thread a moment to react
        _script_process.join(timeout=3)
        if _script_process is not None and _script_process.is_alive():
            return jsonify({'success': False, 'status': 'stopping', 'error': 'Script did not stop within timeout'}), 202
        script_mode = False
        _script_process = None
        _script_name = None
        return jsonify({'success': True, 'status': 'stopped'})

    return jsonify({'success': False, 'error': 'Unknown process type'}), 500


@app.route('/api/script_state', methods=['POST'])
def script_state_update():
    """Receive joint state from external simulation scripts (PantheraSim)."""
    global script_mode, script_state, current_positions, current_velocities
    global current_torques, current_fk
    try:
        data = request.json
        if 'positions' in data:
            script_state['positions'] = data['positions']
            current_positions[:] = data['positions']
        if 'velocities' in data:
            script_state['velocities'] = data['velocities']
            current_velocities[:] = data['velocities']
        if 'torques' in data:
            script_state['torques'] = data['torques']
            current_torques[:] = data['torques']
        if 'fk' in data and data['fk'] is not None:
            current_fk = data['fk']
            script_state['fk'] = data['fk']
        script_mode = True
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 400


@app.route('/api/set_zero', methods=['POST'])
def set_zero():
    """Reset encoder positions to zero (set current position as zero reference)"""
    global robot, current_positions, target_positions

    if robot is None:
        return jsonify({"success": False, "error": "Robot not connected"}), 400

    try:
        # Call the robot's set_reset_zero method
        robot.set_reset_zero()
        robot.motor_send_cmd()

        # Reset our tracked positions to zero
        with target_lock:
            current_positions[:] = [0.0] * len(current_positions)
            target_positions[:] = [0.0] * len(target_positions)

        print("[Set Zero] Encoder positions reset to zero")

        # Broadcast the update to all clients
        socketio.emit('joint_positions', {
            'positions': [0.0] * len(current_positions),
            'velocities': [0.0] * len(current_positions),
            'torques': [0.0] * len(current_positions)
        })

        return jsonify({"success": True, "message": "Encoder positions reset to zero"})

    except Exception as e:
        print(f"[Set Zero] Error: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/set_velocity', methods=['POST'])
def set_velocity():
    """Set movement velocity"""
    global target_velocity

    with target_lock:
        target_velocity = request.json.get('velocity', 0.5)

    return jsonify({"success": True, "velocity": target_velocity})


@app.route('/api/set_mode', methods=['POST'])
def set_mode():
    """Set control mode: 'position', 'gravity_comp', 'gravity_friction', 'impedance'"""
    data = request.json
    mode = data.get('mode', 'position')

    if mode not in ['position', 'gravity_comp', 'gravity_friction', 'impedance']:
        return jsonify({"success": False, "error": "Invalid mode"}), 400

    with target_lock:
        _set_control_mode(mode)

    print(f"Control mode changed to: {mode}")
    return jsonify({"success": True, "mode": mode})


@app.route('/api/get_mode', methods=['GET'])
def get_mode():
    """Get current control mode and parameters"""
    return jsonify({
        "mode": control_mode,
        "impedance": {
            "K": impedance_K.tolist(),
            "B": impedance_B.tolist(),
            "target": impedance_target.tolist()
        },
        "gravity_comp": {
            "gain": gravity_gain.tolist(),
            "offset": joint_offset.tolist()
        }
    })


@app.route('/api/set_impedance_params', methods=['POST'])
def set_impedance_params():
    """Set impedance control parameters"""
    global impedance_K, impedance_B, impedance_target

    data = request.json

    with target_lock:
        if 'K' in data:
            impedance_K = np.array(data['K'])
        if 'B' in data:
            impedance_B = np.array(data['B'])
        if 'target' in data:
            impedance_target = np.array(data['target'])

    return jsonify({
        "success": True,
        "K": impedance_K.tolist(),
        "B": impedance_B.tolist(),
        "target": impedance_target.tolist()
    })


@app.route('/api/set_impedance_target', methods=['POST'])
def set_impedance_target():
    """Set impedance control target position"""
    global impedance_target

    data = request.json

    with target_lock:
        if 'target' in data:
            impedance_target = np.array(data['target'])
        elif 'joint' in data and 'position' in data:
            # Set single joint target
            joint_index = data['joint']
            impedance_target[joint_index] = data['position']

    return jsonify({"success": True, "target": impedance_target.tolist()})


# ============== Waypoint API Routes ==============

@app.route('/api/waypoints', methods=['GET'])
def get_waypoints():
    """Get all waypoints"""
    return jsonify({
        "success": True,
        "waypoints": waypoints,
        "max_waypoints": MAX_WAYPOINTS,
        "trajectory_running": trajectory_running
    })


@app.route('/api/waypoints/add', methods=['POST'])
def add_waypoint():
    """Add current position as a new waypoint"""
    global waypoints

    if len(waypoints) >= MAX_WAYPOINTS:
        return jsonify({"success": False, "error": f"Maximum {MAX_WAYPOINTS} waypoints allowed"}), 400

    data = request.json

    if 'positions' in data:
        # Use provided positions
        positions = data['positions']
    else:
        # Use current robot positions
        positions = current_positions.copy()

    duration = data.get('duration', 1.0)

    waypoint = {
        'positions': positions,
        'duration': duration,
        'index': len(waypoints)
    }
    waypoints.append(waypoint)

    print(f"Added waypoint {len(waypoints)}: {positions}")
    return jsonify({"success": True, "waypoint": waypoint, "total": len(waypoints)})


@app.route('/api/waypoints/update', methods=['POST'])
def update_waypoint():
    """Update a waypoint"""
    global waypoints

    data = request.json
    index = data.get('index')

    if index is None or index < 0 or index >= len(waypoints):
        return jsonify({"success": False, "error": "Invalid waypoint index"}), 400

    if 'positions' in data:
        waypoints[index]['positions'] = data['positions']
    if 'duration' in data:
        waypoints[index]['duration'] = data['duration']

    return jsonify({"success": True, "waypoint": waypoints[index]})


@app.route('/api/waypoints/delete', methods=['POST'])
def delete_waypoint():
    """Delete a waypoint"""
    global waypoints

    data = request.json
    index = data.get('index')

    if index is None or index < 0 or index >= len(waypoints):
        return jsonify({"success": False, "error": "Invalid waypoint index"}), 400

    deleted = waypoints.pop(index)

    # Update indices
    for i, wp in enumerate(waypoints):
        wp['index'] = i

    return jsonify({"success": True, "deleted": deleted, "total": len(waypoints)})


@app.route('/api/waypoints/clear', methods=['POST'])
def clear_waypoints():
    """Clear all waypoints"""
    global waypoints
    waypoints = []
    return jsonify({"success": True})


@app.route('/api/waypoints/go_to', methods=['POST'])
def go_to_waypoint():
    """Move robot to a specific waypoint"""
    global target_positions

    data = request.json
    index = data.get('index')

    if index is None or index < 0 or index >= len(waypoints):
        return jsonify({"success": False, "error": "Invalid waypoint index"}), 400

    positions = waypoints[index]['positions']

    with target_lock:
        target_positions[:] = positions

    return jsonify({"success": True, "target": positions})


@app.route('/api/trajectory/run', methods=['POST'])
def run_trajectory():
    """Execute trajectory through all waypoints"""
    global trajectory_running

    if trajectory_running:
        return jsonify({"success": False, "error": "Trajectory already running"}), 400

    if len(waypoints) < 2:
        return jsonify({"success": False, "error": "Need at least 2 waypoints"}), 400

    data = request.json
    control_rate = data.get('control_rate', 100)

    waypoint_list, durations = _prepare_trajectory_from_current_pose()

    # Start trajectory in separate thread
    traj_thread = threading.Thread(
        target=execute_trajectory_thread,
        args=(waypoint_list, durations, control_rate),
        daemon=True
    )
    traj_thread.start()

    return jsonify({"success": True, "message": "Trajectory started"})


@app.route('/api/trajectory/stop', methods=['POST'])
def stop_trajectory():
    """Stop running trajectory"""
    global trajectory_running

    trajectory_running = False
    return jsonify({"success": True})


@app.route('/api/trajectory/status', methods=['GET'])
def trajectory_status():
    """Get trajectory execution status"""
    return jsonify({
        "running": trajectory_running,
        "progress": trajectory_progress
    })


# ============== WebSocket Events ==============

@socketio.on('connect')
def handle_connect():
    """Handle new WebSocket connection"""
    connected_clients.add(request.sid)
    print(f"Client connected: {request.sid} (total: {len(connected_clients)})")

    # Send initial config
    emit('config', {
        "robot_name": robot_config['robot']['name'] if robot_config else "Unknown",
        "joints": JOINT_CONFIG,
        "demo_mode": demo_mode,
        "connected": robot is not None or demo_mode,
        "control_mode": control_mode,
        "end_effector_link": robot_config.get('urdf', {}).get('end_effector_link') if robot_config else None,
        "gripper_limits": _gripper_limits_list(),
        "impedance": {
            "K": impedance_K.tolist(),
            "B": impedance_B.tolist(),
            "target": impedance_target.tolist()
        },
        "end_effector_offset": END_EFFECTOR_OFFSET
    })


@socketio.on('disconnect')
def handle_disconnect():
    """Handle WebSocket disconnection"""
    connected_clients.discard(request.sid)
    print(f"Client disconnected: {request.sid} (total: {len(connected_clients)})")


@socketio.on('move_joint')
def handle_move_joint(data):
    """Handle joint movement command via WebSocket"""
    global target_positions

    joint_index = data.get('joint')
    position = data.get('position')

    if joint_index is not None and position is not None:
        joint_index = int(joint_index)
        if _is_gripper_index(joint_index):
            _cancel_reset_profile()
            _set_gripper_target(position)
            return

        arm_config = _arm_joint_config()
        if arm_config and joint_index < len(arm_config):
            jc = arm_config[joint_index]
            position = max(jc['min'], min(jc['max'], position))

        if joint_index < len(target_positions):
            with target_lock:
                _cancel_reset_profile()
                target_positions[joint_index] = position


@socketio.on('move_all')
def handle_move_all(data):
    """Handle all joints movement via WebSocket"""
    global target_positions, target_velocity

    with target_lock:
        gripper_velocity = data.get('velocity', 0.3)
        _cancel_reset_profile()
        if 'positions' in data:
            positions = list(data['positions'])
            target_positions[:] = _clamp_arm_positions(positions)
            gripper_cfg = _gripper_config()
            if gripper_cfg and len(positions) > gripper_cfg["index"]:
                _set_gripper_target(positions[gripper_cfg["index"]], velocity=gripper_velocity)

        if 'gripper' in data:
            _set_gripper_target(data['gripper'], velocity=gripper_velocity)

        if 'velocity' in data:
            target_velocity = data['velocity']


@socketio.on('home')
def handle_home():
    """Handle home command via WebSocket"""
    with target_lock:
        _start_smooth_position_reset()


@socketio.on('reset_all')
def handle_reset_all():
    """Handle smooth reset command via WebSocket"""
    with target_lock:
        _start_smooth_position_reset()


@socketio.on('stop')
def handle_stop():
    """Handle stop command via WebSocket"""
    global target_positions

    with target_lock:
        _cancel_reset_profile()
        target_positions[:] = current_positions.copy()


@socketio.on('set_zero')
def handle_set_zero():
    """Handle set zero command via WebSocket - reset encoder positions to zero"""
    global robot, current_positions, target_positions

    if robot is None:
        emit('set_zero_result', {'success': False, 'error': 'Robot not connected'})
        return

    try:
        # Call the robot's set_reset_zero method
        robot.set_reset_zero()
        robot.motor_send_cmd()

        # Reset our tracked positions to zero
        with target_lock:
            _cancel_reset_profile()
            current_positions[:] = [0.0] * len(current_positions)
            target_positions[:] = [0.0] * len(target_positions)

        print("[Set Zero] Encoder positions reset to zero")

        # Broadcast the update to all clients
        socketio.emit('joint_positions', {
            'positions': [0.0] * len(current_positions),
            'velocities': [0.0] * len(current_positions),
            'torques': [0.0] * len(current_positions)
        })

        emit('set_zero_result', {'success': True, 'message': 'Encoder positions reset to zero'})

    except Exception as e:
        print(f"[Set Zero] Error: {e}")
        emit('set_zero_result', {'success': False, 'error': str(e)})


@socketio.on('set_mode')
def handle_set_mode(data):
    """Handle control mode change via WebSocket"""
    mode = data.get('mode', 'position')

    if mode in ['position', 'gravity_comp', 'gravity_friction', 'impedance']:
        with target_lock:
            _set_control_mode(mode)

        print(f"Control mode changed to: {mode}")

        # Broadcast mode change to all clients
        socketio.emit('mode_changed', {'mode': mode})


@socketio.on('set_impedance_target')
def handle_set_impedance_target(data):
    """Handle impedance target change via WebSocket"""
    global impedance_target

    with target_lock:
        if 'target' in data:
            impedance_target = np.array(data['target'])
        elif 'joint' in data and 'position' in data:
            joint_index = data['joint']
            impedance_target[joint_index] = data['position']


@socketio.on('set_impedance_params')
def handle_set_impedance_params(data):
    """Handle impedance parameter change via WebSocket"""
    global impedance_K, impedance_B

    with target_lock:
        if 'K' in data:
            impedance_K = np.array(data['K'])
        if 'B' in data:
            impedance_B = np.array(data['B'])


@socketio.on('add_waypoint')
def handle_add_waypoint(data):
    """Add waypoint via WebSocket"""
    global waypoints

    if len(waypoints) >= MAX_WAYPOINTS:
        emit('waypoint_error', {'error': f'Maximum {MAX_WAYPOINTS} waypoints allowed'})
        return

    if 'positions' in data:
        positions = data['positions']
    else:
        positions = current_positions.copy()

    duration = data.get('duration', 1.0)

    waypoint = {
        'positions': positions,
        'duration': duration,
        'index': len(waypoints)
    }
    waypoints.append(waypoint)

    # Broadcast to all clients
    socketio.emit('waypoints_updated', {'waypoints': waypoints})


@socketio.on('delete_waypoint')
def handle_delete_waypoint(data):
    """Delete waypoint via WebSocket"""
    global waypoints

    index = data.get('index')
    if index is None or index < 0 or index >= len(waypoints):
        emit('waypoint_error', {'error': 'Invalid waypoint index'})
        return

    waypoints.pop(index)

    # Update indices
    for i, wp in enumerate(waypoints):
        wp['index'] = i

    socketio.emit('waypoints_updated', {'waypoints': waypoints})


@socketio.on('clear_waypoints')
def handle_clear_waypoints():
    """Clear all waypoints via WebSocket"""
    global waypoints
    waypoints = []
    socketio.emit('waypoints_updated', {'waypoints': waypoints})


@socketio.on('update_waypoint_duration')
def handle_update_waypoint_duration(data):
    """Update waypoint duration via WebSocket"""
    global waypoints

    index = data.get('index')
    duration = data.get('duration')

    if index is None or index < 0 or index >= len(waypoints):
        return

    if duration is not None:
        waypoints[index]['duration'] = duration
        socketio.emit('waypoints_updated', {'waypoints': waypoints})


@socketio.on('run_trajectory')
def handle_run_trajectory(data):
    """Run trajectory via WebSocket"""
    global trajectory_running

    if trajectory_running:
        emit('trajectory_error', {'error': 'Trajectory already running'})
        return

    if len(waypoints) < 2:
        emit('trajectory_error', {'error': 'Need at least 2 waypoints'})
        return

    control_rate = data.get('control_rate', 100)

    waypoint_list, durations = _prepare_trajectory_from_current_pose()

    traj_thread = threading.Thread(
        target=execute_trajectory_thread,
        args=(waypoint_list, durations, control_rate),
        daemon=True
    )
    traj_thread.start()


@socketio.on('stop_trajectory')
def handle_stop_trajectory():
    """Stop trajectory via WebSocket"""
    global trajectory_running
    trajectory_running = False


@socketio.on('go_to_waypoint')
def handle_go_to_waypoint(data):
    """Move to waypoint via WebSocket"""
    global target_positions

    index = data.get('index')
    if index is None or index < 0 or index >= len(waypoints):
        return

    positions = waypoints[index]['positions']

    with target_lock:
        target_positions[:] = positions


# ============== Keyboard Control ==============

_key_state = {}
_key_lock = threading.Lock()
_valid_keys = {'w','s','a','d','q','e','i','k','j','l','u','o','z','x'}
_cmd_queue = []
_cmd_queue_lock = threading.Lock()
KEY_STEP = 0.015      # rad per control cycle at 200Hz  (~3 rad/s max)
GRIPPER_STEP = 0.02   # rad per control cycle
_gripper_target = 0.0


@socketio.on('key_down')
def handle_key_down(data):
    key = data.get('key', '').lower()
    if key in _valid_keys:
        with _key_lock:
            _key_state[key] = True


@socketio.on('key_up')
def handle_key_up(data):
    key = data.get('key', '').lower()
    if key in _valid_keys:
        with _key_lock:
            _key_state[key] = False


@socketio.on('command')
def handle_command(data):
    action = data.get('action', '')
    if action in ('home', 'zero_ft', 'print_pose'):
        with _cmd_queue_lock:
            _cmd_queue.append(action)


def _process_keyboard():
    """Apply active keyboard keys to control targets.
    Call from control loop (200 Hz) when in position or impedance mode."""
    global target_positions, impedance_target, _gripper_target, current_positions

    with _key_lock:
        keys = dict(_key_state)

    with _cmd_queue_lock:
        cmds = list(_cmd_queue)
        _cmd_queue.clear()

    for cmd in cmds:
        if cmd == 'home':
            _start_smooth_position_reset()
            impedance_target[:] = [0.0] * 6
            _gripper_target = 0.0
        elif cmd == 'print_pose':
            print(f"[KB] pos={current_positions}  imp_target={impedance_target}")

    if not keys:
        return

    if control_mode == 'position':
        with target_lock:
            t = target_positions
            if keys.get('w'): t[0] += KEY_STEP
            if keys.get('s'): t[0] -= KEY_STEP
            if keys.get('a'): t[1] += KEY_STEP
            if keys.get('d'): t[1] -= KEY_STEP
            if keys.get('q'): t[2] += KEY_STEP
            if keys.get('e'): t[2] -= KEY_STEP
            if keys.get('i'): t[3] += KEY_STEP
            if keys.get('k'): t[3] -= KEY_STEP
            if keys.get('j'): t[4] += KEY_STEP
            if keys.get('l'): t[4] -= KEY_STEP
            if keys.get('u'): t[5] += KEY_STEP
            if keys.get('o'): t[5] -= KEY_STEP
            arm_config = _arm_joint_config()
            if arm_config:
                for i in range(min(len(t), len(arm_config))):
                    t[i] = max(arm_config[i]['min'], min(arm_config[i]['max'], t[i]))

    elif control_mode == 'impedance':
        t = impedance_target
        if keys.get('w'): t[0] += KEY_STEP
        if keys.get('s'): t[0] -= KEY_STEP
        if keys.get('a'): t[1] += KEY_STEP
        if keys.get('d'): t[1] -= KEY_STEP
        if keys.get('q'): t[2] += KEY_STEP
        if keys.get('e'): t[2] -= KEY_STEP
        if keys.get('i'): t[3] += KEY_STEP
        if keys.get('k'): t[3] -= KEY_STEP
        if keys.get('j'): t[4] += KEY_STEP
        if keys.get('l'): t[4] -= KEY_STEP
        if keys.get('u'): t[5] += KEY_STEP
        if keys.get('o'): t[5] -= KEY_STEP
        arm_config = _arm_joint_config()
        if arm_config:
            for i in range(min(len(t), len(arm_config))):
                t[i] = max(arm_config[i]['min'], min(arm_config[i]['max'], t[i]))

    # Gripper keys (work in any mode)
    if keys.get('z') or keys.get('x'):
        if keys.get('z'): _gripper_target += GRIPPER_STEP
        if keys.get('x'): _gripper_target -= GRIPPER_STEP
        # Clamp
        gl = _gripper_config()
        if gl:
            _gripper_target = max(gl['min'], min(gl['max'], _gripper_target))
        if robot is not None and not demo_mode:
            try:
                robot.gripper_control(_gripper_target, 0.3, 0.5)
            except Exception:
                pass


# ============== Main ==============

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Digital Twin Backend Server')
    parser.add_argument('--config', '-c', type=str,
                        default=LOCAL_CONFIG_PATH,
                        help='Path to robot config YAML')
    parser.add_argument('--demo', action='store_true',
                        help='Run in demo mode without robot connection')
    parser.add_argument('--port', '-p', type=int, default=5000,
                        help='Server port (default: 5000)')
    args = parser.parse_args()

    demo_mode = args.demo

    print("=" * 50)
    print("Digital Twin Backend Server")
    print("=" * 50)

    # Load configuration
    config_path = args.config
    if not os.path.isabs(config_path):
        config_path = os.path.join(os.getcwd(), config_path)
    _backend_config_path = config_path

    print(f"\n1. Loading configuration from: {config_path}")
    try:
        load_config(config_path)
    except Exception as e:
        print(f"Failed to load config: {e}")
        print("Using default joint configuration")
        JOINT_CONFIG = [
            {"name": f"Joint {i+1}", "index": i, "min": -3.14, "max": 3.14}
            for i in range(6)
        ]

    # Initialize robot
    print("\n2. Initializing robot...")
    init_robot(config_path)

    # Start control loops
    print("\n3. Starting control loops...")
    start_loops()

    # Start server
    print(f"\n4. Starting server on port {args.port}...")
    print(f"\n   Backend API: http://localhost:{args.port}")
    print(f"   WebSocket:   ws://localhost:{args.port}")
    print("=" * 50)

    socketio.run(app, host='0.0.0.0', port=args.port, debug=False,
                 allow_unsafe_werkzeug=True)
