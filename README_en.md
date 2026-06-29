# Panthera-HT Host

[![en](https://img.shields.io/badge/lang-English-blue.svg)](README_en.md#english)[![中文](https://img.shields.io/badge/lang-简体中文-red.svg)](README.md#中文)

![Panthera-HT Host UI](images/1.png)

This is the host-side project for the Panthera-HT robotic arm. It includes SDK examples for real robot control, a backend service, and a browser frontend. The project is mainly used to:

- Connect to a Panthera-HT real robot and run position, gravity compensation, impedance, and related control modes.
- Display the robot 3D state, joint state, and end-effector state in real time in the browser.
- Run SDK example scripts from `panthera_python/scripts/` directly from the web page.
- Use Demo simulation mode to develop and test the frontend/backend UI without a real robot.

## Quick Launch

### 1. Prepare The Environment

Use Ubuntu 20/22/24, and install Miniconda or Anaconda first.

Then run the following commands from the project root:

```bash
chmod +x install.sh backend.sh frontend.sh
./install.sh
```

The install script first looks for this existing conda environment:

```text
panthera
```

If the environment does not exist, the script creates `panthera` automatically. It then installs the dependencies required by the backend, frontend, and Panthera Python SDK.

### 2. Check The Real Robot Connection

Before starting live mode, confirm that:

- The robot workspace is clear of people and obstacles.
- Power, serial/CAN devices, and hardware connections are ready.
- The correct robot configuration file is being used.

### 3. Start The Backend

Open a new terminal and start the live backend:

```bash
./backend.sh
```

This is equivalent to:

```bash
./backend.sh --live --config ../../panthera_python/robot_param/Follower.yaml --port 5000
```

If no real robot is connected and you only want to learn the UI or debug the frontend/backend, start Demo mode instead:

```bash
./backend.sh --demo
```

### 4. Start The Frontend

Open another terminal:

```bash
./frontend.sh
```

Open this URL in your browser:

```text
http://localhost:3000
```

Once the page is loaded, you can view robot state, control joints, and run example scripts from the browser.

## User Guide

### 1. Open The Page And Check Connection Status

After starting the backend and frontend, open:

```text
http://localhost:3000
```

Check the top or side status information first:

- `Demo Mode` means the system is in simulation mode and will not control real hardware.
- Click `Connect` in the `Robot Connection` floating panel to connect to the robot.
- The 3D robot view updates in real time from backend state.

If the page state does not update, check that the backend terminal has no errors, then refresh the browser page.

### 2. Use The Joints Panel

The `Joints` panel shows and controls the 6 arm joint positions.

Common operations:

- Drag a joint position slider to adjust a joint target.
- Type into the numeric input for more precise adjustment.
- Use the velocity slider or input box to set the velocity used by position commands. The default value is `0.6`.
- Click `Send Position` to send the current joint target positions to the backend.
- Click `Reset` to return all joints to zero. Reset uses a fixed velocity profile and slows down smoothly near zero.

Demo mode is safe for learning the interface. In live mode, always confirm the robot workspace is safe before sending commands.

### 3. Use CONTROL MODE

`CONTROL MODE` in the `Robot Connection` floating panel switches the backend control mode.

Common modes:

- `Position`: position control mode. The `Joints` panel and `Send Position` are mainly used in this mode.
- `Gravity`: gravity compensation mode. The arm becomes backdrivable and can be hand-guided for teaching.
- `Gra+Fri`: gravity + friction compensation mode. It adds friction compensation on top of `Gravity`, changing the hand-guiding feel.
- `Impedance`: impedance control mode. The arm follows a target position with compliance, useful for interaction and force-direction feedback.

Notes:

- When switching from `Gravity`, `Gra+Fri`, or `Impedance` back to `Position`, the backend uses a smooth reset strategy to avoid sudden jumps.
- In `Gravity` and `Gra+Fri`, the gripper is released so it can be moved manually.
- In `Impedance`, the gripper uses a light MIT hold control.

### 4. Observe The Robot In The 3D View

The center of the page shows the robot 3D model:

- The model pose updates in real time according to backend joint state.
- The red dot marks the end-effector position.
- Drag with the left mouse button to rotate the camera, and use the mouse wheel to zoom.

If you update the URDF or model files, restart the backend and refresh the page.

### 5. Use WAYPOINTS For Trajectory Planning

The `Waypoints` section records multiple joint poses and executes them in sequence.

Basic workflow:

1. Move the robot to a target pose in the `Joints` panel, or hand-guide it in gravity compensation mode.
2. Click `+ Add Current` to save the current pose as a waypoint.
3. Move the robot to another pose and add more waypoints.
4. Set the duration for each waypoint as needed.
5. Click `Position` to switch back to position-velocity control. After the robot returns to zero, click `Run Trajectory` to move through the waypoints in order.

The backend applies smooth interpolation during trajectory execution. In live mode, verify that every waypoint is in a safe workspace and that the trajectory will not pass through the table, fixtures, or people.

### 6. Run SDK Example Scripts

The `Scripts` panel reads:

```text
panthera_python/scripts/
```

Workflow:

1. Select a script in `Select Script`.
2. Click the run button to start it.
3. Watch the page state and backend terminal output.
4. If scripts under `panthera_python/scripts/` were updated, click `Refresh` to reload the list.

In live mode, scripts directly control the robot. Before running a script, open it and confirm what it does.

### 7. Recommended Beginner Workflow

For first-time use, follow this order:

1. Run `./install.sh` to install the environment.
2. Run `./backend.sh --demo` to start the Demo backend.
3. Run `./frontend.sh` to start the frontend.
4. Open `http://localhost:3000`.
5. Drag joints in the `Joints` panel and click `Send Position`.
6. Try switching `CONTROL MODE` and understand what each mode does.
7. Add several `WAYPOINTS` and run a simple trajectory in Demo mode.
8. After confirming that the 3D model moves correctly, try running a simple script.
9. After the workflow is familiar, switch to live mode.

## Project Layout

```text
.
├── install.sh                         # One-command environment setup
├── backend.sh                         # Start backend
├── frontend.sh                        # Start frontend
├── Panthera_digital_twin-main/
│   ├── backend/                       # Flask backend
│   ├── frontend/                      # Web frontend
│   ├── robot_param/                   # Robot configs
│   └── Panthera-HT_description/       # URDF and model assets
└── panthera_python/
    ├── scripts/                       # SDK example scripts
    ├── motor_whl/                     # Motor SDK wheel
    └── requirements.txt               # Python dependencies
```

## Commonly Edited Files

- Backend entry: `Panthera_digital_twin-main/backend/app.py`
- Demo simulation: `Panthera_digital_twin-main/backend/panthera_sim.py`
- Frontend entry: `Panthera_digital_twin-main/frontend/src/main.js`
- Frontend UI: `Panthera_digital_twin-main/frontend/src/ui/`
- Example scripts: `panthera_python/scripts/`
- Default live robot config: `panthera_python/robot_param/Follower.yaml`

The web page `Scripts` panel reads one-level `.py` files under `panthera_python/scripts/`.

## Common Commands

```bash
# Install environment
./install.sh

# Start backend: Demo mode
./backend.sh --demo

# Start backend: live mode
./backend.sh

# Start frontend
./frontend.sh

# Specify frontend port
./frontend.sh --port 3001

# Frontend build check
cd Panthera_digital_twin-main/frontend
npm run build

# Remove the conda environment created for this project
conda env remove -n panthera
```

## FAQ

### How Do I Develop Without A Real Robot?

Use Demo mode:

```bash
./backend.sh --demo
```

### The Frontend Page Does Not Open

Confirm that `./frontend.sh` is running, then open:

```text
http://localhost:3000
```

If port 3000 is occupied, use another port:

```bash
./frontend.sh --port 3001
```

### The Backend Cannot Find The Conda Environment

Run:

```bash
./install.sh
```

To reinstall dependencies, run `./install.sh` again.

If `panthera` is dedicated to this project, you can also remove it first:

```bash
conda env remove -n panthera
```

Then run `./install.sh` again.

### Need To Skip System Dependency Installation?

If you only want to install conda, Python, and npm dependencies without changing system packages:

```bash
INSTALL_SYSTEM_DEPS=0 ./install.sh
```

## More Information

For more detailed digital twin documentation, see:

```text
Panthera_digital_twin-main/README.md
```

Live mode and scripts under `panthera_python/scripts/` may directly control real hardware. Always check script behavior and site safety before running them.
