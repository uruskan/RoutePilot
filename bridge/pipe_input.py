"""Read JSONL pipe bytes without holding a blocked stdin read during DLL loading.

On this Windows host, both TextIO.readline and blocking ReadFile prevented
NumPy's native extension from initializing until stdin received EOF. Polling
PeekNamedPipe and reading only bytes already available avoids that interaction.
"""
from __future__ import annotations

import os


def pipe_lines(stream, stopped, max_line=8192, poll=0.025):
    descriptor = stream.fileno()
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        import msvcrt
        handle = msvcrt.get_osfhandle(descriptor)
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.PeekNamedPipe.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD,
                                         wintypes.LPVOID, ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID]
        kernel.PeekNamedPipe.restype = wintypes.BOOL

        def available_bytes():
            available = wintypes.DWORD()
            if not kernel.PeekNamedPipe(handle, None, 0, None, ctypes.byref(available), None):
                error = ctypes.get_last_error()
                if error in (109, 232):  # ERROR_BROKEN_PIPE / ERROR_NO_DATA
                    return -1
                raise OSError(error, "RoutePilot komut girişi bir boru bağlantısı olmalı.")
            return available.value
    else:
        import select

        def available_bytes():
            return 4096 if select.select([descriptor], [], [], 0)[0] else 0

    pending = bytearray()
    while not stopped.is_set():
        available = available_bytes()
        if available < 0:
            return
        if not available:
            stopped.wait(poll)
            continue
        chunk = os.read(descriptor, min(available, 4096))
        if not chunk:
            return
        pending.extend(chunk)
        while b"\n" in pending:
            line, _, tail = pending.partition(b"\n")
            pending = bytearray(tail)
            if len(line) > max_line:
                raise ValueError("Komut çok uzun; bağlantı kapatıldı.")
            yield bytes(line)
        if len(pending) > max_line:
            raise ValueError("Komut çok uzun; bağlantı kapatıldı.")
    # An incomplete command at EOF/Stop is never executed.
