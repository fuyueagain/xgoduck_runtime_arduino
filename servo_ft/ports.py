"""Locate the URT2's serial port the way Device Manager would.

The Feetech URT2 enumerates as a WCH USB-serial bridge, the same chip family that
shows up as `USB-Enhanced-SERIAL CH343 (COM7)`. Bluetooth links also appear as COM
ports but carry no USB vendor id, so they drop out on their own.
"""
from serial.tools import list_ports

WCH_VID = 0x1A86
WCH_FAMILY = ('ch340', 'ch341', 'ch343', 'ch344', 'ch9101', 'ch9102')
URT_HINTS = ('urt', 'feetech')


def all_ports():
    return sorted(list_ports.comports(), key=lambda p: p.device)


def describe(port):
    vid = f'{port.vid:04x}' if port.vid is not None else '----'
    pid = f'{port.pid:04x}' if port.pid is not None else '----'
    return f'{port.device:<8} {port.description or "?":<40} [{vid}:{pid}]'


def _score(port):
    if port.vid is None:
        return -1  # a Bluetooth link or a legacy port; never auto-pick one
    text = ' '.join(str(v).lower() for v in
                    (port.description, port.product, port.manufacturer, port.hwid) if v)
    score = 4 if port.vid == WCH_VID else 1
    if any(chip in text for chip in WCH_FAMILY):
        score += 2
    if any(hint in text for hint in URT_HINTS):
        score += 2
    return score


def candidates():
    """USB serial ports that could be a URT2, best match first."""
    scored = [(_score(p), p) for p in all_ports()]
    scored = [pair for pair in scored if pair[0] > 0]
    scored.sort(key=lambda pair: (-pair[0], pair[1].device))
    return [port for _, port in scored]


def auto():
    """The port to attach without asking: the best candidate, or None.

    Several adapters still yield a port — the page can switch — so this never
    refuses just because the choice is wide. It only returns None when nothing
    looks like a USB serial adapter at all.
    """
    found = candidates()
    return found[0] if found else None
