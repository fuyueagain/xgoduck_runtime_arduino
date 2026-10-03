import unittest

from servo_setup import position_reached, validate_scan_result, validate_servo_id
from wire import SERVO_READ_GAINS, decode_servo_reply, encode_servo


class ServoSetupRulesTest(unittest.TestCase):
    def test_scan_requires_exactly_one_responding_address(self):
        self.assertEqual(validate_scan_result([37]), 37)
        with self.assertRaises(ValueError):
            validate_scan_result([])
        with self.assertRaises(ValueError):
            validate_scan_result([37, 42])

    def test_scan_address_is_a_valid_unicast_id(self):
        self.assertEqual(validate_servo_id(253), 253)
        with self.assertRaises(ValueError):
            validate_servo_id(0)
        with self.assertRaises(ValueError):
            validate_servo_id(254)

    def test_position_verification_requires_feedback_within_tolerance(self):
        self.assertTrue(position_reached(2047, 2047, tolerance=3))
        self.assertTrue(position_reached(2044, 2047, tolerance=3))
        self.assertFalse(position_reached(2039, 2047, tolerance=3))

    def test_gain_readback_uses_the_existing_reply_abi(self):
        payload = encode_servo(SERVO_READ_GAINS, 37)
        self.assertEqual(len(payload), 12)
        reply = decode_servo_reply(
            bytes([68, 81, 83, 50]) + bytes([SERVO_READ_GAINS, 37, 1, 0]) +
            (0x0713).to_bytes(2, 'little') + (0).to_bytes(2, 'little')
        )
        self.assertEqual(reply['kp'], 0x07)
        self.assertEqual(reply['kd'], 0x13)


if __name__ == '__main__':
    unittest.main()
