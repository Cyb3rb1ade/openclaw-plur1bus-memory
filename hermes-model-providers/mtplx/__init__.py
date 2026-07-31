"""Hermes model-provider profile for a local MTPLX daemon."""

from providers import register_provider
from providers.base import ProviderProfile


mtplx = ProviderProfile(
    name="mtplx",
    aliases=("mtp",),
    env_vars=("MTPLX_API_KEY",),
    display_name="MTPLX",
    description="Local Apple Silicon inference with native MTP speculative decoding",
    base_url="http://127.0.0.1:18085/v1",
    api_mode="chat_completions",
    fallback_models=(
        "mtplx-qwen36-27b-optimized-speed",
        "samuelfaj/Ornstein3.6-27B-MTP-NSC-ACE-SABER-8bit-MTPLX-Optimized-Speed",
        "samuelfaj/Qwen3.6-35B-A3B-NSC-ACE-SABER-6bit-MTPLX-Optimized-Speed",
        "philipjohnbasile/Qwen3.6-27B-Fable-Fusion-711-MTPLX-4bit",
        "Jonandrop/Ornith-1.0-35B-MTPLX-Vision",
    ),
    supports_vision=True,
)

register_provider(mtplx)
