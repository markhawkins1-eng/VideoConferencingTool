"""Minimal Prometheus-style metrics (no dependency), plus a per-IP connection counter."""

from __future__ import annotations

from collections import defaultdict
from typing import Callable


class Metrics:
    def __init__(self) -> None:
        self._counters: dict[tuple[str, tuple[tuple[str, str], ...]], int] = defaultdict(int)
        self._help: dict[str, str] = {}
        self._gauges: dict[str, tuple[str, Callable[[], float]]] = {}

    def inc(self, name: str, help_text: str, **labels: str) -> None:
        self._help.setdefault(name, help_text)
        self._counters[(name, tuple(sorted(labels.items())))] += 1

    def gauge(self, name: str, help_text: str, fn: Callable[[], float]) -> None:
        self._gauges[name] = (help_text, fn)

    def value(self, name: str, **labels: str) -> int:
        return self._counters.get((name, tuple(sorted(labels.items()))), 0)

    def render(self) -> str:
        lines: list[str] = []
        for name, (help_text, fn) in sorted(self._gauges.items()):
            lines += [f"# HELP {name} {help_text}", f"# TYPE {name} gauge", f"{name} {fn()}"]
        for name in sorted(self._help):
            lines += [f"# HELP {name} {self._help[name]}", f"# TYPE {name} counter"]
            for (n, labels), v in sorted(self._counters.items()):
                if n != name:
                    continue
                lab = ",".join(f'{k}="{val}"' for k, val in labels)
                lines.append(f"{name}{{{lab}}} {v}" if lab else f"{name} {v}")
        return "\n".join(lines) + "\n"


class ConnectionCounter:
    """Caps concurrent connections per key (client IP)."""

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self._open: dict[str, int] = defaultdict(int)

    def acquire(self, key: str) -> bool:
        if self._open[key] >= self.limit:
            return False
        self._open[key] += 1
        return True

    def release(self, key: str) -> None:
        self._open[key] -= 1
        if self._open[key] <= 0:
            del self._open[key]
