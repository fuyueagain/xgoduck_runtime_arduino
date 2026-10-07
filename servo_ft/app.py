"""Standalone servo-setup host for a Feetech URT2 (no UNO Q required).

Serves the same `/api/servo*` surface as `python/main.py`, so the browser wizard
in `assets/servoFT.html` runs unmodified. The difference is the backend: instead
of `Bridge` -> STM32 -> `Serial1`, this talks to the SCS bus over a USB adapter.

Nothing is opened until the page asks. The host starts with no port attached and
`POST /api/connect` attaches one, so an idle host never grabs a COM port.

Run:  python servo_ft/app.py
Then: http://127.0.0.1:9530/servoFT.html
"""
import argparse
import json
import sys
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / 'python'))

from servo_setup import position_reached, validate_servo_id  # noqa: E402  (same repo, same rules)

import ports  # noqa: E402

from scs import BAUD, SCAN_FIRST, SCAN_LAST, ScsBus  # noqa: E402

ASSETS = REPO / 'assets'
BAUD_MIN, BAUD_MAX = 1200, 4000000
SETTLE_AFTER_ID_S = 0.05
# The Uno Q closes a session after 2 s so a closed page drops torque. On the bench
# there is no motion to stop, and a backgrounded tab throttles its timers to about
# once a minute, so this is deliberately generous. servoFT.js also re-enters on
# demand when a request arrives after the session lapsed.
HEARTBEAT_TIMEOUT_S = 30.0


