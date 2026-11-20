import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Load command logic without initializing a renderer or a network connection.
async function loadClass(path) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    return import(`data:text/javascript;base64,${Buffer.from(source.replace(/^import .*;?\r?\n/gm, '')).toString('base64')}`);
}

const { JointControlsUI } = await loadClass('../src/ui/JointControlsUI.js');
const { RobotConnection } = await loadClass('../src/robot/RobotConnection.js');

test('Send Position sends edits only despite feedback drift, including repeated sends', () => {
    const sent = [];
    const connection = new RobotConnection();
    connection.connected = true;
    connection.socket = { emit: (event, data) => sent.push({ event, data }) };
    const ui = new JointControlsUI({ currentModel: {}, redraw() {}, render() {} });
    ui.robotConnection = connection;
    ui.isConnectedMode = true;
    ui.applyJointToModel = () => {};
    const names = ['joint1', 'joint2', 'joint3', 'joint4', 'joint5', 'joint6', 'gripper'];
    const sliders = names.map((name, index) => ({
        value: '0',
        getAttribute: key => key === 'data-joint-index' ? String(index) : name,
        closest: () => null,
    }));
    const originalDocument = globalThis.document;
    globalThis.document = { querySelectorAll: () => sliders };
    try {
        ui.pendingJointValues.set(0, 0.4);
        ui.updateFromRobotState({ positions: [0, 0.7, 1.23, 0, 0, 0], gripper_position: 0.2 });
        assert.equal(sliders[2].value, 1.23);
        ui.sendPendingJointPositions();
        assert.deepEqual(sent.at(-1), {
            event: 'move_all', data: { joint_positions: { 0: 0.4 }, velocity: 0.6 },
        });
        assert.equal(ui.pendingJointValues.size, 0);

        ui.pendingJointValues.set(1, 0.8);
        ui.updateFromRobotState({ positions: [0.4, 0.7, 1.27, 0, 0, 0], gripper_position: 0.3 });
        ui.sendPendingJointPositions();
        assert.deepEqual(sent.at(-1).data.joint_positions, { 1: 0.8 });

        ui.pendingJointValues.set(2, 1.1);
        ui.pendingJointValues.set(4, -0.2);
        ui.pendingJointValues.set(6, 0.9);
        ui.sendPendingJointPositions();
        assert.deepEqual(sent.at(-1).data, {
            joint_positions: { 2: 1.1, 4: -0.2 }, velocity: 0.6, gripper: 0.9,
        });

        ui.pendingJointValues.set(6, 0.5);
        ui.sendPendingJointPositions();
        assert.deepEqual(sent.at(-1).data, { joint_positions: {}, velocity: 0.6, gripper: 0.5 });
        ui.sendPendingJointPositions();
        assert.equal(sent.length, 4);
    } finally {
        globalThis.document = originalDocument;
    }
});
