# Container build and run for the registration prover-memory measurement.
#
# PLATFORM: the RISC Zero toolchain has no linux/aarch64 build. The rzup installer
# rejects it with "Unsupported architecture: linux/aarch64". So on an Apple Silicon
# or other ARM64 host (for example colima on an Apple Silicon Mac) this image must
# be built for amd64 under emulation:
#   docker run --privileged --rm tonistiigi/binfmt --install amd64
#   docker build --platform linux/amd64 -t r0-registration .
#   docker run --rm --platform linux/amd64 --memory=16g r0-registration
# Emulated x86_64 is slow, and its memory and time numbers are NOT representative,
# so use it only to confirm the build. For real Phase 0 numbers use a native
# x86_64 Linux box sized like a masternode, or a native macOS arm64 build (rzup
# supports darwin/arm64), not this container on Apple Silicon.
#
# On a native x86_64 Linux host no --platform flag is needed:
#   docker build -t r0-registration .
#   docker run --rm --memory=16g r0-registration
FROM rust:bookworm

# GNU time for the peak-memory measurement, curl for the RISC Zero installer.
RUN apt-get update \
 && apt-get install -y --no-install-recommends time curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Install the RISC Zero toolchain (rzup) and r0vm. Adjust if the installer path
# changes with the release, see the top-level README on version alignment.
RUN curl -L https://risczero.com/install | bash
ENV PATH="/root/.risc0/bin:${PATH}"
RUN rzup install

WORKDIR /app
COPY . .

# Prebuild so `docker run` measures a clean proving run, not a compile.
RUN cargo build --release -p host

CMD ["bash", "scripts/bench.sh"]
