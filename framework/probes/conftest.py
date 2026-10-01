"""Executable provenance for Sillo Agent skills.

Every behavioural claim a skill makes that is easy to get wrong, and that the
docs have got wrong at least once, is pinned here as a test against the
installed framework. A skill cites the probe ids it relies on under `probes:`,
and `npm run validate` refuses a citation that does not resolve to a test.

Run against the Sillo you want to check:

    pip install "sillo-framework[record,jwt,cache,mail]" httpx pytest pytest-asyncio
    pytest framework/probes

A probe id is the test function's name without the `test_` prefix.
"""

import os

# The framework loads .env on construction; a probe must never read one.
os.environ.setdefault("SILLO_ENV_FILE", "")
