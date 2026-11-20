"""Exercise the actual command handlers without importing hardware dependencies."""
import ast
import math
from pathlib import Path
from threading import Lock
from types import SimpleNamespace
import unittest


class JointPositionCommandTest(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).resolve().parents[1] / 'app.py'
        tree = ast.parse(source.read_text(encoding='utf-8'))
        compile(tree, str(source), 'exec')
        names = {'_clamp_arm_positions', '_merge_arm_joint_positions', 'handle_move_all', 'move_all'}
        functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
        for node in functions:
            node.decorator_list = []
        self.gripper_commands = []
        self.scope = {
            'target_positions': [0.0, 0.7, 1.2, 0.0, 0.0, 0.0],
            'current_positions': [0.0, 0.7, 1.3, 0.0, 0.0, 0.0],
            'target_velocity': 0.6,
            'target_lock': Lock(),
            'np': SimpleNamespace(isfinite=math.isfinite),
            '_arm_joint_config': lambda: [{'min': -2.0, 'max': 2.0}] * 6,
            '_gripper_config': lambda: {'index': 6},
            '_cancel_reset_profile': lambda: None,
            '_set_gripper_target': lambda pos, velocity: self.gripper_commands.append((pos, velocity)),
            'jsonify': lambda result: result,
        }
        exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), 'exec'), self.scope)

    def send(self, handler, data):
        if handler == 'move_all':
            self.scope['request'] = SimpleNamespace(json=data)
            return self.scope[handler]()
        return self.scope[handler](data)

    def test_untouched_j3_target_survives_repeated_other_joint_commands(self):
        for handler in ('handle_move_all', 'move_all'):
            with self.subTest(handler=handler):
                self.scope['target_positions'] = [0.0, 0.7, 1.2, 0.0, 0.0, 0.0]
                self.send(handler, {'joint_positions': {'0': 0.4}, 'velocity': 0.5})
                self.send(handler, {'joint_positions': {'1': 0.8}, 'velocity': 0.7})
                self.assertEqual(self.scope['target_positions'], [0.4, 0.8, 1.2, 0.0, 0.0, 0.0])
                self.assertEqual(self.scope['target_velocity'], 0.7)
                self.send(handler, {'joint_positions': {'2': 1.1, '4': -3.0}})
                self.assertEqual(self.scope['target_positions'], [0.4, 0.8, 1.1, 0.0, -2.0, 0.0])

    def test_gripper_only_and_legacy_full_commands(self):
        for handler in ('handle_move_all', 'move_all'):
            with self.subTest(handler=handler):
                before = self.scope['target_positions'].copy()
                self.send(handler, {'joint_positions': {}, 'gripper': 0.5, 'velocity': 0.4})
                self.assertEqual(self.scope['target_positions'], before)
                self.assertEqual(self.gripper_commands[-1], (0.5, 0.4))
                self.send(handler, {'positions': [0.1] * 6})
                self.assertEqual(self.scope['target_positions'], [0.1] * 6)

    def test_invalid_edit_does_not_partially_update_targets(self):
        for updates in ({'0': 0.5, '6': 0.1}, {'2': float('nan')}, {'-1': 0.5}):
            before = self.scope['target_positions'].copy()
            with self.assertRaises(ValueError):
                self.send('handle_move_all', {'joint_positions': updates})
            self.assertEqual(self.scope['target_positions'], before)


if __name__ == '__main__':
    unittest.main()
