"""Deterministic regionwide daily weather, derived from the calendar and seed."""

SEASONS = ("winter", "spring", "summer", "autumn")
CONDITIONS = ("sun", "rain", "snow")
WEIGHTS = {
    "winter": (25, 25, 50),
    "spring": (50, 45, 5),
    "summer": (75, 25, 0),
    "autumn": (40, 55, 5),
}
HAPPINESS = {"sun": 3, "rain": -2, "snow": -4}


def _condition(seed: int, absolute_day: int) -> str:
    season = SEASONS[(((absolute_day // 30) + 1) % 12) // 3]
    n = (seed ^ ((absolute_day + 1) * 0x9E3779B9)) & 0xffffffff
    n = ((n ^ (n >> 16)) * 0x85EBCA6B) & 0xffffffff
    roll = ((n ^ (n >> 13)) % 100)
    sun, rain, _ = WEIGHTS[season]
    return "sun" if roll < sun else "rain" if roll < sun + rain else "snow"


def weather(seed: int, month: int, clock: float) -> dict:
    season = SEASONS[((month + 1) % 12) // 3]
    day = int(clock // 1440)
    absolute_day = month * 30 + day
    # The old sky gives way to the new one throughout the day. The endpoints
    # match across midnight, so a new roll never causes a visual jump.
    phase = (clock % 1440) / 1440
    blend = phase * phase * (3 - 2 * phase)
    previous, current = _condition(seed, absolute_day - 1), _condition(seed, absolute_day)
    strengths = {kind: round((1 - blend if previous == kind else 0) +
                             (blend if current == kind else 0), 4) for kind in CONDITIONS}
    condition = max(CONDITIONS, key=lambda kind: strengths[kind])
    happiness = sum(HAPPINESS[kind] * strengths[kind] for kind in CONDITIONS)
    return {"season": season, "condition": condition, "happiness": round(happiness, 2),
            "day": day + 1, **strengths}
