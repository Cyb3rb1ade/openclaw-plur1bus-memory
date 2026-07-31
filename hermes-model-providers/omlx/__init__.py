"""Hermes model-provider profile for a local oMLX server."""

from providers import register_provider
from providers.base import ProviderProfile


omlx = ProviderProfile(
    name="omlx",
    aliases=("mlx",),
    env_vars=("OMLX_API_KEY",),
    display_name="oMLX",
    description="Local MLX inference through an OpenAI-compatible oMLX server",
    base_url="http://127.0.0.1:8000/v1",
    api_mode="chat_completions",
    fallback_models=("gemma-4-12b-coder-fable5-composer2.5-4bit",),
    supports_vision=True,
)

register_provider(omlx)
