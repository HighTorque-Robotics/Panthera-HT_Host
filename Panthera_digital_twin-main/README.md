# Panthera Digital Twin

This directory contains the digital twin implementation for Panthera-HT:

- `backend/`: Flask backend, WebSocket state broadcast, robot control loop, waypoint and script APIs.
- `frontend/`: Vite/Three.js web UI, 3D model viewer, control panels, waypoints, and script runner.
- `robot_param/`: robot configuration files used by the backend.
- `Panthera-HT_description/`: URDF and mesh assets used by the frontend.

For installation, startup, and user-facing usage instructions, use the root README files:

- [中文说明](../README.md)
- [English README](../README_en.md)

Keeping the full guide at the repository root avoids two README files drifting out of sync.
