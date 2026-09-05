"""Hermes model-provider profile for a local vMLX server."""

from providers import register_provider
from providers.base import ProviderProfile


vmlx = ProviderProfile(
    name="vmlx",
    env_vars=("VMLX_API_KEY",),
    display_name="vMLX",
    description="Local JANG and Gemma 4 inference through vMLX",
    base_url="http://127.0.0.1:8002/v1",
    api_mode="chat_completions",
    fallback_models=("Gemma-4-31B-JANG_4M-Uncensored",),
)

register_provider(vmlx)
