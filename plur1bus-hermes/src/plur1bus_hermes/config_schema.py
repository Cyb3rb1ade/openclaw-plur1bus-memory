"""Hermes provider-owned configuration for reviewed PLUR1BUS settings."""

from plugins.memory.config_schema import KIND_JSON, STORAGE_PROVIDER, ProviderConfigSchema, ProviderField


CONFIG_SCHEMA = ProviderConfigSchema(
    name="plur1bus",
    label="PLUR1BUS",
    storage=STORAGE_PROVIDER,
    fields=(ProviderField(
        key="reviewedSetting",
        label="PLUR1BUS-Einstellungen",
        kind=KIND_JSON,
        description="Öffne PLUR1BUS in der Seitenleiste, um Änderungen zu prüfen und zu speichern.",
    ),),
)
