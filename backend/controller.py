"""Simulation coordination primitives.

The web layer owns the lock protecting these objects.  Keeping command ordering
here makes the mutation boundary explicit without coupling the headless model to
FastAPI or to a particular worker implementation.
"""
from collections import deque
from dataclasses import dataclass
from typing import Callable, TypeVar


T = TypeVar("T")


@dataclass(frozen=True)
class CommandReceipt:
    sequence: int
    name: str


@dataclass
class _Command:
    receipt: CommandReceipt
    operation: Callable[[], object]


class CommandQueue:
    """Ordered, synchronous command boundary for authoritative mutations.

    Commands are queued before execution even though this first implementation
    drains them immediately while the simulation lock is held.  A later actor or
    process controller can consume the same boundary without changing endpoints.
    Failed commands still consume a sequence number, which keeps diagnostics and
    replay logs unambiguous.
    """

    def __init__(self):
        self._next_sequence = 1
        self._pending: deque[_Command] = deque()

    @property
    def pending(self) -> int:
        return len(self._pending)

    @property
    def last_sequence(self) -> int:
        return self._next_sequence - 1

    def execute(self, name: str, operation: Callable[[], T]) -> tuple[T, CommandReceipt]:
        receipt = CommandReceipt(self._next_sequence, name)
        self._next_sequence += 1
        command = _Command(receipt, operation)
        self._pending.append(command)
        try:
            current = self._pending.popleft()
            if current is not command:
                raise RuntimeError("Command queue was drained out of order.")
            return current.operation(), receipt
        finally:
            # The command is normally removed before execution.  This also makes
            # the invariant robust if the implementation changes to drain later.
            if self._pending and self._pending[0] is command:
                self._pending.popleft()

