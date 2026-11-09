"""The optional Jev credential is stored by Hermes' native provider form."""

from plugins.memory.config_schema import KIND_SECRET, STORAGE_PROVIDER, ProviderConfigSchema, ProviderField


CONFIG_SCHEMA = ProviderConfigSchema(
    name="plur1bus",
    label="PLUR1BUS",
    storage=STORAGE_PROVIDER,
    fields=(ProviderField(
        key="jevApiKey",
        label="Jev API key",
        kind=KIND_SECRET,
        env_key="TYPESAFE_API_KEY",
        description="Optional. In PLUR1BUS, choose Automatic (Jev) to let Jev decide how eligible captures are stored.",
    ),),
)
