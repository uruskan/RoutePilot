import os
import threading
import unittest

from bridge.pipe_input import pipe_lines


class PipeTests(unittest.TestCase):
    def start_reader(self, max_line=8192):
        descriptor, self.writer = os.pipe()
        self.stream = os.fdopen(descriptor, "rb", buffering=0)
        self.stopped = threading.Event()
        self.lines = []
        self.errors = []
        self.got_line = threading.Event()
        def read():
            try:
                for line in pipe_lines(self.stream, self.stopped, max_line=max_line, poll=0.005):
                    self.lines.append(line)
                    self.got_line.set()
            except Exception as exc:
                self.errors.append(exc)
        self.reader = threading.Thread(target=read, daemon=True)
        self.reader.start()
        self.addCleanup(self.cleanup)

    def cleanup(self):
        self.stopped.set()
        if self.writer is not None:
            os.close(self.writer)
            self.writer = None
        self.reader.join(1)
        self.stream.close()

    def test_fragmented_utf8_and_multiple_commands_remain_whole(self):
        self.start_reader()
        payload = '{"id":"Türkçe","action":"stop"}\n{"id":2,"action":"save"}\n'.encode("utf-8")
        for byte in payload:
            os.write(self.writer, bytes([byte]))
        os.close(self.writer)
        self.writer = None
        self.reader.join(1)
        self.assertEqual([line.decode("utf-8") for line in self.lines], payload.decode("utf-8").splitlines())
        self.assertEqual(self.errors, [])

    def test_stop_unblocks_idle_pipe_without_eof_or_input(self):
        self.start_reader()
        self.stopped.set()
        self.reader.join(0.3)
        self.assertFalse(self.reader.is_alive())
        self.assertEqual(self.lines, [])

    def test_incomplete_command_at_disconnect_never_executes(self):
        self.start_reader()
        os.write(self.writer, b'{"id":"one","action":"start"}')
        os.close(self.writer)
        self.writer = None
        self.reader.join(1)
        self.assertFalse(self.reader.is_alive())
        self.assertEqual(self.lines, [])

    def test_oversized_command_is_bounded(self):
        self.start_reader(max_line=32)
        os.write(self.writer, b"x" * 33)
        self.reader.join(1)
        self.assertFalse(self.reader.is_alive())
        self.assertEqual(self.lines, [])
        self.assertIsInstance(self.errors[0], ValueError)
