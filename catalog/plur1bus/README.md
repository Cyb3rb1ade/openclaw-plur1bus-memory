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

Each profile opts in separately. Edit feature settings in the selected
profile. Model and storage migrations require confirmation and a writable
retrieval connection. Open the profile as the backend's launch profile when
Hermes exposes its retrieval controls in read-only mode.

The catalog bundle contains reviewable source only. It uses Hermes Package
Management for Python dependencies. Apple Silicon, Linux x64/ARM64, and Windows
x64 use the published Python dependency stack. For Windows ARM64, use the native
installer on the [release page](https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory/releases/tag/7.21.8-hermes.1);
the catalog cannot carry its native LanceDB/PyArrow wheels. The release page also
has the signed macOS installer and step-by-step guides.

## EmbeddingGemma 2

In **PLUR1BUS → Models & Storage**, select **local-onnx → EmbeddingGemma 2**
to prepare the pinned Apache-2.0 model for the current profile. Choose q8, q4
or fp32 and 128, 256, 512 or 768 dimensions. Model preparation downloads and
verifies the text graph. Changing an existing writer uses a separately
reviewed migration and activation.

## Recall across embedding generations

In a profile's PLUR1BUS `config.json`, list independently staged and activated
namespaces under `namespaces.activeRecallNamespaces`. List the writer under
`namespaces.activeWriteNamespace` and include it in the recall list. For each
other vector identity, set `namespaces.recallEmbeddings.<namespace>` to the
complete embedding configuration used to build its generation. Hermes
compares the fingerprint and dimensions before using the provider. Use
profile-scoped credential references for remote models. This configuration
adds read routes within the profile. Captures still use the active writer.
Shared memory without matching, verified embedding provenance is available
through keyword recall within its existing sharing scope.

## Engine embedding IPC

To use an existing local Engine embedding owner, select `engine-ipc` in
**Models & Storage**. Enter the owner's absolute state root, model, dimensions,
and `embedding:v1:sha256:…` fingerprint from its probe or serve response.
The profile uses the authenticated endpoint under the selected state root.
On Windows, the legacy pipe mode is available for a legacy OpenClaw owner.
Switching the active writer to IPC uses the reviewed embedding migration.

To serve a prepared, revision-pinned Hermes model to a local Engine client, run
the following with the Python that has the PLUR1BUS Hermes plugin installed.
The command prints the connection settings, including the fingerprint. Keep
the service running while clients use it.

```sh
python -m plur1bus_hermes.embedding_ipc --hermes-home /absolute/path/to/.hermes --profile default
```

For an upstream Node owner on Windows, prepare the IPC scope first with the
Python from the Hermes environment:

```powershell
python -m plur1bus_hermes.embedding_ipc --prepare-state-root "C:\local\engine-state"
```

Choose a fresh or already safe directory on a local fixed drive. The absolute
state root must already exist. The command creates or checks the private IPC
directory and exits without starting a listener or issuing a token. Existing
unsafe permissions are refused. Give the Node owner and Hermes client the same
state-root spelling. A Hermes foreground owner prepares its scope at startup.

## Conversation compression

Set the summary model in Hermes Desktop under **Settings → Models → Auxiliary
models → Compression**. Select the intended profile under **Applies to**.
Hermes saves the choice in that profile. PLUR1BUS memory consolidation is a
separate task and has its own model settings.

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