class FtController:
    """Serial side of the wizard.

    No port is attached until connect(). State and I/O use separate locks so a
    long scan never blocks the heartbeat that keeps the session alive.
    """

    def __init__(self, baud=BAUD, scan_first=SCAN_FIRST, scan_last=SCAN_LAST, timeout=0.05):
        self.bus = None
        self.baud = baud
        self.timeout = timeout
        self.scan_first = scan_first
        self.scan_last = scan_last
        self.serial_lock = threading.RLock()
        self.state_lock = threading.Lock()
        self.cancel = threading.Event()
        self.active = False
        self.last_beat = 0.0
        self.started = time.monotonic()

    # --- connection --------------------------------------------------------
    def port_name(self):
        return self.bus.port if self.bus else None

    def available_ports(self):
        found = ports.candidates()
        return {'ports': [{'device': p.device, 'description': p.description or '',
                           'label': ports.describe(p)} for p in found],
                'connected': self.bus is not None,
                'current': self.port_name()}

    def connect(self, port_name, baud=None):
        """Attach a port and open a session. Connecting again swaps the port."""
        if not port_name:
            raise ValueError('no port given')
        baud = self.baud if baud is None else _baud(baud)
        with self.serial_lock:
            self._close_locked()
            self.bus = ScsBus(port_name, baud, self.timeout)
            self.baud = baud
        self.enter_session()
        return {'connected': True, 'port': port_name, 'baud': baud,
                'probe_id': self.probe()}

    def enter_session(self):
        """Open a session on the attached port. Also re-opens one that lapsed."""
        if self.bus is None:
            raise ValueError('no port connected')
        with self.state_lock:
            self.active = True
            self.cancel.clear()
            self.last_beat = time.monotonic()
        return {'mode': 'servo_debug'}

    def _close_locked(self):
        if self.bus is not None:
            self.bus.close()
            self.bus = None

    def disconnect(self):
        with self.serial_lock:
            self._close_locked()
        with self.state_lock:
            self.active = False
        self.cancel.set()
        return {'connected': False}

    def probe(self):
        """First ID that answers — confirms wiring and baud for a fresh port."""
        try:
            with self.serial_lock:
                for sid in range(self.scan_first, self.scan_last + 1):
                    if self.bus is None:
                        return None
                    if self.bus.present_position(sid) is not None:
                        return sid
        except Exception:
            return None
        return None

    def set_baud(self, baud):
        baud = _baud(baud)
        with self.serial_lock:
            self.baud = baud
            if self.bus is not None:
                self.bus.set_baud(baud)
        return {'port': self.port_name(), 'baud': baud}

    # --- session -----------------------------------------------------------
    def _refresh_locked(self):
        if self.active and time.monotonic() - self.last_beat > HEARTBEAT_TIMEOUT_S:
            self.active = False
            self.cancel.set()

    def _touch(self):
        """Reject work without a port or outside a live session."""
        if self.bus is None:
            raise ValueError('no port connected')
        with self.state_lock:
            self._refresh_locked()
            if not self.active:
                raise ValueError('servo setup session is not active')
            self.last_beat = time.monotonic()

    def exit_session(self):
        with self.state_lock:
            was_active = self.active
            self.active = False
        self.cancel.set()
        return {'exit_state': 'confirmed' if was_active else 'already_closed'}

    def heartbeat(self):
        self._touch()
        return {'mode': 'servo_debug', 'active': True}

    def status(self):
        with self.state_lock:
            self._refresh_locked()
            mode = 'servo_debug' if self.active else 'off'
            active = self.active
        return {'mode': mode, 'active': active, 'connected': self.bus is not None,
                'port': self.port_name(), 'baud': self.baud,
                'scan_first': self.scan_first, 'scan_last': self.scan_last,
                'uptime_s': round(time.monotonic() - self.started, 1)}

    # --- bus operations ----------------------------------------------------
    def scan(self):
        self._touch()
        self.cancel.clear()
        found = []
        with self.serial_lock:
            for sid in range(self.scan_first, self.scan_last + 1):
                if self.cancel.is_set():
                    return {'ids': found, 'count': len(found), 'cancelled': True,
                            'single_id': None}
                if self.bus.present_position(sid) is not None:
                    found.append(sid)
        return {'ids': found, 'count': len(found), 'cancelled': False,
                'single_id': found[0] if len(found) == 1 else None}

    def read(self, target_id):
        target_id = validate_servo_id(target_id)
        self._touch()
        with self.serial_lock:
            raw_pos = self.bus.present_position(target_id)
        if raw_pos is None:
            raise ValueError(f'no reply from ID {target_id}')
        return {'op': 'read', 'target_id': target_id, 'ok': True, 'raw_pos': raw_pos,
                'zero_pos': 0, 'kp': 0, 'kd': 0}

    def goto(self, target_id, raw_pos):
        target_id = validate_servo_id(target_id)
        raw_pos = _raw(raw_pos)
        self._touch()
        with self.serial_lock:
            self.bus.goto(target_id, raw_pos)
        return {'op': 'goto', 'target_id': target_id, 'ok': True, 'raw_pos': raw_pos,
                'zero_pos': 0, 'kp': 0, 'kd': 0}

    def verify_position(self, target_id, raw_pos, tolerance=3, timeout=1.5):
        target_id = validate_servo_id(target_id)
        raw_pos = _raw(raw_pos)
        tolerance = int(tolerance)
        self.goto(target_id, raw_pos)
        deadline = time.monotonic() + float(timeout)
        while time.monotonic() < deadline:
            with self.serial_lock:
                last = self.bus.present_position(target_id, timeout=0.25)
            if last is not None and position_reached(last, raw_pos, tolerance):
                return {'op': 'goto', 'target_id': target_id, 'ok': True, 'raw_pos': last,
                        'verified': True, 'target_raw_pos': raw_pos, 'zero_pos': 0,
                        'kp': 0, 'kd': 0}
            time.sleep(0.05)
        raise ValueError('position feedback did not reach requested target')

    def set_id(self, target_id, new_id):
        target_id = validate_servo_id(target_id)
        new_id = validate_servo_id(new_id)
        self._touch()
        with self.serial_lock:
            self.bus.set_id(target_id, new_id)
            time.sleep(SETTLE_AFTER_ID_S)
        return {'op': 'set_id', 'target_id': new_id, 'ok': True, 'raw_pos': 0,
                'zero_pos': 0, 'kp': 0, 'kd': 0}

    def unlock(self, target_id):
        target_id = validate_servo_id(target_id)
        self._touch()
        with self.serial_lock:
            self.bus.unlock(target_id)
        return {'op': 'unlock', 'target_id': target_id, 'ok': True, 'raw_pos': 0,
                'zero_pos': 0, 'kp': 0, 'kd': 0}

    def set_gains(self, target_id, kp, kd):
        target_id = validate_servo_id(target_id)
        kp, kd = _gain(kp), _gain(kd)
        self._touch()
        with self.serial_lock:
            self.bus.set_gains(target_id, kp, kd)
        return {'op': 'set_gains', 'target_id': target_id, 'ok': True, 'kp': kp, 'kd': kd,
                'raw_pos': 0, 'zero_pos': 0}

    def verify_gains(self, target_id, kp, kd):
        target_id = validate_servo_id(target_id)
        kp, kd = _gain(kp), _gain(kd)
        self._touch()
        with self.serial_lock:
            gains = self.bus.stored_gains(target_id)
        if gains is None:
            raise ValueError(f'no reply from ID {target_id}')
        got_kp, got_kd = gains
        reply = {'op': 'read_gains', 'target_id': target_id, 'ok': True, 'kp': got_kp,
                 'kd': got_kd, 'raw_pos': 0, 'zero_pos': 0,
                 'verified': got_kp == kp and got_kd == kd}
        if not reply['verified']:
            raise ValueError('stored KP/KD did not match requested values')
        return reply

    def read_gains(self, target_id):
        target_id = validate_servo_id(target_id)
        self._touch()
        with self.serial_lock:
            gains = self.bus.stored_gains(target_id)
        if gains is None:
            raise ValueError(f'no reply from ID {target_id}')
        return {'op': 'read_gains', 'target_id': target_id, 'ok': True,
                'kp': gains[0], 'kd': gains[1], 'raw_pos': 0, 'zero_pos': 0}

    def action(self, body):
        name = body['action']
        if name == 'scan_cancel':
            self.cancel.set()
            return {'cancel_requested': True}
        if name == 'scan':
            return self.scan()
        if name == 'goto_verify':
            return self.verify_position(body['target_id'], body.get('raw_pos', 2047),
                                        body.get('tolerance', 3), body.get('timeout', 1.5))
        if name == 'gains_verify':
            return self.verify_gains(body['target_id'], body['kp'], body['kd'])
        if name == 'read':
            return self.read(body['target_id'])
        if name == 'read_gains':
            return self.read_gains(body['target_id'])
        if name == 'goto':
            return self.goto(body['target_id'], body.get('raw_pos', 2047))
        if name == 'set_id':
            return self.set_id(body['target_id'], body['new_id'])
        if name == 'set_gains':
            return self.set_gains(body['target_id'], body.get('kp', 5), body.get('kd', 20))
        if name == 'unlock':
            return self.unlock(body['target_id'])
        raise ValueError(f'unknown servo action: {name}')


