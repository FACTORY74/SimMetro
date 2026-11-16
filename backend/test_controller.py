import unittest

from backend.controller import CommandQueue


class CommandQueueTests(unittest.TestCase):
    def test_commands_are_sequenced_and_results_are_returned(self):
        commands = CommandQueue()
        observed = []
        first, a = commands.execute("first", lambda: observed.append("first") or 10)
        second, b = commands.execute("second", lambda: observed.append("second") or 20)
        self.assertEqual((first, second), (10, 20))
        self.assertEqual(observed, ["first", "second"])
        self.assertEqual((a.sequence, b.sequence, commands.last_sequence, commands.pending), (1, 2, 2, 0))

    def test_failed_commands_consume_a_sequence_and_leave_queue_usable(self):
        commands = CommandQueue()
        with self.assertRaisesRegex(ValueError, "rejected"):
            commands.execute("bad", lambda: (_ for _ in ()).throw(ValueError("rejected")))
        result, receipt = commands.execute("good", lambda: "ok")
        self.assertEqual((result, receipt.sequence, commands.pending), ("ok", 2, 0))


if __name__ == "__main__":
    unittest.main()
