#!/usr/bin/env bash
# Minimal offline Python stand-in for installer shell regression tests.
set -euo pipefail

record="${MTPLX_TEST_RECORD:?MTPLX_TEST_RECORD is required}"

case "${1:-}" in
  --version)
    printf 'Python 3.11.0\n'
    ;;
  -c)
    program="${2:-}"
    if [[ "$program" == *'json.load(sys.stdin)["embedding"]'* ]]; then
      cat >/dev/null
      printf 'jina-embeddings-v5-text-small\n'
    elif [[ "$program" == *'json.load(sys.stdin)["reranker"]'* ]]; then
      cat >/dev/null
      printf 'jina-reranker-v3.5\n'
    fi
    ;;
  -)
    "${MTPLX_TEST_REAL_PYTHON:-/usr/bin/python3}" - "${2:-}"
    ;;
  -m)
    case "${2:-}" in
      venv)
        venv_dir="${3:?missing venv directory}"
        install -d "$venv_dir/bin"
        install -m 0755 "$0" "$venv_dir/bin/python"
        printf 'venv:%s\n' "$venv_dir" >> "$record"
        ;;
      pip)
        printf 'pip:%s %s\n' "$0" "${*:3}" >> "$record"
        ;;
      mtplx_embed.installer)
        case "${3:-}" in
          download)
            printf 'download:%s\n' "$0" >> "$record"
            printf '{"embedding":"jina-embeddings-v5-text-small","reranker":"jina-reranker-v3.5"}\n'
            ;;
          smoke)
            printf 'smoke:%s\n' "${*:4}" >> "$record"
            ;;
          *)
            printf 'unexpected fake installer command: %s\n' "${3:-}" >&2
            exit 2
            ;;
        esac
        ;;
      *)
        printf 'unexpected fake Python module: %s\n' "${2:-}" >&2
        exit 2
        ;;
    esac
    ;;
  *)
    printf 'unexpected fake Python invocation: %s\n' "$*" >&2
    exit 2
    ;;
esac