def _raw(value):
    value = int(value)
    if not 0 <= value <= 4095:
        raise ValueError('raw position out of range')
    return value


def _gain(value):
    value = int(value)
    if not 0 <= value <= 255:
        raise ValueError('kp/kd out of range')
    return value


def _baud(value):
    value = int(value)
    if not BAUD_MIN <= value <= BAUD_MAX:
        raise ValueError('baud out of range')
    return value


class Handler(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    controller = None

    def log_message(self, fmt, *args):
        sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))

    # --- helpers -----------------------------------------------------------
    def end_headers(self):
        # A local tool is edited between runs; never let the browser sit on a stale page.
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def _json(self, code, payload):
        body = json.dumps(payload).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get('Content-Length') or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length) or b'{}')
        except json.JSONDecodeError:
            raise ValueError('malformed JSON body')

    # --- routes ------------------------------------------------------------
    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path == '/api/status':
            return self._json(200, self.controller.status())
        if path == '/api/ports':
            return self._json(200, self.controller.available_ports())
        if path in ('/', '/index.html'):
            self.send_response(302)
            self.send_header('Location', '/servoFT.html')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        return super().do_GET()

    def do_POST(self):
        path = self.path.split('?', 1)[0]
        try:
            body = self._body()
            if path == '/api/connect':
                return self._json(200, self.controller.connect(body.get('port'),
                                                               body.get('baud')))
            if path == '/api/disconnect':
                return self._json(200, self.controller.disconnect())
            if path == '/api/baud':
                return self._json(200, self.controller.set_baud(body['baud']))
            if path == '/api/servo/enter':
                return self._json(200, self.controller.enter_session())
            if path == '/api/servo/exit':
                return self._json(200, self.controller.exit_session())
            if path == '/api/servo/heartbeat':
                return self._json(200, self.controller.heartbeat())
            if path == '/api/servo':
                return self._json(200, self.controller.action(body))
            return self._json(404, {'detail': 'not found'})
        except (KeyError, TypeError, ValueError) as exc:
            return self._json(400, {'detail': str(exc)})
        except Exception as exc:  # serial errors and the like
            return self._json(500, {'detail': f'{type(exc).__name__}: {exc}'})


def _print_ports():
    found = ports.all_ports()
    print('Serial ports:')
    for port in found:
        print('  ' + ports.describe(port))
    if not found:
        print('  (none)')


def main():
    ap = argparse.ArgumentParser(description='Servo setup host for a Feetech URT2.')
    ap.add_argument('--port', help='attach this port at startup; default: wait for the page')
    ap.add_argument('--baud', type=int, default=BAUD, help='default 1000000')
    ap.add_argument('--timeout', type=float, default=0.05, help='per-servo reply timeout (s)')
    ap.add_argument('--first', type=int, default=SCAN_FIRST, help='lowest ID to scan')
    ap.add_argument('--last', type=int, default=SCAN_LAST, help='highest ID to scan')
    ap.add_argument('--http-port', type=int, default=9530)
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--list', action='store_true', help='list serial ports and exit')
    args = ap.parse_args()

    if args.list:
        _print_ports()
        return

    controller = FtController(baud=args.baud, scan_first=args.first,
                              scan_last=args.last, timeout=args.timeout)
    if args.port:
        try:
            info = controller.connect(args.port)
        except Exception as exc:
            print(f'Could not open {args.port}: {type(exc).__name__}: {exc}')
            raise SystemExit(1)
        print(f'Attached {args.port} at {info["baud"]} baud, '
              + (f'servo ID {info["probe_id"]} answered.' if info['probe_id']
                 else 'no servo answered.'))
    else:
        print('No port attached. Pick one in the page and press 开始连接.')

    Handler.controller = controller
    server = ThreadingHTTPServer((args.host, args.http_port),
                                 partial(Handler, directory=str(ASSETS)))
    print(f'Open http://{args.host}:{args.http_port}/servoFT.html')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        controller.disconnect()


if __name__ == '__main__':
    main()
