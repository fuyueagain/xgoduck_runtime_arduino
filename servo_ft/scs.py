"""Feetech SCS bus over a USB adapter (URT2).

Ported from `sketch/scs_bus.h` and `sketch/duck_config.h` so the exact register
sequence the UNO Q firmware uses can be driven from a PC. Packet framing and the
register map are the same; only the transport changes (`Serial1` -> a USB port).
"""
import time

import serial

# duck_config.h
BAUD = 1000000
POS_MIN = 0
POS_MAX = 4095
CAL_CENTER_POS = 2047

# Project IDs run 10..34 (MOTOR_IDS in duck_config.h), so 35 is the highest that can matter.
SCAN_FIRST = 1
SCAN_LAST = 35

ADDR_ID = 0x05
ADDR_PERM_KP_KD = 0x15
ADDR_GOAL_POS = 0x2A
ADDR_UNLOCK = 0x37
ADDR_PRESENT = 0x38
PRESENT_LEN = 6

INST_READ = 0x02
INST_WRITE = 0x03

BROADCAST_ID = 0xFE


def build(sid, inst, params):
    """0xFF 0xFF ID LEN INST PARAMS... CHECKSUM, CHECKSUM = ~(ID+LEN+INST+sum(params))."""
    body = bytes([sid & 0xFF, (len(params) + 2) & 0xFF, inst & 0xFF]) + bytes(params)
    return b'\xff\xff' + body + bytes([(~(sum(body) & 0xFF)) & 0xFF])


class ScsBus:
    """Half-duplex SCS bus. One instance owns one serial port; callers serialise."""

    def __init__(self, port, baud=BAUD, timeout=0.05):
        self.port = port
        self.baud = baud
        self.timeout = timeout
        self.ser = serial.Serial(port, baudrate=baud, bytesize=8, parity='N',
                                 stopbits=1, timeout=0.0, write_timeout=0.2)

    def close(self):
        try:
            self.ser.close()
        except Exception:
            pass

    def set_baud(self, baud):
        """Reconfigure the open port. Callers must keep the bus idle."""
        self.baud = int(baud)
        self.ser.baudrate = self.baud
        self.ser.reset_input_buffer()
        return self.baud

    # --- framing -----------------------------------------------------------
    def _byte(self, deadline):
        while time.monotonic() < deadline:
            data = self.ser.read(1)
            if data:
                return data[0]
        return None

    def _reply(self, deadline):
        """Read one status packet. Returns (id, error, params) or None on timeout."""
        prev = None
        while True:
            b = self._byte(deadline)
            if b is None:
                return None
            if prev == 0xFF and b == 0xFF:
                break
            prev = b
        sid = self._byte(deadline)
        length = self._byte(deadline)
        if sid is None or length is None or length < 2:
            return None
        body = bytearray()
        for _ in range(length):
            b = self._byte(deadline)
            if b is None:
                return None
            body.append(b)
        if (~((sid + length + sum(body[:-1])) & 0xFF)) & 0xFF != body[-1]:
            return None
        return sid, body[0], bytes(body[1:-1])

    def _exchange(self, sid, inst, params, timeout):
        frame = build(sid, inst, params)
        self.ser.reset_input_buffer()
        self.ser.write(frame)
        self.ser.flush()
        return self._reply(time.monotonic() + timeout)

    # --- operations --------------------------------------------------------
    def read(self, sid, addr, length, timeout=None):
        """READ a register block. None means no servo answered at this address."""
        reply = self._exchange(sid, INST_READ, [addr, length],
                               self.timeout if timeout is None else timeout)
        if reply is None:
            return None
        rsid, err, params = reply
        if rsid != sid or err != 0 or len(params) != length:
            return None
        return params

    def write(self, sid, addr, data, timeout=None):
        """WRITE a register block. Returns the status error byte, or None if unacknowledged."""
        reply = self._exchange(sid, INST_WRITE, [addr] + list(data),
                               self.timeout if timeout is None else timeout)
        if reply is None:
            return None
        _, err, _ = reply
        return err

    def present_position(self, sid, timeout=None):
        """Encoder reading 0..4095, or None if the servo did not answer."""
        params = self.read(sid, ADDR_PRESENT, PRESENT_LEN, timeout)
        if params is None:
            return None
        return params[0] | (params[1] << 8)

    def stored_gains(self, sid, timeout=None):
        """(KP, KD) stored at 0x15, or None."""
        params = self.read(sid, ADDR_PERM_KP_KD, 2, timeout)
        if params is None:
            return None
        return params[0], params[1]

    def unlock(self, sid, timeout=None):
        return self.write(sid, ADDR_UNLOCK, [0], timeout)

    def set_id(self, sid, new_id, timeout=None):
        """Unlock 0x37 then write 0x05, exactly as scs_bus.h does."""
        self.unlock(sid, timeout)
        return self.write(sid, ADDR_ID, [new_id & 0xFF], timeout)

    def set_gains(self, sid, kp, kd, timeout=None):
        return self.write(sid, ADDR_PERM_KP_KD, [kp & 0xFF, kd & 0xFF], timeout)

    def goto(self, sid, raw_pos, timeout=None):
        """Goal position plus zeroed time/speed, matching writeSingleGoalRaw()."""
        raw_pos = max(POS_MIN, min(POS_MAX, int(raw_pos)))
        return self.write(sid, ADDR_GOAL_POS,
                          [raw_pos & 0xFF, (raw_pos >> 8) & 0xFF, 0, 0, 0, 0], timeout)


def _main():
    import argparse
    ap = argparse.ArgumentParser(description='Scan an SCS bus for responding IDs.')
    ap.add_argument('--port', required=True)
    ap.add_argument('--baud', type=int, default=BAUD)
    ap.add_argument('--timeout', type=float, default=0.05)
    ap.add_argument('--first', type=int, default=SCAN_FIRST)
    ap.add_argument('--last', type=int, default=SCAN_LAST)
    args = ap.parse_args()
    bus = ScsBus(args.port, args.baud, args.timeout)
    try:
        found = []
        for sid in range(args.first, args.last + 1):
            pos = bus.present_position(sid)
            if pos is not None:
                found.append(sid)
                print(f'ID {sid}: raw_pos={pos}')
        print(f'found {len(found)} address(es): {found}')
    finally:
        bus.close()


if __name__ == '__main__':
    _main()
