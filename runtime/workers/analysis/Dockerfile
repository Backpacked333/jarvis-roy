# syntax=docker/dockerfile:1
# setup-analysis-image.sh supplies the reviewed, engine-matched immutable pin.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

COPY --chmod=0444 requirements.lock /opt/jarvis-analysis/requirements.lock
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export PIP_CERT=/run/secrets/proxy_ca; fi; \
    python -m pip install --disable-pip-version-check --no-cache-dir --only-binary=:all: \
      --require-hashes -r /opt/jarvis-analysis/requirements.lock && \
    python -m pip check
COPY --chmod=0444 test_analysis.py /opt/jarvis-analysis/test_analysis.py
RUN chmod 0555 /opt/jarvis-analysis && chmod 0444 /opt/jarvis-analysis/*
# Python workers retain the existing noexec workspace policy. No unreviewed
# image is added to the coding-image catalog or granted executable scratch.
LABEL ai.jarvis.profile="analysis-python" ai.jarvis.analysis-version="1"
