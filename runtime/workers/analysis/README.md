# Offline analysis image

This optional local image adds NumPy, SciPy, pandas, SymPy, Matplotlib and pytest
to the existing reviewed Python 3.12 image. Every direct/transitive dependency is
version-pinned and verified against PyPI SHA-256 wheel hashes. The lock covers
Linux CPython 3.12 on AMD64 and ARM64; no source builds or runtime downloads occur.

From the checkout root, with Node 24 and a local Docker engine:

```sh
JARVIS_WORKER_IMAGE="$(./scripts/setup-analysis-image.sh)" && export JARVIS_WORKER_IMAGE
```

The script builds from the engine-matched immutable Python catalog pin, runs four
offline library/numerical/symbolic/plot fixtures, and then runs the existing
Jarvis resource/security enforcement probe. Only full success prints an image ID
on stdout. Review failure output before retrying. In particular, rootless Docker
without delegated cgroups is rejected even when the library fixtures pass.

The image is kept local. Nothing is pushed or added to the reviewed coding-image
catalog. Its `sha256:…` ID selects the existing custom/Python sandbox policy:
offline networking, read-only root, and **noexec** workspace. Numerical native
libraries live in the read-only image, not executable scratch. Use `python3 -I`
for analyses; the worker controller itself remains separately pinned.

Managed cloud builds preserve Docker's proxy configuration and mount the supplied
CA as a BuildKit secret. TLS and package-hash checks remain enabled; trust files
and provider credentials are not baked into image layers. Allow `pypi.org` and
`files.pythonhosted.org` for the build. Fixtures run with no network and a cleared
environment. Record the selected image ID, source/artifact hashes, commands and
results in research deliverables; successful fixtures do not prove a new
analysis semantically correct.
