"""Shared pytest setup for the downloader suite (SPEC 9.0).

Run with `pytest` from /agent. The downloader targets Python 3.12 on the
owner's Windows PC; the build sandbox runs 3.13, so the suite is written
to pass on both (see docs/DECISIONS.md).
"""

import sys
from pathlib import Path

AGENT_DIR = Path(__file__).resolve().parent.parent

# Let `import downloader` work no matter where pytest is invoked from.
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))
