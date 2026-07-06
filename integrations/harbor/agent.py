"""Legacy compatibility import for Sigma's portable Harbor runtime.

The canonical Harbor adapter source lives in
``portable/harbor/sigma_harbor_agent.py`` and is packaged into
``.artifacts/harbor-runtime/sigma_harbor_agent.py``. Keep this module thin so
benchmark runs do not depend on ``integrations.harbor`` by default.
"""

from __future__ import annotations

from portable.harbor.sigma_harbor_agent import SigmaCliHarborAgent


AgentCliHarborAgent = SigmaCliHarborAgent

__all__ = ["AgentCliHarborAgent", "SigmaCliHarborAgent"]
