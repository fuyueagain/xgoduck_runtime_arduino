def validate_servo_id(value):
    value = int(value)
    if not 1 <= value <= 253:
        raise ValueError('invalid servo id')
    return value


def validate_scan_result(ids):
    ids = [validate_servo_id(value) for value in ids]
    if not ids:
        raise ValueError('no servo responded during scan')
    if len(ids) != 1:
        raise ValueError('scan found multiple responding addresses; write is blocked')
    return ids[0]


def position_reached(actual, target, tolerance=3):
    return abs(int(actual) - int(target)) <= int(tolerance)
