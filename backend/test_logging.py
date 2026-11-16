import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from main import configure_logging


class LoggingTests(unittest.TestCase):
    def test_uvicorn_and_application_messages_share_a_rotating_file(self):
        previous = list(logging.getLogger().handlers)
        try:
            with TemporaryDirectory() as folder:
                path = Path(folder) / "nested" / "simmetro.log"
                configure_logging(path)
                logging.getLogger("uvicorn.access").info("GET /api/view 200")
                logging.getLogger("simmetro").warning("simulation warning")
                handler = logging.getLogger().handlers[0]
                handler.flush()
                self.assertIsInstance(handler, RotatingFileHandler)
                self.assertEqual((handler.maxBytes, handler.backupCount), (5 * 1024 * 1024, 4))
                contents = path.read_text(encoding="utf-8")
                self.assertIn("GET /api/view 200", contents)
                self.assertIn("simulation warning", contents)
                logging.getLogger().handlers.clear()
                handler.close()
        finally:
            root = logging.getLogger()
            root.handlers.clear()
            root.handlers.extend(previous)


if __name__ == "__main__":
    unittest.main()
