"""Small in-memory request limiter for a single ShareGuard gateway."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from math import ceil
from threading import Lock
import time


@dataclass(frozen=True)
class RateLimitResult:
    allowed: bool
    retry_after: int = 0


class MemoryRateLimiter:
    """Enforce sliding-minute and UTC-day limits for one process."""

    def __init__(
        self,
        per_minute: int = 0,
        per_day: int = 0,
        clock=time.time,
    ):
        self.per_minute = max(0, int(per_minute))
        self.per_day = max(0, int(per_day))
        self.clock = clock
        self._minute_events = {}
        self._daily_counts = {}
        self._lock = Lock()

    def consume(self, actor: str) -> RateLimitResult:
        if self.per_minute == 0 and self.per_day == 0:
            return RateLimitResult(True)

        now = float(self.clock())
        day = datetime.fromtimestamp(now, tz=timezone.utc).date()
        with self._lock:
            events = self._minute_events.setdefault(actor, deque())
            cutoff = now - 60.0
            while events and events[0] <= cutoff:
                events.popleft()

            daily_key = (actor, day.isoformat())
            daily_count = self._daily_counts.get(daily_key, 0)
            if self.per_minute and len(events) >= self.per_minute:
                retry_after = max(1, ceil(events[0] + 60.0 - now))
                return RateLimitResult(False, retry_after)
            if self.per_day and daily_count >= self.per_day:
                next_day = datetime.combine(
                    day + timedelta(days=1),
                    datetime.min.time(),
                    tzinfo=timezone.utc,
                )
                retry_after = max(1, ceil(next_day.timestamp() - now))
                return RateLimitResult(False, retry_after)

            events.append(now)
            self._daily_counts[daily_key] = daily_count + 1
            self._discard_old_days(day.isoformat())
            return RateLimitResult(True)

    def _discard_old_days(self, current_day: str) -> None:
        stale = [key for key in self._daily_counts if key[1] != current_day]
        for key in stale:
            self._daily_counts.pop(key, None)
