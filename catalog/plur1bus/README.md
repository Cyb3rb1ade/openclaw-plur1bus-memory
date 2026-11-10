# PLUR1BUS for Hermes

PLUR1BUS is a persistent, profile-scoped long-term memory engine. It captures
conversation memories and retrieves relevant ones with semantic search, embeddings
and reranking. It includes Semantic Lens, Layer 1.5, a Continuity Engine, emotion
and memory dynamics, Persona Voice, consolidation, optional dreaming and Dream
Echo, an Obsidian bridge, and a Skill Workshop. The Desktop extension has settings,
model and storage controls, a memory browser, and diagnostics.

## Setup

1. Install PLUR1BUS from the Hermes Plugin Catalog.
2. In the intended Hermes profile, enable the plugin and choose PLUR1BUS as the
   persistent memory provider in Hermes' memory settings. In the CLI, use
   `hermes memory setup`.
3. Start or restart the profile's gateway. **PLUR1BUS** then appears in the
   Desktop navigation for that profile.

Each profile opts in separately. Model and storage migrations require
confirmation. If Hermes exposes a secondary profile in read-only mode, open
it as the backend's launch profile to edit its settings.

The catalog bundle contains reviewable source only. It uses Hermes Package
Management for Python dependencies. Apple Silicon, Linux x64/ARM64, and Windows
x64 use the published Python dependency stack. For Windows ARM64, use the native
installer on the [release page](https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory/releases/tag/7.19.3-hermes.1);
the catalog cannot carry its native LanceDB/PyArrow wheels. The release page also
has the signed macOS installer and step-by-step guides.

## Data and credentials

- Memory records and indexes are stored locally in the selected profile by default.
  The plugin writes profile configuration only through intentional settings,
  setup, or reviewed operations. Optional Obsidian mirroring accesses only the
  configured vault and optional skill workflows access their configured roots.
- Local model providers can download weights from their upstream distribution.
  Configured remote embedding, reranking or task model routes can receive the
  text they need to perform those tasks. No remote service is required to install.
- Jev is optional. In Hermes Settings → Memory → PLUR1BUS, save a **Jev API
  key**. In the PLUR1BUS dashboard, choose **Automatic (Jev)** under **Storage
  mode** to allow sending eligible new capture text to `https://api.typesafe.ai`.
  Hermes stores the key for the selected profile. The dashboard shows only
  whether a key is configured.
- This catalog payload does not include the standalone platform installers,
  an updater, model weights, private credentials, or Hermes core patches.
